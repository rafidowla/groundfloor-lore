/**
 * boundedMap.ts - order-preserving map with a small concurrency bound.
 *
 * The link substrate issues one tiny read per node (`getById`, `queryEdges` x2). On a networked store each is a
 * round trip, so a 50-node batch spends 150+ sequential round trips doing nothing but waiting. Running a few at a
 * time overlaps those waits without opening the floodgates: the bound is deliberately small (default 4) because the
 * rebuild shares the pool with foreground traffic.
 *
 * Results come back in INPUT order, so callers that merge them keep their deterministic first-wins semantics.
 * The first rejection stops handing out new work and is rethrown once in-flight calls settle.
 */
export const LINK_READ_CONCURRENCY = 4;

export async function boundedMap<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
    let next = 0;
    let failure: { err: unknown } | null = null;
    const worker = async (): Promise<void> => {
        while (!failure) {
            const i = next++;
            if (i >= items.length) return;
            try { out[i] = await fn(items[i]!, i); } catch (err) { failure ??= { err }; return; }
        }
    };
    await Promise.all(Array.from({ length: width }, worker));
    if (failure) throw (failure as { err: unknown }).err;
    return out;
}
