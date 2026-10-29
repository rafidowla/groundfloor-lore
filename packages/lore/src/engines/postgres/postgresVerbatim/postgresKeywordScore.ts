/**
 * postgresKeywordScore.ts — the ONE place keyword (ts_rank) scores are normalized to [0,1].
 *
 * Phase 0 lane L5 (merge-safe keyword scores). `bm25Search` returns the RAW `ts_rank` per row (a pure function of the
 * document and the query, so values are comparable across rows, slices and shards). Normalization is a property of
 * the FINAL, caller-visible hit list, so it must run exactly once, after every step that can remove or add rows:
 *
 *   1. the scope predicate (SQL, pre-LIMIT since L4; the JS assertion also runs before this helper), and
 *   2. (Phase 3, multi-slice) the cross-slice merge + re-cut to `limit`.
 *
 * Normalizing earlier lets rows the caller can never see decide the scale: a hidden top hit would pin every visible
 * score below 1.0, and two slices normalized separately would be merged on incomparable numbers.
 *
 * The formula is unchanged from the pre-L5 inline code: `raw / max(max(raw), 1e-9)`, so with no hidden rows the output
 * is byte-identical (see test/pg-keyword-score-raw-unit.ts, which pins it against a copy of the old expression).
 */

/** Guard against a zero/empty max (all-zero ts_rank), identical to the pre-L5 inline floor. */
export const KEYWORD_SCORE_MAX_FLOOR = 1e-9;

/**
 * Normalize RAW scores to [0,1] by the best score present. Pure; input order is preserved. Call it once, on the final
 * hit list. Non-finite raw scores count as 0 (they cannot become the max or poison the divisor).
 */
export function normalizeKeywordScores(raw: readonly number[]): number[] {
    if (raw.length === 0) return [];
    const clean = raw.map((s) => (Number.isFinite(s) ? s : 0));
    const max = Math.max(...clean, KEYWORD_SCORE_MAX_FLOOR);
    return clean.map((s) => s / max);
}

/** Hit-list form of {@link normalizeKeywordScores}: each hit's `score` is replaced by its normalized value. */
export function normalizeKeywordHits<T extends { score: number }>(hits: readonly T[]): T[] {
    const norm = normalizeKeywordScores(hits.map((h) => h.score));
    return hits.map((h, i) => ({ ...h, score: norm[i]! }));
}
