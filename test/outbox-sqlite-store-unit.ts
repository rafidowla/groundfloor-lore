#!/usr/bin/env tsx
/**
 * test/outbox-sqlite-store-unit.ts — Sprint O3c SQLite outbox tests.
 *
 * Mirrors test/outbox-foundation-unit.ts cases against
 * SqliteOutboxStore (the O3c replacement for FileOutboxStore) plus
 * adds a migration smoke test.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}: ${(err as Error).message}`);
        failed++;
    }
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-sqlite-'));
}

function nowIso(): string { return new Date().toISOString(); }

function newEntry(opts: Partial<OutboxEntry> & { id: string }): OutboxEntry {
    return {
        id: opts.id,
        operation: opts.operation ?? 'test.op',
        initiator: opts.initiator ?? 'test:rafi',
        createdAt: opts.createdAt ?? nowIso(),
        updatedAt: opts.updatedAt ?? nowIso(),
        steps: opts.steps ?? [{ kind: 'noop', status: 'pending' }],
        completed: opts.completed ?? false,
        workspace: opts.workspace,
        operationKind: opts.operationKind,
        payload: opts.payload,
        status: opts.status,
        sequenceId: opts.sequenceId,
    };
}

console.log('Sprint O3c SqliteOutboxStore unit tests');

await test('1. record + listUnfinished round-trip carries universal-write fields', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1', type: 'decision', label: 'X' },
    }));
    const unfinished = await store.listUnfinished();
    assert.equal(unfinished.length, 1);
    assert.equal(unfinished[0]?.workspace, 'alpha');
    assert.equal(unfinished[0]?.operationKind, 'node.upsert');
    assert.equal(unfinished[0]?.sequenceId, 1);
    assert.equal(unfinished[0]?.status, 'pending');
    assert.equal(unfinished[0]?.attempts, 0);
    assert.equal(unfinished[0]?.payload?.label, 'X');
    store.close();
});

await test('2. per-workspace sequenceId allocator is monotonic + isolated', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    await store.record(newEntry({ id: 'a1', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n1' } }));
    await store.record(newEntry({ id: 'a2', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n2' } }));
    await store.record(newEntry({ id: 'b1', operationKind: 'node.upsert', workspace: 'beta', payload: { id: 'n3' } }));
    await store.record(newEntry({ id: 'a3', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n4' } }));
    const all = await store.listUnfinished();
    const byId = Object.fromEntries(all.map(e => [e.id, e.sequenceId]));
    assert.equal(byId['a1'], 1);
    assert.equal(byId['a2'], 2);
    assert.equal(byId['b1'], 1);
    assert.equal(byId['a3'], 3);
    store.close();
});

await test('3. workspace-required invariant — new-shape entry without workspace throws', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    await assert.rejects(
        () => store.record(newEntry({ id: 'bad', operationKind: 'node.upsert', payload: { id: 'n1' } })),
        /workspace is required/,
    );
    await store.record(newEntry({ id: 'legacy', steps: [{ kind: 'sync.vector.mirror', status: 'pending', payload: { nodeIds: ['x'] } }] }));
    const all = await store.listUnfinished();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.workspace, 'default');
    assert.equal(all[0]?.operationKind, 'sync.vector.mirror');
    store.close();
});

await test('4. replicator processes pending → replicated via stub substrate', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    let calls = 0;
    const substrates: DispatcherSubstrates = {
        upsertNode: async (p) => { void p; calls++; },
    };
    const replicator = new OutboxReplicator({ store, substrates });
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1', type: 'decision', label: 'X' },
    }));
    const processed = await replicator.tickOnce();
    assert.equal(processed, 1);
    assert.equal(calls, 1);
    const pending = await store.listPendingForWorkspace!('alpha', 10);
    assert.equal(pending.length, 0);
    const cursor = await store.readReplicationState!('alpha');
    assert.equal(cursor.lastReplicatedSeq, 1);
    store.close();
});

await test('5. replicator marks dead after maxAttempts when substrate throws', async () => {
    const store = new SqliteOutboxStore(tmpDir(), { retryBaseMs: 0 });
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('flaky'); },
    };
    const replicator = new OutboxReplicator({ store, substrates, config: { maxAttempts: 3 } });
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1' },
    }));
    await replicator.tickOnce();
    await replicator.tickOnce();
    await replicator.tickOnce();
    const pending = await store.listPendingForWorkspace!('alpha', 10);
    assert.equal(pending.length, 0, 'no more pending after dead');
    const all = await store.listUnfinished();
    assert.equal(all[0]?.status, 'dead');
    assert.equal(all[0]?.attempts, 3);
    store.close();
});

await test('6. crash recovery — replicator skips rows already covered by cursor', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    let calls = 0;
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { calls++; },
    };
    await store.record(newEntry({ id: 'e1', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n1' } }));
    await store.record(newEntry({ id: 'e2', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n2' } }));
    await store.record(newEntry({ id: 'e3', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n3' } }));
    await store.markEntryStatus!('e1', 'replicated');
    await store.markEntryStatus!('e2', 'replicated');
    await store.writeReplicationState!('alpha', { lastReplicatedSeq: 2, updatedAt: nowIso() });
    const replicator = new OutboxReplicator({ store, substrates });
    const processed = await replicator.tickOnce();
    assert.equal(processed, 1, 'only e3 should be processed');
    assert.equal(calls, 1);
    const cursor = await store.readReplicationState!('alpha');
    assert.equal(cursor.lastReplicatedSeq, 3);
    store.close();
});

await test('7. idempotency — replay 3× produces 3 substrate calls but single logical row', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    const written = new Map<string, Record<string, unknown>>();
    const substrates: DispatcherSubstrates = {
        upsertNode: async (p) => { written.set(String(p['id']), p); },
    };
    const replicator = new OutboxReplicator({ store, substrates });
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1', label: 'X' },
    }));
    await replicator.tickOnce();
    await store.markEntryStatus!('e1', 'pending');
    await replicator.tickOnce();
    await store.markEntryStatus!('e1', 'pending');
    await replicator.tickOnce();
    assert.equal(written.size, 1);
    assert.equal(written.get('n1')?.label, 'X');
    store.close();
});

await test('8. statsByWorkspace + aggregateStats — depth + lag math', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1' }, createdAt: longAgo,
    }));
    await store.record(newEntry({
        id: 'e2', operationKind: 'node.upsert', workspace: 'beta',
        payload: { id: 'n2' },
    }));
    const stats = await store.statsByWorkspace!();
    assert.equal(stats['alpha']?.depth, 1);
    assert.ok((stats['alpha']?.lagSeconds ?? 0) >= 55, `alpha lag should be ~60s, got ${stats['alpha']?.lagSeconds}`);
    assert.equal(stats['beta']?.depth, 1);
    const agg = await store.aggregateStats!();
    assert.equal(agg.depth, 2);
    assert.ok(agg.lagSeconds >= 55);
    store.close();
});

await test('9. batchRecord(1000) — single-transaction perf + correctness', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    const N = 1000;
    const entries: OutboxEntry[] = [];
    const base = nowIso();
    for (let i = 0; i < N; i++) {
        entries.push(newEntry({
            id: `bulk-${i}`,
            operationKind: 'node.upsert',
            workspace: 'bulk-ws',
            payload: { id: `n-${i}`, label: `node ${i}` },
            createdAt: base,
        }));
    }
    const t0 = Date.now();
    await store.batchRecord!(entries);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `batchRecord(1000) should be <2s, got ${elapsed}ms`);
    const all = await store.listPendingForWorkspace!('bulk-ws', 1500);
    assert.equal(all.length, N);
    // sequenceIds must be contiguous 1..N within bulk-ws.
    const seqs = all.map(e => e.sequenceId).sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.equal(seqs[0], 1);
    assert.equal(seqs[N - 1], N);
    store.close();
});

await test('10. migration — pre-seed outbox.json, init store, verify SQLite populated', async () => {
    const dir = tmpDir();
    const legacyMap: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
        legacyMap[`legacy-${i}`] = {
            id: `legacy-${i}`,
            operation: 'sync.vector.mirror',
            initiator: 'system:syncEngine',
            createdAt: new Date(2026, 4, 1, 0, 0, i).toISOString(),
            updatedAt: new Date(2026, 4, 1, 0, 0, i).toISOString(),
            steps: [{ kind: 'sync.vector.mirror', status: i % 3 === 0 ? 'done' : 'pending' }],
            completed: i % 3 === 0,
        };
    }
    fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify(legacyMap));
    fs.writeFileSync(
        path.join(dir, 'outbox-replication.json'),
        JSON.stringify({ default: { lastReplicatedSeq: 7, updatedAt: nowIso() } }),
    );
    const store = new SqliteOutboxStore(dir);
    const report = store.migrateFromJson();
    assert.equal(report.migratedEntries, 25);
    assert.equal(report.migratedRepl, 1);
    assert.ok(!report.error, `migration should not error: ${report.error ?? ''}`);
    // outbox.json should be renamed.
    assert.ok(!fs.existsSync(path.join(dir, 'outbox.json')));
    const files = fs.readdirSync(dir);
    assert.ok(files.some(f => f.startsWith('outbox.json.migrated-')), `expected migrated rename, got ${files.join(',')}`);
    const all = await store.listUnfinished();
    // 25 total minus ~9 completed (i % 3 == 0 → indices 0,3,6,9,12,15,18,21,24 = 9)
    assert.equal(all.length, 25 - 9);
    const cursor = await store.readReplicationState!('default');
    assert.equal(cursor.lastReplicatedSeq, 7);
    // Re-running migration on populated SQLite is a no-op (idempotent).
    const second = store.migrateFromJson();
    assert.equal(second.migratedEntries, 0);
    store.close();
});

await test('11. crash + reopen — entries persist across SqliteOutboxStore close + reopen', async () => {
    const dir = tmpDir();
    const s1 = new SqliteOutboxStore(dir);
    await s1.record(newEntry({
        id: 'persist-1', operationKind: 'node.upsert', workspace: 'gamma',
        payload: { id: 'p1' },
    }));
    await s1.writeReplicationState!('gamma', { lastReplicatedSeq: 0, updatedAt: nowIso() });
    s1.close();
    const s2 = new SqliteOutboxStore(dir);
    const all = await s2.listUnfinished();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, 'persist-1');
    s2.close();
});

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('');
console.log(`OK: ${passed} cases pass.`);
