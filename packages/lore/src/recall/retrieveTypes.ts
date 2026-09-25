/**
 * retrieveTypes.ts — the shared retrieve() contract types, split out of
 * retrieve.ts purely to keep that file under the repo's 800-line file-size
 * cap. Both fix/d4-traversal-separate-field (the `related`/`RelatedResult`
 * split) and fix/d1-calibrated-abstention (calibrated relevance + abstention
 * meta) independently extracted this file; the integration merge unions
 * them. Pure type/interface declarations, no logic. Every type here is
 * re-exported from retrieve.ts, so existing `import type {...} from
 * './retrieve.js'` call sites are unaffected — file-layout change only, not
 * a contract change.
 *
 * License: original work for groundfloor-lore.
 */

import type { LoreNode } from '../providers/types.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { StorageBundle } from '../mcp/services.js';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';
import type { CalibrationStatus } from './calibration.js';
import type { LexicalBaseMode } from './candidateWindow.js';
import type { PieceVectorsMeta } from './pieceSeedSearch.js';
import type { RerankMeta } from './rerankStage.js';

/* ─── Unified contract (D4) ────────────────────────────────────── */

/** Which retrieval method(s) surfaced a result. */
export type MatchKind = 'semantic' | 'bm25' | 'keyword' | 'traversal';

/**
 * D4 (P2, fix/d4-traversal-separate-field) — `results` now carries ONLY
 * direct matches (depth 0). `depth` and `source` are therefore constant
 * (`0` / `'seed'`) on every element; they are kept on the shape (rather than
 * dropped) so existing readers of these two fields don't break, and because
 * a future direct-match variant (e.g. a fuzzy/alias match) may legitimately
 * want a non-'seed' source without becoming a traversal neighbour. Graph
 * neighbours live in `RetrieveOutcome.related` (see `RelatedResult`) and are
 * never mixed into this array — see the CHANGELOG entry and
 * docs/RETRIEVAL_UNIFICATION.md's D4-defect-fix addendum for the full
 * before/after and why.
 */
export interface RetrievalResult {
    node: LoreNode;
    /** Relative retrieval confidence within THIS result set (0..1). Not
     *  comparable across queries. */
    score: number;
    /** Which method(s) found this node. A hybrid seed can be both
     *  'semantic' and 'bm25'. */
    matchedBy: MatchKind[];
    /** Always 0 — `results` contains only direct (depth-0) matches. */
    depth: number;
    /** Always 'seed' — `results` contains only direct matches. */
    source: string;
    /**
     * D1 (calibrated relevance) — raw vector-leg cosine similarity for THIS
     * result, 0..1, 3dp. Only populated for seeds that had a semantic hit;
     * null on a keyword/bm25-only seed, or when the vector index wasn't
     * consulted at all. Distinct from `score`, which is the pipeline's
     * fused/re-ranked relative-confidence value and is NEVER changed by D1 —
     * `similarity` is purely additive. (Traversal neighbours live in
     * `RetrieveOutcome.related` and never carry it.)
     */
    similarity?: number | null;
    /**
     * D1 — robust z-score of `similarity` against this workspace's
     * calibration null-distribution (see calibration.ts), 2dp. Null when
     * `similarity` is null, or when calibration status is not `ok`
     * (insufficient_rows / degenerate / unavailable / not_applicable).
     */
    relevance?: number | null;
    /**
     * D8 — cross-encoder logit from the optional local re-rank stage
     * (rerankStage.ts). Present only on hits the stage actually scored
     * (the reranked top K of a call that had rerank enabled). Not
     * comparable across queries or across models. Never used in place of
     * `score`/`similarity` — those stay pre-rerank (see `RerankMeta`).
     */
    rerankScore?: number;
}

/**
 * D4 fix — a graph-traversal neighbour, kept OUT of `results` and OUT of
 * `meta.totalMatched`/`meta.directMatches`. `relation` is the REAL edge
 * relation `graph.traverse()` reported for this hop (never invented) —
 * see `TraversalResult` in providers/types.ts.
 */
export interface RelatedResult {
    node: LoreNode;
    /** The seed id this node was reached from. */
    via: string;
    /** The edge relation traversed to reach this node, as reported by
     *  `graph.traverse()` — the real relation name, never synthesised. */
    relation: string;
    /** Hop distance from the seed (>=1). */
    depth: number;
    /** Depth-decayed relative weight (0.3/(1+depth)) — NOT comparable to
     *  `RetrievalResult.score`, which is a real retrieval-method score. Kept
     *  for callers that want to order `related` internally. */
    score: number;
}

export interface RetrieveOptions {
    /** Target workspace. "*" (cross-workspace) is not yet handled by the core. */
    workspace: string;
    ecosystem?: string;
    /**
     * Retrieval mode. Default 'hybrid' (semantic + BM25 → RRF).
     * 'semantic' = vector-only (embedding provider required).
     * 'keyword' (3.21 step 3(a)) = standalone lexical recall — the store's
     * bm25Search() unioned with the graph's own text-search leg. NEVER calls
     * the embedding provider; safe with embeddings disabled/unavailable.
     */
    mode?: 'semantic' | 'keyword' | 'hybrid';
    /** Graph traversal depth from each seed. 0 = seeds only (the `search`
     *  preset); 1 = include related nodes (the `recall` preset). Default 1. */
    depth?: number;
    /** Max seed/result cardinality. Default 10. */
    limit?: number;
    /** Keep only nodes carrying ALL of these (lowercased) tags. */
    tags?: string[];
    /** D2 (P1) — node TYPE/KIND prefilter, ANY-of. Unlike `tags`/`entities`/
     *  `topics`/`project`, pushed INTO the ANN + BM25 queries (resolveSeedStore),
     *  not applied after the fixed-size seed window. Omitted/empty = no filter. */
    types?: string[];
    includeArchived?: boolean;
    includeSuperseded?: boolean;
    /** Rough token budget — fills top-ranked nodes until exhausted. */
    maxTokens?: number;
    /** Ignore workspace scope and search every project. */
    crossProject?: boolean;
    /**
     * 3.21 step 3(f) — up to 5 EXTRA phrasings, used ALONGSIDE `query` (not
     * instead of it). Each phrasing runs the same seed leg(s) mode already
     * runs for the primary query; every resulting ranked list (phrasing ×
     * leg) is fused with the ONE shared rrfFuse (recall/rrf.ts, k=60) —
     * never averaged. Omitted/empty is exactly today's single-phrasing
     * behaviour (rrfFuse on one list per leg reduces to the same order/score
     * the pre-3.21-f code computed).
     */
    queries?: string[];
    /** 3.21 step 3(f) — keep only nodes whose metadata.entities (3.21 step
     *  3(e)) contains ALL of these (case-sensitive, caller-normalised)
     *  values. Applied post-hydration, same filter shape as `tags`. */
    entities?: string[];
    /** 3.21 step 3(f) — same as `entities`, over metadata.topics. */
    topics?: string[];
    /** 3.21 step 3(f) — keep only nodes whose `project` field equals this
     *  value exactly. Applied post-hydration, same filter shape as `tags`. */
    project?: string;
    /**
     * Optional cancellation (fix/search-worker-call-cancellation, 3.20.2,
     * follow-up to req. 3). Threaded all the way down to the seed store's
     * search()/bm25Search() calls (via resolveSeedStore → LoreStorageClient /
     * a per-workspace VerbatimStore), so an abort here genuinely frees the
     * SearchGate permit/queue slot the underlying native call was holding or
     * waiting on — not just the caller's own wait at the inProcessRecall()
     * boundary. An already-aborted signal short-circuits before any seed-store
     * work starts (see the top of retrieveInner). Omitting it is byte-
     * identical to prior behavior — every caller that doesn't pass one is
     * unaffected.
     */
    signal?: AbortSignal;
    /**
     * D1 (calibrated relevance + abstention) — when true, a query whose
     * calibrated relevance (z-score of the primary phrasing's top vector-leg
     * similarity) falls below `relevanceFloor` returns ZERO results with
     * `meta.abstained: true`, UNLESS an exact-identifier token in `query`
     * rescues it (see abstention.ts). Default false (env override
     * LORE_RECALL_ABSTAIN=1/true) — existing callers see byte-identical
     * results/score unless they opt in. Calibration itself (the `_meta`
     * fields) runs regardless of this flag.
     */
    abstain?: boolean;
    /**
     * D1 — robust z-score floor below which a query abstains, when
     * `abstain` is true. Default 2.0 (env override
     * LORE_RECALL_RELEVANCE_FLOOR). Ignored when `abstain` is false, but
     * still reported on `meta.relevanceFloor` for visibility.
     */
    relevanceFloor?: number;
    /**
     * D1 term-coverage signal (termCoverage.ts) — only consulted when
     * `abstain` is on. When true, a query whose z is above the floor but
     * below floor + 2.5 ALSO abstains if the weighted fraction of its content
     * terms found in the top-5 FINAL ranked hits (after fusion + the D3
     * identifier lane) is below 0.1 (env LORE_RECALL_TERM_COVERAGE_MIN,
     * clamped to [0,1]), unless an exact identifier rescues it.
     * Default false (env LORE_RECALL_ABSTAIN_TERM_COVERAGE=1/true).
     */
    abstainTermCoverage?: boolean;
    /**
     * D3 (docs/design/D3-prefix-stable-ranking.md §3.1) — floor for every
     * candidate-generation step, independent of `limit`. Default 0 = legacy
     * (via `LORE_RECALL_CANDIDATE_FLOOR` when omitted; opt-in value 50): pre-D3
     * output byte-for-byte. Any value > 0 FORCES `lexicalBase: 'anchored'`
     * (see resolveLexicalBase). Only the FINAL slice ever uses `limit`.
     */
    candidateFloor?: number;
    /**
     * D3 §3.5 — base-score mode for seeds with NO semantic score
     * (bm25-only/keyword-only). `'rrf'` (default, via
     * `LORE_RECALL_LEXICAL_BASE` when omitted) = legacy: raw RRF/keyword-rank
     * score unchanged. `'anchored'` (opt-in) caps it on the semantic scale
     * with a strength-aware ceiling between semFloor and semTop, so lexical
     * filler cannot outrank a real semantic match. Ignored (always anchored)
     * when candidateFloor > 0.
     */
    lexicalBase?: LexicalBaseMode;
    /**
     * D8d — per-call override for the optional local cross-encoder re-rank
     * stage (default ON). `undefined` = no per-call opinion (falls through
     * to workspace/host/env/default precedence — see rerankConfig.ts).
     * `false` always wins (immediate off, byte-identical to pre-D8). `true`
     * wins over env/default but NOT over a workspace-level off, which is
     * authoritative and overrides it (that is the one case where
     * `_meta.rerank = {applied:false, reason:'workspace_disabled'}` is
     * surfaced).
     */
    rerank?: boolean;
}

/**
 * D1 — the calibration/abstention fields threaded onto RetrieveMeta and, via
 * abstention.ts's buildRelevanceMeta, projected as the snake_case `_meta`
 * block on every presentation surface.
 */
export interface RetrieveCalibrationMeta {
    /** Raw vector-leg cosine similarity of the PRIMARY phrasing's best
     *  pre-rerank seed hit (`s*`), 0..1, 3dp. Null when the vector leg
     *  wasn't consulted or produced no hit for the primary phrasing. */
    topSimilarity: number | null;
    /** Robust z-score of topSimilarity against the workspace calibration
     *  null-distribution. Null when topSimilarity is null or calibration
     *  status isn't `ok`. */
    topRelevance: number | null;
    /** The floor this call was (or would be) gated against. */
    relevanceFloor: number;
    /** True when topRelevance is non-null and below relevanceFloor. */
    belowFloor: boolean;
    /** True when `abstain` was on AND belowFloor AND no rescue applied —
     *  results were short-circuited to empty before traversal ran. */
    abstained: boolean;
    /** Set when belowFloor would have abstained but an exact-identifier
     *  token in the query rescued it. */
    abstainOverridden?: 'exact_identifier';
    /** Set iff `abstained` AND the term-coverage flag is on: which signal
     *  fired ('below_floor' | 'term_coverage'). Absent when the flag is off. */
    abstainReason?: 'below_floor' | 'term_coverage';
    /** Weighted key-term coverage of the top-k final ranked hits (0..1), present
     *  only when the opt-in term-coverage signal ran. */
    termCoverage?: number | null;
    calibration: {
        status: CalibrationStatus;
        version: string;
        probes: number;
        rows: number;
        nullMedian: number | null;
        nullScale: number | null;
        scope: string;
    };
}

export interface RetrieveMeta extends RetrieveCalibrationMeta {
    /** D7b — piece-level vector routing status for this call. Present only
     *  when piece-vectors intent is on for the seed store consulted (absent
     *  entirely, not `{status:'off'}`, when intent is off — keeps default
     *  output byte-identical to pre-D7b). See pieceSeedSearch.ts. */
    pieceVectors?: PieceVectorsMeta;
    /** Top semantic similarity score (0..1) when the vector index was consulted. */
    topScore: number | null;
    /** 1 = keyword only; 2 = vector index also consulted. */
    sourcesConsulted: number;
    /** Result count before token-budget truncation. */
    totalMatched: number;
    truncated: boolean;
    droppedCount: number;
    /** Count of depth-0 (direct seed) matches. */
    directMatches: number;
    /** D5/P14 freshness signal: was the vector index available + consulted? When
     *  false, semantic results are absent (e.g. just-written, not-yet-embedded
     *  content, or a non-active workspace) — keyword still works. */
    verbatimConsulted: boolean;
    /** P16: true when the keyword candidate scan hit SEARCH_SCAN_CAP, so matches
     *  older than the retained window were dropped before ranking (results may be
     *  incomplete). Only the keyword path scans under the cap, so this stays
     *  false on a pure-semantic/vector seed run. */
    scanCapHit: boolean;
    /**
     * 3.21 step 3(a) — true unless the store's bm25Search() came back UNRANKED
     * (the LIKE-scan fallback, every hit force-scored 1.0 — see
     * verbatimBm25Result.ts's fail-closed envelope contract). Only meaningful
     * when bm25 was actually consulted (mode:'keyword' or mode:'hybrid' with a
     * populated verbatim store); stays at its harmless default `true` on a run
     * that never called bm25Search (mode:'semantic', or no seed store). A
     * caller presenting results as "ranked by relevance" must check this before
     * doing so — unranked hits are ordered by physical row order, not by any
     * lexical score.
     */
    bm25Ranked: boolean;
    /**
     * 3.21 step 3(c) — true when a semantic seed fetch (mode:'semantic' or
     * the semantic half of mode:'hybrid') was SKIPPED because the active
     * embedding provider is disabled (NullEmbeddingProvider /
     * LORE_EMBEDDING_PROVIDER=none), caught via the typed
     * EmbeddingDisabledError rather than a broad catch. The read degrades
     * to the keyword/BM25/graph path instead of throwing — false in every
     * other case, including mode:'keyword' (which never attempts a semantic
     * fetch at all, so there is nothing to skip).
     */
    vectorLegSkipped: boolean;
    /** Finding 5.3: true when the vector seed window came back FULL yet the
     *  post-hydration filters (archived/superseded/ecosystem/actor-scope)
     *  left fewer live seeds than `limit` even after the adaptive over-fetch
     *  retries — live rows matching the query very likely exist beyond the
     *  scanned window. Callers must not read a thin/empty result carrying
     *  this flag as authoritative absence. False on a run with no seed
     *  store window at all (the graph-only keyword fallback, no verbatim
     *  store consulted). 3.21 step 3(a): mode:'keyword' now ALSO fetches a
     *  fixed-size bm25Search() window and so can starve the same way the
     *  vector window can — this flag applies to it too. */
    possibleStarvation: boolean;
    /**
     * D3 §3.1 — the final candidate-generation window size (the `seedFetch`
     * the seed store was actually asked for, after any starvation-retry
     * growth). `0` when no seed store was consulted (pure keyword/graph
     * path — that leg is bounded by `prefixStableUpTo`, not a vector
     * window).
     */
    candidateWindow: number;
    /**
     * D3 §3.1 — every `limit` up to and including this value returns the
     * first `limit` of what `limit: prefixStableUpTo` returns today: the
     * `top-k@k == first k of top-50` guarantee holds for k in
     * `[1, prefixStableUpTo]`. Equals `max(limit, candidateFloor)`, or
     * `limit` itself when `candidateFloor` is 0 (legacy — no guarantee
     * beyond the single requested limit).
     */
    prefixStableUpTo: number;
    /** D8 — present only when rerank was enabled for this call. */
    rerank?: RerankMeta;
}

export interface RetrieveOutcome {
    /** Direct matches ONLY (depth 0) — never graph-traversal neighbours. */
    results: RetrievalResult[];
    /** D4 fix — graph-traversal neighbours (depth >= 1), kept separate from
     *  `results`. Empty when `depth` is 0 or no seed has any neighbours.
     *  Never counted in `meta.totalMatched`/`meta.directMatches`. */
    related: RelatedResult[];
    meta: RetrieveMeta;
}

export interface RetrieveContext {
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. When wired,
     * a recall against a NON-active workspace resolves that workspace's OWN
     * verbatim store (getOrOpen) and runs the semantic + BM25 seed pass against
     * it, instead of gating semantic consultation to the boot workspace only.
     * Omitted (cloud mode / test fixtures) ⇒ non-active recall degrades to the
     * keyword path, exactly as before this was threaded in.
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<{
            count(): Promise<number>;
            /**
             * `gate` (fix/search-worker-call-cancellation, 3.20.2 follow-up) is
             * appended at the SAME positional slot as the real VerbatimStore's
             * own gate param (see engines/verbatimWorkerProtocol.ts's
             * GATE_ARG_SLOT.search = 5 — 0-indexed, i.e. the 6th positional
             * argument here). Every caller in this file passes `opts`/
             * `actorScopes` as explicit `undefined` rather than omitting them,
             * so `gate` can never land in the wrong slot the way a bare append
             * would. The real resolver always returns a `VerbatimStore`, which
             * already has exactly this signature — this widened structural type
             * just lets TS see it.
             */
            search(query: string, limit: number, filter?: { ecosystem?: string; type?: string | string[] }, opts?: unknown, actorScopes?: ReadonlyArray<string>, gate?: { signal?: AbortSignal; deadline?: number }): Promise<Array<{ id: string; score?: number }>>;
            /** Same slot discipline as `search` above — GATE_ARG_SLOT.bm25Search = 4
             *  (0-indexed, the 5th positional argument here). */
            bm25Search(query: string, limit: number, filter?: { ecosystem?: string; type?: string | string[] }, actorScopes?: ReadonlyArray<string>, gate?: { signal?: AbortSignal; deadline?: number }): Promise<Bm25Envelope<{ id: string; score?: number }>>;
        }>;
    };
    /**
     * Types that receive the 1.5× recall type-bias. When omitted, the default
     * schema's operatorCurated types apply (decision, convention, …). Pass an
     * empty set to disable type bias (schema-agnostic caller).
     */
    curatedTypes?: ReadonlySet<string>;
}
