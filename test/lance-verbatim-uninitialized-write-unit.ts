#!/usr/bin/env tsx
/**
 * lance-verbatim-uninitialized-write-unit.ts - LanceDB VerbatimStore mutators on a never-initialized or closed
 * store must throw a typed error (applied === false), never resolve as a silent no-op.
 *
 * Before the fix: physicalDelete / physicalDeleteMany / purgeWithHistory / tombstone returned normally
 * (`if (!this.initialized || !this.db) return;`) and store / storeBatch threw an untyped Error('Store not initialized').
 *
 * Run: npx tsx test/lance-verbatim-uninitialized-write-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore, VerbatimStoreClosedError } from '../packages/lore/src/engines/verbatimStore.js';
import { isVerbatimStoreClosedError, isVerbatimStoreNotInitializedError, VerbatimStoreNotInitializedError } from '../packages/lore/src/engines/verbatimStoreClosedError.js';
import { isSqliteOrRetiredTransient } from '../packages/lore/src/outbox/failureDisposition.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env.LORE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lance-uninit-home-'));
process.env.LORE_MODEL_SERVER = '0';

const DIM = 4;
const provider: EmbeddingProvider = {
    modelId: 'lance-uninit-stub', dimension: DIM,
    async initialize() { /* no-op */ },
    async embed() { return [1, 0, 0.5, 0.25]; }, async embedDocument() { return [1, 0, 0.5, 0.25]; }, async embedQuery() { return [1, 0, 0.5, 0.25]; },
    async embedDocumentBatch(t: string[]) { return t.map(() => [1, 0, 0.5, 0.25]); },
} as EmbeddingProvider;
const dirs: string[] = [process.env.LORE_HOME!];
const mkdir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lance-uninit-ws-')); dirs.push(d); return d; };
const doc = (id: string, text: string) => ({ id, text, metadata: {} });
const row = (id: string, text: string): Record<string, unknown> => ({
    id, text, vector: [1, 0, 0.5, 0.25], type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e',
    updatedAt: '2026-10-24T00:00:00.000Z', security_scopes: [], contentHash: `h-${id}`,
});

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const mutators: Array<{ name: string; call: (s: VerbatimStore) => Promise<unknown> }> = [
    { name: 'store', call: (s) => s.store(doc('n1', 'x')) },
    { name: 'storeBatch', call: (s) => s.storeBatch([doc('n2', 'x')]) },
    { name: 'bulkAddPrebuiltRows', call: (s) => s.bulkAddPrebuiltRows([row('n3', 'x')]) },
    { name: 'bulkUpsertPrebuiltRows', call: (s) => s.bulkUpsertPrebuiltRows([row('n4', 'x')]) },
    { name: 'tombstone', call: (s) => s.tombstone('a', 'test') },
    { name: 'physicalDelete', call: (s) => s.physicalDelete('a') },
    { name: 'physicalDeleteMany', call: (s) => s.physicalDeleteMany(['a']) },
    { name: 'purgeWithHistory', call: (s) => s.purgeWithHistory(['a']) },
];

async function seeded(): Promise<{ dir: string; store: VerbatimStore }> {
    const dir = mkdir();
    const store = new VerbatimStore(dir, provider, { pieceVectors: false });
    await store.initialize();
    await store.store(doc('a', 'seed a'));
    return { dir, store };
}
async function ids(dir: string): Promise<string[]> {
    const s = new VerbatimStore(dir, provider, { pieceVectors: false });
    await s.initialize();
    try { return (await s.listIds()).sort(); } finally { await s.close(); }
}

for (const m of mutators) {
    await test(`${m.name}() on a never-initialized store rejects with VerbatimStoreNotInitializedError`, async () => {
        const dir = mkdir();
        const s = new VerbatimStore(dir, provider, { pieceVectors: false });
        let thrown: unknown;
        try { await m.call(s); } catch (e) { thrown = e; }
        assert.ok(thrown, `${m.name}() resolved silently on a never-initialized store`);
        assert.ok(thrown instanceof VerbatimStoreNotInitializedError || isVerbatimStoreNotInitializedError(thrown), `wrong error: ${(thrown as Error).name}: ${(thrown as Error).message}`);
        assert.equal((thrown as { applied?: boolean }).applied, false);
        assert.equal(isSqliteOrRetiredTransient(thrown), true, 'outbox must classify it transient');
    });
    await test(`${m.name}() on a closed store rejects with VerbatimStoreClosedError and leaves the row`, async () => {
        const { dir, store } = await seeded();
        await store.close();
        let thrown: unknown;
        try { await m.call(store); } catch (e) { thrown = e; }
        assert.ok(thrown, `${m.name}() resolved silently on a closed store`);
        assert.ok(thrown instanceof VerbatimStoreClosedError, `wrong error: ${(thrown as Error).name}: ${(thrown as Error).message}`);
        assert.ok(isVerbatimStoreClosedError(thrown));
        assert.equal((thrown as VerbatimStoreClosedError).applied, false);
        assert.equal(isSqliteOrRetiredTransient(thrown), true);
        assert.deepEqual(await ids(dir), ['a'], 'a rejected write must leave the table untouched');
    });
}

await test('a closed store that is initialize()d again accepts writes (reconnect clears the closed state)', async () => {
    const { dir, store } = await seeded();
    await store.close();
    await store.initialize();
    await store.store(doc('b', 'after reopen'));
    await store.physicalDelete('a');
    await store.close();
    assert.deepEqual(await ids(dir), ['b']);
});

await test('normal path unchanged: writes on an open store land and delete/tombstone act', async () => {
    const { dir, store } = await seeded();
    await store.storeBatch([doc('c', 'c'), doc('d', 'd')]);
    assert.equal(await store.physicalDeleteMany(['c']), 1);
    await store.tombstone('d', 'test');
    assert.equal(await store.physicalDeleteMany([]), 0, 'empty id list stays a no-op');
    await store.close();
    const live = await ids(dir);
    assert.ok(live.includes('a') && !live.includes('c'));
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nlance-verbatim-uninitialized-write-unit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
