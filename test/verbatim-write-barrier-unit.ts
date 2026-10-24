#!/usr/bin/env tsx
/**
 * verbatim-write-barrier-unit.ts - 3.35.3 review finding F1a: the application-level write barrier that
 * lets promotion's final gate converge under steady in-process writes.
 *
 *   - writers QUEUE behind a raised barrier (none fails) and run, in order, when it is lowered;
 *   - raising waits (bounded) for writes already in flight; if they do not drain it backs off (null);
 *   - the hold is bounded: the barrier lowers itself after holdMs even if the promotion forgot to;
 *   - retire() (the promotion committed) rejects parked writers with VerbatimStoreRetiredError and runs
 *     none of them, so they cannot write onto the SQLite file that was just renamed away;
 *   - EVERY vector write method of SqliteVerbatimStore goes through it (all eight);
 *   - no state leaks once idle.
 *
 * Run: npx tsx test/verbatim-write-barrier-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    withWriteBarrier, raiseWriteBarrier, writeBarrierStateCount, VerbatimStoreRetiredError,
} from '../packages/lore/src/engines/verbatimWriteBarrier.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wbar-')); dirs.push(d); return d; };

/** Tracks whether a promise has settled without awaiting it. */
function track<T>(p: Promise<T>): { settled: () => boolean; result: Promise<PromiseSettledResult<T>> } {
    let done = false;
    const result = p.then((v) => { done = true; return { status: 'fulfilled', value: v } as const; },
        (e) => { done = true; return { status: 'rejected', reason: e } as const; });
    return { settled: () => done, result };
}

console.log('barrier semantics');

await test('no barrier: writes run immediately and leave no state behind', async () => {
    const base = tmp();
    assert.equal(await withWriteBarrier(base, async () => 7), 7);
    assert.equal(writeBarrierStateCount(), 0);
});

await test('raised barrier parks writers; they all run, in order, after release', async () => {
    const base = tmp();
    const h = await raiseWriteBarrier(base, { holdMs: 5000 });
    assert.ok(h);
    const order: number[] = [];
    const writers = [1, 2, 3].map((n) => track(withWriteBarrier(base, async () => { order.push(n); return n; })));
    await sleep(60);
    assert.deepEqual(order, [], 'nothing ran while the barrier was up');
    assert.ok(writers.every((w) => !w.settled()));
    h!.release();
    const res = await Promise.all(writers.map((w) => w.result));
    assert.ok(res.every((r) => r.status === 'fulfilled'), 'none failed');
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(writeBarrierStateCount(), 0);
});

await test('raise waits for an in-flight write to finish before returning the handle', async () => {
    const base = tmp();
    let finish!: () => void;
    let finished = false;
    const inflight = withWriteBarrier(base, () => new Promise<void>((r) => { finish = () => { finished = true; r(); }; }));
    const raised = raiseWriteBarrier(base, { holdMs: 5000, drainMs: 2000 });
    const t = track(raised);
    await sleep(50);
    assert.equal(t.settled(), false, 'still draining');
    finish();
    await inflight;
    const h = await raised;
    assert.ok(h && finished, 'handle returned only after the in-flight write finished');
    h!.release();
});

await test('in-flight write that never drains: raise returns null, barrier is down, writers are not left parked', async () => {
    const base = tmp();
    let finish!: () => void;
    const stuck = withWriteBarrier(base, () => new Promise<void>((r) => { finish = r; }));
    const t0 = Date.now();
    const h = await raiseWriteBarrier(base, { holdMs: 5000, drainMs: 80 });
    assert.equal(h, null);
    assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 1500);
    assert.equal(await withWriteBarrier(base, async () => 'ok'), 'ok', 'new writes are not parked after a failed raise');
    finish();
    await stuck;
    assert.equal(writeBarrierStateCount(), 0);
});

await test('hold is bounded: the barrier lowers itself after holdMs and parked writers resume', async () => {
    const base = tmp();
    const h = await raiseWriteBarrier(base, { holdMs: 120 });
    assert.ok(h);
    assert.equal(h!.isHeld(), true);
    const w = track(withWriteBarrier(base, async () => 'late'));
    await sleep(40);
    assert.equal(w.settled(), false);
    const r = await w.result;
    assert.equal(r.status, 'fulfilled', 'expiry resumes (does not reject) the writer');
    assert.equal(h!.isHeld(), false);
    assert.ok(h!.deadline <= Date.now() + 5);
});

await test('retire(): parked writers are rejected with VerbatimStoreRetiredError and none of them runs', async () => {
    const base = tmp();
    const h = await raiseWriteBarrier(base, { holdMs: 5000 });
    assert.ok(h);
    let ran = 0;
    const writers = [0, 1, 2].map(() => track(withWriteBarrier(base, async () => { ran++; })));
    await sleep(30);
    h!.retire();
    const res = await Promise.all(writers.map((w) => w.result));
    for (const r of res) {
        assert.equal(r.status, 'rejected');
        assert.ok((r as PromiseRejectedResult).reason instanceof VerbatimStoreRetiredError);
    }
    assert.equal(ran, 0, 'a retired-out write is never applied');
    h!.release(); // idempotent after retire
    assert.equal(writeBarrierStateCount(), 0);
});

await test('two workspaces do not block each other; a second raise on the same workspace is refused', async () => {
    const a = tmp(), b = tmp();
    const h = await raiseWriteBarrier(a, { holdMs: 5000 });
    assert.ok(h);
    assert.equal(await withWriteBarrier(b, async () => 'b ok'), 'b ok');
    await assert.rejects(() => raiseWriteBarrier(a), /already raised/);
    h!.release();
});

console.log('SqliteVerbatimStore routes every write through the barrier');

class Det implements EmbeddingProvider {
    readonly dimension = 16; readonly modelId = 'wbar-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] { const v = new Array(16).fill(0); for (let i = 0; i < text.length; i++) v[i % 16] += text.charCodeAt(i) / 128; const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); }
    async embed(t: string) { return this.vec(t); } async embedQuery(t: string) { return this.vec(t); } async embedDocument(t: string) { return this.vec(t); }
}

await test('store, storeBatch, bulkAdd/UpsertPrebuiltRows, physicalDelete(Many), purgeWithHistory and tombstone all park', async () => {
    const ws = tmp();
    const s = new SqliteVerbatimStore(ws, new Det());
    await s.initialize();
    await s.store({ id: 'seed', text: 'seed row', metadata: {} });
    const h = await raiseWriteBarrier(ws, { holdMs: 10_000 });
    assert.ok(h);
    const row = { id: 'pre1', text: 'prebuilt', vector: new Array(16).fill(0.25), contentHash: 'h', type: 'note', label: '', tags: '', project: '', ecosystem: '', updatedAt: new Date().toISOString(), security_scopes: '[]', is_canonical: true, is_tombstone: false, superseded_at: '', created_at: new Date().toISOString() };
    const calls: Record<string, () => Promise<unknown>> = {
        store: () => s.store({ id: 'a', text: 'a', metadata: {} }),
        storeBatch: () => s.storeBatch([{ id: 'b', text: 'b', metadata: {} }]),
        bulkAddPrebuiltRows: () => s.bulkAddPrebuiltRows([row]),
        bulkUpsertPrebuiltRows: () => s.bulkUpsertPrebuiltRows([{ ...row, id: 'pre2' }]),
        physicalDelete: () => s.physicalDelete('seed'),
        physicalDeleteMany: () => s.physicalDeleteMany(['seed']),
        purgeWithHistory: () => s.purgeWithHistory(['seed']),
        tombstone: () => s.tombstone('seed', 'test'),
    };
    const tracked = Object.entries(calls).map(([name, fn]) => ({ name, t: track(fn()) }));
    await sleep(150);
    const leaked = tracked.filter((x) => x.t.settled()).map((x) => x.name);
    assert.deepEqual(leaked, [], `these writes did not park behind the barrier: ${leaked.join(', ')}`);
    h!.retire(); // reject all of them: none may be applied
    const res = await Promise.all(tracked.map((x) => x.t.result));
    for (let i = 0; i < res.length; i++) {
        const r = res[i]!;
        assert.equal(r.status, 'rejected', tracked[i]!.name);
        assert.ok((r as PromiseRejectedResult).reason instanceof VerbatimStoreRetiredError, `${tracked[i]!.name}: ${(r as PromiseRejectedResult).reason}`);
    }
    const db = (s as unknown as { db: { prepare(q: string): { all(): Array<{ id: string }> } } }).db;
    assert.deepEqual(db.prepare('SELECT id FROM verbatim ORDER BY id').all().map((r) => r.id), ['seed'], 'nothing was applied');
    await s.close();
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
