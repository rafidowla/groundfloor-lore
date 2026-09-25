/**
 * retrieveSeedStore.ts — resolve the verbatim (vector) store retrieve()'s own
 * seed step should read from.
 *
 * Extracted out of retrieve.ts (fix/search-worker-call-cancellation, 3.20.2
 * follow-up, independent-review finding 4): `retrieve.ts` crossed the repo's
 * 800-line hard cap on this branch from a previously-compliant 774 lines, and
 * `resolveSeedStore` — the seed-store resolution/selection decision plus the
 * per-call `gate` wiring it bakes into the returned closures — is a single,
 * cohesive, low-coupling concern that owns none of retrieveInner()'s own
 * fusion/traversal/budget logic. Moving it here is the same move
 * `querySeedStore.ts` already made for the hand-rolled (non-retrieve())
 * read surfaces — see that file's own docblock for the sibling decision.
 *
 * P2 (scalability) — resolve the verbatim store for the READ's OWN workspace.
 *
 * The boot-bound `storageClient` verbatim methods only see the active
 * workspace's LanceDB. Without this, a recall against any NON-active
 * workspace had `verbatimConsulted=false` and fell back to a full-table
 * keyword CONTAINS scan — no semantic/BM25 path — which undercuts
 * local-mode's multi-app promise. The outbox replicator already writes
 * vectors per-workspace and the `WorkspaceVerbatimResolver` (getOrOpen)
 * resolves a workspace's own VerbatimStore, so retrieve() threads it here and
 * seeds against the target store.
 *
 * Selection:
 *   - Reading the boot/active graph → the boot storageClient adapter
 *     (unchanged path; reuses the daemon's already-open handle).
 *   - Reading a non-active workspace WITH a resolver → getOrOpen(workspace).
 *   - No resolver, or open fails (never-embedded / missing LanceDB) → null,
 *     and the caller degrades gracefully to the keyword path (no throw).
 *
 * assertWorkspaceOpenAllowed runs inside resolver.getOrOpen (the substrate
 * chokepoint), so a bound route slot only opens the workspace it's
 * authorized for — recall opens exactly the workspace the gate resolved.
 *
 * 3.21 step 3(a) — resolving the store is NOT itself an embedding call: it
 * only wires up closures. mode:'keyword' calls ONLY the returned `bm25Search`
 * closure (a lexical query, no embedding provider involved); `search` (the
 * semantic method, which embeds the query) is never touched by that mode.
 * (3.21 had split this same function out to `resolveSeedStore.ts` in
 * parallel with 3.20.2's extraction here; the 3.21/main merge consolidated
 * on this module so the signal/gate wiring is kept.)
 *
 * License: original work for groundfloor-lore.
 */

import type { StorageBundle } from '../mcp/services.js';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';
import {
    seedWithEcosystemUnion,
    bm25WithEcosystemUnion,
    unionSeedHits,
    unionBm25Envelopes,
    type VerbatimSeedHit,
} from './ecosystemSeedUnion.js';
import {
    pieceAwareSearch,
    resolvePieceRouting,
    pieceCalibrationIdentityFor,
    type PieceSearchStats,
    type PieceVectorsMeta,
} from './pieceSeedSearch.js';

/** Minimal view of a verbatim (vector) store the seed step needs. Both
 *  `LoreStorageClient` (boot-bound, via a thin adapter below) and a
 *  per-workspace `VerbatimStore` from the resolver satisfy it — actor-scope
 *  filtering happens inside each implementation (getCurrentActorScopes()). */
export interface VerbatimSeedStore {
    count(): Promise<number>;
    search(query: string, limit: number): Promise<VerbatimSeedHit[]>;
    bm25Search(query: string, limit: number): Promise<Bm25Envelope<VerbatimSeedHit>>;
    /** D1 review fix — the UNDERLYING store object these closures wrap (the
     *  boot storageClient, or the resolver's per-workspace VerbatimStore).
     *  calibration.ts keys its cache on this identity so a reopened store
     *  (new embedder / re-embed / a second Lore instance in the same process
     *  using the same workspace name) never reuses another store's null fit. */
    readonly calibrationIdentity?: object;
    /** D7b — `_meta.pieceVectors` value for this resolved seed store.
     *  Present whenever the underlying store's piece-vectors intent is on
     *  (even when not currently 'active' — see resolvePieceRouting),
     *  `undefined` when intent is off so retrieve.ts omits the key entirely
     *  and default (opt-out) responses stay byte-identical (design 2.5). */
    readonly pieceStatus?: PieceVectorsMeta;
    /** D7b — filled by side effect during `search()` ONLY when `pieceStatus`
     *  is `'active'` (piece search actually ran). retrieve.ts reads this
     *  AFTER awaiting `search()` to fill in `piecesFetched`/`nodesGrouped` on
     *  `_meta.pieceVectors`. Overwritten on each `search()` call within a
     *  single resolveSeedStore-produced store — "last call wins" (see
     *  pieceSeedSearch.ts's PieceSearchStats docblock). */
    readonly pieceStats?: PieceSearchStats;
}

/** The subset of RetrieveContext this decision needs. Structural — kept
 *  narrow and self-contained (rather than importing `RetrieveContext` itself)
 *  so this module has no dependency back on retrieve.ts. */
export interface RetrieveSeedStoreDeps {
    store: StorageBundle;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. When
     * wired, a recall against a NON-active workspace resolves that
     * workspace's OWN verbatim store (getOrOpen) and runs the semantic + BM25
     * seed pass against it, instead of gating semantic consultation to the
     * boot workspace only. Omitted (cloud mode / test fixtures) ⇒ non-active
     * recall degrades to the keyword path, exactly as before this was
     * threaded in.
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<{
            count(): Promise<number>;
            /**
             * `gate` (fix/search-worker-call-cancellation, 3.20.2 follow-up)
             * is appended at the SAME positional slot as the real
             * VerbatimStore's own gate param (see
             * engines/verbatimWorkerProtocol.ts's GATE_ARG_SLOT.search = 5 —
             * 0-indexed, i.e. the 6th positional argument here). Every caller
             * in this file passes `opts`/`actorScopes` as explicit
             * `undefined` rather than omitting them, so `gate` can never land
             * in the wrong slot the way a bare append would. The real
             * resolver always returns a `VerbatimStore`, which already has
             * exactly this signature — this widened structural type just
             * lets TS see it.
             */
            search(query: string, limit: number, filter?: { ecosystem?: string; type?: string | string[] }, opts?: unknown, actorScopes?: ReadonlyArray<string>, gate?: { signal?: AbortSignal; deadline?: number }): Promise<VerbatimSeedHit[]>;
            /** Same slot discipline as `search` above — GATE_ARG_SLOT.bm25Search = 4
             *  (0-indexed, the 5th positional argument here). */
            bm25Search(query: string, limit: number, filter?: { ecosystem?: string; type?: string | string[] }, actorScopes?: ReadonlyArray<string>, gate?: { signal?: AbortSignal; deadline?: number }): Promise<Bm25Envelope<VerbatimSeedHit>>;
        }>;
    };
}

export async function resolveSeedStore(
    ctx: RetrieveSeedStoreDeps,
    workspace: string,
    isBootGraph: boolean,
    ecosystemScope: string,
    signal?: AbortSignal,
    types?: string[],
    project?: string,
): Promise<VerbatimSeedStore | null> {
    // fix/search-worker-call-cancellation (3.20.2 follow-up): baked into the
    // closures below as a fixed value captured once per retrieveInner() call,
    // rather than threaded as a per-invocation parameter on VerbatimSeedStore's
    // own search()/bm25Search() — resolveSeedStore has exactly one call site
    // (retrieve.ts) with one signal per call, so there is no "intervening
    // optional parameter" that could ever shift this into the wrong slot the
    // way GATE_ARG_SLOT documents for the worker-IPC boundary. Each closure
    // below passes `opts`/`actorScopes` as an explicit `undefined` so `gate`
    // always lands in the SAME positional slot the real store's own method
    // expects (VerbatimStore.search's 6th arg / bm25Search's 5th — see
    // engines/verbatimWorkerProtocol.ts GATE_ARG_SLOT).
    const gate = signal ? { signal } : undefined;
    // Push ecosystem scoping INTO the vector/BM25 query itself (the
    // underlying store already supports a metadata filter pushdown — see
    // VERBATIM_FILTERABLE_COLUMNS), instead of fetching a fixed-size GLOBAL
    // top-K window and filtering after hydration. Without this, a workspace
    // shared by many ecosystems crowds a given ecosystem's own real
    // candidates out of that fixed window as unrelated ecosystems'
    // data accumulates — confirmed via the LongMemEval benchmark: raw
    // candidate count for one fixed-size ecosystem fell from 150 to single
    // digits purely as other ecosystems' data piled into the same shared
    // workspace. (The same benchmark note recorded a ~15x seed-latency
    // growth. Do NOT read that as a latency win for the pushdown as it
    // stands: `seedWithEcosystemUnion` always ALSO issues the unscoped
    // query, which is the slow one, so wall clock is back at roughly the
    // pre-pushdown figure. What survives is candidate QUALITY. The full
    // accounting — including the halved scoped-recall throughput and the 4x
    // hydration ceiling in hybrid mode — is on seedWithEcosystemUnion.)
    //
    // CORRECTNESS still belongs to the post-hydration filter further down in
    // retrieve.ts: it reads the GRAPH node's ecosystem, which is
    // authoritative, whereas the pushdown reads the verbatim ROW's metadata
    // copy, which can disagree. `seedWithEcosystemUnion` therefore ALWAYS
    // pairs the scoped query with the unscoped one so a disagreement degrades
    // instead of deleting real results — see its docstring for why that
    // union cannot be made conditional.
    const filter = ecosystemScope !== '*' ? { ecosystem: ecosystemScope } : undefined;
    // D2 (P1) — the type/kind prefilter. Unlike `filter` above, this is NOT
    // handed to seedWithEcosystemUnion/bm25WithEcosystemUnion as their own
    // "scoped" predicate: that union deliberately ALSO issues an UNSCOPED
    // query as a correctness backstop against ecosystem-metadata staleness
    // (see ecosystemSeedUnion.ts's docstring) — reusing it for `type` would
    // silently reintroduce the exact crowding-out defect D2 exists to fix,
    // since the union's unscoped leg would still search the full unfiltered
    // corpus. Instead `types` is merged into BOTH legs unconditionally below
    // (the `f` closure param the union already threads through to every
    // query it issues, scoped or not), so it is a hard filter no union or
    // fallback can bypass.
    const typesFilter = types && types.length > 0 ? types : undefined;
    const withTypes = (f: { ecosystem?: string } | undefined): { ecosystem?: string; type?: string[] } | undefined => {
        if (!typesFilter) return f;
        return { ...f, type: typesFilter };
    };
    // E2 — `project` (a real verbatim column). NOT merged into every leg like
    // `types`: the verbatim row's project is a write-time copy that can
    // disagree with the graph node's (bulkIngest/outbox writers fall back to
    // the workspace or ecosystem name when the node has none; the autolink
    // store path writes the workspace name), and retrieve.ts filters on the
    // GRAPH node's project. So the pre-E2 queries run unchanged and ONE extra
    // project-scoped query is unioned in (unionSeedHits): rows whose vector
    // project is right can no longer be crowded out, and rows whose copy is
    // stale are still found exactly as before. '' = no filter (same
    // truthiness as passesEntitiesTopicsProject). See CHANGELOG [Unreleased].
    const projectScope = project ? project : undefined;
    type SeedFilter = { ecosystem?: string; type?: string[]; project?: string } | undefined;
    const projectScoped = (): SeedFilter => ({ ...withTypes(filter), project: projectScope });
    const vectorSeeds = (run: (lim: number, f: SeedFilter) => Promise<VerbatimSeedHit[]>, n: number): Promise<VerbatimSeedHit[]> => {
        const base = seedWithEcosystemUnion((lim, f) => run(lim, withTypes(f)), n, filter);
        return projectScope ? unionSeedHits(base, run(n, projectScoped())) : base;
    };
    const bm25Seeds = (run: (lim: number, f: SeedFilter) => Promise<Bm25Envelope<VerbatimSeedHit>>, n: number): Promise<Bm25Envelope<VerbatimSeedHit>> => {
        const base = bm25WithEcosystemUnion((lim, f) => run(lim, withTypes(f)), n, filter);
        return projectScope ? unionBm25Envelopes(base, run(n, projectScoped())) : base;
    };
    if (isBootGraph) {
        // Active/boot workspace — the boot storageClient's verbatim methods see
        // exactly this workspace's LanceDB. Adapt it to the seed-store shape.
        // (Unchanged pre-P2 path.)
        const sc = ctx.store.storageClient;
        // D7b (design 2.5 step 2-3) — the RAW verbatim handle (not the
        // storageClient wrapper) is what exposes searchPieces/
        // pieceIndexStatus/pieceVectorsIntentOn, so routing is decided
        // against it, not `sc`. `rawVerbatim` is a real `LoreStorageClient`
        // method, but this branch's `sc` is typed only as `StorageBundle`'s
        // `storageClient`, and several existing tests construct a minimal
        // structural `storageClient` fixture (verbatimCount/verbatimSearch/
        // verbatimBm25Search only, e.g. r3221-d1-recall-option-parity-unit.ts)
        // that never implements it — feature-detect the same way
        // resolvePieceRouting itself feature-detects `rawStore`, rather than
        // assuming every storageClient exposes the escape hatch.
        const rawStore = typeof sc.rawVerbatim === 'function' ? sc.rawVerbatim() : undefined;
        const routing = resolvePieceRouting(rawStore);
        const pieceStats: PieceSearchStats = { piecesFetched: 0, nodesGrouped: 0 };
        const pooledRun = (q: string) => (lim: number, f: SeedFilter) => sc.verbatimSearch(q, lim, f, undefined, undefined, gate);
        const pieceRun = (q: string) => (lim: number, f: SeedFilter) =>
            pieceAwareSearch(routing.capable!, q, lim, f as Record<string, unknown> | undefined, undefined, gate, pieceStats);
        const runFor = routing.active ? pieceRun : pooledRun;
        return {
            // D1 — a distinct identity when piece mode is active so the
            // calibration cache re-fits instead of reusing a pooled-vector-
            // era null distribution (design 2.5). Keyed off `routing.capable`
            // (guaranteed non-null exactly when `routing.active` is true —
            // see resolvePieceRouting) rather than `rawStore` directly, since
            // `rawStore` itself is `object | undefined` now that it degrades
            // gracefully for a storageClient without a `rawVerbatim` escape
            // hatch.
            calibrationIdentity: routing.active ? pieceCalibrationIdentityFor(routing.capable!) : sc,
            count: () => sc.verbatimCount(),
            search: (q, n) => vectorSeeds(runFor(q), n),
            // bm25Search/count stay canonical — piece vectors only affect the
            // semantic leg (design 2.5 step 4).
            bm25Search: (q, n) => bm25Seeds((lim, f) => sc.verbatimBm25Search(q, lim, f, undefined, gate), n),
            pieceStatus: routing.meta,
            pieceStats: routing.active ? pieceStats : undefined,
        };
    }
    // NON-active workspace. The boot storageClient only knows the ACTIVE
    // workspace's vectors, so it must NEVER be used here — seeding a wsB recall
    // from wsA's LanceDB would surface foreign ids (the exact confinement bug,
    // and it also suppresses wsB's keyword fallback when a boot seed id collides
    // with a wsB node). Without a per-workspace resolver we therefore return
    // null → the caller degrades to wsB's own keyword scan (pre-P2 behavior).
    if (!ctx.workspaceVerbatimResolver) return null;
    try {
        const store = await ctx.workspaceVerbatimResolver.getOrOpen(workspace);
        // D7b — same routing decision as the boot branch above, against the
        // resolved per-workspace store itself (it IS the raw store here,
        // there is no separate wrapper to unwrap).
        const routing = resolvePieceRouting(store);
        const pieceStats: PieceSearchStats = { piecesFetched: 0, nodesGrouped: 0 };
        const pooledRun = (q: string) => (lim: number, f: SeedFilter) => store.search(q, lim, f, undefined, undefined, gate);
        const pieceRun = (q: string) => (lim: number, f: SeedFilter) =>
            pieceAwareSearch(routing.capable!, q, lim, f as Record<string, unknown> | undefined, undefined, gate, pieceStats);
        const runFor = routing.active ? pieceRun : pooledRun;
        return {
            calibrationIdentity: routing.active ? pieceCalibrationIdentityFor(store) : store,
            count: () => store.count(),
            search: (q, n) => vectorSeeds(runFor(q), n),
            bm25Search: (q, n) => bm25Seeds((lim, f) => store.bm25Search(q, lim, f, undefined, gate), n),
            pieceStatus: routing.meta,
            pieceStats: routing.active ? pieceStats : undefined,
        };
    } catch {
        // Never-embedded workspace, missing/corrupt LanceDB, or a chokepoint
        // denial — degrade to the keyword path rather than failing the recall.
        return null;
    }
}
