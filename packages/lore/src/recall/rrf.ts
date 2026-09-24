/**
 * rrf.ts — the ONE shared reciprocal-rank-fusion implementation (3.21 step
 * 3b). Every place core fuses two or more RANKED result lists into one
 * (semantic + BM25 seed passes, cross-workspace recall's per-workspace
 * semantic/keyword merge, the legacy workspace:"*" search dedupe-merge, the
 * verbatim hybrid-search surfaces) now goes through `rrfFuse` here instead of
 * a locally-reimplemented formula.
 *
 * Why this exists: an audit of every fusion site in recall/, mcp/ and core/
 * (3.21 step 3b) found the SAME reciprocal-rank-fusion math reimplemented
 * three times (mcp/tools/search/helpers.ts's `reciprocalRankFusion` —
 * order-only; recall/retrieve.ts's local `rrfScores` — score-only, same
 * formula; engines/verbatimHybridSearch.ts's local `rrfScores` — same
 * formula again), PLUS two real fusion BUGS the owner has flagged as
 * incorrect by design, not just duplicated:
 *
 *   - mcp/tools/search/searchTool.ts's workspace:"*" branch: a node found by
 *     BOTH the keyword scan and the semantic scan kept whichever score was
 *     registered FIRST (a plain `Map.set` skip-if-present, not a fusion) —
 *     its own doc comment already called this out as "NOT
 *     reciprocal-rank-fusion".
 *   - mcp/tools/recallCrossWorkspace.ts's per-workspace merge: a node found
 *     by both the semantic seed pass and the keyword scan kept whichever of
 *     {raw cosine similarity 0..1, a synthetic keyword score capped at 0.3}
 *     was numerically LARGER — Math.max-of-scores used as fusion, mixing two
 *     incomparable scales.
 *
 * Measured cost of the naive-average shape of bug (owner's benchmark): 50/50
 * averaging scored 27% top-1 accuracy vs BM25's own 27% / dense's own 60% —
 * i.e. naive fusion of two ranked lists can score WORSE than either list
 * alone. RRF avoids this because it fuses RANK POSITION, not raw score scale,
 * so two incomparable scoring scales never get blended arithmetically.
 *
 * Deterministic tie-break: fused score descending, then id ascending — so
 * two ids with the identical RRF score (same rank position in every list
 * that contains them) always resolve to the same order across runs/engines,
 * never insertion-order-dependent.
 */

/** One entry in a ranked input list: either a bare ordered id, or an
 *  `{id, score}` pair (the score itself is IGNORED by RRF — only rank
 *  POSITION within the list matters; RRF is scale-agnostic by design). */
export type RankedItem = string | { id: string; score?: number };

/** A single caller-supplied ranked list, best-to-worst order. */
export type RankedList = RankedItem[];

export interface FusedResult {
    id: string;
    /** Normalized RRF score, 0..1 (1.0 = top of the fused ranking). Safe to
     *  present to a caller as "relative relevance within this fused set". */
    score: number;
    /** Raw (unnormalized) reciprocal-rank-fusion score — Σ 1/(k + rank + 1)
     *  across every list containing this id. Exposed for callers that need
     *  the pre-normalization value (e.g. combining fused sets further). */
    rrf: number;
    /** How many of the input lists contained this id. */
    listsMatched: number;
}

/** RRF's `k` constant (exported — D3 review round 2 / candidateWindow.ts's
 *  `stableProv` needs the SAME constant to undo the window-size-dependent
 *  `maxRrf` normalization below with a fixed one; see that file's comment). */
export const DEFAULT_K = 60;

function idOf(item: RankedItem): string {
    return typeof item === 'string' ? item : item.id;
}

/**
 * rrfFuse — fuse N ranked lists into one, by reciprocal-rank-fusion:
 *   RRF(doc) = Σ 1 / (k + rank_in_list_i + 1)   over every list i containing doc
 *
 * `k` (default 60) is the standard RRF constant that keeps a rank-1 item
 * from completely dominating the fused order. Only rank POSITION is used —
 * any `score` on the input items is ignored, which is exactly why this is
 * safe to use across scales that are not directly comparable (cosine
 * similarity vs BM25 score vs a synthetic keyword-rank score).
 *
 * Result order: fused score descending; ties broken by id ascending
 * (deterministic — never insertion-order-dependent).
 */
export function rrfFuse(lists: RankedList[], k: number = DEFAULT_K): FusedResult[] {
    const rrf = new Map<string, number>();
    const matched = new Map<string, number>();
    for (const list of lists) {
        list.forEach((item, idx) => {
            const id = idOf(item);
            rrf.set(id, (rrf.get(id) ?? 0) + 1 / (k + idx + 1));
            matched.set(id, (matched.get(id) ?? 0) + 1);
        });
    }
    const maxRrf = Math.max(1e-9, ...rrf.values());
    return Array.from(rrf.entries())
        .map(([id, score]) => ({ id, rrf: score, score: score / maxRrf, listsMatched: matched.get(id) ?? 0 }))
        .sort((a, b) => (b.rrf - a.rrf) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Convenience wrapper for call sites that only need the fused id ORDER
 *  (a drop-in replacement for the old two-list-only
 *  `reciprocalRankFusion(semanticIds, keywordIds)` shape). */
export function rrfFuseIds(lists: RankedList[], k: number = DEFAULT_K): string[] {
    return rrfFuse(lists, k).map((r) => r.id);
}

/** Convenience wrapper for call sites that want id → normalized-score, e.g.
 *  to attach the unified `score` field onto a hydrated result. */
export function rrfFuseScores(lists: RankedList[], k: number = DEFAULT_K): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of rrfFuse(lists, k)) out.set(r.id, r.score);
    return out;
}
