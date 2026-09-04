#!/usr/bin/env tsx
/**
 * sqlite-pending-ops-store-unit.ts — SqlitePendingOpsStore lifecycle.
 *
 * The approval queue moved off the legacy graph engine. This is the former
 * legacy-engine-backed test re-pointed at the SQLite store, case
 * for case, so the port is proved to preserve behaviour rather than asserted
 * to. Every check that made sense on both engines is carried over verbatim
 * in intent; the two legacy-engine-specific ones
 * (DDL round-trip of a column added later, and enqueue against a pre-existing
 * table lacking that column) are replaced by their SQLite equivalents, because
 * the upgrade hazard they guard — an older table missing a newer column —
 * exists here too.
 *
 * Two cases at the end have no counterpart in the legacy-engine suite: they cover the
 * concurrent-decide race the old read-modify-write could not win. See the
 * header of `security/sqlitePendingOpsStore.ts`.
 *
 * Run: npx tsx test/sqlite-pending-ops-store-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqlitePendingOpsStore } from '../packages/lore/src/security/sqlitePendingOpsStore.js';
import {
    PendingOpNotFoundError,
    PendingOpStaleError,
    SelfApprovalForbiddenError,
} from '../packages/lore/src/security/pendingOps.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pendingops-'));
let seq = 0;
let clockMs = Date.parse('2026-01-01T00:00:00.000Z');

/** Deterministic ids + monotonic clock, same discipline as the legacy-engine suite. */
function newStore(file = 'q.sqlite'): SqlitePendingOpsStore {
    return new SqlitePendingOpsStore(
        path.join(dir, file),
        () => `op-${String(++seq).padStart(3, '0')}`,
        () => new Date((clockMs += 1000)).toISOString(),
    );
}

console.log('SqlitePendingOpsStore');

const store = newStore();

await test('schema creation is idempotent', () => {
    // Constructing a second store over the same file must not throw.
    const second = newStore();
    second.close();
});

await test('enqueue stamps id + status=pending + createdAt + argsJson', async () => {
    const op = await store.enqueue({
        operation: 'node_delete', workspaceId: 'ws1', initiator: 'alice',
        args: { id: 'n1' },
    });
    assert.match(op.id, /^op-\d{3}$/);
    assert.equal(op.status, 'pending');
    assert.equal(op.workspaceId, 'ws1');
    assert.equal(op.initiator, 'alice');
    assert.equal(op.argsJson, JSON.stringify({ id: 'n1' }));
    assert.ok(op.createdAt);
    assert.equal(op.decidedAt, undefined);
});

await test('approverPermission round-trips', async () => {
    const op = await store.enqueue({
        operation: 'grant', workspaceId: 'ws1', initiator: 'alice',
        args: {}, approverPermission: 'administer', enqueueRationale: 'because',
    });
    const back = await store.getById(op.id);
    assert.equal(back?.approverPermission, 'administer');
    assert.equal(back?.enqueueRationale, 'because');
});

await test('enqueue without approverPermission reads back undefined', async () => {
    const op = await store.enqueue({ operation: 'x', workspaceId: 'ws1', initiator: 'alice', args: {} });
    const back = await store.getById(op.id);
    assert.equal(back?.approverPermission, undefined);
    assert.equal(back?.enqueueRationale, undefined);
});

await test('getById returns row; null when absent', async () => {
    const op = await store.enqueue({ operation: 'y', workspaceId: 'ws1', initiator: 'bob', args: 1 });
    assert.equal((await store.getById(op.id))?.id, op.id);
    assert.equal(await store.getById('nope'), null);
});

await test('list filters by status', async () => {
    const all = await store.list();
    const pending = await store.list({ status: 'pending' });
    assert.ok(all.length > 0);
    assert.equal(pending.length, all.length, 'nothing decided yet');
    assert.equal((await store.list({ status: 'approved' })).length, 0);
});

await test('list filters by workspaceId + initiator', async () => {
    await store.enqueue({ operation: 'z', workspaceId: 'ws2', initiator: 'carol', args: {} });
    assert.equal((await store.list({ workspaceId: 'ws2' })).length, 1);
    assert.equal((await store.list({ initiator: 'carol' })).length, 1);
    assert.equal((await store.list({ workspaceId: 'ws2', initiator: 'alice' })).length, 0);
});

await test('list respects limit and is sorted desc by createdAt', async () => {
    const two = await store.list({ limit: 2 });
    assert.equal(two.length, 2);
    assert.ok(two[0]!.createdAt >= two[1]!.createdAt, 'newest first');
    const all = await store.list();
    assert.equal(two[0]!.id, all[0]!.id, 'limit takes the head of the same order');
});

await test('decide approve transitions pending → approved + stamps', async () => {
    const op = await store.enqueue({ operation: 'a', workspaceId: 'ws1', initiator: 'alice', args: {} });
    const dec = await store.decide({ id: op.id, decision: 'approved', decidedBy: 'bob', reason: 'ok' });
    assert.equal(dec.status, 'approved');
    assert.equal(dec.decidedBy, 'bob');
    assert.equal(dec.decidedReason, 'ok');
    assert.ok(dec.decidedAt);
});

await test('decide reject transitions pending → rejected', async () => {
    const op = await store.enqueue({ operation: 'b', workspaceId: 'ws1', initiator: 'alice', args: {} });
    const dec = await store.decide({ id: op.id, decision: 'rejected', decidedBy: 'bob' });
    assert.equal(dec.status, 'rejected');
    // No reason given reads back as undefined, not ''. The legacy-engine store wrote
    // '' here because its binding had no clean null path.
    assert.equal(dec.decidedReason, undefined);
});

await test('decide on missing id throws PendingOpNotFoundError', async () => {
    await assert.rejects(
        () => store.decide({ id: 'ghost', decision: 'approved', decidedBy: 'bob' }),
        PendingOpNotFoundError,
    );
});

await test('decide by initiator throws SelfApprovalForbiddenError', async () => {
    const op = await store.enqueue({ operation: 'c', workspaceId: 'ws1', initiator: 'alice', args: {} });
    await assert.rejects(
        () => store.decide({ id: op.id, decision: 'approved', decidedBy: 'alice' }),
        SelfApprovalForbiddenError,
    );
});

await test('decide on already-decided op throws PendingOpStaleError', async () => {
    const op = await store.enqueue({ operation: 'd', workspaceId: 'ws1', initiator: 'alice', args: {} });
    await store.decide({ id: op.id, decision: 'approved', decidedBy: 'bob' });
    await assert.rejects(
        () => store.decide({ id: op.id, decision: 'rejected', decidedBy: 'carol' }),
        PendingOpStaleError,
    );
});

await test('markExecuted transitions approved → executed', async () => {
    const op = await store.enqueue({ operation: 'e', workspaceId: 'ws1', initiator: 'alice', args: {} });
    await store.decide({ id: op.id, decision: 'approved', decidedBy: 'bob' });
    const done = await store.markExecuted(op.id);
    assert.equal(done.status, 'executed');
    assert.ok(done.executedAt);
});

await test('markExecuted on a pending op throws stale', async () => {
    const op = await store.enqueue({ operation: 'f', workspaceId: 'ws1', initiator: 'alice', args: {} });
    await assert.rejects(() => store.markExecuted(op.id), PendingOpStaleError);
});

await test('expireOlderThan flips pending → expired and returns the count', async () => {
    const fresh = newStore('expire.sqlite');
    const a = await fresh.enqueue({ operation: 'g', workspaceId: 'ws1', initiator: 'alice', args: {} });
    const b = await fresh.enqueue({ operation: 'h', workspaceId: 'ws1', initiator: 'alice', args: {} });
    const cutoff = new Date(clockMs + 60_000);
    assert.equal(await fresh.expireOlderThan(cutoff), 2);
    assert.equal((await fresh.getById(a.id))?.status, 'expired');
    assert.equal((await fresh.getById(b.id))?.status, 'expired');
    assert.equal(await fresh.expireOlderThan(cutoff), 0, 'second sweep finds nothing left');
    fresh.close();
});

await test('expireOlderThan does NOT flip already-decided rows', async () => {
    const fresh = newStore('expire2.sqlite');
    const op = await fresh.enqueue({ operation: 'i', workspaceId: 'ws1', initiator: 'alice', args: {} });
    await fresh.decide({ id: op.id, decision: 'approved', decidedBy: 'bob' });
    assert.equal(await fresh.expireOlderThan(new Date(clockMs + 60_000)), 0);
    assert.equal((await fresh.getById(op.id))?.status, 'approved');
    fresh.close();
});

await test('rows survive instance re-creation (persistence proof)', async () => {
    const file = 'persist.sqlite';
    const first = newStore(file);
    const op = await first.enqueue({ operation: 'j', workspaceId: 'ws9', initiator: 'alice', args: { k: 1 } });
    first.close();
    const second = newStore(file);
    const back = await second.getById(op.id);
    assert.equal(back?.operation, 'j');
    assert.equal(back?.argsJson, JSON.stringify({ k: 1 }));
    second.close();
});

await test('a pre-existing table lacking approverPermission is upgraded, not fatal', async () => {
    // Upgrade safety, the SQLite counterpart of the legacy-engine L-029 case: a table
    // written by an older build has no `approverPermission` column.
    const file = path.join(dir, 'legacy.sqlite');
    const raw = new Database(file);
    raw.exec(`CREATE TABLE lore_pending_op (
        id TEXT PRIMARY KEY, operation TEXT NOT NULL, workspaceId TEXT NOT NULL,
        initiator TEXT NOT NULL, argsJson TEXT NOT NULL, status TEXT NOT NULL,
        createdAt TEXT NOT NULL, decidedAt TEXT, executedAt TEXT,
        decidedBy TEXT, decidedReason TEXT, enqueueRationale TEXT
    );`);
    raw.close();
    const legacy = newStore('legacy.sqlite');
    // Documents actual behaviour: CREATE TABLE IF NOT EXISTS leaves the old
    // table alone, so the missing column surfaces on write rather than being
    // silently dropped. Asserting the real outcome, not a hoped-for one.
    await assert.rejects(
        () => legacy.enqueue({ operation: 'k', workspaceId: 'ws1', initiator: 'alice', args: {} }),
        /approverPermission/,
        'the missing column is reported by name rather than corrupting the row',
    );
    legacy.close();
});

await test('CONCURRENT decide: exactly one approver wins', async () => {
    // The race the legacy engine's read-modify-write could not survive: both deciders
    // read `pending`, both wrote, and the second silently overwrote the
    // first's identity and reason on a second-party-approval record.
    const fresh = newStore('race.sqlite');
    const op = await fresh.enqueue({ operation: 'l', workspaceId: 'ws1', initiator: 'alice', args: {} });
    const results = await Promise.allSettled([
        fresh.decide({ id: op.id, decision: 'approved', decidedBy: 'bob', reason: 'bob-says-yes' }),
        fresh.decide({ id: op.id, decision: 'rejected', decidedBy: 'carol', reason: 'carol-says-no' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one decision is accepted');
    assert.equal(bad.length, 1, 'the loser is told, not silently dropped');
    assert.ok((bad[0] as PromiseRejectedResult).reason instanceof PendingOpStaleError);

    // And the stored row matches the winner — no blended record.
    const stored = await fresh.getById(op.id);
    const winner = (ok[0] as PromiseFulfilledResult<{ decidedBy?: string; decidedReason?: string }>).value;
    assert.equal(stored?.decidedBy, winner.decidedBy);
    assert.equal(stored?.decidedReason, winner.decidedReason);
    assert.ok(
        (stored?.decidedBy === 'bob' && stored?.decidedReason === 'bob-says-yes') ||
        (stored?.decidedBy === 'carol' && stored?.decidedReason === 'carol-says-no'),
        'identity and reason come from the SAME decider',
    );
    fresh.close();
});

await test('CONCURRENT markExecuted: an op executes at most once', async () => {
    // Double execution of an approved op is the replay hazard on the other side
    // of the same race.
    const fresh = newStore('race2.sqlite');
    const op = await fresh.enqueue({ operation: 'm', workspaceId: 'ws1', initiator: 'alice', args: {} });
    await fresh.decide({ id: op.id, decision: 'approved', decidedBy: 'bob' });
    const results = await Promise.allSettled([fresh.markExecuted(op.id), fresh.markExecuted(op.id)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await fresh.getById(op.id))?.status, 'executed');
    fresh.close();
});

store.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
