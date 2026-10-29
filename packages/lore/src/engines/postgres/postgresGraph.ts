/**
 * postgresGraph.ts — Postgres graph engine for Lore (production engine).
 * `LoreGraphHandle` on Postgres (node-postgres), ported
 * METHOD BY METHOD from `engines/sqliteGraph.ts`: this class is the thin
 * wiring layer, every operation's body lives in `engines/postgres/*.ts`, and
 * the engine-agnostic logic (BFS, keyset paging, the supersede cycle guard,
 * lint message text, the read cache, the node-batch outcome contract) is the
 * SAME shared code under `engines/graphShared/` + `engines/cache.ts` that
 * SqliteGraph uses. Nothing about ranking lives here or in
 * `engines/postgres/`: search re-uses `rankSearchResults`/`SEARCH_SCAN_CAP`
 * exactly like SurrealGraph and SqliteGraph do.
 *
 * Differences from SqliteGraph, by design:
 *   - Construction takes a `pg` Pool (or a pool factory) instead of a
 *     basePath; `LORE_PG_URL`/pool rules live in `postgresClient.ts` and the
 *     engine NEVER falls back to another engine's store.
 *   - Every statement slices `workspace_id = $1`: one Postgres database
 *     holds many workspaces (SQLite got isolation from one file per
 *     workspace). There is no other multi-tenancy layer.
 *   - `initialize()` runs `ensureGraphSchema` (idempotent DDL) on a pool
 *     client; `close()` releases this handle's claim but does NOT end the
 *     pool — the pool is owned by whoever constructed it (it may be shared
 *     with the verbatim store); call `closePostgresPool` to drain it.
 *   - `commitNodeBatch` is one transaction with a sorted `SELECT ... FOR
 *     UPDATE` lock phase; 40001/40P01 -> `contention`, timeouts ->
 *     `unknown` (see postgresNodeBatch.ts).
 *   - Explicit not_supported (loud, never silent success): integrity
 *     scan/remove (a (workspace_id, id) PK cannot diverge from its row) and
 *     `backupTo` (no online page-streaming backup through a SQL driver; use
 *     pg_dump). The schema-authoring subsystem's `getSchemaGraphOps` is
 *     deliberately NOT implemented: boot never calls it (the boot adapter in
 *     `mcp/bootSteps.ts` resolves it lazily per schema operation and throws
 *     the named `GraphSubstrateUnsupportedError` when the handle has neither
 *     hatch).
 */

import type {
    BulkListPage,
    BulkListQuery,
    EdgeQuery,
    GraphStats,
    EdgeKey,
    LoreEdge,
    LoreNode,
    TraversalResult,
} from '../../providers/types.js';
import type { DirectedTraversalResult, LoreNodeSummary } from '../../providers/types.js';
import type { LoreGraphHandle } from '../../storage/loreStorageClient.js';
import type { Pool } from 'pg';
import { ReadCache, type CacheStats } from '../cache.js';
import { LoreGraphError } from '../loreGraphError.js';
import { KeyedMutex } from '../writeQueue.js';
import { runBidirectionalEdgeWrite } from '../graphShared/bidirectionalEdgeLock.js';
import { ensureRekeyed } from './postgresRekey.js';
import { runSchemaBootstrap } from './postgresStartup.js';
import { ensureGraphSchema } from './postgresGraphSchema.js';
import { keywordIndexBuildDone, releaseKeywordIndexBuild, startKeywordIndexBuild } from './postgresKeywordIndex.js';
import { createdAtTsBuildDone, releaseCreatedAtTsBuild, startCreatedAtTsBuild } from './postgresPartitionKeySchema.js';
import { releaseWorkspaceSkBuild, startWorkspaceSkBuild, workspaceSkBuildDone } from './postgresWorkspaceSk.js';
import {
    DEFAULT_LIST_NODES_CAP,
    getNode as readGetNode,
    getNodesByIds as readGetNodesByIds,
    listNodes as readListNodes,
    listNodesAsOf as readListNodesAsOf,
    search as readSearch,
    traverse as readTraverse,
    type PostgresReadCtx,
} from './postgresGraphReads.js';
import * as aggregates from './postgresGraphAggregates.js';
import * as directed from './postgresGraphDirected.js';
import * as writes from './postgresGraphWrites.js';
import { commitPostgresNodeBatch } from './postgresNodeBatch.js';
import * as edgesBatch from './postgresGraphEdgesBatch.js';
import * as linkOptOut from './postgresGraphLinkOptOut.js';
import * as linkStats from './postgresGraphLinkStats.js';
import type { BatchEdgeResult, InferredEdge, LinkEdgeStats } from '../../link/linkTypes.js';
import type { NodeBatchCheck, NodeBatchOutcome, NodeBatchSupersedes, NodeBatchWrite } from '../graphShared/nodeBatch.js';
import * as overview from './postgresGraphOverview.js';
import { queryEdgesPage, type EdgeKeysetPage, type EdgeKeysetQuery } from './postgresEdgeKeyset.js';
import { CallTally } from '../callTally.js';
import {
    neighbors1Hop,
    subgraphFetch,
    type NeighborRow,
    type SubgraphEdge,
    type SubgraphNode,
} from '../graphNeighbors.js';
import type { TopologyOverviewResult } from '../topologyOverviewFold.js';
import type { SupersedeResult } from '../graphShared/supersedeGuard.js';
import { notSupportedIntegrity } from '../graphShared/integrityNotSupported.js';

export interface PostgresGraphOptions {
    /** Scopes read-cache keys so switching workspaces never serves a cross-hit. */
    cacheMaxSize?: number;
    cacheTtlMs?: number;
    /** Settings-driven pass-through mode (localCache.enabled=false). */
    cacheDisabled?: boolean;
    /**
     * Row count at or below which the keyword-search indexes are built inline at open;
     * above it they are built in the background (postgresKeywordIndex.ts). Default 50,000.
     */
    keywordIndexInlineRowLimit?: number;
}

/**
 * isPostgresTransientDeleteError — the postgres classifier for the delete
 * routes' bounded retry (graphShared/deleteOutcome.ts). The counterpart of
 * SQLite's SQLITE_BUSY/SQLITE_LOCKED handling: serialization failures and
 * deadlocks (40001/40P01) are worth another attempt, as are statement
 * timeouts (57014 — the statement may yet land for a retry to re-judge) and
 * broken/reset connections. `pgErrorClass` is the stamp `withTransaction`
 * leaves, so a classified wrapper error is recognised without re-deriving.
 */
export function isPostgresTransientDeleteError(err: unknown): boolean {
    const e = err as { code?: unknown; message?: unknown; pgErrorClass?: unknown } | null | undefined;
    if (typeof e?.code === 'string' && ['40001', '40P01', '57014', '08000', '08003', '08006'].includes(e.code)) return true;
    if (e?.pgErrorClass === 'contention' || e?.pgErrorClass === 'timeout') return true;
    const msg = typeof e?.message === 'string' ? e.message : '';
    return /connection terminated|connection reset|ECONNRESET|timeout expired|connection timeout|deadlock detected|could not serialize/i.test(msg);
}

/** Why the postgres engine answers `not_supported` on integrityScan/integrityRemove. */
export const POSTGRES_INTEGRITY_REASON =
    'Postgres stores nodes in one table keyed by (workspace_id, id); a row cannot exist without its index entry, so there is nothing to repair';

export class PostgresGraph implements LoreGraphHandle {
    private pool: Pool | null = null;
    private poolFactory: (() => Promise<Pool>) | null = null;
    private initialized = false;
    private readonly workspaceId: string;

    public readonly readCache: ReadCache;

    /** Same ordering rationale as SqliteGraph's chains (writeQueue.ts KeyedMutex). */
    private readonly nodeWriteChain = new KeyedMutex();
    private readonly edgeWriteChain = new KeyedMutex();

    public readonly callTally = new CallTally();

    /** Memoized `information_schema` column set for `bulkListProjected` (fixed after ensureGraphSchema). */
    private nodeColumns: Promise<ReadonlySet<string>> | null = null;
    private readonly keywordIndexInlineRowLimit: number | undefined;

    constructor(workspaceId: string, pool: Pool | (() => Promise<Pool>), options: PostgresGraphOptions = {}) {
        if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
            throw new LoreGraphError('PostgresGraph needs a non-empty workspaceId', 'constructor', null);
        }
        if (typeof pool === 'function') this.poolFactory = pool;
        else this.pool = pool;
        this.workspaceId = workspaceId;
        this.keywordIndexInlineRowLimit = options.keywordIndexInlineRowLimit;
        this.readCache = new ReadCache({
            maxSize: options.cacheMaxSize ?? 500,
            ttlMs: options.cacheTtlMs ?? 60_000,
            disabled: process.env['LORE_CACHE_DISABLED'] === '1' || options.cacheDisabled === true,
        });
    }

    /* ── lifecycle ───────────────────────────────────────────────── */

    async initialize(): Promise<void> {
        if (this.initialized) return;
        const pool = this.pool ?? await this.poolFactory!();
        this.pool = pool;
        // Idempotent DDL on one short-lived client; the pool itself is never
        // consumed by the schema step (a busy pool must not deadlock open).
        // Serialized across processes by the schema advisory lock; startup
        // failures surface as PostgresStartupError with a fix hint.
        const schema = await runSchemaBootstrap(pool, {}, (client) =>
            ensureGraphSchema(client, this.workspaceId, this.keywordIndexInlineRowLimit === undefined
                ? {} : { keywordIndexInlineRowLimit: this.keywordIndexInlineRowLimit }));
        await ensureRekeyed(pool, this.workspaceId); // one-time name -> permanent-id row rewrite (postgresRekey.ts)
        this.initialized = true;
        // Large table, indexes missing: build off the open path (never blocks a search or a write).
        if (schema.pending || schema.analyzePending) void startKeywordIndexBuild(pool, this, schema.analyzePending ? { analyze: true } : {});
        // Same for the workspace-led `sk` unique index / edge index (postgresWorkspaceSk.ts).
        if (schema.workspaceSkPending) void startWorkspaceSkBuild(pool, this);
        // And the created_at_ts pending index + legacy backfill (postgresPartitionKeySchema.ts).
        if (schema.createdAtTsPending) void startCreatedAtTsBuild(pool, this);
    }

    /** Resolves when any background created_at_ts build on this pool has finished (never rejects). Test/shutdown hook. */
    waitForCreatedAtTs(): Promise<void> {
        return createdAtTsBuildDone(this.pool);
    }

    /** Resolves when any background workspace-sk build on this pool has finished (never rejects). Test/shutdown hook. */
    waitForWorkspaceSk(): Promise<void> {
        return workspaceSkBuildDone(this.pool);
    }

    /** Resolves when any background keyword-index build on this pool has finished (never rejects). Test/shutdown hook. */
    waitForKeywordIndexes(): Promise<void> {
        return keywordIndexBuildDone(this.pool);
    }

    /**
     * close — release this handle's claim on the pool. Idempotent. The pool
     * is NOT ended here: it was passed in (possibly shared with the verbatim
     * store), so its owner drains it via `closePostgresPool`.
     */
    async close(): Promise<void> {
        await releaseKeywordIndexBuild(this.pool, this); // the last handle out cancels a running index build
        await releaseWorkspaceSkBuild(this.pool, this);
        await releaseCreatedAtTsBuild(this.pool, this);
        this.pool = null;
        this.initialized = false;
        this.nodeColumns = null;
    }

    get backend(): 'postgres' | null {
        return this.pool ? 'postgres' : null;
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
        return overview.getTopologyOverview(this.db(), this.workspaceId);
    }

    async getTopologyOverviewByType(): Promise<TopologyOverviewResult> {
        await this.initialize();
        return overview.getTopologyOverviewByType(this.db(), this.workspaceId);
    }

    async getLanguageBreakdown(): Promise<Record<string, number>> {
        await this.initialize();
        return overview.getLanguageBreakdown(this.db(), this.workspaceId);
    }

    async lintGraph(): Promise<string[]> {
        await this.initialize();
        return overview.lintGraph(this.db(), this.workspaceId);
    }

    async findSupersededByPredecessors(byId: string): Promise<string[]> {
        await this.initialize();
        return overview.findSupersededByPredecessors(this.db(), this.workspaceId, byId);
    }

    async archiveNode(id: string): Promise<void> {
        await this.initialize();
        await overview.archiveNode(this.db(), this.workspaceId, id);
        this.readCache.bumpEpoch();
    }

    /* ── internals ───────────────────────────────────────────────── */

    private db(): Pool {
        if (!this.pool) {
            throw new LoreGraphError('PostgresGraph is not initialized — await initialize() before use', 'db');
        }
        return this.pool;
    }

    private get readCtx(): PostgresReadCtx {
        return {
            pool: this.db(),
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

    /** PostgresGraph has no optional-acceleration matrix; always null, matching SqliteGraph. */
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

    /**
     * Valid-time "as of" list as one SQL predicate (see postgresGraphReads.listNodesAsOf);
     * core/temporalQuery.ts uses this when a graph offers it. Pages are full when matches exist.
     */
    async listNodesValidAt(
        atMs: number,
        o: {
            type?: string; tag?: string; project?: string; ecosystem?: string;
            limit?: number; unbounded?: boolean; after?: { updatedAt: string; id: string };
        } = {},
    ): Promise<LoreNode[]> {
        await this.initialize();
        return readListNodesAsOf(this.readCtx, atMs, o);
    }

    async traverse(nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
        await this.initialize();
        return readTraverse(this.readCtx, nodeId, maxDepth);
    }

    /* ── node writes ─────────────────────────────────────────────── */

    async upsertNode(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const written = await writes.upsertNode(this.db(), this.workspaceId, node);
            this.bumpWriteEpoch();
            return written;
        });
    }

    /** Conditional-writes R1 — INSERT-only create; throws NodeAlreadyExistsError when the id is taken. */
    async insertNodeIfAbsent(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const written = await writes.insertNodeIfAbsent(this.db(), this.workspaceId, node);
            this.bumpWriteEpoch();
            return written;
        });
    }

    /** Phase 2a — upsert that leaves the revision alone (outcome-counter writes are not content changes). */
    async upsertNodeKeepRevision(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const written = await writes.upsertNodeKeepRevision(this.db(), this.workspaceId, node);
            this.bumpWriteEpoch();
            return written;
        });
    }

    /** Phase 2a — upsert that lands only at `expectedRevision` (throws RevisionConflictError otherwise). */
    async upsertNodeAtRevision(
        node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>, expectedRevision: number, updatedAt: string, mustExist?: boolean,
    ): Promise<LoreNode> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const written = await writes.upsertNodeAtRevision(this.db(), this.workspaceId, node, expectedRevision, updatedAt, mustExist);
            this.bumpWriteEpoch();
            return written;
        });
    }

    /**
     * 3.35.0 - atomic precondition checks + guarded writes in one transaction (see
     * postgresNodeBatch.ts). Unlike SQLite there is no whole-database write lock to lean
     * on: the transaction opens with a sorted `SELECT ... FOR UPDATE` over every id the
     * batch can move, so overlapping batches serialize on the rows and one of them
     * answers `contention` when Postgres aborts the unit of work.
     */
    async commitNodeBatch(checks: NodeBatchCheck[], writes: NodeBatchWrite[], supersedes?: NodeBatchSupersedes): Promise<NodeBatchOutcome> {
        await this.initialize();
        const out = await commitPostgresNodeBatch(this.db(), this.workspaceId, checks, writes, supersedes);
        if (out.ok) this.bumpWriteEpoch();
        return out;
    }

    /** Phase 2a — outbox replay gate: applies only over an absent/older row, verbatim, no bump. */
    async replayNodeAtRevision(node: LoreNode): Promise<boolean> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const applied = await writes.replayNodeAtRevision(this.db(), this.workspaceId, node);
            if (applied) this.bumpWriteEpoch();
            return applied;
        });
    }

    async bulkUpsertNodes(
        batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
        await this.initialize();
        const results: Array<{ id: string; ok: boolean; error?: string }> = [];
        for (const node of batch) {
            try {
                await this.nodeWriteChain.run(node.id, () => writes.upsertNode(this.db(), this.workspaceId, node));
                results.push({ id: node.id, ok: true });
            } catch (error) {
                results.push({ id: node.id, ok: false, error: (error as Error).message });
            }
        }
        this.bumpWriteEpoch();
        return results;
    }

    /** 3.34.0 (M3a): the delete routes' bounded retry classifier (postgres form — see isPostgresTransientDeleteError). */
    isTransientDeleteError(err: unknown): boolean { return isPostgresTransientDeleteError(err); }
    /** 3.34.0: explicit not_supported (see POSTGRES_INTEGRITY_REASON). */
    async integrityScan() { return notSupportedIntegrity(POSTGRES_INTEGRITY_REASON); }
    async integrityRemove(_rids: string[]) { return notSupportedIntegrity(POSTGRES_INTEGRITY_REASON); }

    async deleteNode(id: string): Promise<boolean> {
        await this.initialize();
        return this.nodeWriteChain.run(id, async () => {
            const deleted = await writes.deleteNode(this.db(), this.workspaceId, id);
            if (deleted) this.bumpWriteEpoch();
            return deleted;
        });
    }

    /** Batched `deleteNode`: one transaction for the whole set (see writes.deleteNodes). Returns the ids that existed.
     *  Takes the per-node write chains in sorted order so it queues behind, and ahead of, single-node writes exactly
     *  like `deleteNode` does. */
    async deleteNodes(ids: string[]): Promise<Set<string>> {
        await this.initialize();
        const keys = [...new Set(ids)].sort();
        const held = (i: number): Promise<Set<string>> => i >= keys.length
            ? writes.deleteNodes(this.db(), this.workspaceId, keys)
            : this.nodeWriteChain.run(keys[i]!, () => held(i + 1));
        const deleted = await held(0);
        if (deleted.size > 0) this.bumpWriteEpoch();
        return deleted;
    }

    /* ── edges ───────────────────────────────────────────────────── */

    async addEdge(edge: LoreEdge): Promise<void> {
        await this.initialize();
        const key = `${edge.sourceId}|${edge.targetId}|${edge.relation}`;
        await this.edgeWriteChain.run(key, () => writes.addEdge(this.db(), this.workspaceId, edge));
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
            await writes.addEdge(this.db(), this.workspaceId, edge);
            await writes.addEdge(this.db(), this.workspaceId, reverseEdge);
        });
        this.bumpWriteEpoch();
    }

    async deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
        await this.initialize();
        const key = `${sourceId}|${targetId}|${relation}`;
        const count = await this.edgeWriteChain.run(key, () => writes.deleteEdge(this.db(), this.workspaceId, sourceId, targetId, relation));
        if (count > 0) this.bumpWriteEpoch();
        return count;
    }

    async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
        await this.initialize();
        const count = await writes.pruneInferredLoreEdges(this.db(), this.workspaceId, relationPrefix);
        if (count > 0) this.bumpWriteEpoch();
        return count;
    }

    /** getEdge — one edge by its exact triple, or null (3.26.0, bulk edge rollback). Live edges only unless `includeInvalidated`. */
    async getEdge(
        sourceId: string, targetId: string, relation: string,
        opts: { includeProvenance?: boolean; includeInvalidated?: boolean } = {},
    ): Promise<LoreEdge | null> {
        await this.initialize();
        return aggregates.getEdge(this.db(), this.workspaceId, sourceId, targetId, relation, opts);
    }

    /** Link-on-arrival: many inferred edges in one statement; never overwrites a caller edge (contract: link-batch-engine-contract-unit). */
    async addInferredEdgesBatch(edges: InferredEdge[]): Promise<BatchEdgeResult> {
        await this.initialize();
        const out = await edgesBatch.addInferredEdgesBatch(this.db(), this.workspaceId, edges);
        if (out.written > 0) this.bumpWriteEpoch();
        return out;
    }

    /** Link-on-arrival: which of `ids` carry the durable `autolink:false` opt-out (postgresGraphLinkOptOut.ts). */
    async getLinkOptOuts(ids: readonly string[]): Promise<Set<string>> {
        await this.initialize();
        return linkOptOut.getLinkOptOuts(this.db(), this.workspaceId, ids);
    }

    /** Record (`true`) or clear (`false`) the durable link opt-out. Independent of the node row; `deleteNode` clears it. */
    async setLinkOptOuts(ids: readonly string[], optOut: boolean): Promise<void> {
        await this.initialize();
        await linkOptOut.setLinkOptOuts(this.db(), this.workspaceId, ids, optOut);
    }

    /** Link-health counts over `link_on_arrival` edges (postgresGraphLinkStats.ts). */
    async linkEdgeStats(current: { policyVersion: string; modelFingerprint: string | null }): Promise<LinkEdgeStats> {
        await this.initialize();
        return linkStats.linkEdgeStats(this.db(), this.workspaceId, current);
    }

    /** Node ids with more than `cap` live link edges, ascending, after `afterId` (the background cap prune's scan). */
    async linkNodesOverCap(cap: number, limit: number, afterId?: string | null): Promise<string[]> {
        await this.initialize();
        return linkStats.linkNodesOverCap(this.db(), this.workspaceId, cap, limit, afterId);
    }

    /** Soft-invalidate edges (sets valid_to, never deletes). Returns how many were newly invalidated. */
    async invalidateEdges(edgeKeys: EdgeKey[], at: string): Promise<number> {
        await this.initialize();
        const n = await edgesBatch.invalidateEdges(this.db(), this.workspaceId, edgeKeys, at);
        if (n > 0) this.bumpWriteEpoch();
        return n;
    }

    async queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
        await this.initialize();
        return aggregates.queryEdges(this.db(), this.workspaceId, q);
    }

    /** Engine-only keyset paging on the physical edge key (O(1) per page at any depth); see postgresEdgeKeyset.ts. */
    async queryEdgesPage(q: EdgeKeysetQuery): Promise<EdgeKeysetPage> {
        await this.initialize();
        return queryEdgesPage(this.db(), this.workspaceId, q);
    }

    /* ── lifecycle / maintenance ─────────────────────────────────── */

    async supersedeNode(oldId: string, newId: string, reason?: string): Promise<SupersedeResult> {
        await this.initialize();
        return this.nodeWriteChain.run(oldId, async () => {
            const result = await writes.supersedeNode(this.db(), this.workspaceId, (id) => this.getNode(id), oldId, newId, reason);
            if (result.ok) this.bumpWriteEpoch();
            return result;
        });
    }

    async unsupersedeNode(id: string): Promise<boolean> {
        await this.initialize();
        return this.nodeWriteChain.run(id, async () => {
            const ok = await writes.unsupersedeNode(this.db(), this.workspaceId, (nid) => this.getNode(nid), id);
            if (ok) this.bumpWriteEpoch();
            return ok;
        });
    }

    async markStaleByTags(tags: string[]): Promise<number> {
        await this.initialize();
        const marked = await writes.markStaleByTags(this.db(), this.workspaceId, tags);
        if (marked > 0) this.bumpWriteEpoch();
        return marked;
    }

    async findNodeIdsByTags(tags: string[]): Promise<string[]> {
        await this.initialize();
        return writes.findNodeIdsByTags(this.db(), this.workspaceId, tags);
    }

    async markStaleByIds(ids: string[]): Promise<number> {
        await this.initialize();
        const marked = await writes.markStaleByIds(this.db(), this.workspaceId, ids);
        if (marked > 0) this.bumpWriteEpoch();
        return marked;
    }

    /** Stamps an already-open store, never opens one — same invariant as SurrealGraph/SqliteGraph.stampAccessTimes. */
    async stampAccessTimes(entries: Array<{ id: string; accessedAt: string; retrievedAt?: string }>): Promise<number> {
        if (!this.initialized || !this.pool) return 0;
        return writes.stampAccessTimes(this.pool, this.workspaceId, entries);
    }

    async listExpiredEphemeralNodeIds(defaultTtlMs: number = 3_600_000): Promise<string[]> {
        await this.initialize();
        const res = await this.db().query(
            `SELECT id, "createdAt", ttl_ms FROM nodes WHERE workspace_id = $1 AND ephemeral = 1 LIMIT $2::int`,
            [this.workspaceId, DEFAULT_LIST_NODES_CAP],
        );
        const now = Date.now();
        const expired: string[] = [];
        for (const row of res.rows as Array<{ id: string; createdAt: string; ttl_ms: number }>) {
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
            console.error(`[PostgresGraph] pruneEphemeralNodes failed (non-fatal): ${(error as Error).message}`);
            return 0;
        }
    }

    /* ── aggregates + projections ────────────────────────────────── */

    async getStats(projectFilter?: string): Promise<GraphStats> {
        await this.initialize();
        return aggregates.getStats(this.db(), this.workspaceId, projectFilter);
    }

    async getTopology(
        limit: number = 300, projects?: string[] | string, edgeLimit?: number,
    ): Promise<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> {
        await this.initialize();
        return aggregates.getTopology(this.db(), this.workspaceId, limit, projects, edgeLimit);
    }

    async bulkList(q: BulkListQuery): Promise<BulkListPage> {
        await this.initialize();
        return aggregates.bulkList(this.db(), this.workspaceId, q);
    }

    async bulkListProjected(
        project: string, columns: readonly string[], limit: number,
        cursor: { updatedAt: string; id: string } | null,
    ): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }> {
        await this.initialize();
        if (!this.nodeColumns) this.nodeColumns = aggregates.loadNodeColumns(this.db());
        return aggregates.bulkListProjected(this.db(), this.workspaceId, project, columns, limit, cursor, this.nodeColumns);
    }

    /** Rows whose id starts with `prefix` (idx_nodes_id_prefix) — see aggregates.listNodesByIdPrefix. */
    async listNodesByIdPrefix(prefix: string, columns: readonly string[]): Promise<Array<Record<string, unknown>>> {
        await this.initialize();
        if (!this.nodeColumns) this.nodeColumns = aggregates.loadNodeColumns(this.db());
        return aggregates.listNodesByIdPrefix(this.db(), this.workspaceId, prefix, columns, this.nodeColumns);
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
     * importRaw — bulk loader for a future migration step: writes nodes/edges
     * verbatim, preserving `createdAt`/`updatedAt` exactly as given rather
     * than stamping `now()`. No caller reaches this through the public
     * `LoreGraphHandle` interface, and migrate-graph INTO postgres stays an
     * explicit refusal at the route layer (design §3).
     */
    async importRaw(nodes: LoreNode[], edges: LoreEdge[]): Promise<{ nodeCount: number; edgeCount: number }> {
        await this.initialize();
        const result = await writes.importRaw(this.db(), this.workspaceId, nodes, edges);
        this.bumpWriteEpoch();
        return result;
    }

    /**
     * backupTo — explicit not_supported (loud, never a silent partial): the
     * sqlite engine's online backup is better-sqlite3's page-streaming
     * `db.backup()`; a SQL driver has no equivalent, and pretending a
     * `pg_dump`-less copy happened would be worse than refusing. Use pg_dump
     * against the configured database.
     */
    async backupTo(_destPath: string): Promise<never> {
        throw new LoreGraphError(
            'backupTo is not supported on the postgres engine — use pg_dump against the configured LORE_PG_URL database',
            'backupTo',
            null,
        );
    }
}
