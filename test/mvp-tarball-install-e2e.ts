#!/usr/bin/env tsx
/**
 * mvp-tarball-install-e2e.ts — MVP readiness P0 (release blocker #1): a
 * PACKED-TARBALL install must actually work.
 *
 * Everything else in test/ runs against the repo's own node_modules /
 * source tree, so it never exercises what `npm install @groundfloor/lore`
 * actually ships: the `files` allow-list in package.json, the `postinstall`
 * script that verifies the SurrealDB native addon, and the compiled `dist/`
 * output as a real npm consumer sees it. Release blocker #1 was exactly
 * this gap — the published tarball's `files` array once omitted the
 * then-postinstall script for the former legacy graph engine, so `npm install`
 * silently ran no postinstall and every fresh install shipped without the
 * native graph engine. No unit test caught it because unit tests never
 * leave the repo's own node_modules.
 *
 * This suite, in order:
 *
 *   §1 `npm pack` (REAL, not --dry-run) the publishable package from THIS
 *      repo into a scratch dir, producing the exact tarball `npm publish`
 *      would upload.
 *   §2 Assert the tarball's file list contains
 *      `scripts/ensure-surreal-native.mjs` — the postinstall target, and
 *      the regression class this suite exists to catch (a `files` array
 *      that omits a script the postinstall references). Fails loudly with
 *      the full file list if the `files` array regresses again.
 *   §3 `npm install <tarball>` into a FRESH consumer directory (its own
 *      package.json, its own node_modules) — the real postinstall path
 *      runs for real.
 *   §4 From the consumer dir, run a smoke script with PLAIN `node` (no tsx —
 *      the installed package is compiled `dist/`, exactly what a real
 *      consumer imports): `createLore()` in embedded mode against an
 *      isolated temp dataDir AND an isolated temp LORE_HOME (seeded with a
 *      copy of the cached embedding model — `search()` embeds the query via
 *      the shared model server), `nodeUpsert` one node, `search()`, assert
 *      the round trip and that the model server ran under the temp home,
 *      `dispose()`, and exit cleanly (code 0). Nothing is written under
 *      the operator's real ~/.groundfloor.
 *
 * No framework; same tsx-run style + manual pass/fail counters as the rest
 * of the mvp-*-e2e suite. Non-zero exit on any failure.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_POSTINSTALL_FILE = 'scripts/ensure-surreal-native.mjs';

// npm pack + a real `npm install` (npm's own dependency resolution) are
// slower than an in-repo test. Generous but bounded so a genuinely hung
// install still fails the suite.
const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
const SMOKE_TIMEOUT_MS = 2 * 60_000;

let passed = 0;
let failed = 0;

console.log('MVP tarball-install E2E — npm pack -> npm install <tarball> -> smoke test the compiled package');

function mkScratch(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-tarball-e2e-${tag}-`));
}

async function main(): Promise<void> {
    const packDir = mkScratch('pack');
    const consumerDir = mkScratch('consumer');
    const smokeDataDir = mkScratch('smoke-data');
    const smokeHome = mkScratch('smoke-home');
    try {
        /* ── §1 npm pack (real) ─────────────────────────────────────────── */
        console.log('  → npm pack (real, not --dry-run)...');
        const packJson = execFileSync(
            'npm',
            ['pack', '--json', '--pack-destination', packDir],
            { cwd: REPO_ROOT, encoding: 'utf8', timeout: NPM_INSTALL_TIMEOUT_MS },
        );
        const packResult = JSON.parse(packJson) as Array<{ filename: string; files: Array<{ path: string }> }>;
        assert.equal(packResult.length, 1, `npm pack must produce exactly one tarball, got ${packResult.length}`);
        const tarballName = packResult[0]!.filename;
        const tarballPath = path.join(packDir, tarballName);
        assert.ok(fs.existsSync(tarballPath), `tarball must exist on disk at ${tarballPath}`);
        console.log(`  ✓ §1 npm pack produced ${tarballName}`);
        passed++;

        /* ── §2 tarball must contain the postinstall script ───────────────
         * This is THE regression class: if the `files` array in package.json
         * omits the postinstall target, a real `npm install` ships a
         * postinstall directive (`node scripts/ensure-surreal-native.mjs`)
         * that points at a file the tarball never contains — postinstall
         * just silently no-ops (node exits non-zero on a missing file, but
         * npm had ALREADY extracted an incomplete package by then). The
         * original incident was exactly this with the repo's former
         * legacy-engine postinstall script. Assert against npm's own reported file
         * list first (authoritative), then cross-check by actually listing
         * the tarball contents on disk. */
        const packedPaths = new Set(packResult[0]!.files.map((f) => f.path));
        assert.ok(
            packedPaths.has(REQUIRED_POSTINSTALL_FILE),
            `tarball is MISSING ${REQUIRED_POSTINSTALL_FILE} — this is release blocker #1 ` +
            `(package.json "files" array regression: postinstall references a file the ` +
            `tarball doesn't ship, so every fresh install silently loses the postinstall ` +
            `verification). Packed file list (${packedPaths.size} files):\n` +
            [...packedPaths].sort().join('\n'),
        );
        // Belt-and-suspenders: independently verify via `tar -tf` against the
        // actual bytes on disk, not just npm's self-reported manifest.
        const tarList = execFileSync('tar', ['-tf', tarballPath], { encoding: 'utf8' });
        const tarHasIt = tarList.split('\n').some((l) => l.trim() === `package/${REQUIRED_POSTINSTALL_FILE}`);
        assert.ok(
            tarHasIt,
            `tar -tf ${tarballName} does not list package/${REQUIRED_POSTINSTALL_FILE} — ` +
            `npm's reported file list and the actual tarball contents disagree`,
        );
        console.log(`  ✓ §2 tarball contains ${REQUIRED_POSTINSTALL_FILE} (postinstall target present)`);
        passed++;

        /* ── §3 npm install <tarball> into a fresh consumer dir ────────────
         * Real `npm install`, so the real postinstall
         * (ensure-surreal-native.mjs, a fail-soft verify step) runs. */
        fs.writeFileSync(
            path.join(consumerDir, 'package.json'),
            JSON.stringify({
                name: 'lore-tarball-consumer-smoke',
                version: '0.0.0',
                private: true,
                type: 'module',
            }, null, 2),
        );
        console.log('  → npm install <tarball> into a fresh consumer dir (real postinstall runs)...');
        execFileSync(
            'npm',
            ['install', tarballPath, '--no-audit', '--no-fund'],
            { cwd: consumerDir, encoding: 'utf8', timeout: NPM_INSTALL_TIMEOUT_MS, stdio: 'pipe' },
        );
        const installedPkgRoot = path.join(consumerDir, 'node_modules', '@groundfloor', 'lore');
        assert.ok(fs.existsSync(installedPkgRoot), `@groundfloor/lore must be installed under ${installedPkgRoot}`);
        assert.ok(
            fs.existsSync(path.join(installedPkgRoot, 'scripts', 'ensure-surreal-native.mjs')),
            'installed package must contain scripts/ensure-surreal-native.mjs on disk (files-array regression would strip it here too)',
        );
        assert.ok(
            fs.existsSync(path.join(installedPkgRoot, 'dist', 'lore', 'src', 'index.js')),
            'installed package must contain the compiled dist/ entry point',
        );
        console.log(`  ✓ §3 npm install succeeded; postinstall + dist/ both present under ${installedPkgRoot}`);
        passed++;

        /* ── §4 smoke test the INSTALLED (compiled) package with plain node ─
         * No tsx here — a real consumer only has the compiled dist/ output.
         * Uses embedded mode (in-process, no port) with an isolated dataDir.
         *
         * dataDir alone does NOT isolate everything: the shared model server
         * (socket/pid under `<LORE_HOME>/run/`, log under `<LORE_HOME>/logs/`)
         * and the model cache (`<LORE_HOME>/models`) resolve from LORE_HOME,
         * and `isTestProcess()` can't catch this child (its entry script
         * lives in the consumer dir, not under test/). Without an explicit
         * LORE_HOME it joined the operator's real `lore-models` process and
         * wrote to the real ~/.groundfloor. So the child gets its own temp
         * LORE_HOME, seeded with a copy of the cached embedding model (search
         * embeds the query) so no network download is needed. */
        passed += runSmoke(consumerDir, smokeDataDir, smokeHome);
        console.log('  ✓ §4 smoke test passed: createLore -> nodeUpsert -> search round-trip (model server under temp LORE_HOME) -> dispose -> clean exit');

        console.log(`\n${passed} passed, ${failed} failed`);
    } catch (err) {
        failed++;
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        console.error(`  ✗ ${e.message}`);
        if (e.stdout) console.error(`--- stdout ---\n${e.stdout.toString().slice(-4000)}`);
        if (e.stderr) console.error(`--- stderr ---\n${e.stderr.toString().slice(-4000)}`);
        console.log(`\n${passed} passed, ${failed} failed`);
    } finally {
        stopSmokeModelServers(smokeHome);
        for (const d of [packDir, consumerDir, smokeDataDir, smokeHome]) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    }
    if (failed > 0) process.exit(1);
}

/** Run the smoke script under an isolated LORE_HOME and prove the model
 *  server it used lived there, not in the operator's real home. Returns
 *  the number of passed checks (1). */
function runSmoke(consumerDir: string, dataDir: string, home: string): number {
    seedModelCache(home);
    const smokeScriptPath = path.join(consumerDir, 'smoke.mjs');
    fs.writeFileSync(smokeScriptPath, buildSmokeScript(dataDir));
    console.log(`  → running smoke script with plain node against the installed dist/ package (LORE_HOME=${home})...`);
    const smokeOut = execFileSync(
        process.execPath,
        [smokeScriptPath],
        {
            cwd: consumerDir,
            encoding: 'utf8',
            timeout: SMOKE_TIMEOUT_MS,
            stdio: 'pipe',
            // Short idle-exit so the temp-home model server is gone by the
            // time cleanup deletes its run dir.
            env: { ...process.env, LORE_HOME: home, LORE_MODEL_SERVER_IDLE_EXIT_MS: '1000' },
        },
    );
    assert.ok(smokeOut.includes('SMOKE_OK'), `smoke script must print SMOKE_OK; got:\n${smokeOut}`);
    if (process.env['LORE_MODEL_SERVER'] !== '0') {
        assert.ok(
            fs.existsSync(path.join(home, 'logs', 'model-server.log')),
            `the shared model server must have run under the temp LORE_HOME (${home}/logs/model-server.log missing) — `
            + 'if it resolved another home it may have joined the operator\'s real lore-models process',
        );
    }
    return 1;
}

/** Copy the operator's cached embedding model(s) into the temp home so the
 *  smoke run's query embed needs no network. Read-only on the source; lock
 *  and staging entries are skipped. With nothing cached the model is
 *  downloaded into the temp home instead (slow, needs network). */
function seedModelCache(home: string): void {
    const realHome = process.env['LORE_HOME']?.trim() || path.join(os.homedir(), '.groundfloor');
    const src = path.join(realHome, 'models');
    if (!fs.existsSync(src)) {
        console.log(`  → no cached models at ${src}; the smoke run will download the embedding model into the temp home`);
        return;
    }
    fs.cpSync(src, path.join(home, 'models'), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE, // APFS/btrfs clone when available, plain copy otherwise
        filter: (s) => !/^\.(lock|staging)-/.test(path.basename(s)),
    });
}

/** Make sure no model server spawned under the temp home outlives the test.
 *  It idle-exits ~1s after the smoke run disconnects; wait for that, and
 *  only SIGTERM a pid still alive after the grace period. Scoped strictly
 *  to `home` (a temp dir) — never touches the operator's own server. */
function stopSmokeModelServers(home: string): void {
    const runRoot = path.join(home, 'run');
    if (!home.startsWith(os.tmpdir()) || !fs.existsSync(runRoot)) return;
    const alive = (pid: number): boolean => {
        try { process.kill(pid, 0); return true; } catch { return false; }
    };
    for (const entry of fs.readdirSync(runRoot)) {
        if (!entry.startsWith('model-server-')) continue;
        let pid: number;
        try { pid = parseInt(fs.readFileSync(path.join(runRoot, entry, 'server.pid'), 'utf8'), 10); } catch { continue; }
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const deadline = Date.now() + 5_000;
        while (alive(pid) && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        if (alive(pid)) {
            console.log(`  → temp-home model server pid ${pid} still alive after 5s; sending SIGTERM`);
            try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
    }
}

/** The smoke script's source, as a string, written to disk and run with
 *  plain `node` (ESM, `.mjs`) from inside the consumer dir — exactly the
 *  same way a real downstream app would `import { createLore } from
 *  '@groundfloor/lore'`. Takes the isolated dataDir as a parameter; the
 *  isolated LORE_HOME comes from the child's env (see runSmoke). */
function buildSmokeScript(dataDir: string): string {
    return `
import assert from 'node:assert/strict';
import { createLore } from '@groundfloor/lore';

const NODE_ID = 'tarball-smoke-node-1';

async function main() {
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: ${JSON.stringify(dataDir)} });
    try {
        const write = await lore.nodeUpsert({
            id: NODE_ID,
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: NODE_ID,
                type: 'note',
                label: 'tarball install smoke node',
                content: 'proves a packed-tarball npm install can write and read a node end to end',
                tags: 'smoke,tarball',
                project: 'default',
                ecosystem: '*',
                metadata: '{}',
            },
            // Keyword-only smoke test: skip the embedding pipeline entirely
            // so this never downloads the embedding model.
            skipEmbed: true,
        });
        assert.ok(write.ok, 'nodeUpsert must succeed: ' + JSON.stringify(write));

        // search() embeds the query (the model comes from the temp
        // LORE_HOME's seeded cache) — exercises the round trip.
        const hits = await lore.search('tarball install smoke', 10, 'default', '*');
        assert.ok(
            hits.some((n) => n.id === NODE_ID),
            'keyword search must find the node just written (got ids: ' + hits.map((n) => n.id).join(',') + ')',
        );

        await lore.dispose('tarball-smoke-teardown');
        console.log('SMOKE_OK');
    } catch (err) {
        await lore.dispose('tarball-smoke-teardown-on-error').catch(() => {});
        throw err;
    }
}

main().catch((err) => {
    console.error('SMOKE_FAILED:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
`;
}

await main();
