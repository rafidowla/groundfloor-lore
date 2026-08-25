#!/usr/bin/env tsx
/**
 * substrate-adversarial-unit.ts — RC2 audit (2026-05-17) Phase 2.
 *
 * Each test pins down a substrate-level edge case that the audit
 * brief calls out and the existing unit suites either don't cover or
 * cover only the happy path.
 *
 *   1. SqliteTableStorage schema-cache mismatch — DB still holds the
 *      table after schemas.json is deleted. requireSchema must surface
 *      a recovery-actionable error, and a re-declare must
 *      non-destructively restore access to the existing rows.
 *   2. Empty / fresh storage — count + query must succeed (returning
 *      0 / []) rather than throwing.
 *   3. Concurrent same-target inserts — better-sqlite3 is synchronous
 *      and serializes; if a duplicate primary key races against an
 *      earlier insert, one promise rejects (duplicate_primary_key)
 *      and the other persists. Document this as the invariant.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';

const TENANT: TableSchema = {
    name: 'tenant',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string' },
    ],
};

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function mkTmp(): { dbPath: string; cachePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-substrate-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cachePath: path.join(dir, 'schemas.json'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

(async () => {
    console.log('substrate-adversarial-unit (RC2 audit Phase 2)');
    console.log('\nSqlite schema-cache mismatch');

    await test('cache deleted: getByKey surfaces a recovery-actionable error (not just "unknown table")', async () => {
        const { dbPath, cachePath, cleanup } = mkTmp();
        try {
            {
                const s = new SqliteTableStorage(dbPath, cachePath);
                await s.createTable(TENANT);
                await s.insert('tenant', { id: 'a', name: 'Acme' });
                s.close();
            }
            fs.unlinkSync(cachePath);
            const s2 = new SqliteTableStorage(dbPath, cachePath);
            await assert.rejects(
                () => s2.getByKey('tenant', 'a'),
                (err: Error) => {
                    assert.match(err.message, /exists in the DB but its schema is not cached/);
                    assert.match(err.message, /Re-declare the table via createTable/);
                    return true;
                },
            );
            s2.close();
        } finally { cleanup(); }
    });

    await test('cache deleted: re-declare via createTable restores access without rewriting data', async () => {
        const { dbPath, cachePath, cleanup } = mkTmp();
        try {
            {
                const s = new SqliteTableStorage(dbPath, cachePath);
                await s.createTable(TENANT);
                await s.insert('tenant', { id: 'a', name: 'Acme' });
                s.close();
            }
            fs.unlinkSync(cachePath);
            const s2 = new SqliteTableStorage(dbPath, cachePath);
            await s2.createTable(TENANT); // recovery step
            const row = await s2.getByKey('tenant', 'a');
            assert.deepEqual(row, { id: 'a', name: 'Acme' });
            s2.close();
        } finally { cleanup(); }
    });

    await test('truly-missing table still surfaces the original "unknown table" error', async () => {
        const { dbPath, cachePath, cleanup } = mkTmp();
        try {
            const s = new SqliteTableStorage(dbPath, cachePath);
            await assert.rejects(
                () => s.getByKey('nope', 'x'),
                /unknown table 'nope' \(createTable first\)/,
            );
            s.close();
        } finally { cleanup(); }
    });

    console.log('\nEmpty workspace');

    await test('count on fresh table returns 0 (not "unknown table")', async () => {
        const { dbPath, cachePath, cleanup } = mkTmp();
        try {
            const s = new SqliteTableStorage(dbPath, cachePath);
            await s.createTable(TENANT);
            assert.equal(await s.count('tenant'), 0);
            s.close();
        } finally { cleanup(); }
    });

    await test('query on fresh table returns []', async () => {
        const { dbPath, cachePath, cleanup } = mkTmp();
        try {
            const s = new SqliteTableStorage(dbPath, cachePath);
            await s.createTable(TENANT);
            assert.deepEqual(await s.query('tenant'), []);
            s.close();
        } finally { cleanup(); }
    });

    console.log('\nConcurrent same-target inserts');

    await test('duplicate primary key racing against an earlier insert: exactly one survives', async () => {
        const { dbPath, cachePath, cleanup } = mkTmp();
        try {
            const s = new SqliteTableStorage(dbPath, cachePath);
            await s.createTable(TENANT);
            const results = await Promise.allSettled([
                s.insert('tenant', { id: 'same', name: 'A' }),
                s.insert('tenant', { id: 'same', name: 'B' }),
                s.insert('tenant', { id: 'same', name: 'C' }),
            ]);
            const fulfilled = results.filter(r => r.status === 'fulfilled');
            const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            assert.equal(fulfilled.length, 1, 'exactly one insert must succeed');
            assert.equal(rejected.length, 2, 'two duplicates must be rejected');
            for (const r of rejected) {
                assert.match((r.reason as Error).message, /duplicate primary key|UNIQUE constraint/);
            }
            assert.equal(await s.count('tenant'), 1);
            s.close();
        } finally { cleanup(); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
