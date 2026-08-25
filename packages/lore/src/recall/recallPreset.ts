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

import type { LoreNode } from '../providers/types.js';
import type { RetrieveOutcome } from './retrieve.js';
import { buildLanguageHint } from '../mcp/tools/search/helpers.js';

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
}

export interface RecallMeta {
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
}

export interface RecallResultSummary {
    topic: string;
    mode: 'summary';
    searchMode: string;
    scope: { workspace: string; ecosystem: string };
    crossProject: boolean;
    totalRecalled: number;
    shown: number;
    projectsSeen: string[];
    hits: RecallHit[];
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
    crossProject: boolean;
    totalRecalled: number;
    directMatches: number;
    connectedMatches: number;
    knowledge: RecallNode[];
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
}

/** retrieve() tags seeds 'seed' and neighbours 'via:<id>'; recall's wire shape
 *  has historically used 'search' / 'via <id>'. */
function mapSource(source: string): string {
    if (source === 'seed') return 'search';
    return source.startsWith('via:') ? `via ${source.slice(4)}` : source;
}

function snippetOf(content: unknown): string | null {
    if (typeof content !== 'string') return null;
    return content.length > SNIPPET_LEN
        ? content.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim() + '…'
        : content.replace(/\s+/g, ' ').trim();
}

export async function buildRecallResult(
    params: RecallPresentationParams,
    outcome: RetrieveOutcome,
    graph: RecallGraph,
): Promise<RecallResult> {
    const { topic, responseMode, searchMode, workspaceScope, ecosystemScope, crossProject, queryLanguage, filePaths, maxTokens } = params;
    const { topScore, sourcesConsulted, totalMatched, truncated, droppedCount, directMatches } = outcome.meta;

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
        };
        // An empty result keeps the REQUESTED response shape — a full-mode
        // caller gets the full-mode shape with an empty knowledge array, not
        // a silent downgrade to the summary shape.
        if (responseMode === 'full') {
            return {
                topic, mode: 'full', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope },
                crossProject, totalRecalled: 0, directMatches: 0, connectedMatches: 0, knowledge: [],
                ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
                ...(earlyHint ? { hint: earlyHint } : {}),
                _meta: emptyMeta,
            };
        }
        return {
            topic, mode: 'summary', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope },
            crossProject, totalRecalled: 0, shown: 0, projectsSeen: [], hits: [],
            ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
            ...(earlyHint ? { hint: earlyHint } : {}),
            _meta: emptyMeta,
        };
    }

    const recalled = outcome.results.map((r) => ({ node: r.node, source: mapSource(r.source) }));
    const tokenMeta = maxTokens ? { truncated, dropped_count: droppedCount, total_matched: totalMatched } : {};
    const hint = queryLanguage ? await buildLanguageHint(graph as unknown as Parameters<typeof buildLanguageHint>[0], queryLanguage) : null;

    // Confidence/negative-evidence are computed ONCE, before the mode branch,
    // so full mode can carry the same _meta envelope summary mode has always
    // had (Finding: maxTokens truncation was invisible in mode:'full').
    let confidence: number;
    let negativeEvidence: string | undefined;
    const metaTopScore = topScore !== null ? parseFloat(topScore.toFixed(3)) : undefined;
    if (directMatches === 0) {
        confidence = 0.4;
        negativeEvidence = `Direct match count is 0 — every hit is a traversal neighbour, not a seed match.`;
    } else if (topScore !== null) {
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
            topic, mode: 'full', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope },
            crossProject, totalRecalled: recalled.length,
            directMatches,
            connectedMatches: recalled.length - directMatches,
            knowledge: recalled.map(({ node, source }) => {
                const n = node as LoreNode & { language?: string | null; stale?: boolean };
                return {
                    id: n.id, type: n.type, label: n.label, content: n.content, tags: n.tags,
                    project: n.project, source, language: n.language ?? null,
                    ...(n.stale ? { stale_warning: true } : {}),
                };
            }),
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
                ...tokenMeta,
            },
        };
    }

    // Summary.
    const trimmed = recalled.slice(0, SUMMARY_MAX_HITS);
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
        topic, mode: 'summary', searchMode, scope: { workspace: workspaceScope, ecosystem: ecosystemScope },
        crossProject, totalRecalled: recalled.length, shown: trimmed.length, projectsSeen: [...projectsSeen],
        hits: trimmed.map(({ node, source }) => {
            const n = node as LoreNode & { stale?: boolean };
            return {
                id: n.id, type: n.type, label: n.label, project: n.project, tags: n.tags,
                snippet: snippetOf(n.content), source,
                ...(n.stale ? { stale_warning: true } : {}),
            };
        }),
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
            ...tokenMeta,
        },
    };
}
