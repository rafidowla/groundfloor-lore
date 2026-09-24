#!/usr/bin/env tsx
/**
 * pdf-extract-real-unit.ts — drives `pdfExtractor.extract()` through the real
 * pdfjs-dist on generated PDFs (3.22.3, pdfjs-dist 5 → 6).
 *
 * pdf-tables-unit.ts covers the table heuristic on synthetic text items only;
 * nothing else loads pdfjs-dist, so a major bump could break extraction
 * (entry point, getDocument options, getTextContent / getMetadata shapes)
 * with every test still green. This pins, end to end:
 *   - multi-page text extraction + pageCount
 *   - Info-dictionary metadata (Title / Author)
 *   - positional items reaching table detection (a 3×3 grid → 1 table)
 *   - a PDF with an /OpenAction JavaScript action extracts as plain text
 *   - empty / corrupt inputs map to ExtractorError codes
 *
 * PDFs are built in-test (hand-written objects + a computed xref), so no
 * fixture file is needed.
 *
 * Run: npx tsx test/extractors/pdf-extract-real-unit.ts
 */

import assert from 'node:assert/strict';
import { pdfExtractor } from '../../packages/lore/src/engines/extractors/pdf.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

/** Text runs for one page: [x, y, text]. */
type Run = [number, number, string];

function buildPdf(pages: Run[][], opts: { info?: Record<string, string>; openActionJs?: string } = {}): Buffer {
    const objs: string[] = [];
    const add = (body: string): number => { objs.push(body); return objs.length; };

    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pagesId = objs.length + 1 + pages.length * 2; // reserved below
    const pageIds: number[] = [];
    for (const runs of pages) {
        const esc = (s: string) => s.replace(/([\\()])/g, '\\$1');
        const stream = runs.map(([x, y, t]) => `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${esc(t)}) Tj ET`).join('\n');
        const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
        pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    const pagesObj = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    assert.equal(pagesObj, pagesId);
    let openAction = '';
    if (opts.openActionJs) {
        const js = add(`<< /Type /Action /S /JavaScript /JS (${opts.openActionJs}) >>`);
        openAction = ` /OpenAction ${js} 0 R`;
    }
    const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R${openAction} >>`);
    const info = opts.info
        ? add(`<< ${Object.entries(opts.info).map(([k, v]) => `/${k} (${v})`).join(' ')} >>`)
        : 0;

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}

console.log('pdfExtractor on real PDFs');

await test('multi-page text + pageCount + Info metadata', async () => {
    const pdf = buildPdf(
        [[[72, 700, 'Quarterly report alpha']], [[72, 700, 'Second page beta']]],
        { info: { Title: 'Lore PDF Test', Author: 'r3223' } },
    );
    const r = await pdfExtractor.extract(pdf, 'application/pdf');
    assert.match(r.text, /Quarterly report alpha/);
    assert.match(r.text, /Second page beta/);
    assert.ok(r.text.indexOf('alpha') < r.text.indexOf('beta'), 'page order kept');
    const m = r.metadata as Record<string, unknown>;
    assert.equal(m.pageCount, 2);
    assert.equal(m.title, 'Lore PDF Test');
    assert.equal(m.author, 'r3223');
});

await test('positional items reach table detection (3x3 grid)', async () => {
    const grid: Run[] = [
        [100, 700, 'Name'], [250, 700, 'Qty'], [400, 700, 'Price'],
        [100, 670, 'Widget'], [250, 670, '3'], [400, 670, '9.99'],
        [100, 640, 'Gadget'], [250, 640, '5'], [400, 640, '14.50'],
    ];
    const r = await pdfExtractor.extract(buildPdf([grid]), 'application/pdf');
    const tables = (r as { tables?: Array<{ headers: string[]; rows: Array<Record<string, string>> }> }).tables ?? [];
    assert.equal(tables.length, 1, `expected 1 table, got ${tables.length}`);
    assert.deepEqual(tables[0]!.headers, ['Name', 'Qty', 'Price']);
    assert.equal(tables[0]!.rows.length, 2);
});

await test('PDF with a JavaScript OpenAction extracts as plain text', async () => {
    (globalThis as Record<string, unknown>).__r3223_pdf_js_ran = undefined;
    const pdf = buildPdf([[[72, 700, 'Scripted doc text']]], { openActionJs: 'globalThis.__r3223_pdf_js_ran = 1' });
    const r = await pdfExtractor.extract(pdf, 'application/pdf');
    assert.match(r.text, /Scripted doc text/);
    assert.equal((globalThis as Record<string, unknown>).__r3223_pdf_js_ran, undefined, 'embedded JS must not run');
});

await test('empty input → ExtractorError(empty)', async () => {
    await assert.rejects(pdfExtractor.extract(Buffer.alloc(0), 'application/pdf'),
        (e: unknown) => e instanceof ExtractorError && (e as ExtractorError & { code: string }).code === 'empty');
});

await test('corrupt input → ExtractorError(corrupt)', async () => {
    await assert.rejects(pdfExtractor.extract(Buffer.from('not a pdf at all'), 'application/pdf'),
        (e: unknown) => e instanceof ExtractorError && (e as ExtractorError & { code: string }).code === 'corrupt');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
