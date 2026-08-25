/**
 * streaming/concurrencyLimiter.ts — generic per-key in-memory
 * concurrency cap. Sprint S extract.
 *
 * Why a fresh primitive instead of reusing Sprint Z3's
 * `WorkspaceConcurrencyManager`:
 *   - Z3's manager is intentionally coupled to LoadJobsStore for
 *     reconcile() (durable state — load_jobs.status='running' rows
 *     survive restart and the in-memory count must match on boot).
 *   - Sprint S stream sessions are in-memory only by definition (HTTP
 *     chunked responses die on daemon restart; clients reconnect),
 *     so there is no durable store to reconcile from. Forcing the
 *     stream registry through a store-shaped interface would muddy
 *     both call sites.
 *   - The shared pattern is the in-memory tryAcquire/release/getCount
 *     loop. That is exactly what this file ships — 60 lines, zero
 *     external dependencies, identical semantics to Z3's hot path.
 *
 * Sprint Z3's WorkspaceConcurrencyManager retains its existing API
 * unchanged; the two implementations share the same observable
 * behaviour (acquire-or-refuse + monotone non-negative counter) so
 * future consolidation is mechanical when both sites can tolerate
 * the store-coupling tradeoff.
 *
 * Operator-visible config:
 *   - LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE — integer cap; default 3.
 *     Matches Sprint Z3's DEFAULT_MAX_CONCURRENT_PER_WORKSPACE so a
 *     workspace running both bulk loads + warm-lane streams sees
 *     symmetric backpressure shapes.
 */

/**
 * Generic key-scoped concurrency limiter. Single-threaded JS event
 * loop guarantees `tryAcquire` + `release` are atomic without locks.
 */
export class ConcurrencyLimiter {
    private readonly cap: number;
    private readonly counts = new Map<string, number>();

    constructor(cap: number) {
        if (!Number.isFinite(cap) || cap <= 0) {
            throw new Error(`ConcurrencyLimiter: cap must be a positive integer (got ${cap})`);
        }
        this.cap = cap;
    }

    /** Read the per-key cap. */
    getCap(): number {
        return this.cap;
    }

    /** Current in-flight count for a key. */
    getCount(key: string): number {
        return this.counts.get(key) ?? 0;
    }

    /**
     * Attempt to increment. Returns true if accepted (under cap),
     * false if rejected (at cap — caller emits 429 + Retry-After).
     */
    tryAcquire(key: string): boolean {
        const cur = this.counts.get(key) ?? 0;
        if (cur >= this.cap) return false;
        this.counts.set(key, cur + 1);
        return true;
    }

    /** Decrement on session close. Never goes below zero. */
    release(key: string): void {
        const cur = this.counts.get(key) ?? 0;
        const next = Math.max(0, cur - 1);
        if (next === 0) this.counts.delete(key);
        else this.counts.set(key, next);
    }

    /** Test introspection. */
    snapshot(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [k, v] of this.counts.entries()) out[k] = v;
        return out;
    }
}
