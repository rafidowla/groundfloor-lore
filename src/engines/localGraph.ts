/**
 * localGraph.ts — Kùzu Embedded Graph Database for Unified Lore.
 *
 * Purpose:
 *   Provides the local-first graph database for both code intelligence and
 *   institutional knowledge. Uses Kùzu (embedded graph DB via @kineviz/kuzu-lite)
 *   for native Cypher queries and cross-pillar traversals.
 *
 * Architecture:
 *   Replaces the separate SQLite (knowledge) and Kùzu (code) databases from
 *   the GitNexus/Lore split with a single unified graph. All reads and writes
 *   are local (<1ms). Sync to hosted SurrealDB is handled by the sync engine.
 *
 * Node Tables:
 *   - LoreNode: decisions, conventions, bug patterns, architecture notes
 *   - CodeSymbol: functions, classes, methods, interfaces (future)
 *   - DevActivity: developer branch/file tracking (future)
 *
 * Relationship Tables:
 *   - LoreEdge: knowledge ↔ knowledge relationships
 *   - LoreAppliesToCode: knowledge ↔ code cross-pillar edges (future)
 *   - CodeRelation: code ↔ code relationships (future)
 *
 * Side Effects: Creates/reads .lore/graph/ directory in the specified base path.
 * Determinism: Deterministic for a given database state.
 * Thread Safety: Single-writer (Kùzu constraint). Reads are concurrent-safe.
 * Idempotency: Schema creation is idempotent (IF NOT EXISTS).
 */

import { Database, Connection, type QueryResult } from '@kineviz/kuzu-lite';
import path from 'path';
import fs from 'fs';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * LoreNode — A knowledge node in the graph.
 *
 * Represents a discrete piece of institutional knowledge: a decision,
 * convention, bug pattern, architecture note, or file reference.
 */
export interface LoreNode {
    /** Unique identifier, e.g. "baas-body-stream-fix" */
    id: string;
    /** Node category */
    type: 'decision' | 'convention' | 'bug_pattern' | 'file_ref' | 'architecture' | 'troubleshooting' | 'note';
    /** Human-readable title */
    label: string;
    /** Full text content */
    content: string;
    /** Comma-separated tags */
    tags: string;
    /** Project scope (e.g., "groundfloor-v2.5") */
    project: string;
    /** Ecosystem scope (e.g., "groundfloor") */
    ecosystem: string;
    /** JSON metadata string */
    metadata: string;
    /** ISO 8601 timestamp */
    createdAt: string;
    /** ISO 8601 timestamp */
    updatedAt: string;
    /** ISO 8601 timestamp — NULL if not yet synced to hosted */
    syncedAt: string | null;
}

/**
 * LoreEdge — A relationship between two knowledge nodes.
 */
export interface LoreEdge {
    sourceId: string;
    targetId: string;
    relation: string;
}

/**
 * TraversalResult — A node discovered during graph traversal.
 */
export interface TraversalResult {
    node: LoreNode;
    depth: number;
    relation: string;
}

/**
 * GraphStats — Summary statistics for the local graph.
 */
export interface GraphStats {
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
}

/**
 * LoreGraphError — Custom error for graph operations.
 *
 * Purpose: Wraps Kùzu errors with context about the operation that failed.
 */
export class LoreGraphError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly cause?: unknown,
    ) {
        super(`[LoreGraph:${operation}] ${message}`);
        this.name = 'LoreGraphError';
    }
}

/* ─── Local Graph ─────────────────────────────────────────────── */

/**
 * LocalGraph — Kùzu-backed unified graph for code + knowledge.
 *
 * Purpose:
 *   Manages the local embedded graph database. All MCP tools delegate to
 *   this class for reads and writes. The graph lives in .lore/graph/ within
 *   the repository root (or a specified base path).
 *
 * Inputs: basePath — directory where .lore/graph/ will be created.
 * Outputs: Query results as typed objects.
 *
 * Side Effects:
 *   - Creates .lore/graph/ directory on initialization.
 *   - Reads/writes Kùzu database files.
 *
 * Error Behavior: Throws LoreGraphError on database failures.
 * Concurrency: Single-writer. Multiple readers are safe.
 * Performance: All operations are local (<1ms for typical queries).
 */
export class LocalGraph {
    private database: Database;
    private connection: Connection;
    private graphPath: string;
    private initialized: boolean = false;

    /**
     * Creates a new LocalGraph instance.
     *
     * @param basePath - Root directory for the .lore/graph/ data.
     *                   Typically the repository root or ~/.groundfloor/.
     */
    constructor(basePath: string) {
        const loreDir = path.join(basePath, '.lore');
        fs.mkdirSync(loreDir, { recursive: true });
        this.graphPath = path.join(loreDir, 'graph');

        this.database = new Database(this.graphPath);
        this.connection = new Connection(this.database);
    }

    /**
     * initialize — Creates the graph schema if it does not exist.
     *
     * Purpose: Ensures all node and relationship tables are present.
     *   Safe to call multiple times (idempotent).
     *
     * Side Effects: Creates Kùzu tables in the graph database.
     * Determinism: Idempotent.
     * Error Behavior: Throws LoreGraphError if schema creation fails.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            // ─── Node Tables ────────────────────────────────────────────
            await this.connection.query(`
                CREATE NODE TABLE IF NOT EXISTS LoreNode (
                    id STRING,
                    type STRING,
                    label STRING,
                    content STRING,
                    tags STRING,
                    project STRING,
                    ecosystem STRING,
                    metadata STRING,
                    createdAt STRING,
                    updatedAt STRING,
                    syncedAt STRING,
                    PRIMARY KEY (id)
                )
            `);

            // ─── Relationship Tables ────────────────────────────────────
            await this.connection.query(`
                CREATE REL TABLE IF NOT EXISTS LoreEdge (
                    FROM LoreNode TO LoreNode,
                    relation STRING
                )
            `);

            this.initialized = true;
        } catch (error) {
            throw new LoreGraphError(
                'Failed to initialize graph schema',
                'initialize',
                error,
            );
        }
    }

    /**
     * upsertNode — Create or update a knowledge node.
     *
     * Purpose: Inserts a new node or updates an existing one by ID.
     *   Sets createdAt on insert, updatedAt on every call.
     *
     * @param nodeData - The node data to upsert.
     * @returns The upserted node.
     *
     * Side Effects: Writes to Kùzu database.
     * Determinism: Deterministic for a given input.
     * Idempotency: Safe to retry (upsert semantics).
     */
    async upsertNode(nodeData: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();

        const now = new Date().toISOString();
        const existingNode = await this.getNode(nodeData.id);

        try {
            if (existingNode) {
                const stmt = await this.connection.prepare(
                    `MATCH (n:LoreNode {id: $id})
                     SET n.type = $type,
                         n.label = $label,
                         n.content = $content,
                         n.tags = $tags,
                         n.project = $project,
                         n.ecosystem = $ecosystem,
                         n.metadata = $metadata,
                         n.updatedAt = $updatedAt,
                         n.syncedAt = $syncedAt`,
                );
                await this.connection.execute(stmt, {
                    id: nodeData.id,
                    type: nodeData.type,
                    label: nodeData.label,
                    content: nodeData.content,
                    tags: nodeData.tags,
                    project: nodeData.project,
                    ecosystem: nodeData.ecosystem,
                    metadata: nodeData.metadata,
                    updatedAt: now,
                    syncedAt: '',
                });

                return {
                    ...nodeData,
                    createdAt: existingNode.createdAt,
                    updatedAt: now,
                    syncedAt: null,
                };
            } else {
                const stmt = await this.connection.prepare(
                    `CREATE (n:LoreNode {
                        id: $id,
                        type: $type,
                        label: $label,
                        content: $content,
                        tags: $tags,
                        project: $project,
                        ecosystem: $ecosystem,
                        metadata: $metadata,
                        createdAt: $createdAt,
                        updatedAt: $updatedAt,
                        syncedAt: $syncedAt
                    })`,
                );
                await this.connection.execute(stmt, {
                    id: nodeData.id,
                    type: nodeData.type,
                    label: nodeData.label,
                    content: nodeData.content,
                    tags: nodeData.tags,
                    project: nodeData.project,
                    ecosystem: nodeData.ecosystem,
                    metadata: nodeData.metadata,
                    createdAt: now,
                    updatedAt: now,
                    syncedAt: '',
                });

                return {
                    ...nodeData,
                    createdAt: now,
                    updatedAt: now,
                    syncedAt: null,
                };
            }
        } catch (error) {
            throw new LoreGraphError(
                `Failed to upsert node '${nodeData.id}'`,
                'upsertNode',
                error,
            );
        }
    }

    /**
     * getNode — Retrieve a single knowledge node by ID.
     *
     * @param id - The node ID to look up.
     * @returns The node if found, null otherwise.
     *
     * Side Effects: Reads from Kùzu database.
     * Determinism: Deterministic.
     */
    async getNode(id: string): Promise<LoreNode | null> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $id}) RETURN n.*`,
            );
            const result = await this.connection.execute(stmt, { id }) as QueryResult;
            const rows = await result.getAll();
            if (rows.length === 0) return null;

            return this.rowToLoreNode(rows[0]);
        } catch (error) {
            throw new LoreGraphError(
                `Failed to get node '${id}'`,
                'getNode',
                error,
            );
        }
    }

    /**
     * addEdge — Create a directed relationship between two nodes.
     *
     * @param edge - Source, target, and relation type.
     *
     * Side Effects: Writes to Kùzu database.
     * Error Behavior: Throws if either node does not exist.
     */
    async addEdge(edge: LoreEdge): Promise<void> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (a:LoreNode {id: $sourceId}), (b:LoreNode {id: $targetId})
                 CREATE (a)-[:LoreEdge {relation: $relation}]->(b)`,
            );
            await this.connection.execute(stmt, {
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                relation: edge.relation,
            });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to add edge ${edge.sourceId} → ${edge.targetId}`,
                'addEdge',
                error,
            );
        }
    }

    /**
     * addBidirectionalEdge — Create edges in both directions.
     *
     * @param edge - Source, target, and relation type.
     *
     * Side Effects: Writes two edges to Kùzu database.
     */
    async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
        await this.addEdge(edge);
        await this.addEdge({
            sourceId: edge.targetId,
            targetId: edge.sourceId,
            relation: edge.relation,
        });
    }

    /**
     * traverse — Walk the graph from a starting node.
     *
     * Purpose: Follows edges up to a specified depth, returning all
     *   connected nodes with their distance and connecting relation.
     *
     * @param nodeId - Starting node ID.
     * @param maxDepth - Maximum traversal depth (1-5, default: 2).
     * @returns Array of traversal results sorted by depth.
     *
     * Side Effects: Reads from Kùzu database.
     * Performance: Bounded by maxDepth. Typical <5ms for depth 2.
     */
    async traverse(nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
        await this.initialize();
        const clampedDepth = Math.min(Math.max(maxDepth, 1), 5);

        try {
            // Use MATCH with recursive edge pattern
            const result = await this.connection.query(
                `MATCH (start:LoreNode)-[e:LoreEdge* 1..${clampedDepth}]->(connected:LoreNode)
                 WHERE start.id = '${this.escapeString(nodeId)}'
                 RETURN connected.*, length(e) AS depth, e[length(e)-1].relation AS relation`,
            ) as QueryResult;

            const rows = await result.getAll();
            const seen = new Set<string>();
            const results: TraversalResult[] = [];

            for (const row of rows) {
                const record = row as Record<string, unknown>;
                const node = this.rowToLoreNode(record);
                if (!seen.has(node.id) && node.id !== nodeId) {
                    seen.add(node.id);
                    results.push({
                        node,
                        depth: (record['depth'] as number) ?? 1,
                        relation: (record['relation'] as string) ?? 'related_to',
                    });
                }
            }

            return results.sort((nodeA, nodeB) => nodeA.depth - nodeB.depth);
        } catch (error) {
            throw new LoreGraphError(
                `Failed to traverse from '${nodeId}'`,
                'traverse',
                error,
            );
        }
    }

    /**
     * search — Full-text keyword search across knowledge nodes.
     *
     * Purpose: Finds nodes whose label, content, or tags contain the query string.
     *   Optionally filtered by project and ecosystem scope.
     *
     * @param query - Search query string.
     * @param limit - Maximum results (default: 20).
     * @param project - Optional project filter ('*' for all).
     * @param ecosystem - Optional ecosystem filter ('*' for all).
     * @returns Array of matching nodes.
     *
     * Side Effects: Reads from Kùzu database.
     * Performance: Linear scan with CONTAINS. Future: add FTS index.
     */
    async search(
        query: string,
        limit: number = 20,
        project: string = '*',
        ecosystem: string = '*',
    ): Promise<LoreNode[]> {
        await this.initialize();

        const escapedQuery = this.escapeString(query.toLowerCase());

        try {
            let cypher = `MATCH (n:LoreNode) WHERE
                (lower(n.label) CONTAINS '${escapedQuery}' OR lower(n.content) CONTAINS '${escapedQuery}' OR lower(n.tags) CONTAINS '${escapedQuery}')`;

            if (project !== '*') {
                cypher += ` AND (n.project = '${this.escapeString(project)}' OR n.project = '*')`;
            }
            if (ecosystem !== '*') {
                cypher += ` AND (n.ecosystem = '${this.escapeString(ecosystem)}' OR n.ecosystem = '*')`;
            }

            cypher += ` RETURN n.* LIMIT ${limit}`;

            const result = await this.connection.query(cypher) as QueryResult;
            const rows = await result.getAll();

            return rows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                `Failed to search for '${query}'`,
                'search',
                error,
            );
        }
    }

    /**
     * listNodes — List all nodes with optional type/tag/scope filters.
     *
     * @param type - Optional node type filter.
     * @param tag - Optional tag filter (substring match).
     * @param project - Optional project filter ('*' for all).
     * @param ecosystem - Optional ecosystem filter ('*' for all).
     * @returns Array of matching nodes.
     */
    async listNodes(
        type?: string,
        tag?: string,
        project: string = '*',
        ecosystem: string = '*',
    ): Promise<LoreNode[]> {
        await this.initialize();

        try {
            let cypher = 'MATCH (n:LoreNode) WHERE true';

            if (type) {
                cypher += ` AND n.type = '${this.escapeString(type)}'`;
            }
            if (tag) {
                cypher += ` AND lower(n.tags) CONTAINS '${this.escapeString(tag.toLowerCase())}'`;
            }
            if (project !== '*') {
                cypher += ` AND (n.project = '${this.escapeString(project)}' OR n.project = '*')`;
            }
            if (ecosystem !== '*') {
                cypher += ` AND (n.ecosystem = '${this.escapeString(ecosystem)}' OR n.ecosystem = '*')`;
            }

            cypher += ' RETURN n.* ORDER BY n.updatedAt DESC';

            const result = await this.connection.query(cypher) as QueryResult;
            const rows = await result.getAll();

            return rows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                'Failed to list nodes',
                'listNodes',
                error,
            );
        }
    }

    /**
     * deleteNode — Remove a node and all its edges.
     *
     * @param id - Node ID to delete.
     * @returns true if the node existed and was deleted.
     *
     * Side Effects: Removes node and connected edges from Kùzu database.
     */
    async deleteNode(id: string): Promise<boolean> {
        await this.initialize();

        const existingNode = await this.getNode(id);
        if (!existingNode) return false;

        const escaped = this.escapeString(id);
        try {
            // Delete all edges connected to this node (both directions)
            await this.connection.query(
                `MATCH (n:LoreNode {id: '${escaped}'})-[e:LoreEdge]-() DELETE e`,
            );
            // Delete the node itself
            await this.connection.query(
                `MATCH (n:LoreNode {id: '${escaped}'}) DELETE n`,
            );

            return true;
        } catch (error) {
            throw new LoreGraphError(
                `Failed to delete node '${id}'`,
                'deleteNode',
                error,
            );
        }
    }

    /**
     * getStats — Return summary statistics for the graph.
     *
     * @returns Node count, edge count, and type breakdown.
     */
    async getStats(): Promise<GraphStats> {
        await this.initialize();

        try {
            const nodeResult = await this.connection.query(
                'MATCH (n:LoreNode) RETURN count(n) AS cnt',
            ) as QueryResult;
            const nodeRows = await nodeResult.getAll();
            const nodeCount = (nodeRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

            const edgeResult = await this.connection.query(
                'MATCH ()-[e:LoreEdge]->() RETURN count(e) AS cnt',
            ) as QueryResult;
            const edgeRows = await edgeResult.getAll();
            const edgeCount = (edgeRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

            const typeResult = await this.connection.query(
                'MATCH (n:LoreNode) RETURN n.type AS type, count(n) AS cnt',
            ) as QueryResult;
            const typeRows = await typeResult.getAll();
            const typeBreakdown: Record<string, number> = {};
            for (const row of typeRows) {
                const record = row as Record<string, unknown>;
                const nodeType = record['type'] as string;
                const count = record['cnt'] as number;
                if (nodeType) typeBreakdown[nodeType] = count;
            }

            return { nodeCount, edgeCount, typeBreakdown };
        } catch (error) {
            throw new LoreGraphError(
                'Failed to get stats',
                'getStats',
                error,
            );
        }
    }

    /**
     * getUnsyncedNodes — Retrieve nodes not yet synced to hosted DB.
     *
     * Purpose: Used by the sync engine to find nodes that need to be
     *   pushed to SurrealDB.
     *
     * @returns Array of nodes with null or empty syncedAt.
     */
    async getUnsyncedNodes(): Promise<LoreNode[]> {
        await this.initialize();

        try {
            const result = await this.connection.query(
                `MATCH (n:LoreNode) WHERE n.syncedAt = '' RETURN n.*`,
            ) as QueryResult;
            const rows = await result.getAll();
            return rows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                'Failed to get unsynced nodes',
                'getUnsyncedNodes',
                error,
            );
        }
    }

    /**
     * markSynced — Mark a node as synced to hosted DB.
     *
     * @param id - Node ID to mark.
     */
    async markSynced(id: string): Promise<void> {
        await this.initialize();
        const now = new Date().toISOString();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $id}) SET n.syncedAt = $syncedAt`,
            );
            await this.connection.execute(stmt, { id, syncedAt: now });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to mark '${id}' as synced`,
                'markSynced',
                error,
            );
        }
    }

    /**
     * close — Gracefully close the database connection.
     *
     * Side Effects: Closes Kùzu connection and database handles.
     */
    async close(): Promise<void> {
        try {
            await this.connection.close();
            await this.database.close();
        } catch {
            // Ignore close errors
        }
        this.initialized = false;
    }

    /* ─── Private Helpers ─────────────────────────────────────────── */

    /**
     * escapeString — Escape single quotes for inline Cypher values.
     *
     * Used for queries where parameterized execution is not possible
     * (e.g., dynamic CONTAINS). Prevents Cypher injection.
     */
    private escapeString(value: string): string {
        return value.replace(/'/g, "\\'");
    }

    /**
     * rowToLoreNode — Convert a Kùzu result row to a LoreNode.
     *
     * @param row - Record from getAll() or getNext().
     * @returns Typed LoreNode.
     */
    private rowToLoreNode(row: Record<string, unknown>): LoreNode {
        // kuzu-lite getAll() returns keys like "n.id", "n.label", etc.
        // Handle both prefixed ("n.id") and unprefixed ("id") keys.
        const getValue = (key: string): unknown => {
            return row[key] ?? row[`n.${key}`] ?? row[`connected.${key}`] ?? undefined;
        };

        return {
            id: (getValue('id') as string) ?? '',
            type: (getValue('type') as LoreNode['type']) ?? 'note',
            label: (getValue('label') as string) ?? '',
            content: (getValue('content') as string) ?? '',
            tags: (getValue('tags') as string) ?? '',
            project: (getValue('project') as string) ?? '*',
            ecosystem: (getValue('ecosystem') as string) ?? '*',
            metadata: (getValue('metadata') as string) ?? '{}',
            createdAt: (getValue('createdAt') as string) ?? '',
            updatedAt: (getValue('updatedAt') as string) ?? '',
            syncedAt: (getValue('syncedAt') as string) || null,
        };
    }
}
