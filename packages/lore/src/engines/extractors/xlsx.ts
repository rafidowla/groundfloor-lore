/**
 * xlsx.ts — XLSX/XLSM spreadsheet extraction via read-excel-file.
 *
 * Why read-excel-file and not SheetJS (xlsx npm) or ExcelJS:
 *   SheetJS has unpatched CVEs and a history of slow security responses.
 *   ExcelJS pulls in an archiver/unzipper/fast-csv/uuid dependency tree that
 *   carried production `npm audit` findings. read-excel-file is MIT-licensed,
 *   has a small dependency set, and reads the same .xlsx format without native
 *   bindings. The adapter around it lives in xlsxRead.ts; the guards that
 *   replace what the old reader did implicitly (merged cells, bounded memory)
 *   live in xlsxSheetScan.ts.
 *
 * Extraction strategy:
 *   - Iterate every sheet → every row → every cell.
 *   - Emit a plain-text table per sheet: rows as tab-separated values.
 *   - Preserve sheet names, row count, and column count in metadata.
 *   - Formula cells: the cached result is extracted (not the formula string),
 *     so the text reflects what the user sees. Formulas with no cached result
 *     and error cells (#N/A, #DIV/0!) are blank.
 *   - Merged ranges: every cell in the range carries the master cell's value.
 *   - Empty cells: rendered as empty string — gaps in sparse sheets are
 *     preserved so column alignment is not lost; trailing blank cells are not.
 *
 * Quality signal:
 *   - Workbooks that are nearly all empty (< 10 chars total across all
 *     sheets) flag image_heavy_doc — the file may be mostly charts or
 *     embedded images that the reader cannot see.
 *
 * What this extractor does NOT do:
 *   - Chart data, embedded images inside cells, pivot table aggregations.
 *   - Password-protected workbooks or legacy .xls (both are OLE2 containers;
 *     throws ExtractorError 'unsupported').
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { loadWorkbook, lastFilledColumn, cellText } from './xlsxRead.js';
import { capText, MAX_EXTRACTED_TEXT_BYTES } from './textCap.js';

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

        // Guarded read: zip-bomb preflight, dense-grid memory guard, merged-cell replay.
        const sheets = await loadWorkbook(input, 'xlsx');

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

        for (const sheet of sheets) {
            const lines: string[] = [];
            let maxCol = 0;
            let rowCount = 0;

            for (const row of sheet.data) {
                const last = lastFilledColumn(row);
                if (last < 0) continue; // wholly blank row — not counted, not emitted
                rowCount++;
                if (textCapped) continue; // keep counting rows for metadata; stop text
                if (last + 1 > maxCol) maxCol = last + 1;
                const line = row.slice(0, last + 1).map(cellText).join('\t');
                accumulatedBytes += Buffer.byteLength(line, 'utf8') + 1;
                if (accumulatedBytes > MAX_EXTRACTED_TEXT_BYTES) { textCapped = true; continue; }
                lines.push(line);
            }

            sheetSummaries.push({ name: sheet.name, rows: rowCount, cols: maxCol });

            if (lines.length > 0) {
                sheetTexts.push(`## Sheet: ${sheet.name}\n${lines.join('\n')}`);
            }
        }

        // F-E02 — final guard/marker (also covers the cross-sheet join overhead).
        const fullText = capText(sheetTexts.join('\n\n'));
        const totalChars = fullText.length;
        const imageHeavy = totalChars < 10 && input.byteLength > 10_000;

        return {
            text: fullText,
            metadata: {
                sheetCount: sheets.length,
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
