/**
 * test/extractors/xlsx.test.ts
 * Run: tsx test/extractors/xlsx.test.ts
 */

import * as assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { xlsxExtractor } from '../../packages/lore/src/engines/extractors/xlsx.js';
import { buildDefaultRegistry } from '../../packages/lore/src/engines/extractors/index.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────

async function makeWorkbook(cb: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    cb(wb);
    const arr = await wb.xlsx.writeBuffer();
    return Buffer.from(arr);
}

// ── xlsxExtractor.extract() ───────────────────────────────────────────────

async function testEmptyBuffer(): Promise<void> {
    await assert.rejects(
        () => xlsxExtractor.extract(Buffer.alloc(0), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        (err: unknown) => err instanceof ExtractorError && err.code === 'empty',
    );
    console.log('  ✓ empty buffer throws ExtractorError("empty")');
}

async function testSingleSheet(): Promise<void> {
    const buf = await makeWorkbook((wb) => {
        const ws = wb.addWorksheet('Data');
        ws.addRow(['Name', 'Score']);
        ws.addRow(['Alice', 95]);
        ws.addRow(['Bob', 82]);
    });

    const result = await xlsxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    assert.ok(result.text.includes('Name'), 'header row preserved');
    assert.ok(result.text.includes('Alice'), 'data row 1 preserved');
    assert.ok(result.text.includes('Bob'), 'data row 2 preserved');
    assert.ok(result.text.includes('95'), 'numeric value preserved');
    assert.ok(result.text.includes('Score'), 'Score column preserved');
    assert.equal(result.metadata.sheetCount, 1, 'sheetCount = 1');
    assert.equal(result.confidence, 1.0, 'confidence 1.0');
    console.log('  ✓ single sheet — text, numbers, header');
}

async function testMultipleSheets(): Promise<void> {
    const buf = await makeWorkbook((wb) => {
        const ws1 = wb.addWorksheet('Q1');
        ws1.addRow(['Revenue', 1000]);
        const ws2 = wb.addWorksheet('Q2');
        ws2.addRow(['Revenue', 1200]);
    });

    const result = await xlsxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    assert.ok(result.text.includes('Sheet: Q1'), 'Q1 sheet heading present');
    assert.ok(result.text.includes('Sheet: Q2'), 'Q2 sheet heading present');
    assert.ok(result.text.includes('Revenue'), 'Revenue label in output');
    assert.equal(result.metadata.sheetCount, 2, 'sheetCount = 2');
    console.log('  ✓ multiple sheets — each section labeled');
}

async function testDateCell(): Promise<void> {
    const buf = await makeWorkbook((wb) => {
        const ws = wb.addWorksheet('Sheet1');
        const d = new Date('2024-03-15');
        ws.addRow(['Event', d]);
    });

    const result = await xlsxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(result.text.includes('Event'), 'label preserved');
    // Date should appear as ISO-like string
    assert.ok(result.text.includes('2024'), 'year in output');
    console.log('  ✓ date cell rendered as ISO string');
}

async function testRichTextCell(): Promise<void> {
    const buf = await makeWorkbook((wb) => {
        const ws = wb.addWorksheet('Sheet1');
        ws.addRow([{
            richText: [
                { text: 'Hello' },
                { text: ' World' },
            ],
        }]);
    });

    const result = await xlsxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(result.text.includes('Hello'), 'richText part 1 preserved');
    assert.ok(result.text.includes('World'), 'richText part 2 preserved');
    console.log('  ✓ rich-text cell concatenated correctly');
}

async function testSheetMetadata(): Promise<void> {
    const buf = await makeWorkbook((wb) => {
        const ws = wb.addWorksheet('Summary');
        ws.addRow(['Col A', 'Col B', 'Col C']);
        ws.addRow([1, 2, 3]);
        ws.addRow([4, 5, 6]);
    });

    const result = await xlsxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sheets = result.metadata.sheets as Array<{ name: string; rows: number; cols: number }>;
    assert.equal(sheets.length, 1, 'one sheet summary');
    assert.equal(sheets[0].name, 'Summary', 'sheet name recorded');
    assert.equal(sheets[0].rows, 3, 'row count = 3');
    assert.equal(sheets[0].cols, 3, 'col count = 3');
    console.log('  ✓ sheet metadata (name, rows, cols)');
}

async function testTabSeparatedColumns(): Promise<void> {
    const buf = await makeWorkbook((wb) => {
        const ws = wb.addWorksheet('Sheet1');
        ws.addRow(['Apple', 'Banana', 'Cherry']);
    });

    const result = await xlsxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const line = result.text.split('\n').find(l => l.includes('Apple'));
    assert.ok(line, 'line with Apple found');
    assert.ok(line!.includes('\t'), 'columns separated by tab');
    console.log('  ✓ columns tab-separated');
}

// ── Registry wiring ───────────────────────────────────────────────────────

function testRegistryWiring(): void {
    const registry = buildDefaultRegistry();

    assert.equal(
        registry.mimeFromPath('budget.xlsx'),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xlsx MIME type',
    );
    assert.equal(
        registry.mimeFromPath('old.xls'),
        'application/vnd.ms-excel',
        '.xls MIME type',
    );
    assert.equal(
        registry.mimeFromPath('sheet.ods'),
        'application/vnd.oasis.opendocument.spreadsheet',
        '.ods MIME type',
    );

    const extractor = registry.findByMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(extractor, 'xlsx extractor registered');
    assert.equal(extractor?.name, 'xlsx', 'correct extractor name');

    console.log('  ✓ registry wiring — .xlsx, .xls, .ods');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('xlsx extractor tests');

    console.log('\nxlsxExtractor');
    await testEmptyBuffer();
    await testSingleSheet();
    await testMultipleSheets();
    await testDateCell();
    await testRichTextCell();
    await testSheetMetadata();
    await testTabSeparatedColumns();

    console.log('\nregistry');
    testRegistryWiring();

    console.log('\nAll xlsx extractor tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
