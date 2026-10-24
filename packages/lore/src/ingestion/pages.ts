/**
 * ingestion/pages.ts — page-marker conventions shared with Structuring V2.
 * Structuring V2 splits input on lines of the form `Page_Number: N`.
 */
import type { TextChunk } from './contracts.js';

const MARKER = /^Page_Number:\s*(\d{1,6})\s*$/gm;

/** Split marker-delimited text into page chunks. No markers => []. */
export function splitPages(text: string): TextChunk[] {
    const hits = [...text.matchAll(MARKER)];
    if (hits.length === 0) return [];
    const out: TextChunk[] = [];
    for (let i = 0; i < hits.length; i++) {
        const start = hits[i]!.index! + hits[i]![0].length;
        const end = i + 1 < hits.length ? hits[i + 1]!.index! : text.length;
        const body = text.slice(start, end).trim();
        if (body) out.push({ text: body, page: Number(hits[i]![1]) });
    }
    return out;
}

/** Build structuring input from chunks, inserting markers where pages are known. */
export function buildStructuringText(text: string, chunks: TextChunk[]): string {
    if (chunks.length === 0 || chunks.every((c) => c.page === undefined)) return text;
    return chunks.map((c) => (c.page !== undefined ? `Page_Number: ${c.page}\n${c.text}` : c.text)).join('\n\n');
}
