/**
 * htmlTables.ts — structural table extraction from mammoth's HTML output.
 *
 * DOCX table extraction is a STRUCTURAL read, not a heuristic: mammoth's
 * `convertToHtml` renders the document's own `<w:tbl>` elements as real
 * `<table>` markup, so this module only has to walk that well-formed HTML
 * into `{ headers, rows }`. The first `<tr>` of each table becomes the
 * header row, matching Bucket A's XLSX convention (row 1 = headers).
 *
 * Kept out of docx.ts so the extractor file stays small and this parser is
 * independently unit-testable against HTML strings with zero API calls.
 */

import type { DetectedTable } from './types.js';

/** Decode the named/numeric HTML entities mammoth emits (`&amp;`, `&#39;`, …). */
function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'");
}

/** Strip REAL tags first, then decode entities — so an entity-encoded
 *  `&lt;gadget&gt;` becomes literal `<gadget>` text instead of being mistaken
 *  for a tag and stripped. */
function cellText(rawCell: string): string {
    return decodeHtmlEntities(rawCell.replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract every `<table>` from mammoth's HTML into `{headers, rows}`.
 * Pure and defensive: malformed markup yields an empty/partial table rather
 * than throwing. Tables are returned in document order; `position` is
 * 1-based.
 */
export function extractHtmlTables(html: string): DetectedTable[] {
    if (!html) return [];
    const tables: DetectedTable[] = [];

    const tableMatches = html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi);
    let position = 0;
    for (const tableMatch of tableMatches) {
        position++;
        const body = tableMatch[1] ?? '';
        const rowMatches = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
        if (rowMatches.length === 0) continue;

        const grid: string[][] = [];
        for (const rowMatch of rowMatches) {
            const rowBody = rowMatch[1] ?? '';
            const cells = [...rowBody.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
                .map((c) => cellText(c[1] ?? ''));
            grid.push(cells);
        }

        if (grid.length < 2) continue; // a table with only a header row → skip
        const headers = grid[0]!;
        const rows: Array<Record<string, string>> = [];
        for (let r = 1; r < grid.length; r++) {
            const rowCells = grid[r]!;
            const out: Record<string, string> = {};
            headers.forEach((h, i) => {
                out[h] = rowCells[i] ?? '';
            });
            rows.push(out);
        }

        tables.push({ headers, rows, position, confidence: 1.0 });
    }

    return tables;
}
