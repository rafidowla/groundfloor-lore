/**
 * verbatimHybridSearch.ts — hybrid (BM25 + vector) fusion for the verbatim
 * search surfaces (cluster-5 medium, 2026-08-18).
 *
 * search_verbatim, GET /api/verbatim/search, and VerbatimStoreAdapter.search
 * are all documented as "Hybrid (BM25 + vector) search" — the IVerbatimStore
 * contract even specifies the default ranking ("reciprocal-rank-fusion
 * across the two scorers") — but each of them only ever ran the VECTOR
 * search. bm25Search existed and was fused correctly elsewhere (recall's
 * retrieve.ts); these surfaces just never called it.
 *
 * This helper is that fusion, factored so all three surfaces share ONE
 * implementation (same shape as retrieve.ts's seed pass):
 *   - run the vector search and bm25Search in parallel;
 *   - read the BM25 result through readBm25Envelope — FAIL-CLOSED: a
 *     LIKE-scan fallback (`ranked: false`) or any corrupted/legacy shape
 *     contributes NOTHING rather than an arbitrary order ("half a signal
 *     beats a corrupted one");
 *   - fuse the two id lists with reciprocal-rank-fusion (k=60);
 *   - report each hit's score as its RRF score normalized to 0..1 (1.0 =
 *     best-fused), matching the unified score convention in retrieve.ts.
 *
 * The underlying VerbatimStore.search stays PURE vector similarity —
 * autolink/reconnect and the recall seed pass rely on raw cosine scores and
 * must not silently change meaning. Fusion belongs to the user-facing
 * surfaces only.
 */

import { reciprocalRankFusion } from '../mcp/tools/search/helpers.js';
import { readBm25Envelope } from './verbatimBm25Result.js';

/** One fused result row: the underlying hit object plus its unified score.
 *  `hit` is the SEMANTIC hit object when the id appeared in both lists (it
 *  carries the full text/metadata), else the BM25-only hit object. */
export interface FusedVerbatimHit<T extends { id: string }> {
    hit: T;
    /** Normalized RRF score, 0..1 (1.0 = top of the fused ranking). */
    score: number;
    matchedBy: { semantic: boolean; bm25: boolean };
}

/** Per-id RRF score, k=60 — mirrors retrieve.ts's local rrfScores (the
 *  shared helpers.reciprocalRankFusion returns only ordered ids). */
function rrfScores(semanticIds: string[], bm25Ids: string[], k = 60): Map<string, number> {
    const scores = new Map<string, number>();
    const add = (ids: string[]) => ids.forEach((id, idx) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1)));
    add(semanticIds);
    add(bm25Ids);
    return scores;
}

/** Fuse already-fetched semantic + BM25 result lists. `bm25Value` is the RAW
 *  return of bm25Search() (any shape — the fail-closed envelope reader
 *  decides); pass `undefined` when the store has no bm25Search at all and
 *  the read degrades to semantic-only. */
export function fuseHybridVerbatim<T extends { id: string }>(
    semantic: T[],
    bm25Value: unknown,
): FusedVerbatimHit<T>[] {
    const envelope = readBm25Envelope<T>(bm25Value);
    const bm25 = envelope.ranked ? envelope.hits : [];
    const semanticIds = semantic.map((h) => h.id);
    const bm25Ids = bm25.map((h) => h.id);
    const fusedIds = reciprocalRankFusion(semanticIds, bm25Ids);
    const rrf = rrfScores(semanticIds, bm25Ids);
    const maxRrf = Math.max(1e-9, ...rrf.values());
    const semanticById = new Map(semantic.map((h) => [h.id, h]));
    const bm25ById = new Map(bm25.map((h) => [h.id, h]));
    const semanticSet = new Set(semanticIds);
    const bm25Set = new Set(bm25Ids);
    return fusedIds.map((id) => ({
        hit: semanticById.get(id) ?? bm25ById.get(id)!,
        score: (rrf.get(id) ?? 0) / maxRrf,
        matchedBy: { semantic: semanticSet.has(id), bm25: bm25Set.has(id) },
    }));
}

/** Run both scorers against a store and fuse. `store.search` is required;
 * `store.bm25Search` is feature-detected — a store without it (or one whose
 * bm25Search throws) degrades to semantic-only, never fails the search. */
export async function hybridVerbatimSearch<T extends { id: string }>(
    store: { search(q: string, limit: number): Promise<T[]> },
    query: string,
    limit: number,
): Promise<FusedVerbatimHit<T>[]> {
    const bm25Store = store as { bm25Search?: (q: string, limit: number) => Promise<unknown> };
    let bm25Value: unknown;
    try {
        bm25Value = typeof bm25Store.bm25Search === 'function'
            ? await bm25Store.bm25Search(query, limit)
            : undefined;
    } catch {
        // A broken lexical path must not take the working vector path down.
        bm25Value = undefined;
    }
    const semantic = await store.search(query, limit);
    return fuseHybridVerbatim(semantic, bm25Value).slice(0, limit);
}
