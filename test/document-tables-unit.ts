#!/usr/bin/env tsx
/**
 * document-tables-unit.ts — Bucket C table-write path (reuses Bucket A).
 *
 * Confirms documentTableEntityType derives stable names, and that
 * writeDocumentTables hands correctly-shaped `{headers, rows}` to
 * tabularImport.ts's inferTableSchema + writeTabularRows (verified by
 * querying the resulting tables back from a real SQLite store — the
 * Collections write path itself is already covered by Bucket A's tests).
 *
 * Run: npx tsx test/document-tables-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import {
    documentTableEntityType,
    writeDocumentTables,
} from '../packages/lore/src/engines/documentTables.js';
import type { DetectedTable } from '../packages/lore/src/engines/extractors/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

function mkTmp(): { dbPath: string; cachePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-doc-tables-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cachePath: path.join(dir, 'schemas.json'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

console.log('documentTableEntityType');

test('derives a stable entity type from file name + position', () => {
    assert.equal(documentTableEntityType('report.docx', 1), 'report_table_1');
    assert.equal(documentTableEntityType('/path/to/My Report.docx', 2), 'My_Report_table_2');
    assert.equal(documentTableEntityType('notes.pdf', 3), 'notes_table_3');
    // empty / pathological names fall back to 'document'
    assert.equal(documentTableEntityType('.docx', 1), 'document_table_1');
});

console.log('writeDocumentTables — real SQLite');

const table1: DetectedTable = {
    headers: ['Name', 'Amount'],
    rows: [{ Name: 'Alice', Amount: '100' }, { Name: 'Bob', Amount: '250' }],
    position: 1,
    confidence: 1.0,
};
const table2: DetectedTable = {
    headers: ['Product', 'Qty'],
    rows: [{ Product: 'Widget', Qty: '3' }],
    position: 2,
    confidence: 0.9,
};

test('writes each detected table into its own named collection', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const result = await writeDocumentTables({
            storage,
            sourceName: 'report.docx',
            tables: [table1, table2],
        });
        assert.equal(result.written, 2);
        assert.deepEqual(result.tableNames, ['import_report_table_1', 'import_report_table_2']);
        assert.equal(result.rows, 3); // 2 + 1

        const t1 = await storage.query('import_report_table_1');
        assert.equal(t1.length, 2);
        assert.equal(t1.find((r) => r.Name === 'Alice')!.Amount, 100); // inferred integer
        assert.equal(t1[0]!._source_file, 'report.docx');

        const t2 = await storage.query('import_report_table_2');
        assert.equal(t2.length, 1);
        assert.equal(t2[0]!.Product, 'Widget');
        assert.equal(t2[0]!.Qty, 3);
    } finally {
        tmp.cleanup();
    }
});

test('an empty tables array writes nothing', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const result = await writeDocumentTables({ storage, sourceName: 'x.docx', tables: [] });
        assert.deepEqual(result, { written: 0, tableNames: [], rows: 0 });
    } finally {
        tmp.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
