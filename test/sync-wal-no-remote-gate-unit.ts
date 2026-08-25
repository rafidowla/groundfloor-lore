#!/usr/bin/env tsx
/**
 * sync-wal-no-remote-gate-unit.ts — sync.wal grows unboundedly for a
 * workspace with no sync target configured.
 *
 * `WriteAheadLog.append()` logged every node/edge write unconditionally,
 * with no awareness of whether anything would ever consume the log.
 * `truncatePushed()` only removes an entry once a push to a real remote
 * confirms it landed — a workspace with `adapter === null` (the ordinary
 * single-operator local case; `resolveSyncAdapterFromEnv` returns null
 * exactly when no DATAPLANE_API_KEY is set, not a non-functional stub)
 * has no cycle that will ever call it. Found in the wild: one local-only
 * workspace's sync.wal reached 228,000 entries / 222MB, none of which were
 * ever going anywhere.
 *
 * T1/T2 test the mechanism directly (WriteAheadLog's `enabled` option).
 * T3/T4 test the REAL integration point — SyncEngine's constructor wiring
 * `adapter !== null` through — since the actual bug was in that wiring,
 * not in WriteAheadLog itself (which worked exactly as designed; it just
 * had no way to know sync was pointless).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteAheadLog } from '../packages/lore/src/engines/writeAheadLog.js';
import { SyncEngine, type SyncAdapter } from '../packages/lore/src/engines/syncEngine.js';
import type { LoreGraphHandle } from '../packages/lore/src/storage/loreStorageClient.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        failed++;
    }
}

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-wal-gate-'));
}

/** Minimal fake — only `push` is required by SyncAdapter; never actually
 *  called in these tests (append doesn't push, it only logs). */
const fakeAdapter: SyncAdapter = {
    push: async () => ({ pushed: 0, failed: 0 }),
};

/** A graph handle real enough for SyncEngine's constructor to accept —
 *  none of its methods are exercised by append(). */
const fakeGraph = {} as LoreGraphHandle;

console.log('\nsync.wal — no-remote-target gate\n');

await test('T1: WriteAheadLog with enabled:false is a true no-op — no file, no entry', async () => {
    const dir = makeTmpDir();
    try {
        const wal = new WriteAheadLog(dir, { enabled: false });
        wal.append('upsert_node', { id: 'n1' });
        wal.append('upsert_node', { id: 'n2' });
        assert.equal(fs.existsSync(path.join(dir, 'sync.wal')), false, 'disabled WAL must not even create the file');
        assert.equal(wal.pendingCount(), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('T2: WriteAheadLog defaults to enabled (no behaviour change for existing direct construction)', async () => {
    const dir = makeTmpDir();
    try {
        const wal = new WriteAheadLog(dir); // no opts — must match pre-fix behaviour
        wal.append('upsert_node', { id: 'n1' });
        assert.equal(fs.existsSync(path.join(dir, 'sync.wal')), true, 'default construction still logs, unchanged');
        assert.equal(wal.pendingCount(), 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('T3: a SyncEngine with adapter=null (no remote configured) writes NOTHING to sync.wal — the regression', async () => {
    const dir = makeTmpDir();
    try {
        const engine = new SyncEngine(fakeGraph, dir, null);
        engine.getWal().append('upsert_node', { id: 'n1', label: 'x'.repeat(1000) });
        engine.getWal().append('add_edge', { sourceId: 'n1', targetId: 'n2', relation: 'refers_to' });
        assert.equal(
            fs.existsSync(path.join(dir, 'sync.wal')),
            false,
            'no adapter means nothing will ever consume the log — it must not accumulate',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('T4: a SyncEngine with a REAL adapter still logs normally — the gate does not break the working path', async () => {
    const dir = makeTmpDir();
    try {
        const engine = new SyncEngine(fakeGraph, dir, fakeAdapter);
        engine.getWal().append('upsert_node', { id: 'n1' });
        assert.equal(fs.existsSync(path.join(dir, 'sync.wal')), true, 'a configured adapter must still log — this is the control case');
        assert.equal(engine.getWal().pendingCount(), 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
