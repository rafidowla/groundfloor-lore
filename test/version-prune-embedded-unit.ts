#!/usr/bin/env tsx
/**
 * test/version-prune-embedded-unit.ts — storage-growth fix 2/3 (R3), unit
 * coverage for the embedded-host counterpart to version-prune-scheduler-unit.ts.
 *
 * `versionPruneScheduler.ts`'s daemon-only sweep (`runVersionPruneSweep` +
 * `VersionStore.vacuum()`) never ran for a `createLore()` library host
 * (Atlas, MIRA, PM Helper) — `startsDaemonTimers` is false for all of them,
 * so `versions.sqlite` grew unbounded on exactly those hosts. This file
 * proves the new pieces in isolation, at store/scheduler granularity:
 *
 *   U1. `runEmbeddedVersionPruneSweep({store: null})` is a fail-soft no-op.
 *   U2. `retentionDaysByType` (Sprint 1's VersionHistoryPolicy) is honoured:
 *       a type with a short override is pruned even though a same-age row
 *       of an unlisted type survives on the 90-day default.
 *   U3. `skipTypes` rows are prunable immediately — no age requirement.
 *   U4. The reclaim step actually shrinks the file on disk, using
 *       `incrementalVacuum()` (not a full VACUUM) on a freshly created,
 *       `auto_vacuum=INCREMENTAL` file.
 *   U5. `incrementalVacuum()` is a documented no-op (`ran: false`) on a
 *       file that predates this change (still `auto_vacuum=NONE`) — the
 *       online/offline split boundary Sprint 3's offline tool exists for.
 *   U6. `scheduleVersionPruneSweep`'s `stop()` is idempotent and clears its
 *       handle so a `dispose()`d embedded host can't leak a live timer; and
 *       `runImmediately: true` fires an initial pass without waiting a full
 *       `intervalMs`.
 *
 * test/storage-growth-2-embedded.ts is the mandatory integration proof
 * (real `createLore()`) that this wiring actually runs on the embedded
 * path, not just that the underlying functions are correct in isolation —
 * same division of labour as version-prune-scheduler-unit.ts (store-level)
 * vs. version-no-op-embedded.ts (real path) in Sprint 1.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import {
    runEmbeddedVersionPruneSweep,
    scheduleVersionPruneSweep,
} from '../packages/lore/src/mcp/versionPruneScheduler.js';
import { resolveEffectiveVersionHistoryPolicy } from '../packages/lore/src/outbox/versionPruningPolicy.js';

/** Pruning is opt-in (owner decision 2026-09-29): every sweep test states its policy explicitly. */
const POLICY_90 = resolveEffectiveVersionHistoryPolicy({ pruning: { enabled: true, retentionDays: 90 } }, {});

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vprune-emb-'));
}

const BIG_STATE = JSON.stringify({ content: 'x'.repeat(20_000) });

function seedOld(store: VersionStore, nodeId: string, type: string, daysOld: number): void {
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'w',
        timestamp: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: null,
        newState: { type, content: 'x'.repeat(20_000) },
        changesetId: null,
    });
}

console.log('\nEmbedded version-prune sweep — storage-growth fix 2/3 (R3)\n');

await test('U1: runEmbeddedVersionPruneSweep tolerates a missing store as a fail-soft no-op', async () => {
    const result = await runEmbeddedVersionPruneSweep({ store: null });
    assert.deepEqual(result, { softCompacted: 0, hardDeleted: 0, vacuumed: false, incrementalVacuumRan: false });
});

await test('U2: retentionDaysByType overrides the default per type; unlisted types keep the default', async () => {
    const dir = makeTmpDir();
    try {
        const store = VersionStore.open(dir);
        store.setHistoryPolicy({ retentionDaysByType: { note: 1 } });

        // 5 days old: past the 1-day override for 'note', well under the
        // 90-day default that 'decision' (unlisted) still gets.
        for (let i = 0; i < 5; i++) seedOld(store, `note-${i}`, 'note', 5);
        for (let i = 0; i < 5; i++) seedOld(store, `decision-${i}`, 'decision', 5);

        const result = await runEmbeddedVersionPruneSweep({ store, policy: POLICY_90 });

        assert.equal(result.hardDeleted, 5, `expected exactly the 5 'note' rows hard-deleted, got ${result.hardDeleted}`);
        for (let i = 0; i < 5; i++) {
            assert.equal(store.getVersions(`note-${i}`, 'w').length, 0, `note-${i} must be pruned (type override)`);
        }
        for (let i = 0; i < 5; i++) {
            assert.equal(store.getVersions(`decision-${i}`, 'w').length, 1, `decision-${i} must survive (default retention, only 5 days old)`);
        }

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('U3: skipTypes rows are prunable immediately, regardless of age', async () => {
    const dir = makeTmpDir();
    try {
        const store = VersionStore.open(dir);
        store.setHistoryPolicy({ skipTypes: ['scratch'] });

        // Both rows are seconds old — nowhere near any retention window.
        seedOld(store, 'scratch-1', 'scratch', 0);
        seedOld(store, 'decision-1', 'decision', 0);

        const result = await runEmbeddedVersionPruneSweep({ store, policy: POLICY_90 });

        assert.equal(result.hardDeleted, 1, `expected the 1 'scratch' row pruned immediately, got ${result.hardDeleted}`);
        assert.equal(store.getVersions('scratch-1', 'w').length, 0, 'skipTypes row must be gone even though it is brand new');
        assert.equal(store.getVersions('decision-1', 'w').length, 1, 'ordinary type must still survive (recent, default retention)');

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('U4: incrementalVacuum shrinks a fresh (auto_vacuum=INCREMENTAL) file on disk', async () => {
    const dir = makeTmpDir();
    try {
        const store = VersionStore.open(dir);
        for (let i = 0; i < 300; i++) seedOld(store, `n${i}`, 'note', 200);
        const filePath = path.join(dir, 'versions.sqlite');
        const sizeBefore = fs.statSync(filePath).size;

        const result = await runEmbeddedVersionPruneSweep({ store, policy: POLICY_90 });
        assert.equal(result.incrementalVacuumRan, true, 'a freshly created store must be auto_vacuum=INCREMENTAL');

        const sizeAfter = fs.statSync(filePath).size;
        console.log(`      ${sizeBefore.toLocaleString()} bytes -> ${sizeAfter.toLocaleString()} bytes`);
        assert.ok(
            sizeAfter < sizeBefore * 0.5,
            `incrementalVacuum must reclaim the freed pages (before=${sizeBefore}, after=${sizeAfter})`,
        );

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('U5: incrementalVacuum is a documented no-op on a file that predates auto_vacuum=INCREMENTAL', async () => {
    const dir = makeTmpDir();
    try {
        // Simulate a legacy versions.sqlite: create the file BEFORE
        // VersionStore.open() ever sees it, with no auto_vacuum pragma set
        // (SQLite's own default is NONE) — exactly what every pre-Sprint-2
        // store on disk looks like today.
        const filePath = path.join(dir, 'versions.sqlite');
        const legacy = new Database(filePath);
        legacy.close();

        const store = VersionStore.open(dir); // isNewFile=false — INCREMENTAL is never set
        for (let i = 0; i < 50; i++) seedOld(store, `legacy-${i}`, 'note', 200);

        const result = await runEmbeddedVersionPruneSweep({ store, policy: POLICY_90 });
        assert.equal(result.hardDeleted, 50, 'prune + hard-delete still run normally on a legacy file');
        assert.equal(result.incrementalVacuumRan, false, 'incrementalVacuum must no-op — file is not auto_vacuum=INCREMENTAL');

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('U6: scheduleVersionPruneSweep — runImmediately fires a pass, and stop() is idempotent', async () => {
    let runs = 0;
    const scheduler = scheduleVersionPruneSweep(
        async () => { runs++; return { softCompacted: 0, hardDeleted: 0, vacuumed: true }; },
        24 * 60 * 60 * 1000, // interval large enough that only the immediate kickoff can have fired
        { runImmediately: true },
    );
    // The immediate pass runs off a zero-delay, unref'd setTimeout — give
    // the event loop a turn to reach it.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runs, 1, 'runImmediately must fire exactly one pass without waiting a full intervalMs');

    await scheduler.stop();
    await scheduler.stop(); // idempotent — must not throw
    assert.equal(runs, 1, 'stop() must not trigger an extra pass');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
