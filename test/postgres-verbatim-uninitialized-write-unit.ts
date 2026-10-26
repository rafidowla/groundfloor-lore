#!/usr/bin/env tsx
/**
 * postgres-verbatim-uninitialized-write-unit.ts - PostgresVerbatimStore mutators on a never-initialized or closed
 * store must throw a typed error (applied === false) instead of resolving as a silent no-op.
 *
 * Before the fix every mutator opened with `if (!this.initialized) return;` so the outbox read the call as success.
 * The guard fires before any pool use, so a pool factory that fails the test if invoked is enough (no database).
 *
 * Run: npx tsx test/postgres-verbatim-uninitialized-write-unit.ts
 */
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { isVerbatimStoreClosedError, isVerbatimStoreNotInitializedError } from '../packages/lore/src/engines/verbatimStoreClosedError.js';
import { isSqliteOrRetiredTransient } from '../packages/lore/src/outbox/failureDisposition.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env.LORE_MODEL_SERVER = '0';
const provider = {
    modelId: 'pg-uninit-stub', dimension: 4,
    async initialize() { /* no-op */ },
    async embed() { return [1, 0, 0, 0]; }, async embedDocument() { return [1, 0, 0, 0]; }, async embedQuery() { return [1, 0, 0, 0]; },
    async embedDocumentBatch(t: string[]) { return t.map(() => [1, 0, 0, 0]); },
} as EmbeddingProvider;
const poolFactory = (): Pool => { throw new Error('pool must not be touched by a rejected write'); };
const mk = (): PostgresVerbatimStore => new PostgresVerbatimStore('/tmp/pg-uninit', poolFactory, 'ws-uninit', provider);
const doc = (id: string) => ({ id, text: 'x', metadata: {} });

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const mutators: Array<{ name: string; call: (s: PostgresVerbatimStore) => Promise<unknown> }> = [
    { name: 'store', call: (s) => s.store(doc('a')) },
    { name: 'storeBatch', call: (s) => s.storeBatch([doc('a')]) },
    { name: 'bulkAddPrebuiltRows', call: (s) => s.bulkAddPrebuiltRows([{ id: 'a' }]) },
    { name: 'bulkUpsertPrebuiltRows', call: (s) => s.bulkUpsertPrebuiltRows([{ id: 'a' }]) },
    { name: 'tombstone', call: (s) => s.tombstone('a', 'test') },
    { name: 'physicalDelete', call: (s) => s.physicalDelete('a') },
    { name: 'physicalDeleteMany', call: (s) => s.physicalDeleteMany(['a']) },
    { name: 'purgeWithHistory', call: (s) => s.purgeWithHistory(['a']) },
];

for (const m of mutators) {
    await test(`${m.name}() before initialize() rejects with VerbatimStoreNotInitializedError`, async () => {
        let thrown: unknown;
        try { await m.call(mk()); } catch (e) { thrown = e; }
        assert.ok(thrown, `${m.name}() resolved silently on a never-initialized store`);
        assert.ok(isVerbatimStoreNotInitializedError(thrown), `wrong error: ${(thrown as Error).name}: ${(thrown as Error).message}`);
        assert.equal((thrown as { applied?: boolean }).applied, false);
        assert.equal(isSqliteOrRetiredTransient(thrown), true);
    });
    await test(`${m.name}() after close() rejects with VerbatimStoreClosedError`, async () => {
        const s = mk();
        await s.close();
        let thrown: unknown;
        try { await m.call(s); } catch (e) { thrown = e; }
        assert.ok(thrown, `${m.name}() resolved silently on a closed store`);
        assert.ok(isVerbatimStoreClosedError(thrown), `wrong error: ${(thrown as Error).name}: ${(thrown as Error).message}`);
        assert.equal(isSqliteOrRetiredTransient(thrown), true);
    });
}

await test('empty id list stays a no-op on an uninitialized store', async () => {
    const s = mk();
    assert.equal(await s.physicalDeleteMany([]), 0);
    assert.equal(await s.purgeWithHistory([]), 0);
    await s.storeBatch([]);
});

console.log(`\npostgres-verbatim-uninitialized-write-unit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
