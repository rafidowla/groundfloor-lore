#!/usr/bin/env tsx
/**
 * test/pg-pool-guard-unit.ts - the Postgres pool guard keeps a floor of connections free for foreground queries.
 *
 * Runs against a throwaway database `lore_gate_poolguard` on the LORE_PG_URL server (the pure cases run even without
 * it; the rest skip with a printed reason when LORE_PG_URL is unset).
 *
 *   config      slot arithmetic, default reserve (4 on the default pool of 16), env + option overrides, bad env fails loudly
 *   starvation  (a) with background jobs holding every slot, foreground queries still finish promptly;
 *               negative control: the same load taken straight from the pool DOES starve the foreground
 *   exclusive   jobs sharing an exclusive key (the concurrent index builds) run one at a time; others are not held back
 *   cap         (b) slots cap concurrency (by `concurrency` and by poolMax - reserve); excess jobs queue without a connection
 *   cancel      (c) cancelOwner / AbortSignal / closePostgresPool cancel an in-flight statement, the job promise settles,
 *               the slot is freed, the backend is gone; a queued job is dropped without ever connecting
 *   small pool  (d) poolMax <= reserve: the job is skipped with ONE warning, fn never runs, foreground unaffected
 *   timeout     per-job statement_timeout applies and is restored on the reused connection
 *   verbatim    the verbatim store's compact() (VACUUM) and index builds run through the guard; skipped on a pool too small to spare a connection
 *   keyword     (e) the keyword-index background build runs through the guard, and releasing its last owner cancels it
 *
 * Run: npx tsx test/pg-pool-guard-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import {
    backgroundSlots, defaultBackgroundReserve, INDEX_BUILD_EXCLUSIVE, poolGuardFor,
} from '../packages/lore/src/engines/postgres/postgresPoolGuard.js';
import { KEYWORD_INDEXES, releaseKeywordIndexBuild, startKeywordIndexBuild, validKeywordIndexes } from '../packages/lore/src/engines/postgres/postgresKeywordIndex.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { gateDbUrl, stampGateManifest } from './helpers/testPostgres.js';

const DB = 'lore_gate_poolguard';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(25); }
    throw new Error(`timed out waiting for ${what}`);
}
async function timed<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
    const t = Date.now();
    const value = await p;
    return { value, ms: Date.now() - t };
}

console.log('\nconfig');
await test('slots = max(0, poolMax - reserve) capped by concurrency', () => {
    assert.equal(backgroundSlots(16, 4, 2), 2);
    assert.equal(backgroundSlots(16, 4, 20), 12);
    assert.equal(backgroundSlots(4, 3, 8), 1);
    assert.equal(backgroundSlots(4, 4, 2), 0);
    assert.equal(backgroundSlots(1, 1, 2), 0);
    assert.equal(backgroundSlots(2, 9, 2), 0);
});
await test('default reserve: 4 on the default pool of 16, scaled down on small pools, never 0', () => {
    assert.equal(defaultBackgroundReserve(16), 4);
    assert.equal(defaultBackgroundReserve(8), 4);
    assert.equal(defaultBackgroundReserve(4), 2);
    assert.equal(defaultBackgroundReserve(2), 1);
    assert.equal(defaultBackgroundReserve(1), 1);
});

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-pool-guard (database cases): LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const url = dbUrl.toString();
/** Side connection (not part of any pool under test) for observing pg_stat_activity. */
const obs = new Client({ connectionString: url });
await obs.connect();
const activeSleeps = async (marker: string): Promise<number> =>
    Number((await obs.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()`, [`%${marker}%`])).rows[0].n);

const pools: Pool[] = [];
const mk = (o: Parameters<typeof createPostgresPool>[0] = {}): Pool => {
    const p = createPostgresPool({ url, ...o });
    pools.push(p);
    return p;
};

try {
    await test('options set reserve / concurrency; env is the fallback; a bad env value fails loudly', async () => {
        const a = mk({ max: 10, backgroundReserve: 3, backgroundConcurrency: 1 });
        assert.deepEqual([poolGuardFor(a).stats().reserve, poolGuardFor(a).stats().concurrency, poolGuardFor(a).slots], [3, 1, 1]);
        const d = mk();
        assert.deepEqual([poolGuardFor(d).stats().poolMax, poolGuardFor(d).stats().reserve, poolGuardFor(d).slots], [16, 4, 2]);
        process.env['LORE_PG_BACKGROUND_RESERVE'] = '6';
        process.env['LORE_PG_BACKGROUND_CONCURRENCY'] = '3';
        try {
            const e = mk({ max: 10 });
            assert.deepEqual([poolGuardFor(e).stats().reserve, poolGuardFor(e).slots], [6, 3]);
            const o = mk({ max: 10, backgroundReserve: 1 });
            assert.equal(poolGuardFor(o).stats().reserve, 1, 'an explicit option beats the env');
            process.env['LORE_PG_BACKGROUND_RESERVE'] = 'abc';
            assert.throws(() => mk(), /LORE_PG_BACKGROUND_RESERVE must be a non-negative integer/);
        } finally {
            delete process.env['LORE_PG_BACKGROUND_RESERVE'];
            delete process.env['LORE_PG_BACKGROUND_CONCURRENCY'];
        }
    });

    console.log('\nstarvation (a)');
    await test('background jobs holding every slot never starve foreground queries', async () => {
        const pool = mk({ max: 4, backgroundReserve: 2, backgroundConcurrency: 2 });
        const g = poolGuardFor(pool);
        const bg = [0, 1, 2].map((i) => g.run('sleepy', (c) => c.query(`SELECT pg_sleep(2.5) /* guard-a-${i} */`), {}));
        await waitFor('two background statements running', async () => (await activeSleeps('guard-a-')) === 2);
        assert.equal(g.stats().waiting, 1, 'the third job waits for a slot without holding a connection');
        assert.equal(pool.totalCount, 2, 'only the two slot holders hold connections');
        const fg = await timed(Promise.all([pool.query('SELECT 1'), pool.query('SELECT 2'), pool.query('SELECT 3')]));
        assert.ok(fg.ms < 1000, `foreground took ${fg.ms} ms while background held its slots`);
        await Promise.all(bg);
    });
    await test('negative control: the same load taken straight from the pool DOES starve the foreground', async () => {
        const pool = mk({ max: 4 });
        const hogs = [0, 1, 2, 3].map(async (i) => { const c = await pool.connect(); try { await c.query(`SELECT pg_sleep(1.5) /* hog-${i} */`); } finally { c.release(); } });
        await waitFor('four hogs running', async () => (await activeSleeps('hog-')) === 4);
        const fg = await timed(pool.query('SELECT 1'));
        assert.ok(fg.ms >= 1000, `unguarded foreground only waited ${fg.ms} ms; the starvation scenario is not being reproduced`);
        await Promise.all(hogs);
    });

    console.log('\ncap (b)');
    await test('concurrency caps simultaneous jobs; the rest queue and all complete in order', async () => {
        const pool = mk({ max: 8, backgroundReserve: 2, backgroundConcurrency: 2 });
        const g = poolGuardFor(pool);
        let now = 0, peak = 0;
        const order: number[] = [];
        const jobs = Array.from({ length: 5 }, (_, i) => g.run('capped', async (c) => {
            now++; peak = Math.max(peak, now);
            await c.query(`SELECT pg_sleep(0.15) /* guard-b */`);
            now--; order.push(i);
        }));
        const res = await Promise.all(jobs);
        assert.equal(peak, 2);
        assert.ok(res.every((r) => r.ran));
        assert.deepEqual(order.slice().sort(), [0, 1, 2, 3, 4]);
        assert.equal(g.stats().active, 0);
        assert.equal(g.stats().completed, 5);
    });
    await test('poolMax - reserve caps below the concurrency limit', async () => {
        const pool = mk({ max: 4, backgroundReserve: 3, backgroundConcurrency: 8 });
        const g = poolGuardFor(pool);
        assert.equal(g.slots, 1);
        let now = 0, peak = 0;
        await Promise.all([0, 1, 2].map(() => g.run('capped1', async (c) => { now++; peak = Math.max(peak, now); await c.query('SELECT pg_sleep(0.1)'); now--; })));
        assert.equal(peak, 1);
    });

    console.log('\nexclusive (3.38.1)');
    await test('jobs sharing an exclusive key never overlap; other keys and keyless jobs still run alongside', async () => {
        const pool = mk({ max: 10, backgroundReserve: 2, backgroundConcurrency: 4 });
        const g = poolGuardFor(pool);
        const running = new Map<string, number>();
        const peakFor = new Map<string, number>();
        let now = 0, peak = 0;
        const job = (label: string, key: string | undefined) => g.run(label, async (c) => {
            now++; peak = Math.max(peak, now);
            const k = key ?? `none-${label}`;
            running.set(k, (running.get(k) ?? 0) + 1);
            peakFor.set(k, Math.max(peakFor.get(k) ?? 0, running.get(k)!));
            await c.query(`SELECT pg_sleep(0.3) /* guard-x-${label} */`);
            running.set(k, running.get(k)! - 1);
            now--;
        }, key === undefined ? {} : { exclusive: key });
        const jobs = [job('a1', INDEX_BUILD_EXCLUSIVE), job('a2', INDEX_BUILD_EXCLUSIVE), job('a3', INDEX_BUILD_EXCLUSIVE), job('b', 'other'), job('n', undefined)];
        await waitFor('three jobs running', async () => (await activeSleeps('guard-x-')) === 3);
        assert.equal(g.stats().waiting, 2, 'the two same-key jobs wait');
        assert.equal(pool.totalCount, 3, 'waiting jobs hold no connection');
        await Promise.all(jobs);
        assert.equal(peakFor.get(INDEX_BUILD_EXCLUSIVE), 1, 'same-key jobs ran one at a time');
        assert.equal(peak, 3, 'the other-key and keyless jobs overlapped the exclusive one');
        assert.equal(g.stats().active, 0);
        assert.equal(g.stats().completed, 5);
    });
    await test('a same-key waiter does not block a later job with no key while a slot is free', async () => {
        const pool = mk({ max: 8, backgroundReserve: 2, backgroundConcurrency: 2 });
        const g = poolGuardFor(pool);
        const first = g.run('k1', (c) => c.query(`SELECT pg_sleep(0.6) /* guard-y-1 */`), { exclusive: 'k' });
        await waitFor('first running', async () => (await activeSleeps('guard-y-1')) === 1);
        const second = g.run('k2', (c) => c.query('SELECT 1'), { exclusive: 'k' });
        const t = await timed(g.run('free', (c) => c.query('SELECT 1')));
        assert.ok(t.ms < 400, `keyless job waited ${t.ms} ms behind a same-key waiter`);
        await Promise.all([first, second]);
    });
    await test('an aborted same-key waiter is dropped; the key is released after a failing job', async () => {
        const pool = mk({ max: 8, backgroundReserve: 2, backgroundConcurrency: 4 });
        const g = poolGuardFor(pool);
        const ac = new AbortController();
        let abortedRan = false;
        const failing = g.run('fail', async (c) => { await c.query(`SELECT pg_sleep(0.3) /* guard-z */`); throw new Error('boom'); }, { exclusive: 'k' });
        const dropped = g.run('drop', async () => { abortedRan = true; }, { exclusive: 'k', signal: ac.signal });
        await waitFor('waiter queued', () => g.stats().waiting === 1);
        ac.abort();
        assert.deepEqual(await dropped, { ran: false, reason: 'cancelled' });
        await assert.rejects(failing, /boom/);
        assert.equal(abortedRan, false);
        const after = await g.run('next', async (c) => (await c.query('SELECT 7 AS n')).rows[0].n, { exclusive: 'k' });
        assert.deepEqual(after, { ran: true, value: 7 });
        assert.deepEqual([g.stats().active, g.stats().waiting], [0, 0]);
    });

    console.log('\ncancel (c)');
    await test('cancelOwner cancels an in-flight statement; the job settles, the slot frees, the backend is gone', async () => {
        const pool = mk({ max: 4, backgroundReserve: 2, backgroundConcurrency: 2 });
        const g = poolGuardFor(pool);
        const owner = {};
        const job = g.run('long', (c) => c.query(`SELECT pg_sleep(30) /* guard-c1 */`), { owner });
        await waitFor('statement running', async () => (await activeSleeps('guard-c1')) === 1);
        const t = await timed(g.cancelOwner(owner));
        assert.ok(t.ms < 5000, `cancelOwner took ${t.ms} ms`);
        assert.deepEqual(await job, { ran: false, reason: 'cancelled' });
        assert.equal(await activeSleeps('guard-c1'), 0);
        assert.equal(g.stats().active, 0);
        assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the pool is healthy afterwards');
    });
    await test('an AbortSignal drops a queued job (it never connects) and cancels a running one', async () => {
        const pool = mk({ max: 4, backgroundReserve: 3, backgroundConcurrency: 4 }); // one slot
        const g = poolGuardFor(pool);
        const running = new AbortController(), queued = new AbortController();
        let queuedRan = false;
        const j1 = g.run('r', (c) => c.query(`SELECT pg_sleep(30) /* guard-c2 */`), { signal: running.signal });
        await waitFor('statement running', async () => (await activeSleeps('guard-c2')) === 1);
        const j2 = g.run('q', async () => { queuedRan = true; }, { signal: queued.signal });
        await waitFor('second job queued', () => g.stats().waiting === 1);
        queued.abort();
        assert.deepEqual(await j2, { ran: false, reason: 'cancelled' });
        assert.equal(queuedRan, false);
        running.abort();
        assert.deepEqual(await j1, { ran: false, reason: 'cancelled' });
        assert.equal(g.stats().active, 0);
        assert.equal(g.stats().waiting, 0);
    });
    await test('closePostgresPool cancels in-flight background work instead of waiting for it', async () => {
        const pool = createPostgresPool({ url, max: 4, backgroundReserve: 2 });
        const job = poolGuardFor(pool).run('long', (c) => c.query(`SELECT pg_sleep(30) /* guard-c3 */`));
        await waitFor('statement running', async () => (await activeSleeps('guard-c3')) === 1);
        const t = await timed(closePostgresPool(pool));
        assert.ok(t.ms < 8000, `close took ${t.ms} ms`);
        assert.deepEqual(await job, { ran: false, reason: 'cancelled' });
        assert.deepEqual(await poolGuardFor(pool).run('late', async () => 1), { ran: false, reason: 'cancelled' }, 'a closed pool accepts no new background work');
    });
    await test('a job that throws on its own rejects with its error and frees the slot', async () => {
        const pool = mk({ max: 4, backgroundReserve: 3, backgroundConcurrency: 1 });
        const g = poolGuardFor(pool);
        await assert.rejects(g.run('boom', async () => { throw new Error('boom'); }), /boom/);
        assert.equal(g.stats().active, 0);
        assert.deepEqual(await g.run('next', async () => 7), { ran: true, value: 7 });
    });

    console.log('\nsmall pool (d)');
    await test('pool max 1: the job is skipped with a single warning, fn never runs, foreground is untouched', async () => {
        const pool = mk({ max: 1 });
        const g = poolGuardFor(pool);
        assert.equal(g.slots, 0);
        const warns: string[] = [];
        const warn = console.warn; console.warn = (m: unknown) => { warns.push(String(m)); };
        let ran = false;
        try {
            assert.deepEqual(await g.run('idx', async () => { ran = true; }), { ran: false, reason: 'no-slots' });
            assert.deepEqual(await g.run('idx', async () => { ran = true; }), { ran: false, reason: 'no-slots' });
        } finally { console.warn = warn; }
        assert.equal(ran, false);
        assert.equal(warns.length, 1, 'warn once per job name');
        assert.match(warns[0]!, /idx.*skipped/);
        assert.equal(g.stats().skipped, 2);
        assert.equal(pool.totalCount, 0, 'a skipped job never took a connection');
        assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
    });
    await test('reserve >= max also skips; reserve 0 lets background use the whole pool (explicit operator choice)', async () => {
        assert.equal(poolGuardFor(mk({ max: 3, backgroundReserve: 3 })).slots, 0);
        assert.equal(poolGuardFor(mk({ max: 3, backgroundReserve: 0, backgroundConcurrency: 8 })).slots, 3);
        assert.equal(poolGuardFor(mk({ max: 16, backgroundConcurrency: 0 })).slots, 0, 'concurrency 0 switches background work off');
    });

    console.log('\nstatement timeout');
    await test('a job timeout applies to the job only (0 = unbounded) and is not left on the reused connection', async () => {
        const pool = mk({ max: 2, backgroundReserve: 1, backgroundConcurrency: 1 });
        const g = poolGuardFor(pool);
        const err = await g.run('t', (c) => c.query('SELECT pg_sleep(5)'), { timeoutMs: 200 }).catch((e: Error & { code?: string }) => e);
        assert.equal((err as { code?: string }).code, '57014', 'the 200 ms job timeout fired');
        const inside = await g.run('t0', async (c) => (await c.query('SHOW statement_timeout')).rows[0].statement_timeout as string, { timeoutMs: 0 });
        assert.deepEqual(inside, { ran: true, value: '0' });
        const after = await g.run('t-none', async (c) => (await c.query('SHOW statement_timeout')).rows[0].statement_timeout as string);
        assert.deepEqual(after, { ran: true, value: '0' }, 'no timeout requested: background jobs default to unbounded, not the 30 s foreground timeout');
        const fgAfter = (await pool.query('SHOW statement_timeout')).rows[0].statement_timeout;
        assert.equal(fgAfter, '30s');
        const configured = mk({ max: 2, backgroundReserve: 1, backgroundStatementTimeoutMs: 1234 });
        const viaDefault = await poolGuardFor(configured).run('d', async (c) => (await c.query('SHOW statement_timeout')).rows[0].statement_timeout as string);
        assert.deepEqual(viaDefault, { ran: true, value: '1234ms' });
        assert.equal((await configured.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s');
        const prevEnv = process.env.LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS;
        process.env.LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS = '4321';
        try {
            const viaEnv = mk({ max: 2, backgroundReserve: 1 });
            const envVal = await poolGuardFor(viaEnv).run('e', async (c) => (await c.query('SHOW statement_timeout')).rows[0].statement_timeout as string);
            assert.deepEqual(envVal, { ran: true, value: '4321ms' }, 'LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS sets the background default');
            assert.equal((await viaEnv.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s', 'foreground timeout unchanged');
        } finally {
            if (prevEnv === undefined) delete process.env.LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS; else process.env.LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS = prevEnv;
        }
    });


    console.log('\nverbatim store (compact + index builds)');
    class GateEmbedder implements EmbeddingProvider {
        readonly dimension = 4;
        readonly modelId = 'pg-gate-fixed';
        readonly dtype = 'fp32';
        async initialize(): Promise<void> {}
        async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
        async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
        async embedDocument(_t?: string): Promise<number[]> { return [0.5, 0.5, 0.5, 0.5]; }
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-guard-'));
    stampGateManifest(tmp, 'pg-gate-fixed', 4);
    await test('compact() and ensureFtsIndex() build run as guarded jobs and still do their work', async () => {
        const pool = mk({ max: 6, backgroundReserve: 2 });
        const store = new PostgresVerbatimStore(tmp, pool, 'pg-gate-poolguard-v', new GateEmbedder());
        await store.initialize();
        const g = poolGuardFor(pool);
        const c0 = g.stats().completed;
        assert.notEqual(await store.compact(), null);
        assert.equal(g.stats().completed, c0 + 1);
        await pool.query('DROP INDEX IF EXISTS verbatim_text_tsv_gin');
        assert.equal(await store.ensureFtsIndex(), true);
        assert.equal(g.stats().completed, c0 + 2);
        assert.equal((await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'verbatim_text_tsv_gin'`)).rowCount, 1);
        await store.close();
    });
    await test('pool max 1: compact() and the index build are skipped (null / false), never run', async () => {
        const pool = mk({ max: 1 });
        const store = new PostgresVerbatimStore(tmp, pool, 'pg-gate-poolguard-v', new GateEmbedder());
        await store.initialize();
        await pool.query('DROP INDEX IF EXISTS verbatim_text_tsv_gin');
        const warn = console.warn; console.warn = () => undefined;
        try {
            assert.equal(await store.compact(), null);
            assert.equal(await store.ensureFtsIndex(), false);
        } finally { console.warn = warn; }
        assert.equal(poolGuardFor(pool).stats().skipped, 2);
        assert.equal((await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'verbatim_text_tsv_gin'`)).rowCount, 0);
        await store.close();
    });
    await test('store.close() cancels that store\'s in-flight background statement', async () => {
        const pool = mk({ max: 6, backgroundReserve: 2 });
        const store = new PostgresVerbatimStore(tmp, pool, 'pg-gate-poolguard-v', new GateEmbedder());
        await store.initialize();
        // An old snapshot makes VACUUM-free index creation wait: reuse the blocker trick with a plain CREATE INDEX needing a SHARE lock.
        const blocker = new Client({ connectionString: url });
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE verbatim IN ACCESS EXCLUSIVE MODE'); // VACUUM ANALYZE verbatim blocks behind this
        try {
            const compacting = store.compact();
            await waitFor('vacuum waiting', async () => (await obs.query(`SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'VACUUM ANALYZE verbatim%'`)).rowCount === 1);
            const t = await timed(store.close());
            assert.ok(t.ms < 8000, `close took ${t.ms} ms`);
            assert.equal(await compacting, null);
            assert.equal(poolGuardFor(pool).stats().active, 0);
        } finally {
            await blocker.query('ROLLBACK').catch(() => undefined);
            await blocker.end();
        }
    });

    console.log('\nkeyword index (e)');
    const q = async (pool: Pool, sql: string): Promise<Record<string, unknown>[]> => (await pool.query(sql)).rows;
    const seed = async (pool: Pool, ws: string): Promise<PostgresGraph> => {
        const g = new PostgresGraph(ws, pool);
        await g.initialize();
        for (let i = 0; i < 30; i++) await g.upsertNode({ id: `bulk${i}`, type: 'note', label: `bulk${i}`, content: `content ${i}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
        await g.close();
        for (const s of KEYWORD_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${s.name}`);
        return g;
    };
    await test('the background keyword-index build runs through the guard and finishes', async () => {
        const pool = mk({ max: 6, backgroundReserve: 2 });
        await seed(pool, 'pg-gate-poolguard');
        const g = poolGuardFor(pool);
        const before = g.stats().completed;
        const graph = new PostgresGraph('pg-gate-poolguard', pool, { keywordIndexInlineRowLimit: 5 });
        await graph.initialize();
        await graph.waitForKeywordIndexes();
        assert.equal((await validKeywordIndexes(pool)).size, KEYWORD_INDEXES.length);
        assert.equal(g.stats().completed, before + 1, 'the build was counted as a guarded job');
        assert.equal(g.stats().started, g.stats().completed);
        await graph.close();
    });
    await test('while the build runs, foreground search keeps working and releasing the last owner cancels the build', async () => {
        const pool = mk({ max: 6, backgroundReserve: 2 });
        for (const s of KEYWORD_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${s.name}`);
        // An old open transaction makes CREATE INDEX CONCURRENTLY wait ("waiting for old snapshots"): the build is in flight but blocked.
        const blocker = new Client({ connectionString: url });
        await blocker.connect();
        await blocker.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); // holds a snapshot, which is what the build waits for
        await blocker.query('SELECT count(*) FROM nodes');
        try {
            const owner = {};
            const done = startKeywordIndexBuild(pool, owner);
            await waitFor('CREATE INDEX CONCURRENTLY in flight', async () => (await obs.query(`SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'CREATE INDEX CONCURRENTLY%'`)).rowCount === 1);
            const fg = await timed(pool.query(`SELECT count(*) FROM nodes WHERE label LIKE 'bulk%'`));
            assert.ok(fg.ms < 1000, `foreground query took ${fg.ms} ms during the build`);
            const t = await timed(releaseKeywordIndexBuild(pool, owner));
            assert.ok(t.ms < 8000, `release took ${t.ms} ms`);
            await done;
            assert.equal((await obs.query(`SELECT 1 FROM pg_stat_activity WHERE query LIKE 'CREATE INDEX CONCURRENTLY%' AND state = 'active'`)).rowCount, 0);
            assert.equal(poolGuardFor(pool).stats().active, 0);
        } finally {
            await blocker.query('ROLLBACK').catch(() => undefined);
            await blocker.end();
        }
        // The cancelled build left an INVALID leftover at most; the next open repairs it (A1 behaviour, unchanged).
        const g2 = new PostgresGraph('pg-gate-poolguard', pool);
        await g2.initialize();
        assert.equal((await validKeywordIndexes(pool)).size, KEYWORD_INDEXES.length);
        await g2.close();
    });
    await test('pool max 1: the keyword build is skipped with a warning and search stays correct (unindexed)', async () => {
        const pool = mk({ max: 1 });
        for (const s of KEYWORD_INDEXES) await q(pool, `DROP INDEX IF EXISTS ${s.name}`);
        const warn = console.warn; const warns: string[] = []; console.warn = (m: unknown) => { warns.push(String(m)); };
        const graph = new PostgresGraph('pg-gate-poolguard', pool, { keywordIndexInlineRowLimit: 5 });
        try {
            await graph.initialize();
            await graph.waitForKeywordIndexes();
        } finally { console.warn = warn; }
        assert.ok(warns.some((w) => /keyword-index-build.*skipped/.test(w)), warns.join('|'));
        assert.equal((await validKeywordIndexes(pool)).size, 0);
        assert.ok((await graph.search('bulk7', 5)).length >= 1);
        await graph.close();
    });
} finally {
    await obs.end().catch(() => undefined);
    for (const p of pools) await closePostgresPool(p).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
