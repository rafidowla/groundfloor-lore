#!/usr/bin/env tsx
/**
 * sync-poller-unit.ts — SyncPoller against an in-memory fake cloud
 * client + spied callbacks. No timers, no disk.
 */

import assert from 'node:assert/strict';
import { SyncPoller } from '../packages/lore/src/sync/syncPoller.js';
import type {
    CloudSyncClient,
    SyncedWorkspace,
    SyncPushChange,
    SyncPushResult,
    SyncSnapshot,
} from '../packages/lore/src/sync/cloudSyncClient.js';
import type { LocalWorkspaceState } from '../packages/lore/src/sync/reconciler.js';
import {
    SyncDirectionGuard,
    guardSyncDown,
} from '../packages/lore/src/security/syncDirectionGuard.js';

interface FakeCloudOpts {
    reachable?: boolean;
    workspaces?: SyncedWorkspace[];
    snapshotBytes?: (workspaceId: string, version: string) => Uint8Array | null;
    listThrows?: boolean; // RA2-reaudit2 — simulate a 401/5xx/network failure of listMyWorkspaces
}

function fakeCloud(opts: FakeCloudOpts = {}): CloudSyncClient {
    return {
        async isReachable() { return opts.reachable ?? true; },
        async listMyWorkspaces() {
            if (opts.listThrows) throw new Error('listMyWorkspaces failed: HTTP 503');
            return opts.workspaces ?? [];
        },
        async pullWorkspaceSnapshot(workspaceId: string, version: string): Promise<SyncSnapshot | null> {
            const bytes = opts.snapshotBytes?.(workspaceId, version);
            if (bytes === null) return null;
            return { workspaceId, version, bytes: bytes ?? new Uint8Array([1, 2, 3]) };
        },
        async pushChanges(_w: string, c: SyncPushChange[]): Promise<SyncPushResult> {
            return { accepted: c.map(x => x.id), rejected: [] };
        },
    };
}

interface SpyCallbacks {
    readLocalState: () => Promise<LocalWorkspaceState[]>;
    applySnapshot: (workspaceId: string, version: string, bytes: Uint8Array) => Promise<void>;
    removeWorkspace: (workspaceId: string) => Promise<void>;
    applied: Array<{ workspaceId: string; version: string; bytes: Uint8Array }>;
    removed: string[];
}

function spyCallbacks(localInitial: LocalWorkspaceState[] = []): SpyCallbacks {
    const applied: SpyCallbacks['applied'] = [];
    const removed: SpyCallbacks['removed'] = [];
    return {
        applied, removed,
        readLocalState: async () => localInitial,
        applySnapshot: async (workspaceId, version, bytes) => {
            applied.push({ workspaceId, version, bytes });
        },
        removeWorkspace: async (workspaceId) => { removed.push(workspaceId); },
    };
}

function silentLog() {
    return { info: () => {}, error: () => {} };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('SyncPoller');

    await test('skips tick when cloud is unreachable', async () => {
        const cb = spyCallbacks();
        const poller = new SyncPoller({
            client: fakeCloud({ reachable: false }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.skipped, 'unreachable');
        assert.equal(cb.applied.length, 0);
        assert.equal(cb.removed.length, 0);
    });

    await test('pulls every workspace cloud lists when local is empty', async () => {
        const cb = spyCallbacks([]);
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [
                { workspaceId: 'ws-1', displayName: 'A', accountId: 'acct', permissions: ['read', 'write'], version: 'v1' },
                { workspaceId: 'ws-2', displayName: 'B', accountId: 'acct', permissions: ['read'],          version: 'v1' },
            ] }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.pullsApplied.length, 2);
        assert.equal(cb.applied.length, 2);
        assert.deepEqual(cb.applied.map(a => a.workspaceId).sort(), ['ws-1', 'ws-2']);
        assert.equal(r.dropsApplied.length, 0);
    });

    await test('skips pull for workspaces already at the same version', async () => {
        const cb = spyCallbacks([
            { workspaceId: 'ws-1', syncedVersion: 'v1' },
        ]);
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [
                { workspaceId: 'ws-1', displayName: 'A', accountId: 'acct', permissions: ['read'], version: 'v1' },
            ] }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.pullsApplied.length, 0);
        assert.equal(r.plan?.unchanged.length, 1);
    });

    await test('pulls again on version mismatch', async () => {
        const cb = spyCallbacks([{ workspaceId: 'ws-1', syncedVersion: 'v1' }]);
        const poller = new SyncPoller({
            client: fakeCloud({
                workspaces: [
                    { workspaceId: 'ws-1', displayName: 'A', accountId: 'acct', permissions: ['read'], version: 'v2' },
                ],
                snapshotBytes: (_id, v) => new Uint8Array([v.charCodeAt(0)]),
            }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.pullsApplied.length, 1);
        assert.equal(r.pullsApplied[0].version, 'v2');
        assert.equal(cb.applied[0].bytes[0], 'v'.charCodeAt(0));
    });

    await test('drops local workspaces cloud no longer lists', async () => {
        const cb = spyCallbacks([
            { workspaceId: 'ws-keep',    syncedVersion: 'v1' },
            { workspaceId: 'ws-revoked', syncedVersion: 'v1' },
        ]);
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [
                { workspaceId: 'ws-keep', displayName: 'K', accountId: 'acct', permissions: ['read'], version: 'v1' },
            ] }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.deepEqual(r.dropsApplied, ['ws-revoked']);
        assert.deepEqual(cb.removed, ['ws-revoked']);
    });

    await test('SAFETY: a FAILED cloud-list never drops local workspaces (RA2 critical)', async () => {
        // Under the bug, listMyWorkspaces swallowed the 503 into [], and with
        // cloudIsAuthoritative the reconciler would drop EVERY local workspace.
        const cb = spyCallbacks([
            { workspaceId: 'ws-keep-1', syncedVersion: 'v1' },
            { workspaceId: 'ws-keep-2', syncedVersion: 'v1' },
        ]);
        const poller = new SyncPoller({
            client: fakeCloud({ listThrows: true }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.skipped, 'workspace-list-failed');
        assert.equal(cb.removed.length, 0, 'a transient cloud failure must NOT wipe local workspaces');
    });

    await test('SAFETY: cloudIsAuthoritative=false → never drops anything', async () => {
        const cb = spyCallbacks([
            { workspaceId: 'ws-1', syncedVersion: 'v1' },
            { workspaceId: 'ws-2', syncedVersion: 'v1' },
        ]);
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [] }), // pretend cloud says nothing
            callbacks: cb, cloudIsAuthoritative: false, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.dropsApplied.length, 0);
        assert.equal(cb.removed.length, 0);
    });

    await test('per-pull failure does not abort the rest of the tick', async () => {
        const cb = spyCallbacks([]);
        const poller = new SyncPoller({
            client: fakeCloud({
                workspaces: [
                    { workspaceId: 'ws-1', displayName: 'A', accountId: 'acct', permissions: ['read'], version: 'v1' },
                    { workspaceId: 'ws-2', displayName: 'B', accountId: 'acct', permissions: ['read'], version: 'v1' },
                ],
                // Snapshot fails for ws-1 only.
                snapshotBytes: (id) => id === 'ws-1' ? null : new Uint8Array([0]),
            }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.equal(r.pullsApplied.length, 1);
        assert.equal(r.pullsApplied[0].workspaceId, 'ws-2');
        assert.equal(r.pullsFailed.length, 1);
        assert.equal(r.pullsFailed[0].workspaceId, 'ws-1');
        assert.equal(r.pullsFailed[0].reason, 'snapshot_null');
    });

    await test('per-drop failure is captured + does not abort the rest', async () => {
        const cb: SpyCallbacks = {
            applied: [], removed: [],
            readLocalState: async () => [
                { workspaceId: 'ws-good', syncedVersion: 'v1' },
                { workspaceId: 'ws-bad',  syncedVersion: 'v1' },
            ],
            applySnapshot: async () => {},
            removeWorkspace: async (id) => {
                if (id === 'ws-bad') throw new Error('disk full');
                cb.removed.push(id);
            },
        };
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [] }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();
        assert.deepEqual(r.dropsApplied, ['ws-good']);
        assert.equal(r.dropsFailed.length, 1);
        assert.equal(r.dropsFailed[0].workspaceId, 'ws-bad');
        assert.match(r.dropsFailed[0].reason, /disk full/);
    });

    await test('L-035: applySnapshot gated by SyncDirectionGuard refuses cloud-only, applies local-first + unregistered', async () => {
        // Wire a real guard with one cloud-only, one local-first, and leave a
        // third workspace UNregistered. The applySnapshot callback uses the
        // SAME try/catch-on-code gate the server.ts host callback uses.
        const guard = new SyncDirectionGuard();
        guard.register({ workspace: 'ws-cloud', policy: 'cloud-only' });
        guard.register({ workspace: 'ws-local', policy: 'local-first' });
        // 'ws-unreg' intentionally not registered.

        const applied: string[] = [];
        const cb = {
            ...spyCallbacks([]),
            applySnapshot: async (workspaceId: string, _v: string, _b: Uint8Array) => {
                // Call the SAME production helper server.ts's host callback uses
                // (audit L-035 integration-verification: exercise the real gate,
                // not a hand-copied duplicate).
                guardSyncDown(guard, workspaceId);
                applied.push(workspaceId);
            },
        };

        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [
                { workspaceId: 'ws-cloud', displayName: 'C', accountId: 'acct', permissions: ['read'], version: 'v1' },
                { workspaceId: 'ws-local', displayName: 'L', accountId: 'acct', permissions: ['read'], version: 'v1' },
                { workspaceId: 'ws-unreg', displayName: 'U', accountId: 'acct', permissions: ['read'], version: 'v1' },
            ] }),
            callbacks: cb, cloudIsAuthoritative: true, log: silentLog(),
        });
        const r = await poller.tickOnce();

        // cloud-only refused → captured as a pull failure, never persisted.
        assert.deepEqual(r.pullsFailed.map(f => f.workspaceId), ['ws-cloud']);
        assert.match(r.pullsFailed[0].reason, /cloud-only/);
        assert.ok(!applied.includes('ws-cloud'), 'cloud-only workspace must not be applied');

        // local-first + unregistered both persisted (fail-open for unknown).
        assert.deepEqual(r.pullsApplied.map(p => p.workspaceId).sort(), ['ws-local', 'ws-unreg']);
        assert.deepEqual(applied.sort(), ['ws-local', 'ws-unreg']);
    });

    await test('onTickComplete fires with the result', async () => {
        let captured: unknown = null;
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [] }),
            callbacks: spyCallbacks([]),
            cloudIsAuthoritative: true,
            log: silentLog(),
            onTickComplete: (r) => { captured = r; },
        });
        await poller.tickOnce();
        assert.ok(captured);
        assert.match((captured as { completedAt: string }).completedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    await test('tickOnce is reentrant-safe — second call returns inflight', async () => {
        let resolveCloud: ((v: SyncedWorkspace[]) => void) | null = null;
        const slowCloud: CloudSyncClient = {
            async isReachable() { return true; },
            async listMyWorkspaces() {
                return new Promise<SyncedWorkspace[]>((res) => { resolveCloud = res; });
            },
            async pullWorkspaceSnapshot() { return null; },
            async pushChanges() { return { accepted: [], rejected: [] }; },
        };
        const poller = new SyncPoller({
            client: slowCloud, callbacks: spyCallbacks([]),
            cloudIsAuthoritative: true, log: silentLog(),
        });
        const p1 = poller.tickOnce();
        const p2 = poller.tickOnce();
        // Wait for the async chain inside p1 to reach listMyWorkspaces +
        // assign resolveCloud. Poll-until-set keeps the test
        // deterministic without timing assumptions.
        for (let i = 0; i < 50 && !resolveCloud; i++) {
            await new Promise((r) => setImmediate(r));
        }
        assert.ok(resolveCloud, 'slowCloud.listMyWorkspaces should have been invoked by now');
        (resolveCloud as unknown as (v: SyncedWorkspace[]) => void)([]);
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.strictEqual(r1, r2, 'concurrent calls share the same inflight promise');
    });

    await test('start() schedules first tick + subsequent at intervals', async () => {
        const ticks: number[] = [];
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [] }),
            callbacks: spyCallbacks([]),
            cloudIsAuthoritative: true,
            log: silentLog(),
            initialDelayMs: 5, intervalMs: 10,
            onTickComplete: () => { ticks.push(Date.now()); },
        });
        poller.start();
        await new Promise((r) => setTimeout(r, 40));   // enough for ~3 ticks
        poller.stop();
        assert.ok(ticks.length >= 2, `expected at least 2 ticks, got ${ticks.length}`);
    });

    await test('stop() halts further ticks', async () => {
        const ticks: number[] = [];
        const poller = new SyncPoller({
            client: fakeCloud({ workspaces: [] }),
            callbacks: spyCallbacks([]),
            cloudIsAuthoritative: true,
            log: silentLog(),
            initialDelayMs: 5, intervalMs: 10,
            onTickComplete: () => { ticks.push(1); },
        });
        poller.start();
        await new Promise((r) => setTimeout(r, 25));
        poller.stop();
        const after = ticks.length;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(ticks.length, after, 'no more ticks after stop()');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
