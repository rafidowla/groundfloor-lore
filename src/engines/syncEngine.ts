/**
 * syncEngine.ts — Offline-First Sync Engine with WAL.
 *
 * Purpose:
 *   Provides offline-first synchronization between the local Kùzu graph
 *   and a remote backend (e.g., SurrealDB). Uses a Write-Ahead Log (WAL)
 *   to buffer writes locally, then pushes them asynchronously when the
 *   remote backend is reachable.
 *
 * Architecture:
 *   Local writes → WAL file (append-only JSONL) → push to remote on sync.
 *   Remote pulls → upsert locally with last-writer-wins conflict resolution.
 *   Auto-sync runs on a configurable interval (default: 30s).
 *
 * Components:
 *   - WriteAheadLog: Append-only JSONL file at .lore/sync.wal
 *   - SyncAdapter: Pluggable interface for remote backends
 *   - SyncEngine: Orchestrates push/pull/conflict resolution
 *
 * Side Effects:
 *   - Reads/writes .lore/sync.wal (WAL file)
 *   - Reads/writes .lore/.last-sync (timestamp marker)
 *   - Network calls via SyncAdapter
 *
 * Determinism: Non-deterministic (depends on network + remote state).
 * Thread Safety: Single-writer for WAL. SyncEngine is not reentrant.
 * Idempotency: Push is idempotent (upsert semantics on remote).
 */

import fs from 'fs';
import path from 'path';
import type { LoreNode, LoreEdge, LocalGraph } from './localGraph.js';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * WalOperation — The type of operation recorded in the WAL.
 */
export type WalOperation = 'upsert_node' | 'add_edge' | 'delete_node';

/**
 * WalEntry — A single write operation buffered in the WAL.
 *
 * Inputs: Written by store_node/store_edge/delete_node operations.
 * Outputs: Read by push cycle for remote replication.
 */
export interface WalEntry {
    /** Operation type */
    op: WalOperation;
    /** Operation payload — node data, edge data, or node ID */
    data: Record<string, unknown>;
    /** ISO 8601 timestamp of the local write */
    timestamp: string;
    /** Unique entry ID for deduplication */
    entryId: string;
}

/**
 * SyncResult — Result of a push operation.
 */
export interface SyncResult {
    /** Number of nodes successfully pushed */
    nodesPushed: number;
    /** Number of edges successfully pushed */
    edgesPushed: number;
    /** Number of entries that failed */
    failures: number;
    /** Error messages for failed entries */
    errors: string[];
}

/**
 * DevActivity — Developer activity snapshot for team awareness.
 *
 * Purpose: Tracks what each developer is working on, enabling
 *   conflict detection and team visibility.
 */
export interface DevActivity {
    /** Developer identifier (hostname or configured name) */
    developer: string;
    /** Organization ID for multi-tenant isolation */
    orgId: string;
    /** Current git branch */
    branch: string;
    /** Repository name */
    repo: string;
    /** List of recently modified symbol names */
    modifiedSymbols: string[];
    /** List of recently modified file paths */
    modifiedFiles: string[];
    /** ISO 8601 timestamp of last activity */
    lastActive: string;
}

/**
 * SyncAdapter — Pluggable interface for remote sync backends.
 *
 * Purpose: Abstracts the remote storage backend so the sync engine
 *   can work with SurrealDB, BaaS AppDocuments, or any future backend.
 *
 * Implementations must handle:
 *   - Network failures gracefully (throw, don't crash)
 *   - Idempotent upserts (push may retry)
 *   - Timestamp-based delta queries (pull since X)
 *
 * Error Behavior: Throws on network/auth failures. Caller handles retry.
 * Concurrency: Must be safe for sequential calls. No concurrent guarantees.
 */
export interface SyncAdapter {
    /**
     * push — Send local changes to the remote backend.
     *
     * @param nodes - Nodes to upsert remotely.
     * @param edges - Edges to create remotely.
     * @returns Summary of push results.
     *
     * Side Effects: Writes to remote database.
     * Idempotency: Yes — upsert semantics.
     */
    push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult>;

    /**
     * pull — Fetch remote changes since a given timestamp.
     *
     * @param since - ISO 8601 timestamp. Fetch changes after this time.
     * @returns Nodes and edges modified since the given timestamp.
     *
     * Side Effects: Reads from remote database.
     */
    pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }>;

    /**
     * heartbeat — Broadcast developer activity to the team.
     *
     * @param activity - Current developer activity snapshot.
     *
     * Side Effects: Writes to remote dev_activity table.
     */
    heartbeat(activity: DevActivity): Promise<void>;

    /**
     * queryActivity — Query team activity, optionally filtered by symbol.
     *
     * @param symbol - Optional symbol name to filter by.
     * @returns Array of recent developer activity records.
     *
     * Side Effects: Reads from remote database.
     */
    queryActivity(symbol?: string): Promise<DevActivity[]>;

    /**
     * isConnected — Check if the remote backend is reachable.
     *
     * @returns true if connected and authenticated.
     *
     * Side Effects: Network health check.
     */
    isConnected(): Promise<boolean>;

    /**
     * connect — Establish connection to the remote backend.
     *
     * Side Effects: Opens network connection, authenticates.
     * Error Behavior: Throws on connection failure.
     */
    connect(): Promise<void>;

    /**
     * disconnect — Close the remote connection.
     *
     * Side Effects: Closes network connection.
     */
    disconnect(): Promise<void>;
}

/* ─── Write-Ahead Log ─────────────────────────────────────────── */

/**
 * WriteAheadLog — Append-only JSONL file for offline write buffering.
 *
 * Purpose:
 *   Buffers local write operations (node upserts, edge creates, deletes)
 *   as JSONL lines in .lore/sync.wal. The sync engine reads pending
 *   entries and pushes them to the remote backend.
 *
 * Format: One JSON object per line (JSONL / newline-delimited JSON).
 *
 * Side Effects: Reads/writes .lore/sync.wal file.
 * Determinism: Deterministic (local file I/O).
 * Thread Safety: Single-writer. Append is atomic for single lines.
 * Idempotency: append() is NOT idempotent — each call adds a new entry.
 */
export class WriteAheadLog {
    private walPath: string;

    /**
     * @param loreDir - Path to the .lore/ directory.
     */
    constructor(loreDir: string) {
        this.walPath = path.join(loreDir, 'sync.wal');
    }

    /**
     * append — Append a write operation to the WAL.
     *
     * @param op - Operation type.
     * @param data - Operation payload.
     *
     * Side Effects: Appends one JSONL line to sync.wal.
     */
    append(op: WalOperation, data: Record<string, unknown>): void {
        const entry: WalEntry = {
            op,
            data,
            timestamp: new Date().toISOString(),
            entryId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        };

        fs.appendFileSync(this.walPath, JSON.stringify(entry) + '\n', 'utf-8');
    }

    /**
     * readPending — Read all pending (un-flushed) WAL entries.
     *
     * @returns Array of WalEntry objects in chronological order.
     *
     * Side Effects: Reads sync.wal file.
     * Error Behavior: Returns empty array if file doesn't exist.
     */
    readPending(): WalEntry[] {
        if (!fs.existsSync(this.walPath)) return [];

        const rawContent = fs.readFileSync(this.walPath, 'utf-8').trim();
        if (!rawContent) return [];

        const entries: WalEntry[] = [];
        for (const line of rawContent.split('\n')) {
            try {
                entries.push(JSON.parse(line) as WalEntry);
            } catch {
                // Skip malformed lines — log corruption is non-fatal
            }
        }

        return entries;
    }

    /**
     * truncate — Clear the WAL after a successful push.
     *
     * Side Effects: Overwrites sync.wal with empty content.
     * Idempotency: Yes — safe to call multiple times.
     */
    truncate(): void {
        fs.writeFileSync(this.walPath, '', 'utf-8');
    }

    /**
     * pendingCount — Number of un-flushed entries.
     *
     * @returns Count of pending operations.
     */
    pendingCount(): number {
        return this.readPending().length;
    }

    /**
     * exists — Whether the WAL file exists on disk.
     */
    exists(): boolean {
        return fs.existsSync(this.walPath);
    }
}

/* ─── Sync Engine ─────────────────────────────────────────────── */

/**
 * SyncEngine — Orchestrates offline-first push/pull synchronization.
 *
 * Purpose:
 *   Reads pending entries from the WAL, pushes them to the remote
 *   backend via a SyncAdapter, pulls remote changes, and resolves
 *   conflicts using last-writer-wins (by updatedAt timestamp).
 *
 * Inputs:
 *   - localGraph: The Kùzu graph for reading/writing local data.
 *   - adapter: The remote backend adapter (nullable — runs offline).
 *   - loreDir: Path to .lore/ directory for WAL and sync markers.
 *
 * Side Effects:
 *   - Reads/writes WAL file via WriteAheadLog.
 *   - Reads/writes .lore/.last-sync timestamp marker.
 *   - Network calls via SyncAdapter (when connected).
 *   - Upserts to local Kùzu graph (on pull).
 *
 * Error Behavior:
 *   - Network failures are caught and logged, never crash.
 *   - WAL is NOT truncated unless push fully succeeds.
 *
 * Determinism: Non-deterministic (network + timestamps).
 * Thread Safety: Not reentrant. Use one SyncEngine instance.
 */
export class SyncEngine {
    private wal: WriteAheadLog;
    private localGraph: LocalGraph;
    private adapter: SyncAdapter | null;
    private loreDir: string;
    private lastSyncPath: string;
    private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
    private isSyncing: boolean = false;

    /**
     * @param localGraph - The local Kùzu graph instance.
     * @param loreDir - Path to the .lore/ directory.
     * @param adapter - Optional remote sync adapter. If null, runs offline-only.
     */
    constructor(localGraph: LocalGraph, loreDir: string, adapter: SyncAdapter | null = null) {
        this.localGraph = localGraph;
        this.loreDir = loreDir;
        this.adapter = adapter;
        this.wal = new WriteAheadLog(loreDir);
        this.lastSyncPath = path.join(loreDir, '.last-sync');
    }

    /**
     * getWal — Expose the WAL for direct append from MCP tools.
     *
     * @returns The WriteAheadLog instance.
     */
    getWal(): WriteAheadLog {
        return this.wal;
    }

    /**
     * pushPending — Push buffered WAL entries to the remote backend.
     *
     * Reads all pending WAL entries, groups them by type (nodes vs edges),
     * pushes to the remote backend, marks nodes as synced in Kùzu,
     * and truncates the WAL on success.
     *
     * @returns SyncResult with push statistics.
     *
     * Side Effects: Network push, WAL truncation, Kùzu markSynced.
     * Error Behavior: Returns result with failure count on partial failure.
     *   WAL is only truncated if ALL entries succeed.
     */
    async pushPending(): Promise<SyncResult> {
        if (!this.adapter) {
            return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: ['No sync adapter configured — running offline'] };
        }

        const connected = await this.adapter.isConnected().catch(() => false);
        if (!connected) {
            try {
                await this.adapter.connect();
            } catch (connectionError) {
                return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [`Cannot connect to remote: ${(connectionError as Error).message}`] };
            }
        }

        const entries = this.wal.readPending();
        if (entries.length === 0) {
            return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [] };
        }

        // Group entries by type
        const nodes: LoreNode[] = [];
        const edges: LoreEdge[] = [];
        const deletedIds: string[] = [];

        for (const entry of entries) {
            switch (entry.op) {
                case 'upsert_node':
                    nodes.push(entry.data as unknown as LoreNode);
                    break;
                case 'add_edge':
                    edges.push(entry.data as unknown as LoreEdge);
                    break;
                case 'delete_node':
                    deletedIds.push(entry.data['id'] as string);
                    break;
            }
        }

        try {
            const result = await this.adapter.push(nodes, edges);

            // Mark successfully pushed nodes as synced
            if (result.failures === 0) {
                for (const node of nodes) {
                    await this.localGraph.markSynced(node.id).catch(() => {
                        // Non-fatal — node may have been deleted locally
                    });
                }
                this.wal.truncate();
                this.writeLastSync(new Date().toISOString());
            }

            return result;
        } catch (pushError) {
            return {
                nodesPushed: 0,
                edgesPushed: 0,
                failures: entries.length,
                errors: [`Push failed: ${(pushError as Error).message}`],
            };
        }
    }

    /**
     * pullRemote — Pull changes from the remote backend into local Kùzu.
     *
     * Fetches all changes since the last sync timestamp, applies them
     * locally using last-writer-wins conflict resolution.
     *
     * @returns Summary of pulled changes.
     *
     * Side Effects: Upserts to local Kùzu graph. Updates .last-sync.
     * Error Behavior: Returns empty result on network failure.
     */
    async pullRemote(): Promise<{ nodesPulled: number; edgesPulled: number; conflicts: number }> {
        if (!this.adapter) {
            return { nodesPulled: 0, edgesPulled: 0, conflicts: 0 };
        }

        const connected = await this.adapter.isConnected().catch(() => false);
        if (!connected) {
            try {
                await this.adapter.connect();
            } catch {
                return { nodesPulled: 0, edgesPulled: 0, conflicts: 0 };
            }
        }

        const since = this.readLastSync();

        try {
            const remote = await this.adapter.pull(since);
            let nodesPulled = 0;
            let conflicts = 0;

            // Apply nodes with last-writer-wins
            for (const remoteNode of remote.nodes) {
                const localNode = await this.localGraph.getNode(remoteNode.id);

                if (localNode) {
                    // Conflict: both exist — last-writer-wins by updatedAt
                    const localTime = new Date(localNode.updatedAt).getTime();
                    const remoteTime = new Date(remoteNode.updatedAt).getTime();

                    if (remoteTime > localTime) {
                        await this.localGraph.upsertNode(remoteNode);
                        nodesPulled++;
                        conflicts++;
                    }
                    // else: local is newer — skip remote version
                } else {
                    // No conflict: insert remote node
                    await this.localGraph.upsertNode(remoteNode);
                    nodesPulled++;
                }
            }

            // Apply edges (additive — edges don't have timestamps for conflict resolution)
            let edgesPulled = 0;
            for (const remoteEdge of remote.edges) {
                try {
                    await this.localGraph.addEdge(remoteEdge);
                    edgesPulled++;
                } catch {
                    // Edge may already exist or nodes may be missing — skip
                }
            }

            this.writeLastSync(new Date().toISOString());

            return { nodesPulled, edgesPulled, conflicts };
        } catch (pullError) {
            return { nodesPulled: 0, edgesPulled: 0, conflicts: 0 };
        }
    }

    /**
     * sync — Full sync cycle: push pending, then pull remote.
     *
     * @returns Combined push and pull results.
     */
    async sync(): Promise<{
        push: SyncResult;
        pull: { nodesPulled: number; edgesPulled: number; conflicts: number };
    }> {
        if (this.isSyncing) {
            return {
                push: { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: ['Sync already in progress'] },
                pull: { nodesPulled: 0, edgesPulled: 0, conflicts: 0 },
            };
        }

        this.isSyncing = true;
        try {
            const push = await this.pushPending();
            const pull = await this.pullRemote();
            return { push, pull };
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * startAutoSync — Start a periodic background sync.
     *
     * @param intervalMs - Sync interval in milliseconds (default: 30000 = 30s).
     *
     * Side Effects: Starts a setInterval timer.
     */
    startAutoSync(intervalMs: number = 30000): void {
        if (this.autoSyncTimer) return;

        this.autoSyncTimer = setInterval(() => {
            this.sync().catch((syncError) => {
                console.error('[Lore Sync] Auto-sync failed:', (syncError as Error).message);
            });
        }, intervalMs);
    }

    /**
     * stopAutoSync — Stop the periodic background sync.
     *
     * Side Effects: Clears the setInterval timer.
     */
    stopAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
    }

    /**
     * getStatus — Get current sync status for CLI/MCP.
     *
     * @returns Sync status summary.
     */
    getStatus(): {
        walPending: number;
        lastSync: string;
        hasAdapter: boolean;
        isAutoSyncing: boolean;
    } {
        return {
            walPending: this.wal.pendingCount(),
            lastSync: this.readLastSync(),
            hasAdapter: this.adapter !== null,
            isAutoSyncing: this.autoSyncTimer !== null,
        };
    }

    /* ─── Private Helpers ────────────────────────────────────────── */

    /**
     * readLastSync — Read the last successful sync timestamp.
     *
     * @returns ISO 8601 timestamp, or '1970-01-01T00:00:00.000Z' if never synced.
     */
    private readLastSync(): string {
        try {
            return fs.readFileSync(this.lastSyncPath, 'utf-8').trim();
        } catch {
            return '1970-01-01T00:00:00.000Z';
        }
    }

    /**
     * writeLastSync — Write the last successful sync timestamp.
     *
     * @param timestamp - ISO 8601 timestamp to write.
     */
    private writeLastSync(timestamp: string): void {
        fs.writeFileSync(this.lastSyncPath, timestamp, 'utf-8');
    }
}
