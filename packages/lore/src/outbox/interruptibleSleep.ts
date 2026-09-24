/**
 * outbox/interruptibleSleep.ts — the outbox replicator's between-tick nap,
 * extracted from replicator.ts (2026-09-18) so the file-size guardrail's
 * baseline there stays put.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The nap is UNREF'D so an idle replicator cannot hold an embedding host's
 * loop open — referenced, it hung any teardown that missed stop(),
 * invisibly (`_getActiveHandles()` reports no timers). Work in flight holds
 * its own handles. See test/embedded-abandoned-dispose-exit-unit.ts.
 *
 * An unref'd timer only fires on its own schedule if the event loop has
 * some OTHER reason to keep spinning until then. That held by accident:
 * with SurrealGraph as the boot graph, its own open native handle
 * (`@surrealdb/node`) kept the loop alive through dispose()'s drain, so the
 * nap's timer always got a chance to fire before `OutboxReplicator.stop()`'s
 * `await loopPromise` needed it to. SqliteGraph (better-sqlite3) opens no
 * such handle, so once it is the boot graph and dispose() has closed
 * everything else by drain step 4, NOTHING is left to pump the loop — the
 * unref'd timer never fires and stop() hangs forever (observed as Node's
 * "Detected unsettled top-level await", exit code 13, in
 * test/schema-approve-embedded-unit.ts once pr/3.21.0-03 made sqlite the
 * default boot graph).
 *
 * The fix keeps the timer unref'd (an abandoned/never-stopped replicator
 * must still hold no handle of its own) but additionally races it against
 * a `StopSignal`, which `stop()` resolves directly — so stop() wakes its
 * own nap immediately instead of depending on an unrelated substrate handle
 * to keep the loop alive long enough for the timer to fire. See
 * test/embedded-sqlite-dispose-settles-unit.ts for the regression pin.
 */

/** Resolvable signal — `OutboxReplicator.stop()` calls `.resolve()` to
 *  interrupt an in-flight `interruptibleSleep()` immediately rather than
 *  waiting on its unref'd timer. */
export interface StopSignal {
    promise: Promise<void>;
    resolve: () => void;
}

export function makeStopSignal(): StopSignal {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

/** Sleeps `ms`, unref'd (see module doc), but resolves immediately if
 *  `stopSignal` settles first. */
export function interruptibleSleep(ms: number, stopSignal?: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
        if (stopSignal) {
            stopSignal.then(() => {
                clearTimeout(timer);
                resolve();
            });
        }
    });
}
