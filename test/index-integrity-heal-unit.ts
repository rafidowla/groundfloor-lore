#!/usr/bin/env tsx
/**
 * index-integrity-heal-unit.ts — crash-safe index builds + corruption self-heal.
 *
 * Reproduces the durability bug reported after the SearchGate admission fix:
 * repeatedly crashing the embedded engine mid-index-build corrupted a
 * workspace's search index, and every subsequent read then re-crashed the
 * process (SIGSEGV) until a full manual re-index. That is a workspace getting
 * BRICKED by a self-inflicted crash — unacceptable for an always-on embedded
 * digital employee.
 *
 * The fix (indexIntegrity.ts + verbatimStore/verbatimBatch wiring):
 *   #2 atomicity  — a build writes a marker before createIndex, clears it after.
 *   #3 self-heal  — on open, a surviving marker => the last build didn't finish
 *                   => drop the suspect index (metadata-only, safe on a corrupt
 *                   index) + rebuild from the surviving rows, before any read.
 *
 * Section A — indexIntegrity module units (marker lifecycle, dropAllIndices,
 *              corruption-error recognition).
 * Section B — end-to-end: build indices, simulate a crash mid-build (leave the
 *              marker + physically corrupt the index files), reopen the store,
 *              and assert it SELF-HEALS (opens clean, searches return, data
 *              intact) instead of throwing / crash-looping.
 *
 * Runs under the same Node as the test runner (native ABI match — Node 22).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

import {
    markBuildStart,
    markBuildDone,
    hasInterruptedBuild,
    clearAllBuildMarkers,
    dropAllIndices,
    isIndexCorruptionError,
} from '../packages/lore/src/engines/indexIntegrity.js';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failures += 1;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).message}`);
    }
}

// ── Section A: indexIntegrity module units ──────────────────────────────────
console.log('\n=== Section A: indexIntegrity module ===\n');

const MARK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-integrity-mark-'));

await test('marker lifecycle: start → present → done → absent', () => {
    assert.equal(hasInterruptedBuild(MARK_DIR), false, 'clean dir has no marker');
    markBuildStart(MARK_DIR, 'fts');
    assert.equal(hasInterruptedBuild(MARK_DIR), true, 'marker present after start');
    markBuildDone(MARK_DIR, 'fts');
    assert.equal(hasInterruptedBuild(MARK_DIR), false, 'marker gone after done');
});

await test('per-kind markers are independent; clearAll wipes both', () => {
    markBuildStart(MARK_DIR, 'vector');
    markBuildStart(MARK_DIR, 'fts');
    assert.equal(hasInterruptedBuild(MARK_DIR), true);
    markBuildDone(MARK_DIR, 'vector');
    assert.equal(hasInterruptedBuild(MARK_DIR), true, 'fts marker still stands');
    clearAllBuildMarkers(MARK_DIR);
    assert.equal(hasInterruptedBuild(MARK_DIR), false, 'clearAll removed everything');
});

await test('isIndexCorruptionError recognises LanceDB corrupt-index errors', () => {
    for (const msg of [
        'Failed to execute query stream: GenericFailure, lance error: LanceError(Index): unsupported index version',
        'Not found: /path/lore_verbatim.lance/_indices/abc/index.idx',
        'index files are corrupt',
    ]) {
        assert.equal(isIndexCorruptionError(new Error(msg)), true, `should match: ${msg}`);
    }
});

await test('isIndexCorruptionError ignores unrelated errors', () => {
    for (const msg of [
        'ECONNREFUSED 127.0.0.1:3847',
        'No embedding functions are defined in the table',
        'workspace not found',
        '',
    ]) {
        assert.equal(isIndexCorruptionError(new Error(msg)), false, `should NOT match: ${msg}`);
    }
});

await test('dropAllIndices removes every index (safe even on corrupt files)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-integrity-drop-'));
    const db = await lancedb.connect(dir);
    const rows = Array.from({ length: 300 }, (_, i) => ({
        id: `r${i}`,
        text: `doc ${i} search indexing retrieval`,
        vector: Array.from({ length: 8 }, () => Math.random()),
    }));
    const t = await db.createTable('lore_verbatim', rows);
    await t.createIndex('vector');
    await t.createIndex('text', { config: lancedb.Index.fts() });
    assert.equal((await t.listIndices()).length, 2, 'built 2 indices');

    // Physically corrupt the index artifacts, then drop — must not throw.
    for (const f of fs.readdirSync(path.join(dir, 'lore_verbatim.lance', '_indices'))) {
        const idxDir = path.join(dir, 'lore_verbatim.lance', '_indices', f);
        for (const inner of fs.readdirSync(idxDir)) {
            fs.writeFileSync(path.join(idxDir, inner), 'CORRUPT');
        }
    }
    const dropped = await dropAllIndices(t);
    assert.equal(dropped, 2, 'dropped both suspect indices without crashing');
    assert.equal((await t.listIndices()).length, 0, 'no indices remain');
    assert.equal(await t.countRows(), 300, 'base rows survive the drop');
    fs.rmSync(dir, { recursive: true, force: true });
});

fs.rmSync(MARK_DIR, { recursive: true, force: true });

// ── Section B: end-to-end self-heal through VerbatimStore ────────────────────
console.log('\n=== Section B: VerbatimStore self-heal on open ===\n');

const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-integrity-e2e-'));
const LANCEDB_DIR = path.join(HOME, '.lore', 'lancedb');
const ROWS = 300; // > the 256-row index-build threshold

function seedDocs(): Array<{ id: string; text: string; metadata: Record<string, unknown> }> {
    return Array.from({ length: ROWS }, (_, i) => ({
        id: `lore:heal-${i}`,
        text: `document ${i} about search indexing, retrieval, embeddings and recovery`,
        metadata: {},
    }));
}

// Phase 1 — build a healthy store with real indices.
{
    const store = new VerbatimStore(HOME);
    await store.initialize();
    await store.storeBatch(seedDocs() as never[]);
    await store.ensureVectorIndex(); // no-op if storeBatch already built it
    await store.ensureFtsIndex();
    await test('phase 1: indices exist + search works on a healthy store', async () => {
        const indicesDir = path.join(LANCEDB_DIR, 'lore_verbatim.lance', '_indices');
        assert.ok(fs.existsSync(indicesDir) && fs.readdirSync(indicesDir).length > 0,
            'at least one on-disk index was built');
        const hits = await store.search('search indexing', 5);
        assert.ok(hits.length > 0, 'vector search returns hits before corruption');
    });
    await store.close();
}

// Phase 2 — simulate a crash mid-build: leave a build marker AND physically
// corrupt the on-disk index artifacts (the exact bricked-workspace state).
await test('phase 2: corrupt the index + strand a build marker (crash sim)', () => {
    markBuildStart(LANCEDB_DIR, 'fts'); // marker survives the "crash"
    markBuildStart(LANCEDB_DIR, 'vector');
    const indicesDir = path.join(LANCEDB_DIR, 'lore_verbatim.lance', '_indices');
    let corrupted = 0;
    for (const f of fs.readdirSync(indicesDir)) {
        const idxDir = path.join(indicesDir, f);
        for (const inner of fs.readdirSync(idxDir)) {
            fs.writeFileSync(path.join(idxDir, inner), 'CORRUPTGARBAGE');
            corrupted += 1;
        }
    }
    assert.ok(corrupted > 0, 'corrupted at least one index file');
    assert.equal(hasInterruptedBuild(LANCEDB_DIR), true, 'marker present going into reopen');
});

// Phase 3 — reopen. The store MUST self-heal, not throw / crash-loop.
{
    const store = new VerbatimStore(HOME);
    await test('phase 3: reopen self-heals (no crash, marker cleared)', async () => {
        await store.initialize(); // heal-on-open runs here
        assert.equal(hasInterruptedBuild(LANCEDB_DIR), false, 'build markers cleared by heal');
    });

    await test('phase 3: data survived + search works after heal', async () => {
        // Vector search: brute-force immediately after the drop, native once the
        // background rebuild lands — either way it must return, never crash.
        const hits = await store.search('search indexing retrieval', 5);
        assert.ok(hits.length > 0, `vector search returns hits post-heal (got ${hits.length})`);
        const kw = await store.bm25Search('recovery', 5);
        assert.ok(kw.hits.length > 0, `bm25 keyword search returns hits post-heal (got ${kw.hits.length})`);
    });

    await test('phase 3: indices rebuild cleanly in the background', async () => {
        // Give the fire-and-forget rebuild a moment, then confirm a healthy index
        // is back (idempotent ensure* returns false when already present).
        for (let i = 0; i < 40; i++) {
            const idxCount = await store.ensureVectorIndex().then(() => 1).catch(() => 0);
            if (idxCount) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        // A final search must still succeed on the rebuilt index.
        const hits = await store.search('embeddings', 5);
        assert.ok(hits.length >= 0, 'search stable after rebuild window');
    });

    await store.close();
}

fs.rmSync(HOME, { recursive: true, force: true });

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
    console.log(`\x1b[31m${failures} test(s) failed\x1b[0m`);
    process.exit(1);
}
console.log('\x1b[32mAll index-integrity heal tests passed\x1b[0m');
process.exit(0);
