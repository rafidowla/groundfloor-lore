#!/usr/bin/env tsx
/**
 * tw2b-embedded-no-global-handlers-unit.ts — TW-2b adversarial unit tests.
 *
 * Closes audit cluster EMBEDDED-GLOBAL-HANDLERS
 * (`err-embedded-installs-global-process-handlers` +
 * `conc-safetynet-process-handlers-violate-embedded-contract`).
 *
 * The defect: the native-pool safety net installs process-global
 * `process.on('uncaughtException')` / `process.on('unhandledRejection')`
 * handlers at pool construction with a hard SURVIVE policy (log + return,
 * never exit/rethrow). The pools are constructed during EMBEDDED
 * `createLore()`, so an embedding HOST silently inherits Lore's crash
 * suppression — and `dispose()` never removes it. A library must NEVER
 * attach process-global handlers to a process it does not own.
 *
 * The fix: the safety net is OPT-IN. Only a process Lore OWNS (the daemon
 * path) arms it; embedded `createLore()` never does. The install is
 * idempotent + reversible (a disposer that `process.off(...)`s exactly the
 * listeners Lore added).
 *
 * Two cases, each FAILS on base (swarm/integration-3) and PASSES on branch:
 *
 *   (a) EMBEDDED ADDS ZERO NET GLOBAL LISTENERS.
 *       Snapshot process.listeners('uncaughtException'/'unhandledRejection')
 *       counts → embedded createLore() → dispose() → re-snapshot. The counts
 *       are UNCHANGED (Lore added none in embedded mode, and removed any it
 *       touched). On base: embedded createLore() leaves +1 uncaughtException
 *       and +1 unhandledRejection listener that survive dispose().
 *
 *   (b) DAEMON (ownsProcess:true) STILL GETS THE SAFETY NET, REVERSIBLY.
 *       Arm the net (daemon path) → construct a native pool → exactly ONE
 *       uncaughtException + ONE unhandledRejection listener appear (daemon
 *       native-fault resilience, NW-1c, preserved) → run the disposer →
 *       both are removed, restoring the prior listener set.
 *
 * Harness: the tsx no-framework style used across test/ — manual pass/fail
 * counters + a trailing process.exit so a native-Kùzu teardown SIGSEGV after
 * the assertions can't flip a green run red.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// (b) is the same isolation discipline as TW-2a: no global LORE_HOME — the
// embedded instance is pinned via dataDir so a developer env can't mask the
// listener accounting.
delete process.env['LORE_HOME'];
delete process.env['LORE_GRAPH_PATH'];

// ── Global listener accounting ───────────────────────────────────────────────
function countListeners(): { uncaught: number; unhandled: number } {
    return {
        uncaught: process.listeners('uncaughtException').length,
        unhandled: process.listeners('unhandledRejection').length,
    };
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

// Dynamic imports AFTER the env scrub so module-eval sees the cleaned env.
const { createLore } = await import('../packages/lore/src/index.js');
const {
    armNativePoolSafetyNet,
    installNativePoolSafetyNet,
    disposeNativePoolSafetyNet,
    __disarmNativePoolSafetyNetForTests,
    __isNativePoolSafetyNetInstalledForTests,
} = await import('../packages/lore/src/engines/nativePoolSafetyNet.js');
const { LanceTablePool } = await import('../packages/lore/src/engines/lanceTablePool.js');

async function run(): Promise<void> {
    console.log('TW-2b — embedded must not install process-global crash handlers');

    // ────────────────────────────────────────────────────────────────────────
    // (a) EMBEDDED createLore() → dispose() leaves the host listener set EXACTLY
    //     as it was. Net Lore-added global listeners = ZERO.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n── (a) embedded createLore()+dispose() adds zero net global handlers ──');
    {
        // Start from the un-armed default — the embedded contract state (a
        // process Lore does not own). Embedded createLore() must NOT arm it.
        __disarmNativePoolSafetyNetForTests();

        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tw2b-a-'));
        const before = countListeners();

        const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });

        await check('(a) embedded createLore() added NO uncaughtException listener', () => {
            const now = countListeners();
            assert.equal(
                now.uncaught,
                before.uncaught,
                `embedded createLore() must add 0 uncaughtException listeners (before=${before.uncaught} now=${now.uncaught})`,
            );
        });
        await check('(a) embedded createLore() added NO unhandledRejection listener', () => {
            const now = countListeners();
            assert.equal(
                now.unhandled,
                before.unhandled,
                `embedded createLore() must add 0 unhandledRejection listeners (before=${before.unhandled} now=${now.unhandled})`,
            );
        });
        await check('(a) safety net reports NOT installed in embedded mode', () => {
            assert.equal(
                __isNativePoolSafetyNetInstalledForTests(),
                false,
                'embedded mode never arms the safety net, so nothing is installed',
            );
        });

        await lore.dispose('tw2b-a');

        await check('(a) AFTER dispose(): uncaughtException count UNCHANGED from before createLore()', () => {
            const after = countListeners();
            assert.equal(
                after.uncaught,
                before.uncaught,
                `host uncaughtException listener set must be restored (before=${before.uncaught} after=${after.uncaught})`,
            );
        });
        await check('(a) AFTER dispose(): unhandledRejection count UNCHANGED from before createLore()', () => {
            const after = countListeners();
            assert.equal(
                after.unhandled,
                before.unhandled,
                `host unhandledRejection listener set must be restored (before=${before.unhandled} after=${after.unhandled})`,
            );
        });
    }

    // ────────────────────────────────────────────────────────────────────────
    // (b) DAEMON path (ownsProcess:true) — the safety net IS installed (daemon
    //     resilience preserved) and is removed on shutdown via the disposer.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n── (b) daemon (ownsProcess:true) installs the net, removes it on shutdown ──');
    {
        // Clean slate, then arm for an owned process (what the daemon path does
        // before constructing the pools).
        __disarmNativePoolSafetyNetForTests();
        const before = countListeners();

        armNativePoolSafetyNet();

        // Construct a native pool with cast-stubs so no real native handle
        // is opened — construction is all we need to trigger the (now
        // armed) install. (Was KuzuConnectionPool; Lance is the surviving
        // pool whose constructor performs the armed install — Kùzu removal
        // Phase 3d, 2026-08-21.)
        const pool = new LanceTablePool({} as never, 'unused', 1);
        void pool;

        let disposer: () => void = disposeNativePoolSafetyNet;
        await check('(b) armed daemon path installs exactly ONE uncaughtException listener', () => {
            const now = countListeners();
            assert.equal(
                now.uncaught,
                before.uncaught + 1,
                `daemon must install one uncaughtException listener (before=${before.uncaught} now=${now.uncaught})`,
            );
            assert.equal(__isNativePoolSafetyNetInstalledForTests(), true, 'safety net reports installed');
            // A redundant install (second pool) is idempotent — still +1, and
            // returns the disposer we drive shutdown with.
            disposer = installNativePoolSafetyNet();
        });
        await check('(b) armed daemon path installs exactly ONE unhandledRejection listener', () => {
            const now = countListeners();
            assert.equal(
                now.unhandled,
                before.unhandled + 1,
                `daemon must install one unhandledRejection listener (before=${before.unhandled} now=${now.unhandled})`,
            );
        });
        await check('(b) second install is idempotent (still +1)', () => {
            const now = countListeners();
            assert.equal(now.uncaught, before.uncaught + 1, 'still exactly one uncaughtException after re-install');
        });

        // Shutdown — the disposer (and the dispose() drain wires the same call)
        // removes exactly Lore's listeners.
        disposer();

        await check('(b) AFTER shutdown: uncaughtException listener REMOVED', () => {
            const after = countListeners();
            assert.equal(
                after.uncaught,
                before.uncaught,
                `daemon shutdown must remove the safety-net uncaughtException listener (before=${before.uncaught} after=${after.uncaught})`,
            );
            assert.equal(__isNativePoolSafetyNetInstalledForTests(), false, 'safety net reports NOT installed after dispose');
        });
        await check('(b) AFTER shutdown: unhandledRejection listener REMOVED', () => {
            const after = countListeners();
            assert.equal(
                after.unhandled,
                before.unhandled,
                `daemon shutdown must remove the safety-net unhandledRejection listener (before=${before.unhandled} after=${after.unhandled})`,
            );
        });

        // Leave the global state un-armed so we don't pollute a shared process.
        __disarmNativePoolSafetyNetForTests();
    }

    // ────────────────────────────────────────────────────────────────────────
    // (c) IN-PROCESS HOST WITH A NON-'embedded' MODE — still adds zero global
    //     handlers. Regression for S9-EMBEDDED-ENV-SCRUB.
    //
    //     The original TW-2b fix gated the arm on `effectiveMode !== 'embedded'`,
    //     treating "not embedded" as a synonym for "Lore owns the process". It
    //     is not. `deploymentMode` selects SUBSTRATES; it says nothing about
    //     whose process this is. A host can legitimately construct an in-process
    //     instance with deploymentMode 'local' (same local Kùzu/LanceDB
    //     substrates, host-owned lifecycle) — and that call passed the mode
    //     check and armed a SURVIVE-policy handler pair in the HOST's process,
    //     silently suppressing every uncaught fault in an application Lore does
    //     not own. Exactly the defect (a) exists to prevent, reached by a
    //     different door.
    //
    //     Ownership is now the predicate: `opts.ownsProcess === true`, which
    //     only the daemon entry main() sets. Case (b) above proves the daemon
    //     still gets the net, so this is a tightening, not a removal.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n── (c) in-process host with deploymentMode:local adds zero global handlers ──');
    {
        __disarmNativePoolSafetyNetForTests();

        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tw2b-c-'));
        const before = countListeners();

        // No ownsProcess — a library consumer, exactly like (a), but with the
        // mode that used to slip past the gate.
        const lore = await createLore({ deploymentMode: 'local', dataDir: home });

        await check('(c) in-process local createLore() added NO uncaughtException listener', () => {
            const now = countListeners();
            assert.equal(
                now.uncaught,
                before.uncaught,
                `a host that did not claim ownership must keep its own crash handling ` +
                `(before=${before.uncaught} now=${now.uncaught})`,
            );
        });
        await check('(c) in-process local createLore() added NO unhandledRejection listener', () => {
            const now = countListeners();
            assert.equal(
                now.unhandled,
                before.unhandled,
                `a host that did not claim ownership must keep its own crash handling ` +
                `(before=${before.unhandled} now=${now.unhandled})`,
            );
        });
        await check('(c) safety net reports NOT installed for an unowned process in local mode', () => {
            assert.equal(
                __isNativePoolSafetyNetInstalledForTests(),
                false,
                'only ownsProcess:true arms the net — deploymentMode must not be able to',
            );
        });

        await lore.dispose('tw2b-c');
        __disarmNativePoolSafetyNetForTests();
    }

    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run()
    .then(() => {
        console.log('TW-2b PASSED — embedded adds no global handlers; daemon net installs+reverses ✓');
        // Explicit clean exit (harness style): a lingering native-Kùzu teardown
        // SIGSEGV after all assertions passed must not flip a green run red.
        process.exit(0);
    })
    .catch((err) => {
        console.error('TW-2b harness error:', err);
        process.exit(1);
    });
