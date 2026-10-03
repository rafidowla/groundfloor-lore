/**
 * dataplaneScore.ts — score normalisation for Dataplane-backed verbatim search
 * (cloud parity, design D4): `normalizeBm25Scores` / `scoreBm25Hits` (keyword lane) and
 * `normalizeVectorScore` (semantic lane).
 *
 * Vector contract: Lore ASSUMES every `lore_verbatim` vector index uses cosine. The engine
 * cannot declare a metric or honour the vector dimension (Nokshi dataplane-ask #8 + A4),
 * and each connector names the similarity differently (F9), so until every result carries
 * a normalised `_score` Lore infers the metric from the key name; a non-cosine collection
 * produces wrong but bounded scores (always clamped to [0,1]).
 *
 * BM25 contract (mirrors local `verbatimStore.ts`): scores are `raw / max(max(raw), 1)`,
 * computed AFTER the scope post-filter so a foreign workspace's high-scoring row can
 * never compress the caller's scores. `ranked` is true only when EVERY hit carried a
 * numeric `_score` (the engine sets it iff the connector advertises RankedFullTextSearch,
 * e.g. Arango). A substring backend (Postgres today) returns no `_score`: the hits are
 * kept with score 1.0 and `ranked:false`, which is what local's LIKE fallback does —
 * RRF fusion excludes an unranked lane, so it never pretends to be a ranking.
 *
 * Pure: no SDK, no I/O.
 */

/** Normalise raw BM25 scores to [0,1]: `raw / max(max(raw), 1)` (identical to local). */
export function normalizeBm25Scores(raw: readonly number[]): number[] {
    if (raw.length === 0) return [];
    const finite = raw.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
    const denom = Math.max(Math.max(...finite), 1);
    return finite.map((s) => s / denom);
}

/**
 * Score a post-filtered keyword hit list. Returns one score per hit and whether the
 * list is a genuine ranking (every hit has a numeric `_score`). Unranked → all 1.0.
 */
export function scoreBm25Hits(hits: ReadonlyArray<Record<string, unknown>>): { scores: number[]; ranked: boolean } {
    if (hits.length === 0) return { scores: [], ranked: true };
    const ranked = hits.every((h) => typeof h['_score'] === 'number' && Number.isFinite(h['_score'] as number));
    if (!ranked) return { scores: hits.map(() => 1.0), ranked: false };
    return { scores: normalizeBm25Scores(hits.map((h) => h['_score'] as number)), ranked: true };
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Normalise ONE vector-search hit to [0,1], equal to local's `1 - cosineDistance/2`.
 * Precedence (first numeric key wins):
 *   1. `_score`     — the future engine contract (already 0..1, ask #8); clamped.
 *   2. `_distance`  — cosine distance in [0,2]          -> 1 - d/2.
 *   3. `score`      — Qdrant cosine similarity in [-1,1] -> (1 + s)/2.
 *   4. `distance`   — Zilliz COSINE (Milvus returns the SIMILARITY under this key) -> (1 + s)/2.
 *   5. none (Arango returns no score) or non-finite -> 0; callers keep the server order.
 */
export function normalizeVectorScore(rec: Record<string, unknown>): number {
    if (num(rec['_score'])) return clamp01(rec['_score']);
    if (num(rec['_distance'])) return clamp01(1 - rec['_distance'] / 2);
    if (num(rec['score'])) return clamp01((1 + rec['score']) / 2);
    if (num(rec['distance'])) return clamp01((1 + rec['distance']) / 2);
    return 0;
}
