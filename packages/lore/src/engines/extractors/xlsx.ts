/**
 * xlsx.ts — XLSX/ODS spreadsheet extraction via ExcelJS.
 *
 * Why ExcelJS and not SheetJS (xlsx npm):
 *   SheetJS has unpatched CVEs and a history of slow security responses.
 *   ExcelJS is MIT-licensed, actively maintained, and has a clean security
 *   record. It reads the same .xlsx format without native bindings.
 *
 * Extraction strategy:
 *   - Iterate every sheet → every row → every cell.
 *   - Emit a plain-text table per sheet: header row (bold or row 1) as
 *     column names, subsequent rows as tab-separated values.
 *   - Preserve sheet names, row count, and column count in metadata.
 *   - Formula cells: use the cached result value (not the formula string)
 *     so the extracted text reflects what the user sees, not `=SUM(A1:A9)`.
 *   - Empty cells: rendered as empty string — gaps in sparse sheets are
 *     preserved so column alignment is not lost.
 *
 * Quality signal:
 *   - Workbooks that are nearly all empty (< 10 chars total across all
 *     sheets) flag image_heavy_doc — the file may be mostly charts or
 *     embedded images that ExcelJS cannot read.
 *
 * What this extractor does NOT do:
 *   - Chart data (ExcelJS exposes chart metadata but not rendered values).
 *   - Embedded images inside cells.
 *   - Pivot table aggregations — raw source data only.
 *   - Password-protected workbooks (throws ExtractorError 'unsupported').
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { assertZipWithinBudget, assertZipRealBytesWithinBudget } from './zipGuard.js';
import { capText, MAX_EXTRACTED_TEXT_BYTES } from './textCap.js';

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

export const xlsxExtractor: IExtractor = {
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
