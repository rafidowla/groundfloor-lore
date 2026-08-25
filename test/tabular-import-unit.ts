#!/usr/bin/env tsx
/**
 * tabular-import-unit.ts — verifies the Bucket A import-table path.
 *
 * Two layers, matching how the feature splits:
 *   1. Pure functions (no I/O, zero API cost): identifier sanitation,
 *      column-type inference, schema construction, row mapping, and the
 *      additive union used for re-import reconciliation.
 *   2. Real SQLite round-trip: writeTabularRows against a real
 *      SqliteTableStorage in a per-test tmpdir — insert a small
 *      spreadsheet's worth of rows, query them back, confirm counts,
 *      values, and types; then re-import (same shape → reuse, new
 *      columns → additive evolve).
 *
 * Run: npx tsx test/tabular-import-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runImport } from '../packages/lore/src/mcp/http/routes/import.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import {
    buildTableRow,
    coerceValue,
    deriveTableName,
    inferColumnType,
    inferTableSchema,
    sanitizeIdentifier,
    unionSchema,
    writeTabularRows,
} from '../packages/lore/src/engines/tabularImport.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function mkTmp(): { dbPath: string; cachePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tabular-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cachePath: path.join(dir, 'schemas.json'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

console.log('tabularImport — pure');

/* ---------- sanitizeIdentifier ---------- */

test('sanitizeIdentifier collapses invalid runs to underscores', () => {
    assert.equal(sanitizeIdentifier('First Name', 'x'), 'First_Name');
    assert.equal(sanitizeIdentifier('Revenue ($)', 'x'), 'Revenue');
    assert.equal(sanitizeIdentifier('a b-c', 'x'), 'a_b_c');
});

test('sanitizeIdentifier falls back when empty and prefixes a leading digit', () => {
    assert.equal(sanitizeIdentifier('', 'fallback'), 'fallback');
    assert.equal(sanitizeIdentifier('   ', 'fallback'), 'fallback');
    assert.equal(sanitizeIdentifier('123abc', 'x'), '_123abc');
});

test('sanitizeIdentifier always yields a valid identifier', () => {
    for (const raw of ['', 'a', 'A b', '1', '_lead', '___', 'dash-dash', '@#$%', '混合']) {
        const out = sanitizeIdentifier(raw, 'col');
        assert.match(out, /^[A-Za-z_][A-Za-z0-9_]*$/, `invalid identifier from ${JSON.stringify(raw)} → ${out}`);
    }
});

/* ---------- inferColumnType ---------- */

test('inferColumnType detects integer / float / boolean / date / datetime', () => {
    assert.equal(inferColumnType(['1', '2', '-3']), 'integer');
    assert.equal(inferColumnType(['1', '2.5', '-0.5']), 'float');
    assert.equal(inferColumnType(['true', 'False', 'TRUE']), 'boolean');
    assert.equal(inferColumnType(['2024-01-15', '2023-12-31']), 'date');
    assert.equal(inferColumnType(['2024-01-15T10:00:00Z', '2024-01-15 09:30:00']), 'datetime');
});

test('inferColumnType widens to string on any non-conforming value', () => {
    assert.equal(inferColumnType(['1', 'abc']), 'string');
    assert.equal(inferColumnType(['1', 'N/A']), 'string');
    assert.equal(inferColumnType(['2024-13-45']), 'string'); // invalid date
    assert.equal(inferColumnType(['12.50', '1,200']), 'string'); // comma not float
});

test('inferColumnType treats empty cells as absent (null), not a type signal', () => {
    assert.equal(inferColumnType([]), 'string');
    assert.equal(inferColumnType(['', '  ']), 'string');
    assert.equal(inferColumnType(['', '5', '']), 'integer'); // empties ignored
});

/* ---------- deriveTableName ---------- */

test('deriveTableName keys the table on the sanitised entity type', () => {
    assert.equal(deriveTableName('Invoice'), 'import_invoice');
    assert.equal(deriveTableName('Invoice Line'), 'import_invoice_line');
    assert.equal(deriveTableName(''), 'import_dataset');
    assert.equal(deriveTableName('   '), 'import_dataset');
});

/* ---------- inferTableSchema ---------- */

test('inferTableSchema builds typed columns + traceability columns', () => {
    const rows = [
        { Name: 'Alice', Amount: '100', Active: 'true', 'Signup Date': '2024-01-15' },
        { Name: 'Bob', Amount: '250', Active: 'false', 'Signup Date': '2024-02-20' },
    ];
    const t = inferTableSchema({ entityType: 'Contact', headers: Object.keys(rows[0]), rows });
    assert.equal(t.tableName, 'import_contact');

    const byName = new Map(t.schema.columns.map((c) => [c.name, c.type]));
    assert.equal(byName.get('_row_id'), 'string');
    assert.equal(byName.get('_import_id'), 'string');
    assert.equal(byName.get('_source_file'), 'string');
    assert.equal(byName.get('_source_row'), 'integer');
    assert.equal(byName.get('Name'), 'string');
    assert.equal(byName.get('Amount'), 'integer');
    assert.equal(byName.get('Active'), 'boolean');
    assert.equal(byName.get('Signup_Date'), 'date');

    // exactly one primary key, and it's the synthetic _row_id
    const pks = t.schema.columns.filter((c) => c.primary);
    assert.equal(pks.length, 1);
    assert.equal(pks[0]!.name, '_row_id');
});

test('inferTableSchema de-duplicates colliding sanitised headers', () => {
    const rows = [{ Name: 'a', Name2: 'b' }, { Name: 'c', Name2: 'd' }];
    // "Name" and "Name 2" both… actually use two headers that collapse together.
    const t = inferTableSchema({
        entityType: 'T',
        headers: ['Full Name', 'Full Name'],
        rows: [{ 'Full Name': 'a' }, { 'Full Name': 'b' }],
    });
    const names = t.schema.columns.map((c) => c.name);
    assert.equal(names.filter((n) => n === 'Full_Name').length, 1);
    assert.ok(names.includes('Full_Name_2'), `expected de-duped second column, got ${names.join(',')}`);
});

/* ---------- coerceValue ---------- */

test('coerceValue maps empty → null and parses typed values', () => {
    assert.equal(coerceValue('42', 'integer'), 42);
    assert.equal(coerceValue('-7', 'integer'), -7);
    assert.equal(coerceValue('12.50', 'float'), 12.5);
    assert.equal(coerceValue('true', 'boolean'), true);
    assert.equal(coerceValue('FALSE', 'boolean'), false);
    assert.equal(coerceValue('2024-01-15', 'date'), '2024-01-15');
    assert.equal(coerceValue('', 'integer'), null);
    assert.equal(coerceValue('   ', 'float'), null);
});

test('coerceValue preserves a value that does not fit its declared type', () => {
    // Re-import edge case: column kept its first-import integer type, but a
    // new value arrived as text. It must not be dropped or corrupted.
    assert.equal(coerceValue('N/A', 'integer'), 'N/A');
    assert.equal(coerceValue('unknown', 'boolean'), 'unknown');
});

/* ---------- buildTableRow ---------- */

test('buildTableRow maps source headers to sanitised columns + trace metadata', () => {
    const columns = [
        { sourceHeader: 'Name', name: 'Name', type: 'string' as const },
        { sourceHeader: 'Amount', name: 'Amount', type: 'integer' as const },
    ];
    const row = buildTableRow(
        { Name: 'Alice', Amount: '100' },
        columns,
        { importId: 'b1', sourceFile: 'f.csv', sourceRow: 2 },
    );
    assert.deepEqual(row, {
        _row_id: 'b1:2',
        _import_id: 'b1',
        _source_file: 'f.csv',
        _source_row: 2,
        Name: 'Alice',
        Amount: 100,
    });
});

/* ---------- unionSchema ---------- */

test('unionSchema keeps existing types, appends new columns, never drops', () => {
    const existing: TableSchema = {
        name: 't',
        columns: [
            { name: 'a', type: 'integer', primary: true },
            { name: 'b', type: 'string' },
        ],
    };
    const next: TableSchema = {
        name: 't',
        columns: [
            { name: 'a', type: 'float' },  // type conflict — existing wins
            { name: 'c', type: 'float' },  // new column
        ],
    };
    const union = unionSchema(existing, next);
    assert.deepEqual(union.columns, [
        { name: 'a', type: 'integer', primary: true },
        { name: 'b', type: 'string' },
        { name: 'c', type: 'float' },
    ]);
});

console.log('tabularImport — real SQLite');

/* ---------- create + insert + query round-trip ---------- */

test('writeTabularRows creates the table and round-trips typed rows', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const rows = [
            { Name: 'Widget', Qty: '3', Price: '9.99', Active: 'true' },
            { Name: 'Gadget', Qty: '5', Price: '14.50', Active: 'false' },
        ];
        const t = inferTableSchema({ entityType: 'Product', headers: Object.keys(rows[0]), rows });
        const result = await writeTabularRows({
            storage, tableName: t.tableName, schema: t.schema, columns: t.columns, rows,
            importId: 'batch-1', sourceFile: 'widgets.csv',
        });
        assert.equal(result.disposition, 'created');
        assert.equal(result.rowsWritten, 2);

        assert.equal(await storage.count(t.tableName), 2);
        const back = await storage.query(t.tableName);
        assert.equal(back.length, 2);

        const widget = back.find((r) => r.Name === 'Widget')!;
        assert.equal(widget.Qty, 3);
        assert.equal(widget.Price, 9.99);
        assert.equal(widget.Active, true);
        assert.equal(widget._source_file, 'widgets.csv');
        assert.equal(widget._import_id, 'batch-1');
        assert.equal(widget._source_row, 2);
        assert.equal(widget._row_id, 'batch-1:2');

        const gadget = back.find((r) => r.Name === 'Gadget')!;
        assert.equal(gadget.Active, false);
        assert.equal(gadget._source_row, 3);
    } finally {
        tmp.cleanup();
    }
});

test('re-import with a new column evolves additively and preserves old rows', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const first = inferTableSchema({
            entityType: 'Product',
            headers: ['Name', 'Qty'],
            rows: [{ Name: 'Widget', Qty: '3' }],
        });
        await writeTabularRows({
            storage, tableName: first.tableName, schema: first.schema, columns: first.columns,
            rows: [{ Name: 'Widget', Qty: '3' }], importId: 'b1', sourceFile: 'w.csv',
        });

        const second = inferTableSchema({
            entityType: 'Product',
            headers: ['Name', 'Qty', 'Discount'],
            rows: [{ Name: 'Widget', Qty: '3', Discount: '0.1' }],
        });
        const result = await writeTabularRows({
            storage, tableName: second.tableName, schema: second.schema, columns: second.columns,
            rows: [{ Name: 'Widget', Qty: '3', Discount: '0.1' }], importId: 'b2', sourceFile: 'w.csv',
        });

        assert.equal(result.disposition, 'evolved');
        assert.deepEqual(result.addedColumns, ['Discount']);

        assert.equal(await storage.count(second.tableName), 2);
        const back = await storage.query(second.tableName);
        // First row has no Discount → null; second row has 0.1.
        const firstRow = back.find((r) => r._import_id === 'b1')!;
        const secondRow = back.find((r) => r._import_id === 'b2')!;
        assert.equal(firstRow.Discount, null);
        assert.equal(secondRow.Discount, 0.1);
        assert.equal(firstRow.Qty, 3);
    } finally {
        tmp.cleanup();
    }
});

test('re-import with the same shape reuses the table (no evolve)', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const rows = [{ Name: 'Widget', Qty: '3' }];
        const t = inferTableSchema({ entityType: 'Product', headers: ['Name', 'Qty'], rows });
        await writeTabularRows({
            storage, tableName: t.tableName, schema: t.schema, columns: t.columns, rows,
            importId: 'b1', sourceFile: 'w.csv',
        });
        const again = await writeTabularRows({
            storage, tableName: t.tableName, schema: t.schema, columns: t.columns, rows,
            importId: 'b2', sourceFile: 'w.csv',
        });
        assert.equal(again.disposition, 'reused');
        assert.deepEqual(again.addedColumns, []);
        assert.equal(await storage.count(t.tableName), 2);
    } finally {
        tmp.cleanup();
    }
});

test('a value that does not fit a kept column type is preserved, not dropped', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        // First import infers Qty as integer.
        const first = inferTableSchema({
            entityType: 'Product', headers: ['Name', 'Qty'],
            rows: [{ Name: 'Widget', Qty: '3' }],
        });
        await writeTabularRows({
            storage, tableName: first.tableName, schema: first.schema, columns: first.columns,
            rows: [{ Name: 'Widget', Qty: '3' }], importId: 'b1', sourceFile: 'w.csv',
        });
        // Re-import same headers but Qty is now "N/A" → the column keeps its
        // integer type and the raw string must survive (not become null).
        const second = inferTableSchema({
            entityType: 'Product', headers: ['Name', 'Qty'],
            rows: [{ Name: 'Widget', Qty: 'N/A' }],
        });
        await writeTabularRows({
            storage, tableName: second.tableName, schema: second.schema, columns: second.columns,
            rows: [{ Name: 'Widget', Qty: 'N/A' }], importId: 'b2', sourceFile: 'w.csv',
        });
        const back = await storage.query(second.tableName);
        const row = back.find((r) => r._import_id === 'b2')!;
        assert.equal(row.Qty, 'N/A');
    } finally {
        tmp.cleanup();
    }
});

console.log('tabularImport — runImport end-to-end (real SQLite)');

test('runImport writes real rows alongside nodes and reports the table', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const upserted: string[] = [];
        const fakeGraph = {
            getNode: async () => null,
            upsertNode: async (node: Record<string, unknown>) => {
                upserted.push(String(node.id));
                return { id: String(node.id) };
            },
        };
        const deps = {
            store: { tableStorage: storage, loreGraph: fakeGraph },
            detectedScope: { workspace: 'ws', ecosystem: 'x' },
            deploymentMode: 'local' as const,
            dataplane: null,
        } as unknown as Parameters<typeof runImport>[0];
        const body = {
            format: 'csv' as const,
            filename: 'people.csv',
            data: '',
            mapping: { entityType: 'Person', fields: { Name: 'label', Age: 'age' } },
        } as Parameters<typeof runImport>[2];

        const response = await runImport(
            deps,
            Buffer.from('Name,Age\nAlice,30\nBob,25\n', 'utf-8'),
            body,
            fakeGraph as unknown as Parameters<typeof runImport>[3],
            'ws',
        );

        // Node loop unaffected: both rows became nodes.
        assert.equal(response.imported, 2);
        assert.equal(upserted.length, 2);
        // Table write reported + additive.
        assert.equal(response.tableError, undefined);
        assert.ok(response.table, 'expected a table result');
        assert.equal(response.table!.name, 'import_person');
        assert.equal(response.table!.rowsWritten, 2);
        assert.equal(response.table!.disposition, 'created');

        // Real rows land in the queryable table, typed + traced.
        const back = await storage.query('import_person');
        assert.equal(back.length, 2);
        const alice = back.find((r) => r.Name === 'Alice')!;
        assert.equal(alice.Age, 30);
        assert.equal(alice._source_file, 'people.csv');
        assert.equal(alice._import_id, response.table ? (back[0]!._import_id as string) : '');
        // _row_id: without an idColumn mapping, import.ts's recordTableRow
        // (2026-08-17 audit) keys on a content hash of the header-ordered row
        // -- deliberate + documented: makes a re-import of the same file
        // dedupe instead of duplicating every row, which a random-per-import
        // id could never do. Verify against that actual documented scheme,
        // not a hardcoded literal (the hash is stable for this fixture's
        // content but asserting the formula, not a copied string, is what
        // keeps this test meaningful if the fixture ever changes).
        const expectedRowHash = createHash('sha256')
            .update(JSON.stringify(['Alice', '30']))
            .digest('hex')
            .slice(0, 32);
        assert.equal(alice._row_id, `Person:rowhash:${expectedRowHash}`);
    } finally {
        tmp.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
