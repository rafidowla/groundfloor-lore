/**
 * helpers.ts — retrieval helpers shared by the search/recall tools.
 *
 *   - reciprocalRankFusion: merge semantic + BM25 ranked lists (recall).
 *   - buildLanguageHint: cross-language hint when the corpus is mostly in
 *     a different language than the query (search + recall).
 *   - estimateTokens: rough token cost of one node (recall token budget).
 */

import type { LoreNode } from '../../../providers/types.js';
import type { WorkspaceGraph } from '../../../engines/openWorkspaceGraph.js';

/**
 * reciprocalRankFusion — Merge two ranked result lists into one.
 *
 * Fix #1 (hybrid retrieval): fuses semantic (vector) and BM25 (keyword)
 * result lists so that nodes appearing in BOTH lists rank higher than
 * nodes appearing in only one. Classic RRF formula:
 *   RRF(doc) = Σ 1 / (k + rank_in_list_i)
 * where k=60 is the standard constant that prevents rank-1 items from
 * completely dominating the merged list.
 *
 * Returns ids in descending RRF score order.
 */
export function reciprocalRankFusion(
    semanticIds: string[],
    keywordIds: string[],
    k: number = 60,
): string[] {
    const scores = new Map<string, number>();
    const add = (ids: string[]) => {
        ids.forEach((id, idx) => {
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
        });
    };
    add(semanticIds);
    add(keywordIds);
    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
}

/**
 * `getLanguageBreakdown` sits in an awkward spot: `LocalGraph`, `SurrealGraph`
 * AND `DataplaneGraph` all implement it, but the Arcade scoped handle does not
 * — so it is neither a `LoreGraphHandle` member nor a local-engine marker, and
 * it gets its own capability probe.
 *
 * Probe the METHOD, never the engine family. Gating it behind
 * `requireWorkspaceGraph` (which refuses anything without `bulkListProjected`)
 * would 501 it in CLOUD mode, where `DataplaneGraph` implements it and it has
 * always worked — that regression was written and caught during the daemon
 * engine port, which is why this comment is here.
 */
export interface LanguageBreakdownGraph {
    getLanguageBreakdown(): Promise<Record<string, number>>;
}

/** True when this graph can produce a language breakdown, whatever it is. */
export function hasLanguageBreakdown(graph: unknown): graph is LanguageBreakdownGraph {
    return !!graph
        && typeof graph === 'object'
        && typeof (graph as LanguageBreakdownGraph).getLanguageBreakdown === 'function';
}

/**
 * Cross-language hint payload — named so consumers can type a `hint`
 * variable without reaching for `Awaited<ReturnType<typeof buildLanguageHint>>`.
 */
export interface LanguageHint {
    queryLanguage: string;
    corpusLanguageBreakdown: Record<string, number>;
    suggestion: string;
}

/**
 * buildLanguageHint — Phase B (V2.2). Compare caller's declared
 * `queryLanguage` against the corpus language breakdown. Return a
 * hint object when few/no nodes match, or null when the graph has
 * enough matches or the distribution is uninformative.
 *
 * No automatic translation here. The hint tells the caller that
 * cross-language routing might help; the chat LLM already handles
 * translation naturally during answer generation.
 */
export async function buildLanguageHint(
    graph: LanguageBreakdownGraph,
    queryLanguage: string,
): Promise<LanguageHint | null> {
    try {
        const breakdown = await graph.getLanguageBreakdown();
        const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
        if (total === 0) return null;

        const untagged = breakdown['null'] ?? 0;
        const tagged = total - untagged;
        const matchingLang = breakdown[queryLanguage] ?? 0;

        // If nothing in the corpus is tagged, no basis to claim a
        // language mismatch — fire a "no language data" hint so the
        // caller knows why translation isn't being suggested.
        if (tagged === 0) {
            return {
                queryLanguage,
                corpusLanguageBreakdown: breakdown,
                suggestion: `No nodes in the corpus are language-tagged. Your BYOK LLM will still handle translation naturally during chat. To improve raw-search quality for "${queryLanguage}" content, tag nodes explicitly at ingest (see detect_language tool or docs/LANGUAGE_DETECTION.md).`,
            };
        }

        // Of the tagged content, how much matches the query language?
        const matchingFracOfTagged = matchingLang / tagged;
        if (matchingFracOfTagged >= 0.1) return null;

        const suggestion = `Only ${matchingLang} of ${tagged} tagged node(s) match language="${queryLanguage}" (${untagged} untagged remain). Your BYOK LLM will translate retrieved content in its answer automatically. To improve raw-search quality for "${queryLanguage}" content, tag nodes explicitly at ingest.`;

        return {
            queryLanguage,
            corpusLanguageBreakdown: breakdown,
            suggestion,
        };
    } catch {
        return null;
    }
}

/** Estimate token cost of one LoreNode (label + content / 4). */
export function estimateTokens(node: LoreNode): number {
    return Math.ceil(((node.label?.length ?? 0) + (node.content?.length ?? 0)) / 4);
}
