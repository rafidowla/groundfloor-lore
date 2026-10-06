/**
 * xlsxRead.ts — thin adapter over `read-excel-file` shared by the xlsx
 * extractor and the /api/import xlsx parser.
 *
 * `read-excel-file` returns every sheet as a rectangular grid of
 * `string | number | boolean | Date | null`. The adapter:
 *   - disables its default per-cell trimming (`trim: false`) so leading and
 *     trailing spaces survive, exactly as they did with the previous reader;
 *   - maps its input errors onto ExtractorError codes;
 *   - provides `lastFilledColumn` / `cellText` so callers can recover the
 *     "ragged row" shape (no trailing blanks) and the plain-text rendering.
 *
 * The OLE2 magic-byte check lives here because `.xlsx` files that are
 * password-protected are NOT zip archives: Office wraps them in an OLE2
 * compound file (the same container legacy `.xls` uses).
 */

import { ExtractorError } from './types.js';
import { assertZipWithinBudget, assertZipRealBytesWithinBudget } from './zipGuard.js';
import { scanWorkbook, assertGridWithinBudget, applyMerges, type SheetScan } from './xlsxSheetScan.js';

export type SheetCell = string | number | boolean | Date | null;
export interface SheetGrid {
    name: string;
    data: SheetCell[][];
}

/** OLE2 compound-file signature: D0 CF 11 E0 (A1 B1 1A E1). */
function isOle2(buf: Buffer): boolean {
    return buf.length >= 4
        && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
}

/**
 * String cell normalisation. (1) Decode the OOXML `_xHHHH_` escape (Excel stores
 * a carriage return as `_x000D_`; the previous reader decoded it, this library
 * leaves it as literal text). Same single-pass, upper-case-hex rule the previous
 * reader used, so `_x005F_x0041_` still decodes to the literal `_x0041_`.
 * (2) Fold every line break to LF, so text extraction never carries CR/CRLF.
 */
function normaliseString(v: string): string {
    let out = v;
    if (out.includes('_x')) {
        out = out.replace(/_x([0-9A-F]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (out.includes('\r')) out = out.replace(/\r\n?/g, '\n');
    return out;
}

/** Index of the last non-null cell in a row, or -1 for an all-blank row. */
export function lastFilledColumn(row: readonly SheetCell[]): number {
    for (let i = row.length - 1; i >= 0; i--) {
        if (row[i] !== null && row[i] !== undefined) return i;
    }
    return -1;
}

/** Plain-text rendering of one cell. Dates render as `YYYY-MM-DD`. */
export function cellText(value: SheetCell | undefined): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
}

/**
 * Read every sheet of an .xlsx/.xlsm buffer, in workbook order.
 * Throws ExtractorError: 'unsupported' for OLE2 containers (password-protected
 * or legacy .xls), 'corrupt' for anything else that cannot be read.
 */
async function readSheets(input: Buffer): Promise<SheetGrid[]> {
    if (isOle2(input)) {
        throw new ExtractorError(
            'Spreadsheet is password-protected or in legacy .xls format — cannot extract content',
            'unsupported',
        );
    }
    try {
        const mod = await import('read-excel-file/node');
        const sheets = await mod.default(input, { trim: false });
        return sheets.map((s) => ({
            name: s.sheet,
            data: (s.data as SheetCell[][]).map((row) =>
                row.map((v) => (typeof v === 'string' ? normaliseString(v) : v))),
        }));
    } catch (err) {
        throw new ExtractorError(
            `Failed to parse spreadsheet: ${(err as Error).message ?? String(err)}`,
            'corrupt',
        );
    }
}

/**
 * Full guarded read used by BOTH the extractor and the /api/import parser:
 *   1. decompression-bomb preflight (declared + real inflated bytes) via JSZip,
 *      BEFORE the reader sees the bytes (a non-zip falls through to step 3);
 *   2. streaming sheet scan: dense-grid memory guard + merge ranges;
 *   3. `read-excel-file`, then merged ranges replayed onto the grids.
 * Resource-limit refusals and OLE2/encrypted input throw ExtractorError
 * 'unsupported'; unreadable input throws 'corrupt'.
 *
 * @param label  prefix for resource-limit messages ('xlsx' / 'xlsx-import').
 */
export async function loadWorkbook(input: Buffer, label = 'xlsx'): Promise<SheetGrid[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let zip: any = null;
    if (!isOle2(input)) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const jszipMod = (await import('jszip')) as any;
            const JSZip = jszipMod.default ?? jszipMod;
            zip = await JSZip.loadAsync(input);
            assertZipWithinBudget(zip, label);
            await assertZipRealBytesWithinBudget(zip, label); // real-byte scan catches a lying header
        } catch (err) {
            if (/zip bomb|refusing to decompress/i.test((err as Error).message)) {
                throw new ExtractorError((err as Error).message, 'unsupported');
            }
            zip = null; // not a parseable zip → readSheets() classifies it
        }
    }

    let scans = new Map<string, SheetScan>();
    if (zip) {
        try {
            scans = await scanWorkbook(zip);
            assertGridWithinBudget(scans, label);
        } catch (err) {
            if (/refusing/i.test((err as Error).message)) {
                throw new ExtractorError((err as Error).message, 'unsupported');
            }
            throw new ExtractorError(`Failed to parse spreadsheet: ${(err as Error).message}`, 'corrupt');
        }
    }

    const sheets = await readSheets(input);
    for (const sheet of sheets) {
        const ranges = scans.get(sheet.name)?.merges;
        if (ranges && ranges.length > 0) applyMerges(sheet.data, ranges);
    }
    return sheets;
}

/**
 * Header + rows view of the first non-empty sheet, for /api/import.
 * Row 1 is the header (trimmed, trailing blank columns dropped); each later
 * row becomes an object keyed by header, values trimmed; rows with no value
 * are skipped. Returns empty headers/rows when every sheet is empty.
 */
export function sheetsToTable(sheets: readonly SheetGrid[]): { headers: string[]; rows: Record<string, string>[] } {
    const sheet = sheets.find((s) => s.data.some((row) => lastFilledColumn(row) >= 0));
    if (!sheet) return { headers: [], rows: [] };

    const headerRow = sheet.data[0] ?? [];
    const headers: string[] = [];
    for (let c = 0; c <= lastFilledColumn(headerRow); c++) headers.push(cellText(headerRow[c]).trim());

    const rows: Record<string, string>[] = [];
    for (let r = 1; r < sheet.data.length; r++) {
        const row = sheet.data[r]!;
        const out: Record<string, string> = {};
        let anyValue = false;
        for (let c = 0; c < headers.length; c++) {
            const v = cellText(row[c]).trim();
            if (v) anyValue = true;
            out[headers[c]!] = v;
        }
        if (anyValue) rows.push(out);
    }
    return { headers, rows };
}
