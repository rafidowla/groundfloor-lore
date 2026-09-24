/**
 * sqliteGraph.ts — embedded better-sqlite3 graph engine for Lore (3.21 step
 * 1b). `LoreGraphHandle` on SQLite, built to be bit-identical to
 * `SurrealGraph` on the parity contract (`321-STEP1-SQLITE-GRAPH-DESIGN.md`).
 *
 * Mirrors `surrealGraph.ts` file for file: this class is the thin wiring
 * layer, every operation's body lives in `engines/sqlite/*.ts`, and the
 * engine-agnostic logic (BFS, keyset paging, the supersede cycle guard,
 * lint message text) is the SAME shared code under `engines/graphShared/`
 * that `surrealGraph.ts`'s modules call — see that directory's step-1a
 * extraction. Nothing about ranking lives here or in `engines/sqlite/`:
 * search re-uses `rankSearchResults`/`SEARCH_SCAN_CAP` exactly like
 * SurrealGraph does.
 *
 * NOT wired into workspace/engine selection yet — that is a later branch.
 * Callers construct this directly.
 */

import type {
    BulkListPage,
    BulkListQuery,
    EdgeQuery,
    GraphStats,
    LoreEdge,
    LoreNode,
    TraversalResult,
} from '../providers/types.js';
import type { DirectedTraversalResult, LoreNodeSummary } from '../providers/types.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import { ReadCache, type CacheStats } from './cache.js';
import { LoreGraphError } from './loreGraphError.js';
import { KeyedMutex } from './writeQueue.js';
import { runBidirectionalEdgeWrite } from './graphShared/bidirectionalEdgeLock.js';
import {
    closeSqliteGraph,
    openSqliteGraph,
    sqliteGraphDataPath,
    type SqliteDb,
} from './sqlite/sqliteGraphSchema.js';
import {
    DEFAULT_LIST_NODES_CAP,
    getNode as readGetNode,
    getNodesByIds as readGetNodesByIds,
    listNodes as readListNodes,
    search as readSearch,
    traverse as readTraverse,
    type SqliteReadCtx,
} from './sqlite/sqliteGraphReads.js';
import * as aggregates from './sqlite/sqliteGraphAggregates.js';
import * as directed from './sqlite/sqliteGraphDirected.js';
import * as writes from './sqlite/sqliteGraphWrites.js';
import * as overview from './sqlite/sqliteGraphOverview.js';
import { SqliteSchemaGraphOps } from './sqlite/sqliteSchemaGraphOps.js';
import { CallTally } from './callTally.js';
import {
    neighbors1Hop,
    subgraphFetch,
    type NeighborRow,
    type SubgraphEdge,
    type SubgraphNode,
} from './graphNeighbors.js';
import type { TopologyOverviewResult } from './topologyOverviewFold.js';

export interface SqliteGraphOptions {
    /** Scopes read-cache keys so switching workspaces never serves a cross-hit. */
    workspaceId?: string;
    cacheMaxSize?: number;
    cacheTtlMs?: number;
    /** Settings-driven pass-through mode (localCache.enabled=false). */
    cacheDisabled?: boolean;
}

export class SqliteGraph implements LoreGraphHandle {
    private connection: SqliteDb | null = null;
    private initialized = false;
    private readonly basePath: string;
    private readonly workspaceId: string;

    public readonly readCache: ReadCache;

    /** Same rationale as SurrealGraph's NW-1d chain — see that class's doc comment. */
    private readonly nodeWriteChain = new KeyedMutex();
    private readonly edgeWriteChain = new KeyedMutex();

    public readonly callTally = new CallTally();

    constructor(basePath: string, opts: SqliteGraphOptions = {}) {
        this.basePath = basePath;
        this.workspaceId = opts.workspaceId ?? 'default';
        this.readCache = new ReadCache({
            maxSize: opts.cacheMaxSize ?? 500,
            ttlMs: opts.cacheTtlMs ?? 60_000,
            disabled: process.env['LORE_CACHE_DISABLED'] === '1' || opts.cacheDisabled === true,
        });
    }

    /* ── lifecycle ───────────────────────────────────────────────── */

    async initialize(): Promise<void> {
        if (this.initialized) return;
        const { db } = openSqliteGraph(this.basePath);
        this.connection = db;
        this.initialized = true;
    }

    /**
     * close — `db.close()`. better-sqlite3 is synchronous: unlike
     * SurrealGraph, there is no deferred background flush to wait out, so
     * this IS the whole shutdown sequence (see `sqliteGraphSchema.ts`'s
     * `closeSqliteGraph` doc comment). Idempotent.
     */
    async close(): Promise<void> {
        await this.closeAndSettle();
    }

    /** Named to match SurrealGraph's prototype surface; no settle wait is needed on this engine (see `close()`). */
    private async closeAndSettle(): Promise<void> {
        const connection = this.connection;
        this.connection = null;
        this.initialized = false;
        if (connection) closeSqliteGraph(connection);
    }

    get backend(): 'sqlite' | null {
        return this.connection ? 'sqlite' : null;
    }

    /** Absolute path of the on-disk store. Available before initialize(). */
    get dataPath(): string {
        return sqliteGraphDataPath(this.basePath);
    }

    getCacheStats(): CacheStats {
        return this.readCache.stats();
    }

    resetCacheStats(): void {
        this.readCache.resetStats();
    }

    reconfigureCache(opts: { enabled?: boolean; ttlSeconds?: number; maxEntries?: number }): void {
        const patch: { disabled?: boolean; ttlMs?: number; maxSize?: number } = {};
        if (typeof opts.enabled === 'boolean') {
            patch.disabled = opts.enabled === false || process.env['LORE_CACHE_DISABLED'] === '1';
        }
        if (typeof opts.ttlSeconds === 'number') patch.ttlMs = Math.max(0, opts.ttlSeconds) * 1000;
        if (typeof opts.maxEntries === 'number') patch.maxSize = Math.max(1, Math.trunc(opts.maxEntries));
        this.readCache.configure(patch);
    }

    async getTopologyOverview(): Promise<TopologyOverviewResult> {
        await this.initialize();
        return overview.getTopologyOverview(this.db());
    }

    async getTopologyOverviewByType(): Promise<TopologyOverviewResult> {
        await this.initialize();
        return overview.getTopologyOverviewByType(this.db());
    }

    async getLanguageBreakdown(): Promise<Record<string, number>> {
        await this.initialize();
        return overview.getLanguageBreakdown(this.db());
    }

    async lintGraph(): Promise<string[]> {
        await this.initialize();
        return overview.lintGraph(this.db());
    }

    async findSupersededByPredecessors(byId: string): Promise<string[]> {
        await this.initialize();
        return overview.findSupersededByPredecessors(this.db(), byId);
    }

    async archiveNode(id: string): Promise<void> {
        await this.initialize();
        await overview.archiveNode(this.db(), id);
        this.readCache.bumpEpoch();
    }

    /* ── internals ───────────────────────────────────────────────── */

    private db(): SqliteDb {
        if (!this.connection) {
            throw new LoreGraphError('SqliteGraph is not initialized — await initialize() before use', 'db');
        }
        return this.connection;
    }

    private get readCtx(): SqliteReadCtx {
        return {
            db: this.db(),
            readCache: this.readCache,
            workspaceId: this.workspaceId,
            tally: this.callTally,
            readGetNodesByIds: (ids) => readGetNodesByIds(this.readCtx, ids),
        };
    }

    async traverseDirected(nodeId: string, maxDepth: number = 2): Promise<DirectedTraversalResult[]> {
        await this.initialize();
        return directed.traverseDirected(this.readCtx, nodeId, maxDepth);
    }

    async listNodeSummaries(
        type?: string, tag?: string, project: string = '*',
        ecosystem: string = '*', limit?: number, opts?: { unbounded?: boolean; ordered?: boolean },
    ): Promise<LoreNodeSummary[]> {
        await this.initialize();
        return directed.listNodeSummaries(this.readCtx, type, tag, project, ecosystem, limit, opts);
    }

    /** SqliteGraph has no optional-acceleration matrix; always null, matching the design doc. */
    get features(): null {
        return null;
    }

    private bumpWriteEpoch(): void {
        this.readCache.bumpEpoch();
    }

    /* ── node reads ──────────────────────────────────────────────── */

    async getNode(id: string): Promise<LoreNode | null> {
        await this.initialize();
        return readGetNode(this.readCtx, id);
    }

    async getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> {
        await this.initialize();
        return readGetNodesByIds(this.readCtx, ids);
    }

    async search(
        query: string, limit: number = 20, project: string = '*', ecosystem: string = '*',
        excludeHidden: boolean = false, signals?: { scanCapHit: boolean }, types?: string[],
        entities?: string[], topics?: string[],
    ): Promise<LoreNode[]> {
        await this.initialize();
        return readSearch(this.readCtx, query, limit, project, ecosystem, excludeHidden, signals, types, entities, topics);
    }

    async listNodes(
        type?: string, tag?: string, project: string = '*', ecosystem: string = '*',
        limit?: number, opts?: { unbounded?: boolean },
    ): Promise<LoreNode[]> {
        await this.initialize();
        return readListNodes(this.readCtx, type, tag, project, ecosystem, limit, opts);
    }

    async traverse(nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
        await this.initialize();
        return readTraverse(this.readCtx, nodeId, maxDepth);
    }

    /* ── node writes ─────────────────────────────────────────────── */

    async upsertNode(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const written = await writes.upsertNode(this.db(), node);
            this.bumpWriteEpoch();
            return written;
        });
    }

    async bulkUpsertNodes(
        batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
        await this.initialize();
        const results: Array<{ id: string; ok: boolean; error?: string }> = [];
        for (const node of batch) {
            try {
                await this.nodeWriteChain.run(node.id, () => writes.upsertNode(this.db(), node));
                results.push({ id: node.id, ok: true });
            } catch (error) {
                results.push({ id: node.id, ok: false, error: (error as Error).message });
            }
        }
        this.bumpWriteEpoch();
        return results;
    }

    async deleteNode(id: string): Promise<boolean> {
        await this.initialize();
        return this.nodeWriteChain.run(id, async () => {
            const deleted = await writes.deleteNode(this.db(), id);
            if (deleted) this.bumpWriteEpoch();
            return deleted;
        });
    }

    /* ── edges ───────────────────────────────────────────────────── */

    async addEdge(edge: LoreEdge): Promise<void> {
        await this.initialize();
        const key = `${edge.sourceId}|${edge.targetId}|${edge.relation}`;
        await this.edgeWriteChain.run(key, () => writes.addEdge(this.db(), edge));
        this.bumpWriteEpoch();
    }

    async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
        await this.initialize();
        const reverseEdge: LoreEdge = {
            sourceId: edge.targetId, targetId: edge.sourceId, relation: edge.relation,
            confidence: edge.confidence, confidenceScore: edge.confidenceScore,
        };
        const forwardKey = `${edge.sourceId}|${edge.targetId}|${edge.relation}`;
        const reverseKey = `${edge.targetId}|${edge.sourceId}|${edge.relation}`;
        await runBidirectionalEdgeWrite(this.edgeWriteChain, forwardKey, reverseKey, async () => {
            await writes.addEdge(this.db(), edge);
            await writes.addEdge(this.db(), reverseEdge);
        });
        this.bumpWriteEpoch();
    }

    async deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
        await this.initialize();
        const key = `${sourceId}|${targetId}|${relation}`;
        const count = await this.edgeWriteChain.run(key, () => writes.deleteEdge(this.db(), sourceId, targetId, relation));
        if (count > 0) this.bumpWriteEpoch();
        return count;
    }

    async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
        await this.initialize();
        const count = await writes.pruneInferredLoreEdges(this.db(), relationPrefix);
        if (count > 0) this.bumpWriteEpoch();
        return count;
    }

    async queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
        await this.initialize();
        return aggregates.queryEdges(this.db(), q);
    }

    /* ── lifecycle / maintenance ─────────────────────────────────── */

    async supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
        await this.initialize();
        return this.nodeWriteChain.run(oldId, async () => {
            const result = await writes.supersedeNode(this.db(), (id) => this.getNode(id), oldId, newId, reason);
            if (result.ok) this.bumpWriteEpoch();
            return result;
        });
    }

    async unsupersedeNode(id: string): Promise<boolean> {
        await this.initialize();
        return this.nodeWriteChain.run(id, async () => {
            const ok = await writes.unsupersedeNode(this.db(), (nid) => this.getNode(nid), id);
            if (ok) this.bumpWriteEpoch();
            return ok;
        });
    }

    async markStaleByTags(tags: string[]): Promise<number> {
        await this.initialize();
        const marked = await writes.markStaleByTags(this.db(), tags);
        if (marked > 0) this.bumpWriteEpoch();
        return marked;
    }

    async findNodeIdsByTags(tags: string[]): Promise<string[]> {
        await this.initialize();
        return writes.findNodeIdsByTags(this.db(), tags);
    }

    async markStaleByIds(ids: string[]): Promise<number> {
        await this.initialize();
        const marked = await writes.markStaleByIds(this.db(), ids);
        if (marked > 0) this.bumpWriteEpoch();
        return marked;
    }

    /** Stamps an already-open store, never opens one — same invariant as SurrealGraph.stampAccessTimes; see that method's doc comment. */
    async stampAccessTimes(entries: Array<{ id: string; accessedAt: string; retrievedAt?: string }>): Promise<number> {
        if (!this.initialized || !this.connection) return 0;
        return writes.stampAccessTimes(this.connection, entries);
    }

    async listExpiredEphemeralNodeIds(defaultTtlMs: number = 3_600_000): Promise<string[]> {
        await this.initialize();
        const rows = this.db().prepare(
            `SELECT id, createdAt, ttl_ms FROM nodes WHERE ephemeral = 1 LIMIT ?`,
        ).all(DEFAULT_LIST_NODES_CAP) as Array<{ id: string; createdAt: string; ttl_ms: number }>;
        const now = Date.now();
        const expired: string[] = [];
        for (const row of rows) {
            const ttl = typeof row.ttl_ms === 'number' && row.ttl_ms > 0 ? row.ttl_ms : defaultTtlMs;
            if (!row.id || !row.createdAt) continue;
            const createdMs = new Date(row.createdAt).getTime();
            if (!Number.isFinite(createdMs)) continue;
            if (now - createdMs > ttl) expired.push(row.id);
        }
        return expired;
    }

    async pruneEphemeralNodes(defaultTtlMs: number = 3_600_000): Promise<number> {
        await this.initialize();
        try {
            const expired = await this.listExpiredEphemeralNodeIds(defaultTtlMs);
            if (expired.length === 0) return 0;
            let deleted = 0;
            for (const id of expired) {
                if (await this.deleteNode(id)) deleted++;
            }
            return deleted;
        } catch (error) {
            console.error(`[SqliteGraph] pruneEphemeralNodes failed (non-fatal): ${(error as Error).message}`);
            return 0;
        }
    }

    getSchemaGraphOps(): SqliteSchemaGraphOps {
        return new SqliteSchemaGraphOps({
            db: this.db(),
            deleteNode: (id) => this.deleteNode(id),
            deleteEdge: (s2, t, r) => this.deleteEdge(s2, t, r),
            addEdge: (e) => this.addEdge(e as LoreEdge),
            upsertNode: (n) => this.upsertNode(
                n as unknown as Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
            ),
        });
    }

    /* ── aggregates + projections ────────────────────────────────── */

    async getStats(projectFilter?: string): Promise<GraphStats> {
        await this.initialize();
        return aggregates.getStats(this.db(), projectFilter);
    }

    async getTopology(
        limit: number = 300, projects?: string[] | string, edgeLimit?: number,
    ): Promise<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> {
        await this.initialize();
        return aggregates.getTopology(this.db(), limit, projects, edgeLimit);
    }

    async bulkList(q: BulkListQuery): Promise<BulkListPage> {
        await this.initialize();
        return aggregates.bulkList(this.db(), q);
    }

    async bulkListProjected(
        project: string, columns: readonly string[], limit: number,
        cursor: { updatedAt: string; id: string } | null,
    ): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }> {
        await this.initialize();
        return aggregates.bulkListProjected(this.db(), project, columns, limit, cursor);
    }

    /* ── typed neighbour surfaces ────────────────────────────────── */

    async neighbors1Hop(id: string, ecosystem: string = '*'): Promise<{ outRows: NeighborRow[]; inRows: NeighborRow[] }> {
        await this.initialize();
        return neighbors1Hop(this, id, ecosystem);
    }

    async subgraphFetch(
        centerId: string, center: { label: string; type: string; tags?: string[] },
        depth: number, limit: number, includeInferred: boolean, ecosystem: string = '*',
    ): Promise<{ nodes: SubgraphNode[]; edges: SubgraphEdge[] }> {
        await this.initialize();
        return subgraphFetch(this, centerId, center, depth, limit, includeInferred, ecosystem);
    }

    /* ── internal-only surfaces (not part of LoreGraphHandle) ──────── */

    /**
     * importRaw — bulk loader for the (future) migration step: writes
     * nodes/edges verbatim, preserving `createdAt`/`updatedAt` exactly as
     * given rather than stamping `now()`. No caller reaches this through
     * the public `LoreGraphHandle` interface.
     */
    async importRaw(nodes: LoreNode[], edges: LoreEdge[]): Promise<{ nodeCount: number; edgeCount: number }> {
        await this.initialize();
        const result = await writes.importRaw(this.db(), nodes, edges);
        this.bumpWriteEpoch();
        return result;
    }

    /**
     * backupTo — online backup via better-sqlite3's `db.backup()`, the same
     * mechanism the other SQLite substrates in this codebase use (see
     * `engines/backup.ts`'s header). Safe to call against a live, open
     * handle — better-sqlite3 streams pages under its own internal locking,
     * unlike a raw file copy of a WAL-mode database.
     */
    async backupTo(destPath: string): Promise<void> {
        await this.initialize();
        await this.db().backup(destPath);
    }
}
