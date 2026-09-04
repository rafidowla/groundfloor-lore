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
 *      runs for real. LORE_HOME/data is isolated (mkdtemp).
 *   §4 From the consumer dir, run a smoke script with PLAIN `node` (no tsx —
 *      the installed package is compiled `dist/`, exactly what a real
 *      consumer imports): `createLore()` in embedded mode against an
 *      isolated temp dataDir, `nodeUpsert` one node, `search()` (keyword
 *      full-text — NOT semantic recall, so this smoke test never
 *      downloads the embedding model), assert the round trip, `dispose()`,
 *      and exit cleanly (code 0).
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
         * Uses embedded mode (in-process, no port) with an isolated dataDir,
         * and keyword search (NOT semantic recall) so this smoke test never
         * triggers an embedding model download. */
        const smokeDataDir = mkScratch('smoke-data');
        const smokeScriptPath = path.join(consumerDir, 'smoke.mjs');
        fs.writeFileSync(smokeScriptPath, buildSmokeScript(smokeDataDir));
        console.log('  → running smoke script with plain node against the installed dist/ package...');
        const smokeOut = execFileSync(
            process.execPath,
            [smokeScriptPath],
            { cwd: consumerDir, encoding: 'utf8', timeout: SMOKE_TIMEOUT_MS, stdio: 'pipe' },
        );
        assert.ok(smokeOut.includes('SMOKE_OK'), `smoke script must print SMOKE_OK; got:\n${smokeOut}`);
        console.log('  ✓ §4 smoke test passed: createLore -> nodeUpsert -> keyword search round-trip -> dispose -> clean exit');
        passed++;

        console.log(`\n${passed} passed, ${failed} failed`);
    } catch (err) {
        failed++;
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        console.error(`  ✗ ${e.message}`);
        if (e.stdout) console.error(`--- stdout ---\n${e.stdout.toString().slice(-4000)}`);
        if (e.stderr) console.error(`--- stderr ---\n${e.stderr.toString().slice(-4000)}`);
        console.log(`\n${passed} passed, ${failed} failed`);
    } finally {
        for (const d of [packDir, consumerDir]) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    }
    if (failed > 0) process.exit(1);
}

/** The smoke script's source, as a string, written to disk and run with
 *  plain `node` (ESM, `.mjs`) from inside the consumer dir — exactly the
 *  same way a real downstream app would `import { createLore } from
 *  '@groundfloor/lore'`. Takes the isolated dataDir as a parameter so the
 *  graph/vector data never touches the real ~/.groundfloor. */
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

        // Keyword search (full-text), NOT semantic recall — exercises
        // the round trip without needing an embedding model.
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
