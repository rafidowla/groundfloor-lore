#!/usr/bin/env tsx
/**
 * outbox-claim-before-replay-unit.ts — 3.26.0: the replicator claims an outbox
 * row before it replays it, and runs one tick at a time.
 *
 * Before: `replicateOne` set the row to 'replicating' unconditionally and
 * dispatched it. The row came from a `listPendingForWorkspace` snapshot taken
 * earlier in the tick, so nothing re-checked its status:
 *
 *   - two overlapping ticks (the background loop and `awaitEmbeds()`'s
 *     `tickOnce()`, or two replayers on one outbox) both listed the row as
 *     pending and both dispatched it;
 *   - a row a rolled-back write had already retracted (`removeIfPending`) was
 *     still dispatched from the stale snapshot.
 *
 * Now: `OutboxStore.claimForReplication(id)` flips `pending`/`failed` →
 * `replicating` atomically and says whether it did; an unclaimed row is not
 * dispatched. `OutboxReplicator` also serialises its own ticks.
 *
 * Run: npx tsx test/outbox-claim-before-replay-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const dirs: string[] = [];
function mkDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-claim-'));
    dirs.push(dir);
    return dir;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const WS = 'ws1';

async function recordUpsert(store: OutboxStore, id: string) {
    return recordHotWrite(store, {
        workspace: WS, operationKind: 'node.upsert', payload: { id, type: 'note', label: id }, operation: 'graph.upsert',
    });
}

console.log('\noutbox — claim before replay (3.26.0)\n');

for (const [label, make] of [
    ['SqliteOutboxStore', (dir: string) => new SqliteOutboxStore(dir, { retryBaseMs: 20 }) as OutboxStore & { close?: () => void }],
    ['FileOutboxStore', (dir: string) => new FileOutboxStore(dir) as OutboxStore & { close?: () => void }],
] as const) {
    await test(`${label}: a pending row is claimed exactly once`, async () => {
        const store = make(mkDir());
        const entry = await recordUpsert(store, 'n1');
        assert.equal(typeof store.claimForReplication, 'function', 'the store implements claimForReplication');
        assert.equal(await store.claimForReplication!(entry.id), true, 'first claim wins');
        assert.equal(await store.claimForReplication!(entry.id), false, 'a second claim of a held row is refused');
        assert.equal((await store.listPendingForWorkspace!(WS, 10)).length, 0, 'a claimed row is no longer pending');
        store.close?.();
    });

    await test(`${label}: a failed row can be claimed again; an applied row cannot`, async () => {
        const store = make(mkDir());
        const entry = await recordUpsert(store, 'n2');
        assert.equal(await store.claimForReplication!(entry.id), true);
        await store.markEntryStatus!(entry.id, 'failed', { error: 'boom' });
        // The SQLite store stamps a retry time on a failed row (20 ms base
        // here); the file store has no back-off.
        await sleep(120);
        assert.equal(await store.claimForReplication!(entry.id), true, 'a failed row is claimable for its retry');
        await store.markEntryStatus!(entry.id, 'replicated');
        assert.equal(await store.claimForReplication!(entry.id), false, 'an applied row is never claimed again');
        store.close?.();
    });

    await test(`${label}: a missing row is not claimable`, async () => {
        const store = make(mkDir());
        assert.equal(await store.claimForReplication!('no-such-row'), false);
        store.close?.();
    });

    await test(`${label}: a retracted row (removeIfPending) is not claimable`, async () => {
        const store = make(mkDir());
        const entry = await recordUpsert(store, 'n3');
        assert.equal(await store.removeIfPending!(entry.id), true);
        assert.equal(await store.claimForReplication!(entry.id), false);
        store.close?.();
    });

    await test(`${label}: a claimed row cannot be retracted (the writer must compensate instead)`, async () => {
        const store = make(mkDir());
        const entry = await recordUpsert(store, 'n4');
        assert.equal(await store.claimForReplication!(entry.id), true);
        assert.equal(await store.removeIfPending!(entry.id), false);
        store.close?.();
    });
}

await test('SqliteOutboxStore: a failed row is not claimable before its retry time', async () => {
    const store = new SqliteOutboxStore(mkDir(), { retryBaseMs: 60_000 });
    const entry = await recordUpsert(store, 'backoff');
    assert.equal(await store.claimForReplication(entry.id), true);
    await store.markEntryStatus(entry.id, 'failed', { error: 'boom' });
    assert.equal(await store.claimForReplication(entry.id), false, 'the claim honours the same back-off the listing does');
    assert.equal((await store.listPendingForWorkspace(WS, 10)).length, 0);
    store.close();
});

await test('two overlapping ticks of one replicator replay a row once', async () => {
    const store = new SqliteOutboxStore(mkDir());
    await recordUpsert(store, 'overlap');
    const upserts: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async (p) => { await sleep(40); upserts.push(String(p['id'])); },
    };
    const r = new OutboxReplicator({ store, substrates, log: () => undefined });
    await Promise.all([r.tickOnce(), r.tickOnce()]);
    assert.deepEqual(upserts, ['overlap'], 'the row is dispatched exactly once');
    assert.equal((await store.listPendingForWorkspace(WS, 10)).length, 0);
    assert.equal(r.getStats().replicated, 1);
    store.close();
});

await test('two replayers on one outbox replay a row once (claim, not the tick gate)', async () => {
    const store = new SqliteOutboxStore(mkDir());
    await recordUpsert(store, 'two-replayers');
    const upserts: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async (p) => { await sleep(40); upserts.push(String(p['id'])); },
    };
    const a = new OutboxReplicator({ store, substrates, log: () => undefined });
    const b = new OutboxReplicator({ store, substrates, log: () => undefined });
    await Promise.all([a.tickOnce(), b.tickOnce()]);
    assert.deepEqual(upserts, ['two-replayers'], 'only the replayer that claimed the row dispatches it');
    assert.equal(a.getStats().replicated + b.getStats().replicated, 1);
    store.close();
});

await test('a row retracted after the tick listed it is not dispatched', async () => {
    const real = new SqliteOutboxStore(mkDir());
    const kept = await recordUpsert(real, 'kept');
    const retracted = await recordUpsert(real, 'retracted');
    // The tick's snapshot still names the row; the writer's rollback retracts
    // it before the replicator reaches it.
    const store = new Proxy(real, {
        get(target, prop, receiver) {
            if (prop === 'listPendingForWorkspace') {
                return async (ws: string, limit: number) => {
                    const snapshot = await target.listPendingForWorkspace(ws, limit);
                    await target.removeIfPending(retracted.id);
                    return snapshot;
                };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as SqliteOutboxStore;
    const upserts: string[] = [];
    const substrates: DispatcherSubstrates = { upsertNode: async (p) => { upserts.push(String(p['id'])); } };
    const r = new OutboxReplicator({ store, substrates, log: () => undefined });
    await r.tickOnce();
    assert.deepEqual(upserts, ['kept'], 'the retracted row must not be replayed');
    assert.equal(kept.id.length > 0, true);
    real.close();
});

await test('a store without claimForReplication still replays (legacy stores)', async () => {
    const real = new SqliteOutboxStore(mkDir());
    await recordUpsert(real, 'legacy');
    const store = new Proxy(real, {
        get(target, prop, receiver) {
            if (prop === 'claimForReplication') return undefined;
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as SqliteOutboxStore;
    const upserts: string[] = [];
    const r = new OutboxReplicator({
        store, substrates: { upsertNode: async (p) => { upserts.push(String(p['id'])); } }, log: () => undefined,
    });
    await r.tickOnce();
    assert.deepEqual(upserts, ['legacy']);
    real.close();
});

for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
