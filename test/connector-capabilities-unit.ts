#!/usr/bin/env tsx
/**
 * connector-capabilities-unit.ts — covers the GET /connectors probe +
 * TTL cache + hasCapability wrapper used by bm25Search.
 *
 * Stub fetch is injected so we never hit a real network. The
 * dataplane response shape mirrors what `GET /connectors` returns
 * today (verified live during this PR's build).
 */

import assert from 'node:assert/strict';
import {
    fetchConnectors,
    getConnectorCapabilities,
    hasCapability,
    _clearCapabilityCache,
} from '../packages/lore/src/engines/connectorCapabilities.js';

interface FakeFetchOpts {
    status?: number;
    body?: unknown;
    throws?: Error;
}

function fakeFetch(opts: FakeFetchOpts): { fn: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (opts.throws) throw opts.throws;
        return {
            ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
            status: opts.status ?? 200,
            json: async () => opts.body,
        } as Response;
    }) as unknown as typeof fetch;
    return { fn, calls };
}

const SAMPLE_BODY = {
    success: true,
    data: {
        connectors: [
            { name: 'postgresql', version: '0.1.0', capabilities: ['Crud', 'Sql'] },
            { name: 'arangodb',   version: '0.1.0', capabilities: ['Crud', 'FullTextSearch', 'RankedFullTextSearch', 'Vector'] },
        ],
    },
};

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('connectorCapabilities');

    await test('fetchConnectors returns connector list on success', async () => {
        const { fn } = fakeFetch({ body: SAMPLE_BODY });
        const list = await fetchConnectors('http://dp', 'key', fn);
        assert.equal(list?.length, 2);
        assert.equal(list?.[1].name, 'arangodb');
    });

    await test('fetchConnectors sends Bearer auth + GET /connectors', async () => {
        const { fn, calls } = fakeFetch({ body: SAMPLE_BODY });
        await fetchConnectors('http://dp/', 'my-key', fn); // trailing slash on baseUrl
        assert.equal(calls[0].url, 'http://dp/connectors', 'should strip trailing slash + hit /connectors');
        const auth = (calls[0].init?.headers as Record<string,string>)?.Authorization;
        assert.equal(auth, 'Bearer my-key');
    });

    await test('fetchConnectors returns null on non-2xx', async () => {
        const { fn } = fakeFetch({ status: 500, body: { success: false } });
        assert.equal(await fetchConnectors('http://dp', 'key', fn), null);
    });

    await test('fetchConnectors returns null on success:false body', async () => {
        const { fn } = fakeFetch({ body: { success: false, data: null } });
        assert.equal(await fetchConnectors('http://dp', 'key', fn), null);
    });

    await test('fetchConnectors returns null on throw (network)', async () => {
        const { fn } = fakeFetch({ throws: new Error('ECONNREFUSED') });
        assert.equal(await fetchConnectors('http://dp', 'key', fn), null);
    });

    await test('getConnectorCapabilities caches by (baseUrl, key-prefix)', async () => {
        _clearCapabilityCache();
        const { fn, calls } = fakeFetch({ body: SAMPLE_BODY });
        await getConnectorCapabilities('http://dp', 'key', { fetchImpl: fn });
        await getConnectorCapabilities('http://dp', 'key', { fetchImpl: fn });
        await getConnectorCapabilities('http://dp', 'key', { fetchImpl: fn });
        assert.equal(calls.length, 1, '3 calls should hit cache after the first');
    });

    await test('getConnectorCapabilities refetches after ttl expires', async () => {
        _clearCapabilityCache();
        const { fn, calls } = fakeFetch({ body: SAMPLE_BODY });
        await getConnectorCapabilities('http://dp', 'key', { fetchImpl: fn, ttlMs: 0 });
        await getConnectorCapabilities('http://dp', 'key', { fetchImpl: fn, ttlMs: 0 });
        assert.equal(calls.length, 2, 'ttl=0 forces refetch each call');
    });

    await test('hasCapability returns true for advertised capability', async () => {
        _clearCapabilityCache();
        const { fn } = fakeFetch({ body: SAMPLE_BODY });
        const r = await hasCapability('http://dp', 'key', 'RankedFullTextSearch', { fetchImpl: fn });
        assert.equal(r, true);
    });

    await test('hasCapability returns false for unknown capability', async () => {
        _clearCapabilityCache();
        const { fn } = fakeFetch({ body: SAMPLE_BODY });
        const r = await hasCapability('http://dp', 'key', 'TimeTravel', { fetchImpl: fn });
        assert.equal(r, false);
    });

    await test('hasCapability returns null when probe fails (caller falls open)', async () => {
        _clearCapabilityCache();
        const { fn } = fakeFetch({ throws: new Error('boom') });
        const r = await hasCapability('http://dp', 'key', 'RankedFullTextSearch', { fetchImpl: fn });
        assert.equal(r, null);
    });

    await test('cache key includes baseUrl — different URLs cache separately', async () => {
        _clearCapabilityCache();
        const { fn, calls } = fakeFetch({ body: SAMPLE_BODY });
        await getConnectorCapabilities('http://dp1', 'same-key-aaaaaaaa', { fetchImpl: fn });
        await getConnectorCapabilities('http://dp2', 'same-key-aaaaaaaa', { fetchImpl: fn });
        assert.equal(calls.length, 2);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
