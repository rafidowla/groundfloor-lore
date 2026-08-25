#!/usr/bin/env tsx
/**
 * audit-zipbomb-docx-import-unit.ts — deep-audit 2026-06-25 (HIGH, DoS).
 *
 * The 2026-06-18 decompression-bomb guard (`assertZipWithinBudget`) was wired
 * into the pptx/xlsx/epub extractors but MISSED two OOXML-zip ingestion paths:
 *
 *   1. engines/extractors/docx.ts — handed bytes straight to mammoth, which
 *      inflates the zip internally with no size cap.
 *   2. mcp/http/routes/import.ts `parseXlsx()` — the /api/import counterpart of
 *      the xlsx extractor; called ExcelJS.load() with no preflight.
 *
 * A few-KB archive that DECLARES a multi-GB uncompressed size would OOM the
 * embedded/local daemon through either path. These guards close both.
 *
 * Fixture: a real zip whose single entry declares > MAX_ENTRY_BYTES uncompressed
 * (zeros compress to ~KB on disk but the central directory records the full
 * declared size — exactly the common zip-bomb shape the guard targets).
 */

import assert from 'node:assert/strict';
import { MAX_ENTRY_BYTES } from '../packages/lore/src/engines/extractors/zipGuard.js';
import { docxExtractor } from '../packages/lore/src/engines/extractors/docx.js';
import { parseXlsx } from '../packages/lore/src/mcp/http/routes/import.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/** Build a real zip whose one entry declares > the per-entry cap. */
async function makeZipBomb(): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const JSZip = ((await import('jszip')) as any).default;
    const zip = new JSZip();
    // 100 MB + 1 of zeros → deflates to ~KB on disk, declares > MAX_ENTRY_BYTES.
    zip.file('word/document.xml', Buffer.alloc(MAX_ENTRY_BYTES + 1));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

console.log('AUDIT zip-bomb — docx extractor + /api/import parseXlsx reject declared-oversize archives');

const bomb = await makeZipBomb();
console.log(`  (bomb fixture: ${bomb.byteLength} bytes on disk, declares ${MAX_ENTRY_BYTES + 1} uncompressed)`);

await test('docx extractor refuses a declared-oversize zip (no OOM)', async () => {
    await assert.rejects(
        () => docxExtractor.extract(bomb, DOCX_MIME),
        /zip bomb|refusing to decompress/i,
        'docx must reject the bomb before handing bytes to mammoth',
    );
});

await test('/api/import parseXlsx refuses a declared-oversize zip (no OOM)', async () => {
    await assert.rejects(
        () => parseXlsx(bomb),
        /zip bomb|refusing to decompress/i,
        'parseXlsx must reject the bomb before ExcelJS.load',
    );
});

await test('a small benign zip is NOT misflagged as a bomb (guard falls through)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const JSZip = ((await import('jszip')) as any).default;
    const z = new JSZip();
    z.file('word/document.xml', '<xml>hi</xml>');
    const small = await z.generateAsync({ type: 'nodebuffer' });
    // Not a real DOCX, so mammoth will error — but it must NOT be a zip-bomb error.
    await assert.rejects(
        () => docxExtractor.extract(small, DOCX_MIME),
        (e: Error) => !/zip bomb|refusing to decompress/i.test(e.message),
        'a benign small zip must fall through the guard, not trip it',
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
