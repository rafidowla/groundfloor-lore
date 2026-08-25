#!/usr/bin/env tsx
/**
 * import-routes-unit.ts — drive the pure helpers (parseCsv, buildNode)
 * out of the bulk-ingest route. No HTTP plumbing — that's covered by
 * type-checking and a future integration test once a daemon test
 * harness exists.
 *
 * Covers MX1 (2026-05-15).
 */

import assert from 'node:assert/strict';
import { parseCsv, parseXlsx, parseJson, buildNode, type ImportMapping } from '../packages/lore/src/mcp/http/routes/import.js';
import ExcelJS from 'exceljs';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const csv = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf-8');

(async () => {
    console.log('parseCsv');

    await test('extracts headers + rows from a small CSV', () => {
        const buf = csv(['id,name,city', '1,Alpha,NYC', '2,Beta,SF']);
        const { headers, rows } = parseCsv(buf);
        assert.deepEqual(headers, ['id', 'name', 'city']);
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.name, 'Alpha');
        assert.equal(rows[1]!.city, 'SF');
    });

    await test('handles trailing newline + empty lines', () => {
        const buf = csv(['id,name', '1,Alpha', '', '2,Beta', '']);
        const { rows } = parseCsv(buf);
        assert.equal(rows.length, 2);
    });

    await test('trims whitespace in headers + values', () => {
        const buf = csv(['  id  , name  ', '  1 , Alpha ']);
        const { headers, rows } = parseCsv(buf);
        assert.deepEqual(headers, ['id', 'name']);
        assert.equal(rows[0]!.name, 'Alpha');
    });

    console.log('parseXlsx');

    await test('extracts headers + rows from an in-memory XLSX workbook', async () => {
        const wb = new ExcelJS.Workbook();
        const sheet = wb.addWorksheet('Sheet1');
        sheet.addRow(['id', 'name', 'city']);
        sheet.addRow([1, 'Alpha', 'NYC']);
        sheet.addRow([2, 'Beta', 'SF']);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        const { headers, rows } = await parseXlsx(buf);
        assert.deepEqual(headers, ['id', 'name', 'city']);
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.name, 'Alpha');
        assert.equal(rows[1]!.city, 'SF');
    });

    await test('parseXlsx skips fully-empty rows', async () => {
        const wb = new ExcelJS.Workbook();
        const sheet = wb.addWorksheet('Sheet1');
        sheet.addRow(['id', 'name']);
        sheet.addRow([1, 'Alpha']);
        sheet.addRow([]);   // empty
        sheet.addRow([2, 'Beta']);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        const { rows } = await parseXlsx(buf);
        assert.equal(rows.length, 2);
    });

    console.log('parseJson');

    await test('parses a JSON array of objects', () => {
        const buf = Buffer.from(JSON.stringify([
            { id: 1, name: 'Alpha', tags: ['a', 'b'] },
            { id: 2, name: 'Beta', notes: { rating: 5 } },
        ]));
        const { headers, rows } = parseJson(buf, 'json');
        // Headers are union, sorted.
        assert.deepEqual(headers, ['id', 'name', 'notes', 'tags']);
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.name, 'Alpha');
        // Nested objects/arrays get stringified.
        assert.equal(rows[0]!.tags, '["a","b"]');
        assert.equal(rows[1]!.notes, '{"rating":5}');
        // Missing keys become empty strings.
        assert.equal(rows[0]!.notes, '');
    });

    await test('parses JSONL — one object per line', () => {
        const buf = Buffer.from(
            '{"id":1,"name":"Alpha"}\n' +
            '\n' +
            '{"id":2,"name":"Beta"}\n',
        );
        const { headers, rows } = parseJson(buf, 'jsonl');
        assert.deepEqual(headers, ['id', 'name']);
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.name, 'Beta');
    });

    await test('JSON rejects non-array top level', () => {
        const buf = Buffer.from(JSON.stringify({ id: 1 }));
        assert.throws(() => parseJson(buf, 'json'), /top-level array/);
    });

    console.log('buildNode');

    // Contract reminder: anything not in RESERVED_TARGETS (id/label/content/
    // tags/project) lands under `metadata.<target>` automatically. Don't
    // prefix targets with 'metadata.' — the route does that for you.
    const mapping = (overrides: Partial<ImportMapping> = {}): ImportMapping => ({
        entityType: 'cre_property',
        idColumn: 'property_id',
        fields: {
            address: 'label',
            owner: 'owner',
            year_built: 'year_built',
        },
        ...overrides,
    });

    await test('builds a node with id prefixed by entityType', () => {
        const r = buildNode(
            { property_id: 'P-001', address: '123 Main', owner: 'Acme', year_built: '1972' },
            mapping(),
            'project-a',
            0,
        );
        assert.ok(!('error' in r));
        const node = (r as { node: Record<string, unknown> }).node;
        assert.equal(node.id, 'cre_property:P-001');
        assert.equal(node.type, 'cre_property');
        assert.equal(node.label, '123 Main');
        assert.equal(node.project, 'project-a');
    });

    await test('reserved targets land on the node, others go to metadata JSON', () => {
        const r = buildNode(
            { property_id: 'P-001', address: '123 Main', owner: 'Acme', year_built: '1972' },
            mapping(),
            'project-a',
            0,
        );
        assert.ok(!('error' in r));
        const node = (r as { node: Record<string, unknown> }).node;
        // 'owner' is not reserved → metadata.owner
        // 'year_built' uses dotted path → metadata.year_built
        const meta = JSON.parse(node.metadata as string);
        assert.equal(meta.owner, 'Acme');
        assert.equal(meta.year_built, '1972');
        // address mapped to 'label' (reserved) is on the node directly
        assert.equal(node.label, '123 Main');
    });

    await test('errors when idColumn value is empty', () => {
        const r = buildNode(
            { property_id: '', address: '123 Main' },
            mapping(),
            'project-a',
            0,
        );
        assert.ok('error' in r);
        const err = (r as { error: { row: number; column: string; message: string } }).error;
        assert.equal(err.row, 2); // 1-indexed + header offset
        assert.equal(err.column, 'property_id');
        assert.match(err.message, /empty/);
    });

    await test('synthesises an id when idColumn is not configured', () => {
        const r = buildNode(
            { address: '123 Main' },
            mapping({ idColumn: undefined, fields: { address: 'label' } }),
            'project-a',
            0,
        );
        assert.ok(!('error' in r));
        const node = (r as { node: Record<string, unknown> }).node;
        assert.match(String(node.id), /^cre_property:0_\d+_/);
    });

    await test('falls back to id for label when label is not mapped', () => {
        const r = buildNode(
            { property_id: 'P-001' },
            mapping({ fields: { property_id: 'id' } }),
            'project-a',
            0,
        );
        assert.ok(!('error' in r));
        const node = (r as { node: Record<string, unknown> }).node;
        assert.equal(node.label, 'cre_property:P-001');
    });

    await test('user-extension dotted path lands under metadata.extensions', () => {
        const r = buildNode(
            { property_id: 'P-001', renewal: 'auto' },
            mapping({
                fields: {
                    property_id: 'id',
                    renewal: 'extensions.renewal_clause',
                },
            }),
            'project-a',
            0,
        );
        assert.ok(!('error' in r));
        const node = (r as { node: Record<string, unknown> }).node;
        const meta = JSON.parse(node.metadata as string);
        assert.equal(meta.extensions.renewal_clause, 'auto');
    });

    // L-015 — prototype-pollution guard on the attacker-controlled dotted
    // field-mapping target. A target naming __proto__/prototype/constructor
    // as ANY segment is rejected as an ImportRowError (row dropped, no node),
    // and Object.prototype is never mutated.
    await test('L-015: __proto__.polluted target is rejected and does not pollute Object.prototype', () => {
        const r = buildNode(
            { property_id: 'P-001', renewal: 'auto' },
            mapping({ fields: { property_id: 'id', renewal: '__proto__.polluted' } }),
            'project-a',
            0,
        );
        assert.ok('error' in r, 'must return an error, not a node');
        const err = (r as { error: { row: number; column: string; message: string } }).error;
        assert.match(err.message, /forbidden/);
        assert.equal(err.column, 'renewal');
        // Prove the global prototype is untouched.
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });

    await test('L-015: constructor.prototype.polluted target is rejected and does not pollute', () => {
        const r = buildNode(
            { property_id: 'P-001', renewal: 'auto' },
            mapping({ fields: { property_id: 'id', renewal: 'constructor.prototype.polluted' } }),
            'project-a',
            0,
        );
        assert.ok('error' in r, 'must return an error, not a node');
        assert.match((r as { error: { message: string } }).error.message, /forbidden/);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });

    await test('L-015: benign deep dotted path (extensions.a.b) still succeeds (regression guard)', () => {
        const r = buildNode(
            { property_id: 'P-001', deep: 'value' },
            mapping({ fields: { property_id: 'id', deep: 'extensions.a.b' } }),
            'project-a',
            0,
        );
        assert.ok(!('error' in r), 'benign nested path must not be rejected');
        const node = (r as { node: Record<string, unknown> }).node;
        const meta = JSON.parse(node.metadata as string);
        assert.equal(meta.extensions.a.b, 'value');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
