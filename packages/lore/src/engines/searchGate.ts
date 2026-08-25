/**
 * engines/searchGate.ts — admission control in front of the native search
 * engines (LanceDB vector + full-text) so a burst of concurrent searches can't
 * push the native layer into a state that hard-crashes the whole process.
 *
 * It's a small FIFO weighted semaphore:
 *   - read()      takes ONE permit. Concurrent reads are bounded to `maxConcurrent`
 *                 (adaptive to CPU cores), so a stampede becomes an orderly line.
 *   - exclusive() takes ALL permits. Used for the FTS index BUILD, so the build
 *                 drains in-flight reads and blocks new ones for its (one-time,
 *                 short) duration — the "read while the index is being rebuilt"
 *                 overlap that triggers the crash can never happen.
 *   - overload    when more than `maxQueue` reads are already waiting, a new read
 *                 is rejected with SearchOverloadError ("busy, retry") instead of
 *                 piling more work onto a saturated engine.
 *
 * FIFO fairness: once anything is queued, even a read that could grab a free
 * permit waits its turn — so the exclusive build is never starved by a steady
 * stream of reads. Cache HITS never reach here (they're free); only real native
 * reads take a permit.
 */

import * as os from 'node:os';

/** Thrown when the search admission queue is saturated. Callers surface it as a
 *  clean "busy, retry shortly" rather than crashing or dogpiling the engine. */
export class SearchOverloadError extends Error {
    readonly code = 'search_overloaded';
    constructor(message: string) {
        super(message);
        this.name = 'SearchOverloadError';
    }
}

function parseEnvInt(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/** Default concurrent-search ceiling: scale to CPU cores, clamped to [2, 8].
 *  Env LORE_SEARCH_CONCURRENCY overrides. */
export function defaultSearchConcurrency(): number {
    const env = parseEnvInt('LORE_SEARCH_CONCURRENCY');
    if (env && env > 0) return env;
    const cores = Math.max(1, os.cpus()?.length ?? 4);
    return clamp(cores, 2, 8);
}

/** Default max queued reads before shedding load. Env LORE_SEARCH_QUEUE_MAX. */
function defaultSearchQueueMax(maxConcurrent: number): number {
    const env = parseEnvInt('LORE_SEARCH_QUEUE_MAX');
    if (env !== undefined) return env;
    return maxConcurrent * 8;
}

export interface SearchGateOptions {
    maxConcurrent?: number;
    maxQueue?: number;
}

interface Waiter {
    need: number;
    isRead: boolean;
    resolve: () => void;
    reject: (e: Error) => void;
}

export class SearchGate {
    private readonly max: number;
    private readonly maxQueue: number;
    private permits: number;
    private readonly waiters: Waiter[] = [];
    private queuedReads = 0;

    constructor(opts: SearchGateOptions = {}) {
        this.max = clamp(opts.maxConcurrent ?? defaultSearchConcurrency(), 1, 4096);
        this.maxQueue = Math.max(0, opts.maxQueue ?? defaultSearchQueueMax(this.max));
        this.permits = this.max;
    }

    /** Test/diagnostic: current available permits + queue depth. */
    stats(): { max: number; permits: number; queued: number; queuedReads: number } {
        return { max: this.max, permits: this.permits, queued: this.waiters.length, queuedReads: this.queuedReads };
    }

    private acquire(need: number, isRead: boolean): Promise<void> {
        // Fast path only when nothing is already waiting (preserve FIFO so an
        // exclusive build isn't starved by a steady read stream).
        if (this.waiters.length === 0 && this.permits >= need) {
            this.permits -= need;
            return Promise.resolve();
        }
        // Overload valve — applies to READS only; the (rare) exclusive build must
        // always be admitted or the index can never get built.
        if (isRead && this.queuedReads >= this.maxQueue) {
            return Promise.reject(new SearchOverloadError(
                `search overloaded: ${this.queuedReads} already queued (max ${this.maxQueue}) — retry shortly`,
            ));
        }
        return new Promise<void>((resolve, reject) => {
            this.waiters.push({ need, isRead, resolve, reject });
            if (isRead) this.queuedReads++;
        });
    }

    private release(n: number): void {
        this.permits += n;
        // Grant waiters in FIFO order while enough permits are free for the head.
        while (this.waiters.length > 0 && this.permits >= this.waiters[0].need) {
            const w = this.waiters.shift()!;
            if (w.isRead) this.queuedReads--;
            this.permits -= w.need;
            w.resolve();
        }
    }

    /** Run `fn` holding ONE permit (a bounded concurrent read). */
    async read<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire(1, true);
        try { return await fn(); }
        finally { this.release(1); }
    }

    /** Run `fn` holding ALL permits — drains in-flight reads + blocks new ones
     *  for its duration. Used for the FTS index build so it never overlaps reads. */
    async exclusive<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire(this.max, false);
        try { return await fn(); }
        finally { this.release(this.max); }
    }
}
