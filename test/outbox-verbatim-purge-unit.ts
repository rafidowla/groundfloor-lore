#!/usr/bin/env tsx
/**
 * outbox-verbatim-purge-unit.ts — 3.27.0: the `verbatim.purge` outbox kind.
 *
 * Pinned: keyOfEntry / supersessionFamilySql place it in the verbatim family;
 * dispatch applies it (unwired / missing payload refused), verifyApplied is
 * "every id absent"; hasNewerReplicatedForKey sees a replicated purge through
 * payload.ids (so a failed alias `verbatim.upsert` cannot resurrect content);
 * queuedVerbatimUpsertIds reports pending/failed alias upserts only.
 *
 * Run: npx tsx test/outbox-verbatim-purge-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { keyOfEntry, supersessionFamilySql } from '../packages/lore/src/outbox/supersession.js';
import { dispatch, verifyApplied, UnwiredOperationKindError, MissingPayloadError, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import type { OutboxEntry, OutboxOperationKind } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const WS = 'default';
function entry(kind: OutboxOperationKind, payload: Record<string, unknown>): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id: `e-${kind}`, operation: kind, initiator: 'test', createdAt: now, updatedAt: now, steps: [], completed: false,
        workspace: WS, operationKind: kind, payload, status: 'pending', attempts: 0,
    };
}
const purgeRow = (ids: string[]) => entry('verbatim.purge', { id: 'lore:n', ids });

console.log('\nkeying and family membership\n');
await test('keyOfEntry: purge is in the verbatim family under the canonical lore:<id> key', () => {
    assert.deepEqual(keyOfEntry(purgeRow(['lore:n', 'lore:n#q0'])), { family: 'verbatim', key: 'lore:n' });
    assert.equal(keyOfEntry(entry('verbatim.purge', { ids: ['x'] })), null, 'no payload.id -> no key');
});
await test('supersessionFamilySql(verbatim) lists upsert, tombstone and purge', () => {
    const k = supersessionFamilySql('verbatim').kinds;
    for (const kind of ['verbatim.upsert', 'verbatim.tombstone', 'verbatim.purge']) assert.ok(k.includes(`'${kind}'`), kind);
    assert.ok(!supersessionFamilySql('node').kinds.includes('verbatim.purge'));
});

console.log('\ndispatcher\n');
await test('dispatch applies purge with every id; payload.id is merged in', async () => {
    const seen: string[][] = [];
    const subs: DispatcherSubstrates = { purgeVerbatim: async (ids) => { seen.push(ids); } };
    await dispatch(purgeRow(['lore:n', 'lore:n#q0']), subs);
    await dispatch(entry('verbatim.purge', { id: 'lore:solo' }), subs);
    assert.deepEqual(seen, [['lore:n', 'lore:n#q0'], ['lore:solo']]);
});
await test('dispatch: no hook -> UnwiredOperationKindError; no ids -> MissingPayloadError', async () => {
    await assert.rejects(() => dispatch(purgeRow(['a']), {}), UnwiredOperationKindError);
    await assert.rejects(() => dispatch(entry('verbatim.purge', {}), { purgeVerbatim: async () => undefined }), MissingPayloadError);
});
await test('verifyApplied: verified iff every id is absent', async () => {
    const live = new Set(['lore:n#q1']);
    const subs: DispatcherSubstrates = { getVerbatim: async (id) => (live.has(id) ? { text: 'x' } : null) };
    const row = purgeRow(['lore:n', 'lore:n#q0', 'lore:n#q1']);
    const bad = await verifyApplied(row, subs);
    assert.equal(bad.verified, false);
    assert.equal(bad.reason, 'substrate-still-has-verbatim');
    live.clear();
    assert.equal((await verifyApplied(row, subs)).verified, true);
    assert.equal((await verifyApplied(row, {})).reason, 'content-witness-unwired');
    assert.equal((await verifyApplied(entry('verbatim.purge', {}), subs)).reason, 'missing-ids');
});

console.log('\nSQLite outbox store\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-purge-'));
const store = new SqliteOutboxStore(dir);
try {
    const rec = (kind: OutboxOperationKind, payload: Record<string, unknown>) =>
        recordHotWrite(store, { workspace: WS, operationKind: kind, payload, initiator: 'test' });
    await test('queuedVerbatimUpsertIds: pending/failed alias upserts only, workspace-scoped', async () => {
        const pend = await rec('verbatim.upsert', { id: 'lore:n#q0', text: 't', metadata: {} });
        const fail = await rec('verbatim.upsert', { id: 'lore:n#q1', text: 't', metadata: {} });
        const done = await rec('verbatim.upsert', { id: 'lore:n#q2', text: 't', metadata: {} });
        await store.markEntryStatus(fail.id, 'failed', { error: 'boom', bumpAttempt: true });
        await store.markEntryStatus(done.id, 'replicated');
        const ids = ['lore:n#q0', 'lore:n#q1', 'lore:n#q2', 'lore:n#q3'];
        assert.deepEqual((await store.queuedVerbatimUpsertIds!(WS, ids)).sort(), ['lore:n#q0', 'lore:n#q1']);
        assert.deepEqual(await store.queuedVerbatimUpsertIds!('other', ids), []);
        assert.ok(pend.id);
    });
    await test('hasNewerReplicatedForKey: a replicated purge supersedes a failed alias upsert via payload.ids', async () => {
        const failedAlias = await rec('verbatim.upsert', { id: 'lore:m#q0', text: 't', metadata: {} });
        await store.markEntryStatus(failedAlias.id, 'failed', { error: 'boom', bumpAttempt: true });
        const seq = (await store.listUnfinished()).find((e) => e.id === failedAlias.id)?.sequenceId
            ?? ((store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): { sequenceId: number } } } })
                .db.prepare('SELECT sequenceId FROM outbox_entries WHERE id = ?').get(failedAlias.id).sequenceId);
        assert.equal(await store.hasNewerReplicatedForKey(WS, 'verbatim', 'lore:m#q0', seq), false, 'nothing newer yet');
        const purge = await rec('verbatim.purge', { id: 'lore:m', ids: ['lore:m', 'lore:m#q0', 'lore:m#q1'] });
        assert.equal(await store.hasNewerReplicatedForKey(WS, 'verbatim', 'lore:m#q0', seq), false, 'a pending purge does not supersede yet');
        await store.markEntryStatus(purge.id, 'replicated');
        assert.equal(await store.hasNewerReplicatedForKey(WS, 'verbatim', 'lore:m#q0', seq), true, 'alias id matched through payload.ids');
        assert.equal(await store.hasNewerReplicatedForKey(WS, 'verbatim', 'lore:m', seq), true, 'canonical key matched');
        assert.equal(await store.hasNewerReplicatedForKey(WS, 'verbatim', 'lore:mm#q0', seq), false, 'a different id is not matched');
        assert.equal(await store.hasNewerReplicatedForKey(WS, 'verbatim', 'lore:m#q9', seq), false, 'ids not in the purge are not matched');
    });
} finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
