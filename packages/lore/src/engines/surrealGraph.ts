/**
 * surrealGraph.ts — embedded SurrealDB graph engine for Lore.
 *
 * Purpose:
 *   A second, ADDITIVE local graph engine behind the same
 *   `LoreGraphHandle` contract LocalGraph (Kùzu) and DataplaneGraph (cloud)
 *   implement. Nothing calls it automatically — it exists, it is importable,
 *   and `LoreStorageClient.fromSurreal(...)` wires it up when a caller asks.
 *   See docs/SURREALDB_BUILD_PLAN.md.
 *
 * Why it exists:
 *   Kùzu (@kineviz/kuzu-lite 0.11.3) is a fork of an archived database that
 *   produced a real string-column corruption bug on 2026-08-03/04, and its
 *   parser rejects recursive Cypher — so multi-hop traversal currently runs as
 *   a JS BFS loop instead of in the database. This engine evaluates a
 *   replacement without touching the incumbent.
 *
 * Architecture:
 *   Embedded, in-process, one instance per workspace directory
 *   (`.lore/surreal`), no port and no daemon — the same deployment shape Kùzu
 *   already has. Graph substrate ONLY: nodes and edges. Collections/tables,
 *   analytical storage, pending-ops and ReBAC are SQLite under `.lore/` on
 *   EVERY workspace, and vectors are LanceDB — none of them consult this
 *   engine. This block used to say those four stayed in Kùzu and that a
 *   Surreal-backed workspace still depended on a Kùzu database for them; both
 *   stopped being true in DEC-KUZU-REMOVAL-STEP1.
 *
 * Licence:
 *   SurrealDB core is BSL 1.1 — embedding is permitted, offering SurrealDB
 *   itself as a hosted service is not. Enforced in code by
 *   storage/surrealLicenceGuard.ts (throws on a cloud-mode construction) and
 *   by the D-022 rule in scripts/test-arch.mjs. Do not weaken either.
 *
 * Side Effects: creates/reads `<basePath>/.lore/surreal`.
 * Concurrency: writes are serialized per node id / per edge triple, mirroring
 *   LocalGraph. SurrealDB itself is multi-writer; the serialization exists for
 *   read-decide-write atomicity, not for a substrate constraint.
 * Error Behavior: throws LoreGraphError, with the cause surfaced in `.message`.
 */

import type { Surreal } from 'surrealdb';

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
import {
    applySurrealSchema,
    openSurreal,
    surrealDataPath,
    type SurrealBackend,
    type SurrealConnection,
    type SurrealFeatures,
} from './surreal/surrealConnection.js';
import {
    DEFAULT_LIST_NODES_CAP,
    getNode as readGetNode,
    getNodesByIds as readGetNodesByIds,
    listNodes as readListNodes,
    search as readSearch,
    traverse as readTraverse,
    type SurrealQuery,
    type SurrealReadCtx,
} from './surreal/surrealGraphReads.js';
import { redactSurrealLog, surrealError } from './surreal/surrealError.js';
import * as aggregates from './surreal/surrealGraphAggregates.js';
import * as directed from './surreal/surrealGraphDirected.js';
import { CallTally } from './callTally.js';
import * as writes from './surreal/surrealGraphWrites.js';
import {
    neighbors1Hop,
    subgraphFetch,
    type NeighborRow,
    type SubgraphEdge,
    type SubgraphNode,
} from './graphNeighbors.js';
import { NODE_TABLE, ridToId, toNodeRid } from './surreal/surrealRecordId.js';
import * as overview from './surreal/surrealGraphOverview.js';
import { SurrealSchemaGraphOps } from './surreal/surrealSchemaGraphOps.js';
import type { TopologyOverviewResult } from './topologyOverviewFold.js';

export interface SurrealGraphOptions {
    /** Scopes read-cache keys so switching workspaces never serves a cross-hit. */
    workspaceId?: string;
    cacheMaxSize?: number;
    cacheTtlMs?: number;
    /** Settings-driven pass-through mode (localCache.enabled=false). */
    cacheDisabled?: boolean;
    /** Storage backend override; defaults to `resolveSurrealBackend()`. */
    backend?: SurrealBackend;
    /**
     * Feature overrides; defaults to `resolveSurrealFeatures()` (env). Tests
     * and benchmarks pass this explicitly so a flag matrix does not depend on
     * mutating `process.env`.
     */
    features?: Partial<SurrealFeatures>;
}


export class SurrealGraph implements LoreGraphHandle {
    private connection: SurrealConnection | null = null;
    private initPromise: Promise<void> | null = null;
    private initialized = false;

    private readonly basePath: string;
    private readonly options: SurrealGraphOptions;
    private readonly workspaceId: string;

    /** In-proc read-through cache, epoch-invalidated on every write. */
    public readonly readCache: ReadCache;

    /**
     * Per-node-id write serialization. `upsertNode` reads the prior
     * `createdAt` then merges; without this chain two concurrent same-id
     * upserts can interleave and the later one can resurrect the earlier
     * node's timestamp. Identical rationale to LocalGraph's NW-1d chain.
     * Different ids still write in parallel.
     */
    private readonly nodeWriteChain = new KeyedMutex();

    /** Edge-level counterpart, keyed on the directed (source,target,relation). */
    private readonly edgeWriteChain = new KeyedMutex();

    constructor(basePath: string, opts: SurrealGraphOptions = {}) {
        this.basePath = basePath;
        this.options = opts;
        this.workspaceId = opts.workspaceId ?? 'default';
        this.readCache = new ReadCache({
            maxSize: opts.cacheMaxSize ?? 500,
            ttlMs: opts.cacheTtlMs ?? 60_000,
            disabled: process.env['LORE_CACHE_DISABLED'] === '1' || opts.cacheDisabled === true,
        });
    }

    /* ── lifecycle ───────────────────────────────────────────────── */

    /**
     * initialize — open the embedded instance and apply the schema.
     * Idempotent, and concurrent first calls share one in-flight promise
     * (LocalGraph has the same guard for the same reason: parallel recalls
     * race here on a cold workspace).
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            const connection = await openSurreal(this.basePath, {
                backend: this.options.backend,
                features: this.options.features,
            });
            try {
                await applySurrealSchema(connection.db, connection.features);
            } catch (error) {
                await connection.db.close().catch(() => undefined);
                throw error;
            }
            this.connection = connection;
        })()
            .then(() => { this.initialized = true; })
            .finally(() => { this.initPromise = null; });
        return this.initPromise;
    }

    /**
     * close — release the native handle.
     *
     * Kùzu has documented close/reopen segfault behaviour in this codebase
     * (see cli/commands/migrateWorkspaceToWorkspace.ts). This engine is proven
     * against the same scenario by test/surreal-crash-recovery-unit.ts:
     * repeated close/reopen in one process, and reopen after SIGKILL.
     */
    async close(): Promise<void> {
        const connection = this.connection;
        this.connection = null;
        this.initialized = false;
        if (connection) await connection.db.close().catch(() => undefined);
    }

    /** Which on-disk backend this instance opened (`surrealkv` / `rocksdb`). */
    get backend(): SurrealBackend | null {
        return this.connection?.backend ?? null;
    }

    /** Absolute path of the on-disk store. Available before initialize(). */
    get dataPath(): string {
        return surrealDataPath(this.basePath);
    }

    /** Cache instrumentation for admin/benchmark callers. */
    getCacheStats(): CacheStats {
        return this.readCache.stats();
    }

    /* ── operations that used to exist only on Kùzu ───────────────── */
    //
    // Each of these had live callers and no SurrealDB implementation, so on a
    // Surreal-backed workspace they either threw or ran against the empty Kùzu
    // node table and returned a confident wrong answer. The two topology
    // overviews delegate their MEANING to the shared fold in
    // engines/topologyOverviewFold.ts; only the queries live in the Surreal
    // layer, so the engines cannot disagree about what the numbers mean.

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
        return overview.getTopologyOverview(this.query);
    }

    async getTopologyOverviewByType(): Promise<TopologyOverviewResult> {
        await this.initialize();
        return overview.getTopologyOverviewByType(this.query);
    }

    async getLanguageBreakdown(): Promise<Record<string, number>> {
        await this.initialize();
        return overview.getLanguageBreakdown(this.query);
    }

    async lintGraph(): Promise<string[]> {
        await this.initialize();
        return overview.lintGraph(this.query);
    }

    async findSupersededByPredecessors(byId: string): Promise<string[]> {
        await this.initialize();
        return overview.findSupersededByPredecessors(this.query, byId);
    }

    /**
     * Soft-archive. Bumps the read-cache epoch for the same reason the Kùzu
     * implementation does: without it, recall keeps surfacing the node until
     * some unrelated write happens to invalidate the cache.
     */
    async archiveNode(id: string): Promise<void> {
        await this.initialize();
        await overview.archiveNode(this.query, id, toNodeRid(id, 'archiveNode'));
        this.readCache.bumpEpoch();
    }

    /* ── internals ───────────────────────────────────────────────── */

    private db(): Surreal {
        if (!this.connection) {
            throw new LoreGraphError(
                'SurrealGraph is not initialized — await initialize() before use',
                'db',
            );
        }
        return this.connection.db;
    }

    /**
     * Run one SurrealQL statement and return its rows.
     *
     * `db.query` returns one result slot per statement; every call site here
     * sends exactly one statement, so the first slot IS the result. Statements
     * that return nothing (`DELETE` without `RETURN`) yield an empty array.
     */
    private readonly query: SurrealQuery = async (sql, vars) => {
        const results = await this.db().query<unknown[]>(sql, vars);
        const first = results[0];
        if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
        if (first == null) return [];
        return [first as Record<string, unknown>];
    };

    private get readCtx(): SurrealReadCtx {
        return {
            query: this.query,
            readCache: this.readCache,
            workspaceId: this.workspaceId,
            features: this.connection?.features,
            tally: this.callTally,
            readGetNodesByIds: (ids) => readGetNodesByIds(this.readCtx, ids),
        };
    }

    /** Per-instance operation counts. See engines/callTally.ts for why not global. */
    public readonly callTally = new CallTally();

    /** Directed BFS — same walk as traverse(), plus which way each edge points. */
    async traverseDirected(nodeId: string, maxDepth: number = 2): Promise<DirectedTraversalResult[]> {
        await this.initialize();
        return directed.traverseDirected(this.readCtx, nodeId, maxDepth);
    }

    /** listNodes' rows, narrowed to id/type/label. */
    async listNodeSummaries(
        type?: string, tag?: string, project: string = '*',
        ecosystem: string = '*', limit?: number, opts?: { unbounded?: boolean; ordered?: boolean },
    ): Promise<LoreNodeSummary[]> {
        await this.initialize();
        return directed.listNodeSummaries(this.readCtx, type, tag, project, ecosystem, limit, opts);
    }

    /** Which optional accelerations are live on this instance. */
    get features(): SurrealFeatures | null {
        return this.connection?.features ?? null;
    }

    /** Invalidate every cached read. Called after any write, same as Kùzu. */
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
        query: string,
        limit: number = 20,
        project: string = '*',
        ecosystem: string = '*',
        excludeHidden: boolean = false,
        signals?: { scanCapHit: boolean },
    ): Promise<LoreNode[]> {
        await this.initialize();
        return readSearch(this.readCtx, query, limit, project, ecosystem, excludeHidden, signals);
    }

    async listNodes(
        type?: string,
        tag?: string,
        project: string = '*',
        ecosystem: string = '*',
        limit?: number,
        opts?: { unbounded?: boolean },
    ): Promise<LoreNode[]> {
        await this.initialize();
        return readListNodes(this.readCtx, type, tag, project, ecosystem, limit, opts);
    }

    /**
     * traverse — depth-limited walk from a seed node.
     *
     * This is the capability the evaluation exists to restore: SurrealDB
     * resolves a whole frontier in ONE query per depth level, where the Kùzu
     * path issues two per frontier NODE because 0.11.3 cannot parse the
     * recursive form. Same observable contract (true per-node depth, minimum
     * depth wins, sorted by depth).
     */
    async traverse(nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
        await this.initialize();
        return readTraverse(this.readCtx, nodeId, maxDepth);
    }

    /* ── node writes ─────────────────────────────────────────────── */

    async upsertNode(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();
        return this.nodeWriteChain.run(node.id, async () => {
            const written = await writes.upsertNode(this.query, node);
            this.bumpWriteEpoch();
            return written;
        });
    }

    /**
     * bulkUpsertNodes — batched write surface the storage facade
     * feature-detects. Per-node error isolation: one bad node is reported in
     * its own result slot and the batch continues, matching LocalGraph.
     */
    async bulkUpsertNodes(
        batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
        await this.initialize();
        const results: Array<{ id: string; ok: boolean; error?: string }> = [];
        for (const node of batch) {
            try {
                await this.nodeWriteChain.run(node.id, () => writes.upsertNode(this.query, node));
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
            const deleted = await writes.deleteNode(this.query, id);
            if (deleted) this.bumpWriteEpoch();
            return deleted;
        });
    }

    /* ── edges ───────────────────────────────────────────────────── */

    async addEdge(edge: LoreEdge): Promise<void> {
        await this.initialize();
        const key = `${edge.sourceId}|${edge.targetId}|${edge.relation}`;
        await this.edgeWriteChain.run(key, () => writes.addEdge(this.query, edge));
        this.bumpWriteEpoch();
    }

    async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
        await this.addEdge(edge);
        await this.addEdge({
            sourceId: edge.targetId,
            targetId: edge.sourceId,
            relation: edge.relation,
            confidence: edge.confidence,
            confidenceScore: edge.confidenceScore,
        });
    }

    async deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
        await this.initialize();
        const count = await writes.deleteEdge(this.query, sourceId, targetId, relation);
        if (count > 0) this.bumpWriteEpoch();
        return count;
    }

    async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
        await this.initialize();
        const count = await writes.pruneInferredLoreEdges(this.query, relationPrefix);
        if (count > 0) this.bumpWriteEpoch();
        return count;
    }

    /** queryEdges — paginated edge query (GET /api/edges contract). */
    async queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
        await this.initialize();
        return aggregates.queryEdges(this.query, q);
    }

    /* ── lifecycle / maintenance ─────────────────────────────────── */

    async supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
        await this.initialize();
        return this.nodeWriteChain.run(oldId, async () => {
            const result = await writes.supersedeNode(this.query, (id) => this.getNode(id), oldId, newId, reason);
            if (result.ok) this.bumpWriteEpoch();
            return result;
        });
    }

    async unsupersedeNode(id: string): Promise<boolean> {
        await this.initialize();
        return this.nodeWriteChain.run(id, async () => {
            const ok = await writes.unsupersedeNode(this.query, (nid) => this.getNode(nid), id);
            if (ok) this.bumpWriteEpoch();
            return ok;
        });
    }

    async markStaleByTags(tags: string[]): Promise<number> {
        await this.initialize();
        const marked = await writes.markStaleByTags(this.query, tags);
        if (marked > 0) {
            this.bumpWriteEpoch();
            // Tags are caller content; the parenthesised list is redacted so a
            // personal-workspace tag ("client-acme") never lands in a log file.
            console.error(redactSurrealLog(
                `[SurrealGraph] markStaleByTags: marked ${marked} node(s) stale (tags: "${tags.join(', ')}")`,
            ));
        }
        return marked;
    }

    /**
     * pruneEphemeralNodes — delete expired ephemeral scratchpad nodes.
     *
     * Expiry math runs in JS (not SurrealQL) deliberately: LocalGraph does the
     * same, and matching it keeps the boundary cases — `ttl_ms = 0` meaning
     * "use the default", an unparseable `createdAt` — identical rather than
     * subtly re-derived in a second dialect. Non-fatal by contract: a prune
     * failure must never block boot.
     */
    async pruneEphemeralNodes(defaultTtlMs: number = 3_600_000): Promise<number> {
        await this.initialize();
        try {
            const rows = await this.query(
                `SELECT * FROM ${NODE_TABLE} WHERE ephemeral = true LIMIT $cap`,
                { cap: DEFAULT_LIST_NODES_CAP },
            );
            const now = Date.now();
            const expired: string[] = [];
            for (const row of rows) {
                const id = ridToId(row['id']);
                const createdAt = String(row['createdAt'] ?? '');
                const rawTtl = row['ttl_ms'];
                const ttl = typeof rawTtl === 'number' && rawTtl > 0 ? rawTtl : defaultTtlMs;
                if (!id || !createdAt) continue;
                const createdMs = new Date(createdAt).getTime();
                if (!Number.isFinite(createdMs)) continue;
                if (now - createdMs > ttl) expired.push(id);
            }
            if (expired.length === 0) return 0;

            let deleted = 0;
            for (const id of expired) {
                // Round-7 — the per-call-site conflict wrap from 86bb3b7 is
                // gone: writes.deleteNode now retries SurrealDB conflicts
                // itself (engine layer), so this loop inherits it without a
                // second nested retry budget.
                if (await this.deleteNode(id)) deleted++;
            }
            if (deleted > 0) {
                console.error(`[SurrealGraph] pruneEphemeralNodes: deleted ${deleted} expired ephemeral node(s)`);
            }
            return deleted;
        } catch (error) {
            console.error(
                `[SurrealGraph] pruneEphemeralNodes failed (non-fatal): ${redactSurrealLog(error)}`,
            );
            return 0;
        }
    }

    /**
     * The schema-safety subsystem's engine-specific half — blast radius, the
     * pre-destructive-change snapshot, and the migration runner.
     *
     * Exposed as a bound object rather than by making `query` public: the raw
     * query primitive stays private, and the SurrealQL those three callers
     * need lives in one audited file. This is the SurrealDB counterpart to
     * Kùzu's `getGraphContext()` escape hatch, and its existence is what lets
     * `assertKuzuGraphSubstrate` stop refusing the subsystem here.
     */
    getSchemaGraphOps(): SurrealSchemaGraphOps {
        return new SurrealSchemaGraphOps({
            query: async (sql, vars) => {
                await this.initialize();
                return this.query(sql, vars);
            },
            deleteNode: (id) => this.deleteNode(id),
            deleteEdge: (s2, t, r) => this.deleteEdge(s2, t, r),
            addEdge: (e) => this.addEdge(e as LoreEdge),
            upsertNode: (n) => this.upsertNode(
                n as unknown as Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
            ),
        });
    }

    /* ── aggregates + projections ────────────────────────────────── */
    // Bodies live in surreal/surrealGraphAggregates.ts — same split rationale
    // as LocalGraph's graphStats / graphTopology / graphBulkList / graphEdges.

    async getStats(projectFilter?: string): Promise<GraphStats> {
        await this.initialize();
        return aggregates.getStats(this.query, projectFilter, this.connection?.features);
    }

    async getTopology(
        limit: number = 300,
        projects?: string[] | string,
        edgeLimit?: number,
    ): Promise<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> {
        await this.initialize();
        return aggregates.getTopology(this.query, limit, projects, edgeLimit);
    }

    async bulkList(q: BulkListQuery): Promise<BulkListPage> {
        await this.initialize();
        return aggregates.bulkList(this.query, q);
    }

    /**
     * Engine-agnostic paged node scan — see `graphBulkList.NodePager`.
     *
     * Five maintenance callers (consistency, corpus health, supersession
     * candidates, the retention sweep, `list_nodes`) walk every node in bounded
     * pages. They previously did it through raw Cypher, so a Surreal-backed
     * workspace silently fell back to an UNBOUNDED `listNodes` — the whole node
     * table with full content in heap, which is the scale problem the paged
     * walk exists to avoid.
     */
    async bulkListProjected(
        project: string,
        columns: readonly string[],
        limit: number,
        cursor: { updatedAt: string; id: string } | null,
    ): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }> {
        await this.initialize();
        return aggregates.bulkListProjected(this.query, project, columns, limit, cursor);
    }

    /* ── typed neighbour surfaces (feature-detected by HTTP routes) ── */

    /**
     * neighbors1Hop — 1-hop out+in neighbours, shaped exactly as
     * `GET /api/node?neighbors=1` renders them.
     *
     * `nodes/getNode.ts` feature-detects this method and falls back to raw
     * Cypher when it is absent. Implementing it is what makes that route work
     * on a Surreal-backed workspace: the Cypher fallback would run against the
     * Kùzu instance, whose node table is EMPTY here, and return 200-with-no-
     * neighbours. The ArcadeDB engine carries it for the identical reason.
     *
     * Built from `queryEdges` + `getNodesByIds` (engines/graphNeighbors.ts), so
     * there is one implementation and every backend produces the same rows.
     */
    async neighbors1Hop(id: string, ecosystem: string = '*'): Promise<{ outRows: NeighborRow[]; inRows: NeighborRow[] }> {
        await this.initialize();
        return neighbors1Hop(this, id, ecosystem);
    }

    /**
     * subgraphFetch — the depth-limited BFS behind `GET /api/subgraph`, same
     * feature-detect contract and same shared implementation as
     * {@link neighbors1Hop}.
     */
    async subgraphFetch(
        centerId: string,
        center: { label: string; type: string; tags?: string[] },
        depth: number,
        limit: number,
        includeInferred: boolean,
        ecosystem: string = '*',
    ): Promise<{ nodes: SubgraphNode[]; edges: SubgraphEdge[] }> {
        await this.initialize();
        return subgraphFetch(this, centerId, center, depth, limit, includeInferred, ecosystem);
    }
}
