/**
 * poolLimits.ts — engine-agnostic pool admission limits and their errors.
 *
 * Relocated out of `kuzuConnectionPool.ts` (Kùzu-only, importing
 * `@kineviz/kuzu-lite`'s `Connection`/`Database`) because none of these
 * symbols touch Kùzu: they are the shared bounded-acquire policy used
 * identically by `LanceTablePool` and (until it is deleted) Kùzu's own
 * `KuzuConnectionPool`, plus the two error classes the HTTP layer maps
 * to 503. Moving them before the Kùzu-only remainder of that file is
 * deleted is load-bearing — see docs/audit/KUZU-REMOVAL-*.md.
 */

/**
 * Default drain timeout (ms) for `close()` / `drain()`. After this window
 * elapses, the pool stops waiting for in-flight borrows and proceeds to
 * close native handles as a best-effort. A logged warning records how
 * many borrows were still outstanding when the timeout fired. The daemon
 * is NOT crashed — see audit finding `conc-close-does-not-drain-inflight-reads`.
 */
export const DEFAULT_POOL_DRAIN_TIMEOUT_MS = 5000;

/**
 * PoolExhaustedError — thrown by acquire() when maxWaiters is set and
 * the waiter queue is already full. HTTP layer maps this to 503 with
 * Retry-After so callers get a fast-fail instead of hanging until the
 * client times out.
 */
export class PoolExhaustedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PoolExhaustedError';
    }
}

/**
 * PoolAcquireTimeoutError — thrown when a queued acquire waits longer
 * than acquireTimeoutMs. HTTP layer maps this to 503.
 */
export class PoolAcquireTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PoolAcquireTimeoutError';
    }
}

/** Maximum number of callers that may queue waiting for a connection.
 *  Beyond this, acquire() throws PoolExhaustedError immediately so the
 *  HTTP layer can return 503 rather than silently queueing without
 *  bound. Configurable via LORE_POOL_MAX_WAITERS. */
export const DEFAULT_POOL_MAX_WAITERS = 200;

/** Maximum ms a queued acquire may wait before PoolAcquireTimeoutError
 *  is thrown. Configurable via LORE_POOL_ACQUIRE_TIMEOUT_MS. */
export const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 30_000;

export function resolvePoolMaxWaiters(
    envValue: string | undefined = process.env.LORE_POOL_MAX_WAITERS,
): number {
    if (envValue === undefined || envValue === '') return DEFAULT_POOL_MAX_WAITERS;
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POOL_MAX_WAITERS;
    return parsed;
}

export function resolvePoolAcquireTimeoutMs(
    envValue: string | undefined = process.env.LORE_POOL_ACQUIRE_TIMEOUT_MS,
): number {
    if (envValue === undefined || envValue === '') return DEFAULT_POOL_ACQUIRE_TIMEOUT_MS;
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POOL_ACQUIRE_TIMEOUT_MS;
    return parsed;
}
