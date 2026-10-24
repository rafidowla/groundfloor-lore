#!/usr/bin/env tsx
/**
 * test/pg-verbatim-count-cache-unit.ts - PostgresVerbatimStore.count() is served from a short-TTL, write-invalidated cache.
 *
 *   pure         cachedVerbatimCount: one load per TTL window, TTL expiry, TTL 0 disables, single-flight, workspaces and
 *                pools are separate keys, a write during an in-flight load is not cached (and later callers do not join it),
 *                a failed load is not cached.
 *   store (pg)   the real store: repeated count() issues ONE count(*); every write path (store, storeBatch, delete,
 *                tombstone, physicalDelete, physicalDeleteMany, purgeWithHistory) is visible to the very next count();
 *                a write through a sibling handle invalidates the other handle; another workspace's cache is untouched;
 *                countCacheTtlMs: 0 queries every time.
 *
 * The pure cases run without a database; the store cases need LORE_PG_URL and skip with a printed reason otherwise.
 * Run: npx tsx test/pg-verbatim-count-cache-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Pool } from 'pg';

import { cachedVerbatimCount, invalidateVerbatimCount } from '../packages/lore/src/engines/postgres/postgresVerbatimCount.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const fakePool = (): Pool => ({}) as unknown as Pool;
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } => {
    let resolve!: (v: T) => void, reject!: (e: Error) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};

console.log('\npure cache');
await test('repeated calls inside the TTL run the loader once; after the TTL it runs again', async () => {
    const pool = fakePool(); let t = 1000; let calls = 0;
    const load = async (): Promise<number> => ++calls * 10;
    assert.equal(await cachedVerbatimCount(pool, 'w', load, 5000, () => t), 10);
    t += 4999;
    assert.equal(await cachedVerbatimCount(pool, 'w', load, 5000, () => t), 10);
    t += 2;
    assert.equal(await cachedVerbatimCount(pool, 'w', load, 5000, () => t), 20);
    assert.equal(calls, 2);
});
await test('a cached value of 0 is cached too (empty store is the common recall-time question)', async () => {
    const pool = fakePool(); let calls = 0;
    const load = async (): Promise<number> => { calls++; return 0; };
    await cachedVerbatimCount(pool, 'w', load); await cachedVerbatimCount(pool, 'w', load);
    assert.equal(calls, 1);
});
await test('invalidate drops the value', async () => {
    const pool = fakePool(); let calls = 0;
    const load = async (): Promise<number> => ++calls;
    assert.equal(await cachedVerbatimCount(pool, 'w', load), 1);
    invalidateVerbatimCount(pool, 'w');
    assert.equal(await cachedVerbatimCount(pool, 'w', load), 2);
});
await test('TTL 0 disables the cache', async () => {
    const pool = fakePool(); let calls = 0;
    const load = async (): Promise<number> => ++calls;
    await cachedVerbatimCount(pool, 'w', load, 0); await cachedVerbatimCount(pool, 'w', load, 0);
    assert.equal(calls, 2);
});
await test('workspaces and pools are separate keys; invalidating one leaves the others', async () => {
    const p1 = fakePool(), p2 = fakePool(); const n: Record<string, number> = {};
    const mk = (k: string) => async (): Promise<number> => (n[k] = (n[k] ?? 0) + 1);
    await cachedVerbatimCount(p1, 'a', mk('p1a')); await cachedVerbatimCount(p1, 'b', mk('p1b')); await cachedVerbatimCount(p2, 'a', mk('p2a'));
    invalidateVerbatimCount(p1, 'a');
    await cachedVerbatimCount(p1, 'a', mk('p1a')); await cachedVerbatimCount(p1, 'b', mk('p1b')); await cachedVerbatimCount(p2, 'a', mk('p2a'));
    assert.deepEqual(n, { p1a: 2, p1b: 1, p2a: 1 });
});
await test('single-flight: concurrent callers share one load', async () => {
    const pool = fakePool(); let calls = 0; const d = deferred<number>();
    const load = (): Promise<number> => { calls++; return d.promise; };
    const all = [cachedVerbatimCount(pool, 'w', load), cachedVerbatimCount(pool, 'w', load), cachedVerbatimCount(pool, 'w', load)];
    d.resolve(7);
    assert.deepEqual(await Promise.all(all), [7, 7, 7]);
    assert.equal(calls, 1);
});
await test('a write during an in-flight load: that result is returned to its caller but NOT cached, and a later caller starts a fresh load', async () => {
    const pool = fakePool(); const loads: Array<ReturnType<typeof deferred<number>>> = [];
    const load = (): Promise<number> => { const d = deferred<number>(); loads.push(d); return d.promise; };
    const first = cachedVerbatimCount(pool, 'w', load);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(loads.length, 1);
    invalidateVerbatimCount(pool, 'w'); // the write lands while the old query is running
    const second = cachedVerbatimCount(pool, 'w', load);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(loads.length, 2, 'a caller arriving after the write must not join the pre-write query');
    loads[0]!.resolve(5); // stale
    loads[1]!.resolve(6); // fresh
    assert.equal(await first, 5);
    assert.equal(await second, 6);
    let calls = 0;
    assert.equal(await cachedVerbatimCount(pool, 'w', async () => { calls++; return 99; }), 6, 'the post-write value is the cached one');
    assert.equal(calls, 0);
});
await test('a failed load is not cached and the next call retries', async () => {
    const pool = fakePool(); let calls = 0;
    const load = async (): Promise<number> => { if (++calls === 1) throw new Error('boom'); return 3; };
    await assert.rejects(cachedVerbatimCount(pool, 'w', load), /boom/);
    assert.equal(await cachedVerbatimCount(pool, 'w', load), 3);
    assert.equal(calls, 2);
});

console.log('\nreal store');
class GateEmbedder implements EmbeddingProvider {
    readonly dimension = 4;
    readonly modelId = 'pg-gate-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedDocument(_t?: string): Promise<number[]> { return [0.5, 0.5, 0.5, 0.5]; }
}
const gate = await createGatePool('pg-verbatim-count-cache');
if (gate) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pg-'));
    stampGateManifest(tmp, 'pg-gate-fixed', 4);
    // A counting proxy over the pool: the cache is keyed by this object, so every handle built on it shares entries.
    let countQueries = 0;
    const counting = new Proxy(gate, {
        get(target, prop, recv) {
            if (prop === 'query') {
                return (...args: unknown[]) => {
                    const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
                    if (/SELECT count\(\*\) AS c FROM verbatim/.test(sql)) countQueries++;
                    return (target.query as (...a: unknown[]) => unknown)(...args);
                };
            }
            const v = Reflect.get(target, prop, recv);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as Pool;
    const open = async (ws: string, ttl?: number): Promise<PostgresVerbatimStore> => {
        const s = new PostgresVerbatimStore(tmp, counting, ws, new GateEmbedder(), ttl === undefined ? undefined : { countCacheTtlMs: ttl });
        await s.initialize();
        return s;
    };
    const doc = (id: string, text = `text ${id}`) => ({ id, text, metadata: { type: 'note' } });
    const queriesFor = async (fn: () => Promise<unknown>): Promise<number> => { const b = countQueries; await fn(); return countQueries - b; };

    await cleanupGateWorkspaces(gate);
    try {
        await test('repeated count() issues one count(*) and returns the right number', async () => {
            const s = await open('pg-gate-cc-a');
            await s.storeBatch([doc('a1'), doc('a2'), doc('a3')]);
            const q = await queriesFor(async () => {
                for (let i = 0; i < 5; i++) assert.equal(await s.count(), 3);
            });
            assert.equal(q, 1);
        });

        const writes: Array<[string, (s: PostgresVerbatimStore) => Promise<unknown>]> = [
            ['store()', (s) => s.store(doc('w1'))],
            ['storeBatch()', (s) => s.storeBatch([doc('w2'), doc('w3')])],
            ['tombstone()', (s) => s.tombstone('w1', 'r')],
            ['delete()', (s) => s.delete('w2')],
            ['physicalDelete()', (s) => s.physicalDelete('w3')],
            ['physicalDeleteMany()', async (s) => { await s.storeBatch([doc('m1'), doc('m2')]); await s.physicalDeleteMany(['m1', 'm2']); }],
            ['purgeWithHistory()', async (s) => { await s.store(doc('p1')); await s.purgeWithHistory(['p1']); }],
        ];
        for (const [name, write] of writes) {
            await test(`${name}: the very next count() equals a fresh count(*) (cache invalidated by the write)`, async () => {
                const s = await open('pg-gate-cc-b');
                await s.count(); // warm the cache
                await write(s);
                const truth = Number((await gate.query(`SELECT count(*) AS c FROM verbatim WHERE workspace_id = $1`, ['pg-gate-cc-b'])).rows[0].c);
                assert.equal(await s.count(), truth);
            });
        }
        await test('a write through one handle invalidates the other handle on the same pool and workspace', async () => {
            const h1 = await open('pg-gate-cc-c'), h2 = await open('pg-gate-cc-c');
            assert.equal(await h1.count(), 0);
            assert.equal(await h2.count(), 0);
            await h1.store(doc('c1'));
            assert.equal(await h2.count(), 1);
        });
        await test('another workspace is not invalidated and is not served from this one', async () => {
            const a = await open('pg-gate-cc-d1'), b = await open('pg-gate-cc-d2');
            await b.storeBatch([doc('x1'), doc('x2')]);
            assert.equal(await a.count(), 0);
            assert.equal(await b.count(), 2);
            const q = await queriesFor(async () => { await a.store(doc('d1')); await b.count(); });
            assert.equal(q, 0, 'a write in workspace 1 must not evict workspace 2');
            assert.equal(await a.count(), 1);
            assert.equal(await b.count(), 2);
        });
        await test('countCacheTtlMs: 0 queries every time', async () => {
            const s = await open('pg-gate-cc-e', 0);
            const q = await queriesFor(async () => { await s.count(); await s.count(); await s.count(); });
            assert.equal(q, 3);
        });
    } finally {
        await cleanupGateWorkspaces(gate);
        await closeGatePool(gate);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
