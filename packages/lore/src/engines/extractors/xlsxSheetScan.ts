/**
 * xlsxSheetScan.ts — one streaming pass over each worksheet part of an
 * .xlsx archive, to cover two things `read-excel-file` does not do itself:
 *
 * 1. MEMORY GUARD. The reader materialises each sheet as a DENSE grid of
 *    `maxRow x maxCol` cells (it pads every row to the widest value). A
 *    ~1 KB workbook with one value at `XFD1048576` therefore asks for ~17
 *    billion cells and OOMs the daemon (measured: the old ExcelJS reader
 *    handled the same file in ~90 ms). We measure the extent of VALUE-bearing
 *    cells (empty styled cells are ignored by the reader) BEFORE parsing and
 *    refuse a workbook whose dense area exceeds MAX_GRID_CELLS.
 *
 * 2. MERGED CELLS. A merged range stores its value only in the top-left
 *    ("master") cell. The previous reader (ExcelJS) reported that master value
 *    for EVERY cell in the range, and that is load-bearing for extraction: a
 *    vertically merged category label ("Retail" spanning 12 rows) or a header
 *    spanning three columns would otherwise appear once, leaving the other
 *    rows / columns without their label once the text is chunked. The reader
 *    does not expose merge ranges, so we read them here and replay the ExcelJS
 *    behaviour: every cell in the range takes the master's value (a blank
 *    master blanks the range).
 *
 * Memory of the scan itself is O(1): sheet XML is streamed in chunks (with a
 * short carry-over so a tag split across chunks is still seen). Expansion of
 * merge ranges is capped so a hostile `A1:XFD1048576` merge cannot allocate
 * billions of cells.
 */

import type { SheetCell } from './xlsxRead.js';

/** Zero-based, inclusive range. */
export interface MergeRange { r1: number; c1: number; r2: number; c2: number }

export interface SheetScan {
    /** Highest 1-based row / column that holds a VALUE. */
    maxRow: number;
    maxCol: number;
    merges: MergeRange[];
}

/** Max dense cells (rows x columns, summed over sheets) we let the reader build (~40 MB RSS per million cells; a sheet this dense would exceed the 10 MB text cap anyway). */
export const MAX_GRID_CELLS = 10_000_000;
/** Max cells one merge range may expand to; larger ranges are skipped. */
export const MAX_MERGE_CELLS_PER_RANGE = 100_000;
/** Max cells touched by all merge expansions in one sheet. */
export const MAX_MERGE_CELLS_PER_SHEET = 1_000_000;

interface ZipEntryLike {
    async(type: 'string'): Promise<string>;
    nodeStream?(type: 'nodebuffer'): NodeJS.ReadableStream & { destroy?: () => void };
}
interface ZipLike { file(name: string): ZipEntryLike | null }

const unescapeXml = (s: string): string =>
    s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
        }
        return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e] ?? '';
    });

function colToIndex(letters: string): number {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/** Parse "A1" or "A1:C3" into a MergeRange (null when malformed). */
export function parseRef(ref: string): MergeRange | null {
    const m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(ref.trim());
    if (!m) return null;
    const c1 = colToIndex(m[1]!.toUpperCase());
    const r1 = parseInt(m[2]!, 10) - 1;
    const c2 = m[3] ? colToIndex(m[3].toUpperCase()) : c1;
    const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
    if (r1 < 0 || r2 < r1 || c2 < c1) return null;
    return { r1, c1, r2, c2 };
}

const TAG_RE = /<(?:[\w-]+:)?(c|mergeCell)\b[^>]*>/g;
const ATTR_R_RE = /\br\s*=\s*["']([^"']+)["']/;
const ATTR_REF_RE = /\bref\s*=\s*["']([^"']+)["']/;

/** Stream one sheet part: extent of value cells + merge ranges. */
function scanSheet(entry: ZipEntryLike): Promise<SheetScan> {
    return new Promise((resolve, reject) => {
        const scan: SheetScan = { maxRow: 0, maxCol: 0, merges: [] };
        if (typeof entry.nodeStream !== 'function') { resolve(scan); return; }
        const stream = entry.nodeStream('nodebuffer');
        let carry = '';
        stream.on('data', (chunk: Buffer) => {
            // latin1: the tags/attributes we read are ASCII, and it can never split a char wrongly.
            const text = carry + chunk.toString('latin1');
            TAG_RE.lastIndex = 0;
            for (let m = TAG_RE.exec(text); m; m = TAG_RE.exec(text)) {
                const tag = m[0];
                if (m[1] === 'c') {
                    if (tag.endsWith('/>')) continue; // self-closed => no value (styled/empty)
                    const ref = ATTR_R_RE.exec(tag)?.[1];
                    const p = ref ? parseRef(ref) : null;
                    if (p) {
                        if (p.r1 + 1 > scan.maxRow) scan.maxRow = p.r1 + 1;
                        if (p.c1 + 1 > scan.maxCol) scan.maxCol = p.c1 + 1;
                    }
                } else {
                    const ref = ATTR_REF_RE.exec(tag)?.[1];
                    const p = ref ? parseRef(ref) : null;
                    if (p && (p.r2 > p.r1 || p.c2 > p.c1)) scan.merges.push(p);
                }
            }
            // Keep an unterminated trailing tag for the next chunk.
            const lt = text.lastIndexOf('<');
            carry = lt > text.lastIndexOf('>') ? text.slice(lt) : '';
        });
        stream.on('end', () => resolve(scan));
        stream.on('error', (err: Error) => reject(err));
    });
}

/** Resolve a workbook relationship target to a zip path. */
function resolveTarget(target: string): string {
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

/**
 * Scan every worksheet, keyed by sheet NAME (as the reader reports it).
 * Missing/odd workbook plumbing yields an empty map (the reader then
 * classifies the file); a genuine stream error rejects.
 */
export async function scanWorkbook(zip: ZipLike): Promise<Map<string, SheetScan>> {
    const out = new Map<string, SheetScan>();
    const wbXml = await zip.file('xl/workbook.xml')?.async('string');
    const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if (!wbXml || !relsXml) return out;
    const targets = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
        const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
        if (id && target) targets.set(id, resolveTarget(target));
    }
    for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
        const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
        const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1];
        const path = rid ? targets.get(rid) : undefined;
        const entry = path ? zip.file(path) : null;
        if (name === undefined || !entry) continue;
        out.set(unescapeXml(name), await scanSheet(entry));
    }
    return out;
}

/** Throw if the dense grids the reader would build exceed MAX_GRID_CELLS in total. */
export function assertGridWithinBudget(scans: Map<string, SheetScan>, label = 'xlsx'): void {
    let total = 0;
    for (const [name, s] of scans) {
        total += s.maxRow * s.maxCol;
        if (total > MAX_GRID_CELLS) {
            throw new Error(`${label}: sheet '${name}' spans ${s.maxRow} rows x ${s.maxCol} columns of values — the workbook would need more than ${MAX_GRID_CELLS} grid cells to read — refusing (resource limit)`);
        }
    }
}

/** Replay the merge ranges onto a grid (mutates `data`; rows/columns grow as needed). */
export function applyMerges(data: SheetCell[][], ranges: readonly MergeRange[]): void {
    let budget = MAX_MERGE_CELLS_PER_SHEET;
    for (const { r1, c1, r2, c2 } of ranges) {
        const area = (r2 - r1 + 1) * (c2 - c1 + 1);
        if (area > MAX_MERGE_CELLS_PER_RANGE || area > budget) continue;
        budget -= area;
        const master = data[r1]?.[c1] ?? null;
        for (let r = r1; r <= r2; r++) {
            while (data.length <= r) data.push([]);
            const row = data[r]!;
            while (row.length <= c2) row.push(null);
            for (let c = c1; c <= c2; c++) row[c] = master;
        }
    }
}
