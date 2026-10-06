/**
 * test/extractors/xlsx-oracle-exceljs.ts
 *
 * TEST-ONLY ORACLE. A frozen copy of the pre-swap `extractors/xlsx.ts`
 * (ExcelJS based, as of Lore 3.25.1) kept so test/extractors/xlsx-parity.test.ts
 * can prove the read-excel-file implementation yields equivalent output.
 * exceljs is a devDependency for exactly this and for building fixtures.
 * Do not "fix" this file: its quirks (e.g. formula cells rendered as
 * "[object Object]") are the recorded baseline the parity test diffs against.
 */

import type { IExtractor, ExtractedContent } from '../../packages/lore/src/engines/extractors/types.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';
import { assertZipWithinBudget, assertZipRealBytesWithinBudget } from '../../packages/lore/src/engines/extractors/zipGuard.js';
import { capText, MAX_EXTRACTED_TEXT_BYTES } from '../../packages/lore/src/engines/extractors/textCap.js';

function cellValueToString(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        // RichText: { richText: Array<{ text: string }> }
        if ('richText' in (value as object)) {
            return ((value as { richText: Array<{ text: string }> }).richText)
                .map((r) => r.text)
                .join('');
        }
        // Hyperlink: { text: string, hyperlink: string }
        if ('text' in (value as object)) {
            return String((value as { text: unknown }).text);
        }
        // Date
        if (value instanceof Date) {
            return value.toISOString().slice(0, 10);
        }
        return String(value);
    }
    return String(value);
}

export const exceljsOracleExtractor: IExtractor = {
    name: 'xlsx',
    mimeTypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.oasis.opendocument.spreadsheet',
    ],

    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('Spreadsheet is empty', 'empty');
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ExcelJSMod: any;
        try {
            const mod = await import('exceljs') as any;
            ExcelJSMod = mod.default ?? mod;
        } catch (err) {
            throw new ExtractorError(
                `exceljs unavailable: ${(err as Error).message}`,
                'unsupported',
            );
        }

        // audit 2026-06-18 — decompression-bomb preflight. xlsx/ods is a zip and
        // ExcelJS inflates it internally with no size cap, so a small "zip bomb"
        // could OOM the daemon. Validate the declared uncompressed sizes with
        // JSZip first; a non-zip input (rare) falls through to ExcelJS.
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const jszipMod = (await import('jszip')) as any;
            const JSZip = jszipMod.default ?? jszipMod;
            const zip = await JSZip.loadAsync(input);
            assertZipWithinBudget(zip, 'xlsx');
            await assertZipRealBytesWithinBudget(zip, 'xlsx'); // 4.1 — real-byte scan catches a lying header
        } catch (err) {
            if (/zip bomb|refusing to decompress/i.test((err as Error).message)) {
                throw new ExtractorError((err as Error).message, 'unsupported');
            }
            // Not a parseable zip → let ExcelJS handle/err appropriately.
        }

        // F-LOW-E03 — parse the workbook IN MEMORY from the input buffer.
        // The previous implementation wrote attacker-controlled bytes to
        // os.tmpdir() (disk-fill / temp-file leak risk) and read them back via
        // workbook.xlsx.readFile(). ExcelJS 4.x exposes workbook.xlsx.load()
        // which accepts a Buffer/ArrayBuffer directly, so we avoid touching the
        // filesystem entirely — no temp file to cap, leak, or clean up.
        const workbook = new ExcelJSMod.Workbook();
        try {
            await workbook.xlsx.load(input);
        } catch (err) {
            const msg = (err as Error).message ?? '';
            if (/password|encrypted/i.test(msg)) {
                throw new ExtractorError(
                    'Spreadsheet is password-protected — cannot extract content',
                    'unsupported',
                );
            }
            throw new ExtractorError(
                `Failed to parse spreadsheet: ${msg}`,
                'corrupt',
            );
        }

        const sheetSummaries: Array<{
            name: string;
            rows: number;
            cols: number;
        }> = [];
        const sheetTexts: string[] = [];
        // F-E02 — track running output bytes; stop accumulating once the text
        // cap is hit so a huge workbook can't build unbounded in-memory text.
        let accumulatedBytes = 0;
        let textCapped = false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workbook.eachSheet((sheet: any) => {
            const lines: string[] = [];
            let maxCol = 0;
            let rowCount = 0;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sheet.eachRow({ includeEmpty: false }, (row: any) => {
                rowCount++;
                if (textCapped) return; // keep counting rows for metadata; stop text
                const cells: string[] = [];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
                    if (colNumber > maxCol) maxCol = colNumber;
                    cells.push(cellValueToString(cell.value));
                });
                const line = cells.join('\t');
                accumulatedBytes += Buffer.byteLength(line, 'utf8') + 1;
                if (accumulatedBytes > MAX_EXTRACTED_TEXT_BYTES) { textCapped = true; return; }
                lines.push(line);
            });

            sheetSummaries.push({ name: sheet.name, rows: rowCount, cols: maxCol });

            if (lines.length > 0) {
                sheetTexts.push(`## Sheet: ${sheet.name}\n${lines.join('\n')}`);
            }
        });

        // F-E02 — final guard/marker (also covers the cross-sheet join overhead).
        const fullText = capText(sheetTexts.join('\n\n'));
        const totalChars = fullText.length;
        const imageHeavy = totalChars < 10 && input.byteLength > 10_000;

        return {
            text: fullText,
            metadata: {
                sheetCount: workbook.worksheets.length,
                sheets: sheetSummaries,
                totalChars,
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
            quality: imageHeavy
                ? {
                    reliable: false,
                    reason: 'image_heavy_doc',
                    suggestedUpgrade: 'either',
                    upgradeMessage: `Spreadsheet extracted almost no text (${totalChars} chars from ${Math.round(input.byteLength / 1024)} KB) — file may be mostly charts or embedded images.`,
                }
                : undefined,
        };
    },
};

// ── Frozen copy of the pre-swap /api/import parseXlsx (ExcelJS) ─────────
export async function parseXlsxOracle(buf: Buffer): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
    // audit 2026-06-25 (HIGH, malicious-content DoS) — the extractor path
    // (engines/extractors/xlsx.ts) zip-bomb-guards before ExcelJS, but this
    // import-time counterpart did not: ExcelJS.load inflates the zip with no
    // size cap, so a small bomb uploaded to /api/import could OOM the daemon.
    // Preflight the declared uncompressed sizes; a non-zip falls through.
    try {
        const jszipMod = (await import('jszip')) as any;
        const JSZip = jszipMod.default ?? jszipMod;
        const zip = await JSZip.loadAsync(buf);
        assertZipWithinBudget(zip, 'xlsx-import');
    } catch (err) {
        if (/zip bomb|refusing to decompress/i.test((err as Error).message)) {
            throw new Error((err as Error).message);
        }
        // Not a parseable zip → let ExcelJS handle/err appropriately.
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    // ExcelJS's published Buffer type pins to a narrower variant than
    // @types/node's current Buffer<ArrayBufferLike>. Hand it the
    // underlying ArrayBuffer slice instead; ExcelJS accepts that
    // overload natively, no escape hatch needed.
    // Node Buffer's underlying .buffer is always ArrayBuffer (never
    // SharedArrayBuffer), but TS infers the broader ArrayBufferLike
    // union — narrow with an assertion so this matches ExcelJS's overload.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await workbook.xlsx.load(ab);

    // Pick the first sheet that has at least one populated row. Empty
    // sheets (sometimes left over from templates) are skipped silently.
    let sheet: import('exceljs').Worksheet | null = null;
    for (const ws of workbook.worksheets) {
        if (ws.rowCount > 0) { sheet = ws; break; }
    }
    if (!sheet) return { headers: [], rows: [] };

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell) => {
        headers.push(stringifyCell(cell.value).trim());
    });

    const rows: Record<string, string>[] = [];
    for (let rowIdx = 2; rowIdx <= sheet.rowCount; rowIdx++) {
        const row = sheet.getRow(rowIdx);
        const out: Record<string, string> = {};
        let anyValue = false;
        for (let colIdx = 1; colIdx <= headers.length; colIdx++) {
            const cell = row.getCell(colIdx);
            const v = stringifyCell(cell.value).trim();
            if (v) anyValue = true;
            out[headers[colIdx - 1]!] = v;
        }
        if (anyValue) rows.push(out);
    }

    return { headers, rows };
}

function stringifyCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        if ('richText' in (value as object)) {
            return (value as { richText: Array<{ text: string }> }).richText
                .map(r => r.text).join('');
        }
        if (value instanceof Date) {
            return value.toISOString().slice(0, 10);
        }
        // Formula cell: { formula, result }. We want the cached result.
        if ('result' in (value as object)) {
            return stringifyCell((value as { result: unknown }).result);
        }
        if ('text' in (value as object)) {
            return String((value as { text: unknown }).text);
        }
        return String(value);
    }
    return String(value);
}

