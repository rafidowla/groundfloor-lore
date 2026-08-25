/**
 * nativePoolSafetyNet.ts — single shared process-level safety net for the
 * native (Kùzu + LanceDB) pools.
 *
 * Policy: SURVIVE.
 * ─────────────────
 * Both native pools front NAPI bindings whose misuses can escape normal
 * try/catch (e.g. an async callback firing after a handle is mid-close).
 * The Round-1 daemon-resilience contract (SW-19 / E1b) is explicit: the
 * Lore daemon must NOT exit on a recoverable native fault. Killing the
 * process on every `uncaughtException` tears down all in-flight requests
 * + the MCP socket, which is exactly the failure mode SW-19 was designed
 * to prevent.
 *
 * Why this module exists (NW-1c — audit cluster HIGH-ERR-A)
 * ─────────────────────────────────────────────────────────
 * Before this module the two pools each installed their OWN
 * `process.on('uncaughtException', …)` listener. Kùzu's logged and
 * returned (survive). Lance's logged and called `process.exit(1)`. Node
 * fires every registered listener for the event, so on a single native
 * fault BOTH ran — and the one that calls `process.exit` wins. Net
 * effect: the documented survive-policy was silently defeated, and the
 * daemon would die on any uncaught native escape. Findings
 * `conc-dual-safety-net-exit` + `err-contradictory-uncaught-handlers`
 * are two views of the same bug; this module collapses both pools onto
 * one listener that follows the survive policy.
 *
 * Contract (TW-2b — opt-in for process owners only)
 * ──────────────────────────────────────────────────
 *  - The safety net is OPT-IN. `installNativePoolSafetyNet()` is a
 *    NO-OP unless the process owner has explicitly armed it via
 *    `armNativePoolSafetyNet()`. A library embedded in a host it does
 *    NOT own (embedded `createLore()`) never arms it, so it never
 *    attaches process-global handlers to the host's process — the host
 *    keeps its crash semantics exactly as its authors intended.
 *  - The DAEMON (and any local/cloud instance the daemon `main()` boots)
 *    arms it before constructing the pools, so daemon native-fault
 *    resilience (SW-19 / NW-1c) is fully preserved.
 *  - When armed, `installNativePoolSafetyNet()` is idempotent: many pool
 *    instances in the same process register exactly one pair of
 *    listeners (uncaughtException + unhandledRejection).
 *  - Both handlers log via the structured logger (stderr, level=error)
 *    and RETURN. They do NOT call `process.exit`. They do NOT throw.
 *  - Install is reversible: `disposeNativePoolSafetyNet()` calls
 *    `process.off(...)` on exactly the listeners Lore added, leaving the
 *    host's listener set byte-for-byte as it was. Embedded teardown /
 *    `dispose()` calls it (a no-op when nothing was installed).
 *  - Other subsystems that want exit-on-uncaught semantics can install
 *    their own listener first — Node fires all listeners, but since
 *    this one never exits it never overrides another listener's
 *    policy. (See "scope" note below.)
 *
 * Scope
 * ─────
 * The listener cannot reliably filter for "is this fault from kuzu vs
 * lance vs unrelated code" — that signal is not stable across native
 * bindings. The cost is logging unrelated escapes we'd otherwise have
 * crashed on; the benefit is the daemon survives a native-pool
 * anomaly. This is the same tradeoff the original Kùzu safety net
 * already documented. Because it suppresses ALL uncaught faults
 * process-wide, it is precisely the behavior a non-owning embedder must
 * never inherit — hence the opt-in gate.
 */

import { log } from '../logger.js';

/**
 * Process-ownership gate (TW-2b). Defaults to FALSE so the safety net is
 * inert for any embedded/library consumer. The daemon path arms it via
 * `armNativePoolSafetyNet()` before the pools are constructed; embedded
 * `createLore()` never does.
 */
let ownsProcess = false;

/**
 * Module-level guard. Both pool constructors call
 * `installNativePoolSafetyNet()` unconditionally; this flag ensures
 * only one pair of listeners is ever registered, regardless of how
 * many pool instances exist (tests typically construct several).
 */
let safetyNetInstalled = false;

/**
 * The exact handler references Lore registered, retained so
 * `disposeNativePoolSafetyNet()` can `process.off(...)` them precisely —
 * never an anonymous re-bind, which would not match and would leak.
 */
let uncaughtHandler: ((err: unknown) => void) | null = null;
let unhandledRejectionHandler: ((reason: unknown) => void) | null = null;

/**
 * Arm the safety net for a process Lore owns (the daemon, or a local/
 * cloud instance booted by the daemon `main()`). Idempotent. MUST be
 * called BEFORE the native pools are constructed; otherwise the install
 * calls in their constructors no-op and the daemon loses native-fault
 * resilience. Embedded `createLore()` must NOT call this.
 */
export function armNativePoolSafetyNet(): void {
    ownsProcess = true;
}

/**
 * Install the shared survive-policy listeners exactly once per process —
 * but ONLY when the process owner has armed the net. Safe to call from
 * every native-pool constructor: in embedded mode (un-armed) it is a
 * no-op and registers nothing on the host process. Returns a disposer
 * that removes whatever this module installed (idempotent; safe even
 * when nothing was installed).
 */
export function installNativePoolSafetyNet(): () => void {
    // OPT-IN gate — embedded/library consumers never armed the net, so
    // Lore attaches NO process-global handlers to a host it doesn't own.
    if (!ownsProcess) return disposeNativePoolSafetyNet;
    if (safetyNetInstalled) return disposeNativePoolSafetyNet;
    safetyNetInstalled = true;

    uncaughtHandler = (err: unknown) => {
        try {
            const stack = (err as Error)?.stack ?? String(err);
            log.error(`[NativePool safety-net] uncaughtException survived: ${stack}`);
        } catch {
            // best-effort logging only; never throw from a handler.
        }
        // SURVIVE — do not exit. See module header.
    };
    process.on('uncaughtException', uncaughtHandler as (err: Error) => void);

    unhandledRejectionHandler = (reason: unknown) => {
        try {
            const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
            log.error(`[NativePool safety-net] unhandledRejection survived: ${msg}`);
        } catch {
            // best-effort logging only; never throw from a handler.
        }
        // SURVIVE — do not exit.
    };
    process.on('unhandledRejection', unhandledRejectionHandler as (reason: unknown) => void);

    return disposeNativePoolSafetyNet;
}

/**
 * Remove exactly the listeners Lore installed, restoring the host's
 * listener set to what it was before. Idempotent and safe to call when
 * nothing was installed (the common embedded case). Does NOT clear the
 * `ownsProcess` arm — the daemon can re-install on a fresh pool if it
 * rebuilds substrates within the same owned process.
 */
export function disposeNativePoolSafetyNet(): void {
    if (uncaughtHandler) {
        process.off('uncaughtException', uncaughtHandler as (err: Error) => void);
        uncaughtHandler = null;
    }
    if (unhandledRejectionHandler) {
        process.off('unhandledRejection', unhandledRejectionHandler as (reason: unknown) => void);
        unhandledRejectionHandler = null;
    }
    safetyNetInstalled = false;
}

/**
 * Test-only: reset the install guard to a clean slate AND arm the net,
 * so the legacy direct-construction safety-net tests (NW-1c) — which
 * construct pools in isolation and assert the listener IS installed —
 * keep their pre-TW-2b semantics without each having to arm explicitly.
 * Removes any listeners Lore left behind first. Production code must not
 * call this.
 *
 * For the embedded opt-in path use `__disarmNativePoolSafetyNetForTests()`
 * instead (resets to the un-armed default the embedded contract relies on).
 */
export function __resetNativePoolSafetyNetForTests(): void {
    disposeNativePoolSafetyNet();
    ownsProcess = true;
}

/**
 * Test-only: reset to the UN-ARMED default (the embedded contract state:
 * a process Lore does not own). After this, `installNativePoolSafetyNet()`
 * is a no-op. Removes any listeners Lore left behind. Production code must
 * not call this.
 */
export function __disarmNativePoolSafetyNetForTests(): void {
    disposeNativePoolSafetyNet();
    ownsProcess = false;
}

/** Test-only: inspect whether the safety net is installed. */
export function __isNativePoolSafetyNetInstalledForTests(): boolean {
    return safetyNetInstalled;
}
