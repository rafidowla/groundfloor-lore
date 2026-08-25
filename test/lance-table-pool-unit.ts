#!/usr/bin/env tsx
/**
 * test/lance-table-pool-unit.ts — LanceTablePool unit tests.
 *
 * Mirrors test/kuzu-connection-pool-unit.ts shape. Validates the
 * pool-lifecycle invariants the /api/recall LanceDB fix depends on:
 *
 *   1. resolveLancePoolSize honours env + clamp + default
 *   2. initialize opens N handles
 *   3. acquire returns up to N immediately
 *   4. N+1th acquire blocks until release
 *   5. waiters are released in FIFO order
 *   6. withTable releases on throw
 *   7. close rejects queued waiters, is idempotent
 *   8. safety net installs exactly once
 *
 * Exercises a real LanceDB table in a tmp dir — the pool wraps native
 * NAPI handles and a mock would gloss over the very thing we're
 * testing (multi-handle openTable behaviour).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float32, Utf8, FixedSizeList } from 'apache-arrow';

import {
    LanceTablePool,
    DEFAULT_LANCE_POOL_SIZE,
    MIN_LANCE_POOL_SIZE,
    MAX_LANCE_POOL_SIZE,
    resolveLancePoolSize,
    __resetLanceSafetyNetForTests,
    __isLanceSafetyNetInstalledForTests,
} from '../packages/lore/src/engines/lanceTablePool.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/** Build a real lancedb table in a fresh tmp dir, seeded with a few
 *  rows so openTable doesn't reject. Returns the connection + cleanup
 *  fn the caller must invoke. */
async function makeLanceTable(): Promise<{
    connection: lancedb.Connection;
    cleanup: () => Promise<void>;
}> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-lance-pool-test-'));
    const dbPath = path.join(tmp, 'lancedb');
    const conn = await lancedb.connect(dbPath);
    const schema = new Schema([
        new Field('vector', new FixedSizeList(8, new Field('item', new Float32(), true)), false),
        new Field('id', new Utf8(), false),
        new Field('text', new Utf8(), false),
    ]);
    const tbl = await conn.createEmptyTable('lore_verbatim', schema);
    await tbl.add([{
        id: 'seed-1',
        text: 'tenant alpha bravo',
        vector: Array.from({ length: 8 }, (_, i) => i / 10),
    }]);
    return {
        connection: conn,
        cleanup: async () => {
            try { await conn.close?.(); } catch { /* ignore */ }
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
}

async function run() {
    console.log('\n=== LanceTablePool unit tests ===\n');

    await test('resolveLancePoolSize: default when env missing/empty', () => {
        assert.equal(resolveLancePoolSize(undefined), DEFAULT_LANCE_POOL_SIZE);
        assert.equal(resolveLancePoolSize(''), DEFAULT_LANCE_POOL_SIZE);
    });

    await test('resolveLancePoolSize: parses integer values', () => {
        assert.equal(resolveLancePoolSize('8'), 8);
        assert.equal(resolveLancePoolSize('1'), 1);
    });

    await test('resolveLancePoolSize: clamps below MIN and above MAX', () => {
        assert.equal(resolveLancePoolSize('0'), MIN_LANCE_POOL_SIZE);
        assert.equal(resolveLancePoolSize('-3'), MIN_LANCE_POOL_SIZE);
        assert.equal(resolveLancePoolSize('9999'), MAX_LANCE_POOL_SIZE);
    });

    await test('resolveLancePoolSize: non-finite falls back to default', () => {
        assert.equal(resolveLancePoolSize('not-a-number'), DEFAULT_LANCE_POOL_SIZE);
        assert.equal(resolveLancePoolSize('NaN'), DEFAULT_LANCE_POOL_SIZE);
    });

    await test('pool initialize opens N handles', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 3);
            assert.equal(pool.size, 3);
            await pool.initialize();
            assert.equal(pool.available(), 3);
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('acquire hands out up to N distinct handles', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 2);
            await pool.initialize();
            const a = await pool.acquire();
            const b = await pool.acquire();
            assert.notEqual(a, b, 'each acquire must return a distinct Table');
            assert.equal(pool.available(), 0);
            pool.release(a);
            pool.release(b);
            assert.equal(pool.available(), 2);
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('N+1th acquire blocks until release', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 1);
            await pool.initialize();
            const first = await pool.acquire();
            let resolved = false;
            const pending = pool.acquire().then((t) => { resolved = true; return t; });
            await new Promise((r) => setImmediate(r));
            assert.equal(resolved, false, 'acquire must wait when no idle handles remain');
            assert.equal(pool.waitingCount(), 1);
            pool.release(first);
            const second = await pending;
            assert.equal(resolved, true);
            assert.ok(second);
            pool.release(second);
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('waiters released in FIFO order', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 1);
            await pool.initialize();
            const held = await pool.acquire();

            const completed: number[] = [];
            const w1 = pool.acquire().then((t) => { completed.push(1); return t; });
            const w2 = pool.acquire().then((t) => { completed.push(2); return t; });
            const w3 = pool.acquire().then((t) => { completed.push(3); return t; });

            pool.release(held);
            const t1 = await w1;
            assert.deepEqual(completed, [1]);
            pool.release(t1);
            const t2 = await w2;
            assert.deepEqual(completed, [1, 2]);
            pool.release(t2);
            const t3 = await w3;
            assert.deepEqual(completed, [1, 2, 3]);
            pool.release(t3);
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('withTable releases on throw', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 1);
            await pool.initialize();
            await assert.rejects(
                pool.withTable(async () => { throw new Error('boom'); }, false),
                /boom/,
            );
            assert.equal(pool.available(), 1, 'handle must return to pool on throw');
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('withTable runs vectorSearch end-to-end', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 2);
            await pool.initialize();
            const rows = await pool.withTable(async (tbl) => {
                const vec = Array.from({ length: 8 }, (_, i) => i / 10);
                return await tbl.vectorSearch(vec).limit(5).toArray();
            }, false);
            assert.ok(Array.isArray(rows));
            assert.ok(rows.length >= 1, 'seeded row should be retrievable');
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('close rejects queued waiters', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 1);
            await pool.initialize();
            const held = await pool.acquire();
            const pending = pool.acquire();
            const closePromise = pool.close();
            await assert.rejects(pending, /closed during acquire/);
            pool.release(held);
            await closePromise;
        } finally { await cleanup(); }
    });

    await test('close is idempotent', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 2);
            await pool.initialize();
            await pool.close();
            await pool.close(); // must not throw
        } finally { await cleanup(); }
    });

    await test('acquire after close rejects with closed-pool error', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 2);
            await pool.initialize();
            await pool.close();
            await assert.rejects(pool.acquire(), /pool is closed/);
        } finally { await cleanup(); }
    });

    await test('acquire before initialize rejects', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            const pool = new LanceTablePool(connection, 'lore_verbatim', 1);
            await assert.rejects(pool.acquire(), /not initialized/);
            await pool.close();
        } finally { await cleanup(); }
    });

    await test('safety net installs exactly once across pool instances', async () => {
        const { connection, cleanup } = await makeLanceTable();
        try {
            __resetLanceSafetyNetForTests();
            assert.equal(__isLanceSafetyNetInstalledForTests(), false);
            const beforeUncaught = process.listenerCount('uncaughtException');
            const beforeUnhandled = process.listenerCount('unhandledRejection');

            const p1 = new LanceTablePool(connection, 'lore_verbatim', 1);
            assert.equal(__isLanceSafetyNetInstalledForTests(), true);

            const afterFirst = {
                uncaught: process.listenerCount('uncaughtException'),
                unhandled: process.listenerCount('unhandledRejection'),
            };
            assert.equal(afterFirst.uncaught, beforeUncaught + 1);
            assert.equal(afterFirst.unhandled, beforeUnhandled + 1);

            const p2 = new LanceTablePool(connection, 'lore_verbatim', 1);
            assert.equal(process.listenerCount('uncaughtException'), afterFirst.uncaught,
                'second pool must not add another uncaughtException listener');
            assert.equal(process.listenerCount('unhandledRejection'), afterFirst.unhandled,
                'second pool must not add another unhandledRejection listener');
            void p1.close();
            void p2.close();
        } finally { await cleanup(); }
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
