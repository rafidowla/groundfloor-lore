#!/usr/bin/env tsx
/**
 * pdf-tables-unit.ts — Bucket C PDF table detection (the geometric
 * heuristic). Pure — operates on synthetic positional text items, so no PDF
 * library and no fixture file is needed to exercise the algorithm.
 *
 * Run: npx tsx test/extractors/pdf-tables-unit.ts
 */

import assert from 'node:assert/strict';
import {
    extractPdfTextItems,
    groupPdfTextItemsIntoLines,
    splitLineIntoCells,
    detectPdfTables,
    type PdfTextItem,
} from '../../packages/lore/src/engines/extractors/pdfTables.js';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}

/** Make a text item at a given (x, y) with a default width/height. */
function item(str: string, x: number, y: number, over: Partial<PdfTextItem> = {}): PdfTextItem {
    return { str, x, y, width: 50, height: 10, ...over };
}

// A clean 3-column × 3-row grid: headers at y=800, two data rows below.
const GRID: PdfTextItem[] = [
    item('Name', 100, 800), item('Qty', 200, 800), item('Price', 300, 800),
    item('Widget', 100, 770), item('3', 200, 770), item('9.99', 300, 770),
    item('Gadget', 100, 740), item('5', 200, 740), item('14.50', 300, 740),
];

console.log('extractPdfTextItems / line grouping');

test('extractPdfTextItems keeps positional data and skips non-string items', () => {
    const items = extractPdfTextItems({
        items: [
            { str: 'a', transform: [1, 0, 0, 1, 10, 20], width: 5, height: 8 },
            { str: '   ' },
            { transform: [1, 0, 0, 1, 99, 99] }, // no str
            'garbage',
        ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.x, 10);
    assert.equal(items[0]!.y, 20);
});

test('groupPdfTextItemsIntoLines clusters by Y into top-to-bottom order', () => {
    const lines = groupPdfTextItemsIntoLines(GRID);
    assert.equal(lines.length, 3); // three distinct y bands
    assert.deepEqual(lines.map((l) => l.items.map((i) => i.str).join(',')), [
        'Name,Qty,Price',
        'Widget,3,9.99',
        'Gadget,5,14.50',
    ]);
    // items within a line are x-ascending
    assert.deepEqual(lines[0]!.items.map((i) => i.x), [100, 200, 300]);
});

console.log('splitLineIntoCells');

test('splits a line on horizontal gaps larger than the threshold', () => {
    const line = { y: 800, items: [item('Name', 100, 800), item('Qty', 200, 800)] };
    const cells = splitLineIntoCells(line, 15); // gap 50 > 15
    assert.deepEqual(cells.map((c) => c.text), ['Name', 'Qty']);
});

test('keeps adjacent items in one cell when the gap is small', () => {
    const line = { y: 800, items: [item('John', 100, 800, { width: 40 }), item('Smith', 143, 800)] };
    const cells = splitLineIntoCells(line, 15); // gap 3 < 15
    assert.deepEqual(cells.map((c) => c.text), ['John Smith']);
});

console.log('detectPdfTables — clean grid');

test('detects a clean grid with confidence 1.0', () => {
    const tables = detectPdfTables(GRID);
    assert.equal(tables.length, 1);
    const t = tables[0]!;
    assert.deepEqual(t.headers, ['Name', 'Qty', 'Price']);
    assert.deepEqual(t.rows, [
        { Name: 'Widget', Qty: '3', Price: '9.99' },
        { Name: 'Gadget', Qty: '5', Price: '14.50' },
    ]);
    assert.equal(t.position, 1);
    assert.equal(t.confidence, 1.0);
});

test('detects no table from prose (no column structure)', () => {
    const prose: PdfTextItem[] = [
        item('This is a long paragraph of prose text', 100, 800),
        item('that has no column boundaries at all', 100, 770),
        item('and just flows across the page width', 100, 740),
    ];
    assert.deepEqual(detectPdfTables(prose), []);
});

test('detects no table from a single line of data', () => {
    assert.deepEqual(detectPdfTables([item('a', 100, 800), item('b', 200, 800)]), []);
});

test('lower confidence when rows have inconsistent column counts', () => {
    const ragged: PdfTextItem[] = [
        item('Name', 100, 800), item('Qty', 200, 800), item('Price', 300, 800),
        item('Widget', 100, 770), item('3', 200, 770), item('9.99', 300, 770),
        item('Gadget', 100, 740), item('5', 200, 740), // missing Price cell
        item('Cog', 100, 710), item('7', 200, 710), item('3.50', 300, 710),
    ];
    const tables = detectPdfTables(ragged);
    assert.equal(tables.length, 1);
    // 3 of 4 rows have the modal (3) column count → confidence 0.75
    assert.equal(tables[0]!.confidence, 0.75);
    // the ragged row's missing cell is padded to ''
    assert.deepEqual(tables[0]!.rows[1], { Name: 'Gadget', Qty: '5', Price: '' });
});

test('two separated tables are detected as two tables', () => {
    const two: PdfTextItem[] = [
        // first table (2 rows)
        item('A', 100, 800), item('B', 200, 800),
        item('1', 100, 770), item('2', 200, 770),
        // prose gap (single column)
        item('Some text between the tables', 100, 720),
        // second table (2 rows)
        item('X', 100, 680), item('Y', 200, 680),
        item('9', 100, 650), item('8', 200, 650),
    ];
    const tables = detectPdfTables(two);
    assert.equal(tables.length, 2);
    assert.equal(tables[0]!.position, 1);
    assert.equal(tables[1]!.position, 2);
    assert.deepEqual(tables[0]!.headers, ['A', 'B']);
    assert.deepEqual(tables[1]!.headers, ['X', 'Y']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
