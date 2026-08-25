#!/usr/bin/env tsx
/**
 * test/fc1-collections-write-integrity-unit.ts — 2026-08-17 audit findings
 * 1.5 / 1.6 / M6 / M8 (collections + SqliteTableStorage).
 *
 *   1.5 — insertBatch silently dropped rows whose keys matched no declared
 *         column (`if (cols.length === 0) continue`) while handleBulkInsert
 *         (collection_bulk_insert / POST /v1/{c}/bulk) reported
 *         inserted: records.length. Now both throw like insert() always did,
 *         and the single-transaction batch leaves NOTHING behind.
 *   1.6 — insert() silently discarded caller keys not in the schema and the
 *         handler echoed the caller's own object back as if stored, while
 *         update() threw for the same typo. insert/insertBatch now throw on
 *         unknown columns too. (Decision: throw — update()'s strictness is
 *         the pre-existing design signal; the permissive zod record type is
 *         just an untyped bag, not a silent-drop mandate.)
 *   M6  — collection_query silently truncated at the storage layer's
 *         10,000-row default cap with has_more:false and a wrong
 *         total_count, and the documented { limit: Infinity } escape hatch
 *         threw (`LIMIT Infinity` is a SQLite syntax error). Now: non-finite
 *         limits omit the LIMIT clause, and handleQuery runs a real COUNT(*)
 *         whenever truncation is possible.
 *   M8  — evolveSchema applied ALTERs one at a time but updated its schema
 *         cache only at the end, so a mid-way failure permanently wedged the
 *         table (applied-but-uncached columns silently dropped on write).
 *         The cache now commits after EACH successful ALTER.
 *
 * Run: npx tsx test/fc1-collections-write-integrity-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { handleInsert, handleBulkInsert, handleQuery } from '../packages/lore/src/mcp/tools/collections.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc1-collections-'));
    return {
        s: new SqliteTableStorage(path.join(dir, 'tables.sqlite'), path.join(dir, 'schemas.json')),
        dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

const CONTACT = {
    name: 'contact',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'email', type: 'string' },
    ],
} as const;

async function main() {
    console.log('1.5 — bulk insert reports what actually landed');

    await test('T1.5a the audit repro: 100 records with wrong-case keys → THROWS, zero rows land', async () => {
        const { s, cleanup } = tmpStore();
        try {
            await s.createTable(CONTACT as never);
            const deps = { tableStorage: s } as never;
            const records = Array.from({ length: 100 }, (_, i) => ({ ID: `c${i}`, Email: `c${i}@x.io` }));
            await assert.rejects(
                () => handleBulkInsert(deps, 'contact', records as never),
                /unknown column 'ID'|empty row/,
                'must throw instead of reporting inserted:100 for 0 landed rows',
            );
            assert.equal(await s.count('contact'), 0, 'nothing may land silently');
        } finally { cleanup(); }
    });

    await test('T1.5b partial batch [{id},{Id},{id}] aborts atomically (was: 2 of 3 silently written)', async () => {
        const { s, cleanup } = tmpStore();
        try {
            await s.createTable(CONTACT as never);
            await assert.rejects(
                () => s.insertBatch('contact', [{ id: 'b1' }, { Id: 'b2' }, { id: 'b3' }]),
                /unknown column 'Id'/,
            );
            assert.equal(await s.count('contact'), 0, 'single transaction — the good rows must roll back too');
        } finally { cleanup(); }
    });

    await test('T1.5c well-formed bulk insert still reports the true count', async () => {
        const { s, cleanup } = tmpStore();
        try {
            await s.createTable(CONTACT as never);
            const deps = { tableStorage: s } as never;
            const records = [{ id: 'a', email: 'a@x.io' }, { id: 'b', email: 'b@x.io' }];
            const res = await handleBulkInsert(deps, 'contact', records as never);
            assert.equal(res.inserted, 2);
            assert.equal(res.total_requested, 2);
            assert.equal(await s.count('contact'), 2, 'reported count matches storage truth');
        } finally { cleanup(); }
    });

    console.log('1.6 — insert refuses unknown columns (matching update())');

    await test('T1.6a the audit repro: unknown field is a hard error, not silent loss', async () => {
        const { s, cleanup } = tmpStore();
        try {
            await s.createTable({
                name: 'invoice',
                columns: [
                    { name: 'id', type: 'string', primary: true },
                    { name: 'amount', type: 'float' },
                ],
            } as never);
            const deps = { tableStorage: s } as never;
            await assert.rejects(
                () => handleInsert(deps, 'invoice', { id: 'a1', amount: 10, customer_note: 'PAY BY FRIDAY' } as never),
                /unknown column 'customer_note'/,
            );
            assert.equal(await s.count('invoice'), 0);
            // And the honest path round-trips what it echoes.
            const ok = await handleInsert(deps, 'invoice', { id: 'a2', amount: 5 } as never);
            assert.deepEqual(ok, { id: 'a2', amount: 5 });
            assert.deepEqual(await s.getByKey('invoice', 'a2'), { id: 'a2', amount: 5 });
        } finally { cleanup(); }
    });

    console.log('M6 — collection_query tells the truth at the 10k cap');

    await test('T1.M6 10,001 rows: default query → has_more:true + real total_count; limit:Infinity escape hatch works', async () => {
        const { s, cleanup } = tmpStore();
        try {
            await s.createTable(CONTACT as never);
            const rows = Array.from({ length: 10_001 }, (_, i) => ({ id: `r${i}`, email: `r${i}@x.io` }));
            await s.insertBatch('contact', rows);
            const deps = { tableStorage: s } as never;

            const page = await handleQuery(deps, 'contact', undefined, undefined);
            assert.equal(page.records.length, 10_000, 'default cap still bounds the page');
            assert.equal(page.has_more, true, 'pre-fix: has_more was false at the silent cap');
            assert.equal(page.total_count, 10_001, 'pre-fix: total_count equaled the truncated page length');

            const all = await handleQuery(deps, 'contact', undefined, { limit: Infinity } as never);
            assert.equal(all.records.length, 10_001, 'documented escape hatch must actually work (pre-fix: SQLite syntax error)');
            assert.equal(all.has_more, false);
        } finally { cleanup(); }
    });

    console.log('M8 — a mid-way evolveSchema failure leaves an accurate cache');

    await test('T1.M8 ALTER 1 of 2 fails → cache knows the applied column, not the failed one', async () => {
        const { s, dir, cleanup } = tmpStore();
        try {
            await s.createTable({
                name: 't',
                columns: [{ name: 'id', type: 'string', primary: true }],
            } as never);
            // Physically pre-add 'c2' BEHIND the cache's back, so evolveSchema's
            // second ALTER (c2) fails with a duplicate-column error AFTER c1 landed.
            const raw = new Database(path.join(dir, 'tables.sqlite'));
            raw.exec('ALTER TABLE "t" ADD COLUMN "c2" TEXT');
            raw.close();

            await assert.rejects(
                () => s.evolveSchema('t', {
                    name: 't',
                    columns: [
                        { name: 'id', type: 'string', primary: true },
                        { name: 'c1', type: 'string' },
                        { name: 'c2', type: 'string' },
                    ],
                } as never),
                /c2|duplicate/i,
            );

            // The applied column is writable (cache committed incrementally)…
            await s.insert('t', { id: 'x', c1: 'v1' });
            assert.equal((await s.getByKey('t', 'x'))!['c1'], 'v1');
            // …and the FAILED column is not falsely claimed by the cache
            // (pre-fix: the cache never updated at all, so BOTH were dropped
            // silently on every later write).
            await assert.rejects(
                () => s.insert('t', { id: 'y', c2: 'v2' }),
                /unknown column 'c2'/,
            );
        } finally { cleanup(); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
