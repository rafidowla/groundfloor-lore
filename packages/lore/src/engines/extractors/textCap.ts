/**
 * textCap.ts — F-E02 (2026-06-27, medium, DoS) total-extracted-text cap.
 *
 * No extractor previously capped the TOTAL text it accumulated, so a single
 * large document (epub/xlsx/docx/pptx) could inflate to unbounded in-memory
 * text even when the source archive itself was within the zip-bomb budget. A
 * 50 MB densely-packed spreadsheet, for instance, produces tens of MB of
 * tab-separated text held entirely in memory.
 *
 * This module is the single source of truth for the output-text budget. Each
 * extractor runs its final string through `capText()` (or accumulates with
 * `TextAccumulator` and stops early once the budget is hit), so the returned
 * text never exceeds MAX_EXTRACTED_TEXT_BYTES + the truncation marker.
 */

/** Max bytes of extracted TEXT returned by any single extractor. */
export const MAX_EXTRACTED_TEXT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Marker appended when output is truncated, so consumers know it's partial. */
export const TEXT_TRUNCATION_MARKER =
    '\n\n[... extraction truncated: output exceeded the 10 MB text cap ...]';

/**
 * Return `text` unchanged if within budget, otherwise truncate to `cap` bytes
 * (UTF-8) and append a clear truncation marker.
 */
export function capText(text: string, cap = MAX_EXTRACTED_TEXT_BYTES): string {
    // Fast path: char count is an upper bound on UTF-8 byte count only when all
    // ASCII, so measure bytes to be safe but cheap on the common case.
    if (Buffer.byteLength(text, 'utf8') <= cap) return text;
    // Truncate on a byte boundary without splitting a multi-byte char.
    const buf = Buffer.from(text, 'utf8').subarray(0, cap);
    // Drop a possibly-partial trailing UTF-8 sequence.
    let end = buf.length;
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf8') + TEXT_TRUNCATION_MARKER;
}

/**
 * Incremental accumulator that stops appending once the byte budget is hit, so
 * extractors can break out of their slide/sheet/chapter loops early instead of
 * building a giant string only to truncate it. `isFull` lets a caller bail.
 */
export class TextAccumulator {
    private parts: string[] = [];
    private bytes = 0;
    private truncated = false;
    constructor(private readonly cap = MAX_EXTRACTED_TEXT_BYTES) {}

    /** True once the budget is reached — caller should stop producing text. */
    get isFull(): boolean {
        return this.truncated;
    }

    /** Append a chunk; ignored once full. Returns false when the cap is hit. */
    push(chunk: string): boolean {
        if (this.truncated) return false;
        const add = Buffer.byteLength(chunk, 'utf8');
        if (this.bytes + add > this.cap) {
            const remaining = this.cap - this.bytes;
            if (remaining > 0) {
                this.parts.push(capText(chunk, remaining).replace(TEXT_TRUNCATION_MARKER, ''));
            }
            this.truncated = true;
            return false;
        }
        this.parts.push(chunk);
        this.bytes += add;
        return true;
    }

    /** Join the accumulated chunks, appending the marker if truncation occurred. */
    toString(separator = '\n\n'): string {
        const joined = this.parts.join(separator);
        return this.truncated ? joined + TEXT_TRUNCATION_MARKER : joined;
    }
}
