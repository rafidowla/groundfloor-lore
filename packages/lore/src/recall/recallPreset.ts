/**
 * recallPreset.ts — the shared recall PRESENTATION (Retrieval Unification, P2).
 *
 * Turns a retrieve(depth>=1) outcome into the RecallResult (summary | full):
 * snippet hits / full bodies, the _meta confidence envelope, the deferred-Lore
 * sidecar, the language-mismatch hint, and high-confidence auto-escalation.
 *
 * Every single-workspace recall surface — the MCP `recall` tool, embedded
 * lore.recall(), and REST GET /api/recall — projects through here, so the recall
 * response shape can no longer drift between them (the P10/P18 fix). The
 * retrieval itself (semantic + BM25 → RRF → traversal → budget) is the shared
 * retrieve() core; this module is presentation only.
 */

import { randomUUID } from 'node:crypto';
import type { LoreNode } from '../providers/types.js';
import type { RetrieveOutcome } from './retrieve.js';
import { buildLanguageHint } from '../mcp/tools/search/helpers.js';
import { buildRelevanceMeta, type RelevanceMetaFields } from './abstention.js';
import type { PieceVectorsMeta } from './pieceSeedSearch.js';
import { toSnakeRerankMeta, type SnakeRerankMeta } from './rerankStage.js';

/* ─── RecallResult shape (canonical; embedded lore.recall returns it) ─── */

export interface RecallHit {
    id: string;
    type: string;
    label: string;
    project: string;
    tags: string[];
    snippet: string | null;
    source: string;
    stale_warning?: boolean;
    /** D1: this hit's own raw vector-leg similarity / calibrated z-score.
     *  Additive only — absent for keyword/traversal-only matches. */
    similarity?: number;
    relevance?: number;
    /** D8b: this hit's cross-encoder re-rank score. Absent unless `rerank`
     *  was enabled for this call AND the stage actually applied. */
    rerank_score?: number;
}

/** D4 fix (fix/d4-traversal-separate-field): a graph-traversal neighbour of a
 *  direct hit. Never a ranked/relevance match to the query itself — `via` +
 *  `relation` say exactly how it was reached, so a caller cannot mistake it
 *  for a query match. Not counted in `shown`/`totalRecalled`. */
export interface RecallRelated {
    id: string;
    type: string;
    label: string;
    project: string;
    snippet: string | null;
    /** id of the direct hit this neighbour was reached FROM. */
    via: string;
    /** the REAL edge relation reported by graph.traverse() — never invented. */
    relation: string;
    depth: number;
}

export interface RecallNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    project: string;
    source: string;
    language?: string | null;
    stale_warning?: boolean;
    /** D1: see RecallHit.similarity/relevance — same semantics. */
    similarity?: number;
    relevance?: number;
    /** D8b: see RecallHit.rerank_score — same semantics. */
    rerank_score?: number;
}

export interface RecallMeta extends RelevanceMetaFields {
    confidence: number;
    negative_evidence?: string;
    top_score?: number;
    sources_consulted: number;
    /** P14 freshness signal: was the vector index consulted? false = semantic
     *  results are absent (just-written / not-yet-embedded content, or a
     *  non-active workspace) — keyword still ran. Callers seeing false right
     *  after a write should expect semantic recall to lag until embedding. */
    vector_index_consulted: boolean;
    truncated?: boolean;
    dropped_count?: number;
    total_matched?: number;
    /** P16: present + true only when the keyword scan hit SEARCH_SCAN_CAP, so
     *  results may be incomplete (matches beyond the cap were dropped before
     *  ranking). Absent in the common case. */
    scan_cap_hit?: boolean;
    /** Finding 5.3: present + true only when the vector seed window came back
     *  full but hidden/out-of-scope rows starved it below the requested limit
     *  even after adaptive over-fetch retries — live matches likely exist
     *  beyond the scanned window, so a thin/empty result is NOT authoritative
     *  absence (negative_evidence says so too when this is set). */
    possible_starvation?: boolean;
    /** 3.21 step 3(a): present + false only when bm25 was consulted (mode
     *  'keyword' or 'hybrid' against a populated store) but came back
     *  UNRANKED — the store's LIKE-scan fallback, every hit force-scored
     *  1.0. Absent means either bm25 was not consulted, or it was and came
     *  back genuinely ranked. A caller must not present `false` results as
     *  relevance-ordered. */
    bm25_ranked?: boolean;
    /** 3.21 step 3(c): present + true only when a semantic fetch was
     *  skipped because the embedding provider is disabled
     *  (NullEmbeddingProvider / LORE_EMBEDDING_PROVIDER=none) — the read
     *  degraded to the keyword/BM25/graph path instead of throwing. */
    vector_leg_skipped?: boolean;
    /** D7b — piece-level vector routing status for this call. Present only
     *  when piece-vectors intent is on for the seed store consulted (absent
     *  entirely, not `{status:'off'}`, when intent is off — keeps default
     *  output byte-identical to pre-D7b). See pieceSeedSearch.ts. */
    piece_vectors?: PieceVectorsMeta;
    /** D8b: present only when `rerank` was enabled for this call (per-call >
     *  workspace > env). Absent leaves default output byte-identical. */
    rerank?: SnakeRerankMeta;
}
// D1 (calibrated relevance + abstention): the top_similarity/top_relevance/
// floor/below_floor/abstained/calibration fields above come from
// RelevanceMetaFields (abstention.ts) via `extends`. Always present. An
// abstained retrieve() outcome is itself an empty-results outcome, so it
// flows through the SAME `outcome.results.length === 0` branch below as
// ordinary "nothing found" — no separate code path needed.

export interface RecallResultSummary {
    topic: string;
    mode: 'summary';
    searchMode: string;
    scope: { workspace: string; ecosystem: string };
    /** 3.21 step 3(h) — correlation token for this recall call; echo it
     *  back on `recall_outcome` / POST /api/recall/outcome to tie an
     *  outcome to the query that surfaced the node. */
    queryId: string;
    crossProject: boolean;
    totalRecalled: number;
    shown: number;
    projectsSeen: string[];
    hits: RecallHit[];
    /** D4 fix: graph-traversal neighbours of `hits`, separate from ranked
     *  results — never counted in `shown`/`totalRecalled`. Absent (not an
     *  empty array) when depth=0 or no neighbours were found. */
    related?: RecallRelated[];
    auto_full?: Array<{ id: string; label: string; content: string }>;
    auto_full_reason?: string;
    deferred?: unknown[];
    hint?: { queryLanguage: string; corpusLanguageBreakdown: Record<string, number>; suggestion: string } | null;
    _meta: RecallMeta;
}

export interface RecallResultFull {
    topic: string;
    mode: 'full';
    searchMode: string;
    scope: { workspace: string; ecosystem: string };
    /** 3.21 step 3(h) — see RecallResultSummary.queryId. */
    queryId: string;
    crossProject: boolean;
    totalRecalled: number;
    directMatches: number;
    connectedMatches: number;
    knowledge: RecallNode[];
    /** D4 fix: graph-traversal neighbours, separate from `knowledge` — never
     *  interleaved into it, and never counted in `totalRecalled`/
     *  `directMatches`. `connectedMatches` (below) IS this array's length —
     *  a pure count, kept for backward-compatible callers that only read
     *  the number, not the nodes. Absent (not an empty array) on `related`
     *  itself when depth=0 or no neighbours were found. */
    related?: RecallRelated[];
    deferred?: unknown[];
    hint?: { queryLanguage: string; corpusLanguageBreakdown: Record<string, number>; suggestion: string } | null;
    /** Same envelope the summary mode has always carried. Present on every
     *  full-mode response so token-budget truncation (max_tokens) and seed
     *  starvation are visible here too — previously full mode silently cut
     *  knowledge[] with totalRecalled reporting the post-truncation count. */
    _meta: RecallMeta;
}

export type RecallResult = RecallResultSummary | RecallResultFull;

/* ─── Presentation ─────────────────────────────────────────────── */

const SUMMARY_MAX_HITS = 10;
const SNIPPET_LEN = 120;
const AUTO_ESCALATE_THRESHOLD = 0.85;
const AUTO_ESCALATE_MAX = 3;

/** Minimal graph surface the presentation needs (deferred + hint + escalate). */
interface RecallGraph {
    getNode(id: string): Promise<LoreNode | null>;
    getLanguageBreakdown(): Promise<Record<string, number>>;
}

export interface RecallPresentationParams {
    topic: string;
    responseMode: 'summary' | 'full';
    searchMode: string;
    /** Project/workspace scope label for `scope.workspace`. */
    workspaceScope: string;
    ecosystemScope: string;
    crossProject: boolean;
    queryLanguage?: string;
    filePaths?: string[];
    /** Whether a token budget was requested (controls the tokenMeta fields). */
    maxTokens?: number;
    /** D2 (3.22.1): overrides SUMMARY_MAX_HITS for this call's summary-mode
     *  display cap — the caller's `max` (recall tool) / `max` (REST /api/recall),
     *  already used to size retrieve()'s own `limit`, so `outcome.results` is
     *  never larger than this anyway. Undefined/omitted keeps the historic
     *  default of 10. Full mode is unaffected — it has never capped `knowledge`
     *  separately from `outcome.results`. */
    maxHits?: number;
}

/** D4 fix: `outcome.results` is direct-matches-only now, so `source` is
 *  always 'seed' → 'search'. Kept as a function (not a constant) so any
 *  caller still importing it keeps working; the `via:<id>` branch is
 *  unreachable via `results` post-fix but is preserved for the (already
 *  scope-filtered) case where a caller passes a raw retrieve() result
 *  through directly, e.g. defensive/older code paths. */
function mapSource(source: string): string {
    if (source === 'seed') return 'search';
    return source.startsWith('via:') ? `via ${source.slice(4)}` : source;
}

function snippetOf(content: unknown, maxLen: number = SNIPPET_LEN): string | null {
    if (typeof content !== 'string') return null;
    return content.length > maxLen
        ? content.slice(0, maxLen).replace(/\s+/g, ' ').trim() + '…'
        : content.replace(/\s+/g, ' ').trim();
}

/* ─── 3.21 step 3(g) — compact candidates ──────────────────────────
 * A caller that only needs to DECIDE which hits are worth a full body
 * (before spending the tokens `full`/`summary` cost) passes `compact:true`.
 * Deliberately NOT a third `responseMode` value: compact bypasses
 * buildRecallResult's summary/full shaping entirely (no traversal-source
 * labels, no deferred sidecar, no language hint, no auto-escalation) — it
 * is the thinnest possible pointer into a result set, paired with
 * `recall_expand` / POST /api/recall/expand to fetch chosen ids' full
 * bodies afterward.
 */
export const COMPACT_SNIPPET_LEN = 240;

export interface RecallCandidate {
    id: string;
    label: string;
    snippet: string | null;
    score: number;
    matchedBy: string[];
    updatedAt: string;
    /** D8b: see RecallHit.rerank_score — same semantics. */
    rerank_score?: number;
}

export function buildCompactCandidates(outcome: RetrieveOutcome): RecallCandidate[] {
    // outcome.results is already in reranked order when rerank applied
    // (retrieve.ts reorders internally before returning) — no reordering
    // logic needed here, only surfacing the already-present score.
    return outcome.results.map((r) => {
        const n = r.node as LoreNode;
        return {
            id: n.id,
            label: n.label,
            snippet: snippetOf(n.content, COMPACT_SNIPPET_LEN),
            score: r.score,
            matchedBy: r.matchedBy,
            updatedAt: n.updatedAt,
            ...(r.rerankScore !== undefined ? { rerank_score: r.rerankScore } : {}),
        };
    });
}

/** D4 fix: compact mode's counterpart to `related` on summary/full — a
 *  caller that only wants ids-to-decide-on still needs to see graph
 *  neighbours, but never mixed into `candidates` (which stays "things that
 *  matched the query"). Paired with the same `recall_expand` flow. */
export interface RecallRelatedCandidate {
    id: string;
    label: string;
    snippet: string | null;
    via: string;
    relation: string;
    depth: number;
}

export function buildRelatedCandidates(outcome: RetrieveOutcome): RecallRelatedCandidate[] {
    return outcome.related.map((r) => {
        const n = r.node as LoreNode;
        return {
            id: n.id,
            label: n.label,
            snippet: snippetOf(n.content, COMPACT_SNIPPET_LEN),
            via: r.via,
            relation: r.relation,
            depth: r.depth,
        };
    });
}

// fix/3.22.1-recall-parity review fix (5) — test-only instrumentation seam,
// same pattern as retrieve.ts's setRetrieveOptionsSpy: unset (null) in every
// real code path, setter-only (no exported mutable binding). A parity test
// sets this to capture the exact `params` object each single-workspace
// recall surface (in-process lore.recall(), the `recall` MCP tool, REST
// GET /api/recall) passes into buildRecallResult — in particular `maxHits`
// — so a future drift (one surface passing it, another silently not) is
// caught by VALUE comparison, not just by the two call sites existing.
let buildRecallResultParamsSpy: ((params: RecallPresentationParams) => void) | null = null;
export function setBuildRecallResultParamsSpy(spy: ((params: RecallPresentationParams) => void) | null): void {
    buildRecallResultParamsSpy = spy;
}

export async function buildRecallResult(
    params: RecallPresentationParams,
    outcome: RetrieveOutcome,
    graph: RecallGraph,
): Promise<RecallResult> {
    buildRecallResultParamsSpy?.(params);
    const { topic, responseMode, searchMode, workspaceScope, ecosystemScope, crossProject, queryLanguage, filePaths, maxTokens, maxHits } = params;
    const { topScore, sourcesConsulted, totalMatched, truncated, droppedCount, directMatches } = outcome.meta;
    // 3.21 step 3(h) — a correlation token for this recall call, so a later
    // `recall_outcome` / POST /api/recall/outcome can be tied back to the
    // query that surfaced the node. Nothing persists it at recall time —
    // it exists purely so the CALLER can echo it back; recall_outcome folds
    // it into the existing outcome row's free-text `notes` column.
    const queryId = randomUUID();

    const { findDeferredMatches } = await import('../engines/deferred.js');
    const deferredMatches = await findDeferredMatches(graph as unknown as Parameters<typeof findDeferredMatches>[0], { topic, filePaths });

    // Finding 5.3 — when retrieve() flags a starved seed window, the "absence
    // is informative" claim is NOT safe to make: live rows matching the topic
    // likely sit beyond the scanned window. Say so instead.
    const starvationNote = outcome.meta.possibleStarvation
        ? ' NOTE: the seed window was starved by archived/superseded or out-of-scope rows — stored memory for this topic may exist beyond the scanned window. Retry with include_archived/include_superseded or a narrower topic before treating this as absence.'
        : '';

    if (outcome.results.length === 0) {
        const earlyHint = queryLanguage ? await buildLanguageHint(graph as unknown as Parameters<typeof buildLanguageHint>[0], queryLanguage) : null;
        const emptyMeta: RecallMeta = {
            confidence: 0,
            negative_evidence: deferredMatches.length > 0
                ? `No knowledge nodes match topic "${topic}", but ${deferredMatches.length} deferred work item(s) reference these file paths.`
                : `No knowledge nodes match topic "${topic}" in ${crossProject ? 'any project' : `project=${workspaceScope}`}.${outcome.meta.possibleStarvation ? '' : ' Absence is informative — the topic has no stored memory yet.'}${starvationNote}`,
            sources_consulted: sourcesConsulted,
            vector_index_consulted: outcome.meta.verbatimConsulted,
            ...(outcome.meta.scanCapHit ? { scan_cap_hit: true } : {}),
            ...(outcome.meta.possibleStarvation ? { possible_starvation: true } : {}),
            ...(outcome.meta.bm25Ranked === false ? { bm25_ranked: false } : {}),
            ...(outcome.meta.vectorLegSkipped ? { vector_leg_skipped: true } : {}),
            ...(outcome.meta.pieceVectors ? { piece_vectors: outcome.meta.pieceVectors } : {}),
            ...buildRelevanceMeta(outcome.meta),
            // D8b — absent unless rerank actually ran for this call (the
            // stage still reports a fail-open `too_few_results` meta when
            // outcome.results was too small, same as a genuine empty recall).
            ...(outcome.meta.rerank ? { rerank: toSnakeRerankMeta(outcome.meta.rerank) } : {}),
        };
        // An empty result keeps the REQUESTED response shape — a full-mode
        // caller gets the full-mode shape with an empty knowledge array, not
        // a silent downgrade to the summary shape.
        if (responseMode === 'full') {
            return {
                topic, mode: 'full', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope }, queryId,
                crossProject, totalRecalled: 0, directMatches: 0, connectedMatches: 0, knowledge: [],
                ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
                ...(earlyHint ? { hint: earlyHint } : {}),
                _meta: emptyMeta,
            };
        }
        return {
            topic, mode: 'summary', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope }, queryId,
            crossProject, totalRecalled: 0, shown: 0, projectsSeen: [], hits: [],
            ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
            ...(earlyHint ? { hint: earlyHint } : {}),
            _meta: emptyMeta,
        };
    }

    // outcome.results is already in reranked order when rerank applied
    // (retrieve.ts reorders internally before returning `results`) — no
    // reordering logic needed here, only carrying the already-present score
    // through so full-mode `knowledge` / summary `hits` (and auto_full,
    // which slices `trimmed` below) can surface it.
    const recalled = outcome.results.map((r) => ({ node: r.node, source: mapSource(r.source), similarity: r.similarity, relevance: r.relevance, rerankScore: r.rerankScore }));
    const related: RecallRelated[] = outcome.related.map((r) => {
        const n = r.node as LoreNode;
        return { id: n.id, type: n.type, label: n.label, project: n.project, snippet: snippetOf(n.content), via: r.via, relation: r.relation, depth: r.depth };
    });
    const tokenMeta = maxTokens ? { truncated, dropped_count: droppedCount, total_matched: totalMatched } : {};
    const hint = queryLanguage ? await buildLanguageHint(graph as unknown as Parameters<typeof buildLanguageHint>[0], queryLanguage) : null;

    // Confidence/negative-evidence are computed ONCE, before the mode branch,
    // so full mode can carry the same _meta envelope summary mode has always
    // had (Finding: maxTokens truncation was invisible in mode:'full').
    // D4 fix: `outcome.results` is now direct-matches-only, and the
    // `outcome.results.length === 0` case already early-returned above — so
    // past this point `directMatches` (== outcome.results.length) can never
    // be 0. The old `directMatches === 0` branch ("every hit is a traversal
    // neighbour") described exactly the bug this fix removes and is now
    // unreachable; removed rather than left as dead defensive code, since
    // keeping it would misleadingly suggest results can still contain
    // traversal-only content.
    let confidence: number;
    let negativeEvidence: string | undefined;
    const metaTopScore = topScore !== null ? parseFloat(topScore.toFixed(3)) : undefined;
    if (topScore !== null) {
        confidence = topScore >= 0.82 ? 1.0 : topScore >= 0.65 ? 0.7 : 0.4;
        if (topScore < 0.65) negativeEvidence = `Semantic similarity is low (top score: ${topScore.toFixed(2)}). Results may be loosely related.`;
    } else {
        confidence = 1.0;
    }
    if (outcome.meta.possibleStarvation) {
        negativeEvidence = (negativeEvidence ?? '') + starvationNote;
    }

    if (responseMode === 'full') {
        return {
            topic, mode: 'full', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope }, queryId,
            crossProject, totalRecalled: recalled.length,
            directMatches,
            // D4 fix: was `recalled.length - directMatches` (a derived count
            // over an array that used to hold BOTH kinds of node). Now that
            // `related` is retrieve()'s own separate array, this is a direct
            // count of it, not arithmetic over `knowledge`.
            connectedMatches: related.length,
            knowledge: recalled.map(({ node, source, similarity, relevance, rerankScore }) => {
                const n = node as LoreNode & { language?: string | null; stale?: boolean };
                return {
                    id: n.id, type: n.type, label: n.label, content: n.content, tags: n.tags,
                    project: n.project, source, language: n.language ?? null,
                    ...(n.stale ? { stale_warning: true } : {}),
                    ...(similarity !== undefined && similarity !== null ? { similarity } : {}),
                    ...(relevance !== undefined && relevance !== null ? { relevance } : {}),
                    ...(rerankScore !== undefined ? { rerank_score: rerankScore } : {}), // D8b
                };
            }),
            ...(related.length > 0 ? { related } : {}),
            ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
            ...(hint ? { hint } : {}),
            _meta: {
                confidence,
                ...(negativeEvidence ? { negative_evidence: negativeEvidence } : {}),
                ...(metaTopScore !== undefined ? { top_score: metaTopScore } : {}),
                sources_consulted: sourcesConsulted,
                vector_index_consulted: outcome.meta.verbatimConsulted,
                ...(outcome.meta.scanCapHit ? { scan_cap_hit: true } : {}),
                ...(outcome.meta.possibleStarvation ? { possible_starvation: true } : {}),
            ...(outcome.meta.bm25Ranked === false ? { bm25_ranked: false } : {}),
            ...(outcome.meta.vectorLegSkipped ? { vector_leg_skipped: true } : {}),
            ...(outcome.meta.pieceVectors ? { piece_vectors: outcome.meta.pieceVectors } : {}),
                ...tokenMeta,
                ...buildRelevanceMeta(outcome.meta),
                ...(outcome.meta.rerank ? { rerank: toSnakeRerankMeta(outcome.meta.rerank) } : {}), // D8b
            },
        };
    }

    // Summary.
    const trimmed = recalled.slice(0, maxHits ?? SUMMARY_MAX_HITS);
    const projectsSeen = new Set<string>();
    for (const { node } of recalled) { const p = (node as { project?: string }).project; if (p) projectsSeen.add(p); }

    let autoEscalated: Array<{ id: string; label: string; content: string }> | undefined;
    // D2-recall-1/2: the ids escalated here come from `trimmed` ⊆ outcome.results,
    // and retrieve() now applies applyActorScopeFilter to every seed + traversal
    // node before returning. So these re-fetched bodies are already restricted to
    // rows the bound actor is scoped for — no additional filter needed here. (If
    // this ever sources ids from outside the scope-filtered outcome, re-filter.)
    if (topScore !== null && topScore >= AUTO_ESCALATE_THRESHOLD) {
        const bodies = await Promise.all(trimmed.slice(0, AUTO_ESCALATE_MAX).map(async ({ node }) => {
            const full = await graph.getNode(node.id);
            return full ? { id: full.id, label: (full as { label: string }).label, content: (full as { content: string }).content } : null;
        }));
        const valid = bodies.filter(Boolean) as Array<{ id: string; label: string; content: string }>;
        if (valid.length > 0) autoEscalated = valid;
    }

    return {
        topic, mode: 'summary', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope }, queryId,
        crossProject, totalRecalled: recalled.length, shown: trimmed.length, projectsSeen: [...projectsSeen],
        hits: trimmed.map(({ node, source, similarity, relevance, rerankScore }) => {
            const n = node as LoreNode & { stale?: boolean };
            return {
                id: n.id, type: n.type, label: n.label, project: n.project, tags: n.tags,
                snippet: snippetOf(n.content), source,
                ...(n.stale ? { stale_warning: true } : {}),
                ...(similarity !== undefined && similarity !== null ? { similarity } : {}),
                ...(relevance !== undefined && relevance !== null ? { relevance } : {}),
                ...(rerankScore !== undefined ? { rerank_score: rerankScore } : {}), // D8b
            };
        }),
        ...(related.length > 0 ? { related } : {}),
        ...(autoEscalated ? { auto_full: autoEscalated, auto_full_reason: `Top similarity score ${topScore?.toFixed(2)} >= ${AUTO_ESCALATE_THRESHOLD} — fetched full bodies to save a get_full round-trip.` } : {}),
        ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
        ...(hint ? { hint } : {}),
        _meta: {
            confidence,
            ...(negativeEvidence ? { negative_evidence: negativeEvidence } : {}),
            ...(metaTopScore !== undefined ? { top_score: metaTopScore } : {}),
            sources_consulted: sourcesConsulted,
            vector_index_consulted: outcome.meta.verbatimConsulted,
            ...(outcome.meta.scanCapHit ? { scan_cap_hit: true } : {}),
            ...(outcome.meta.possibleStarvation ? { possible_starvation: true } : {}),
            ...(outcome.meta.bm25Ranked === false ? { bm25_ranked: false } : {}),
            ...(outcome.meta.vectorLegSkipped ? { vector_leg_skipped: true } : {}),
            ...(outcome.meta.pieceVectors ? { piece_vectors: outcome.meta.pieceVectors } : {}),
            ...tokenMeta,
            ...buildRelevanceMeta(outcome.meta),
            ...(outcome.meta.rerank ? { rerank: toSnakeRerankMeta(outcome.meta.rerank) } : {}), // D8b
        },
    };
}
