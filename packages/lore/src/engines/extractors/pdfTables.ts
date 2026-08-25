/**
 * pdfTables.ts — heuristic table detection from PDF positional text data.
 *
 * Unlike DOCX (where the table exists in the file's own structure), a PDF
 * has NO "this is a table" marker — only visual layout. So this is genuine
 * geometric analysis, and it is HONESTLY IMPERFECT:
 *
 *   1. pull every text item with its x/y position + width/height from
 *      pdfjs's `getTextContent()`,
 *   2. cluster items into visual lines by Y-proximity,
 *   3. split each line into cells by horizontal gaps,
 *   4. treat a run of ≥2 lines that each have ≥2 cells as a table, and
 *   5. attach a confidence = the fraction of rows whose column count
 *      matches the modal count (a clean grid → ~1.0; a ragged layout → low).
 *
 * A missed or malformed detection degrades to the extractor's normal flat
 * text output (it never throws and never corrupts the text path). This is
 * deliberately bounded — "catches clearly-tabular layouts" is the bar, not
 * perfect recall on every PDF ever produced. No LLM, no new dependency.
 */

import type { DetectedTable } from './types.js';

export interface PdfTextItem {
    str: string;
    /** Left edge in PDF user-space (pdfjs `transform[4]`). */
    x: number;
    /** Baseline y (pdfjs `transform[5]`; y grows upward). */
    y: number;
    width: number;
    height: number;
}

export interface PdfLine {
    /** Representative y (max of the line = topmost, since y grows upward). */
    y: number;
    /** Items sorted by x ascending. */
    items: PdfTextItem[];
}

function median(nums: number[]): number {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Pull the positional text items out of a pdfjs `getTextContent()` result.
 * Defensive: items without a `.str` (markup artifacts) are skipped.
 */
export function extractPdfTextItems(content: { items?: unknown[] }): PdfTextItem[] {
    const out: PdfTextItem[] = [];
    for (const raw of content.items ?? []) {
        const it = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
        if (typeof it.str !== 'string' || it.str.trim().length === 0) continue;
        const t = Array.isArray(it.transform) ? (it.transform as number[]) : [];
        out.push({
            str: it.str,
            x: typeof t[4] === 'number' ? t[4] : 0,
            y: typeof t[5] === 'number' ? t[5] : 0,
            width: typeof it.width === 'number' ? it.width : 0,
            height: typeof it.height === 'number' ? it.height : 0,
        });
    }
    return out;
}

/**
 * Cluster items into visual lines by Y-proximity. Two items belong to the
 * same line when their baselines are within `tolerance` (default: 0.6 × the
 * median item height, i.e. a fraction of the font size). Returns lines in
 * top-to-bottom reading order.
 */
export function groupPdfTextItemsIntoLines(
    items: PdfTextItem[],
    tolerance?: number,
): PdfLine[] {
    if (items.length === 0) return [];
    const medianHeight = median(items.map((i) => i.height).filter((h) => h > 0));
    const tol = tolerance ?? medianHeight * 0.6;

    const sorted = [...items].sort((a, b) => b.y - a.y); // top-to-bottom
    const lines: PdfLine[] = [];
    for (const item of sorted) {
        const line = lines.find((l) => Math.abs(l.y - item.y) <= tol);
        if (line) {
            line.items.push(item);
            if (item.y > line.y) line.y = item.y;
        } else {
            lines.push({ y: item.y, items: [item] });
        }
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    return lines;
}

export interface PdfCell {
    text: string;
    x: number;
}

/**
 * Split one line's items into cells: walk left-to-right, and start a new
 * cell whenever the horizontal gap from the previous item's right edge
 * exceeds `gapThreshold`. Within a cell, items join with a space.
 */
export function splitLineIntoCells(line: PdfLine, gapThreshold: number): PdfCell[] {
    const cells: PdfCell[] = [];
    let current: PdfTextItem[] = [];
    let currentStart = 0;
    for (const item of line.items) {
        if (current.length === 0) {
            current = [item];
            currentStart = item.x;
            continue;
        }
        const prev = current[current.length - 1]!;
        const gap = item.x - (prev.x + prev.width);
        if (gap > gapThreshold) {
            cells.push({ text: current.map((i) => i.str).join(' ').trim(), x: currentStart });
            current = [item];
            currentStart = item.x;
        } else {
            current.push(item);
        }
    }
    if (current.length > 0) {
        cells.push({ text: current.map((i) => i.str).join(' ').trim(), x: currentStart });
    }
    return cells.filter((c) => c.text.length > 0);
}

/**
 * Column-gap threshold as a multiple of the median item height (≈ font
 * size). A full column gap is typically ≥1.5× a character's height, while
 * intra-cell word spacing is a small fraction of it. Tunable but a
 * reasonable default for generated report-style PDFs.
 */
const COLUMN_GAP_HEIGHT_MULTIPLE = 1.5;

interface RunTable {
    headers: string[];
    rows: Array<Record<string, string>>;
    confidence: number;
}

function buildTableFromRun(run: PdfCell[][]): RunTable | null {
    if (run.length < 2) return null;

    const counts = run.map((cells) => cells.length);
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modalCount = 2;
    let modalFreq = 0;
    for (const [c, f] of freq) {
        if (f > modalFreq) { modalCount = c; modalFreq = f; }
    }

    const aligned = counts.filter((c) => c === modalCount).length;
    const confidence = Math.round((aligned / run.length) * 100) / 100;

    const headerCells = run[0]!;
    const headers = headerCells.map((c) => c.text);
    const rows: Array<Record<string, string>> = [];
    for (let r = 1; r < run.length; r++) {
        const cells = run[r]!;
        const out: Record<string, string> = {};
        for (let c = 0; c < headers.length; c++) {
            out[headers[c]!] = cells[c]?.text ?? '';
        }
        rows.push(out);
    }
    return { headers, rows, confidence };
}

/**
 * Detect tables in a page's worth of positional text items. Returns each
 * detected table (in reading order) with a confidence in [0, 1]; empty
 * array when the layout shows no tabular region. Pure — operates on the
 * already-extracted items, so it unit-tests against synthetic coordinates.
 */
export function detectPdfTables(items: PdfTextItem[]): DetectedTable[] {
    const lines = groupPdfTextItemsIntoLines(items);
    if (lines.length < 2) return [];

    const medianHeight = median(items.map((i) => i.height).filter((h) => h > 0));
    const gapThreshold = medianHeight * COLUMN_GAP_HEIGHT_MULTIPLE;

    const cellLines = lines.map((line) => splitLineIntoCells(line, gapThreshold));

    const tables: RunTable[] = [];

    let run: PdfCell[][] = [];
    const flush = () => {
        if (run.length >= 2) {
            const t = buildTableFromRun(run);
            if (t) tables.push(t);
        }
        run = [];
    };

    for (const cells of cellLines) {
        if (cells.length >= 2) run.push(cells);
        else flush();
    }
    flush();

    return tables.map((t, i) => ({ ...t, position: i + 1 }));
}
