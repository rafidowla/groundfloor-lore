/**
 * verbatimRetiredRetry.ts - transparent retry of a write rejected with `VerbatimStoreRetiredError`.
 *
 * 3.35.3. A write parked behind the promotion write barrier when the promotion COMMITS is rejected
 * (verbatimWriteBarrier.ts) because the SQLite file it was about to write to has just been renamed
 * away. Nothing was applied. The write belongs on the promoted (LanceDB) store, which the workspace
 * resolver swaps in a moment later (`WorkspaceVerbatimResolver.swapToLance`). Callers must not see
 * that error for a window this short, so SqliteVerbatimStore calls {@link forwardToSuccessor} from
 * each of its eight write methods: it re-resolves the workspace's CURRENT store through the
 * resolver-supplied `resolveSuccessor` and replays the same call there. One helper, one place, so
 * every caller (outbox replay, MCP/REST handlers, bulk ingest, retention, CLI) and every stale
 * reference to the retired instance is covered without per-caller copies.
 *
 * Idempotence: the error is only ever thrown by `withWriteBarrier` BEFORE the write function runs
 * (verbatimWriteBarrier.ts: `throw` sits ahead of `s.inflight++` / `fn()`), so the original attempt
 * applied nothing and the replay cannot double-apply. `VerbatimStoreRetiredError.applied` is the
 * explicit marker for that contract; the helper refuses to replay an error that does not carry it.
 *
 * Bounded: a few attempts with backoff, total {@link retiredRetryConfig}.budgetMs (default 5 s).
 * The replay only ever runs on a store that is NOT the retired instance - a still-stale resolver
 * (swap not done yet, swap failed, or the boot store, which never swaps) is waited out and then the
 * original error is surfaced, because writing to the retired instance would silently lose the write.
 * A resolver SEALED at shutdown (VerbatimResolverSealedError) is the exception: it fails fast with that error.
 */
import { VerbatimStoreRetiredError } from './verbatimWriteBarrier.js';
import { isVerbatimResolverSealedError } from './verbatimStoreClosedError.js';

/** Test seam; production uses the defaults. */
export const retiredRetryConfig = {
    /** Total time a retired write waits for the promoted store before the error is surfaced. */
    budgetMs: 5000,
    /** First backoff; doubles per attempt up to `maxBackoffMs`. */
    initialBackoffMs: 25,
    maxBackoffMs: 500,
};

export type ResolveSuccessor = () => Promise<object | undefined> | object | undefined;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Replay `method(...args)` on the workspace's current store after `err` (a parked write rejected at
 * promotion commit). Throws `err` itself when no promoted store appears within the budget.
 */
export async function forwardToSuccessor<T>(
    self: object,
    resolveSuccessor: ResolveSuccessor | undefined,
    err: unknown,
    method: string,
    args: unknown[],
): Promise<T> {
    if (!(err instanceof VerbatimStoreRetiredError) || err.applied !== false || !resolveSuccessor) throw err;
    const deadline = Date.now() + retiredRetryConfig.budgetMs;
    let backoff = retiredRetryConfig.initialBackoffMs;
    for (;;) {
        let successor: object | undefined;
        try { successor = await resolveSuccessor(); } catch (e) {
            // The resolver was sealed at shutdown: no successor will ever appear, and waiting out the budget would
            // only hold shutdown up. Fail now with the typed error (nothing was applied; the outbox replays later).
            if (isVerbatimResolverSealedError(e)) throw e;
            successor = undefined; // not resolvable yet: keep waiting
        }
        if (successor && successor !== self) {
            const fn = (successor as Record<string, unknown>)[method];
            if (typeof fn !== 'function') throw err; // the promoted store cannot take this write
            try {
                return await (fn as (...a: unknown[]) => Promise<T>).apply(successor, args);
            } catch (e) {
                if (!(e instanceof VerbatimStoreRetiredError)) throw e; // a real failure of the replay: surface it
                // The resolver handed back another store that was itself retired; wait for its successor.
            }
        }
        const left = deadline - Date.now();
        if (left <= 0) throw err;
        await sleep(Math.min(backoff, left));
        backoff = Math.min(backoff * 2, retiredRetryConfig.maxBackoffMs);
    }
}
