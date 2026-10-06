/**
 * test/extractors/xlsx-parity.test.ts
 * Run: tsx test/extractors/xlsx-parity.test.ts
 *
 * Permanent regression test for the exceljs -> read-excel-file swap. Runs the
 * frozen ExcelJS implementation (test/extractors/xlsx-oracle-exceljs.ts) and the
 * production extractor over the same fixtures and asserts:
 *   - identical text + metadata + quality for every shape EXCEPT the documented
 *     differences in KNOWN_DIFFERENCES (each pinned to its exact old and new text);
 *   - identical /api/import header/rows for the same fixtures;
 *   - the non-output behaviours: error classes for encrypted / corrupt /
 *     truncated / non-zip input, zip-bomb refusal before parsing, the dense-grid
 *     memory guard, the text cap, and .xlsm.
 */
import * as assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { exceljsOracleExtractor, parseXlsxOracle } from './xlsx-oracle-exceljs.js';
import { xlsxExtractor } from '../../packages/lore/src/engines/extractors/xlsx.js';
import { loadWorkbook, sheetsToTable } from '../../packages/lore/src/engines/extractors/xlsxRead.js';
import { MAX_ENTRY_BYTES } from '../../packages/lore/src/engines/extractors/zipGuard.js';
import { MAX_EXTRACTED_TEXT_BYTES } from '../../packages/lore/src/engines/extractors/textCap.js';

const M = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
type Cb = (wb: ExcelJS.Workbook) => void;
const build = async (cb: Cb): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook(); cb(wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
};
/** Rewrite a part of the workbook zip (to craft shapes ExcelJS will not write). */
async function patch(buf: Buffer, part: string, fn: (xml: string) => string): Promise<Buffer> {
    const zip = await JSZip.loadAsync(buf);
    zip.file(part, fn(await zip.file(part)!.async('string')));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const S = (v: unknown) => v as never;

interface Case { name: string; buf: () => Promise<Buffer> }
const cases: Case[] = [];
const add = (name: string, buf: () => Promise<Buffer>) => cases.push({ name, buf });
const sheet1 = (name: string, cb: (ws: ExcelJS.Worksheet) => void) => add(name, () => build((wb) => cb(wb.addWorksheet('S1'))));

sheet1('plain strings and numbers', (ws) => { ws.addRow(['Name', 'Score']); ws.addRow(['Alice', 95]); ws.addRow(['Bob', 82.5]); });
sheet1('numeric extremes', (ws) => ws.addRow([0, -0.5, 1e21, 1e-7, 123456789012345678, 0.1 + 0.2, 1.7976931348623157e308, 5e-324, -1, 1e15, 100, 12345.6789]));
sheet1('booleans', (ws) => ws.addRow([true, false, 'true']));
sheet1('dates / datetimes (no explicit numFmt)', (ws) => { ws.addRow([new Date('2024-03-15T00:00:00Z'), new Date('2024-03-15T13:45:10Z'), new Date('1900-03-01T00:00:00Z'), new Date('1970-01-01T00:00:00Z'), new Date('2099-12-31T23:59:59Z')]); });
sheet1('dates with explicit formats', (ws) => {
    for (const [i, fmt] of ['yyyy-mm-dd', 'dd/mm/yyyy', 'mm-dd-yy', 'd-mmm-yy', 'h:mm', 'h:mm:ss AM/PM', 'm/d/yy h:mm', '[$-409]mmmm d, yyyy', 'yyyy-mm-dd hh:mm:ss', 'mmm-yy', '@', 'General'].entries()) {
        const c = ws.getCell(i + 1, 1); c.value = 45366.5; c.numFmt = fmt;
    }
});
sheet1('numbers formatted as numbers (percent/currency/sci/fraction/text)', (ws) => {
    const f: Array<[number, string]> = [[0.07, '0.00%'], [1234.5, '$#,##0.00'], [1234.5, '#,##0'], [0.000123, '0.00E+00'], [0.75, '# ?/?'], [42, '@'], [42, '0000'], [-5, '0;[Red]-0'], [12, '"x"0']];
    f.forEach(([v, n], i) => { const c = ws.getCell(i + 1, 1); c.value = v; c.numFmt = n; });
});
add('1904 date system', async () => {
    const b = await build((wb) => { wb.properties.date1904 = true; wb.addWorksheet('S1').addRow([new Date('2024-03-15T00:00:00Z'), new Date('1904-01-01T00:00:00Z')]); });
    return b;
});
sheet1('formulas with cached results', (ws) => {
    ws.getCell('A1').value = S({ formula: 'A2', result: 42 });
    ws.getCell('B1').value = S({ formula: 'A2', result: 'cached' });
    ws.getCell('C1').value = S({ formula: 'A2', result: true });
    ws.getCell('D1').value = S({ formula: 'A2', result: 3.5 });
    ws.getCell('E1').value = S({ formula: 'A2', result: new Date('2024-03-15T00:00:00Z') });
    ws.getCell('F1').value = S({ sharedFormula: 'A1', result: 7 });
    ws.getCell('A2').value = 'src';
});
sheet1('formula errors and formula with NO cached result', (ws) => {
    ws.getCell('A1').value = S({ formula: '1/0', result: { error: '#DIV/0!' } });
    ws.getCell('B1').value = S({ formula: 'NA()', result: { error: '#N/A' } });
    ws.getCell('C1').value = S({ formula: 'A9' });
    ws.getCell('D1').value = 'after';
});
sheet1('plain error values', (ws) => { ws.getCell('A1').value = S({ error: '#N/A' }); ws.getCell('B1').value = S({ error: '#DIV/0!' }); ws.getCell('C1').value = 'x'; });
sheet1('rich text', (ws) => { ws.getCell('A1').value = S({ richText: [{ text: 'bold ', font: { bold: true } }, { text: 'plain' }, { text: ' red', font: { color: { argb: 'FFFF0000' } } }] }); });
sheet1('hyperlinks', (ws) => {
    ws.getCell('A1').value = S({ text: 'Example', hyperlink: 'https://example.com/a?b=c' });
    ws.getCell('B1').value = S({ text: 'mail', hyperlink: 'mailto:x@y.z' });
    ws.getCell('C1').value = 'https://plain.example.com';
});
add('inline strings (t="inlineStr")', async () => {
    const b = await build((wb) => { const ws = wb.addWorksheet('S1'); ws.addRow(['placeholder', 'two']); });
    return patch(b, 'xl/worksheets/sheet1.xml', (x) => x.replace(/<c r="A1"([^>]*?) t="s"([^>]*)><v>\d+<\/v><\/c>/, '<c r="A1"$1 t="inlineStr"$2><is><t xml:space="preserve">  inline  </t></is></c>'));
});
add('formula string cell (t="str") and error cell (t="e") hand-written', async () => {
    const b = await build((wb) => wb.addWorksheet('S1').addRow([1, 2, 3, 4]));
    return patch(b, 'xl/worksheets/sheet1.xml', (x) => x
        .replace(/<c r="B1"([^>]*)><v>2<\/v><\/c>/, '<c r="B1"$1 t="str"><f>"a"&amp;"b"</f><v>ab</v></c>')
        .replace(/<c r="C1"([^>]*)><v>3<\/v><\/c>/, '<c r="C1"$1 t="e"><v>#REF!</v></c>')
        .replace(/<c r="D1"([^>]*)><v>4<\/v><\/c>/, '<c r="D1"$1 t="b"><v>1</v></c>'));
});
sheet1('shared strings repeated', (ws) => { ws.addRow(['a', 'a', 'b', 'a']); ws.addRow(['b', 'a']); });
sheet1('empty cells inside a row', (ws) => { ws.addRow(['a', null, 'c', null, 'e']); });
sheet1('wholly empty rows between data', (ws) => { ws.getCell('A1').value = 'top'; ws.getCell('A5').value = 'five'; ws.getCell('A9').value = 'nine'; });
sheet1('leading empty columns / rows', (ws) => { ws.getCell('C3').value = 'c3'; ws.getCell('D3').value = 'd3'; ws.getCell('C4').value = 'c4'; });
sheet1('trailing styled-but-empty cells', (ws) => { ws.addRow(['a', 'b']); ws.getCell('D1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }; });
sheet1('cells with only formatting, no value', (ws) => { ws.addRow(['a']); ws.getCell('A2').font = { bold: true }; ws.getCell('B3').numFmt = '0.00'; ws.getCell('A4').value = 'z'; });
sheet1('merged cells (horizontal)', (ws) => { ws.addRow(['Q1 header', null, null, 'tail']); ws.addRow(['x', 'y', 'z', 'w']); ws.mergeCells('A1:C1'); });
sheet1('merged cells (vertical + block)', (ws) => { ws.getCell('A1').value = 'blk'; ws.getCell('D1').value = 'v'; ws.mergeCells('A1:B2'); ws.mergeCells('D1:D3'); ws.getCell('E3').value = 'e'; });
add('multiple sheets incl. empty and hidden', () => build((wb) => {
    wb.addWorksheet('Data').addRow(['d', 1]);
    wb.addWorksheet('Empty');
    const h = wb.addWorksheet('Hidden'); h.state = 'hidden'; h.addRow(['secret']);
    const vh = wb.addWorksheet('VeryHidden'); vh.state = 'veryHidden'; vh.addRow(['vh']);
    wb.addWorksheet('Last').addRow(['l']);
}));
add('sheet names with unicode / special characters', () => build((wb) => {
    wb.addWorksheet('Ünïcödé 日本語').addRow(['a']);
    wb.addWorksheet("Q&A <1> it's").addRow(['b']);
    wb.addWorksheet('emoji 😀').addRow(['c']);
    wb.addWorksheet('a b').addRow(['d']);
}));
sheet1('unicode and multi-line text', (ws) => { ws.addRow(['日本語テキスト', 'Ünïcödé ñ é', '😀 emoji', 'line1\nline2\r\nline3', 'tab\there', '  lead and trail  ', '<b>&amp;</b>']); });
sheet1('whitespace-only and empty-string cells', (ws) => { ws.addRow([' ', '', '  x  ', '\n']); });
sheet1('wide sheet (300 columns)', (ws) => { ws.addRow(Array.from({ length: 300 }, (_, i) => `c${i}`)); ws.addRow(Array.from({ length: 300 }, (_, i) => i)); });
sheet1('5,000-row sheet', (ws) => { for (let i = 0; i < 5000; i++) ws.addRow([i, `row ${i}`, i * 1.5, i % 2 === 0]); });
sheet1('only empty sheet (no data anywhere)', () => undefined);
add('no sheets with text but tiny (image_heavy flag path)', () => build((wb) => { wb.addWorksheet('S1').addRow(['a']); }));
add('large padded workbook flags image_heavy_doc', async () => {
    const b = await build((wb) => { wb.addWorksheet('S1'); });
    const zip = await JSZip.loadAsync(b);
    zip.file('xl/media/pad.bin', Buffer.alloc(40_000, 7));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
});
add('.xlsm (macro-enabled content type)', async () => {
    const b = await build((wb) => wb.addWorksheet('S1').addRow(['macro', 1]));
    return patch(b, '[Content_Types].xml', (x) => x.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'));
});

add('phonetic (rPh) runs in shared strings', async () => {
    const b = await build((wb) => wb.addWorksheet('S1').addRow(['kanji', 'plain']));
    return patch(b, 'xl/sharedStrings.xml', (x) => x.replace('<t>kanji</t>', '<t>kanji</t><rPh sb="0" eb="5"><t>PHONETIC</t></rPh>'));
});
add('sheets listed out of sheetId order', async () => {
    const b = await build((wb) => { wb.addWorksheet('First').addRow(['one']); wb.addWorksheet('Second').addRow(['two']); wb.addWorksheet('Third').addRow(['three']); });
    return patch(b, 'xl/workbook.xml', (x) => x.replace(/<sheet name="Second"([^>]*?)sheetId="2"/, '<sheet name="Second"$1sheetId="9"'));
});
sheet1('header-first sheet with duplicate and blank header cells', (ws) => { ws.addRow(['a', '', 'a', 'd']); ws.addRow(['1', '2', '3', '4']); });
sheet1('many sparse rows with gaps', (ws) => { for (let i = 1; i <= 60; i += 7) ws.getCell(i, 1 + (i % 5)).value = `r${i}`; });
add('CR handling: char refs, _x000D_ escapes, lone CR', async () => {
    const b = await build((wb) => wb.addWorksheet('S1').addRow(['p1', 'p2', 'p3', 'p4']));
    const zip = await JSZip.loadAsync(b);
    const ss = await zip.file('xl/sharedStrings.xml')!.async('string');
    zip.file('xl/sharedStrings.xml', ss
        .replace('<t>p1</t>', '<t xml:space="preserve">a&#13;&#10;b</t>')
        .replace('<t>p2</t>', '<t xml:space="preserve">a_x000D_\nb</t>')
        .replace('<t>p3</t>', '<t xml:space="preserve">a\rb</t>')
        .replace('<t>p4</t>', '<t xml:space="preserve">a&#13;b</t>'));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
});


// ── Documented differences (all class (b): same content, no information lost) ──
// Pinned to the exact old and new text so any further drift fails the test.
const KNOWN_DIFFERENCES: Record<string, { old: string; new: string; why: string }> = {
    'formulas with cached results': {
        old: '## Sheet: S1\n[object Object]\t[object Object]\t[object Object]\t[object Object]\t[object Object]\t[object Object]\nsrc',
        new: '## Sheet: S1\n42\tcached\ttrue\t3.5\t2024-03-15\t7\nsrc',
        why: 'ExcelJS stringified every formula cell as "[object Object]" (the cached result was never read); the new reader returns the cached value',
    },
    'formula errors and formula with NO cached result': {
        old: '## Sheet: S1\n[object Object]\t[object Object]\t[object Object]\tafter',
        new: '## Sheet: S1\n\t\t\tafter',
        why: 'error cells / uncached formulas were the literal "[object Object]"; they are now blank (the error code is not exposed)',
    },
    'plain error values': {
        old: '## Sheet: S1\n[object Object]\t[object Object]\tx',
        new: '## Sheet: S1\n\t\tx',
        why: 'as above — "[object Object]" placeholder becomes an empty cell',
    },
    'formula string cell (t="str") and error cell (t="e") hand-written': {
        old: '## Sheet: S1\n1\t[object Object]\t[object Object]\ttrue',
        new: '## Sheet: S1\n1\tab\t\ttrue',
        why: 'string-typed formula result "ab" is now extracted; error cell blank instead of "[object Object]"',
    },
    'trailing styled-but-empty cells': {
        old: '## Sheet: S1\na\tb\t\t',
        new: '## Sheet: S1\na\tb',
        why: 'formatting-only cells past the last value no longer emit trailing tabs; metadata cols reflects the last VALUE column',
    },
    'CR handling: char refs, _x000D_ escapes, lone CR': {
        old: '## Sheet: S1\na\r\nb\ta\r\nb\ta\nb\ta\rb',
        new: '## Sheet: S1\na\nb\ta\nb\ta\nb\ta\nb',
        why: 'explicit CR / CRLF inside cell text (via &#13; or _x000D_) is folded to LF; raw CR is already normalised by any XML parser',
    },
};

const textOf = (r: { text: string }) => r.text;
type Outcome = { ok: true; r: Awaited<ReturnType<typeof xlsxExtractor.extract>> } | { ok: false; code?: string; msg: string };
const run = async (impl: typeof xlsxExtractor, buf: Buffer): Promise<Outcome> => {
    try { return { ok: true, r: await impl.extract(buf, M) }; }
    catch (e) { return { ok: false, code: (e as { code?: string }).code, msg: (e as Error).message }; }
};

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('xlsx extractor parity (exceljs oracle vs read-excel-file)');
const fixtures = new Map<string, Buffer>();
for (const c of cases) fixtures.set(c.name, await c.buf());

for (const c of cases) {
    await test(`extract: ${c.name}`, async () => {
        const buf = fixtures.get(c.name)!;
        const o = await run(exceljsOracleExtractor, buf);
        const n = await run(xlsxExtractor, buf);
        assert.ok(o.ok && n.ok, `both must succeed: old=${o.ok ? 'ok' : o.msg} new=${n.ok ? 'ok' : n.msg}`);
        if (!o.ok || !n.ok) return;
        const known = KNOWN_DIFFERENCES[c.name];
        if (!known) {
            assert.deepEqual(
                { text: n.r.text, metadata: n.r.metadata, quality: n.r.quality, confidence: n.r.confidence, sourceBytes: n.r.sourceBytes },
                { text: o.r.text, metadata: o.r.metadata, quality: o.r.quality, confidence: o.r.confidence, sourceBytes: o.r.sourceBytes },
            );
        } else {
            assert.equal(textOf(o.r), known.old, `old baseline moved (${known.why})`);
            assert.equal(textOf(n.r), known.new, `new text drifted (${known.why})`);
            // Everything except text/cols/totalChars must still agree.
            assert.equal(n.r.metadata.sheetCount, o.r.metadata.sheetCount);
            assert.deepEqual((n.r.metadata.sheets as Array<{ name: string; rows: number }>).map((s) => [s.name, s.rows]),
                (o.r.metadata.sheets as Array<{ name: string; rows: number }>).map((s) => [s.name, s.rows]));
            assert.deepEqual(n.r.quality, o.r.quality);
        }
    });
}

await test('every documented difference is exercised by a fixture', () => {
    for (const k of Object.keys(KNOWN_DIFFERENCES)) assert.ok(fixtures.has(k), `no fixture named "${k}"`);
    return Promise.resolve();
});

// ── /api/import parser parity ──────────────────────────────────────────
console.log('import parser parity (parseXlsx)');
const tableOf = async (buf: Buffer) => sheetsToTable(await loadWorkbook(buf, 'xlsx-import'));
const importCases: Array<[string, () => Promise<Buffer>]> = [
    ['header + rows', () => build((wb) => { const ws = wb.addWorksheet('S1'); ws.addRow(['Name', 'Qty', 'When', 'Ok']); ws.addRow(['a', 3, new Date('2024-03-15T00:00:00Z'), true]); ws.addRow([' pad ', 1.5, null, false]); ws.addRow([null, null, null, null]); ws.addRow(['z']); })],
    ['empty first sheet is skipped', () => build((wb) => { wb.addWorksheet('E'); const ws = wb.addWorksheet('D'); ws.addRow(['h1', 'h2']); ws.addRow(['x', 'y']); })],
    ['leading blank row (no header)', () => build((wb) => { const ws = wb.addWorksheet('S1'); ws.getCell('A2').value = 'h'; ws.getCell('A3').value = 'v'; })],
    ['blank + duplicate headers', () => build((wb) => { wb.addWorksheet('S1').addRow(['a', '', 'a', 'd']); wb.getWorksheet('S1')!.addRow(['1', '2', '3', '4']); })],
    ['rich text, hyperlink, merged', () => build((wb) => { const ws = wb.addWorksheet('S1'); ws.addRow(['h1', 'h2', 'h3']); ws.getCell('A2').value = S({ richText: [{ text: 'a' }, { text: 'b' }] }); ws.getCell('B2').value = S({ text: 'lnk', hyperlink: 'https://e.x' }); ws.getCell('A3').value = 'm'; ws.mergeCells('A3:C3'); })],
    ['formula with cached result', () => build((wb) => { const ws = wb.addWorksheet('S1'); ws.addRow(['h']); ws.getCell('A2').value = S({ formula: 'A3', result: 42 }); ws.getCell('A3').value = 'x'; })],
    ['workbook with no data', () => build((wb) => { wb.addWorksheet('S1'); })],
];
for (const [name, mk] of importCases) {
    await test(`import: ${name}`, async () => {
        const buf = await mk();
        assert.deepEqual(await tableOf(buf), await parseXlsxOracle(buf));
    });
}
await test('import: styled-but-empty trailing header cells no longer create blank "" columns (documented)', async () => {
    const buf = await build((wb) => { const ws = wb.addWorksheet('S1'); ws.addRow(['a', 'b']); ws.addRow(['1', '2']); ws.getCell('D1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }; });
    assert.deepEqual(await parseXlsxOracle(buf), { headers: ['a', 'b', '', ''], rows: [{ a: '1', b: '2', '': '' }] });
    assert.deepEqual(await tableOf(buf), { headers: ['a', 'b'], rows: [{ a: '1', b: '2' }] });
});
await test('import: formula with no cached result differs only by placeholder (documented)', async () => {
    const buf = await build((wb) => { const ws = wb.addWorksheet('S1'); ws.addRow(['h']); ws.getCell('A2').value = S({ formula: '1/0', result: { error: '#DIV/0!' } }); ws.getCell('A3').value = 'x'; });
    assert.deepEqual((await parseXlsxOracle(buf)).rows, [{ h: '[object Object]' }, { h: 'x' }]);
    assert.deepEqual((await tableOf(buf)).rows, [{ h: 'x' }]);
});

// ── Non-output behaviours ──────────────────────────────────────────────
console.log('error classes and resource limits');
const codeOf = async (impl: typeof xlsxExtractor, buf: Buffer) => { const r = await run(impl, buf); return r.ok ? 'ok' : r.code; };
const goodBuf = await build((wb) => wb.addWorksheet('S1').addRow(['a', 1]));
const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
const truncated = goodBuf.subarray(0, Math.floor(goodBuf.length / 2));
const notXlsxZip = await (async () => { const z = new JSZip(); z.file('hello.txt', 'hi'); return z.generateAsync({ type: 'nodebuffer' }); })();
const noRels = await patch(goodBuf, 'xl/workbook.xml', (x) => x.replace(/<sheets>[\s\S]*<\/sheets>/, '<sheets></sheets>'));

await test('empty buffer -> empty (old and new)', async () => {
    assert.equal(await codeOf(xlsxExtractor, Buffer.alloc(0)), 'empty');
    assert.equal(await codeOf(exceljsOracleExtractor, Buffer.alloc(0)), 'empty');
});
await test('non-zip garbage -> corrupt (old and new)', async () => {
    const junk = Buffer.from('this is definitely not a spreadsheet '.repeat(40));
    assert.equal(await codeOf(xlsxExtractor, junk), 'corrupt');
    assert.equal(await codeOf(exceljsOracleExtractor, junk), 'corrupt');
});
await test('truncated zip -> corrupt (old and new)', async () => {
    assert.equal(await codeOf(xlsxExtractor, truncated), 'corrupt');
    assert.equal(await codeOf(exceljsOracleExtractor, truncated), 'corrupt');
});
await test('zip that is not a workbook -> corrupt (old silently returned empty text, 0 sheets; documented)', async () => {
    assert.equal(await codeOf(xlsxExtractor, notXlsxZip), 'corrupt');
    assert.equal(await codeOf(exceljsOracleExtractor, notXlsxZip), 'ok');
});
await test('encrypted / legacy .xls (OLE2 container) -> unsupported (old reported corrupt)', async () => {
    assert.equal(await codeOf(xlsxExtractor, ole), 'unsupported');
    assert.equal(await codeOf(exceljsOracleExtractor, ole), 'corrupt');
});
await test('workbook declaring zero sheets -> corrupt (old returned empty text; documented)', async () => {
    assert.equal(await codeOf(xlsxExtractor, noRels), 'corrupt');
    assert.equal(await codeOf(exceljsOracleExtractor, noRels), 'ok');
});
await test('declared-size zip bomb refused as unsupported BEFORE parsing', async () => {
    const z = new JSZip(); z.file('xl/worksheets/sheet1.xml', Buffer.alloc(MAX_ENTRY_BYTES + 1));
    const bomb = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const n = await run(xlsxExtractor, bomb);
    assert.ok(!n.ok && n.code === 'unsupported' && /zip bomb|refusing/i.test(n.msg), JSON.stringify(n));
    await assert.rejects(() => loadWorkbook(bomb, 'xlsx-import'), /zip bomb|refusing/i);
});
await test('dense-grid memory guard: one value at XFD1048576 is refused (old reader handled it)', async () => {
    const hostile = await patch(goodBuf, 'xl/worksheets/sheet1.xml', (x) => x.replace('</sheetData>', '<row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>far</t></is></c></row></sheetData>'));
    const t0 = Date.now();
    const n = await run(xlsxExtractor, hostile);
    assert.ok(!n.ok && n.code === 'unsupported' && /refusing/.test(n.msg), JSON.stringify(n));
    assert.ok(Date.now() - t0 < 5000, 'must refuse quickly, before allocating the grid');
    assert.equal(await codeOf(exceljsOracleExtractor, hostile), 'ok');
});
await test('dense-grid guard does not trigger for styled-empty far cells or one far row', async () => {
    const far = await patch(goodBuf, 'xl/worksheets/sheet1.xml', (x) => x.replace('</sheetData>', '<row r="1048576"><c r="XFD1048576" s="1"/></row></sheetData>'));
    assert.equal(await codeOf(xlsxExtractor, far), 'ok');
});
await test('text cap: huge workbook is truncated identically (marker, rows, metadata)', async () => {
    const b = await build((wb) => wb.addWorksheet('S1').addRow(['x']));
    const line = 'y'.repeat(100);
    let rows = '';
    for (let i = 1; i <= 110_000; i++) rows += `<row r="${i}"><c r="A${i}" t="inlineStr"><is><t>${line}</t></is></c></row>`;
    const big = await patch(b, 'xl/worksheets/sheet1.xml', (x) => x.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${rows}</sheetData>`));
    const o = await run(exceljsOracleExtractor, big), n = await run(xlsxExtractor, big);
    assert.ok(o.ok && n.ok);
    if (!o.ok || !n.ok) return;
    assert.ok(Buffer.byteLength(n.r.text, 'utf8') < MAX_EXTRACTED_TEXT_BYTES + 1024, 'capped near the limit');
    assert.deepEqual({ t: n.r.text, m: n.r.metadata }, { t: o.r.text, m: o.r.metadata });
    assert.equal((n.r.metadata.sheets as Array<{ rows: number }>)[0]!.rows, 110_000, 'row count keeps counting past the cap');
});
await test('image_heavy_doc quality flag matches', async () => {
    const o = await run(exceljsOracleExtractor, fixtures.get('large padded workbook flags image_heavy_doc')!);
    const n = await run(xlsxExtractor, fixtures.get('large padded workbook flags image_heavy_doc')!);
    assert.ok(o.ok && n.ok);
    if (o.ok && n.ok) { assert.equal(n.r.quality?.reason, 'image_heavy_doc'); assert.deepEqual(n.r.quality, o.r.quality); }
});
await test('.xlsm extracts the same text', async () => {
    const buf = fixtures.get('.xlsm (macro-enabled content type)')!;
    const n = await run(xlsxExtractor, buf);
    assert.ok(n.ok && n.r.text.includes('macro'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
