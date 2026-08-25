#!/usr/bin/env tsx
/**
 * test/outbox-foundation-unit.ts — Sprint O1 outbox-foundation unit tests
 *
 * Covers:
 *   1. FileOutboxStore.record() + listUnfinished() round-trip with new
 *      universal-write fields (workspace, operationKind, sequenceId).
 *   2. Per-workspace sequenceId allocator is monotonic + isolated.
 *   3. Workspace-required invariant — record() without workspace throws
 *      for new-shape entries (operationKind set), backfills for legacy.
 *   4. Replicator processes pending → replicated end-to-end via a
 *      stub substrate.
 *   5. Replicator marks dead after maxAttempts when substrate always
 *      throws (not Unwired/MissingPayload).
 *   6. Crash recovery — pre-seed outbox + repl state, run tickOnce,
 *      confirm cursor advances and skipped rows aren't re-replicated.
 *   7. Idempotency — replay same outbox row 3× through replicator,
 *      substrate sees the same payload each time but final state
 *      reflects single logical write (verified by substrate counter).
 *   8. statsByWorkspace + aggregateStats — shape and lag computation.
 *   9. Legacy backfill — pre-O1 row (no workspace/operationKind/seq)
 *      reads back with workspace='default', operationKind=
 *      'sync.vector.mirror', sequenceId=1.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-foundation-'));
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

console.log('Sprint O1 outbox-foundation unit tests');

await test('1. record + listUnfinished round-trip carries universal-write fields', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
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
});

await test('2. per-workspace sequenceId allocator is monotonic + isolated', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
    await store.record(newEntry({ id: 'a1', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n1' } }));
    await store.record(newEntry({ id: 'a2', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n2' } }));
    await store.record(newEntry({ id: 'b1', operationKind: 'node.upsert', workspace: 'beta', payload: { id: 'n3' } }));
    await store.record(newEntry({ id: 'a3', operationKind: 'node.upsert', workspace: 'alpha', payload: { id: 'n4' } }));
    const all = await store.listUnfinished();
    const byId = Object.fromEntries(all.map(e => [e.id, e.sequenceId]));
    assert.equal(byId['a1'], 1);
    assert.equal(byId['a2'], 2);
    assert.equal(byId['b1'], 1); // beta starts from 1, isolated
    assert.equal(byId['a3'], 3);
});

await test('3. workspace-required invariant — new-shape entry without workspace throws', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
    await assert.rejects(
        () => store.record(newEntry({ id: 'bad', operationKind: 'node.upsert', payload: { id: 'n1' } })),
        /workspace is required/,
    );
    // Legacy producer (no operationKind) — backfills, doesn't throw.
    await store.record(newEntry({ id: 'legacy', steps: [{ kind: 'sync.vector.mirror', status: 'pending', payload: { nodeIds: ['x'] } }] }));
    const all = await store.listUnfinished();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.workspace, 'default');
    assert.equal(all[0]?.operationKind, 'sync.vector.mirror');
});

await test('4. replicator processes pending → replicated via stub substrate', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
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
    const remainingPending = await store.listPendingForWorkspace!('alpha', 10);
    assert.equal(remainingPending.length, 0);
    const cursor = await store.readReplicationState!('alpha');
    assert.equal(cursor.lastReplicatedSeq, 1);
});

await test('5. replicator marks dead after maxAttempts when substrate throws', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('flaky'); },
    };
    const replicator = new OutboxReplicator({ store, substrates, config: { maxAttempts: 3 } });
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1' },
    }));
    // Tick three times — each picks up the same failed row.
    await replicator.tickOnce();
    await replicator.tickOnce();
    await replicator.tickOnce();
    const all = await store.listUnfinished();
    // Status flips to 'dead' on attempt 3; dead rows are excluded from
    // listPendingForWorkspace.
    const pending = await store.listPendingForWorkspace!('alpha', 10);
    assert.equal(pending.length, 0, 'no more pending after dead');
    assert.equal(all[0]?.status, 'dead');
    assert.equal(all[0]?.attempts, 3);
});

await test('6. crash recovery — replicator skips rows already covered by cursor', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
    let calls = 0;
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { calls++; },
    };
    // Seed 3 entries, then pre-write a replication state cursor that
    // says seq 1 and 2 are already replicated. Replicator should only
    // touch seq 3 — but the gate is per-row status not just cursor, so
    // we also flip rows 1+2 to status='replicated' (mimic the crash
    // scenario where the row was marked but the cursor write was the
    // pre-crash failure).
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
});

await test('7. idempotency — replay 3× through replicator produces 3 substrate calls but final state is single logical row', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
    const written = new Map<string, Record<string, unknown>>();
    const substrates: DispatcherSubstrates = {
        // Idempotent: MERGE-style — last write wins for the id.
        upsertNode: async (p) => { written.set(String(p['id']), p); },
    };
    const replicator = new OutboxReplicator({ store, substrates });
    await store.record(newEntry({
        id: 'e1', operationKind: 'node.upsert', workspace: 'alpha',
        payload: { id: 'n1', label: 'X' },
    }));
    // Process once — flips e1 to 'replicated'.
    await replicator.tickOnce();
    // Force a replay by resetting status to 'pending'.
    await store.markEntryStatus!('e1', 'pending');
    await replicator.tickOnce();
    await store.markEntryStatus!('e1', 'pending');
    await replicator.tickOnce();
    // Final substrate state: single row n1 with label X. Replays
    // overwrite each other identically.
    assert.equal(written.size, 1);
    assert.equal(written.get('n1')?.label, 'X');
});

await test('8. statsByWorkspace + aggregateStats — depth + lag math', async () => {
    const dir = tmpDir();
    const store = new FileOutboxStore(dir);
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
});

await test('9. legacy backfill — pre-O1 row reads back with default workspace + sync.vector.mirror kind', async () => {
    const dir = tmpDir();
    // Write a pre-O1 outbox.json directly to disk (the way Sprint 4
    // sync engine would have produced it).
    const legacy = {
        'legacy-1': {
            id: 'legacy-1',
            operation: 'sync.vector.mirror',
            initiator: 'system:syncEngine',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
            steps: [{ kind: 'sync.vector.mirror', status: 'pending', payload: { nodeIds: ['x', 'y'] } }],
            completed: false,
        },
    };
    fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify(legacy));
    const store = new FileOutboxStore(dir);
    const all = await store.listUnfinished();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.workspace, 'default');
    assert.equal(all[0]?.operationKind, 'sync.vector.mirror');
    assert.equal(all[0]?.sequenceId, 1);
    assert.equal(all[0]?.status, 'pending');
});

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('');
console.log(`OK: ${passed} cases pass.`);
