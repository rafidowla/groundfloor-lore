/**
 * holdContext.ts - bounds how long ONE per-node lock hold can be pinned by a hung engine (3.35.0 b).
 *
 * Problem: ArcadeDB that accepts connections but never answers (a paused container, a wedged JVM,
 * a black-holed network path) made a single write hold the per-node write lock for its whole chain
 * of requests - the pre-write read (retried twice by `ArcadeHttp.query`), the write, the settle
 * re-read - each waiting out the full request timeout. Measured on a real container (30 s timeout):
 * 180 s per write, 270 s for a writer queued behind it, with every later writer waiting behind that.
 *
 * Fix: each lock hold runs inside a `LockHold`. The first request in the hold that times out marks it
 * `timedOut`; every later request issued inside the same hold rejects at once with the same timeout
 * error, and the query retry loop does not retry a timeout inside a hold. A hold therefore costs at
 * most ONE request timeout (plus the time of healthy requests before it), and the error shape is
 * unchanged, so the existing outcome-unknown / settle-by-re-read handling still applies: the settle
 * re-read fails fast too, and the write is reported unavailable/outcome-unknown, never "clean".
 *
 * The context is AsyncLocalStorage-based so no transport signature changes. `active` goes false when
 * the hold ends, so a detached task that inherited the store (autolink, replicator) is not affected
 * by a stale flag.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LockHold {
    /** A request issued inside this hold has already timed out. */
    timedOut: boolean;
    /** The lock is still held. */
    active: boolean;
}

const holdStore = new AsyncLocalStorage<LockHold>();

/** The default ArcadeDB request timeout, shared with ArcadeHttp. */
export const DEFAULT_ARCADE_REQUEST_TIMEOUT_MS = 30_000;
/** Margin added to the request timeout for the lock-hold and lock-wait bounds. */
export const HOLD_MARGIN_MS = 5_000;

function positiveIntEnv(name: string): number | undefined {
    const n = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** ArcadeDB whole-request timeout (ms). Env `LORE_ARCADE_REQUEST_TIMEOUT_MS`; default 30000. */
export function requestTimeoutMs(): number {
    return positiveIntEnv('LORE_ARCADE_REQUEST_TIMEOUT_MS') ?? DEFAULT_ARCADE_REQUEST_TIMEOUT_MS;
}

/** How long a writer may wait for a held node lock before failing busy. Env `LORE_NODE_LOCK_WAIT_MS`; default request timeout + margin (one hung holder). */
export function nodeLockWaitMs(): number {
    return positiveIntEnv('LORE_NODE_LOCK_WAIT_MS') ?? requestTimeoutMs() + HOLD_MARGIN_MS;
}

/** The hold the caller is running inside, if it is still active. */
export function currentHold(): LockHold | undefined {
    const hold = holdStore.getStore();
    return hold && hold.active ? hold : undefined;
}

/** Run `fn` as one lock hold (reusing an enclosing active hold so nested helpers share one budget). */
export async function runInHold<T>(fn: () => Promise<T>): Promise<T> {
    if (currentHold()) return fn();
    const hold: LockHold = { timedOut: false, active: true };
    try {
        return await holdStore.run(hold, fn);
    } finally {
        hold.active = false;
    }
}

/** A fresh hold for a caller that needs several steps (an advisory pre-read, then the write) to share ONE budget. */
export function newHold(): LockHold {
    return { timedOut: false, active: true };
}

/** Run `fn` inside `hold` (see {@link newHold}); the caller sets `hold.active = false` when done. */
export function runWithHold<T>(hold: LockHold, fn: () => Promise<T>): Promise<T> {
    return holdStore.run(hold, fn);
}
