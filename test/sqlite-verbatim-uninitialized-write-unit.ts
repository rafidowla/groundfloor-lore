#!/usr/bin/env tsx
/**
 * sqlite-verbatim-uninitialized-write-unit.ts - a write on a NEVER-initialized SqliteVerbatimStore must not vanish.
 *
 * Before the fix every mutator opened with `if (!this.initialized) return;`, so a write that reached a store
 * before initialize() (the daemon replays the outbox into the boot store before it initializes it) RESOLVED as
 * success and stored nothing. Now each mutator lazily initializes (single-flight) and the write lands; a store
 * whose init fails rejects loudly and does not leak the opened handle.
 *
 * Run: npx tsx test/sqlite-verbatim-uninitialized-write-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStoreClosedError, VerbatimStoreNotInitializedError, isVerbatimStoreNotInitializedError } from '../packages/lore/src/engines/verbatimStoreClosedError.js';
import { isSqliteOrRetiredTransient } from '../packages/lore/src/outbox/failureDisposition.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env.LORE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'uninit-store-home-'));
process.env.LORE_MODEL_SERVER = '0';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class DetEmbedder implements EmbeddingProvider {
    readonly dimension: number = DIM; readonly dtype = 'fp32';
    constructor(readonly modelId = 'uninit-store-det') { /* no-op */ }
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
const tmpWs = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uninit-store-ws-')); dirs.push(d); return d; };
const row = (id: string, text: string): Record<string, unknown> => ({
    id, text, vector: provider.vec(text), type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e',
    updatedAt: '2026-10-24T00:00:00.000Z', security_scopes: [], contentHash: `h-${id}`,
});

/** A workspace holding seed rows a, b, c, plus a NEVER-initialized store pointing at it. */
async function seededWorkspace(): Promise<{ ws: string; fresh: SqliteVerbatimStore }> {
    const ws = tmpWs();
    const seed = new SqliteVerbatimStore(ws, provider);
    await seed.initialize();
    for (const id of ['a', 'b', 'c']) await seed.store({ id, text: `seed ${id}`, metadata: {} });
    await seed.close();
    return { ws, fresh: new SqliteVerbatimStore(ws, provider) };
}
async function liveIds(ws: string): Promise<string[]> {
    const s = new SqliteVerbatimStore(ws, provider);
    await s.initialize();
    try {
        const out: string[] = [];
        for (const id of (await s.listIds()).sort()) { const r = await s.getById(id); if (r && !(r.text ?? "").startsWith('[TOMBSTONED')) out.push(id); }
        return out;
    } finally { await s.close(); }
}

const mutators: Array<{ name: string; call: (s: SqliteVerbatimStore) => Promise<unknown>; expect: string[] }> = [
    { name: 'store', call: (s) => s.store({ id: 'new1', text: 'lands', metadata: {} }), expect: ['a', 'b', 'c', 'new1'] },
    { name: 'storeBatch', call: (s) => s.storeBatch([{ id: 'new2', text: 'lands', metadata: {} }]), expect: ['a', 'b', 'c', 'new2'] },
    { name: 'bulkAddPrebuiltRows', call: (s) => s.bulkAddPrebuiltRows([row('new3', 'lands')]), expect: ['a', 'b', 'c', 'new3'] },
    { name: 'bulkUpsertPrebuiltRows', call: (s) => s.bulkUpsertPrebuiltRows([row('new4', 'lands')]), expect: ['a', 'b', 'c', 'new4'] },
    { name: 'delete', call: (s) => s.delete('a'), expect: ['b', 'c'] },
    { name: 'tombstone', call: (s) => s.tombstone('a', 'uninit test'), expect: ['b', 'c'] },
    { name: 'physicalDelete', call: (s) => s.physicalDelete('a'), expect: ['b', 'c'] },
    { name: 'physicalDeleteMany', call: (s) => s.physicalDeleteMany(['a', 'b']), expect: ['c'] },
    { name: 'purgeWithHistory', call: (s) => s.purgeWithHistory(['a', 'b']), expect: ['c'] },
];

for (const m of mutators) {
    await test(`${m.name}() on a never-initialized store is applied, not silently dropped`, async () => {
        const { ws, fresh } = await seededWorkspace();
        assert.equal(fresh.handleCount(), 0, 'fixture must be un-initialized');
        try {
            await m.call(fresh);
            assert.deepEqual(await liveIds(ws), m.expect, `${m.name}() resolved but the write is not in the file`);
        } finally { await fresh.close(); }
    });
}

await test('concurrent writes racing the boot initialize() share one open and all land', async () => {
    const { ws, fresh } = await seededWorkspace();
    try {
        await Promise.all([
            fresh.initialize(),
            fresh.store({ id: 'r1', text: 'one', metadata: {} }),
            fresh.storeBatch([{ id: 'r2', text: 'two', metadata: {} }]),
            fresh.bulkUpsertPrebuiltRows([row('r3', 'three')]),
            fresh.initialize(),
        ]);
        assert.equal(fresh.handleCount(), 1);
    } finally { await fresh.close(); }
    assert.deepEqual(await liveIds(ws), ['a', 'b', 'c', 'r1', 'r2', 'r3']);
});

await test('a close() racing a lazy write never reopens the store: the write lands or rejects Closed, never vanishes', async () => {
    const { ws, fresh } = await seededWorkspace();
    const w = fresh.store({ id: 'race', text: 'x', metadata: {} }).then(() => 'applied', (e) => e);
    await fresh.close();
    const outcome = await w;
    const ids = await liveIds(ws);
    if (outcome === 'applied') assert.ok(ids.includes('race'), 'write resolved but is missing');
    else { assert.ok(outcome instanceof VerbatimStoreClosedError, `unexpected ${(outcome as Error).name}`); assert.ok(!ids.includes('race')); }
    assert.equal(fresh.handleCount(), 0, 'the store must stay closed');
});

await test('a failed init rejects the write loudly and leaks no handle', async () => {
    const { ws } = await seededWorkspace();
    const other = new SqliteVerbatimStore(ws, new DetEmbedder('a-different-model'), { strictFingerprintCheck: true });
    await assert.rejects(() => other.store({ id: 'x', text: 'x', metadata: {} }), /fingerprint|model|mismatch/i);
    assert.equal(other.handleCount(), 0, 'the half-opened db handle must be closed on a failed init');
    assert.deepEqual(await liveIds(ws), ['a', 'b', 'c']);
});

await test('VerbatimStoreNotInitializedError is typed, unapplied, and an outbox-transient class', async () => {
    const e = new VerbatimStoreNotInitializedError('/x', 'store');
    assert.equal(e.applied, false);
    assert.ok(isVerbatimStoreNotInitializedError(e));
    assert.ok(isSqliteOrRetiredTransient(e), 'the outbox must replay this later, not count an attempt or mark success');
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
