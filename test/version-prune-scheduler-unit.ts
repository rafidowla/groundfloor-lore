#!/usr/bin/env tsx
/**
 * version-prune-scheduler-unit.ts — versions.sqlite grows unboundedly
 * because `pruneVersions()` (Feature 8, 2026-05-26) was never wired to
 * anything. Found in the wild: one workspace's versions.sqlite reached
 * 896MB against a healthy sibling's ~130MB for a comparable node count.
 *
 * Two defects in one, both fixed here:
 *   1. Nothing called pruneVersions() at all — dead code since it shipped.
 *   2. Even called, it would not have helped: pruneVersions only sets
 *      compacted=1 (soft-delete). No read path ever returns a compacted
 *      row (getVersionHistory / getChangesSince both filter compacted=0),
 *      so retaining them serves no purpose, and SQLite does not shrink a
 *      file on DELETE without VACUUM regardless.
 *
 * T1/T2 exercise the REAL scheduler entry point (runVersionPruneSweep), not
 * just the store methods in isolation — the actual bug was the missing
 * wiring, so the test has to prove the wiring works, not just that the
 * underlying SQL is correct.
 *
 * T3 proves the file genuinely shrinks on disk, not just that rows vanish
 * from a query — that's the gap soft-delete-only would have left even if
 * someone HAD wired up the old pruneVersions alone.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { runVersionPruneSweep } from '../packages/lore/src/mcp/versionPruneScheduler.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vprune-'));
}

/** A big payload so real writes visibly move the file size, matching the
 *  real-world shape (node content, not a one-byte stub). */
const BIG_STATE = JSON.stringify({ content: 'x'.repeat(20_000) });

console.log('\nVersion-prune scheduler — versions.sqlite growth\n');

await test('T1: runVersionPruneSweep tolerates a missing store (boot-open failure) as a no-op, not a throw', async () => {
    const result = await runVersionPruneSweep({ store: null });
    assert.deepEqual(result, { softCompacted: 0, hardDeleted: 0, vacuumed: false });
});

await test('T2: the real scheduler entry point actually prunes AND hard-deletes old rows', async () => {
    const dir = makeTmpDir();
    try {
        const store = VersionStore.open(dir);
        const oldTimestamp = new Date(Date.now() - 200 * 86_400_000).toISOString(); // 200 days old
        for (let i = 0; i < 50; i++) {
            store.recordVersion({
                versionId: randomUUID(),
                nodeId: `n${i}`,
                workspace: 'w',
                timestamp: oldTimestamp,
                principal: 'test',
                operation: 'upsert',
                previousState: null,
                newState: BIG_STATE,
                changesetId: null,
            });
        }
        // A protected row, and a recent row — both must survive. recordVersion
        // JSON.stringifies newState itself, so this must be passed as an
        // object — a pre-stringified string would be double-encoded and the
        // pruneVersions LIKE-match against '"status":"protected"' would miss it.
        store.recordVersion({
            versionId: randomUUID(), nodeId: 'protected-1', workspace: 'w',
            timestamp: oldTimestamp, principal: 'test', operation: 'upsert',
            previousState: null, newState: { status: 'protected' }, changesetId: null,
        });
        store.recordVersion({
            versionId: randomUUID(), nodeId: 'recent-1', workspace: 'w',
            timestamp: new Date().toISOString(), principal: 'test', operation: 'upsert',
            previousState: null, newState: BIG_STATE, changesetId: null,
        });

        // THE REAL ENTRY POINT — same call the scheduler makes on its timer.
        const result = await runVersionPruneSweep({ store, retentionDays: 90 });

        assert.equal(result.softCompacted, 50, 'the 50 old, unprotected rows were soft-compacted');
        assert.equal(result.hardDeleted, 50, 'and then hard-deleted in the same pass');
        assert.equal(result.vacuumed, true);

        // Survivors: protected row (any age) + recent row. Both readable.
        const protectedHistory = store.getVersions('protected-1', 'w');
        assert.equal(protectedHistory.length, 1, 'protected row survives regardless of age');
        const recentHistory = store.getVersions('recent-1', 'w');
        assert.equal(recentHistory.length, 1, 'recent row survives (under retention window)');

        // The 50 pruned rows are gone, not just hidden.
        const goneHistory = store.getVersions('n0', 'w');
        assert.equal(goneHistory.length, 0, 'a pruned row no longer returns from getVersionHistory');

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('T3: the file actually shrinks on disk — soft-delete alone would not have', async () => {
    const dir = makeTmpDir();
    try {
        const store = VersionStore.open(dir);
        const oldTimestamp = new Date(Date.now() - 200 * 86_400_000).toISOString();
        for (let i = 0; i < 300; i++) {
            store.recordVersion({
                versionId: randomUUID(), nodeId: `n${i}`, workspace: 'w',
                timestamp: oldTimestamp, principal: 'test', operation: 'upsert',
                previousState: null, newState: BIG_STATE, changesetId: null,
            });
        }
        const filePath = path.join(dir, 'versions.sqlite');
        const sizeBefore = fs.statSync(filePath).size;

        await runVersionPruneSweep({ store, retentionDays: 90 });

        const sizeAfter = fs.statSync(filePath).size;
        console.log(`      ${sizeBefore.toLocaleString()} bytes -> ${sizeAfter.toLocaleString()} bytes`);
        assert.ok(
            sizeAfter < sizeBefore * 0.5,
            `VACUUM must reclaim the freed pages — file should shrink substantially (before=${sizeBefore}, after=${sizeAfter})`,
        );

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
