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

/** Default max time (ms) a READ may sit queued before it fails fast with
 *  SearchOverloadError instead of riding out the caller's full call timeout
 *  (fix/search-worker-call-cancellation, 3.20.2 — defect 1, requirement 4).
 *  Env LORE_SEARCH_QUEUE_WAIT_MS overrides.
 *
 *  3.20.2 review, finding 3: this shipped as Infinity unless the env var was
 *  set, so NO queued read failed fast out of the box — requirement 4 was
 *  effectively opt-in only, contrary to its own stated intent ("a queued read
 *  past that bound fails fast ... instead of waiting out however long the
 *  holder takes"). Now finite by default (30s): generous enough that it
 *  never trims a normal read (bounded concurrency + the exclusive FTS build
 *  is the only long holder, and that's a one-time/rare event), but it puts a
 *  ceiling under a stuck/slow holder instead of leaving queued reads to ride
 *  out an unbounded wait. Never applied to exclusive() — the index build must
 *  always be admitted eventually. */
function defaultQueueWaitMs(): number {
    const env = parseEnvInt('LORE_SEARCH_QUEUE_WAIT_MS');
    if (env !== undefined && env > 0) return env;
    return 30_000;
}

function toAbortError(signal: AbortSignal): Error {
    const reason = (signal as { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const err = new Error(reason !== undefined ? String(reason) : 'aborted');
    err.name = 'AbortError';
    return err;
}

export interface SearchGateOptions {
    maxConcurrent?: number;
    maxQueue?: number;
    /** Overrides LORE_SEARCH_QUEUE_WAIT_MS for this instance (mainly for tests). */
    queueWaitMs?: number;
}

/** Options a caller may pass to read()/exclusive() for cancellation. Only
 *  `signal` is meaningful on exclusive() — queue-wait bounding never applies
 *  to it (see defaultQueueWaitMs's doc). */
export interface SearchGateCallOptions {
    signal?: AbortSignal;
}

interface Waiter {
    need: number;
    isRead: boolean;
    resolve: () => void;
    reject: (e: Error) => void;
    /** Set true the instant a waiter is removed from the queue (by abort or
     *  queue-wait timeout) so a `release()` that raced the removal can never
     *  double-grant it. */
    cancelled?: boolean;
}

export class SearchGate {
    private readonly max: number;
    private readonly maxQueue: number;
    private readonly queueWaitMs: number;
    private permits: number;
    private readonly waiters: Waiter[] = [];
    private queuedReads = 0;

    constructor(opts: SearchGateOptions = {}) {
        this.max = clamp(opts.maxConcurrent ?? defaultSearchConcurrency(), 1, 4096);
        this.maxQueue = Math.max(0, opts.maxQueue ?? defaultSearchQueueMax(this.max));
        this.queueWaitMs = opts.queueWaitMs ?? defaultQueueWaitMs();
        this.permits = this.max;
    }

    /** Test/diagnostic: current available permits + queue depth. */
    stats(): { max: number; permits: number; queued: number; queuedReads: number } {
        return { max: this.max, permits: this.permits, queued: this.waiters.length, queuedReads: this.queuedReads };
    }

    /** need/isRead as before, plus optional cancellation:
     *  - `signal`: an already-aborted signal rejects before anything is queued;
     *    a signal that aborts while queued removes this waiter (by identity, so
     *    a concurrent release() can never double-grant it) and rejects with the
     *    abort's reason. It never affects any other waiter.
     *  - `queueWaitMs`: if still queued after this long, same removal + reject,
     *    but with SearchOverloadError instead — "the queue itself is the
     *    problem", not caller cancellation. READS only (see release()'s caller). */
    private acquire(need: number, isRead: boolean, opts?: SearchGateCallOptions & { queueWaitMs?: number }): Promise<void> {
        const signal = opts?.signal;
        if (signal?.aborted) {
            return Promise.reject(toAbortError(signal));
        }
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
        return new Promise<void>((resolvePromise, rejectPromise) => {
            const waiter: Waiter = { need, isRead, resolve: resolvePromise, reject: rejectPromise };
            this.waiters.push(waiter);
            if (isRead) this.queuedReads++;

            let settled = false;
            let onAbort: (() => void) | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                if (onAbort && signal) signal.removeEventListener('abort', onAbort);
                if (timer !== undefined) clearTimeout(timer);
            };
            // release()/removeWaiter() below call these — never the raw
            // executor callbacks — so a settle can only ever happen once,
            // whichever path (grant, abort, queue-wait) gets there first.
            waiter.resolve = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolvePromise();
            };
            waiter.reject = (e: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                rejectPromise(e);
            };
            const removeWaiter = (err: Error) => {
                if (settled) return;
                waiter.cancelled = true;
                const idx = this.waiters.indexOf(waiter);
                if (idx !== -1) {
                    this.waiters.splice(idx, 1);
                    if (waiter.isRead) this.queuedReads--;
                }
                waiter.reject(err);
            };

            if (signal) {
                onAbort = () => removeWaiter(toAbortError(signal));
                signal.addEventListener('abort', onAbort, { once: true });
            }
            const queueWaitMs = opts?.queueWaitMs;
            if (queueWaitMs !== undefined && Number.isFinite(queueWaitMs)) {
                timer = setTimeout(() => {
                    removeWaiter(new SearchOverloadError(
                        `search overloaded: waited ${queueWaitMs}ms in queue for a permit — retry shortly`,
                    ));
                }, queueWaitMs);
            }
        });
    }

    private release(n: number): void {
        this.permits += n;
        // Grant waiters in FIFO order while enough permits are free for the head.
        while (this.waiters.length > 0 && this.permits >= this.waiters[0].need) {
            const w = this.waiters.shift()!;
            if (w.cancelled) continue; // defensive: removeWaiter() already spliced it out above
            if (w.isRead) this.queuedReads--;
            this.permits -= w.need;
            w.resolve();
        }
    }

    /** Run `fn` holding ONE permit (a bounded concurrent read). `opts.signal`
     *  cancels this caller's own wait/run without affecting any other reader —
     *  see the class doc. Queue-wait bounding (LORE_SEARCH_QUEUE_WAIT_MS) is
     *  applied automatically. */
    async read<T>(fn: () => Promise<T>, opts?: SearchGateCallOptions): Promise<T> {
        await this.acquire(1, true, { signal: opts?.signal, queueWaitMs: this.queueWaitMs });
        try { return await fn(); }
        finally { this.release(1); }
    }

    /** Run `fn` holding ALL permits — drains in-flight reads + blocks new ones
     *  for its duration. Used for the FTS index build so it never overlaps reads.
     *  No queue-wait bound: an index build must always eventually be admitted. */
    async exclusive<T>(fn: () => Promise<T>, opts?: SearchGateCallOptions): Promise<T> {
        await this.acquire(this.max, false, { signal: opts?.signal });
        try { return await fn(); }
        finally { this.release(this.max); }
    }
}
