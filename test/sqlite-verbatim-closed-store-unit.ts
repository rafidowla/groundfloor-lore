#!/usr/bin/env tsx
/**
 * sqlite-verbatim-closed-store-unit.ts - a write on a CLOSED SqliteVerbatimStore must fail loudly.
 *
 * Before the fix, close() set `initialized = false` and every write method opened with
 * `if (!this.initialized) return;`, so the call resolved without writing and the outbox marked the row
 * replicated. This suite proves, for every mutator, that:
 *   (a) the call rejects with VerbatimStoreClosedError (applied === false) and writes nothing (checked by
 *       reopening the file with a fresh store);
 *   (b) it is NOT a VerbatimStoreRetiredError and the retired-retry path never consults the resolver
 *       (resolving the workspace would re-open a store that shutdown just closed);
 *   (c) a write parked behind the promotion barrier that resumes after close() also rejects with it;
 *   (d) the outbox classifies it as transient (replay later, attempt not counted, never success, never a
 *       counted dead-letter attempt);
 *   (e) normal shutdown ordering is unaffected: writes awaited before close() still land, and a double
 *       close() stays a no-op.
 *
 * Run: npx tsx test/sqlite-verbatim-closed-store-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStoreClosedError, isVerbatimStoreClosedError } from '../packages/lore/src/engines/verbatimStoreClosedError.js';
import { VerbatimStoreRetiredError, isVerbatimStoreRetiredError, raiseWriteBarrier } from '../packages/lore/src/engines/verbatimWriteBarrier.js';
import { isSqliteOrRetiredTransient, makeDispositionEnv, recordReplayFailure, DEFAULT_TRANSIENT_CONFIG } from '../packages/lore/src/outbox/failureDisposition.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

process.env.LORE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-store-home-'));
process.env.LORE_MODEL_SERVER = '0';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class DetEmbedder implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'closed-store-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private v(t: string): number[] { const a = new Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) a[i % DIM] += t.charCodeAt(i) / 128; return a; }
    async embed(t: string) { return this.v(t); }
    async embedQuery(t: string) { return this.v(t); }
    async embedDocument(t: string) { return this.v(t); }
    async embedDocumentBatch(ts: string[]) { return ts.map((t) => this.v(t)); }
    vec(t: string): number[] { return this.v(t); }
}
const provider = new DetEmbedder();
const dirs: string[] = [process.env.LORE_HOME!];
const tmpWs = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-store-ws-')); dirs.push(d); return d; };
const row = (id: string, text: string): Record<string, unknown> => ({
    id, text, vector: provider.vec(text), type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e',
    updatedAt: '2026-10-24T00:00:00.000Z', security_scopes: [], contentHash: `h-${id}`,
});

interface Fixture { ws: string; store: SqliteVerbatimStore; successorCalls: { n: number } }
/** Open a store with 3 seed rows (a, b, c) and a resolveSuccessor spy, then close it. */
async function closedStore(): Promise<Fixture> {
    const ws = tmpWs();
    const successorCalls = { n: 0 };
    const store = new SqliteVerbatimStore(ws, provider, { resolveSuccessor: () => { successorCalls.n++; return undefined; } });
    await store.initialize();
    for (const id of ['a', 'b', 'c']) await store.store({ id, text: `seed ${id}`, metadata: {} });
    await store.close();
    return { ws, store, successorCalls };
}
/** Reopen the file with a fresh store and snapshot what is in it. */
async function snapshot(ws: string): Promise<{ ids: string[]; tombstoned: string[] }> {
    const s = new SqliteVerbatimStore(ws, provider);
    await s.initialize();
    try {
        const ids = (await s.listIds()).sort();
        const tombstoned: string[] = [];
        for (const id of ids) { const r = await s.getById(id); if (!r || (r as { tombstoned?: boolean }).tombstoned) tombstoned.push(id); }
        return { ids, tombstoned };
    } finally { await s.close(); }
}

const mutators: Array<{ name: string; call: (s: SqliteVerbatimStore) => Promise<unknown> }> = [
    { name: 'store', call: (s) => s.store({ id: 'new1', text: 'must not land', metadata: {} }) },
    { name: 'storeBatch', call: (s) => s.storeBatch([{ id: 'new2', text: 'must not land', metadata: {} }]) },
    { name: 'bulkAddPrebuiltRows', call: (s) => s.bulkAddPrebuiltRows([row('new3', 'must not land')]) },
    { name: 'bulkUpsertPrebuiltRows', call: (s) => s.bulkUpsertPrebuiltRows([row('new4', 'must not land'), row('a', 'overwrite attempt')]) },
    { name: 'delete', call: (s) => s.delete('a') },
    { name: 'tombstone', call: (s) => s.tombstone('a', 'closed-store test') },
    { name: 'physicalDelete', call: (s) => s.physicalDelete('a') },
    { name: 'physicalDeleteMany', call: (s) => s.physicalDeleteMany(['a', 'b']) },
    { name: 'purgeWithHistory', call: (s) => s.purgeWithHistory(['a', 'b']) },
];

for (const m of mutators) {
    await test(`${m.name}() on a closed store rejects with VerbatimStoreClosedError and writes nothing`, async () => {
        const f = await closedStore();
        const before = await snapshot(f.ws);
        assert.deepEqual(before.ids, ['a', 'b', 'c']);
        let thrown: unknown;
        try { await m.call(f.store); } catch (e) { thrown = e; }
        assert.ok(thrown, `${m.name}() resolved silently on a closed store (the write was dropped without an error)`);
        assert.ok(thrown instanceof VerbatimStoreClosedError, `wrong error: ${(thrown as Error).name}: ${(thrown as Error).message}`);
        assert.equal((thrown as VerbatimStoreClosedError).applied, false);
        assert.ok(isVerbatimStoreClosedError(thrown));
        assert.ok(!isVerbatimStoreRetiredError(thrown), 'closed must be distinct from retired');
        assert.equal(f.successorCalls.n, 0, 'the retired-retry path must not resolve a successor for a closed store');
        assert.deepEqual(await snapshot(f.ws), before, 'a rejected write must leave the file untouched');
    });
}

await test('a write parked behind the promotion barrier that resumes after close() rejects with VerbatimStoreClosedError', async () => {
    const ws = tmpWs();
    const store = new SqliteVerbatimStore(ws, provider);
    await store.initialize();
    const handle = await raiseWriteBarrier(ws);
    assert.ok(handle);
    const parked = store.store({ id: 'parked', text: 'parked write', metadata: {} }).then(() => undefined, (e) => e);
    await new Promise((r) => setTimeout(r, 30));
    await store.close();
    handle!.release();
    const err = await parked;
    assert.ok(err instanceof VerbatimStoreClosedError, `expected VerbatimStoreClosedError, got ${err && (err as Error).name}`);
    assert.deepEqual((await snapshot(ws)).ids, []);
});

await test('a retired (not closed) rejection is unchanged: still VerbatimStoreRetiredError, not closed', async () => {
    const e = new VerbatimStoreRetiredError('/x');
    assert.ok(isVerbatimStoreRetiredError(e));
    assert.ok(!isVerbatimStoreClosedError(e));
});

await test('outbox: a closed-store failure is transient (not success, not a counted attempt, not dead)', async () => {
    const err = new VerbatimStoreClosedError('/x', 'store');
    assert.equal(isSqliteOrRetiredTransient(err), true);
    const calls: string[] = [];
    const store = {
        markEntryStatus: async (_id: string, status: string) => { calls.push(`status:${status}`); },
        recordTransientFailure: async () => { calls.push('transient'); return { firstTransientAt: new Date().toISOString(), transientRetries: 1 }; },
    } as unknown as OutboxStore;
    const env = makeDispositionEnv({ maxAttempts: 1, ...DEFAULT_TRANSIENT_CONFIG }, isSqliteOrRetiredTransient, undefined, isSqliteOrRetiredTransient);
    const out = await recordReplayFailure(store, { id: 'e1', attempts: 99 } as unknown as OutboxEntry, err, env);
    assert.equal(out.kind, 'transient');
    assert.deepEqual(calls, ['transient'], 'must not mark done/dead');
    assert.equal(env.batchHalted, true, 'a closed store is unavailable for the whole batch');
});

await test('normal shutdown: writes awaited before close() land; double close() is a no-op; reads after close are unchanged', async () => {
    const ws = tmpWs();
    const store = new SqliteVerbatimStore(ws, provider);
    await store.initialize();
    await Promise.all([store.store({ id: 'x1', text: 'one', metadata: {} }), store.storeBatch([{ id: 'x2', text: 'two', metadata: {} }])]);
    await store.close();
    await store.close();
    assert.deepEqual((await snapshot(ws)).ids, ['x1', 'x2']);
    assert.equal(await store.count(), 0, 'documented: reads on a closed store keep returning empty');
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nsqlite-verbatim-closed-store-unit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
