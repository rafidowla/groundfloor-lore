#!/usr/bin/env tsx
/**
 * test/nw1c-safety-net-policy-unit.ts — NW-1c regression unit.
 *
 * Closes audit cluster HIGH-ERR-A (findings `conc-dual-safety-net-exit`
 * + `err-contradictory-uncaught-handlers`). Both findings describe the
 * same defect from different angles: Kùzu's pool installed a SURVIVE
 * uncaughtException listener while Lance's installed an EXIT listener.
 * Node fires every registered listener, the exit one wins, and the
 * documented daemon-resilience contract (SW-19 / E1b) is silently
 * defeated. (Kùzu's pool was deleted with the engine — Phase 3d,
 * 2026-08-21; the shared survive-policy net it forced into existence
 * remains and is what this pins, via the surviving Lance pool.)
 *
 * What this test pins down
 * ────────────────────────
 *  A. Idempotent install. Importing the pool module AND constructing
 *     pool instances installs exactly ONE `uncaughtException` listener
 *     on `process` (and exactly one `unhandledRejection` listener),
 *     however many pools are constructed.
 *
 *  B. Survive policy. When the shared listener is fired with a synthetic
 *     `uncaughtException`, it logs and RETURNS — `process.exit` is not
 *     called. On the base branch the Lance listener would call
 *     `process.exit(1)`.
 *
 * Why a child_process isn't used
 * ──────────────────────────────
 * A child_process would let us observe the real exit code, but the
 * goal is to verify the in-process contract: which listeners are
 * registered and what they do when invoked. We assert directly on
 * `process.listeners(...)` and call the listener with a spied
 * `process.exit`, which is faster and gives a clearer signal.
 */

import { strict as assert } from 'node:assert';

// Import the shared safety-net module first so we can manage its
// install-guard. The pool modules also import it; this just guarantees
// we have the reset hook available before construction.
import {
    installNativePoolSafetyNet,
    __resetNativePoolSafetyNetForTests,
    __isNativePoolSafetyNetInstalledForTests,
} from '../packages/lore/src/engines/nativePoolSafetyNet.js';

import { LanceTablePool } from '../packages/lore/src/engines/lanceTablePool.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/**
 * Snapshot + restore helpers for the global `process` listener set.
 * The daemon's other modules may have already installed listeners
 * (e.g. SIGTERM handlers from SP-02 graceful shutdown), and other unit
 * tests run before this one in the npm-test chain. We strip listeners
 * for the two events we care about, run the assertions, then reinstate.
 */
type Listener = (...args: unknown[]) => void;

function snapshotListeners(): { uncaught: Listener[]; unhandled: Listener[] } {
    return {
        uncaught: process.listeners('uncaughtException') as unknown as Listener[],
        unhandled: process.listeners('unhandledRejection') as unknown as Listener[],
    };
}

function clearListeners(): void {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
}

function restoreListeners(snap: { uncaught: Listener[]; unhandled: Listener[] }): void {
    clearListeners();
    for (const l of snap.uncaught) process.on('uncaughtException', l);
    for (const l of snap.unhandled) process.on('unhandledRejection', l);
}

async function run() {
    console.log('NW-1c · native pool safety-net policy');

    // ────────────────────────────────────────────────────────────────
    // A. Idempotent install — exactly ONE listener per event after BOTH
    //    pool modules construct an instance.
    // ────────────────────────────────────────────────────────────────
    await test('A1 · constructing Lance pools installs exactly ONE uncaughtException listener', async () => {
        const snap = snapshotListeners();
        clearListeners();
        __resetNativePoolSafetyNetForTests();
        try {
            assert.equal(__isNativePoolSafetyNetInstalledForTests(), false, 'precondition: not installed');

            // Construct a Lance pool. We pass cast-stubs because
            // the constructor only installs the safety net + reads
            // env/size; it does not touch the native binding until
            // initialize() is called.
            const lance = new LanceTablePool({} as never, 'unused', 1);
            assert.equal(process.listeners('uncaughtException').length, 1, 'one listener after Lance');
            assert.equal(process.listeners('unhandledRejection').length, 1, 'one rejection listener after Lance');

            // And a second — still one listener (shared install-guard).
            const lance2 = new LanceTablePool({} as never, 'unused2', 1);
            assert.equal(
                process.listeners('uncaughtException').length,
                1,
                'still one listener after second Lance pool (idempotent)',
            );
            assert.equal(
                process.listeners('unhandledRejection').length,
                1,
                'still one rejection listener after second Lance pool',
            );

            // Suppress unused warnings.
            void lance; void lance2;
        } finally {
            clearListeners();
            __resetNativePoolSafetyNetForTests();
            restoreListeners(snap);
        }
    });

    // ────────────────────────────────────────────────────────────────
    // B. Survive policy — invoking the installed listener with a
    //    synthetic Error logs and RETURNS. process.exit is never called.
    // ────────────────────────────────────────────────────────────────
    await test('B1 · uncaughtException listener does NOT call process.exit (survive policy)', async () => {
        const snap = snapshotListeners();
        clearListeners();
        __resetNativePoolSafetyNetForTests();

        const realExit = process.exit;
        let exitCalled = false;
        let exitCode: number | string | null | undefined = undefined;
        // Replace process.exit with a spy that throws if invoked —
        // catching the throw lets the test assert without the harness
        // actually terminating.
        (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
            exitCalled = true;
            exitCode = code ?? null;
            throw new Error('process.exit called with code=' + String(code));
        }) as never;

        try {
            installNativePoolSafetyNet();
            const listeners = process.listeners('uncaughtException');
            assert.equal(listeners.length, 1, 'one listener installed');

            // Fire the listener with a synthetic native-style fault.
            // The shared handler must log and return — it MUST NOT
            // touch process.exit.
            const synthetic = new Error('synthetic native fault from NW-1c test');
            try {
                (listeners[0] as (e: Error) => void)(synthetic);
            } catch (e) {
                // The only way this catches anything is if the listener
                // called the spied process.exit, which means the
                // survive-policy contract is violated.
                assert.fail(
                    'safety-net listener threw / called process.exit — survive policy violated: ' +
                        (e as Error).message,
                );
            }

            assert.equal(exitCalled, false, 'process.exit must NOT have been called');
            assert.equal(exitCode, undefined, 'no exit code captured');
        } finally {
            (process as unknown as { exit: typeof realExit }).exit = realExit;
            clearListeners();
            __resetNativePoolSafetyNetForTests();
            restoreListeners(snap);
        }
    });

    await test('B2 · unhandledRejection listener does NOT call process.exit (survive policy)', async () => {
        const snap = snapshotListeners();
        clearListeners();
        __resetNativePoolSafetyNetForTests();

        const realExit = process.exit;
        let exitCalled = false;
        (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
            exitCalled = true;
            throw new Error('process.exit called with code=' + String(code));
        }) as never;

        try {
            installNativePoolSafetyNet();
            const listeners = process.listeners('unhandledRejection');
            assert.equal(listeners.length, 1, 'one rejection listener installed');

            try {
                (listeners[0] as (r: unknown) => void)(new Error('synthetic rejection'));
            } catch (e) {
                assert.fail(
                    'unhandledRejection listener called process.exit — survive policy violated: ' +
                        (e as Error).message,
                );
            }
            assert.equal(exitCalled, false, 'process.exit must NOT have been called');
        } finally {
            (process as unknown as { exit: typeof realExit }).exit = realExit;
            clearListeners();
            __resetNativePoolSafetyNetForTests();
            restoreListeners(snap);
        }
    });

    // ────────────────────────────────────────────────────────────────
    // C. Idempotent direct install — calling the shared installer
    //    repeatedly is a no-op.
    // ────────────────────────────────────────────────────────────────
    await test('C1 · installNativePoolSafetyNet() is idempotent across N direct calls', async () => {
        const snap = snapshotListeners();
        clearListeners();
        __resetNativePoolSafetyNetForTests();
        try {
            for (let i = 0; i < 10; i++) installNativePoolSafetyNet();
            assert.equal(process.listeners('uncaughtException').length, 1, 'still one after 10 installs');
            assert.equal(process.listeners('unhandledRejection').length, 1, 'still one rejection after 10 installs');
        } finally {
            clearListeners();
            __resetNativePoolSafetyNetForTests();
            restoreListeners(snap);
        }
    });

    console.log(`\nNW-1c · ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch((err: Error) => {
    console.error('NW-1c · unhandled test runner error:', err);
    process.exit(1);
});
