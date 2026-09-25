/**
 * retrieve.ts — the ONE shared retrieval core (Retrieval Unification, P1).
 *
 * Every surface (REST /api/search + /api/recall, the MCP search + recall tools,
 * embedded recall, the CLI) is meant to call this single function so the same
 * query returns the same results everywhere. See docs/RETRIEVAL_UNIFICATION.md.
 *
 * This is a FAITHFUL extraction of the recall pipeline (semantic + BM25 →
 * reciprocal-rank-fusion → keyword fallback → re-rank → graph traversal → token
 * budget), restructured to return a uniform, presentation-agnostic result set
 * with provenance (`matchedBy`) and a `score` on every result. Presentation
 * concerns (summary vs full shaping, the deferred sidecar, the cross-language
 * hint, auto-escalation) stay in the per-surface PRESETS (P2), not here.
 *
 * Decisions locked in docs/RETRIEVAL_UNIFICATION.md:
 *   - D1: this is the canonical pipeline (extracted from recall/inProcessRecall).
 *   - D3: queries are searched RAW — no typo/normalization/expansion in core.
 *   - D4: one result contract with `matchedBy` + `score` on every result.
 *
 * Scope note (P1): single-workspace is fully implemented here. Cross-workspace
 * (workspace:"*") still lives in mcp/tools/recallCrossWorkspace.ts and is folded
 * into this core in the next increment; calling retrieve() with "*" throws so no
 * surface silently gets a divergent path.
 *
 * ⚠️ RESPONSE SHAPE CHANGE (2026-09-23, fix/d4-traversal-separate-field, NOT
 * the same "D4" as the "one result contract" decision above — different D4,
 * an unfortunate naming collision): `results` used to interleave
 * graph-traversal neighbours (depth >= 1, `source: 'via:<seedId>'`) into the
 * SAME ranked array as direct matches, counted in `meta.totalMatched`/
 * downstream `shown`/`totalRecalled`. Fixed: `results` is now direct matches
 * ONLY; neighbours come back in a separate `related: RelatedResult[]` field
 * and are never counted in those totals. Full before/after, the `maxTokens`
 * truncation-scope decision and every surface this touches: see
 * recall/README.md and docs/RETRIEVAL_UNIFICATION.md's D4-defect-fix
 * addendum, plus the CHANGELOG entry.
 */

import type { LoreNode } from '../providers/types.js';
import { WorkspaceNotFoundError } from '../engines/localGraphRegistry.js';
import { curatedTypesFromSchema, reRankLoreNodes } from './ranking.js';
import { DEFAULT_SCHEMA_V2 } from '../schemas/types.js';
import { ensureAccessTracker } from '../engines/accessTracker.js';
import { estimateTokens } from '../mcp/tools/search/helpers.js';
import { ecosystemMatches } from '../core/ecosystemMatch.js';
import { fetchSeeds } from './multiQuerySeedFetch.js';
import { timeRecallStage, timeRecallStageSync, withRecallStageTiming } from './recallStageTiming.js';
import { resolveSeedStore } from './retrieveSeedStore.js';
import { filterNodesByActorScope, passesEntitiesTopicsProject } from './retrieveFilters.js';
import { resolveCandidateFloor, candidateLimit, resolveLexicalBase, computeSeedBaseScores } from './candidateWindow.js';
import { getCalibration } from './calibration.js';
import { decideAbstention, DEFAULT_RELEVANCE_FLOOR } from './abstention.js';
import { computeTermCoverage, seedText, resolveTermCoverage, resolveTermCoverageMin, DEFAULT_TERM_COVERAGE_TOP_K, DEFAULT_TERM_COVERAGE_Z_MARGIN } from './termCoverage.js';
import { applyIdentifierLane } from './identifierLane.js';
import type {
    MatchKind,
    RetrievalResult,
    RelatedResult,
    RetrieveOptions,
    RetrieveMeta,
    RetrieveOutcome,
    RetrieveContext,
} from './retrieveTypes.js';

// Re-exported for backward compatibility — every existing
// `import type {...} from './retrieve.js'` call site keeps working
// unmodified after the type extraction to retrieveTypes.ts (800-line cap).
export type {
    MatchKind,
    RetrievalResult,
    RelatedResult,
    RetrieveOptions,
    RetrieveMeta,
    RetrieveOutcome,
    RetrieveContext,
} from './retrieveTypes.js';
import { replaceSupersededInResults, applyCorrectsAdjacency, refillSeedSlots } from './supersessionRecall.js';
import { withOwnRelevance, collectRelated, splitCorrectsInjections } from './retrieveRelated.js';
import { applyRerankStageIfEnabled } from './rerankStage.js';

/** Same shape/behavior as inProcessRecall.ts's own toAbortError and
 *  searchGate.ts's — deliberately NOT shared (see those files' notes on the
 *  pattern being repeated per-module rather than factored out). Used both for
 *  this file's own eager pre-check (fix/search-worker-call-cancellation, req.
 *  3) and nowhere else — the actual in-flight cancellation is handled by
 *  SearchGate/cachedRead once the signal reaches VerbatimStore. */
function toAbortError(signal: AbortSignal): Error {
    const reason = (signal as { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const err = new Error(reason !== undefined ? String(reason) : 'aborted');
    err.name = 'AbortError';
    return err;
}

/* ─── Internals ────────────────────────────────────────────────── */
/* Unified contract (D4) types — MatchKind, RetrievalResult, RelatedResult,
 * RetrieveOptions, RetrieveMeta, RetrieveOutcome, RetrieveContext — now live
 * in ./retrieveTypes.ts (split out to stay under the file-size cap) and are
 * imported + re-exported above; see that file for the full field docs. */

const DEFAULT_LIMIT = 10;
/** 3.21 step 3(f) — max EXTRA phrasings alongside the primary query. */
const MAX_EXTRA_QUERIES = 5;
// Over-fetch the vector seeds so archived/superseded rows (which the vector
// store can't exclude in-query) don't starve the live top-`limit` window; the
// hidden filter + slice below trim back to `limit` live seeds. (R4 #3.)
const SEED_HIDDEN_HEADROOM = 4;
// Finding 5.3 — a FIXED over-fetch only moves the starvation threshold from
// `limit` to `limit × SEED_HIDDEN_HEADROOM`: once more hidden rows outrank
// every live node for a topic, live nodes fall out of the fetched window
// with no fall-through/signal. So when the post-filter seed set is under-full
// AND the store filled the whole requested window, retrieve() re-fetches
// with a doubled window (up to this multiple of `limit`) before giving up —
// flagging `possibleStarvation` when the window is STILL full after the
// final retry, so a starved/empty result is never confident absence.
const SEED_MAX_HEADROOM = 16;

/** Minimal view of the graph methods the core uses (keeps casts out of the
 *  pipeline; every `LoreGraphHandle` — SurrealDB or the Dataplane cloud adapter — satisfies it). */
interface RetrievalGraph {
    search(q: string, n: number, ws: string, eco: string, excludeHidden?: boolean, signals?: { scanCapHit: boolean }, types?: string[], entities?: string[], topics?: string[]): Promise<LoreNode[]>;
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
    /** `relation` is present on every real engine's TraversalResult
     *  (providers/types.ts) — widened here (was omitted) so the D4 fix can
     *  carry the REAL edge relation into `RelatedResult` instead of
     *  inventing one. */
    traverse(id: string, depth: number): Promise<Array<{ node: LoreNode; depth: number; relation: string }>>;
    queryEdges?(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>; // D5, optional — older test doubles may omit it
}

type HiddenFlags = LoreNode & { supersededAt?: unknown; status?: string };

/**
 * fix/3.22.1-d1-recall-option-parity — test-only instrumentation seam. Unset
 * (null) in every real code path; a parity test sets it to capture the exact
 * `opts` object (and therefore its key set, including explicitly-`undefined`
 * values) each caller passes into `retrieve()`, without needing a mocking
 * framework or module-loader hooks. Never read or written outside tests.
 */
// fix/3.22.1-recall-parity review fix (5): setter-only — the mutable
// variable itself is no longer exported, so a caller can only ever go
// through setRetrieveOptionsSpy() (no direct read/write of the closed-over
// state from outside this module).
let retrieveOptionsSpy: ((opts: RetrieveOptions) => void) | null = null;
export function setRetrieveOptionsSpy(spy: ((opts: RetrieveOptions) => void) | null): void {
    retrieveOptionsSpy = spy;
}

/**
 * retrieve — the single shared retrieval entry point.
 */
export async function retrieve(
    ctx: RetrieveContext,
    query: string,
    opts: RetrieveOptions,
): Promise<RetrieveOutcome> {
    retrieveOptionsSpy?.(opts);
    return withRecallStageTiming(() => retrieveInner(ctx, query, opts));
}

async function retrieveInner(
    ctx: RetrieveContext,
    query: string,
    opts: RetrieveOptions,
): Promise<RetrieveOutcome> {
    const {
        workspace,
        ecosystem,
        mode = 'hybrid',
        depth = 1,
        limit = DEFAULT_LIMIT,
        tags,
        types: typesFilter,
        includeArchived = false,
        includeSuperseded = false,
        maxTokens,
        crossProject = false,
        queries: extraQueries,
        entities: entitiesFilter,
        topics: topicsFilter,
        project: projectFilter,
        signal,
        // D1 (calibrated relevance + abstention) — env-var fallbacks so an
        // operator can opt every caller in without touching every surface's
        // Zod schema default. An explicit `opts.abstain`/`relevanceFloor`
        // always wins over the env var.
        abstain: abstainOpt,
        relevanceFloor: relevanceFloorOpt,
        abstainTermCoverage: abstainTermCoverageOpt,
        candidateFloor: candidateFloorOpt,
        lexicalBase: lexicalBaseOpt,
    } = opts;
    // D3 §3.1 — candLimit is what every candidate-generation step below
    // fetches; `limit` itself is used ONLY for the final `.slice(0, limit)`.
    // This is what makes `top-k@k == first k of top-<candLimit>` hold by
    // construction for every k <= candLimit.
    const candidateFloor = resolveCandidateFloor(candidateFloorOpt);
    const candLimit = candidateLimit(limit, candidateFloor);
    const lexicalBaseMode = resolveLexicalBase(lexicalBaseOpt, candidateFloor);
    const abstain = abstainOpt ?? /^(1|true)$/i.test(process.env.LORE_RECALL_ABSTAIN ?? '');
    const relevanceFloor = relevanceFloorOpt
        ?? (process.env.LORE_RECALL_RELEVANCE_FLOOR ? Number(process.env.LORE_RECALL_RELEVANCE_FLOOR) : DEFAULT_RELEVANCE_FLOOR);
    // 3.21 step 3(f) — primary query + up to MAX_EXTRA_QUERIES extras, deduped.
    // A single-element list (no `queries` supplied) reduces every rrfFuse
    // call below to fusing ONE list per leg — byte-identical order/score to
    // the pre-3.21-f single-query math (rrfFuse's formula IS the prior
    // rrfScores formula) — so omitting `queries` is exactly today's behaviour.
    const allQueries = [...new Set([query, ...(extraQueries ?? []).slice(0, MAX_EXTRA_QUERIES)])];

    // fix/search-worker-call-cancellation (3.20.2 follow-up, req. 3): a
    // signal that is already aborted before retrieve() does any work must
    // short-circuit here — before graph resolution, before resolveSeedStore,
    // before any seed-store call is even constructed — so an eager abort
    // never wastes a SearchGate permit or a native search-worker call.
    if (signal?.aborted) throw toAbortError(signal);

    if (workspace === '*') {
        // P1 scope — cross-workspace still lives in recallCrossWorkspace.ts and
        // is folded into this core in the next increment. Surfaces route "*"
        // there meanwhile; failing loud here prevents a silent divergent path.
        throw new Error('retrieve(): workspace="*" (cross-workspace) is not yet handled by the shared core — route to runCrossWorkspaceRecall until it is folded in.');
    }

    // 1. Resolve the target graph (named workspace via the registry).
    // getGraphHandle resolves the workspace's DECLARED engine, so a
    // Surreal-backed workspace reads/writes its own graph rather than an
    // empty database for a different engine (and still runs
    // assertWorkspaceOpenAllowed via getOrOpen internally first).
    // `WorkspaceGraph` — like `LoreGraph` — already
    // satisfies `RetrievalGraph` structurally (search/getNodesByIds/
    // traverse are on the shared `GraphProvider` base), so no cast is
    // needed here any more.
    let graph: RetrievalGraph = ctx.store.loreGraph;
    const bootGraph: RetrievalGraph = ctx.store.loreGraph;
    if (ctx.graphRegistry) {
        try {
            graph = await ctx.graphRegistry.getGraphHandle(workspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                throw Object.assign(new Error(`retrieve(): unknown workspace "${workspace}"`), { code: 'workspace_not_found', requested: err.requested, known: err.known });
            }
            throw err;
        }
    }

    // A named workspace already resolves to its own graph. `project` is a
    // caller-owned node field and is not guaranteed to equal the workspace
    // name (Atlas v3 stores project='v3' inside workspace='default'). Using
    // the workspace name here silently makes keyword fallback empty while the
    // vector path still appears healthy. Keep the physical workspace boundary
    // from graph resolution and search all projects inside that graph, UNLESS
    // the caller explicitly asked for one via the `project` filter option (E2
    // — same real column D2 already pushes `types` alongside; this is not the
    // workspace name, it is the caller's own opt-in project scope). `||`,
    // not `??`: `project: ""` (e.g. REST `?project=`) means NO filter, the
    // same as passesEntitiesTopicsProject's truthiness check — `??` would
    // scope the keyword leg to empty-project rows and return nothing.
    const workspaceScope = projectFilter || '*';
    const ecosystemScope = crossProject ? '*' : (ecosystem ?? '*');

    // 2. Resolve the verbatim store for the READ's OWN workspace. P2
    //    (scalability): the boot storageClient only sees the active
    //    workspace's LanceDB, so before this a non-active recall had NO
    //    semantic/BM25 path and fell back to a full-table keyword scan.
    //    `resolveSeedStore` returns the boot store for the active graph
    //    (unchanged), the target workspace's own VerbatimStore when the
    //    resolver is wired, or null (never-embedded / missing store) to
    //    degrade to the keyword path — never throwing.
    //
    //    3.21 step 3(a) — resolved for EVERY mode now, including 'keyword'.
    //    Resolving the store is NOT an embedding call (it only wires up
    //    `count`/`search`/`bm25Search` closures); mode:'keyword' below calls
    //    ONLY `bm25Search` on it (the store's lexical/BM25 index — a plain
    //    text query, no embedding provider involved) and NEVER `search`
    //    (the semantic method, which embeds the query). Before this, keyword
    //    mode never resolved a seed store at all and so never saw the
    //    verbatim store's own BM25 ranking — it fell straight to the graph's
    //    LIKE/FTS text leg (runKeywordSeeds below), which still runs today
    //    as a supplementary/fallback source, unioned with the bm25 seeds
    //    exactly like the hybrid path unions its keyword supplement (Finding
    //    5.1, below).
    const seedStore = await resolveSeedStore(ctx, workspace, graph === bootGraph, ecosystemScope, signal, typesFilter, projectFilter);
    const verbatimConsulted = seedStore !== null
        ? (await seedStore.count()) > 0
        : false;

    // Provenance for seeds: id -> { matchedBy, score }. Filled by the seed step.
    const seedProvenance = new Map<string, { matchedBy: Set<MatchKind>; score: number; rrf?: number }>();
    // D3 r2 — bm25 leg candidate count, a selectivity signal (candidateWindow.ts).
    let bm25CandidateCount = 0;
    let seedNodeIds: string[] = [];
    // Raw semantic similarity per STRIPPED graph id, for `meta.topScore`.
    // Recorded during the seed pass but only reduced to a single number at the
    // very END of the pipeline (step 6.5), i.e. after the ecosystem/hidden
    // filters, the re-rank slice, the `tags` filter AND the token-budget
    // truncation — so topScore always describes a node the caller actually
    // receives. It cannot be taken from the raw hit list: `seedWithEcosystemUnion`
    // deliberately includes an unscoped query, so the top raw hit is routinely a
    // node the ecosystem filter then drops — and topScore drives recallPreset's
    // confidence + auto-escalation, which must not be decided by a node the
    // caller never sees.
    const semanticScoreById = new Map<string, number>();
    // D1 — the PRIMARY phrasing's semantic scores only (see
    // multiQuerySeedFetch.ts's SeedFetchOutcome.primarySemanticScoreById doc).
    const primarySemanticScoreById = new Map<string, number>();
    let topScore: number | null = null;
    let scanCapHit = false;
    // fix/fts-index-and-tokenizer (item 2) — true unless a hybrid-mode bm25
    // seed pass comes back unranked (the LIKE-scan fallback, every hit
    // force-scored 1.0). Unaffected by 'semantic'/'keyword' modes, which
    // never consult bm25Search at all.
    let bm25Ranked = true;
    // 3.21 step 3(c) — set true when a semantic fetch was skipped because
    // the embedding provider is disabled (caught EmbeddingDisabledError).
    let vectorLegSkipped = false;
    // Finding 5.3 — see SEED_MAX_HEADROOM. Set after the adaptive over-fetch
    // retries below; only the vector seed path can starve.
    let possibleStarvation = false;

    /**
     * One seed pass at the given window size, across every query phrasing
     * in `allQueries` (3.21 step 3(f) — the fan-out + fusion itself lives in
     * recall/multiQuerySeedFetch.ts, split out for the file-size cap).
     * Clears and refills seedNodeIds / seedProvenance / semanticScoreById,
     * so the adaptive over-fetch retry (5.3) can call it again with a
     * larger window without leaking stale entries from the smaller pass.
     * Returns the raw pre-dedup fetch count (`=== seedFetch` means the
     * store held at least that many rows for at least one phrasing — the
     * retry/go signal for the starvation loop).
     */
    const runVectorSeedFetch = async (seedFetch: number): Promise<number> => {
        const outcome = await fetchSeeds(seedStore, allQueries, mode, seedFetch);
        seedNodeIds = outcome.seedNodeIds;
        seedProvenance.clear();
        for (const [k, v] of outcome.seedProvenance) seedProvenance.set(k, v);
        bm25CandidateCount = outcome.bm25CandidateCount;
        semanticScoreById.clear();
        for (const [k, v] of outcome.semanticScoreById) semanticScoreById.set(k, v);
        primarySemanticScoreById.clear();
        for (const [k, v] of outcome.primarySemanticScoreById) primarySemanticScoreById.set(k, v);
        bm25Ranked = outcome.bm25Ranked;
        if (outcome.vectorLegSkipped) vectorLegSkipped = true;
        return outcome.rawWindowCount;
    };
    let seedFetch = candLimit * SEED_HIDDEN_HEADROOM;
    let rawSeedWindow = 0;
    if (verbatimConsulted) {
        rawSeedWindow = await runVectorSeedFetch(seedFetch);
    }

    // 3. Build the seed node set: hydrate vector seeds, or keyword-search.
    //
    // The keyword branch is a SECOND RETRIEVAL PATH, not merely an
    // "index-is-cold" branch, and it is the only one that is ecosystem-scoped
    // AT THE DATABASE (`graph.search(query, limit, project, ecosystemScope)`).
    // It runs as the PRIMARY path when there are no vector seeds, and as an
    // always-on SUPPLEMENTARY seed source (merged by id) when there are —
    // see Finding 5.1 below.
    const runKeywordSeeds = async (): Promise<LoreNode[]> => {
        const searchSignals = { scanCapHit: false };
        const hits = await graph.search(query, candLimit, workspaceScope, ecosystemScope, true, searchSignals, typesFilter, entitiesFilter, topicsFilter); // D2: query-level types filter (fixed top-K scan can else fill with off-type rows); E2: entities/topics/project pushed the same way (workspaceScope above is already projectFilter || '*'); D3: candLimit window
        scanCapHit = searchSignals.scanCapHit;
        // D3 r2 — min of two non-zero leg counts (more selective leg wins).
        bm25CandidateCount = bm25CandidateCount > 0 && hits.length > 0 ? Math.min(bm25CandidateCount, hits.length) : (bm25CandidateCount || hits.length);
        hits.forEach((n, idx) => {
            // Keyword rank → 0..1 score; provenance 'keyword'.
            if (!seedProvenance.has(n.id)) seedProvenance.set(n.id, { matchedBy: new Set<MatchKind>(['keyword']), score: 1 / (idx + 1) });
            else seedProvenance.get(n.id)!.matchedBy.add('keyword');
        });
        return hits;
    };

    const hydrateVectorSeeds = async (): Promise<LoreNode[]> => {
        const out: LoreNode[] = [];
        const stripped = seedNodeIds.map((id) => (id.startsWith('lore:') ? id.slice(5) : id));
        const map = await timeRecallStage('hydrate', () => graph.getNodesByIds(stripped));
        // carry seedProvenance keyed by the (possibly lore:-prefixed) id onto the
        // stripped graph id.
        seedNodeIds.forEach((rawId, i) => {
            const sid = stripped[i]!;
            const node = map.get(sid);
            if (node) {
                if (!seedProvenance.has(sid)) seedProvenance.set(sid, seedProvenance.get(rawId)!);
                out.push(node);
            }
        });
        return out;
    };

    /**
     * The seed filter chain, applied identically to whichever branch produced
     * the raw seeds. Kept in one place so the fall-through below cannot apply a
     * different (weaker) set of filters than the primary path.
     *
     * D2-recall-1: drop seeds the actor isn't scoped for BEFORE assembling
     * results. The keyword branch (graph.search) and the vector-hydrate branch
     * (graph.getNodesByIds) both read localGraph directly and neither applies
     * row-level scope filtering — only VerbatimStore does, on the vector path.
     * Vector seeds were already filtered in the store; re-filtering here is
     * idempotent (same actorScopes source), so one pass over the final seed set
     * is simplest and safe. Ranking/order is preserved (filter, not sort).
     *
     * Ecosystem confinement, applied to the vector-hydrate seed path too.
     * THIS is the correctness boundary, not the query pushdown in
     * resolveSeedStore(): it tests the hydrated GRAPH node's ecosystem, which
     * is authoritative. The pushdown tests the verbatim row's metadata COPY of
     * that value, which is an optimisation (it stops other ecosystems crowding
     * the fixed top-K window) and can be stale or wrong — which is precisely
     * why seedWithEcosystemUnion never lets the pushdown be the only thing
     * standing between a node and its recall: it always unions in the unscoped
     * query so THIS check gets to see the disputed rows.
     *
     * The comparison is `ecosystemMatches`, NOT `===`. A node stored with
     * `'*'`/`''` is UNSCOPED and belongs in every scope — that is the settled
     * meaning of `'*'` (core/ecosystemMatch.ts), and `'*'` is the
     * `LoreNode.ecosystem` column DEFAULT, so `===` here hid every node ever
     * written without an explicit ecosystem from its own owner. Two other
     * surfaces in this codebase (engines/reconnect.ts `ecosystemConfinement`,
     * supersessionCandidates.ts) already read `'*'` as a wildcard; the strict
     * reading here was the odd one out. crossProject/'*' (search-everything) is
     * unaffected: ecosystemScope is already '*' there, so this is a no-op.
     */
    const applySeedFilters = (raw: LoreNode[]): LoreNode[] => {
        return timeRecallStageSync('filter', () => {
            let s = filterNodesByActorScope(raw);
            if (ecosystemScope !== '*') s = s.filter((n) => ecosystemMatches(n.ecosystem, ecosystemScope));
            if (!includeArchived) s = s.filter((n) => (n as HiddenFlags).status !== 'archived'); // D5: supersededAt no longer filtered here — replaced downstream
            if (typesFilter && typesFilter.length > 0) s = s.filter((n) => typesFilter.includes(n.type)); // D2 backstop
            // E2 — entities/topics/project backstop, moved INTO applySeedFilters
            // (same function `types` uses) so the adaptive over-fetch widening
            // loop below — whose retry condition is `seeds.length < candLimit`
            // AFTER applySeedFilters runs — actually sees a shortfall caused by
            // these filters and retries with a wider seedFetch, instead of
            // silently returning a starved window the way a POST-loop filter
            // would. `project` is pushed down on the keyword leg and as an
            // ADDITIONAL scoped query on the vector/BM25 leg (see
            // resolveSeedStore), so this is the authoritative check for it; `entities`/`topics` have no verbatim-row column to push
            // into (VerbatimDocument['metadata'] carries no such fields), so
            // for the vector/BM25 leg THIS loop is the only crowding-out
            // mitigation they get — the keyword leg gets true pushdown via
            // graph.search()'s JSON-path filtering instead (sqliteGraphReads.ts
            // / surrealGraphReads.ts).
            if (entitiesFilter || topicsFilter || projectFilter) s = s.filter((n) => passesEntitiesTopicsProject(n, entitiesFilter, topicsFilter, projectFilter));
            return s;
        });
    };

    let seeds: LoreNode[];
    if (!verbatimConsulted || seedNodeIds.length === 0) {
        seeds = applySeedFilters(await runKeywordSeeds());
    } else {
        seeds = applySeedFilters(await hydrateVectorSeeds());

        // ─── Finding 5.3 — adaptive over-fetch against hidden-row starvation ──
        //
        // The vector store can't exclude archived/superseded rows in-query, so
        // the fixed limit×SEED_HIDDEN_HEADROOM window only MOVED the
        // starvation threshold: with >seedFetch higher-similarity hidden rows,
        // every live node fell outside the window and recall reported a
        // confident false negative (verified live: 45 archived + 1 live at
        // similarity 0.950 → totalRecalled 0). When the filtered seed set is
        // under-full but the store FILLED the requested window (so more rows
        // exist beyond it), re-fetch with a doubled window — bounded by
        // SEED_MAX_HEADROOM so a pathological topic costs at most ~3 vector
        // queries. A still-full, still-starved window after the final retry
        // raises `possibleStarvation` so the response is an honest "we could
        // not see far enough", never a confident "no stored memory".
        // D3 — retry keyed to candLimit (=== limit in legacy) so every limit
        // <= candLimit sees the same candidate set (prefix stability).
        while (seeds.length < candLimit && rawSeedWindow >= seedFetch && seedFetch < candLimit * SEED_MAX_HEADROOM) {
            seedFetch = Math.min(seedFetch * 2, candLimit * SEED_MAX_HEADROOM);
            rawSeedWindow = await runVectorSeedFetch(seedFetch);
            seeds = applySeedFilters(await hydrateVectorSeeds());
        }
        // D3 §3.1 — stays keyed to `limit`, not `candLimit`: meaning unchanged.
        possibleStarvation = seeds.length < limit && rawSeedWindow >= seedFetch;

        // ─── Finding 5.1 — supplementary keyword seed scan, ALWAYS unioned ──
        //
        // A vector (ANN) search always returns its top-K once the workspace's
        // LanceDB holds ANY row, so `seedNodeIds` is never empty and the
        // keyword branch above was dead code on every populated workspace —
        // and the confinement fall-through that used to sit here was gated on
        // `ecosystemScope !== '*'`, which the DEFAULT scope never satisfies.
        // Consequence: any graph node with NO verbatim row (embed:false
        // writes, failed/dropped embeddings) was permanently unreachable
        // through the default recall path. The keyword scan (bounded at
        // `limit`, the same bound the old fall-through used) now runs on
        // EVERY vector-seeded recall as a supplementary seed source, merged
        // by id exactly as the fall-through merged — it can only ADD nodes
        // the vector window missed, never replace vector seeds. This also
        // subsumes the old ecosystem-confinement fall-through: that gated
        // rescue existed because a foreign ecosystem's vectors could fill
        // seedNodeIds while the DB-scoped keyword scan would have found the
        // requested ecosystem's own nodes; running the scan unconditionally
        // rescues that case and the unscoped default too.
        const byId = new Map(seeds.map((n) => [n.id, n]));
        for (const n of applySeedFilters(await runKeywordSeeds())) {
            if (!byId.has(n.id)) byId.set(n.id, n);
        }
        seeds = [...byId.values()];
    }

    // Finding 5.2 — the tags predicate must select from the WHOLE seed window
    // (the limit×headroom over-fetch plus the keyword supplement), not from
    // whatever survived the top-`limit` re-rank slice. Previously the filter
    // ran AFTER `.slice(0, limit)`, so a genuinely tag-matching node ranked
    // 11th+ was silently excluded and recall asserted the topic had no stored
    // memory. Applied to seeds here; the results-level filter below still
    // covers traversal NEIGHBOURS (they enter after this point).
    if (tags && tags.length > 0) {
        const lowerSeedTags = tags.map((t) => t.toLowerCase().trim());
        seeds = seeds.filter((n) => {
            const nodeTags = n.tags ?? [];
            return lowerSeedTags.every((t) => nodeTags.includes(t));
        });
    }
    // E2 — entities/topics/project filtering moved INTO applySeedFilters
    // (above, near the D2 types backstop) so it participates in the adaptive
    // over-fetch widening loop's shortfall detection. Every seed-producing
    // path (runKeywordSeeds, hydrateVectorSeeds, the widen-loop retry) already
    // runs through applySeedFilters, so a second pass here would be a no-op
    // — removed rather than kept as a defensive duplicate.

    // fix/fts-index-and-tokenizer (item 2): sourcesConsulted must not claim
    // 2 (semantic + bm25, or graph-keyword + bm25) when the seed pass ran
    // bm25Search but it came back unranked and was excluded above — only the
    // OTHER source actually contributed. mode==='semantic' is unaffected
    // (bm25Ranked stays at its true default there, matching its pre-existing
    // "2" behavior). 3.21 step 3(a): mode:'keyword' consults the same
    // bm25Ranked signal — a genuinely-ranked bm25 pass alongside the graph's
    // own keyword leg is 2 sources; an unranked bm25 pass degrades to 1
    // (graph keyword only), exactly like hybrid degrading to semantic-only.
    // 3.21 step 3(c): `vectorLegSkipped` (embeddings disabled) forces 1
    // regardless of mode/bm25Ranked — the semantic leg contributed nothing,
    // so at most the graph-keyword/bm25 leg did.
    // D1 note: moved up from just above the (former) seeds.length===0 check
    // so the abstention short-circuit below (which also reports
    // sourcesConsulted in its _meta) can reference it before declaration.
    const sourcesConsulted = (!verbatimConsulted || vectorLegSkipped)
        ? 1
        : ((mode === 'hybrid' || mode === 'keyword') && !bm25Ranked ? 1 : 2);

    // D1 (calibrated relevance + abstention) — `s*`: the max raw vector-leg
    // cosine similarity across the PRIMARY phrasing's semantic seed hits,
    // computed HERE (after seed-level tags/entities/topics/project filters,
    // BEFORE the Finding-5.4 re-rank / `.slice(0, limit)` below) — a
    // deliberately DIFFERENT statistic from `topScore` below (6.5), which is
    // reduced from the FINAL post-everything `results`. `s*` gates whether
    // the query is "about anything this workspace has stored" at all;
    // `topScore` describes what the caller actually receives. Always
    // computed (not gated on `abstain`) — the `_meta` calibration/relevance
    // fields are always on per the design; only the SHORT-CIRCUIT below is
    // gated on `abstain`.
    let topSimilarity: number | null = null;
    for (const n of seeds) {
        const s = primarySemanticScoreById.get(n.id);
        if (s !== undefined && (topSimilarity === null || s > topSimilarity)) topSimilarity = s;
    }
    // D2 x D1: seedStore carries the D2 `types` prefilter (resolveSeedStore), so
    // calibration probes run type-scoped — key the fit on that filter so a
    // type-filtered null distribution never serves an unfiltered query.
    const typesKey = typesFilter && typesFilter.length > 0 ? [...new Set(typesFilter)].sort().join(',') : '*';
    // Review fix: never probe when the vector leg is not in play — mode:'keyword'
    // must NEVER call the embedding provider (3.21 step 3(a) contract), and an
    // embeddings-disabled / empty store has nothing to calibrate. null ⇒ not_applicable.
    const calibrationStore = (mode === 'keyword' || vectorLegSkipped || !verbatimConsulted) ? null : seedStore;
    // Hosts that leave abstention off (the default) shouldn't pay a blocking
    // first-query calibration cost for an additive _meta field — the fit
    // runs in the background (status 'pending' until it lands). abstain:true
    // still blocks, since gating needs the floor to mean something on the
    // very first query.
    const calibration = await getCalibration(calibrationStore, workspace, typesKey, { blocking: abstain });
    // D1 term coverage (opt-in, abstain-only) is judged AFTER re-rank + the D3
    // identifier lane, on the final fused top-k — see the second decision below.
    const termCoverageOn = abstain && resolveTermCoverage(abstainTermCoverageOpt);
    let abstention = decideAbstention({
        topSimilarity, calibration, abstain, relevanceFloor, query, reportReason: termCoverageOn,
        // label + content: an identifier is "stored" whether it's named in the
        // node's label (e.g. a code symbol's `name (path)`) or its body.
        seedContents: seeds.map(seedText),
    });
    let abstentionMeta = {
        ...(abstention.abstainOverridden ? { abstainOverridden: abstention.abstainOverridden } : {}),
        ...(abstention.abstainReason ? { abstainReason: abstention.abstainReason } : {}),
        ...(abstention.termCoverage !== undefined ? { termCoverage: abstention.termCoverage } : {}),
    };
    const abstainedResult = (): RetrieveOutcome => ({
        // Per design §3: an abstained query returns ZERO results and
        // traversal never runs (no wasted graph hops on a query the
        // calibration says is off-topic for this workspace).
        results: [],
        related: [],
        meta: {
            topScore: null, sourcesConsulted, totalMatched: 0, truncated: false, droppedCount: 0,
            directMatches: 0, verbatimConsulted, scanCapHit, possibleStarvation, bm25Ranked, vectorLegSkipped,
            candidateWindow: verbatimConsulted ? seedFetch : 0, prefixStableUpTo: candLimit,
            topSimilarity: topSimilarity !== null ? parseFloat(topSimilarity.toFixed(3)) : null,
            topRelevance: abstention.topRelevance !== null ? parseFloat(abstention.topRelevance.toFixed(2)) : null,
            relevanceFloor, belowFloor: abstention.belowFloor, abstained: true, ...abstentionMeta,
            calibration: { status: calibration.status, version: calibration.version, probes: calibration.probes, rows: calibration.rows, nullMedian: calibration.nullMedian, nullScale: calibration.nullScale, scope: workspace },
        },
    });
    if (abstention.abstained) return abstainedResult();

    // Finding 5.4 / D3 §3.5 — real relevance score per seed (see candidateWindow.ts).
    const seedBaseScores = computeSeedBaseScores(seeds, semanticScoreById, seedProvenance, lexicalBaseMode, { candidateFloor, bm25CandidateCount, candLimit });
    const curatedTypes = ctx.curatedTypes ?? curatedTypesFromSchema(DEFAULT_SCHEMA_V2.nodeTypes);
    // D3 §3.3 — minute-bucketed "now" keeps recency (and the ranking)
    // deterministic within 60s; full legacy (floor 0 + rrf) keeps Date.now().
    const fullLegacy = candidateFloor === 0 && lexicalBaseMode === 'rrf';
    const rankNowMs = fullLegacy ? undefined : Math.floor(Date.now() / 60_000) * 60_000;
    let rankedSeeds = reRankLoreNodes(seeds, rankNowMs, seedBaseScores, curatedTypes);
    // D3 follow-up — exact-identifier lane (identifierLane.ts): anchored mode
    // only (floor > 0), never mode:'semantic'. Fixed-size lane fetch keeps it prefix-stable.
    if (candidateFloor > 0 && mode !== 'semantic') {
        rankedSeeds = await applyIdentifierLane(query, rankedSeeds, {
            bm25Search: seedStore && verbatimConsulted ? (q, n) => seedStore.bm25Search(q, n) : undefined,
            keywordSearch: (q, n) => graph.search(q, n, workspaceScope, ecosystemScope, true, { scanCapHit: false }, typesFilter),
            hydrate: (ids) => graph.getNodesByIds(ids),
            admit: (raw) => applySeedFilters(raw).filter((n) => (!tags || tags.length === 0 || tags.every((t) => (n.tags ?? []).includes(t.toLowerCase().trim())))
                && (!(entitiesFilter || topicsFilter || projectFilter) || passesEntitiesTopicsProject(n, entitiesFilter, topicsFilter, projectFilter))),
            provenance: seedProvenance,
        });
    }
    if (termCoverageOn && !abstention.abstained && rankedSeeds.length > 0) {
        // D1 term coverage vs the FINAL fused order (post re-rank + lane), so an
        // identifier only the lane found is covered AND rescues.
        const rankedTexts = rankedSeeds.map(seedText);
        abstention = decideAbstention({
            topSimilarity, calibration, abstain, relevanceFloor, query, seedContents: rankedTexts,
            termCoverage: { coverage: computeTermCoverage(query, rankedTexts.slice(0, Math.min(limit, DEFAULT_TERM_COVERAGE_TOP_K)), rankedTexts).coverage,
                min: resolveTermCoverageMin(), zMargin: DEFAULT_TERM_COVERAGE_Z_MARGIN },
        });
        abstentionMeta = {
            ...(abstention.abstainOverridden ? { abstainOverridden: abstention.abstainOverridden } : {}),
            ...(abstention.abstainReason ? { abstainReason: abstention.abstainReason } : {}),
            ...(abstention.termCoverage !== undefined ? { termCoverage: abstention.termCoverage } : {}),
        };
        if (abstention.abstained) return abstainedResult();
    }
    seeds = rankedSeeds.slice(0, limit); const seedSpillover = rankedSeeds.slice(limit); // D5 #6(a): feeds refillSeedSlots below

    if (seeds.length === 0) {
        return {
            results: [],
            related: [],
            meta: {
                topScore, sourcesConsulted, totalMatched: 0, truncated: false, droppedCount: 0, directMatches: 0,
                verbatimConsulted, scanCapHit, possibleStarvation, bm25Ranked, vectorLegSkipped,
                candidateWindow: verbatimConsulted ? seedFetch : 0, prefixStableUpTo: candLimit,
                topSimilarity: topSimilarity !== null ? parseFloat(topSimilarity.toFixed(3)) : null,
                topRelevance: abstention.topRelevance !== null ? parseFloat(abstention.topRelevance.toFixed(2)) : null,
                relevanceFloor, belowFloor: abstention.belowFloor, abstained: abstention.abstained, ...abstentionMeta,
                calibration: { status: calibration.status, version: calibration.version, probes: calibration.probes, rows: calibration.rows, nullMedian: calibration.nullMedian, nullScale: calibration.nullScale, scope: workspace },
                ...(seedStore?.pieceStatus ? { pieceVectors: seedStore.pieceStatus } : {}),
            },
        };
    }

    // 4. Assemble the DIRECT result set (seeds only — depth 0). Graph
    //    traversal neighbours are collected SEPARATELY below (D4 fix,
    //    fix/d4-traversal-separate-field): they must never share this map,
    //    or a neighbour could silently shadow/collide with a seed and, more
    //    importantly, would count toward `results.length` again — the exact
    //    defect this fix removes. `collected` preserves seed order (already
    //    re-ranked above), which becomes `results`' final order.
    let collected = new Map<string, RetrievalResult>();
    for (const n of seeds) {
        const prov = seedProvenance.get(n.id) ?? { matchedBy: new Set<MatchKind>(['keyword']), score: 0 };
        collected.set(n.id, { node: n, score: prov.score, matchedBy: [...prov.matchedBy], depth: 0, source: 'seed' });
    }

    // 4.1 D5: a superseded direct match's slot goes to its live successor
    //     (refilled back to `limit` from the ranked spillover). Runs on the
    //     DIRECT map only, before traversal, so `related[].via` always names
    //     a node in `results`. `admitD5` = the seed visibility gate (actor
    //     scope, ecosystem, archived, superseded, D2 `types`) for nodes
    //     supersessionRecall fetches itself.
    const admitD5 = (n: LoreNode): boolean => filterNodesByActorScope([n]).length > 0 && (ecosystemScope === '*' || ecosystemMatches(n.ecosystem, ecosystemScope)) && (includeArchived || (n as HiddenFlags).status !== 'archived') && (includeSuperseded || !(n as HiddenFlags & { supersededBy?: string | null }).supersededBy) && (!typesFilter || typesFilter.length === 0 || typesFilter.includes(n.type));
    if (!includeSuperseded) collected = await refillSeedSlots(await replaceSupersededInResults(collected, graph, admitD5), seedSpillover, limit, graph, admitD5, seedProvenance); // D5 #6(a)
    // 4.2 D1: each direct result's OWN similarity / calibrated relevance
    //     (after D5, so a successor never inherits a dead node's values).
    collected = withOwnRelevance(collected, semanticScoreById, calibration);

    // 4.5 Graph traversal (D4) — a SEPARATE collection, never merged into
    //     `results`; superseded hops are replaced by live successors (D5).
    const relatedCollected = await collectRelated(collected, graph, {
        depth, filterByActorScope: filterNodesByActorScope, admit: admitD5, replaceSuperseded: !includeSuperseded,
        // Ecosystem confinement on every HOP (traverse() has no ecosystem
        // predicate; same '*' escape hatch as seeds) + archived hidden.
        hopAllowed: (n) => (ecosystemScope === '*' || ecosystemMatches(n.ecosystem, ecosystemScope)) && (includeArchived || (n as HiddenFlags).status !== 'archived'),
    });

    // 5. `results` = direct matches only, in re-ranked order.
    let results = Array.from(collected.values());
    let related = Array.from(relatedCollected.values());

    if (tags && tags.length > 0) {
        const lower = tags.map((t) => t.toLowerCase().trim());
        const passesTags = (n: LoreNode) => {
            const nodeTags = (n as { tags?: string[] }).tags ?? [];
            return lower.every((t) => nodeTags.includes(t));
        };
        results = results.filter((r) => passesTags(r.node));
        related = related.filter((r) => passesTags(r.node));
    }
    // 3.21 step 3(f) — same filter, now applied to BOTH `results` and
    // `related` (entered after the seed-level filter above ran).
    if (entitiesFilter || topicsFilter || projectFilter) {
        results = results.filter((r) => passesEntitiesTopicsProject(r.node, entitiesFilter, topicsFilter, projectFilter));
        related = related.filter((r) => passesEntitiesTopicsProject(r.node, entitiesFilter, topicsFilter, projectFilter));
    }

    let rerankMeta; ({ results, rerankMeta } = await applyRerankStageIfEnabled(results, query, opts.rerank, workspace)); // D8: fail-open top-K re-rank (rerankStage.ts)
    // D5: corrects pairs adjacent (before truncation). Injected, non-matching
    // corrects targets move to `related` (D4 contract: never ranked/counted).
    ({ results, related } = splitCorrectsInjections(await applyCorrectsAdjacency(results, graph, admitD5), related));

    // 6. Token-budget truncation — applies to `results` (the ranked, counted
    //    array) only. `related` is presentational context for a direct match
    //    and is deliberately NOT subject to the token budget or to
    //    `totalMatched`/`shown`-style counts (D4 fix) — see CHANGELOG.
    const totalMatched = results.length;
    let truncated = false;
    let droppedCount = 0;
    if (maxTokens && maxTokens > 0) {
        let budget = maxTokens;
        const kept: RetrievalResult[] = [];
        for (const r of results) {
            const est = estimateTokens(r.node);
            if (budget - est < 0 && kept.length > 0) break;
            kept.push(r);
            budget -= est;
        }
        if (kept.length < results.length) { droppedCount = results.length - kept.length; truncated = true; results = kept; }
    }

    // 6.5 topScore is reduced from the FINAL `results`, after EVERY step that
    //     can remove a node: the actor-scope / ecosystem / hidden filters, the
    //     re-rank `.slice(0, limit)`, the `tags` filter, and the token-budget
    //     truncation. Reducing it any earlier reproduces the bug it was meant
    //     to fix, one stage later — `tags` is a first-class parameter on the
    //     MCP `search`/`recall` tools and on REST, so a perfectly ordinary call
    //     (nodes hi=0.99 / lo=0.10, `tags: ['keepme']` carried only by `lo`)
    //     returned `['lo']` with `topScore: 0.99`. topScore drives
    //     recallPreset's confidence AND its auto-escalation threshold, so it
    //     must never be derived from a node the caller does not receive.
    //     `results` is direct-matches-only now (D4 fix), so every element
    //     qualifies — no depth check needed any more. Null (nothing semantic
    //     survived) reads the same as "vector index not consulted", which is
    //     the honest signal.
    for (const r of results) {
        const s = semanticScoreById.get(r.node.id);
        if (s !== undefined && (topScore === null || s > topScore)) topScore = s;
    }

    // 7. Warm the hot-access cache — stamp the read's OWN workspace (never
    //    boot), and only warm the boot-bound session cache for the active
    //    workspace. Touches BOTH `results` and `related` ids: this is a
    //    read-recency signal for every node the caller actually receives,
    //    direct or related, unaffected by the D4 contract split.
    const touchedIds = [...results.map((r) => r.node.id), ...related.map((r) => r.node.id)];
    ensureAccessTracker(graph)?.touch(touchedIds, 'retrieval');
    if (graph === bootGraph) {
        for (const id of touchedIds) ctx.store.sessionCache.pushNode(id);
    }

    return {
        results,
        related,
        meta: {
            topScore: topScore !== null ? parseFloat(topScore.toFixed(3)) : null,
            sourcesConsulted,
            totalMatched,
            truncated,
            droppedCount,
            directMatches: results.length,
            verbatimConsulted,
            scanCapHit,
            possibleStarvation,
            bm25Ranked,
            vectorLegSkipped,
            candidateWindow: verbatimConsulted ? seedFetch : 0,
            prefixStableUpTo: candLimit,
            topSimilarity: topSimilarity !== null ? parseFloat(topSimilarity.toFixed(3)) : null,
            topRelevance: abstention.topRelevance !== null ? parseFloat(abstention.topRelevance.toFixed(2)) : null,
            relevanceFloor,
            belowFloor: abstention.belowFloor,
            abstained: abstention.abstained,
            ...abstentionMeta,
            calibration: {
                status: calibration.status, version: calibration.version, probes: calibration.probes, rows: calibration.rows,
                nullMedian: calibration.nullMedian, nullScale: calibration.nullScale, scope: workspace,
            },
            ...(seedStore?.pieceStatus ? { pieceVectors: seedStore.pieceStatus } : {}), ...(rerankMeta ? { rerank: rerankMeta } : {}),
        },
    };
}

