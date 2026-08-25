#!/usr/bin/env tsx
/**
 * http-sync-client-unit.ts — HttpSyncClient against a stub fetch.
 *
 * No real network. Stub fetch records every request + returns canned
 * responses. Verifies wire shape, auth header, error fall-open, and
 * the safe-degenerate values the polling loop relies on.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HttpSyncClient } from '../packages/lore/src/sync/httpSyncClient.js';
import type { SyncPushChange } from '../packages/lore/src/sync/cloudSyncClient.js';

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(opts: {
    status?: number;
    body?: unknown;
    bytes?: Uint8Array;
    headers?: Record<string, string>;
    throws?: Error;
}): { fn: typeof fetch; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            headers: (init?.headers as Record<string, string>) ?? {},
            body: init?.body ? JSON.parse(init.body as string) : null,
        });
        if (opts.throws) throw opts.throws;
        const status = opts.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (k: string) => opts.headers?.[k.toLowerCase()] ?? opts.headers?.[k] ?? null },
            json: async () => opts.body,
            arrayBuffer: async () => (opts.bytes ?? new Uint8Array()).buffer,
        } as Response;
    }) as unknown as typeof fetch;
    return { fn, calls };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('HttpSyncClient');

    await test('listMyWorkspaces hits GET /sync/workspaces with Bearer auth', async () => {
        const { fn, calls } = fakeFetch({ body: { workspaces: [
            { workspaceId: 'ws-1', displayName: 'Project 1', accountId: 'acct-a',
              permissions: ['read', 'write'], version: 'v1' },
        ] } });
        const c = new HttpSyncClient({ baseUrl: 'https://lore.example.com', getAuthToken: () => 'tok-abc', fetchImpl: fn });
        const list = await c.listMyWorkspaces();
        assert.equal(list.length, 1);
        assert.equal(list[0].workspaceId, 'ws-1');
        assert.equal(calls[0].url, 'https://lore.example.com/sync/workspaces');
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[0].headers['Authorization'], 'Bearer tok-abc');
    });

    await test('listMyWorkspaces strips trailing slash on baseUrl', async () => {
        const { fn, calls } = fakeFetch({ body: { workspaces: [] } });
        const c = new HttpSyncClient({ baseUrl: 'https://lore.example.com/', getAuthToken: () => 't', fetchImpl: fn });
        await c.listMyWorkspaces();
        assert.equal(calls[0].url, 'https://lore.example.com/sync/workspaces');
    });

    // RA2-reaudit2 (CRITICAL) — listMyWorkspaces must THROW on failure, not
    // return []. A swallowed [] makes reconcile() drop every local workspace
    // when the cloud is authoritative, so a transient 401/5xx/network blip
    // would wipe all local data. Failure must be distinguishable from empty.
    await test('listMyWorkspaces THROWS on non-2xx (must not look like an empty list)', async () => {
        const { fn } = fakeFetch({ status: 503, body: null });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        await assert.rejects(() => c.listMyWorkspaces(), /HTTP 503|failed/i);
    });

    await test('listMyWorkspaces THROWS when fetch throws (transport error)', async () => {
        const { fn } = fakeFetch({ throws: new Error('ECONNREFUSED') });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        await assert.rejects(() => c.listMyWorkspaces(), /ECONNREFUSED/);
    });

    await test('listMyWorkspaces sends no Authorization header when token getter returns null', async () => {
        const { fn, calls } = fakeFetch({ body: { workspaces: [] } });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => null, fetchImpl: fn });
        await c.listMyWorkspaces();
        assert.equal(calls[0].headers['Authorization'], undefined);
    });

    await test('pullWorkspaceSnapshot returns SyncSnapshot with bytes + sha256', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        // F-L072 — the client now verifies sha256(bytes) === x-content-sha256
        // before returning, so the mock must present the REAL digest.
        const realSha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
        const { fn, calls } = fakeFetch({ bytes, headers: { 'x-content-sha256': realSha } });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        const snap = await c.pullWorkspaceSnapshot('ws-1', 'v2');
        assert.ok(snap);
        assert.equal(snap?.workspaceId, 'ws-1');
        assert.equal(snap?.version, 'v2');
        assert.deepEqual(Array.from(snap!.bytes), [1, 2, 3, 4]);
        assert.equal(snap?.sha256, realSha);
        assert.match(calls[0].url, /\/sync\/workspaces\/ws-1\/snapshot\?version=v2$/);
    });

    await test('pullWorkspaceSnapshot URL-encodes workspaceId + version', async () => {
        const { fn, calls } = fakeFetch({ bytes: new Uint8Array() });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        await c.pullWorkspaceSnapshot('ws/with slash', 'v 1');
        assert.match(calls[0].url, /\/sync\/workspaces\/ws%2Fwith%20slash\/snapshot\?version=v%201$/);
    });

    await test('pullWorkspaceSnapshot returns null on non-2xx', async () => {
        const { fn } = fakeFetch({ status: 404 });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        assert.equal(await c.pullWorkspaceSnapshot('ws', 'v'), null);
    });

    await test('pullWorkspaceSnapshot THROWS on transport error (F-LOW-S12 — distinguishable from a 404)', async () => {
        // F-LOW-S12: a transport failure must NOT masquerade as "no snapshot"
        // (null is reserved for a genuine 404); it propagates so the poller
        // records pullsFailed instead of silently treating it as not-found.
        const { fn } = fakeFetch({ throws: new Error('boom') });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        await assert.rejects(() => c.pullWorkspaceSnapshot('ws', 'v'), /boom/);
    });

    await test('pushChanges hits POST /sync/workspaces/{id}/push with body', async () => {
        const { fn, calls } = fakeFetch({ body: { accepted: ['c1'], rejected: [] } });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        const changes: SyncPushChange[] = [
            { id: 'c1', workspaceId: 'ws-1', op: 'upsert_node', payload: { id: 'n1' }, capturedAt: '2026-05-10T00:00:00Z' },
        ];
        const r = await c.pushChanges('ws-1', changes);
        assert.deepEqual(r.accepted, ['c1']);
        assert.equal(calls[0].url, 'http://x/sync/workspaces/ws-1/push');
        assert.equal(calls[0].method, 'POST');
        assert.deepEqual(calls[0].body, { changes });
        assert.equal(calls[0].headers['Content-Type'], 'application/json');
    });

    await test('pushChanges with empty input skips the call entirely', async () => {
        const { fn, calls } = fakeFetch({ body: null });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        const r = await c.pushChanges('ws', []);
        assert.deepEqual(r, { accepted: [], rejected: [] });
        assert.equal(calls.length, 0, 'no fetch call when changes is empty');
    });

    await test('pushChanges rejects every change on non-2xx with HTTP-status reason', async () => {
        const { fn } = fakeFetch({ status: 503 });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        const changes: SyncPushChange[] = [
            { id: 'c1', workspaceId: 'ws', op: 'op', payload: {}, capturedAt: 't' },
            { id: 'c2', workspaceId: 'ws', op: 'op', payload: {}, capturedAt: 't' },
        ];
        const r = await c.pushChanges('ws', changes);
        assert.deepEqual(r.accepted, []);
        assert.equal(r.rejected.length, 2);
        for (const x of r.rejected) assert.match(x.reason, /push_failed: HTTP 503/);
    });

    await test('pushChanges rejects every change on transport error', async () => {
        const { fn } = fakeFetch({ throws: new Error('socket hang up') });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        const r = await c.pushChanges('ws', [
            { id: 'c1', workspaceId: 'ws', op: 'op', payload: {}, capturedAt: 't' },
        ]);
        assert.equal(r.rejected.length, 1);
        assert.match(r.rejected[0].reason, /transport_error.*socket hang up/);
    });

    await test('isReachable returns true on 200 from /sync/health', async () => {
        const { fn, calls } = fakeFetch({ body: { ok: true } });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        assert.equal(await c.isReachable(), true);
        assert.equal(calls[0].url, 'http://x/sync/health');
    });

    await test('isReachable returns false on non-2xx', async () => {
        const { fn } = fakeFetch({ status: 503 });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        assert.equal(await c.isReachable(), false);
    });

    await test('isReachable returns false on transport error', async () => {
        const { fn } = fakeFetch({ throws: new Error('boom') });
        const c = new HttpSyncClient({ baseUrl: 'http://x', getAuthToken: () => 't', fetchImpl: fn });
        assert.equal(await c.isReachable(), false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
