#!/usr/bin/env tsx
/**
 * test/arcade-provisioning-db-close-unit.ts — STEP2-CLOSE-PATH-DESIGN.md (d).
 *
 * Two module-level cached better-sqlite3 connections onto the SAME
 * `arcade-provisioning.sqlite` file — `arcadeRegistryStore.ts`'s `cachedDb`
 * and `arcadeAuthResolver.ts`'s `cachedDb` — each already had an exported
 * close hook (`closeRegistryDb()` / `closeTokenDb()`), but neither was ever
 * called from `mcp/arcadeBoot.ts`'s `shutdown()` (SIGINT/SIGTERM path) or
 * `dispose()` (embeddable-API path). Every arcade-mode process leaked two
 * open handles to that file for its whole lifetime.
 *
 * Two things are asserted:
 *   1. Functional: `closeRegistryDb()`/`closeTokenDb()` actually release a
 *      real opened handle (the module-level cache clears; a fresh open call
 *      re-opens rather than reusing a stale reference).
 *   2. Structural: `mcp/arcadeBoot.ts`'s source contains BOTH close calls
 *      inside BOTH its `shutdown` function and its `dispose` closure — a
 *      full boot of arcade mode needs KMS/secret-store/cell-pool wiring far
 *      beyond what a focused close-path test should require, so the
 *      "are they actually wired" question is answered by reading the
 *      source directly, the same technique
 *      shutdown-drain-sidecar-close-unit.ts's structural test uses.
 *
 * Run: npx tsx test/arcade-provisioning-db-close-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRegistryDb, closeRegistryDb } from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { openTokenDbForLifecycle as openTokenDb, closeTokenDb } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';

// Explicit dbPath on every call below — never touch the real
// ~/.groundfloor/arcade-provisioning.sqlite (both functions default to
// provisioningDbPath() = loreHomePath(...) when no path is given).
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-provisioning-close-')), 'arcade-provisioning.sqlite');

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

console.log('\nArcade provisioning db — registry + token connections are released\n');

await test('closeRegistryDb() releases the cached handle; a fresh open re-opens rather than reusing it', () => {
    const db1 = openRegistryDb(DB_PATH);
    assert.equal(db1.open, true);
    closeRegistryDb();
    assert.equal(db1.open, false, 'closeRegistryDb() must actually close the native handle');
    const db2 = openRegistryDb(DB_PATH);
    assert.equal(db2.open, true, 'a fresh open after close() must succeed (module cache cleared, not stale)');
    closeRegistryDb();
});

await test('closeTokenDb() releases the cached handle; a fresh open re-opens rather than reusing it', () => {
    const db1 = openTokenDb(DB_PATH);
    assert.equal(db1.open, true);
    closeTokenDb();
    assert.equal(db1.open, false, 'closeTokenDb() must actually close the native handle');
    const db2 = openTokenDb(DB_PATH);
    assert.equal(db2.open, true, 'a fresh open after close() must succeed (module cache cleared, not stale)');
    closeTokenDb();
});

await test('closeRegistryDb()/closeTokenDb() are no-ops (do not throw) when nothing is cached', () => {
    closeRegistryDb();
    closeRegistryDb();
    closeTokenDb();
    closeTokenDb();
});

await test('structural: mcp/arcadeBoot.ts wires both close calls into shutdown() and dispose()', () => {
    const src = fs.readFileSync(new URL('../packages/lore/src/mcp/arcadeBoot.ts', import.meta.url), 'utf-8');

    const importsBlock = src.slice(0, src.indexOf('\nexport ')); // imports live before the first export
    assert.ok(/closeRegistryDb[\s\S]{0,60}from '\.\.\/engines\/arcade\/arcadeProvisioner\.js'/.test(importsBlock),
        'arcadeBoot.ts must import closeRegistryDb from arcadeProvisioner.js');
    assert.ok(/closeTokenDb[\s\S]{0,60}from '\.\.\/engines\/arcade\/arcadeAuthResolver\.js'/.test(importsBlock),
        'arcadeBoot.ts must import closeTokenDb from arcadeAuthResolver.js');

    const shutdownMatch = src.match(/const shutdown = \(reason: string\): void => \{[\s\S]*?\n {8}\};/);
    assert.ok(shutdownMatch, 'could not locate the shutdown() function body in arcadeBoot.ts — has it been renamed/restructured?');
    assert.ok(shutdownMatch![0].includes('closeTokenDb()'), 'shutdown() must call closeTokenDb()');
    assert.ok(shutdownMatch![0].includes('closeRegistryDb()'), 'shutdown() must call closeRegistryDb()');

    const disposeMatch = src.match(/dispose: async \(\) => \{[\s\S]*?\n {8}\},/);
    assert.ok(disposeMatch, 'could not locate the dispose() closure in arcadeBoot.ts — has it been renamed/restructured?');
    assert.ok(disposeMatch![0].includes('closeTokenDb()'), 'dispose() must call closeTokenDb()');
    assert.ok(disposeMatch![0].includes('closeRegistryDb()'), 'dispose() must call closeRegistryDb()');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
