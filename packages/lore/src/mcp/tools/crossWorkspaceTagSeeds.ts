/**
 * 3.38.3 — tag pushdown for cross-workspace recall's semantic seed pass.
 *
 * 3.38.2 fixed single-workspace `recall({ tags })` (retrieveSeedStore.ts): a tag held by a small
 * share of a workspace was applied only as a cut over a fixed top-K window, so it often came back
 * empty. Cross-workspace recall (recallCrossWorkspace.ts) had the same shape — a 20-row semantic
 * window and a 10-row keyword window per workspace, tags applied after the merge — and was left
 * for this follow-up.
 *
 * Same rule as 3.38.2: the unscoped query still runs unchanged and ONE extra query scoped with
 * `tagsAll` is unioned in. The verbatim row's `tags` is a write-time copy that can be stale, and
 * the graph node's tags (checked by the caller) are authoritative, so the scoped query can only
 * add candidates, never be the sole source. Stores that cannot push `tagsAll` down (LanceDB,
 * Dataplane) ignore the key: the scoped query then duplicates the base one — never a wrong result.
 */

export interface SeedHit { id: string; score?: number }
export type SeedFilter = { type?: string[]; tagsAll?: string[] } | undefined;

/**
 * Run `search` once with `baseFilter`, and — when `seedTags` is set — once more with
 * `tagsAll: seedTags`, returning the union (best score per id, score descending).
 * Without tags this is exactly one call with `baseFilter`, as before 3.38.3.
 */
export async function seedSearchWithTags<T extends SeedHit>(
    search: (filter: SeedFilter) => Promise<T[]>,
    baseFilter: SeedFilter,
    seedTags: string[] | undefined,
): Promise<T[]> {
    if (!seedTags || seedTags.length === 0) return search(baseFilter);
    const [base, scoped] = await Promise.all([search(baseFilter), search({ ...(baseFilter ?? {}), tagsAll: seedTags })]);
    const best = new Map<string, T>();
    for (const hit of [...base, ...scoped]) {
        const prev = best.get(hit.id);
        if (!prev || (hit.score ?? 0) > (prev.score ?? 0)) best.set(hit.id, hit);
    }
    return [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
