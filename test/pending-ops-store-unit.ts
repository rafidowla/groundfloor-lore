#!/usr/bin/env tsx
/**
 * pending-ops-store-unit.ts — InMemoryPendingOpsStore lifecycle tests.
 *
 * Exercises the queue contract used by every PendingOpsStore impl
 * (in-memory today, Kùzu/Postgres later). When the Kùzu-backed store
 * lands, the same test cases re-run against it for parity.
 */

import assert from 'node:assert/strict';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';
import {
    PendingOpNotFoundError,
    PendingOpStaleError,
    SelfApprovalForbiddenError,
} from '../packages/lore/src/security/pendingOps.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function freshStore(opts: { ids?: string[] } = {}): InMemoryPendingOpsStore {
    let i = 0;
    const ids = opts.ids;
    return new InMemoryPendingOpsStore({
        mintId: () => ids ? ids[i++] : `id-${i++}`,
        clock: () => `2026-05-10T00:00:0${i % 10}.000Z`,
    });
}

(async () => {
    console.log('InMemoryPendingOpsStore');

    await test('enqueue stamps id, status=pending, createdAt, encodes args', async () => {
        const store = freshStore({ ids: ['op-1'] });
        const r = await store.enqueue({
            operation: 'forget_person',
            workspaceId: 'ws-test',
            initiator: 'alice',
            args: { personId: 'mom', confirm: true },
            enqueueRationale: 'destructive',
        });
        assert.equal(r.id, 'op-1');
        assert.equal(r.status, 'pending');
        assert.equal(r.workspaceId, 'ws-test');
        assert.equal(r.initiator, 'alice');
        assert.equal(r.enqueueRationale, 'destructive');
        assert.deepEqual(JSON.parse(r.argsJson), { personId: 'mom', confirm: true });
        assert.match(r.createdAt, /^2026-05-10T/);
    });

    await test('getById returns row by id; null when absent', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'a', args: {} });
        assert.ok(await store.getById('op-1'));
        assert.equal(await store.getById('op-9'), null);
    });

    await test('enqueue persists approverPermission and round-trips via getById/list (L-029)', async () => {
        const store = freshStore({ ids: ['op-ap'] });
        const r = await store.enqueue({
            operation: 'invite_member',
            workspaceId: 'ws',
            initiator: 'alice',
            args: {},
            approverPermission: 'manage_members',
        });
        assert.equal(r.approverPermission, 'manage_members');
        const byId = await store.getById('op-ap');
        assert.equal(byId?.approverPermission, 'manage_members');
        const listed = await store.list({ status: 'pending' });
        assert.equal(listed[0]?.approverPermission, 'manage_members');
    });

    await test('enqueue without approverPermission leaves it undefined (L-029 back-compat)', async () => {
        const store = freshStore({ ids: ['op-noap'] });
        const r = await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'a', args: {} });
        assert.equal(r.approverPermission, undefined);
        assert.equal((await store.getById('op-noap'))?.approverPermission, undefined);
    });

    await test('list filters by status', async () => {
        const store = freshStore({ ids: ['a', 'b', 'c'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'u', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'u', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'u', args: {} });
        await store.decide({ id: 'a', decision: 'approved', decidedBy: 'admin' });
        const pending = await store.list({ status: 'pending' });
        assert.equal(pending.length, 2);
        assert.deepEqual(pending.map(r => r.id).sort(), ['b', 'c']);
        const approved = await store.list({ status: 'approved' });
        assert.equal(approved.length, 1);
    });

    await test('list filters by workspaceId + initiator', async () => {
        const store = freshStore({ ids: ['1', '2', '3'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws-a', initiator: 'alice', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'ws-a', initiator: 'bob',   args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'ws-b', initiator: 'alice', args: {} });
        const wsa = await store.list({ workspaceId: 'ws-a' });
        assert.equal(wsa.length, 2);
        const alice = await store.list({ initiator: 'alice' });
        assert.equal(alice.length, 2);
        const both = await store.list({ workspaceId: 'ws-a', initiator: 'alice' });
        assert.equal(both.length, 1);
        assert.equal(both[0].id, '1');
    });

    await test('list respects limit (most-recent first)', async () => {
        const store = freshStore({ ids: ['old', 'mid', 'new'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'u', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'u', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'u', args: {} });
        const r = await store.list({ limit: 2 });
        assert.equal(r.length, 2);
        // Sorted desc by createdAt; clock advances per call so 'new' is latest.
        assert.equal(r[0].id, 'new');
        assert.equal(r[1].id, 'mid');
    });

    await test('decide approve transitions pending → approved + stamps', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        const r = await store.decide({
            id: 'op-1', decision: 'approved', decidedBy: 'admin', reason: 'looks good',
        });
        assert.equal(r.status, 'approved');
        assert.equal(r.decidedBy, 'admin');
        assert.equal(r.decidedReason, 'looks good');
        assert.match(r.decidedAt ?? '', /^2026-05-10T/);
    });

    await test('decide reject transitions pending → rejected', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        const r = await store.decide({ id: 'op-1', decision: 'rejected', decidedBy: 'admin' });
        assert.equal(r.status, 'rejected');
    });

    await test('decide on missing id throws PendingOpNotFoundError', async () => {
        const store = freshStore();
        await assert.rejects(
            () => store.decide({ id: 'nope', decision: 'approved', decidedBy: 'admin' }),
            PendingOpNotFoundError,
        );
    });

    await test('decide by initiator throws SelfApprovalForbiddenError', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        await assert.rejects(
            () => store.decide({ id: 'op-1', decision: 'approved', decidedBy: 'alice' }),
            SelfApprovalForbiddenError,
        );
    });

    await test('decide on already-decided op throws PendingOpStaleError', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        await store.decide({ id: 'op-1', decision: 'approved', decidedBy: 'admin' });
        await assert.rejects(
            () => store.decide({ id: 'op-1', decision: 'rejected', decidedBy: 'admin2' }),
            PendingOpStaleError,
        );
    });

    await test('markExecuted transitions approved → executed', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        await store.decide({ id: 'op-1', decision: 'approved', decidedBy: 'admin' });
        const r = await store.markExecuted('op-1');
        assert.equal(r.status, 'executed');
        assert.match(r.executedAt ?? '', /^2026-05-10T/);
    });

    await test('markExecuted on a pending op (not yet approved) throws stale', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        await assert.rejects(() => store.markExecuted('op-1'), PendingOpStaleError);
    });

    await test('markExecuted on rejected op throws stale', async () => {
        const store = freshStore({ ids: ['op-1'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        await store.decide({ id: 'op-1', decision: 'rejected', decidedBy: 'admin' });
        await assert.rejects(() => store.markExecuted('op-1'), PendingOpStaleError);
    });

    await test('expireOlderThan flips pending → expired for stale rows', async () => {
        const store = new InMemoryPendingOpsStore({
            mintId: () => 'op',
            // First call old, subsequent calls newer
            clock: (() => {
                const stamps = [
                    '2026-05-01T00:00:00.000Z',
                    '2026-05-02T00:00:00.000Z',
                ];
                let i = 0;
                return () => stamps[Math.min(i++, stamps.length - 1)];
            })(),
        });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        const cutoff = new Date('2026-05-08T00:00:00.000Z');
        const expired = await store.expireOlderThan(cutoff);
        assert.equal(expired, 1);
        const row = await store.getById('op');
        assert.equal(row?.status, 'expired');
    });

    await test('expireOlderThan does NOT flip already-decided rows', async () => {
        const store = freshStore({ ids: ['op'] });
        await store.enqueue({ operation: 'op', workspaceId: 'ws', initiator: 'alice', args: {} });
        await store.decide({ id: 'op', decision: 'approved', decidedBy: 'admin' });
        const expired = await store.expireOlderThan(new Date('2030-01-01T00:00:00.000Z'));
        assert.equal(expired, 0);
        const row = await store.getById('op');
        assert.equal(row?.status, 'approved');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('test runner error:', err);
    process.exit(2);
});
