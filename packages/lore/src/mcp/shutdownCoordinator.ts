/**
 * shutdownCoordinator.ts — single shared graceful-shutdown entry point.
 *
 * SP-02: before this module the daemon had three independent exit paths
 * that all called `process.exit(0)` immediately, killing in-flight writes:
 *
 *   1. lifecycle.ts SIGINT/SIGTERM handler (fire-and-forget onShutdown)
 *   2. POST /api/workspaces/switch    (setTimeout(process.exit, 150))
 *   3. POST /api/daemon/restart       (setTimeout(process.exit, 150))
 *
 * Paths 2 + 3 live in HTTP route files that have no access to the
 * server.ts singletons (replicator, embed queue, sync poller, session
 * cache, sweeper, graph/vector handles). They could only `process.exit`.
 *
 * This module is the rendezvous point. server.ts registers ONE ordered
 * async drain via `registerDrain()`. Every exit path then calls
 * `requestShutdown(reason)`, which runs that drain (once, even if SIGINT
 * and SIGTERM race) under a hard timeout, then exits. The route handlers
 * send their HTTP response first, then call requestShutdown — same drain
 * the signal path uses.
 *
 * Deliberately tiny + dependency-free so both the lifecycle layer and the
 * leaf route files can import it without pulling in server.ts.
 */

/** The ordered drain registered by server.ts. Resolves once every
 *  in-flight write has flushed (or the caller gives up). */
export type DrainFn = (reason: string) => Promise<void>;

/** Injectable process.exit — overridden in tests to assert ordering
 *  without tearing down the test runner. */
export type ExitFn = (code: number) => void;

let registeredDrain: DrainFn | null = null;
let shuttingDown = false;
let inFlight: Promise<void> | null = null;
let exitFn: ExitFn = (code) => process.exit(code);

/** Hard ceiling on the drain. A wedged outbox or embed executor must
 *  never prevent the daemon from exiting (launchd relaunches it). */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Register the ordered drain. Called once from server.ts boot wiring.
 * The most recent registration wins (a workspace switch rebuilds the
 * singletons, so the drain closure must point at the live instances).
 */
export function registerDrain(fn: DrainFn): void {
    registeredDrain = fn;
}

/** Test seam: swap the exit function and reset internal latches. */
export function __setExitFnForTests(fn: ExitFn): void {
    exitFn = fn;
}

/** Test seam: clear the one-shot latches between cases. */
export function __resetForTests(): void {
    registeredDrain = null;
    shuttingDown = false;
    inFlight = null;
    exitFn = (code) => process.exit(code);
}

function timeoutMs(ms: number): Promise<'timeout'> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), ms);
        // Don't let the timeout itself keep the loop alive once the
        // drain has resolved — the race below already handles ordering.
        if (typeof t.unref === 'function') t.unref();
    });
}

/**
 * Run the registered drain (idempotent), then exit. Safe to call from
 * the SIGINT/SIGTERM handler AND from the /switch + /restart routes.
 *
 * - If a drain is already in flight, returns the same promise — both
 *   SIGINT and SIGTERM landing in the same tick drain exactly once.
 * - The drain is bounded by `timeoutMsCap`; a wedged drain still exits.
 * - `exitFn` is awaited-then-called so the caller can observe that the
 *   drain finished before exit (the test injects a no-op exit).
 */
export async function requestShutdown(
    reason: string,
    opts: { timeoutMsCap?: number } = {},
): Promise<void> {
    if (shuttingDown) {
        // Already draining — return the same promise so callers await
        // the single in-flight drain rather than starting a second.
        return inFlight ?? Promise.resolve();
    }
    shuttingDown = true;
    const cap = opts.timeoutMsCap ?? DEFAULT_TIMEOUT_MS;

    inFlight = (async () => {
        if (registeredDrain) {
            const outcome = await Promise.race([
                registeredDrain(reason).then(() => 'drained' as const),
                timeoutMs(cap),
            ]);
            if (outcome === 'timeout') {
                console.error(
                    `[Lore MCP] shutdown drain exceeded ${cap}ms (${reason}) — forcing exit`,
                );
            }
        }
        exitFn(0);
    })();

    return inFlight;
}
