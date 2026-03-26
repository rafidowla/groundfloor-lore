/**
 * surrealAdapter.ts — SurrealDB Sync Adapter.
 *
 * Purpose:
 *   Implements the SyncAdapter interface for SurrealDB as the remote
 *   team-shared backend. Connects via WebSocket, pushes/pulls knowledge
 *   nodes and edges using SurrealQL.
 *
 * Architecture:
 *   Uses the official `surrealdb` npm package for WebSocket connections.
 *   Targets the schema defined in infra/surrealdb/schema.surql (local-only).
 *   Namespace: configurable (default: "groundfloor").
 *   Database: configurable (default: "lore").
 *
 * Side Effects: Network I/O via WebSocket to SurrealDB instance.
 * Error Behavior: Throws on connection/auth failures. Query errors are caught per-item.
 * Determinism: Non-deterministic (network + remote state).
 * Thread Safety: Not thread-safe. Use one instance per process.
 * Idempotency: Push is idempotent (upsert via record ID).
 */

import type { LoreNode, LoreEdge } from './localGraph.js';
import type { SyncAdapter, SyncResult, DevActivity } from './syncEngine.js';

/* ─── Configuration ───────────────────────────────────────────── */

/**
 * SurrealConfig — Connection parameters for SurrealDB.
 */
export interface SurrealConfig {
    /** WebSocket URL, e.g. "ws://127.0.0.1:8000/rpc" or "wss://sdb.example.co/rpc" */
    url: string;
    /** SurrealDB namespace (default: "groundfloor") */
    namespace: string;
    /** SurrealDB database (default: "lore") */
    database: string;
    /** Authentication username */
    username: string;
    /** Authentication password */
    password: string;
    /** Organization ID for multi-tenant isolation */
    orgId: string;
}

/* ─── Adapter Implementation ──────────────────────────────────── */

/**
 * SurrealAdapter — SyncAdapter implementation backed by SurrealDB.
 *
 * Purpose:
 *   Provides push/pull/heartbeat/queryActivity against a SurrealDB
 *   instance exposed via WebSocket. All operations are org-scoped.
 *
 * Inputs: SurrealConfig with connection parameters.
 * Outputs: SyncResult, DevActivity[], LoreNode[], LoreEdge[].
 *
 * Side Effects: Network I/O.
 * Error Behavior: Throws SurrealSyncError on failures.
 * Performance: Dependent on network latency. Batches where possible.
 */
export class SurrealAdapter implements SyncAdapter {
    private config: SurrealConfig;
    private db: unknown = null;
    private connected: boolean = false;

    constructor(config: SurrealConfig) {
        this.config = config;
    }

    /**
     * connect — Establish WebSocket connection to SurrealDB.
     *
     * Side Effects: Opens WebSocket, authenticates, selects namespace/database.
     * Error Behavior: Throws if connection or authentication fails.
     */
    async connect(): Promise<void> {
        try {
            // Dynamic import to avoid crashing when surrealdb is not installed
            const { Surreal } = await import('surrealdb');
            const surreal = new Surreal();

            await surreal.connect(this.config.url);
            await surreal.signin({
                username: this.config.username,
                password: this.config.password,
            });
            await surreal.use({
                namespace: this.config.namespace,
                database: this.config.database,
            });

            this.db = surreal;
            this.connected = true;
        } catch (connectionError) {
            this.connected = false;
            throw new SurrealSyncError(
                `Failed to connect to SurrealDB at ${this.config.url}`,
                'connect',
                connectionError,
            );
        }
    }

    /**
     * disconnect — Close the WebSocket connection.
     */
    async disconnect(): Promise<void> {
        if (this.db && typeof (this.db as Record<string, unknown>)['close'] === 'function') {
            await (this.db as { close(): Promise<void> }).close();
        }
        this.connected = false;
        this.db = null;
    }

    /**
     * isConnected — Check if the adapter has an active connection.
     */
    async isConnected(): Promise<boolean> {
        return this.connected && this.db !== null;
    }

    /**
     * push — Upsert nodes and edges to SurrealDB.
     *
     * @param nodes - Knowledge nodes to push.
     * @param edges - Knowledge edges to push.
     * @returns Push result summary.
     *
     * Side Effects: Writes to remote lore_node and relation tables.
     * Idempotency: Yes — uses UPSERT by record ID.
     */
    async push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult> {
        this.ensureConnected();
        const surreal = this.db as { query(sql: string, bindings?: Record<string, unknown>): Promise<unknown[]> };

        let nodesPushed = 0;
        let edgesPushed = 0;
        const errors: string[] = [];

        // Push nodes
        for (const node of nodes) {
            try {
                await surreal.query(
                    `UPSERT lore_node:⟨${node.id}⟩ SET
                        type = $type, label = $label, content = $content,
                        tags = $tags, project = $project, ecosystem = $ecosystem,
                        org_id = $orgId, created_at = $createdAt, updated_at = $updatedAt,
                        sync_id = $syncId`,
                    {
                        type: node.type,
                        label: node.label,
                        content: node.content,
                        tags: node.tags ? node.tags.split(',').map((tag: string) => tag.trim()) : [],
                        project: node.project,
                        ecosystem: node.ecosystem,
                        orgId: this.config.orgId,
                        createdAt: node.createdAt,
                        updatedAt: node.updatedAt,
                        syncId: `${node.id}-${node.updatedAt}`,
                    },
                );
                nodesPushed++;
            } catch (nodeError) {
                errors.push(`Node '${node.id}': ${(nodeError as Error).message}`);
            }
        }

        // Push edges
        for (const edge of edges) {
            try {
                await surreal.query(
                    `RELATE lore_node:⟨${edge.sourceId}⟩->${edge.relation}->lore_node:⟨${edge.targetId}⟩`,
                );
                edgesPushed++;
            } catch (edgeError) {
                errors.push(`Edge '${edge.sourceId}→${edge.targetId}': ${(edgeError as Error).message}`);
            }
        }

        return {
            nodesPushed,
            edgesPushed,
            failures: errors.length,
            errors,
        };
    }

    /**
     * pull — Fetch changes from SurrealDB since a given timestamp.
     *
     * @param since - ISO 8601 timestamp. Fetch changes updated after this time.
     * @returns Nodes and edges modified since the given time.
     */
    async pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }> {
        this.ensureConnected();
        const surreal = this.db as { query(sql: string, bindings?: Record<string, unknown>): Promise<unknown[]> };

        try {
            const nodeResults = await surreal.query(
                `SELECT * FROM lore_node WHERE org_id = $orgId AND updated_at > $since`,
                { orgId: this.config.orgId, since },
            );

            const nodes: LoreNode[] = [];
            const rawNodes = (nodeResults as unknown[][])?.[0] ?? [];
            for (const raw of rawNodes) {
                const record = raw as Record<string, unknown>;
                nodes.push({
                    id: this.extractRecordId(record['id'] as string),
                    type: record['type'] as LoreNode['type'],
                    label: record['label'] as string,
                    content: (record['content'] as string) ?? '',
                    tags: Array.isArray(record['tags']) ? (record['tags'] as string[]).join(',') : '',
                    project: (record['project'] as string) ?? '*',
                    ecosystem: (record['ecosystem'] as string) ?? '*',
                    metadata: '{}',
                    createdAt: (record['created_at'] as string) ?? '',
                    updatedAt: (record['updated_at'] as string) ?? '',
                    syncedAt: new Date().toISOString(),
                });
            }

            // Edges are not timestamp-tracked in SurrealDB schema,
            // so we return empty for now — edges are primarily local
            return { nodes, edges: [] };
        } catch (pullError) {
            throw new SurrealSyncError(
                `Pull failed: ${(pullError as Error).message}`,
                'pull',
                pullError,
            );
        }
    }

    /**
     * heartbeat — Broadcast developer activity to SurrealDB.
     *
     * @param activity - Developer activity snapshot.
     */
    async heartbeat(activity: DevActivity): Promise<void> {
        this.ensureConnected();
        const surreal = this.db as { query(sql: string, bindings?: Record<string, unknown>): Promise<unknown[]> };

        try {
            await surreal.query(
                `UPSERT dev_activity:⟨${activity.developer}-${activity.orgId}⟩ SET
                    developer = $developer, org_id = $orgId,
                    branch = $branch, repo = $repo,
                    modified_symbols = $modifiedSymbols,
                    modified_files = $modifiedFiles,
                    last_active = time::now()`,
                {
                    developer: activity.developer,
                    orgId: activity.orgId,
                    branch: activity.branch,
                    repo: activity.repo,
                    modifiedSymbols: activity.modifiedSymbols,
                    modifiedFiles: activity.modifiedFiles,
                },
            );
        } catch (heartbeatError) {
            throw new SurrealSyncError(
                `Heartbeat failed: ${(heartbeatError as Error).message}`,
                'heartbeat',
                heartbeatError,
            );
        }
    }

    /**
     * queryActivity — Query team developer activity.
     *
     * @param symbol - Optional symbol name to filter by.
     * @returns Array of recent developer activity records.
     */
    async queryActivity(symbol?: string): Promise<DevActivity[]> {
        this.ensureConnected();
        const surreal = this.db as { query(sql: string, bindings?: Record<string, unknown>): Promise<unknown[]> };

        try {
            let queryString = `SELECT * FROM dev_activity WHERE org_id = $orgId AND last_active > time::now() - 1h`;
            const bindings: Record<string, unknown> = { orgId: this.config.orgId };

            if (symbol) {
                queryString += ` AND $symbol IN modified_symbols`;
                bindings['symbol'] = symbol;
            }

            queryString += ` ORDER BY last_active DESC LIMIT 50`;

            const results = await surreal.query(queryString, bindings);
            const rawActivities = (results as unknown[][])?.[0] ?? [];

            return (rawActivities as Record<string, unknown>[]).map((record) => ({
                developer: (record['developer'] as string) ?? '',
                orgId: (record['org_id'] as string) ?? '',
                branch: (record['branch'] as string) ?? '',
                repo: (record['repo'] as string) ?? '',
                modifiedSymbols: (record['modified_symbols'] as string[]) ?? [],
                modifiedFiles: (record['modified_files'] as string[]) ?? [],
                lastActive: (record['last_active'] as string) ?? '',
            }));
        } catch (queryError) {
            throw new SurrealSyncError(
                `Activity query failed: ${(queryError as Error).message}`,
                'queryActivity',
                queryError,
            );
        }
    }

    /* ─── Private Helpers ─────────────────────────────────────────── */

    /**
     * ensureConnected — Guard that throws if not connected.
     */
    private ensureConnected(): void {
        if (!this.connected || !this.db) {
            throw new SurrealSyncError('Not connected to SurrealDB', 'ensureConnected');
        }
    }

    /**
     * extractRecordId — Extract the node ID from a SurrealDB record ID.
     *
     * SurrealDB record IDs are like "lore_node:my-id" — this extracts "my-id".
     */
    private extractRecordId(recordId: string): string {
        const parts = recordId.split(':');
        return parts.length > 1 ? parts.slice(1).join(':') : recordId;
    }
}

/* ─── Error Type ──────────────────────────────────────────────── */

/**
 * SurrealSyncError — Structured error for SurrealDB sync operations.
 */
export class SurrealSyncError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly cause?: unknown,
    ) {
        super(`[SurrealSync:${operation}] ${message}`);
        this.name = 'SurrealSyncError';
    }
}
