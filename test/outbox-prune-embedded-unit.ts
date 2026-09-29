#!/usr/bin/env tsx
/**
 * test/outbox-prune-embedded-unit.ts — storage-growth fix 2/3 (R4), unit
 * coverage for outbox hygiene at store/replicator granularity.
 *
 * `OutboxReplicator.runPruneSweep()` already existed (SP-F2) and already
 * pruned `status='replicated'` rows on the replicator's own self-heal
 * cadence — but that loop only runs for a daemon-owned process
 * (`startsDaemonTimers`). Every `createLore()` library host (Atlas, MIRA,
 * PM Helper) never started that loop, so `outbox.sqlite` grew unbounded on
 * exactly those hosts, same shape as R3's versions.sqlite problem. This
 * file proves the pieces server.ts's `scheduleOutboxOpenPruneSweep` calls,
 * in isolation:
 *
 *   O1. `runPruneSweep({force: true})` deletes 'replicated' rows older than
 *       the retention window, and `force` bypasses only the CADENCE gate.
 *   O2. `pending`, `replicating`, `failed` and `dead` rows are NEVER
 *       touched, regardless of age — operator-triage / in-flight state.
 *   O3. A recent 'replicated' row (inside the window) survives.
 *   O4. `pruneReplicatedOlderThanMs <= 0` (retention disabled) is still
 *       honoured even with `force: true` — force bypasses the cadence gate
 *       only, never the disable switch (see runPruneSweep's own doc
 *       comment in replicator.ts).
 *   O5. `SqliteOutboxStore.incrementalVacuum()` shrinks a fresh
 *       (auto_vacuum=INCREMENTAL) file after a prune frees pages.
 *   O6. `incrementalVacuum()` is a documented no-op on a file that
 *       predates this change (still auto_vacuum=NONE).
 *
 * test/storage-growth-2-embedded.ts is the mandatory integration proof
 * (real `createLore()`) that the deferred prune-on-open sweep actually
 * runs on the embedded path.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { OutboxEntry, OutboxStatus } from '../packages/lore/src/outbox/types.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-outbox-prune-emb-'));
}

/** No `runPruneSweep` path ever calls a substrate — the replicator only
 *  reaches `this.store.pruneReplicated` via the store's own optional hook,
 *  never `this.substrates`. A stub satisfies the constructor's required
 *  field without standing up a real dispatcher for a prune-only test. */
const UNUSED_SUBSTRATES = {} as unknown as DispatcherSubstrates;

async function seedEntry(
    store: SqliteOutboxStore,
    opts: { id?: string; workspace?: string; status: OutboxStatus; ageDays: number },
): Promise<void> {
    const ts = new Date(Date.now() - opts.ageDays * 86_400_000).toISOString();
    const entry: OutboxEntry = {
        id: opts.id ?? randomUUID(),
        operation: 'test.op',
        initiator: 'test:seed',
        createdAt: ts,
        updatedAt: ts,
        steps: [],
        completed: opts.status === 'replicated',
        workspace: opts.workspace ?? 'w',
        operationKind: 'sync.vector.mirror',
        status: opts.status,
        attempts: 0,
        replicatedAt: opts.status === 'replicated' ? ts : undefined,
    };
    await store.record(entry);
}

console.log('\nOutbox prune-on-open — storage-growth fix 2/3 (R4)\n');

await test('O1: runPruneSweep({force:true}) deletes replicated rows past the retention window', async () => {
    const dir = makeTmpDir();
    try {
        const store = new SqliteOutboxStore(dir);
        await seedEntry(store, { id: 'old-replicated', status: 'replicated', ageDays: 30 });

        const replicator = new OutboxReplicator({
            store,
            substrates: UNUSED_SUBSTRATES,
            config: { pruneReplicatedOlderThanMs: 7 * 86_400_000 }, // 7 days
        });

        const deleted = await replicator.runPruneSweep({ force: true });
        assert.equal(deleted, 1, `expected 1 row pruned, got ${deleted}`);

        const remaining = await store.listUnfinished();
        assert.equal(remaining.length, 0, 'no unfinished rows should exist either way');
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test("O2: pending/replicating/failed/dead rows are never pruned, regardless of age", async () => {
    const dir = makeTmpDir();
    try {
        const store = new SqliteOutboxStore(dir);
        await seedEntry(store, { id: 'p', status: 'pending', ageDays: 400 });
        await seedEntry(store, { id: 'r', status: 'replicating', ageDays: 400 });
        await seedEntry(store, { id: 'f', status: 'failed', ageDays: 400 });
        await seedEntry(store, { id: 'd', status: 'dead', ageDays: 400 });

        const replicator = new OutboxReplicator({
            store,
            substrates: UNUSED_SUBSTRATES,
            config: { pruneReplicatedOlderThanMs: 7 * 86_400_000 },
        });

        const deleted = await replicator.runPruneSweep({ force: true });
        assert.equal(deleted, 0, `expected 0 rows pruned (none are replicated), got ${deleted}`);

        const dead = await store.listDead();
        assert.equal(dead.length, 1, 'the dead row must survive untouched');
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('O3: a recent replicated row (inside the retention window) survives', async () => {
    const dir = makeTmpDir();
    try {
        const store = new SqliteOutboxStore(dir);
        await seedEntry(store, { id: 'recent', status: 'replicated', ageDays: 1 });

        const replicator = new OutboxReplicator({
            store,
            substrates: UNUSED_SUBSTRATES,
            config: { pruneReplicatedOlderThanMs: 7 * 86_400_000 },
        });

        const deleted = await replicator.runPruneSweep({ force: true });
        assert.equal(deleted, 0, `1-day-old row must survive a 7-day retention window, got ${deleted} deleted`);
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('O4: force bypasses only the cadence gate — a disabled retention window (<=0) still wins', async () => {
    const dir = makeTmpDir();
    try {
        const store = new SqliteOutboxStore(dir);
        await seedEntry(store, { id: 'old-replicated', status: 'replicated', ageDays: 400 });

        const replicator = new OutboxReplicator({
            store,
            substrates: UNUSED_SUBSTRATES,
            config: { pruneReplicatedOlderThanMs: 0 }, // disabled
        });

        const deleted = await replicator.runPruneSweep({ force: true });
        assert.equal(deleted, 0, `retention disabled (<=0) must win even with force:true, got ${deleted} deleted`);
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('O5: incrementalVacuum shrinks a fresh (auto_vacuum=INCREMENTAL) outbox.sqlite on disk', async () => {
    const dir = makeTmpDir();
    try {
        const store = new SqliteOutboxStore(dir);
        // Bulk of replicated rows with a large payload, then prune them all
        // so there is something for incrementalVacuum to reclaim.
        for (let i = 0; i < 300; i++) {
            await store.record({
                id: `bulk-${i}`,
                operation: 'test.op',
                initiator: 'test:seed',
                createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
                updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
                steps: [],
                completed: true,
                workspace: 'w',
                operationKind: 'sync.vector.mirror',
                status: 'replicated',
                attempts: 0,
                replicatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
                payload: { blob: 'x'.repeat(20_000) },
            });
        }

        const filePath = path.join(dir, 'outbox.sqlite');
        const replicator = new OutboxReplicator({
            store,
            substrates: UNUSED_SUBSTRATES,
            config: { pruneReplicatedOlderThanMs: 7 * 86_400_000 },
        });
        const deleted = await replicator.runPruneSweep({ force: true });
        assert.equal(deleted, 300, `expected all 300 seeded rows pruned, got ${deleted}`);

        const sizeBefore = fs.statSync(filePath).size;
        const result = store.incrementalVacuum!();
        assert.equal(result.ran, true, 'a freshly created store must be auto_vacuum=INCREMENTAL');
        const sizeAfter = fs.statSync(filePath).size;
        console.log(`      ${sizeBefore.toLocaleString()} bytes -> ${sizeAfter.toLocaleString()} bytes`);
        assert.ok(sizeAfter < sizeBefore, `incrementalVacuum must shrink the file (before=${sizeBefore}, after=${sizeAfter})`);

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('O6: incrementalVacuum is a documented no-op on a file that predates auto_vacuum=INCREMENTAL', async () => {
    const dir = makeTmpDir();
    try {
        // Simulate a legacy outbox.sqlite: create the raw file BEFORE
        // SqliteOutboxStore ever sees it, with SQLite's own default
        // auto_vacuum=NONE — exactly what every pre-Sprint-2 store on disk
        // looks like today.
        const filePath = path.join(dir, 'outbox.sqlite');
        const legacy = new Database(filePath);
        legacy.close();

        const store = new SqliteOutboxStore(dir); // isNewFile=false — INCREMENTAL is never set
        const result = store.incrementalVacuum!();
        assert.equal(result.ran, false, 'incrementalVacuum must no-op — file is not auto_vacuum=INCREMENTAL');
        assert.equal(result.autoVacuumMode, 0, 'legacy file must report NONE (0)');

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
