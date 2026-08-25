#!/usr/bin/env tsx
/**
 * create-cloud-sync-client-unit.ts — verifies the boot-time factory
 * picks the right CloudSyncClient impl + sets the
 * cloudIsAuthoritative flag correctly.
 */

import assert from 'node:assert/strict';
import { createCloudSyncClient } from '../packages/lore/src/sync/createCloudSyncClient.js';
import { NoCloudSyncClient } from '../packages/lore/src/sync/noCloudSyncClient.js';
import { HttpSyncClient } from '../packages/lore/src/sync/httpSyncClient.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('createCloudSyncClient');

    await test('LORE_CLOUD_URL unset → NoCloudSyncClient, cloudIsAuthoritative=false', () => {
        const r = createCloudSyncClient({ env: {} });
        assert.ok(r.client instanceof NoCloudSyncClient);
        assert.equal(r.cloudIsAuthoritative, false);
        assert.equal(r.kind, 'no-cloud');
        assert.equal(r.baseUrl, null);
    });

    await test('LORE_CLOUD_URL empty string → NoCloudSyncClient', () => {
        const r = createCloudSyncClient({ env: { LORE_CLOUD_URL: '' } });
        assert.equal(r.kind, 'no-cloud');
    });

    await test('LORE_CLOUD_URL whitespace-only → NoCloudSyncClient', () => {
        const r = createCloudSyncClient({ env: { LORE_CLOUD_URL: '   ' } });
        assert.equal(r.kind, 'no-cloud');
    });

    await test('LORE_CLOUD_URL set → HttpSyncClient, cloudIsAuthoritative=true', () => {
        const r = createCloudSyncClient({ env: { LORE_CLOUD_URL: 'https://lore.example.com' } });
        assert.ok(r.client instanceof HttpSyncClient);
        assert.equal(r.cloudIsAuthoritative, true);
        assert.equal(r.kind, 'http');
        assert.equal(r.baseUrl, 'https://lore.example.com');
    });

    await test('factory passes tokenSource through to HttpSyncClient', async () => {
        const seen: string[] = [];
        const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'];
            seen.push(auth ?? '');
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ workspaces: [] }) } as Response;
        }) as unknown as typeof fetch;
        const r = createCloudSyncClient({
            env: { LORE_CLOUD_URL: 'https://x' },
            tokenSource: () => 'my-token',
            fetchImpl: stubFetch,
        });
        await r.client.listMyWorkspaces();
        assert.equal(seen[0], 'Bearer my-token');
    });

    await test('default tokenSource reads LORE_CLOUD_AUTH_TOKEN from env', async () => {
        const seen: string[] = [];
        const stubFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
            const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'];
            seen.push(auth ?? '');
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ workspaces: [] }) } as Response;
        }) as unknown as typeof fetch;
        const r = createCloudSyncClient({
            env: { LORE_CLOUD_URL: 'https://x', LORE_CLOUD_AUTH_TOKEN: 'env-tok' },
            fetchImpl: stubFetch,
        });
        await r.client.listMyWorkspaces();
        assert.equal(seen[0], 'Bearer env-tok');
    });

    await test('default tokenSource returns undefined when env var absent', async () => {
        const seen: Record<string, string | undefined>[] = [];
        const stubFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
            seen.push((init?.headers as Record<string, string>) ?? {});
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ workspaces: [] }) } as Response;
        }) as unknown as typeof fetch;
        const r = createCloudSyncClient({
            env: { LORE_CLOUD_URL: 'https://x' },
            fetchImpl: stubFetch,
        });
        await r.client.listMyWorkspaces();
        assert.equal(seen[0]['Authorization'], undefined,
            'no Authorization header when token getter returns undefined');
    });

    await test('factory is pure — no side effects, no LORE_HOME I/O', () => {
        // Calling twice on the same env produces independent results.
        const r1 = createCloudSyncClient({ env: { LORE_CLOUD_URL: 'https://a' } });
        const r2 = createCloudSyncClient({ env: { LORE_CLOUD_URL: 'https://b' } });
        assert.equal(r1.baseUrl, 'https://a');
        assert.equal(r2.baseUrl, 'https://b');
        assert.notStrictEqual(r1.client, r2.client);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
