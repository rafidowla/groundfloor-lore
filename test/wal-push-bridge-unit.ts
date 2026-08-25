#!/usr/bin/env tsx
/**
 * wal-push-bridge-unit.ts — pure-function tests for the
 * WAL → CloudSyncClient.pushChanges bridge.
 */

import assert from 'node:assert/strict';
import {
    walEntryToSyncPushChange,
    pushWalEntries,
    partitionPushResult,
} from '../packages/lore/src/sync/walPushBridge.js';
import type { WalEntry } from '../packages/lore/src/engines/syncEngine.js';
import type {
    CloudSyncClient,
    SyncPushChange,
    SyncPushResult,
} from '../packages/lore/src/sync/cloudSyncClient.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('walEntryToSyncPushChange');

    await test('maps WalEntry → SyncPushChange field-by-field', () => {
        const entry: WalEntry = {
            op: 'upsert_node',
            data: { id: 'n1', type: 'note', label: 'L' },
            timestamp: '2026-05-10T12:00:00Z',
            entryId: 'wal-abc',
        };
        const change = walEntryToSyncPushChange(entry, 'ws-1');
        assert.deepEqual(change, {
            id: 'wal-abc',
            workspaceId: 'ws-1',
            op: 'upsert_node',
            payload: { id: 'n1', type: 'note', label: 'L' },
            capturedAt: '2026-05-10T12:00:00Z',
        });
    });

    await test('preserves plugin-extended op names (op type is open)', () => {
        const entry: WalEntry = {
            op: 'personal__add_routine',   // plugin-extended op
            data: {},
            timestamp: 't',
            entryId: 'id',
        };
        const change = walEntryToSyncPushChange(entry, 'ws');
        assert.equal(change.op, 'personal__add_routine');
    });

    console.log('\npushWalEntries');

    function fakeClient(respond: (workspaceId: string, changes: SyncPushChange[]) => SyncPushResult, captured?: Array<{ workspaceId: string; changes: SyncPushChange[] }>): CloudSyncClient {
        return {
            async isReachable() { return true; },
            async listMyWorkspaces() { return []; },
            async pullWorkspaceSnapshot() { return null; },
            async pushChanges(workspaceId, changes) {
                captured?.push({ workspaceId, changes });
                return respond(workspaceId, changes);
            },
        };
    }

    await test('empty entries → empty result, NO push call', async () => {
        const captured: Array<{ workspaceId: string; changes: SyncPushChange[] }> = [];
        const client = fakeClient(() => ({ accepted: [], rejected: [] }), captured);
        const r = await pushWalEntries(client, 'ws-1', []);
        assert.deepEqual(r, { accepted: [], rejected: [] });
        assert.equal(captured.length, 0, 'no push call when entries empty');
    });

    await test('converts + pushes entries; returns the SyncPushResult', async () => {
        const captured: Array<{ workspaceId: string; changes: SyncPushChange[] }> = [];
        const client = fakeClient(
            (_w, c) => ({ accepted: c.map(x => x.id), rejected: [] }),
            captured,
        );
        const entries: WalEntry[] = [
            { op: 'upsert_node', data: { id: 'n1' }, timestamp: 't1', entryId: 'w1' },
            { op: 'add_edge',    data: { src: 'n1', tgt: 'n2' }, timestamp: 't2', entryId: 'w2' },
        ];
        const r = await pushWalEntries(client, 'ws-1', entries);
        assert.deepEqual(r.accepted.sort(), ['w1', 'w2']);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].workspaceId, 'ws-1');
        assert.equal(captured[0].changes.length, 2);
        assert.equal(captured[0].changes[0].op, 'upsert_node');
        assert.equal(captured[0].changes[1].op, 'add_edge');
    });

    await test('propagates partial rejections back to the caller', async () => {
        const client = fakeClient((_w, c) => ({
            accepted: [c[0].id],
            rejected: [{ id: c[1].id, reason: 'permission_denied: write on ws-1' }],
        }));
        const r = await pushWalEntries(client, 'ws-1', [
            { op: 'upsert_node', data: {}, timestamp: 't', entryId: 'good' },
            { op: 'upsert_node', data: {}, timestamp: 't', entryId: 'bad'  },
        ]);
        assert.deepEqual(r.accepted, ['good']);
        assert.equal(r.rejected.length, 1);
        assert.equal(r.rejected[0].id, 'bad');
        assert.match(r.rejected[0].reason, /permission_denied/);
    });

    console.log('\npartitionPushResult');

    await test('splits accepted vs rejected into actionable id lists', () => {
        const result: SyncPushResult = {
            accepted: ['a', 'b'],
            rejected: [
                { id: 'c', reason: 'rate_limited' },
                { id: 'd', reason: 'rate_limited' },
                { id: 'e', reason: 'permission_denied: write' },
            ],
        };
        const split = partitionPushResult(result);
        assert.deepEqual(split.advancePastIds, ['a', 'b']);
        assert.deepEqual([...split.retryIds].sort(), ['c', 'd', 'e']);
    });

    await test('groups rejections by reason for actionable surfacing', () => {
        const result: SyncPushResult = {
            accepted: [],
            rejected: [
                { id: '1', reason: 'rate_limited' },
                { id: '2', reason: 'rate_limited' },
                { id: '3', reason: 'permission_denied: write' },
            ],
        };
        const split = partitionPushResult(result);
        // Sort for deterministic comparison
        const grouped = [...split.rejectionsByReason]
            .map(g => ({ reason: g.reason, ids: [...g.ids].sort() }))
            .sort((a, b) => a.reason.localeCompare(b.reason));
        assert.deepEqual(grouped, [
            { reason: 'permission_denied: write', ids: ['3'] },
            { reason: 'rate_limited', ids: ['1', '2'] },
        ]);
    });

    await test('handles empty SyncPushResult', () => {
        const split = partitionPushResult({ accepted: [], rejected: [] });
        assert.deepEqual(split.advancePastIds, []);
        assert.deepEqual(split.retryIds, []);
        assert.deepEqual(split.rejectionsByReason, []);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
