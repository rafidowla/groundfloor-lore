#!/usr/bin/env tsx
/**
 * test/verbatim-cross-instance-writes-unit.ts — one canonical row per id even
 * when more than one VerbatimStore / lancedb connection targets the SAME
 * `lore_verbatim` table.
 *
 * b61e4dcd serialised writes per store INSTANCE. LanceDB `mergeInsert('id')`
 * from a handle opened BEFORE another handle's commit does not see that row and
 * inserts a duplicate (probe: second connection AND second handle on the same
 * connection). So the lane must be per resolved table path (module-level), and
 * every write must start by moving its handle to the latest version. Cases:
 *
 *   (1) two instances, same path, concurrent storeBatch of the same ids;
 *   (2) instance B opened first, instance A writes X, B then store()s X;
 *   (3) two connections written strictly in sequence (== two processes whose
 *       writes do not overlap in time), every write op, A closed in between;
 *   (4) lane key is the realpath (symlinked spelling shares the lane);
 *   (5) two instances + close(): queued writers on both, one closes mid-flight.
 *
 * Real LanceDB in temp dirs under os.tmpdir(); nothing touches ~/.groundfloor.
 * The lane-count assertion is skipped on trees that predate the path lane.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { VerbatimWriteGate } from '../packages/lore/src/engines/verbatimWriteGate.js';
import { classifyLanceId } from '../packages/lore/src/engines/migrateVectorsRows.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { VerbatimDocument } from '../packages/lore/src/engines/verbatimStore.js';

const DIM = 8;
const ROUNDS = Number(process.env.LORE_XINST_TEST_ROUNDS ?? 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function provider(): EmbeddingProvider {
    const vec = (t: string) => Array.from({ length: DIM }, (_, i) => ((t.charCodeAt(i % Math.max(1, t.length)) || 1) % 17) / 17);
    return {
        modelId: 'xinst-test-fake', dimension: DIM,
        async initialize() { /* no-op */ },
        async embed(t: string) { return vec(t); },
        async embedDocument(t: string) { await sleep(Math.random() * 6); return vec(t); },
        async embedQuery(t: string) { return vec(t); },
        async embedDocumentBatch(texts: string[]) { await sleep(Math.random() * 6); return texts.map(vec); },
    };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-xinst-'));
async function open(dir: string): Promise<VerbatimStore> { const s = new VerbatimStore(dir, provider()); await s.initialize(); return s; }

/** Canonical row counts per id, read through an independent fresh connection. */
async function canonicalCounts(dir: string): Promise<Map<string, number>> {
    const db = await lancedb.connect(path.join(dir, '.lore', 'lancedb'));
    try {
        const out = new Map<string, number>();
        if (!(await db.tableNames()).includes('lore_verbatim')) return out;
        const t = await db.openTable('lore_verbatim');
        for (const r of await t.query().select(['id']).toArray()) {
            const id = String((r as { id: unknown }).id);
            if (classifyLanceId(id) === 'history') continue;
            out.set(id, (out.get(id) ?? 0) + 1);
        }
        return out;
    } finally { db.close(); }
}
async function textOf(dir: string, id: string): Promise<string> {
    const db = await lancedb.connect(path.join(dir, '.lore', 'lancedb'));
    try {
        const rows = await (await db.openTable('lore_verbatim')).query().where(`id = '${id}'`).toArray();
        return String((rows[0] as { text?: unknown } | undefined)?.text ?? '');
    } finally { db.close(); }
}
async function expectOne(dir: string, ids: string[], what: string): Promise<void> {
    const c = await canonicalCounts(dir);
    const bad = ids.filter((id) => c.get(id) !== 1).map((id) => `${id}=${c.get(id) ?? 0}`);
    assert.deepEqual(bad, [], `${what}: expected exactly 1 canonical row per id, got ${bad.slice(0, 5).join(', ')}`);
    const dups = [...c.entries()].filter(([, n]) => n > 1);
    assert.deepEqual(dups, [], `${what}: duplicated canonicals ${JSON.stringify(dups.slice(0, 5))}`);
}

const doc = (id: string, tag = ''): VerbatimDocument => ({ id, text: `text of ${id} ${tag}`, metadata: { type: 'note', project: 'x', ecosystem: 't', updatedAt: '2026-10-05T00:00:00.000Z' } });
const docs = (prefix: string, n: number, tag = ''): VerbatimDocument[] => Array.from({ length: n }, (_, i) => doc(`${prefix}:${i}`, tag));
const clone = (d: VerbatimDocument[]): VerbatimDocument[] => d.map((x) => ({ ...x, metadata: { ...x.metadata } }));
const prebuilt = (id: string, tag: string): Record<string, unknown> => ({
    vector: Array.from({ length: DIM }, () => 0), id, text: `bulk ${id} ${tag}`, type: 'note', label: '', tags: '',
    project: 'x', ecosystem: 't', updatedAt: '2026-10-05T00:00:00.000Z', security_scopes: [], contentHash: `h-${id}-${tag}`,
});

console.log(`\nVerbatimStore — cross-instance / cross-handle writes (${ROUNDS} rounds per race)\n`);

await test('(1) two instances, same path: concurrent storeBatch of the same ids (cold)', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        const dir = mkdir(); const a = await open(dir); const b = await open(dir);
        try {
            const d = docs('c1', 40);
            await Promise.all([a.storeBatch(clone(d)), b.storeBatch(clone(d))]);
            await expectOne(dir, d.map((x) => x.id), `cold round ${r}`);
        } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
    }
});

await test('(1) two instances, same path: concurrent storeBatch of the same ids (warm table)', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        const dir = mkdir(); const a = await open(dir);
        await a.storeBatch([doc('seed')]);
        const b = await open(dir);
        try {
            const d = docs('w1', 40);
            await Promise.all([a.storeBatch(clone(d)), b.storeBatch(clone(d)), a.storeBatch(clone(d)), b.storeBatch(clone(d))]);
            await expectOne(dir, [...d.map((x) => x.id), 'seed'], `warm round ${r}`);
        } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
    }
});

await test('(1) two instances: mixed store()/storeBatch()/bulkUpsert on the same ids', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        const dir = mkdir(); const a = await open(dir); await a.storeBatch([doc('seed')]); const b = await open(dir);
        try {
            const d = docs('m1', 12);
            await Promise.all([
                a.storeBatch(clone(d)), b.storeBatch(clone(d)),
                ...d.slice(0, 4).map((x) => b.store({ ...x })),
                a.bulkUpsertPrebuiltRows(d.slice(4, 8).map((x) => prebuilt(x.id, 'u'))),
                b.bulkAddPrebuiltRows(d.slice(8).map((x) => prebuilt(x.id, 'a'))),
            ]);
            await expectOne(dir, d.map((x) => x.id), `mixed round ${r}`);
        } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
    }
});

await test('(2) instance B opened first, A writes X, then B store()s X -> 1 row (warm)', async () => {
    const dir = mkdir(); const a = await open(dir);
    await a.storeBatch([doc('seed')]);
    const b = await open(dir); // B's handle is now at the version before X
    try {
        await a.store(doc('X', 'by-a'));
        await b.store(doc('X', 'by-b'));
        await expectOne(dir, ['seed', 'X'], 'warm B-after-A');
        assert.match(await textOf(dir, 'X'), /by-b/, 'last write wins');
    } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('(2) instance B opened first on a COLD dir, A creates the table + X, then B store()s X -> 1 row', async () => {
    const dir = mkdir(); const b = await open(dir); const a = await open(dir); // neither has a table
    try {
        await a.store(doc('X', 'by-a'));
        await b.store(doc('X', 'by-b'));
        await expectOne(dir, ['X'], 'cold B-after-A');
    } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('(2) stale B: storeBatch / bulkUpsert / bulkAdd of ids A already wrote -> 1 row each', async () => {
    const dir = mkdir(); const a = await open(dir); await a.storeBatch([doc('seed')]); const b = await open(dir);
    try {
        await a.storeBatch([doc('S1'), doc('S2'), doc('S3')]);
        await b.storeBatch([doc('S1', 'b')]);
        await b.bulkUpsertPrebuiltRows([prebuilt('S2', 'b')]);
        await b.bulkAddPrebuiltRows([prebuilt('S3', 'b')]);
        await expectOne(dir, ['seed', 'S1', 'S2', 'S3'], 'stale B batch/bulk');
    } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('(2) stale B: tombstone / physicalDelete / purgeWithHistory act on rows A created after B opened', async () => {
    const dir = mkdir(); const b = await open(dir); const a = await open(dir); // B opened on a cold dir: has NO table handle
    try {
        await a.storeBatch([doc('T1'), doc('D1'), doc('P1'), doc('P2')]);
        await a.store(doc('P1', 'v2')); // gives P1 a #rev history row
        await b.tombstone('T1', 'test');
        await b.physicalDelete('D1');
        const n = await b.purgeWithHistory(['P1']);
        assert.ok(n >= 2, `purge removed canonical + history, got ${n}`);
        await b.physicalDeleteMany(['P2']);
        const c = await canonicalCounts(dir);
        assert.equal(c.get('T1'), 1, 'T1 remains (tombstoned) exactly once');
        assert.match(await textOf(dir, 'T1'), /^\[TOMBSTONED/); // fresh connection: a's own read handle is not refreshed by design
        assert.equal(c.has('D1'), false, 'D1 deleted by the stale instance');
        assert.equal(c.has('P1'), false, 'P1 purged by the stale instance');
        assert.equal(c.has('P2'), false, 'P2 deleted by the stale instance');
    } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('(3) two connections written strictly in sequence (== non-overlapping processes) -> 1 row', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        const dir = mkdir();
        try {
            const a = await open(dir); await a.storeBatch(docs('seq', 20, 'a0'));
            const b = await open(dir);              // second connection: handle at A's version
            await a.storeBatch(docs('seq', 20, 'a1')); // A commits again; B is now stale
            await b.storeBatch(docs('seq', 20, 'b1')); // B must refresh, not duplicate
            await b.store(doc('seq:3', 'b2'));
            await a.close();                         // "process A exits"
            await b.storeBatch(docs('seq', 25, 'b3'));
            const c = await open(dir);               // "process C" starts later
            await c.bulkUpsertPrebuiltRows([prebuilt('seq:1', 'c')]);
            await c.bulkAddPrebuiltRows([prebuilt('seq:2', 'c'), prebuilt('seq:99', 'c')]);
            await b.store(doc('seq:99', 'b4'));      // B stale w.r.t. C's add
            await b.close(); await c.close();
            await expectOne(dir, [...docs('seq', 25).map((x) => x.id), 'seq:99'], `sequential round ${r}`);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
});

await test('(3) raw lancedb premise: stale handle + mergeInsert duplicates, checkoutLatest() first does not', async () => {
    // Pins WHY refreshWriteTable exists. The control (no refresh) is informational: if a future
    // @lancedb/lancedb stops duplicating, only the refreshed assertion is load-bearing.
    const dir = mkdir();
    try {
        const a = await lancedb.connect(dir); const b = await lancedb.connect(dir);
        const rowsOf = async (name: string) => (await (await (await lancedb.connect(dir)).openTable(name)).query().where("id = 'X'").toArray()).length;
        const up = (t: lancedb.Table) => t.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([{ id: 'X', v: 2 }]);
        const results: Record<string, number> = {};
        for (const [name, refresh] of [['control', false], ['refreshed', true]] as const) {
            const ta = await a.createTable(name, [{ id: 'seed', v: 0 }]);
            const tb = await b.openTable(name); // opened BEFORE A's commit of X
            await ta.add([{ id: 'X', v: 1 }]);
            if (refresh) await tb.checkoutLatest();
            await up(tb);
            results[name] = await rowsOf(name);
        }
        console.log(`    (rows for X: control=${results.control}, refreshed=${results.refreshed})`);
        assert.equal(results.refreshed, 1, 'checkoutLatest() before mergeInsert keeps one row');
        a.close(); b.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('(4) lane key is the realpath: a symlinked spelling of the same dir shares the lane', async () => {
    const dir = mkdir(); const link = dir + '-link';
    fs.symlinkSync(dir, link);
    try {
        const lanePath = path.join(dir, '.lore', 'lancedb'); fs.mkdirSync(lanePath, { recursive: true });
        const g1 = new VerbatimWriteGate(lanePath);
        const g2 = new VerbatimWriteGate(path.join(link, '.lore', 'lancedb'));
        const g3 = new VerbatimWriteGate(); // private lane: must NOT be ordered against the others
        const order: string[] = [];
        const p1 = g1.exclusive(async () => { order.push('1-start'); await sleep(40); order.push('1-end'); });
        const p2 = g2.exclusive(async () => { order.push('2-start'); await sleep(5); order.push('2-end'); });
        const p3 = g3.exclusive(async () => { order.push('3-start'); await sleep(5); order.push('3-end'); });
        await Promise.all([p1, p2, p3]);
        assert.ok(order.indexOf('1-end') < order.indexOf('2-start'), `symlink spelling waited for the first writer: ${order.join(',')}`);
        assert.ok(order.indexOf('3-start') < order.indexOf('1-end'), `private lane is independent: ${order.join(',')}`);
        // a rejection must not poison the next waiter, and the lane map empties
        await g1.exclusive(async () => { throw new Error('boom'); }).catch(() => undefined);
        assert.equal(await g2.exclusive(async () => 'ok'), 'ok');
        const count = (VerbatimWriteGate as unknown as { activeLaneCount?: () => number }).activeLaneCount;
        if (count) assert.equal(count(), 0, 'lane entries are deleted once their last waiter settles');
    } finally { fs.rmSync(link, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('(5) two instances + close(): A closes with queued writers on both; B keeps writing, no deadlock', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        const dir = mkdir(); const a = await open(dir); await a.storeBatch([doc('seed')]); const b = await open(dir);
        try {
            const d = docs('cl', 16);
            const writes = [
                ...Array.from({ length: 4 }, (_, i) => a.storeBatch(clone(d).map((x) => ({ ...x, text: x.text + `a${i}` }))).catch(() => undefined)),
                ...Array.from({ length: 4 }, (_, i) => b.storeBatch(clone(d).map((x) => ({ ...x, text: x.text + `b${i}` })))),
            ];
            const closeA = a.close();
            const outcome = await Promise.race([Promise.all([...writes, closeA]).then(() => 'ok'), sleep(60_000).then(() => 'timeout')]);
            assert.equal(outcome, 'ok', 'writers and A.close() settled');
            await b.storeBatch(docs('after', 3)); // B still fully working after A's natives closed
            const closeB = await Promise.race([b.close().then(() => 'ok'), sleep(30_000).then(() => 'timeout')]);
            assert.equal(closeB, 'ok', 'B.close() settled');
            await expectOne(dir, [...d.map((x) => x.id), 'seed', 'after:0', 'after:1', 'after:2'], `close round ${r}`);
            const count = (VerbatimWriteGate as unknown as { activeLaneCount?: () => number }).activeLaneCount;
            if (count) assert.equal(count(), 0, 'no lane left behind after both closed');
        } finally { await a.close().catch(() => undefined); await b.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
