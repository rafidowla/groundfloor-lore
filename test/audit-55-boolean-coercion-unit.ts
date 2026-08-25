#!/usr/bin/env tsx
/**
 * audit-55-boolean-coercion-unit.ts — regression for audit finding 5.5
 * (2026-08-17 functional-correctness audit, HIGH).
 *
 * Bug: SqliteTableStorage.encodeValue's boolean branch used plain JS
 * truthiness (`v ? 1 : 0`), so EVERY non-empty string ('false', '0', 'no')
 * was stored as TRUE — both on write AND in query filters (the filter
 * encoder delegates to the same encodeValue via buildWhereClause).
 *
 * Verified live pre-fix:
 *   insert({id:'c', active:'false'}) read back as active:true
 *   query({eq:{active:'false'}}) returned the TRUE rows
 *   tabular re-import of '1'/'0'/'no' stored '0' and 'no' as TRUE
 *
 * Fix: encodeValue's boolean branch now PARSES the value (booleans pass
 * through; 0/non-zero numbers; 'true'/'1'/'yes'/'y'/'on' vs
 * 'false'/'0'/'no'/'n'/'off' case-insensitive) and THROWS on a genuinely
 * unparseable string (no lossless verbatim representation exists for a
 * boolean column — silently guessing corrupts data with no signal).
 *
 * Exercises the REAL SqliteTableStorage entry points (the storage behind
 * MCP collection_insert/collection_query and the REST collection routes).
 *
 * Run: npx tsx test/audit-55-boolean-coercion-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { coerceValue } from '../packages/lore/src/engines/tabularImport.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function mkStorage(): { s: SqliteTableStorage; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit55-'));
    return {
        s: new SqliteTableStorage(path.join(dir, 'tables.sqlite'), path.join(dir, 'schemas.json')),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

const PEOPLE: TableSchema = {
    name: 'people',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'active', type: 'boolean' },
    ],
};

console.log('Audit 5.5 — boolean coercion in SqliteTableStorage');

test('RAN repro: insert active:"false" reads back false, and query eq:"false" returns exactly the false rows', async () => {
    const { s, cleanup } = mkStorage();
    try {
        await s.createTable(PEOPLE);
        await s.insert('people', { id: 'a', active: true });
        await s.insert('people', { id: 'b', active: false });
        await s.insert('people', { id: 'c', active: 'false' });

        const all = await s.query('people');
        const byId = new Map(all.map((r) => [r['id'], r['active']]));
        assert.equal(byId.get('a'), true);
        assert.equal(byId.get('b'), false);
        // Pre-fix this read back TRUE — the string was silently inverted.
        assert.equal(byId.get('c'), false, 'insert({active:"false"}) must store false');

        const eqStr = await s.query('people', { eq: { active: 'false' } });
        assert.deepEqual(eqStr.map((r) => r['id']).sort(), ['b', 'c'],
            'query eq:active="false" must return the FALSE rows, not the true ones');

        const eqBool = await s.query('people', { eq: { active: false } });
        assert.deepEqual(eqBool.map((r) => r['id']).sort(), ['b', 'c']);

        assert.equal(await s.count('people', { eq: { active: 'false' } }), 2);
        assert.equal(await s.count('people', { eq: { active: true } }), 1);
    } finally { cleanup(); }
});

test('string aliases parse consistently on write and in filters', async () => {
    const { s, cleanup } = mkStorage();
    try {
        await s.createTable(PEOPLE);
        // Truthy spellings
        for (const [i, v] of ['true', 'TRUE', ' 1 ', 'yes', 'On'].entries()) {
            await s.insert('people', { id: `t${i}`, active: v });
        }
        // Falsy spellings
        for (const [i, v] of ['false', 'FALSE', '0', 'no', 'oFF'].entries()) {
            await s.insert('people', { id: `f${i}`, active: v });
        }
        const trues = await s.query('people', { eq: { active: true } });
        const falses = await s.query('people', { eq: { active: 'no' } });
        assert.equal(trues.length, 5, `expected 5 true rows, got ${trues.length}`);
        assert.equal(falses.length, 5, `expected 5 false rows, got ${falses.length}`);
        assert.ok(falses.every((r) => r['active'] === false));
        assert.ok(trues.every((r) => r['active'] === true));
    } finally { cleanup(); }
});

test('numbers coerce: 0 → false, non-zero → true', async () => {
    const { s, cleanup } = mkStorage();
    try {
        await s.createTable(PEOPLE);
        await s.insert('people', { id: 'n0', active: 0 });
        await s.insert('people', { id: 'n1', active: 1 });
        await s.insert('people', { id: 'n9', active: -9 });
        const rows = await s.query('people');
        const byId = new Map(rows.map((r) => [r['id'], r['active']]));
        assert.equal(byId.get('n0'), false);
        assert.equal(byId.get('n1'), true);
        assert.equal(byId.get('n9'), true);
    } finally { cleanup(); }
});

test('tabular re-import shape: coerceValue("0"/"no") now stores FALSE (Run B repro)', async () => {
    const { s, cleanup } = mkStorage();
    try {
        await s.createTable(PEOPLE);
        // Simulates writeTabularRows' path: coerceValue maps raw cells,
        // then the table store encodes by declared type. Pre-fix, the
        // verbatim passthrough strings ('0', 'no') hit the truthiness
        // branch and were stored as TRUE.
        const cells: Array<[string, string]> = [
            ['alice', 'true'], ['bob', 'false'], ['carol', '1'], ['dave', '0'], ['erin', 'no'],
        ];
        for (const [id, raw] of cells) {
            await s.insert('people', { id, active: coerceValue(raw, 'boolean') });
        }
        const rows = await s.query('people');
        const byId = new Map(rows.map((r) => [r['id'], r['active']]));
        assert.equal(byId.get('alice'), true);
        assert.equal(byId.get('bob'), false);
        assert.equal(byId.get('carol'), true);
        assert.equal(byId.get('dave'), false, "'0' must store FALSE");
        assert.equal(byId.get('erin'), false, "'no' must store FALSE");
    } finally { cleanup(); }
});

test('unparseable boolean strings THROW (surface bad data, never silently corrupt)', async () => {
    const { s, cleanup } = mkStorage();
    try {
        await s.createTable(PEOPLE);
        await assert.rejects(
            () => s.insert('people', { id: 'x', active: 'maybe' }),
            /unparseable boolean/,
        );
        // Filters reject the same way so writes and queries stay consistent.
        await assert.rejects(
            () => s.query('people', { eq: { active: 'maybe' } }),
            /unparseable boolean/,
        );
    } finally { cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
