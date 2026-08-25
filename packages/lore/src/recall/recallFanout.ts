/**
 * recallFanout.ts — bounded fan-out controls for cross-workspace recall.
 *
 * Extracted so the ONE cross-workspace implementation (runCrossWorkspaceRecall)
 * carries the same scale protections the HTTP path used to have on its own:
 * cap the number of workspaces scanned, and scan them with bounded parallelism
 * instead of one-at-a-time. Defaults are generous so small installs behave
 * identically; the caps only bite at scale.
 */

/** Max number of workspaces a single cross-workspace recall will scan. */
export function resolveRecallFanoutWsCap(): number {
    const raw = parseInt(process.env['LORE_RECALL_FANOUT_WS_CAP'] ?? '', 10);
    if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 10_000);
    return 50;
}

/** Max number of per-workspace scans in flight at once. */
export function resolveRecallFanoutConcurrency(): number {
    const raw = parseInt(process.env['LORE_RECALL_FANOUT_CONCURRENCY'] ?? '', 10);
    if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 64);
    return 8;
}

/**
 * mapWithConcurrency — run `fn` over `items` with at most `concurrency` in
 * flight at once, preserving result order. Small inline pool so we don't add a
 * dependency for one call site. Results align positionally with `items`.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]!, i);
        }
    });
    await Promise.all(workers);
    return out;
}
