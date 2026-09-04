/**
 * loreStorageClient.ts — Sprint 15 storage facade.
 *
 * Closes DATAPLANE_INTEGRATION.md Section 10 item #2.
 *
 * Purpose
 * -------
 * Promote 14 scattered storage methods onto a single class so cloud
 * activation is a one-file swap rather than a 14-call-site refactor.
 * Callers depend on `LoreStorageClient` interface only; the concrete
 * routing (LocalGraph + VerbatimStore in local mode, Dataplane SDK in
 * cloud mode) lives inside this file.
 *
 * Mode swap
 * ---------
 *   const client = LoreStorageClient.fromLocal({ graph, verbatim, outbox, loadJobs });
 *   // ...all routes/tools call client.X(...)
 * Cloud mode (W4-CLOUD-FACADE-ROUTING — switchable, not stubbed):
 *   const client = LoreStorageClient.fromDataplane({ graph: dataplaneGraph,
 *       verbatim: dataplaneVectorStore, sdk });  // delegates to the adapters
 *
 * Cross-sprint sentinels preserved
 * --------------------------------
 *   - Sprint L (workspace_required): facade does not bypass workspace
 *     scoping — every method delegates to the substrate which still
 *     enforces tenant/workspace checks.
 *   - Sprint O (outbox-first): write methods (upsertNode/addEdge/
 *     supersedeNode/markStaleByTags/verbatimStore/etc.) delegate to the
 *     substrate which already runs the outbox-first dance. The facade
 *     adds no shortcut around it.
 *   - Sprint #7 + #8 (auth + perf tokens) live above the facade layer.
 *
 * Method count: 17 (Sprint 15 shipped 14; Sprint 16 added the 3 remaining
 * destructive ops — unsupersedeNode, pruneEphemeralNodes,
 * pruneInferredLoreEdges — so every destructive write goes through the
 * facade). Lower-frequency Lore-only ops (getGraphContext,
 * getLanguageBreakdown, getTopologyOverview, reconfigureCache, traverse,
 * deleteNode, deleteEdge, getEdges) remain reachable via the rawGraph()
 * escape hatch until a follow-up sprint expands the facade further.
 *
 * Size cap: 800 LOC per Sprint 15 spec. File well under.
 */

import type {
    LoreNode,
    LoreEdge,
    EdgeQuery,
    BulkListQuery,
    BulkListPage,
    GraphStats,
    GraphProvider,
    VectorProvider,
    VerbatimDocument,
    VerbatimSearchResult,
} from '../providers/types.js';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';
import { assertSurrealLicenceBoundary } from './surrealLicenceGuard.js';
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';
import { listNodesAsOf as queryNodesAsOf, type ListNodesAsOfOptions } from '../core/temporalQuery.js';

/* ─── Public handle types ─────────────────────────────────────────── */

/**
 * LoreGraphHandle — structural interface for the graph substrate.
 *
 * Extends `GraphProvider` (the core CRUD contract) with the maintenance ops
 * that both `LocalGraph` and `DataplaneGraph` implement beyond the base
 * contract: supersession, staleness marking, and pruning.  Using an interface
 * (rather than the concrete `LocalGraph | DataplaneGraph` union) lets the
 * facade call methods without `as never` casts while still accepting any
 * conforming implementation (cq-lore-graph-alias-proliferation /
 * cq-lore-storage-client-as-never).
 */
export interface LoreGraphHandle extends GraphProvider {
    supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }>;
    unsupersedeNode(id: string): Promise<boolean>;
    markStaleByTags(tags: string[]): Promise<number>;
    /**
     * 2026-09-03 (X-markstale audit fix) — the two id-scoped primitives the
     * mark_stale entry points (mcp/tools/memory/markStale.ts, POST
     * /api/mark-stale) use instead of calling `markStaleByTags` directly, so
     * the tag-resolution (read) and the actual mutation (write, chunk-locked
     * + outbox-recorded) are separate steps: `findNodeIdsByTags` resolves
     * the full matching id set ONCE up front; `markStaleByIds` applies the
     * flag to exactly the ids in ONE already-locked, already-outbox-recorded
     * chunk (mirrors deleteNode's role in the `node.delete` outbox kind).
     * `markStaleByTags` itself is UNCHANGED and stays for the CLI's
     * no-daemon direct-open fallback (cli/commands/markStale.ts), which has
     * no outbox/replicator to record against anyway.
     */
    findNodeIdsByTags(tags: string[]): Promise<string[]>;
    markStaleByIds(ids: string[]): Promise<number>;
    pruneEphemeralNodes(defaultTtlMs?: number): Promise<number>;
    pruneInferredLoreEdges(relationPrefix: string): Promise<number>;
    /**
     * Below: implemented by EVERY graph that satisfies this interface —
     * `LocalGraph`, `SurrealGraph`, `DataplaneGraph`
     * (`engines/dataplaneGraph.ts` 493, 522, 733) and the Arcade scoped handle.
     * They were absent purely because the interface predated them, which
     * pushed callers into `instanceof` checks; the first pass of the daemon
     * engine port then mistook "not on the handle" for "local only" and began
     * 501-ing `DELETE /api/edge`, `GET /api/edges` and node-list in CLOUD mode,
     * where they had been working. Declaring them here makes that class of
     * mistake impossible rather than merely discouraged.
     *
     * Two relatives are deliberately NOT here:
     *  - `bulkListProjected` — the one member `DataplaneGraph` lacks, and
     *    therefore the probe `requireWorkspaceGraph` uses to tell a local
     *    engine from the cloud one.
     *  - `getLanguageBreakdown` — `DataplaneGraph` HAS it but the Arcade
     *    handle does not, so it is neither a handle member nor a local-engine
     *    marker. It gets its own capability probe at the three call sites that
     *    want it; see `hasLanguageBreakdown`.
     */
    queryEdges(q: EdgeQuery): Promise<LoreEdge[]>;
    deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number>;
    bulkList(q: BulkListQuery): Promise<BulkListPage>;
}

/** LoreVectorHandle — structural alias for the vector substrate. */
export type LoreVectorHandle = VectorProvider;

/**
 * Optional dependency surfaces the facade hooks into. These are
 * placeholder slots for future routing — e.g. when sprint-N moves
 * upsertNode through an explicit outbox stage at the facade level.
 * For now the substrate already enforces outbox-first, so these
 * remain inert holders that future call sites can drive.
 */
export interface LoreStorageDeps {
    /** Reserved for future facade-level outbox routing. */
    outbox?: unknown;
    /** Reserved for future facade-level load_jobs routing. */
    loadJobs?: unknown;
    /**
     * 1.2 (2026-08-17 audit) — per-workspace read routing. Without these,
     * every facade read hits the boot/active graph no matter which workspace
     * a write landed in (nodeUpsert routes per-workspace; reads did not).
     * Wire `graphForWorkspace` to `LocalGraphRegistry.getGraphHandle` and
     * `verbatimForWorkspace` to the WorkspaceVerbatimResolver. When unset
     * (or no workspace is passed), methods fall back to the boot-bound
     * handles — full back-compat for existing callers.
     */
    graphForWorkspace?: (workspace: string) => Promise<LoreGraphHandle>;
    /** Per-workspace verbatim (vector) handle router. */
    verbatimForWorkspace?: (workspace: string) => Promise<LoreVectorHandle>;
}

/* ─── Cloud-mode signalling ──────────────────────────────────────── */

const CLOUD_NOT_IMPL = 'cloud_mode_not_implemented';

/**
 * CloudModeNotImplementedError — precise, per-operation signal.
 *
 * W4-CLOUD-FACADE-ROUTING: cloud mode is no longer a blanket stub. The
 * DataplaneGraph / DataplaneVectorStore adapters implement the full
 * GraphProvider / VectorProvider surface the facade routes to, so g()/v()
 * delegate to them exactly like the local handles. This error is reserved
 * for the *narrow* case where a specific cloud connector genuinely cannot
 * perform an operation (e.g. a vector connector that ranks no BM25 results),
 * surfaced via runtime feature-detection — NOT for "cloud is unwired".
 */
export class CloudModeNotImplementedError extends Error {
    public readonly code = CLOUD_NOT_IMPL;
    constructor(op: string) {
        super(`[LoreStorageClient] cloud-mode ${op} is not supported by this connector.`);
        this.name = 'CloudModeNotImplementedError';
    }
}

/* ─── Facade ─────────────────────────────────────────────────────── */

/**
 * LoreStorageClient — 14-method storage facade.
 *
 * Local-mode usage:
 *   const client = LoreStorageClient.fromLocal({ graph, verbatim });
 *
 * Cloud-mode usage (W4-CLOUD-FACADE-ROUTING):
 *   const client = LoreStorageClient.fromDataplane({ graph, verbatim, sdk });
 *
 * Constructor is private — use the static factories so the mode is
 * explicit in the call site. Methods always delegate; the facade adds
 * no behaviour, only a swap point. In BOTH modes g()/v() return the
 * constructed substrate handles — cloud is a first-class, switchable
 * backend (cloud_invariant / DEC-CLOUD-READY), not a throwing stub.
 */
export class LoreStorageClient {
    private constructor(
        private readonly mode: 'local' | 'cloud',
        private readonly graph: LoreGraphHandle | null,
        private readonly verbatim: LoreVectorHandle | null,
        private readonly sdk: GroundfloorClient | null,
        // deps reserved for future routing
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        private readonly deps: LoreStorageDeps,
    ) {
        this.workspaceRouters = {
            graphForWorkspace: deps.graphForWorkspace,
            verbatimForWorkspace: deps.verbatimForWorkspace,
        };
    }

    /** Active per-workspace routers (1.2). Empty = boot-bound reads. */
    private workspaceRouters: {
        graphForWorkspace?: (workspace: string) => Promise<LoreGraphHandle>;
        verbatimForWorkspace?: (workspace: string) => Promise<LoreVectorHandle>;
    };

    /**
     * 1.2 — post-construction router wiring. The facade is built at boot
     * BEFORE the workspace registry exists (bootSteps assigns it later), so
     * the daemon/embedded init calls this once the registry + verbatim
     * resolver are live. Routers may also be supplied up front via the
     * factory deps.
     */
    setWorkspaceRouters(routers: {
        graphForWorkspace?: (workspace: string) => Promise<LoreGraphHandle>;
        verbatimForWorkspace?: (workspace: string) => Promise<LoreVectorHandle>;
    }): void {
        this.workspaceRouters = routers;
    }

    /** Build the facade for local mode (LocalGraph + VerbatimStore). */
    static fromLocal(
        opts: {
            graph: LoreGraphHandle;
            verbatim: LoreVectorHandle;
        } & LoreStorageDeps,
    ): LoreStorageClient {
        const { graph, verbatim, ...deps } = opts;
        return new LoreStorageClient('local', graph, verbatim, null, deps);
    }

    /**
     * Build the facade for cloud mode (DataplaneGraph + DataplaneVectorStore).
     *
     * W4-CLOUD-FACADE-ROUTING: cloud now routes through the unified contract.
     * services.ts already constructs the DataplaneGraph + DataplaneVectorStore
     * handles in cloud mode; pass them here and g()/v() delegate to them
     * exactly like fromLocal returns the local handles. The `sdk` handle is
     * retained (it is what the adapters front) so any future facade-level op
     * that needs the raw SDK transport can reach it without a second factory.
     *
     * No method throws `cloud_mode_not_implemented` anymore — the adapters
     * implement the full GraphProvider / VectorProvider surface. The only
     * residual guard is verbatimBm25Search, which runtime-feature-detects
     * bm25Search on the concrete vector connector.
     */
    static fromDataplane(
        opts: {
            graph: LoreGraphHandle;
            verbatim: LoreVectorHandle;
            sdk: GroundfloorClient;
        } & LoreStorageDeps,
    ): LoreStorageClient {
        const { graph, verbatim, sdk, ...deps } = opts;
        return new LoreStorageClient('cloud', graph, verbatim, sdk, deps);
    }

    /**
     * Build the facade for a SurrealDB-backed LOCAL workspace
     * (docs/SURREALDB_BUILD_PLAN.md, Phase 1).
     *
     * Same shape as `fromLocal` — and it produces a 'local'-mode facade,
     * because that is what it is: an embedded, in-process, on-disk graph
     * substrate on the user's own machine. The engine choice is a substrate
     * detail behind `LoreGraphHandle`; it is NOT a fourth deployment mode, and
     * `getMode()` must not start reporting one.
     *
     * The separate factory exists for exactly one reason: it is the single
     * chokepoint where the BSL 1.1 boundary can be enforced in code
     * (storage/surrealLicenceGuard.ts). Routing a SurrealGraph through
     * `fromLocal` would work and would skip that check — the D-022 arch rule
     * fails the build if anything does.
     *
     * The vector substrate is unchanged: LanceDB, unconditionally. Only nodes
     * and edges move.
     */
    static fromSurreal(
        opts: {
            graph: LoreGraphHandle;
            verbatim: LoreVectorHandle;
            /** Explicit deployment mode when the caller has already resolved one. */
            deploymentMode?: string;
        } & LoreStorageDeps,
    ): LoreStorageClient {
        const { graph, verbatim, deploymentMode, ...deps } = opts;
        assertSurrealLicenceBoundary(deploymentMode);
        return new LoreStorageClient('local', graph, verbatim, null, deps);
    }

    /** Diagnostic — which backend is this facade wired to. */
    getMode(): 'local' | 'cloud' {
        return this.mode;
    }

    /* ── private helpers ─────────────────────────────────────────── */

    /**
     * Resolve the graph handle for delegation. Mode-agnostic: local mode
     * holds a LocalGraph, cloud mode holds a DataplaneGraph (both satisfy
     * LoreGraphHandle). A null handle means the facade was mis-constructed
     * (neither factory was used) — surface that as a clear failure rather
     * than a downstream TypeError.
     */
    private g(): LoreGraphHandle {
        if (!this.graph) {
            throw new Error(
                `[LoreStorageClient] no graph handle bound in ${this.mode} mode — ` +
                    'construct via fromLocal({ graph, verbatim }) or ' +
                    'fromDataplane({ graph, verbatim, sdk }).',
            );
        }
        return this.graph;
    }

    /**
     * 1.2 — resolve the graph for a workspace-scoped read. Falls back to
     * the boot-bound handle when no workspace is given, the workspace is
     * the '*' wildcard, or no router is wired (cloud mode / tests).
     */
    private async gFor(workspace?: string): Promise<LoreGraphHandle> {
        if (workspace && workspace !== '*' && this.workspaceRouters.graphForWorkspace) {
            return this.workspaceRouters.graphForWorkspace(workspace);
        }
        return this.g();
    }

    /** 1.2 — verbatim twin of gFor. */
    private async vFor(workspace?: string): Promise<LoreVectorHandle> {
        if (workspace && workspace !== '*' && this.workspaceRouters.verbatimForWorkspace) {
            return this.workspaceRouters.verbatimForWorkspace(workspace);
        }
        return this.v();
    }

    private v(): LoreVectorHandle {
        if (!this.verbatim) {
            throw new Error(
                `[LoreStorageClient] no vector handle bound in ${this.mode} mode — ` +
                    'construct via fromLocal({ graph, verbatim }) or ' +
                    'fromDataplane({ graph, verbatim, sdk }).',
            );
        }
        return this.verbatim;
    }

    /* ── (1-9) Graph methods ─────────────────────────────────────── */

    /**
     * (1) upsertNode — write-through to graph substrate.
     * Sprint O: substrate enqueues to outbox; facade does not bypass.
     * 1.1 (2026-08-18): wrapped in withTransactionConflictRetry — this is the
     * documented embedded-mode write API, and concurrent callers hit
     * SurrealDB's retryable "Transaction conflict" error here just like the
     * four surfaces wrapped in the prior round.
     */
    async upsertNode(
        node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    ): Promise<LoreNode> {
        return withTransactionConflictRetry(() => this.g().upsertNode(node));
    }

    /**
     * (1b) bulkUpsertNodes — RA2-reaudit2 batched write surface. Delegates to
     * the local graph's single-trip bulkUpsertNodes (~1.9x faster than N×
     * upsertNode on a full re-scan: one connection/queue-slot for the batch,
     * statements prepared once). Non-local (cloud) backends fall back to a
     * per-node loop with the same per-node {id, ok, error} result shape, so
     * embedded + HTTP callers get one batched API regardless of backend.
     */
    async bulkUpsertNodes(
        batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
        const graph = this.g();
        // Feature-detect a batched implementation rather than testing for the
        // concrete LocalGraph class. LocalGraph provides one (single prepared-
        // statement loop); the ArcadeDB db-per-app adapter provides one
        // (single-round-trip sqlscript chunks). Both are reached through the
        // SAME facade method with no behavior change for backends that lack it
        // (cloud), which fall through to the per-node loop below. (Was:
        // `isLocalGraph(graph)`, which silently loop-fell-back for arcade.)
        type BulkFn = (
            b: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
        ) => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
        const bulk = (graph as { bulkUpsertNodes?: BulkFn }).bulkUpsertNodes;
        if (typeof bulk === 'function') return bulk.call(graph, batch);
        const out: Array<{ id: string; ok: boolean; error?: string }> = [];
        for (const node of batch) {
            // 1.1 — same retry wrapper as upsertNode: the per-node fallback
            // loop hits the same concurrent-write conflict class.
            try { await withTransactionConflictRetry(() => graph.upsertNode(node)); out.push({ id: node.id, ok: true }); }
            catch (e) { out.push({ id: node.id, ok: false, error: (e as Error).message }); }
        }
        return out;
    }

    /** (2) getNode — point lookup by id.
     *  1.2: pass `{ workspace }` to read from that workspace's graph;
     *  omitted = boot/active graph (legacy behavior). */
    async getNode(id: string, opts?: { workspace?: string }): Promise<LoreNode | null> {
        const graph = await this.gFor(opts?.workspace);
        return graph.getNode(id);
    }

    /**
     * (3) listNodes — filter by type/tag/project/ecosystem.
     * Sprint L: workspace scoping is enforced by the substrate via
     * the project/ecosystem parameters.
     */
    async listNodes(
        type?: string,
        tag?: string,
        project: string = '*',
        ecosystem: string = '*',
        limit?: number,
        opts?: { unbounded?: boolean; workspace?: string },
    ): Promise<LoreNode[]> {
        // DataplaneGraph.listNodes signature is a subset; both accept the
        // 4-positional + optional limit shape via overload-tolerant pass.
        // SW-18: also forward the `opts` unbounded flag so batch callers
        // that go through LoreStorageClient preserve their opt-in.
        // 1.2: `opts.workspace` routes the read to that workspace's graph.
        const graph = await this.gFor(opts?.workspace);
        return graph.listNodes(type, tag, project, ecosystem, limit, opts);
    }

    /**
     * (3b) listNodesAsOf — bi-temporal "as-of" query (core/temporalQuery.ts).
     * Same filter/scope params as listNodes, plus `at` (required ISO 8601
     * timestamp): returns only nodes whose validFrom/validUntil window
     * covers that instant, or that never set a window at all (always
     * valid). Read-only — Core never sets validFrom/validUntil itself; the
     * embedding host decides those explicitly (see LoreNode).
     */
    async listNodesAsOf(at: string, opts?: ListNodesAsOfOptions): Promise<LoreNode[]> {
        return queryNodesAsOf(this.g(), at, opts);
    }

    /** (4) search — full-text search across nodes.
     *  1.2: `opts.workspace` routes to that workspace's graph. NOTE the
     *  third positional is PROJECT, not workspace (the pre-1.2 docs had
     *  them swapped — passing a workspace name in the project slot only
     *  worked because of the project===workspace invariant on the boot
     *  graph and silently read the wrong database for any other
     *  workspace). */
    async search(
        query: string,
        limit: number = 20,
        project: string = '*',
        ecosystem: string = '*',
        opts?: { workspace?: string },
    ): Promise<LoreNode[]> {
        const graph = await this.gFor(opts?.workspace);
        return graph.search(query, limit, project, ecosystem);
    }

    /** (5) addEdge — relationship insertion. Sprint O outbox preserved.
     *  1.1 (2026-08-18): same conflict-retry wrap as upsertNode. */
    async addEdge(edge: LoreEdge): Promise<void> {
        return withTransactionConflictRetry(() => this.g().addEdge(edge));
    }

    /** (6) getStats — graph cardinality + per-project counts.
     *  1.2: `opts.workspace` routes to that workspace's graph. */
    async getStats(projectFilter?: string, opts?: { workspace?: string }): Promise<GraphStats> {
        // DataplaneGraph getStats takes no args today; LocalGraph accepts
        // an optional projectFilter. Pass it through; the cloud branch
        // ignores it harmlessly.
        const graph = await this.gFor(opts?.workspace);
        return graph.getStats(projectFilter);
    }

    /** (7) getTopology — node + edge graph snapshot for the UI. */
    async getTopology(
        limit: number = 300,
        projects?: string[] | string,
        edgeLimit?: number,
    ): Promise<{ nodes: any[]; edges: any[] }> {
        return this.g().getTopology(limit, projects, edgeLimit);
    }

    /** (8) supersedeNode — replace one node with another (audit-trail). */
    async supersedeNode(
        oldId: string,
        newId: string,
        reason?: string,
    ): Promise<{ ok: boolean; reason?: string }> {
        return this.g().supersedeNode(oldId, newId, reason);
    }

    /** (9) markStaleByTags — bulk staleness flag for retention sweep. */
    async markStaleByTags(tags: string[]): Promise<number> {
        return this.g().markStaleByTags(tags);
    }

    /* ── (9a-9c) Sprint 16 — remaining destructive ops ───────────── */

    /**
     * (9a) unsupersedeNode — reverse a prior supersession.
     * Sprint 16: brought through the facade so cloud activation can swap
     * one implementation. Local + Dataplane both implement parity.
     */
    async unsupersedeNode(id: string): Promise<boolean> {
        return this.g().unsupersedeNode(id);
    }

    /**
     * (9b) pruneEphemeralNodes — delete expired ephemeral scratchpad nodes.
     * Sprint 16: facade route for the retention sweep. defaultTtlMs is
     * applied only to ephemeral nodes that have no explicit ttl. Both
     * substrates implement this with the same default (1h).
     */
    async pruneEphemeralNodes(defaultTtlMs: number = 3_600_000): Promise<number> {
        return this.g().pruneEphemeralNodes(defaultTtlMs);
    }

    /**
     * (9c) pruneInferredLoreEdges — delete every LoreEdge whose relation
     * matches the prefix (inferred-relation cleanup). Used by reconnect
     * + maintenance flows. Sprint 16 routes through the facade.
     */
    async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
        return this.g().pruneInferredLoreEdges(relationPrefix);
    }

    /* ── (10-14) Verbatim methods ────────────────────────────────── */

    /**
     * (10) verbatimStore — embed + persist a verbatim document.
     * Sprint O: substrate flow does embed-first then snapshot/delete/add
     * so a failed embed doesn't corrupt history. Facade preserves that.
     */
    async verbatimStore(doc: VerbatimDocument): Promise<void> {
        return this.v().store(doc);
    }

    /** (11) verbatimSearch — vector similarity search.
     *  1.2: `opts.workspace` routes to that workspace's vector store. */
    async verbatimSearch(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
        opts?: { includeHistory?: boolean; workspace?: string },
        actorScopes?: ReadonlyArray<string>,
    ): Promise<VerbatimSearchResult[]> {
        // DataplaneVectorStore.search has the same interface signature;
        // opts + actorScopes are optional so the cloud variant ignores
        // them harmlessly if its implementation doesn't use them.
        const store = await this.vFor(opts?.workspace);
        const { workspace: _ws, ...rest } = opts ?? {};
        return store.search(query, limit, filter, rest, actorScopes);
    }

    /** (12) verbatimCount — total document count (diagnostics).
     *  1.2: `opts.workspace` routes to that workspace's vector store. */
    async verbatimCount(opts?: { workspace?: string }): Promise<number> {
        const store = await this.vFor(opts?.workspace);
        return store.count();
    }

    /** (13) verbatimDelete — tombstone a verbatim doc by id. */
    async verbatimDelete(id: string): Promise<void> {
        return this.v().delete(id);
    }

    /** (14) verbatimBm25Search — lexical BM25 fallback path. Returns a
     *  `Bm25Envelope`: `hits` plus `ranked` (whether `hits` is a genuine
     *  BM25/lexical ranking or an unranked substring fallback that must be
     *  excluded from RRF — see engines/verbatimBm25Result.ts). */
    async verbatimBm25Search(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<Bm25Envelope<VerbatimSearchResult>> {
        // Both VerbatimStore and DataplaneVectorStore implement bm25Search,
        // so this delegates in both modes. The runtime feature-detect stays
        // as the precise, per-connector guard: if a future cloud vector
        // connector ships without lexical ranking, callers get a typed
        // CloudModeNotImplementedError instead of an opaque "fn is not a
        // function" — the one operation a specific connector genuinely can't do.
        const store = this.v();
        // Feature-detect: bm25Search is optional on the VectorProvider contract
        // (not every connector supports lexical ranking). Cast to the structural
        // shape we expect rather than importing the concrete VerbatimStore class.
        type Bm25Fn = (q: string, l: number, f?: Partial<VerbatimDocument['metadata']>, s?: ReadonlyArray<string>) => Promise<Bm25Envelope<VerbatimSearchResult>>;
        const fn = (store as { bm25Search?: Bm25Fn }).bm25Search;
        if (typeof fn !== 'function') {
            throw new CloudModeNotImplementedError('bm25Search');
        }
        return fn.call(store, query, limit, filter, actorScopes);
    }

    /* ── escape hatch ────────────────────────────────────────────── */

    /**
     * Engine-internal escape hatch. Use for the long-tail Lore-only ops
     * that the facade does not (yet) wrap: getGraphContext,
     * traverse, getLanguageBreakdown, getTopologyOverview*, deleteNode,
     * deleteEdge, reconfigureCache.
     * Call sites that reach for this should be migrated when the facade
     * expands in a follow-up sprint.
     */
    rawGraph(): LoreGraphHandle {
        return this.g();
    }

    /** Engine-internal escape hatch — verbatim long-tail (storeBatch, etc.). */
    rawVerbatim(): LoreVectorHandle {
        return this.v();
    }
}
