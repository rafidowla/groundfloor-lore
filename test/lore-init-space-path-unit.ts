#!/usr/bin/env tsx
/**
 * lore-init-space-path-unit.ts — `lore init` must not crash when LORE_HOME
 * (or any ancestor of it) contains a URL-reserved character, e.g. a space.
 *
 * ── WHY THIS IS A DIFFERENT BUG FROM THE BACKUP/RESTORE SPACE-PATH TEST ─────
 *
 * `surreal-space-path-backup-restore-unit.ts` proves the scattering itself —
 * `surrealDataPath()` correctly percent-encodes a reserved character into the
 * connect string `openSurreal` builds, so the embedded engine's own files
 * land in a %20-spelled SIBLING directory tree, not under the literal
 * `<workspaceDir>/.lore/` — is accounted for by `backupWorkspace` /
 * `restoreWorkspace`.
 *
 * `cli/commands/init.ts` was not: it computed `loreDir = path.join(basePath,
 * '.lore')` (the LITERAL path) and unconditionally `fs.writeFileSync`'d
 * `sync.wal` into it. For a legacy-engine-backed workspace `graph.initialize()`
 * happened to create that literal `.lore/` as a side effect (the legacy
 * engine's own files lived there), so nothing exposed the bug — but for a
 * Surreal-backed
 * workspace whose path has a reserved character, NOTHING creates the
 * literal `.lore/` (the graph's own files went to the scattered sibling
 * instead), and the plain `fs.writeFileSync` threw ENOENT. Reproduced
 * live pre-fix: `lore init` under a space-containing LORE_HOME printed
 * "SurrealDB graph initialized" and then crashed with
 * `[lore] Fatal error: ENOENT: no such file or directory, open '.../sync.wal'`,
 * exit code non-zero.
 *
 * Run: npx tsx test/lore-init-space-path-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

console.log('lore init under a space-containing LORE_HOME');

const priorHome = process.env['LORE_HOME'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-init-space-test-'));
// The space lives in an ANCESTOR of the actual home dir, exactly like an
// operator's "Documents/My Project/" — surrealDataPath's scattering triggers
// on any reserved character anywhere in the path, not just the leaf segment.
const home = path.join(root, 'with space', 'lore-home');
fs.mkdirSync(home, { recursive: true });
process.env['LORE_HOME'] = home;

await test('initCommand completes without throwing', async () => {
    const { initCommand } = await import('../packages/lore/src/cli/commands/init.js');
    await initCommand([]);
});

await test('the literal .lore/sync.wal sidecar was created', () => {
    const walPath = path.join(home, '.lore', 'sync.wal');
    assert.ok(fs.existsSync(walPath), `expected ${walPath} to exist`);
});

await test('the graph store landed where surrealDataPath says it will, and it is scattered (not the naive path) — proving this run exercised the bug, not a no-op', async () => {
    const { surrealDataPath } = await import('../packages/lore/src/engines/surreal/surrealConnection.js');
    const { looksLikeSurrealStore } = await import('../packages/lore/src/engines/surreal/surrealSettle.js');
    const storeDir = surrealDataPath(home);
    const naiveDir = path.join(home, '.lore', 'surreal');
    assert.ok(looksLikeSurrealStore(storeDir), `expected a SurrealDB store at ${storeDir}`);
    assert.notEqual(storeDir, naiveDir, 'the space in the path must make surrealDataPath scatter the store away from the naive nested path — otherwise this test is not exercising the bug');
    assert.ok(!fs.existsSync(naiveDir), `the naive path ${naiveDir} must be empty — the store lives at the scattered location only`);
});

if (priorHome === undefined) delete process.env['LORE_HOME'];
else process.env['LORE_HOME'] = priorHome;
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
