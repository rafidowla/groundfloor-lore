#!/usr/bin/env tsx
/**
 * backup-lock-probe-unit.ts — `lore backup` and `lore maintain`'s
 * ephemeral-workspace delete must not rely on `isDaemonUp()` alone to decide
 * whether a workspace's graph store is safe to touch.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────
 *
 * `isDaemonUp()` probes one HTTP port (`LORE_PORT` env, default 3847). A
 * daemon running on a DIFFERENT port with `LORE_PORT` unset — or, as here,
 * ANY other process (not necessarily a daemon at all) holding the workspace's
 * SurrealDB directory lock — is invisible to it. Before this fix:
 *   - `lore backup` proceeded, `backupWorkspace()`'s own read-back attempt
 *     failed against the held lock after its ~2.5s open-budget, and the
 *     result — `graphNodeCount: null` plus a warning in the manifest — was
 *     never surfaced: the CLI printed nothing about it and exited 0.
 *   - `lore maintain`'s ephemeral-workspace expiry (CLI path, no live
 *     `LocalGraphRegistry` to close a handle through) went straight to
 *     `fs.rmSync` on the workspace directory regardless.
 *
 * `probeSurrealLock()` opens the store directly (no HTTP involved), so it
 * catches a holder that `isDaemonUp()` cannot see by construction — proven
 * here with a genuine second SurrealGraph handle left open in-process
 * (confirmed empirically to produce the same "another instance holding the
 * directory lock" failure `probeSurrealLock` reports for a truly separate
 * process, since surrealkv's lock is a real OS-level file lock).
 *
 * T1 — backup refuses (non-zero, lock message, no tarball) while the
 *      workspace's graph store is held and no daemon is running.
 * T2 — backup --force bypasses the lock preflight; backupWorkspace's own
 *      read-back then fails against the same holder, and the CLI turns that
 *      into a non-zero exit + a warning on stderr (not a silent success).
 * T3 — maintain's CLI-path workspace delete (`WorkspaceRegistry.delete()`
 *      with no `graphRegistry` wired) refuses/skips a held workspace instead
 *      of deleting its directory out from under the holder.
 *
 * Run: npx tsx test/backup-lock-probe-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    cases.push({ name, fn });
}

async function runAll(): Promise<void> {
    for (const c of cases) {
        try {
            await c.fn();
            passed++;
            console.log(`  ✓ ${c.name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? String(err)}`);
        }
    }
}

function captureConsole(): { restore: () => void; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg?: unknown) => { out.push(String(msg ?? '')); };
    console.error = (msg?: unknown) => { err.push(String(msg ?? '')); };
    return { restore: () => { console.log = origLog; console.error = origErr; }, out, err };
}

function captureExit(): { restore: () => void; readonly code: number | null } {
    const orig = process.exit;
    const tracker = { code: null as number | null };
    (process as unknown as { exit: (n?: number) => void }).exit = (n?: number) => {
        tracker.code = n ?? 0;
        throw new Error(`__test_exit_${tracker.code}`);
    };
    return {
        restore: () => { (process as unknown as { exit: typeof orig }).exit = orig; },
        get code() { return tracker.code; },
    };
}

console.log('backup / maintain-delete lock-probe preflight (isDaemonUp() alone is not enough)');

const priorHome = process.env['LORE_HOME'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-lock-probe-test-'));
process.env['LORE_HOME'] = root;

test('T1: lore backup refuses with a lock message, exits non-zero, writes no tarball, while the workspace store is held (no daemon)', async () => {
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const { backupCommand } = await import('../packages/lore/src/cli/commands/backup.js');

    const entry = createWorkspace('t1-locked', {}, root);
    // Seed real data, close cleanly.
    const seeder = new SurrealGraph(entry.path, { workspaceId: 't1-locked' });
    await seeder.initialize();
    await seeder.upsertNode({
        id: 'a1', type: 'note', label: 'a1', content: 'a1', tags: [], project: '*',
        ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);
    await seeder.close();

    // Hold the store open — genuinely locked, no HTTP daemon anywhere.
    const holder = new SurrealGraph(entry.path, { workspaceId: 't1-locked' });
    await holder.initialize();
    try {
        const outDir = path.join(root, 't1-out');
        fs.mkdirSync(outDir, { recursive: true });
        const cap = captureConsole();
        const exit = captureExit();
        let threw: Error | null = null;
        try {
            await backupCommand(['--workspace', 't1-locked', '--out', outDir]);
        } catch (err) {
            threw = err as Error;
        } finally {
            cap.restore();
            exit.restore();
        }
        assert.ok(threw, 'backupCommand must not return normally while the store is locked');
        assert.equal(exit.code, 1, 'must exit(1)');
        const stderrJoined = cap.err.join('\n');
        assert.match(stderrJoined, /locked by another process/i);
        assert.equal(
            fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.tar.gz')).length : 0,
            0,
            'no tarball must be written when the lock preflight refuses',
        );
    } finally {
        await holder.close();
    }
});

test('T2: lore backup --force bypasses the lock preflight, but an unreadable graph still exits non-zero with a warning on stderr', async () => {
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const { backupCommand } = await import('../packages/lore/src/cli/commands/backup.js');

    const entry = createWorkspace('t2-locked', {}, root);
    const seeder = new SurrealGraph(entry.path, { workspaceId: 't2-locked' });
    await seeder.initialize();
    await seeder.upsertNode({
        id: 'b1', type: 'note', label: 'b1', content: 'b1', tags: [], project: '*',
        ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);
    await seeder.close();

    const holder = new SurrealGraph(entry.path, { workspaceId: 't2-locked' });
    await holder.initialize();
    try {
        const outDir = path.join(root, 't2-out');
        fs.mkdirSync(outDir, { recursive: true });
        const cap = captureConsole();
        const exit = captureExit();
        let threw: Error | null = null;
        try {
            // --force bypasses BOTH isDaemonUp() and the new probeSurrealLock()
            // preflight — exactly the "isDaemonUp missed it" scenario, driven
            // deliberately here so backupWorkspace()'s own read-back attempt is
            // the thing that has to fail against the held lock.
            await backupCommand(['--workspace', 't2-locked', '--out', outDir, '--force']);
        } catch (err) {
            threw = err as Error;
        } finally {
            cap.restore();
            exit.restore();
        }
        assert.ok(threw, 'backupCommand must not report a silent success for an unverified graph');
        const stderrJoined = cap.err.join('\n');
        assert.match(stderrJoined, /NOT verified in this archive|UNCONFIRMED/i, `expected an unverified-graph warning in stderr, got:\n${stderrJoined}`);
        // The tarball IS still written — the other substrates may be fine —
        // this is a "don't call it a silent success", not "don't back up".
        const tarballs = fs.readdirSync(outDir).filter((f) => f.endsWith('.tar.gz'));
        assert.equal(tarballs.length, 1, 'the tarball is still produced despite the unverified graph');
    } finally {
        await holder.close();
    }
});

test('T3: maintain-delete (CLI path, no graphRegistry) refuses a held workspace instead of rmSync-ing it', async () => {
    const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');

    const entry = createWorkspace('t3-locked', {}, root);
    const seeder = new SurrealGraph(entry.path, { workspaceId: 't3-locked' });
    await seeder.initialize();
    await seeder.close();

    const holder = new SurrealGraph(entry.path, { workspaceId: 't3-locked' });
    await holder.initialize();
    try {
        const registry = new WorkspaceRegistry(); // CLI path: no graphRegistry wired
        await assert.rejects(
            () => registry.delete('t3-locked'),
            /locked by another process/i,
            'delete() must refuse a workspace whose graph store is held',
        );
        assert.ok(fs.existsSync(entry.path), 'the workspace directory must NOT have been rmSync-ed while held');
    } finally {
        await holder.close();
    }

    // Bonus: once released, the same delete() succeeds normally.
    const registry2 = new (await import('../packages/lore/src/engines/maintain/adapters.js')).WorkspaceRegistry();
    const result = await registry2.delete('t3-locked');
    assert.ok(result.bytesFreed >= 0);
    assert.ok(!fs.existsSync(entry.path), 'once released, delete() removes the workspace directory');
});

test('T4: backup surfaces a "did not settle" warning instead of silently discarding settleSurrealStore\'s timeout result', async () => {
    // `settleSurrealStore` reports `{settled:false, outcome:'timeout'}` for a
    // store that genuinely never stops changing within its budget (a slow
    // disk, or — as forced here — a directory some other writer keeps
    // touching). Every call site in engines/backup.ts used to discard that
    // result with a bare `await`; this proves the warning now reaches
    // `BackupResult.warnings`.
    const { backupWorkspace } = await import('../packages/lore/src/engines/backup.js');

    const wsDir = fs.mkdtempSync(path.join(root, 't4-neverquiesce-'));
    const loreDir = path.join(wsDir, '.lore');
    const surrealDir = path.join(loreDir, 'surreal');
    fs.mkdirSync(path.join(surrealDir, 'wal'), { recursive: true });
    fs.writeFileSync(path.join(surrealDir, 'LOCK'), '');
    const outDir = fs.mkdtempSync(path.join(root, 't4-out-'));

    // Keep rewriting the wal file forever — this directory NEVER settles,
    // same harness shape as the QA repro (t4-timeout-silence.ts).
    let stop = false;
    const walFile = path.join(surrealDir, 'wal', '00000000000000000000.wal');
    const iv = setInterval(() => {
        if (stop) return;
        try { fs.writeFileSync(walFile, `x${Date.now()}`); } catch { /* racing our own cleanup */ }
    }, 10);

    const envKeys = [
        'LORE_SURREAL_SETTLE_BUDGET_MS', 'LORE_SURREAL_SETTLE_POLL_MS', 'LORE_SURREAL_SETTLE_MIN_QUIET_MS',
        'LORE_SURREAL_OPEN_BUDGET_MS', 'LORE_SURREAL_OPEN_TIMEOUT_MS',
    ] as const;
    const prior = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    // Short budgets throughout: this is a fake (not a real surrealkv) store,
    // so the probe-open attempt inside backupWorkspace will also fail fast
    // rather than exhausting a multi-second default open budget against it.
    process.env['LORE_SURREAL_SETTLE_BUDGET_MS'] = '300';
    process.env['LORE_SURREAL_SETTLE_POLL_MS'] = '25';
    process.env['LORE_SURREAL_SETTLE_MIN_QUIET_MS'] = '50';
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = '500';
    process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = '250';
    try {
        const result = await backupWorkspace({ workspaceDir: wsDir, workspaceName: 't4-neverquiesce', outDir });
        assert.ok(
            result.warnings.some((w) => /did not settle within/.test(w)),
            `expected a "did not settle" warning in result.warnings, got: ${JSON.stringify(result.warnings)}`,
        );
    } finally {
        stop = true;
        clearInterval(iv);
        for (const k of envKeys) {
            if (prior[k] === undefined) delete process.env[k];
            else process.env[k] = prior[k];
        }
    }
});

test(
    'T5 (QA round 2): an unreadable (EACCES) store dir is neither "free" nor silently deleted — '
    + 'probeSurrealLock refuses it, and a delete() that fails leaves the registry entry intact',
    async () => {
        const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
        const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');
        const { probeSurrealLock } = await import('../packages/lore/src/engines/surreal/surrealSettle.js');
        const { surrealDataPath } = await import('../packages/lore/src/engines/surreal/surrealConnection.js');

        const entry = createWorkspace('t5-eacces', {}, root);
        const g = new SurrealGraph(entry.path, { workspaceId: 't5-eacces' });
        await g.initialize();
        await g.upsertNode({
            id: 'p1', type: 'note', label: 'p1', content: 'irreplaceable', tags: [], project: '*',
            ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never);
        await g.close();

        const surrealDir = surrealDataPath(entry.path);
        fs.chmodSync(surrealDir, 0o000);
        try {
            // Before this fix: an unlistable store dir came back from
            // `looksLikeSurrealStore` as `false` ("no store here"), which
            // `probeSurrealLock` then read as `free: true` — an unreadable,
            // possibly-held store reported as safe to touch.
            const lock = await probeSurrealLock(entry.path);
            assert.equal(lock.free, false, 'an unreadable store directory must never report as free');
            assert.match(lock.detail ?? '', /undeterminable/i, 'the detail must distinguish "cannot tell" from a genuine lock or a genuinely absent store');

            // Before this fix: WorkspaceRegistry.delete() removed the
            // registry entry BEFORE rmSync, so a failed physical delete left
            // an orphaned, untracked directory with the never-verified store
            // still on disk. It must now fail closed: registry entry stays.
            const registry = new WorkspaceRegistry();
            await assert.rejects(
                () => registry.delete('t5-eacces'),
                /undeterminable/i,
                'delete() must not succeed against a store it could not determine the lock state of',
            );
            const stillRegistered = loadWorkspaces().workspaces.some((w) => w.name === 't5-eacces');
            assert.ok(stillRegistered, 'the registry entry must remain when the physical delete could not proceed');
            assert.ok(fs.existsSync(entry.path), 'the workspace directory must remain on disk');
        } finally {
            fs.chmodSync(surrealDir, 0o700);
        }
    },
);

test(
    'T6 (QA round 3): a partial rmSync failure (some siblings removed before a permission-protected '
    + 'one throws) must never leave the REGISTERED path half-emptied, and a retry clears the sideline',
    async () => {
        // Round-3 QA (attack5-partial-rmsync.ts): `fs.rmSync({recursive:true,
        // force:true})` is not transactional — `force` only swallows a
        // missing-path error, not a permission error hit partway through the
        // recursive walk. Pre-fix, `WorkspaceRegistry.delete()` called
        // `rmSync` directly on the REGISTERED path: several sibling
        // files/dirs were removed before it reached a permission-protected
        // subdirectory and threw, leaving the still-registered path
        // half-emptied on disk — neither present nor gone, contradicting the
        // round-2 fix's own claim that a failed delete "leaves the workspace
        // exactly as it was". The fix renames the whole directory aside
        // atomically first, so the registered path is now either fully
        // intact (rename never happened) or wholly gone (rename succeeded) —
        // never half-emptied — and only the sideline copy can end up
        // partially deleted.
        const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');

        const workspacesDir = path.join(root, 'workspaces');
        const findSideline = (): string | undefined => {
            const match = fs.readdirSync(workspacesDir).find((e) => e.startsWith('.pending-delete-t6-partial-rmsync-'));
            return match ? path.join(workspacesDir, match) : undefined;
        };

        const entry = createWorkspace('t6-partial-rmsync', {}, root);
        fs.mkdirSync(path.join(entry.path, 'removable-a'), { recursive: true });
        fs.writeFileSync(path.join(entry.path, 'removable-a', 'file.txt'), 'a'.repeat(1000));
        fs.mkdirSync(path.join(entry.path, 'removable-b'), { recursive: true });
        fs.writeFileSync(path.join(entry.path, 'removable-b', 'file.txt'), 'b'.repeat(1000));
        fs.mkdirSync(path.join(entry.path, 'zzz-protected'), { recursive: true });
        fs.writeFileSync(path.join(entry.path, 'zzz-protected', 'inner.txt'), 'c'.repeat(1000));
        fs.chmodSync(path.join(entry.path, 'zzz-protected'), 0o555); // listable, not writable: unlink inside fails EACCES

        let sidelineProtectedDir: string | undefined;
        try {
            const registry = new WorkspaceRegistry(); // CLI path: no graphRegistry wired
            await assert.rejects(() => registry.delete('t6-partial-rmsync'));

            const stillRegistered = loadWorkspaces().workspaces.some((w) => w.name === 't6-partial-rmsync');
            assert.ok(stillRegistered, 'the registry entry must remain when the physical delete could not fully complete');

            // The core assertion: the REGISTERED path is either fully intact
            // or wholly gone — never half-emptied. It must NOT exist with
            // only some of its original children (the pre-fix failure mode).
            const registeredPathExists = fs.existsSync(entry.path);
            if (registeredPathExists) {
                assert.deepEqual(
                    fs.readdirSync(entry.path).sort(),
                    ['removable-a', 'removable-b', 'zzz-protected'],
                    'if the registered path still exists, ALL of its original children must still be there — not partially emptied',
                );
            }
            // With this fixture (rename always succeeds; only the sideline
            // rmSync can fail on the protected subdir), the registered path
            // is expected to be wholly gone, not merely "if present, intact".
            assert.equal(registeredPathExists, false, 'the registered path must be wholly gone once the atomic rename to a sideline succeeded');

            // The sideline copy — not the registered path — is where the
            // partial deletion is allowed to have happened.
            const sideline = findSideline();
            assert.ok(sideline, 'a sideline directory must exist for a later maintain pass to retry');
            sidelineProtectedDir = path.join(sideline!, 'zzz-protected');
            assert.ok(fs.existsSync(sidelineProtectedDir), 'the protected subdir (the reason rmSync failed) must survive inside the sideline');
            assert.ok(!fs.existsSync(path.join(sideline!, 'removable-a')), 'removable-a was already cleared out of the sideline by the failed rmSync pass');

            // A subsequent maintain pass retries the same name and finds the
            // leftover sideline directory rather than throwing ENOENT trying
            // to rename an already-vanished registered path.
            await assert.rejects(
                () => registry.delete('t6-partial-rmsync'),
                /cleanup is still incomplete/,
                'a retry must target the leftover sideline directory, not fail trying to re-rename a vanished path',
            );
            const stillRegisteredAfterRetry = loadWorkspaces().workspaces.some((w) => w.name === 't6-partial-rmsync');
            assert.ok(stillRegisteredAfterRetry, 'the registry entry must still remain after a retry that also cannot fully clear the sideline');
            assert.equal(findSideline(), sideline, 'the retry must reuse the SAME sideline directory, not create another one');
        } finally {
            if (sidelineProtectedDir) {
                try { fs.chmodSync(sidelineProtectedDir, 0o700); } catch { /* already cleared */ }
            }
        }

        // Once permissions are fixed, a further retry fully clears the
        // sideline and deregisters — nothing is stuck forever.
        const registry2 = new (await import('../packages/lore/src/engines/maintain/adapters.js')).WorkspaceRegistry();
        const result = await registry2.delete('t6-partial-rmsync');
        assert.ok(result.bytesFreed >= 0);
        assert.ok(!fs.existsSync(entry.path), 'the workspace directory is gone once cleanup is retried after permissions are fixed');
        assert.equal(findSideline(), undefined, 'the sideline directory is fully cleared once cleanup finally succeeds');
        const stillRegisteredFinal = loadWorkspaces().workspaces.some((w) => w.name === 't6-partial-rmsync');
        assert.ok(!stillRegisteredFinal, 'the registry entry is finally removed once the sideline is fully cleared');
    },
);

test(
    'T7 (QA round 4, finding 1): a workspace path that is a SYMLINK is refused — the link and its real '
    + 'target are both left completely untouched',
    async () => {
        const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');

        const entry = createWorkspace('t7-symlink', {}, root);
        const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t7-symlink-target-'));
        fs.mkdirSync(path.join(realTarget, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(realTarget, '.lore', 'real-data.txt'), 'irreplaceable'.repeat(50));
        // Replace the real registered dir with a symlink to a target elsewhere
        // (simulating an operator who symlinked a workspace onto a bigger disk).
        fs.rmSync(entry.path, { recursive: true, force: true });
        fs.symlinkSync(realTarget, entry.path, 'dir');

        try {
            const registry = new WorkspaceRegistry();
            await assert.rejects(
                () => registry.delete('t7-symlink'),
                /is a symlink/,
                'delete() must refuse a workspace whose registered path is a symlink, not rename/follow it',
            );
            const stillRegistered = loadWorkspaces().workspaces.some((w) => w.name === 't7-symlink');
            assert.ok(stillRegistered, 'the registry entry must remain untouched');
            let lstatOk = true;
            try { fs.lstatSync(entry.path); } catch { lstatOk = false; }
            assert.ok(lstatOk, 'the symlink itself must still exist at the registered path');
            assert.equal(fs.readlinkSync(entry.path), realTarget, 'the symlink must still point at the same real target, unmoved');
            assert.ok(
                fs.existsSync(path.join(realTarget, '.lore', 'real-data.txt')),
                'the REAL target directory\'s data must be completely untouched (never renamed, never rmSync-ed)',
            );
        } finally {
            fs.rmSync(realTarget, { recursive: true, force: true });
        }
    },
);

test(
    'T8 (QA round 4, finding 2): TWO leftover sidelines for the SAME workspace name are BOTH cleared '
    + 'before the workspace is deregistered',
    async () => {
        const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');

        const entry = createWorkspace('t8-twosideline', {}, root);
        const workspacesDir = path.join(root, 'workspaces');
        // Simulate two separate failed delete() attempts having each renamed
        // the (by-then-recreated) live path aside and left a sideline behind.
        fs.rmSync(entry.path, { recursive: true, force: true });
        const sideA = path.join(workspacesDir, `.pending-delete-t8-twosideline-${Date.now() - 50000}-aaaaaa`);
        const sideB = path.join(workspacesDir, `.pending-delete-t8-twosideline-${Date.now()}-bbbbbb`);
        fs.mkdirSync(sideA, { recursive: true });
        fs.writeFileSync(path.join(sideA, 'a.txt'), 'A'.repeat(1000));
        fs.mkdirSync(sideB, { recursive: true });
        fs.writeFileSync(path.join(sideB, 'b.txt'), 'B'.repeat(2000));

        const registry = new WorkspaceRegistry();
        const result = await registry.delete('t8-twosideline');
        assert.equal(result.bytesFreed, 3000, 'bytesFreed must sum BOTH leftover sidelines, not just the first match');
        assert.ok(!fs.existsSync(sideA), 'the older sideline must be cleared');
        assert.ok(!fs.existsSync(sideB), 'the newer sideline must ALSO be cleared — pre-fix, Array.find only cleared the first match and left this one orphaned forever');
        const stillRegistered = loadWorkspaces().workspaces.some((w) => w.name === 't8-twosideline');
        assert.ok(!stillRegistered, 'the registry entry is removed once every sideline is cleared');
    },
);

test(
    'T9 (QA round 4, finding 2): if ONE of two sidelines still fails to clear, the workspace must remain '
    + 'registered — never deregistered while a sideline for that name still exists',
    async () => {
        const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');

        const entry = createWorkspace('t9-twosideline-partial', {}, root);
        const workspacesDir = path.join(root, 'workspaces');
        fs.rmSync(entry.path, { recursive: true, force: true });
        const sideGood = path.join(workspacesDir, `.pending-delete-t9-twosideline-partial-${Date.now() - 50000}-cccccc`);
        const sideBad = path.join(workspacesDir, `.pending-delete-t9-twosideline-partial-${Date.now()}-dddddd`);
        fs.mkdirSync(sideGood, { recursive: true });
        fs.writeFileSync(path.join(sideGood, 'g.txt'), 'G'.repeat(500));
        fs.mkdirSync(sideBad, { recursive: true });
        fs.writeFileSync(path.join(sideBad, 'inner.txt'), 'x'.repeat(500));
        fs.chmodSync(sideBad, 0o000); // listable dir, unreadable/unremovable contents

        try {
            const registry = new WorkspaceRegistry();
            await assert.rejects(
                () => registry.delete('t9-twosideline-partial'),
                /cleanup is still incomplete/,
            );
            const stillRegistered = loadWorkspaces().workspaces.some((w) => w.name === 't9-twosideline-partial');
            assert.ok(stillRegistered, 'must remain registered while ANY sideline for the name is still uncleared');
            assert.ok(!fs.existsSync(sideGood), 'the clearable sideline is still cleared even though its sibling failed');
            assert.ok(fs.existsSync(sideBad), 'the unclearable sideline remains for a later maintain pass to retry');
        } finally {
            fs.chmodSync(sideBad, 0o700);
        }

        // Once permissions are fixed, a retry clears the remainder and deregisters.
        const registry2 = new (await import('../packages/lore/src/engines/maintain/adapters.js')).WorkspaceRegistry();
        const result = await registry2.delete('t9-twosideline-partial');
        assert.ok(result.bytesFreed >= 0);
        const stillRegisteredFinal = loadWorkspaces().workspaces.some((w) => w.name === 't9-twosideline-partial');
        assert.ok(!stillRegisteredFinal, 'deregistered once the last leftover sideline is finally cleared');
    },
);

test(
    'T10 (QA round 4, finding 1): a workspace directory that is itself a MOUNT POINT (a separate '
    + 'filesystem grafted onto the workspaces dir) is refused before any rename/rmSync — the mounted '
    + 'volume and its contents are left completely intact',
    async () => {
        const { execFileSync } = await import('node:child_process');
        const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');

        const entry = createWorkspace('t10-mountpoint', {}, root);
        const dmgPath = path.join(root, 't10-mountpoint.dmg');
        let mounted = false;
        try {
            execFileSync('hdiutil', ['create', '-size', '10m', '-fs', 'APFS', '-volname', 't10mount', dmgPath]);
            const realDmg = `${dmgPath}.dmg`.replace('.dmg.dmg', '.dmg');
            execFileSync('hdiutil', ['attach', realDmg, '-mountpoint', entry.path, '-nobrowse']);
            mounted = true;
        } catch (err) {
            // Round-4 QA preamble: "if you cannot create a mount in the test,
            // simulate via an injected stat/dev check seam and say so." This
            // host DOES support hdiutil (verified manually while building this
            // fix), so the real-mount path above is exercised whenever
            // possible; this branch only fires on a host without disk-image
            // support (e.g. non-macOS CI), and is a deliberate, logged skip —
            // not a silent pass. The guard itself (lstat + device-id compare
            // in WorkspaceRegistry.delete(), engines/maintain/adapters.ts) has
            // no separate injected-seam test: it is two direct fs.lstatSync /
            // fs.statSync calls compared by `.dev`, already exercised for
            // real above on any host where this branch does not trigger.
            console.log(`    (SKIPPED: no disk-image support on this host — ${(err as Error).message.slice(0, 150)})`);
            return;
        }
        try {
            const stRoot = fs.statSync(root);
            const stWs = fs.statSync(entry.path);
            if (stRoot.dev === stWs.dev) {
                console.log('    (SKIPPED: mount did not land on a distinct device on this host)');
                return;
            }
            fs.mkdirSync(path.join(entry.path, '.lore'), { recursive: true });
            fs.writeFileSync(path.join(entry.path, '.lore', 'onvolume.txt'), 'irreplaceable'.repeat(20));

            const registry = new WorkspaceRegistry();
            await assert.rejects(
                () => registry.delete('t10-mountpoint'),
                /is a mount point/,
                'delete() must refuse a workspace directory that is a mount point, before ever renaming it',
            );
            const stillRegistered = loadWorkspaces().workspaces.some((w) => w.name === 't10-mountpoint');
            assert.ok(stillRegistered, 'the registry entry must remain');
            assert.ok(
                fs.existsSync(path.join(entry.path, '.lore', 'onvolume.txt')),
                'the mounted volume\'s data must be completely untouched — pre-fix, the rename moved the mount and the ' +
                'following rmSync destroyed its contents',
            );
            const workspacesDir = path.join(root, 'workspaces');
            const strays = fs.readdirSync(workspacesDir).filter((e) => e.startsWith('.pending-delete-t10-mountpoint-'));
            assert.equal(strays.length, 0, 'no sideline must be created — the rename step must never be attempted for a mount point');
        } finally {
            if (mounted) {
                try {
                    execFileSync('hdiutil', ['detach', entry.path, '-force']);
                } catch {
                    // The mount point path itself may no longer resolve as a
                    // mount (only possible pre-fix, where the rename moves
                    // it) — fall back to finding the device by image path.
                    try {
                        const info = execFileSync('hdiutil', ['info'], { encoding: 'utf-8' });
                        const blocks = info.split(/\n(?=\/dev\/disk)/);
                        for (const b of blocks) {
                            if (b.includes(dmgPath)) {
                                const m = b.match(/^(\/dev\/disk\d+)\b/m);
                                if (m) { try { execFileSync('hdiutil', ['detach', m[1], '-force']); } catch { /* already gone */ } }
                            }
                        }
                    } catch { /* best effort cleanup only */ }
                }
            }
        }
    },
);

await runAll();
if (priorHome === undefined) delete process.env['LORE_HOME'];
else process.env['LORE_HOME'] = priorHome;
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
