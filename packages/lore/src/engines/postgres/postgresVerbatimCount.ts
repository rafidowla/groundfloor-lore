/**
 * postgresVerbatimCount.ts - short-TTL, write-invalidated cache for the
 * verbatim store's `count()`.
 *
 * recall asks `seedStore.count()` on every query (retrieve.ts: "is the store
 * non-empty?"; calibration.ts: "did the row count move since the last fit?").
 * On Postgres that is `SELECT count(*) FROM verbatim WHERE workspace_id = $1`,
 * an index scan of the whole workspace (measured ~45 ms at 1M rows with a clean visibility map, and it
 * grows with rows and with dead tuples), paid per recall. The VALUE is also
 * cheap to keep correct: every write path of the store calls `onMutate()`.
 *
 * Contract:
 *   - keyed by (pool, workspaceId), NOT by store instance, so two store
 *     handles on one workspace in one process (the graph + a sibling) share an
 *     entry and a write through either invalidates both;
 *   - single-flight: concurrent callers share one in-flight query;
 *   - invalidation is an epoch: a write bumps it, drops the value, and any
 *     query that STARTED before the write is never cached or joined by a
 *     caller that arrives after it (that query may predate the write);
 *   - TTL bounds staleness from writes made by OTHER processes (they cannot
 *     reach our onMutate). Default 5 s; 0 disables the cache entirely;
 *   - failures are not cached (the loader throws; the caller decides).
 * `count()` semantics are untouched: all physical rows for the workspace,
 * history snapshots and tombstones included.
 */
import type { Pool } from 'pg';

export const DEFAULT_COUNT_CACHE_TTL_MS = 5_000;

interface Entry {
    epoch: number;
    value: number | null;
    at: number;
    inflight: { epoch: number; promise: Promise<number> } | null;
}

const entries = new WeakMap<Pool, Map<string, Entry>>();

function entryFor(pool: Pool, workspaceId: string): Entry {
    let perPool = entries.get(pool);
    if (!perPool) { perPool = new Map(); entries.set(pool, perPool); }
    let e = perPool.get(workspaceId);
    if (!e) { e = { epoch: 0, value: null, at: 0, inflight: null }; perPool.set(workspaceId, e); }
    return e;
}

/** Called from every verbatim write path (via the store's onMutate). */
export function invalidateVerbatimCount(pool: Pool | null, workspaceId: string): void {
    if (!pool) return;
    const e = entryFor(pool, workspaceId);
    e.epoch++;
    e.value = null;
    e.inflight = null;
}

/**
 * cachedVerbatimCount - serve `load()` through the cache. `now` is injectable
 * for TTL tests.
 */
export async function cachedVerbatimCount(
    pool: Pool,
    workspaceId: string,
    load: () => Promise<number>,
    ttlMs: number = DEFAULT_COUNT_CACHE_TTL_MS,
    now: () => number = Date.now,
): Promise<number> {
    if (ttlMs <= 0) return load();
    const e = entryFor(pool, workspaceId);
    if (e.value !== null && now() - e.at < ttlMs) return e.value;
    if (e.inflight && e.inflight.epoch === e.epoch) return e.inflight.promise;
    const epoch = e.epoch;
    const flight: { epoch: number; promise: Promise<number> } = { epoch, promise: Promise.resolve(0) };
    flight.promise = (async (): Promise<number> => {
        await Promise.resolve(); // never settle synchronously: `flight` must be registered before the finally below runs
        try {
            const value = await load();
            if (e.epoch === epoch) { e.value = value; e.at = now(); } // a write landed meanwhile: do not cache
            return value;
        } finally {
            if (e.inflight === flight) e.inflight = null;
        }
    })();
    e.inflight = flight;
    return flight.promise;
}
