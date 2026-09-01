#!/usr/bin/env tsx
/**
 * Lore tenant-first calls map onto the collection-first SDK.
 */

import assert from 'node:assert/strict';
import { asLoreDataplaneSdk, type CollectionFirstSdk } from '../packages/lore/src/engines/dataplaneSdkCompat.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
