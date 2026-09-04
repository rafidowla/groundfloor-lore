#!/usr/bin/env tsx
/**
 * restore-name-mismatch-unit.ts — `lore restore <archive> --workspace other`
 * must not silently restore an archive backed up from a DIFFERENT workspace.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────
 *
 * `backupWorkspace` writes `workspace: spec.workspaceName` into every
 * `backup-manifest.json` (engines/backup.ts ~:400). Nothing in
 * `restoreWorkspace` ever read that field back: `lore restore <archive
 * backed up from workspace 'default'> --workspace other` restored the
 * archive's data into 'other' with a clean success message and zero
 * warnings — indistinguishable from restoring the RIGHT archive. The only
 * comparison restore ever made was `manifest.graphEngine` against the
 * destination's registered engine (a completely different question: WHICH
 * SUBSTRATE, not WHICH WORKSPACE).
 *
 * The fix threads `targetWorkspaceName` (the CLI's `--workspace <name>`,
 * looked up from workspaces.json) into `restoreWorkspace`, which now compares
 * it against `manifest.workspace` and refuses on a mismatch unless
 * `allowNameMismatch` (CLI: `--allow-name-mismatch`) is passed — same shape
 * as the existing `allowUnverifiedSource` escape hatch. An archive whose
 * manifest predates this field (`manifest.workspace === undefined`) proceeds
 * either way, with a one-line notice instead of a comparison it cannot make.
 *
 * `lore restore --all <dir>` is new too: it restores every
 * `lore-backup-*.tar.gz` in a directory, each into the workspace named in its
 * OWN manifest (via `peekArchiveManifest`), reusing the exact single-archive
 * path — so the name-mismatch guard above can never fire for `--all` (the
 * target IS the manifest's own claim, by construction), but every OTHER
 * guard (daemon, lock, unverified-source) still runs per archive.
 *
 * T1 — mismatched name, no flag: refused, destination untouched (no
 *      `.lore.pre-restore-*` sideline — the refusal happens before anything
 *      is moved).
 * T2 — mismatched name, `allowNameMismatch: true`: proceeds, with a
 *      `WORKSPACE NAME MISMATCH` warning in `result.warnings`.
 * T3 — matching name: unchanged behaviour (no warning about the name at
 *      all, restore succeeds).
 * T4 — archive with no recorded `workspace` field at all (pre-3.19):
 *      proceeds with a one-line "no recorded workspace name" notice, not a
 *      refusal.
 * T5 — CLI: mismatched name via `restoreCommand` is refused with the exact
 *      message naming both workspaces; `--allow-name-mismatch` on the CLI
 *      makes it proceed and prints the warning to stderr.
 * T6 — `lore restore --all <dir>` over a directory holding two archives
 *      (backed up from two different workspaces) restores each into ITS OWN
 *      workspace — never cross-wired — and an archive with no recorded
 *      workspace name is skipped and reported rather than guessed at.
 *
 * Run: npx tsx test/restore-name-mismatch-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

let passed = 0;
let failed = 0;

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

function tarExtract(tb: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn('tar', ['-x', '-z', '-f', tb, '-C', dest]);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    });
}
function tarCreate(tb: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn('tar', ['-c', '-z', '-f', tb, '-C', cwd, '.']);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    });
}

console.log('restore refuses (or clearly flags) an archive whose manifest names a DIFFERENT workspace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-restore-name-mismatch-test-'));
// Keep this test from ever probing the real Lore daemon port — restore's
// daemon-guard preflight checks http://127.0.0.1:<LORE_PORT||3847>/api/health
// by default.
const priorPort = process.env['LORE_PORT'];
process.env['LORE_PORT'] = '39847';

const { backupWorkspace } = await import('../packages/lore/src/engines/backup.js');
const { restoreWorkspace } = await import('../packages/lore/src/engines/restore.js');
const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');

const outDir = path.join(root, 'out');
fs.mkdirSync(outDir, { recursive: true });

async function seedAndBackup(workspaceName: string, nodeId: string): Promise<string> {
    const srcDir = path.join(root, `src-${workspaceName}`);
    fs.mkdirSync(path.join(srcDir, '.lore'), { recursive: true });
    const g = new SurrealGraph(srcDir, { workspaceId: workspaceName });
    await g.initialize();
    await g.upsertNode({
        id: nodeId, type: 'note', label: nodeId, content: nodeId, tags: [], project: '*',
        ecosystem: '*', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);
    await g.close();
    const result = await backupWorkspace({ workspaceDir: srcDir, workspaceName, outDir });
    return result.tarballPath;
}

const defaultTarball = await seedAndBackup('default', 'd1');

await test('T1: mismatched name refused, destination untouched (no sideline created)', async () => {
    const destDir = path.join(root, 't1-dest');
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({
            tarballPath: defaultTarball, workspaceDir: destDir, expectedEngine: 'surreal',
            targetWorkspaceName: 'other',
        }),
        (err: Error) => {
            assert.match(err.message, /workspace name mismatch|manifest says it was backed up from workspace 'default'/i);
            assert.match(err.message, /'default'/);
            assert.match(err.message, /'other'/);
            return true;
        },
    );
    const entries = fs.readdirSync(destDir);
    assert.deepEqual(entries, ['.lore'], 'nothing must be sidelined or added — the refusal happens before any move');
    assert.ok(fs.existsSync(path.join(destDir, '.lore')), 'the original empty .lore/ must be exactly as it was');
});

await test('T2: mismatched name with allowNameMismatch:true proceeds, with a loud warning', async () => {
    const destDir = path.join(root, 't2-dest');
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    const result = await restoreWorkspace({
        tarballPath: defaultTarball, workspaceDir: destDir, expectedEngine: 'surreal',
        targetWorkspaceName: 'other', allowNameMismatch: true,
    });
    assert.equal(result.restoredGraphNodeCount, 1, 'the data still restores intact');
    assert.ok(
        result.warnings.some((w) => /WORKSPACE NAME MISMATCH/.test(w) && w.includes('default') && w.includes('other')),
        `expected a name-mismatch warning naming both workspaces, got: ${JSON.stringify(result.warnings)}`,
    );
});

await test('T3: matching name — unchanged behaviour, no name-related warning', async () => {
    const destDir = path.join(root, 't3-dest');
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    const result = await restoreWorkspace({
        tarballPath: defaultTarball, workspaceDir: destDir, expectedEngine: 'surreal',
        targetWorkspaceName: 'default',
    });
    assert.equal(result.restoredGraphNodeCount, 1);
    assert.ok(
        !result.warnings.some((w) => /mismatch|workspace name/i.test(w)),
        `expected no name-related warning for a matching restore, got: ${JSON.stringify(result.warnings)}`,
    );
});

await test('T4: archive with no recorded workspace field proceeds with a one-line notice, not a refusal', async () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t4-stage-'));
    await tarExtract(defaultTarball, stage);
    const manifestPath = path.join(stage, 'backup-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.workspace; // simulate a pre-3.19 archive
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const noNameTarball = path.join(root, 't4-no-workspace-field.tar.gz');
    await tarCreate(noNameTarball, stage);

    const destDir = path.join(root, 't4-dest');
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    const result = await restoreWorkspace({
        tarballPath: noNameTarball, workspaceDir: destDir, expectedEngine: 'surreal',
        targetWorkspaceName: 'anything',
    });
    assert.equal(result.restoredGraphNodeCount, 1, 'a pre-field archive must still restore, never refused for a field it predates');
    assert.ok(
        result.warnings.some((w) => /no recorded workspace name/i.test(w)),
        `expected the one-line pre-field notice, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
        !result.warnings.some((w) => /WORKSPACE NAME MISMATCH/.test(w)),
        'a pre-field archive must never be reported as a MISMATCH — there is nothing to compare',
    );

    fs.rmSync(stage, { recursive: true, force: true });
});

await test('T5 (CLI): restoreCommand refuses a mismatched name naming both workspaces, and --allow-name-mismatch proceeds', async () => {
    const priorHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = root;
    try {
        const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
        createWorkspace('cli-other', {}, root);

        const { restoreCommand } = await import('../packages/lore/src/cli/commands/restore.js');

        // Refused, default flags. `restoreWorkspace`'s own thrown error
        // propagates out of `restoreCommand` uncaught (same as every other
        // restoreWorkspace() refusal — the real CLI's top-level
        // `main().catch` in cli/index.ts is what turns this into a
        // non-zero exit; captureExit is not involved here at all).
        {
            const cap = captureConsole();
            const exit = captureExit();
            let threw = false;
            try {
                await restoreCommand([defaultTarball, '--workspace', 'cli-other']);
            } catch (err) {
                threw = true;
                assert.match((err as Error).message, /'default'/);
                assert.match((err as Error).message, /'cli-other'/);
            } finally {
                cap.restore();
                exit.restore();
            }
            assert.ok(threw, 'restoreWorkspace must throw on a name mismatch, uncaught by restoreCommand');
            assert.equal(exit.code, null, 'this refusal is a thrown error, not a process.exit call');
        }

        // Proceeds with --allow-name-mismatch, warning printed to stderr.
        {
            const cap = captureConsole();
            const exit = captureExit();
            try {
                await restoreCommand([defaultTarball, '--workspace', 'cli-other', '--allow-name-mismatch']);
            } finally {
                cap.restore();
                exit.restore();
            }
            assert.equal(exit.code, null, 'a successful restore must not call process.exit');
            const errJoined = cap.err.join('\n');
            assert.match(errJoined, /WORKSPACE NAME MISMATCH/, `expected the mismatch warning on stderr, got:\n${errJoined}`);
        }
    } finally {
        if (priorHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorHome;
    }
});

await test('T6: `lore restore --all <dir>` restores each archive into the workspace ITS OWN manifest names', async () => {
    const priorHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = root;
    try {
        const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
        createWorkspace('alpha', {}, root);
        createWorkspace('beta', {}, root);

        const alphaTarball = await seedAndBackup('alpha', 'a-node');
        const betaTarball = await seedAndBackup('beta', 'b-node');

        const allDir = path.join(root, 't6-all-src');
        fs.mkdirSync(allDir, { recursive: true });
        fs.copyFileSync(alphaTarball, path.join(allDir, path.basename(alphaTarball)));
        fs.copyFileSync(betaTarball, path.join(allDir, path.basename(betaTarball)));

        // An archive with no recorded workspace name must be skipped, not
        // guessed onto the active workspace.
        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-t6-stage-'));
        await tarExtract(alphaTarball, stage);
        const manifestPath = path.join(stage, 'backup-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        delete manifest.workspace;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const namelessTarball = path.join(allDir, 'lore-backup-nameless-2026-01-01T00-00-00-000Z.tar.gz');
        await tarCreate(namelessTarball, stage);

        const { restoreCommand } = await import('../packages/lore/src/cli/commands/restore.js');
        const cap = captureConsole();
        const exit = captureExit();
        let threw = false;
        try {
            // --force: no daemon and nothing holds these fresh workspaces'
            // stores, but --force keeps this test independent of timing on
            // the lock/daemon preflight, which restore-unverified-source-unit.ts
            // and this file's own T5 already cover directly.
            await restoreCommand(['--all', allDir, '--force']);
        } catch (err) {
            threw = true;
        } finally {
            cap.restore();
            exit.restore();
        }
        // Exits non-zero because the nameless archive is skipped — that is
        // expected and reported, not a failure of the two real restores.
        assert.ok(threw, 'exits non-zero because one archive was skipped');
        assert.equal(exit.code, 1);

        const joined = [...cap.out, ...cap.err].join('\n');
        assert.match(joined, /skip .*nameless.*: archive has no recorded workspace name/i, `expected the skip line, got:\n${joined}`);

        const { loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
        const wsFile = loadWorkspaces(root);
        const alphaEntry = wsFile.workspaces.find((w) => w.name === 'alpha')!;
        const betaEntry = wsFile.workspaces.find((w) => w.name === 'beta')!;

        const alphaGraph = new SurrealGraph(alphaEntry.path, { workspaceId: 'alpha' });
        await alphaGraph.initialize();
        const alphaNode = await alphaGraph.getNode('a-node');
        await alphaGraph.close();
        assert.ok(alphaNode, "workspace 'alpha' must hold its OWN archive's node");

        const betaGraph = new SurrealGraph(betaEntry.path, { workspaceId: 'beta' });
        await betaGraph.initialize();
        const betaNode = await betaGraph.getNode('b-node');
        const crossNode = await betaGraph.getNode('a-node');
        await betaGraph.close();
        assert.ok(betaNode, "workspace 'beta' must hold its OWN archive's node");
        assert.ok(!crossNode, "workspace 'beta' must NOT hold workspace 'alpha''s node — no cross-wiring");

        fs.rmSync(stage, { recursive: true, force: true });
    } finally {
        if (priorHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorHome;
    }
});

if (priorPort === undefined) delete process.env['LORE_PORT'];
else process.env['LORE_PORT'] = priorPort;

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
