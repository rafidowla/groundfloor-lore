#!/usr/bin/env tsx
/**
 * Lore tenant-first calls map onto the collection-first SDK.
 */

import assert from 'node:assert/strict';
import * as compat from '../packages/lore/src/engines/dataplaneSdkCompat.js';
import { asLoreDataplaneSdk, createLoreDataplaneSdk, type CollectionFirstSdk } from '../packages/lore/src/engines/dataplaneSdkCompat.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const calls: Array<{ op: string; args: unknown[] }> = [];
const raw = {
    createCollection: async (...args: unknown[]) => { calls.push({ op: 'createCollection', args }); return args[0]; },
    insert: async (...args: unknown[]) => { calls.push({ op: 'insert', args }); return args[1]; },
    get: async (...args: unknown[]) => { calls.push({ op: 'get', args }); return { id: args[1] }; },
    query: async (...args: unknown[]) => { calls.push({ op: 'query', args }); return { records: [] }; },
    updateByQuery: async (...args: unknown[]) => { calls.push({ op: 'updateByQuery', args }); return { updated: 0 }; },
    deleteByQuery: async (...args: unknown[]) => { calls.push({ op: 'deleteByQuery', args }); return { deleted: 0 }; },
    count: async (...args: unknown[]) => { calls.push({ op: 'count', args }); return 0; },
} as CollectionFirstSdk;

console.log('dataplane SDK compat (tenant-first → collection-first)');

await test('insert drops tenant positional (SDK collection-first)', async () => {
    calls.length = 0;
    const lore = asLoreDataplaneSdk(raw);
    await lore.insert('tenant-alpha', 'lore_node', { id: 'n1' }, 'sqlite');
    assert.deepEqual(calls[0]?.args, ['lore_node', { id: 'n1' }, 'sqlite']);
});

await test('updateByQuery / createCollection drop tenant positional', async () => {
    calls.length = 0;
    const lore = asLoreDataplaneSdk(raw);
    await lore.updateByQuery('tenant-beta', 'lore_verbatim', { id_eq: 'x' }, { text: 't' });
    await lore.createCollection('tenant-beta', { name: 'lore_node' });
    assert.deepEqual(calls[0]?.args, ['lore_verbatim', { id_eq: 'x' }, { text: 't' }, undefined]);
    assert.deepEqual(calls[1]?.args, [{ name: 'lore_node' }, undefined]);
});

await test('search forwards collection-first (no tenant positional) and returns the hits', async () => {
    calls.length = 0;
    const withSearch = {
        ...raw,
        search: async (...args: unknown[]) => { calls.push({ op: 'search', args }); return [{ id: 'h1', _score: 2 }]; },
    } as unknown as CollectionFirstSdk;
    const lore = asLoreDataplaneSdk(withSearch);
    const hits = await lore.search!('lore_verbatim', 'hello', { fields: ['text'], limit: 5 });
    assert.deepEqual(calls[0]?.args, ['lore_verbatim', 'hello', { fields: ['text'], limit: 5 }]);
    assert.equal(hits[0]?._score, 2);
});

await test('search on an SDK build without it rejects with a clear error (bm25Search degrades, never crashes)', async () => {
    const lore = asLoreDataplaneSdk(raw);
    await assert.rejects(() => lore.search!('lore_verbatim', 'x'), /search/i);
});

// D9 (cloud parity C item 11): the Dataplane workspace is fixed by the API credential and the engine
// ignores X-Tenant-Id, so the SDK shim must not forge it from the Lore workspace (a Lore workspace is
// an app tenant in a column, never a Dataplane routing input). Fake SDK class: methods go through
// `this.fetch(path, options)` exactly like groundfloor-ts-sdk's client.
await test('no X-Tenant-Id header is sent, even with a Lore workspace bound', async () => {
    const sent: Array<{ path: string; headers: Record<string, string> | undefined }> = [];
    class FakeSdk {
        constructor(public baseUrl: string, public apiKey: string) {}
        protected async fetch<T>(path: string, options?: RequestInit): Promise<T> {
            sent.push({ path, headers: options?.headers as Record<string, string> | undefined });
            return {} as T;
        }
        async insert(collection: string, record: unknown): Promise<unknown> {
            return this.fetch(`/v1/${collection}`, { method: 'POST', headers: { Authorization: 'Bearer k' }, body: JSON.stringify(record) });
        }
    }
    const lore = createLoreDataplaneSdk(FakeSdk as never, 'http://x', 'k');
    await runWithWorkspace({ workspaceId: 'some-lore-workspace' }, () => lore.insert('ignored-tenant', 'lore_node', { id: 'n' }));
    assert.equal(sent.length, 1);
    for (const h of Object.keys(sent[0]!.headers ?? {})) assert.notEqual(h.toLowerCase(), 'x-tenant-id', 'X-Tenant-Id must not be sent');
    assert.equal((sent[0]!.headers ?? {})['Authorization'], 'Bearer k', 'the SDK own headers are untouched');
});

await test('the header-injecting subclass and its constant are gone', () => {
    const ns = compat as unknown as Record<string, unknown>;
    assert.equal(ns['makeTenantAwareDataplaneClient'], undefined);
    assert.equal(ns['SDK_TENANT_ID_HEADER'], undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
