#!/usr/bin/env tsx
/**
 * no-cloud-sync-client-unit.ts — NoCloudSyncClient safe-degenerate
 * behavior. The no-op selected when LORE_CLOUD_URL is unset.
 */

import assert from 'node:assert/strict';
import { NoCloudSyncClient } from '../packages/lore/src/sync/noCloudSyncClient.js';
import type {
    CloudSyncClient,
    SyncPushChange,
} from '../packages/lore/src/sync/cloudSyncClient.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('NoCloudSyncClient');
    const client: CloudSyncClient = new NoCloudSyncClient();

    await test('listMyWorkspaces returns empty array', async () => {
        assert.deepEqual(await client.listMyWorkspaces(), []);
    });

    await test('pullWorkspaceSnapshot returns null', async () => {
        assert.equal(await client.pullWorkspaceSnapshot('ws-1', 'v1'), null);
    });

    await test('pushChanges rejects every change with no_cloud_configured', async () => {
        const changes: SyncPushChange[] = [
            { id: 'c1', workspaceId: 'ws-1', op: 'upsert_node', payload: {}, capturedAt: '2026-05-10T00:00:00Z' },
            { id: 'c2', workspaceId: 'ws-1', op: 'store_edge',  payload: {}, capturedAt: '2026-05-10T00:00:01Z' },
        ];
        const r = await client.pushChanges('ws-1', changes);
        assert.deepEqual(r.accepted, []);
        assert.equal(r.rejected.length, 2);
        assert.deepEqual(r.rejected.map(x => x.id).sort(), ['c1', 'c2']);
        for (const item of r.rejected) {
            assert.match(item.reason, /no_cloud_configured/);
        }
    });

    await test('pushChanges with empty input returns empty result (no spurious entries)', async () => {
        const r = await client.pushChanges('ws-1', []);
        assert.deepEqual(r.accepted, []);
        assert.deepEqual(r.rejected, []);
    });

    await test('isReachable returns true (no-call-no-fail)', async () => {
        assert.equal(await client.isReachable(), true);
    });

    await test('implements CloudSyncClient interface (compile-time)', () => {
        // The type assertion at construction is the test — if any method
        // were missing or shape-mismatched, tsc would fail the build.
        assert.ok(client);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
