#!/usr/bin/env tsx
/**
 * docx-tables-unit.ts — Bucket C DOCX table detection.
 *
 * Two layers:
 *   1. extractHtmlTables — the pure HTML→{headers,rows} parser, tested
 *      against a known mammoth-style HTML string (zero deps, zero API).
 *   2. docxExtractor.extract — the full extractor, fed a real in-memory
 *      .docx fixture (built with JSZip, the same way import-routes-unit.ts
 *      builds an in-memory XLSX). Confirms tables are detected AND the
 *      flattened text output is still produced unchanged.
 *
 * Run: npx tsx test/extractors/docx-tables-unit.ts
 */

import assert from 'node:assert/strict';
import { extractHtmlTables } from '../../packages/lore/src/engines/extractors/htmlTables.js';
import { docxExtractor } from '../../packages/lore/src/engines/extractors/docx.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('extractHtmlTables — pure');

test('extracts a single table with a header row', () => {
    const html =
        '<p>Intro</p>' +
        '<table><tr><td><p>Name</p></td><td><p>Age</p></td></tr>' +
        '<tr><td><p>Alice</p></td><td><p>30</p></td></tr>' +
        '<tr><td><p>Bob</p></td><td><p>25</p></td></tr></table>' +
        '<p>Outro</p>';
    const tables = extractHtmlTables(html);
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0]!.headers, ['Name', 'Age']);
    assert.deepEqual(tables[0]!.rows, [
        { Name: 'Alice', Age: '30' },
        { Name: 'Bob', Age: '25' },
    ]);
    assert.equal(tables[0]!.position, 1);
    assert.equal(tables[0]!.confidence, 1.0);
});

test('decodes entities and strips inline markup within cells', () => {
    const html =
        '<table><tr><td><p><strong>Item &amp; Cost</strong></p></td></tr>' +
        '<tr><td><p>Tom&#39;s &amp; &lt;gadget&gt;</p></td></tr></table>';
    const tables = extractHtmlTables(html);
    assert.equal(tables[0]!.headers[0], "Item & Cost");
    assert.equal(tables[0]!.rows[0]!["Item & Cost"], "Tom's & <gadget>");
});

test('extracts multiple tables in document order', () => {
    const html =
        '<table><tr><td><p>A</p></td></tr><tr><td><p>1</p></td></tr></table>' +
        '<p>middle</p>' +
        '<table><tr><td><p>B</p></td></tr><tr><td><p>2</p></td></tr></table>';
    const tables = extractHtmlTables(html);
    assert.equal(tables.length, 2);
    assert.equal(tables[0]!.position, 1);
    assert.equal(tables[1]!.position, 2);
    assert.equal(tables[0]!.headers[0], 'A');
    assert.equal(tables[1]!.headers[0], 'B');
});

test('returns [] for HTML with no table', () => {
    assert.deepEqual(extractHtmlTables('<p>Just prose.</p>'), []);
    assert.deepEqual(extractHtmlTables(''), []);
});

console.log('docxExtractor — real in-memory DOCX fixture');

/** Build a minimal, valid OOXML .docx containing one 2-column table. */
async function makeDocx(): Promise<Buffer> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    );
    zip.file(
        '_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Bob</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>250</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>End of report.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`,
    );
    return await zip.generateAsync({ type: 'nodebuffer' });
}

test('docxExtractor detects the table AND keeps the flattened text', async () => {
    const buf = await makeDocx();
    const extracted = await docxExtractor.extract(buf, DOCX_MIME);

    // Flattened text unchanged — still contains the prose + table text.
    assert.ok(extracted.text.includes('Quarterly report'), extracted.text);
    assert.ok(extracted.text.includes('Alice'), extracted.text);

    // The table is detected as a structural read (confidence 1.0).
    assert.ok(extracted.tables, 'expected tables');
    assert.equal(extracted.tables!.length, 1);
    const t = extracted.tables![0]!;
    assert.deepEqual(t.headers, ['Name', 'Amount']);
    assert.deepEqual(t.rows, [
        { Name: 'Alice', Amount: '100' },
        { Name: 'Bob', Amount: '250' },
    ]);
    assert.equal(t.confidence, 1.0);
});

test('a DOCX with no table yields no tables (not a false positive)', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    );
    zip.file(
        '_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Just a paragraph, no table here.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`,
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const extracted = await docxExtractor.extract(buf, DOCX_MIME);
    assert.ok(!extracted.tables || extracted.tables.length === 0);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
