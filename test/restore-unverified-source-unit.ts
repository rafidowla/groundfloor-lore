#!/usr/bin/env tsx
/**
 * restore-unverified-source-unit.ts — an archive whose graph was never
 * confirmed readable at backup time must not restore silently, and must
 * never be reported the same way as a harmless pre-field-existing archive.
 *
 * ── THE BUG (full chain, QA repro t10-full-chain.ts) ────────────────────────
 *
 * `lore backup` under a lock holder (no daemon, `isDaemonUp()` blind to it —
 * see backup-lock-probe-unit.ts) still writes a tarball, with
 * `graphNodeCount: null` because the source graph could never be read back.
 * Pre-fix, `restoreWorkspace` propagated that null straight through to
 * `expectedGraphNodeCount`, and `cli/commands/restore.ts` printed:
 *
 *     Graph verified: N node(s) readable (archive predates the recorded count)
 *
 * — the EXACT SAME message a genuinely old, pre-3.17 archive gets, even
 * though this archive's graph was never checked at all and may be empty or
 * torn. An operator reading that line has no way to tell "nothing was ever
 * recorded here" (benign) from "recording was attempted and failed"
 * (alarming) — and the restore proceeded either way.
 *
 * The fix adds `graphNodeCountReason` to the manifest (see
 * `GraphVerificationReason` in engines/backup.ts) so restore can tell the two
 * apart: 'unreadable' refuses the restore outright unless
 * `allowUnverifiedSource` (CLI: `--allow-unverified`) is passed, and even
 * then the CLI prints a distinctly alarming line, never the "predates the
 * recorded count" one.
 *
 * T1 — backup under a holder produces graphNodeCountReason: 'unreadable'.
 * T2 — restoring that archive (default) is REFUSED before touching the
 *      destination — no engine mismatch, no sideline, nothing on disk moves.
 * T3 — restoring with allowUnverifiedSource:true proceeds, and the result
 *      distinguishes 'unreadable' from a genuinely pre-field archive (manifest
 *      with no graphNodeCountReason at all).
 * T4 — the CLI (`restoreCommand`) prints the alarming line for the
 *      'unreadable' case and never the "archive predates" line for it.
 *
 * Run: npx tsx test/restore-unverified-source-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

// Runs immediately (not queued) — T1-T4 share state (a holder process opened
// before T1 and closed right after it, `tarballPath` produced by T1) that
// depends on each `test()` call actually executing in order as it is awaited,
// not being deferred to a later batch run.
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
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

console.log('restore refuses / clearly flags an archive whose graph was never confirmed readable at backup time');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-unverified-restore-test-'));

// ── shared fixture: back up a workspace while a holder locks its store ─────
const { backupWorkspace } = await import('../packages/lore/src/engines/backup.js');
const { restoreWorkspace } = await import('../packages/lore/src/engines/restore.js');
const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');

const srcDir = path.join(root, 'src-ws');
const outDir = path.join(root, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(srcDir, '.lore'), { recursive: true });
{
    const seeder = new SurrealGraph(srcDir, { workspaceId: 'chain' });
    await seeder.initialize();
    for (const id of ['a1', 'a2', 'a3']) {
        await seeder.upsertNode({
            id, type: 'note', label: id, content: id, tags: [], project: '*',
            ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never);
    }
    await seeder.close();
}
const holder = new SurrealGraph(srcDir, { workspaceId: 'chain' });
await holder.initialize();
let tarballPath = '';
await test('T1: backup under a holder produces graphNodeCountReason "unreadable" (fixture setup)', async () => {
    const result = await backupWorkspace({ workspaceDir: srcDir, workspaceName: 'chain', outDir });
    tarballPath = result.tarballPath;
    assert.equal(result.graphNodeCount, null);
    assert.equal(result.graphNodeCountReason, 'unreadable');
    assert.ok(result.warnings.length > 0);
});
await holder.close();

await test('T2: restoring the unverified archive is refused by default, before touching the destination', async () => {
    const destDir = path.join(root, 'dest-refused');
    fs.mkdirSync(destDir, { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath, workspaceDir: destDir, expectedEngine: 'surreal' }),
        /NEVER CONFIRMED READABLE/,
    );
    // Nothing should have been sidelined or moved — the destination is untouched.
    assert.ok(!fs.existsSync(path.join(destDir, '.lore')), 'restore must refuse BEFORE staging anything into the destination');
});

await test('T3: restoring with allowUnverifiedSource:true proceeds and reports the reason distinctly from a pre-field archive', async () => {
    const destDir = path.join(root, 'dest-allowed');
    fs.mkdirSync(destDir, { recursive: true });
    const result = await restoreWorkspace({
        tarballPath, workspaceDir: destDir, expectedEngine: 'surreal', allowUnverifiedSource: true,
    });
    assert.equal(result.expectedGraphNodeCount, null);
    assert.equal(result.expectedGraphNodeCountReason, 'unreadable');

    // A genuinely pre-field archive (no graphNodeCountReason key at all) must
    // report `undefined`, not accidentally collapse onto 'unreadable' —
    // simulate one by stripping the field from a copy of the manifest inside
    // a hand-built tarball is overkill here; the manifest-parsing contract
    // (`manifest.graphNodeCountReason` — optional, absent on old archives) is
    // what `expectedGraphNodeCountReason` is typed as
    // `GraphVerificationReason | undefined` for. Directly assert the type
    // distinction the CLI depends on:
    assert.notEqual(result.expectedGraphNodeCountReason, undefined, "this archive DOES carry the field — it's the 'unreadable' case, not the pre-field case");
});

await test('T4: the CLI prints the alarming line for an unverified source, never the "archive predates" line', async () => {
    const priorHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = root;
    try {
        const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
        createWorkspace('cli-dest', {}, root);

        const { restoreCommand } = await import('../packages/lore/src/cli/commands/restore.js');
        const cap = captureConsole();
        const exit = captureExit();
        try {
            // --allow-name-mismatch: this fixture backs up workspace 'chain'
            // and restores into 'cli-dest' — a deliberate naming mismatch
            // that predates (and is unrelated to) the X-restorename
            // workspace-name guard this flag now satisfies; this test is
            // about the unverified-source CLI message, not workspace names.
            await restoreCommand([tarballPath, '--workspace', 'cli-dest', '--allow-unverified', '--allow-name-mismatch']);
        } finally {
            cap.restore();
            exit.restore();
        }
        const joined = cap.out.join('\n');
        assert.match(joined, /UNVERIFIED SOURCE/, `expected the alarming line, got:\n${joined}`);
        assert.doesNotMatch(joined, /archive predates the recorded count/, 'must never use the benign pre-field message for an unreadable-source archive');
    } finally {
        if (priorHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorHome;
    }
});

await test('T5 (QA round 2): a manifest whose graphNodeCountReason is an unrecognized string is also refused, not just the literal "unreadable"', async () => {
    // Round-2 QA found that the refusal check was `=== 'unreadable'` only —
    // any OTHER value (corrupt manifest, a future schema's new reason, a
    // typo) sailed through unrefused, identical to a clean 'verified'
    // archive, even though graphNodeCount is null and nothing was verified.
    const { spawn } = await import('node:child_process');
    const tarExtract = (tb: string, dest: string) => new Promise<void>((resolve, reject) => {
        const p = spawn('tar', ['-x', '-z', '-f', tb, '-C', dest]);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    });
    const tarCreate = (tb: string, cwd: string) => new Promise<void>((resolve, reject) => {
        const p = spawn('tar', ['-c', '-z', '-f', tb, '-C', cwd, '.']);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    });

    // A CLEAN (verified) backup as the base, so this test isolates the
    // reason-string check from the "was the backup itself unreadable" path
    // T1-T4 above already cover.
    const cleanSrc = path.join(root, 'clean-src');
    fs.mkdirSync(path.join(cleanSrc, '.lore'), { recursive: true });
    {
        const g = new SurrealGraph(cleanSrc, { workspaceId: 'clean' });
        await g.initialize();
        await g.upsertNode({
            id: 'c1', type: 'note', label: 'c1', content: 'c1', tags: [], project: '*',
            ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never);
        await g.close();
    }
    const cleanBackup = await backupWorkspace({ workspaceDir: cleanSrc, workspaceName: 'clean', outDir });
    assert.equal(cleanBackup.graphNodeCountReason, 'verified', 'fixture setup: this backup must be a clean, verified one');

    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t5-stage-'));
    await tarExtract(cleanBackup.tarballPath, stage);
    const manifestPath = path.join(stage, 'backup-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.graphNodeCountReason = 'totally-bogus-future-schema-value';
    manifest.graphNodeCount = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const garbageTarball = path.join(root, 'garbage-reason.tar.gz');
    await tarCreate(garbageTarball, stage);

    const destDir = path.join(root, 'dest-garbage-reason');
    fs.mkdirSync(destDir, { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath: garbageTarball, workspaceDir: destDir, expectedEngine: 'surreal' }),
        /NEVER CONFIRMED READABLE/,
        'an unrecognized graphNodeCountReason must be refused exactly like "unreadable", not treated as safe',
    );
    assert.ok(!fs.existsSync(path.join(destDir, '.lore')), 'restore must refuse BEFORE staging anything into the destination');

    // allowUnverifiedSource still opens the escape hatch for this case, same
    // as for the literal 'unreadable' value.
    const destAllowed = path.join(root, 'dest-garbage-reason-allowed');
    fs.mkdirSync(destAllowed, { recursive: true });
    const allowed = await restoreWorkspace({
        tarballPath: garbageTarball, workspaceDir: destAllowed, expectedEngine: 'surreal', allowUnverifiedSource: true,
    });
    assert.equal(allowed.expectedGraphNodeCountReason, 'totally-bogus-future-schema-value');

    fs.rmSync(stage, { recursive: true, force: true });
});

await test(
    'T6 (QA round 3): graphNodeCountReason "verified" with a null graphNodeCount is internally '
    + 'inconsistent and must be refused, not waved through the allowlist',
    async () => {
        // Round-3 QA (attack4-tc-torn-verified-null.ts / attack4-manifest-mismatch.ts
        // T-B): 'verified' is on the allowlist, so a manifest claiming
        // 'verified' while carrying a null count sailed straight through —
        // `expectedGraphNodeCount` then came out null too, which SKIPS the
        // post-restore node-count cross-check entirely (`expectedGraphNodeCount
        // !== null` guards it). A torn/empty restored store was accepted with
        // no error under a manifest that says "verified".
        const { spawn } = await import('node:child_process');
        const tarExtract = (tb: string, dest: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-x', '-z', '-f', tb, '-C', dest]);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });
        const tarCreate = (tb: string, cwd: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-c', '-z', '-f', tb, '-C', cwd, '.']);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });

        const cleanSrc = path.join(root, 't6-clean-src');
        fs.mkdirSync(path.join(cleanSrc, '.lore'), { recursive: true });
        {
            const g = new SurrealGraph(cleanSrc, { workspaceId: 't6-clean' });
            await g.initialize();
            await g.upsertNode({
                id: 't6-1', type: 'note', label: 't6-1', content: 't6-1', tags: [], project: '*',
                ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            } as never);
            await g.close();
        }
        const cleanBackup = await backupWorkspace({ workspaceDir: cleanSrc, workspaceName: 't6-clean', outDir });
        assert.equal(cleanBackup.graphNodeCountReason, 'verified');
        assert.equal(cleanBackup.graphNodeCount, 1);

        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t6-stage-'));
        await tarExtract(cleanBackup.tarballPath, stage);
        const manifestPath = path.join(stage, 'backup-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.equal(manifest.graphNodeCountReason, 'verified');
        manifest.graphNodeCount = null; // self-contradictory: 'verified' + null
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const tornTarball = path.join(root, 't6-verified-null.tar.gz');
        await tarCreate(tornTarball, stage);

        const destDir = path.join(root, 't6-dest-refused');
        fs.mkdirSync(destDir, { recursive: true });
        await assert.rejects(
            () => restoreWorkspace({ tarballPath: tornTarball, workspaceDir: destDir, expectedEngine: 'surreal' }),
            /internally inconsistent/,
            "'verified' + null count must be refused with a message naming the inconsistency, not a generic one",
        );
        assert.ok(!fs.existsSync(path.join(destDir, '.lore')), 'restore must refuse BEFORE staging anything into the destination');

        // allowUnverifiedSource still opens the escape hatch.
        const destAllowed = path.join(root, 't6-dest-allowed');
        fs.mkdirSync(destAllowed, { recursive: true });
        const allowed = await restoreWorkspace({
            tarballPath: tornTarball, workspaceDir: destAllowed, expectedEngine: 'surreal', allowUnverifiedSource: true,
        });
        assert.equal(allowed.expectedGraphNodeCount, null);
        assert.equal(allowed.expectedGraphNodeCountReason, 'verified');

        fs.rmSync(stage, { recursive: true, force: true });
    },
);

await test(
    'T7 (QA round 3): "no-store" / "unreadable" with a non-null graphNodeCount is also internally '
    + 'inconsistent and must be refused',
    async () => {
        const { spawn } = await import('node:child_process');
        const tarExtract = (tb: string, dest: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-x', '-z', '-f', tb, '-C', dest]);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });
        const tarCreate = (tb: string, cwd: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-c', '-z', '-f', tb, '-C', cwd, '.']);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });

        const cleanSrc = path.join(root, 't7-clean-src');
        fs.mkdirSync(path.join(cleanSrc, '.lore'), { recursive: true });
        {
            const g = new SurrealGraph(cleanSrc, { workspaceId: 't7-clean' });
            await g.initialize();
            await g.upsertNode({
                id: 't7-1', type: 'note', label: 't7-1', content: 't7-1', tags: [], project: '*',
                ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            } as never);
            await g.close();
        }
        const cleanBackup = await backupWorkspace({ workspaceDir: cleanSrc, workspaceName: 't7-clean', outDir });

        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t7-stage-'));
        await tarExtract(cleanBackup.tarballPath, stage);
        const manifestPath = path.join(stage, 'backup-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifest.graphNodeCountReason = 'no-store'; // claims nothing to count...
        manifest.graphNodeCount = 7;                // ...yet a count is recorded
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const inconsistentTarball = path.join(root, 't7-no-store-with-count.tar.gz');
        await tarCreate(inconsistentTarball, stage);

        const destDir = path.join(root, 't7-dest-refused');
        fs.mkdirSync(destDir, { recursive: true });
        await assert.rejects(
            () => restoreWorkspace({ tarballPath: inconsistentTarball, workspaceDir: destDir, expectedEngine: 'surreal' }),
            /internally inconsistent/,
            "'no-store' + a real count must be refused, not waved through because 'no-store' is allowlisted",
        );
        assert.ok(!fs.existsSync(path.join(destDir, '.lore')), 'restore must refuse BEFORE staging anything into the destination');

        fs.rmSync(stage, { recursive: true, force: true });
    },
);

await test(
    'T8 (QA round 3): "no-store" claimed but the archive actually holds a real, readable store — '
    + 'restore still succeeds (no data loss) but warns about the mismatch',
    async () => {
        const { spawn } = await import('node:child_process');
        const tarExtract = (tb: string, dest: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-x', '-z', '-f', tb, '-C', dest]);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });
        const tarCreate = (tb: string, cwd: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-c', '-z', '-f', tb, '-C', cwd, '.']);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });

        const cleanSrc = path.join(root, 't8-clean-src');
        fs.mkdirSync(path.join(cleanSrc, '.lore'), { recursive: true });
        {
            const g = new SurrealGraph(cleanSrc, { workspaceId: 't8-clean' });
            await g.initialize();
            await g.upsertNode({
                id: 't8-1', type: 'note', label: 't8-1', content: 't8-1', tags: [], project: '*',
                ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            } as never);
            await g.close();
        }
        const cleanBackup = await backupWorkspace({ workspaceDir: cleanSrc, workspaceName: 't8-clean', outDir });

        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t8-stage-'));
        await tarExtract(cleanBackup.tarballPath, stage);
        const manifestPath = path.join(stage, 'backup-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifest.graphNodeCountReason = 'no-store'; // claims nothing was there...
        manifest.graphNodeCount = null;              // ...internally consistent with that claim...
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const mismatchTarball = path.join(root, 't8-no-store-but-real.tar.gz');
        await tarCreate(mismatchTarball, stage); // ...but the .lore/surreal store is still really in here

        const destDir = path.join(root, 't8-dest');
        fs.mkdirSync(destDir, { recursive: true });
        const result = await restoreWorkspace({ tarballPath: mismatchTarball, workspaceDir: destDir, expectedEngine: 'surreal' });
        assert.equal(result.restoredGraphNodeCount, 1, 'the real store data must still be restored intact — no data loss');
        assert.ok(
            result.warnings.some((w) => /no-store.*does not match|does not match this archive/i.test(w)),
            `expected a mismatch warning in result.warnings, got: ${JSON.stringify(result.warnings)}`,
        );

        fs.rmSync(stage, { recursive: true, force: true });
    },
);

await test(
    'T9 (QA round 4, finding 4): the CLI must NOT annotate a "no-store" reason with the benign '
    + '"archive predates the recorded count" line — that message is reserved for a manifest that never '
    + 'carried the field at all',
    async () => {
        const { spawn } = await import('node:child_process');
        const tarExtract = (tb: string, dest: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-x', '-z', '-f', tb, '-C', dest]);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });
        const tarCreate = (tb: string, cwd: string) => new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-c', '-z', '-f', tb, '-C', cwd, '.']);
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
        });

        // Same "no-store" claim contradicted by a real, readable store as T8
        // above (library-level warning), but driven through restoreCommand()
        // to check the SEPARATE CLI-level annotation on the "Graph verified"
        // line, which read the reason wrong before this fix.
        const cleanSrc = path.join(root, 't9-clean-src');
        fs.mkdirSync(path.join(cleanSrc, '.lore'), { recursive: true });
        {
            const g = new SurrealGraph(cleanSrc, { workspaceId: 't9-clean' });
            await g.initialize();
            await g.upsertNode({
                id: 't9-1', type: 'note', label: 't9-1', content: 't9-1', tags: [], project: '*',
                ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            } as never);
            await g.close();
        }
        const cleanBackup = await backupWorkspace({ workspaceDir: cleanSrc, workspaceName: 't9-clean', outDir });

        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t9-stage-'));
        await tarExtract(cleanBackup.tarballPath, stage);
        const manifestPath = path.join(stage, 'backup-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifest.graphNodeCountReason = 'no-store'; // claims nothing was there...
        manifest.graphNodeCount = null;              // ...internally consistent with that claim...
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const tarball = path.join(root, 't9-no-store-but-real.tar.gz');
        await tarCreate(tarball, stage); // ...but the .lore/surreal store is still really in here

        const priorHome = process.env['LORE_HOME'];
        process.env['LORE_HOME'] = root;
        try {
            const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
            createWorkspace('t9-cli-dest', {}, root);

            const { restoreCommand } = await import('../packages/lore/src/cli/commands/restore.js');
            const cap = captureConsole();
            const exit = captureExit();
            try {
                // --allow-name-mismatch: same incidental naming mismatch as
                // T4 above ('t9-clean' backed up, 't9-cli-dest' restored
                // into) — unrelated to what this test actually checks (the
                // "no-store" CLI annotation).
                await restoreCommand([tarball, '--workspace', 't9-cli-dest', '--force', '--allow-name-mismatch']);
            } finally {
                cap.restore();
                exit.restore();
            }
            const joined = cap.out.join('\n');
            assert.match(joined, /Graph verified: 1 node\(s\) readable/, `expected the graph-verified line, got:\n${joined}`);
            assert.doesNotMatch(
                joined,
                /archive predates the recorded count/,
                'a "no-store" reason must never be reported with the benign pre-field message — the manifest ' +
                'explicitly claimed no store existed, which is a lie caught by the warning above, not an absent field',
            );
            assert.match(
                joined,
                /manifest recorded no store existed at backup time/,
                `expected the no-store-specific annotation, got:\n${joined}`,
            );
        } finally {
            if (priorHome === undefined) delete process.env['LORE_HOME'];
            else process.env['LORE_HOME'] = priorHome;
        }

        fs.rmSync(stage, { recursive: true, force: true });
    },
);

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
