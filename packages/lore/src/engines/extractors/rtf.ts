/**
 * rtf.ts — RTF (Rich Text Format) text extraction.
 *
 * RTF is ASCII with control words (\word), control symbols (\x), and
 * nested groups ({ ... }). No library is needed — a regex-based stripper
 * handles the vast majority of real-world RTF files.
 *
 * Algorithm:
 *   1. Remove ignorable destinations: {\*\...} groups (font tables,
 *      stylesheets, picture data, OLE objects — none contain body text)
 *   2. Remove known header groups: \fonttbl, \colortbl, \stylesheet,
 *      \info, \pict (exact-match group removal)
 *   3. Convert paragraph/line breaks: \par \pard \line \sect → newline
 *   4. Decode hex escapes: \'ab → Windows-1252 character
 *   5. Strip remaining control words and control symbols
 *   6. Remove group delimiters { }
 *   7. Collapse whitespace
 *
 * Limitations:
 *   - Nested brace counting is not tracked — deeply nested groups with
 *     embedded literal text may produce minor artifacts.
 *   - Non-Windows-1252 codepages (e.g. \cpg950 for Big5) are not
 *     transcoded; hex escapes decode as Latin-1 in those cases.
 *   - Very large RTF with complex field structures (Word mail-merge,
 *     tracked changes) may leave stray control words in output.
 *
 * For those edge cases the quality signal fires (< 50 chars from large
 * file) and the user is offered a vision model upgrade.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { capText } from './textCap.js';

// Windows-1252 supplement (0x80–0x9F are non-standard in Latin-1)
const WIN1252: Record<number, string> = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†',
    0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
    0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
    0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š',
    0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeHex(hex: string): string {
    const code = parseInt(hex, 16);
    return WIN1252[code] ?? String.fromCharCode(code);
}

/**
 * Remove ignorable destinations `{\* ... }` (metadata sub-trees with no body
 * text) with a single LINEAR brace-matching scan.
 *
 * The previous implementation used a regex with adjacent unbounded `[^{}]*`
 * runs around an optional group, which is catastrophic-backtracking ReDoS: a
 * crafted `.rtf` (e.g. `{\*\` followed by a long run of non-brace bytes with no
 * close) froze the daemon (audit 2026-06-18, malicious-content DoS). This scan
 * is O(n), honors RTF escapes (`\{`/`\}`/`\\` do not change brace depth), and
 * removes arbitrarily-nested ignorable destinations in one pass.
 */
function stripIgnorableDestinations(s: string): string {
    let out = '';
    const n = s.length;
    let i = 0;
    while (i < n) {
        if (s[i] === '{' && s[i + 1] === '\\' && s[i + 2] === '*') {
            let depth = 0;
            let j = i;
            for (; j < n; j++) {
                const c = s[j];
                if (c === '\\') { j++; continue; } // skip the escaped char
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
            }
            out += ' ';
            i = j; // skip the whole ignorable destination (or to EOF if unclosed)
        } else {
            out += s[i];
            i++;
        }
    }
    return out;
}

export function rtfToText(rtf: string): string {
    let s = rtf;

    // 1. Remove ignorable destinations {\* ... } — entire sub-trees of metadata
    //    that never contain body text. Linear scan (ReDoS-safe), nesting-aware.
    s = stripIgnorableDestinations(s);

    // 2. Remove known header groups (may span lines, so use [\s\S])
    s = s.replace(/\{\\fonttbl[\s\S]*?\}/g, ' ');
    s = s.replace(/\{\\colortbl[\s\S]*?\}/g, ' ');
    s = s.replace(/\{\\stylesheet[\s\S]*?\}/g, ' ');
    s = s.replace(/\{\\info[\s\S]*?\}/g, ' ');
    s = s.replace(/\{\\pict[\s\S]*?\}/g, ' ');

    // 3. Paragraph/line breaks → newline
    s = s.replace(/\\par\b/g, '\n');
    s = s.replace(/\\pard\b/g, '\n');
    s = s.replace(/\\line\b/g, '\n');
    s = s.replace(/\\sect\b/g, '\n\n');
    s = s.replace(/\\page\b/g, '\n\n');
    s = s.replace(/\\tab\b/g, '\t');

    // 4. Decode Windows-1252 hex escapes: \'ab
    s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => decodeHex(hex));

    // 5. Unicode escapes: \uN? — N is a decimal codepoint, ? is fallback char
    s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
        // RA2-reaudit2 — guard against out-of-range code points. A crafted RTF
        // with a huge/invalid \uN threw an uncaught RangeError from
        // String.fromCodePoint (malicious-content DoS). RTF \uN is a signed
        // 16-bit value; normalize, range-check, and fall back to dropping it.
        let code = parseInt(n, 10);
        if (!Number.isFinite(code)) return '';
        if (code < 0) code += 65536;
        if (code < 0 || code > 0x10FFFF) return '';
        try { return String.fromCodePoint(code); } catch { return ''; }
    });

    // 6. Escaped special chars — use placeholders so step 8 doesn't
    //    re-strip the literal braces we just decoded.
    s = s.replace(/\\\{/g, '\x00LB\x00');
    s = s.replace(/\\\}/g, '\x00RB\x00');
    s = s.replace(/\\\\/g, '\x00BS\x00');

    // 7. Strip remaining control words (\word or \word-N or \word N)
    s = s.replace(/\\[a-zA-Z]+[-]?\d*\s?/g, ' ');

    // 8. Remove remaining group delimiters
    s = s.replace(/[{}]/g, ' ');

    // 9a. Restore escaped literal chars
    s = s.replace(/\x00LB\x00/g, '{');
    s = s.replace(/\x00RB\x00/g, '}');
    s = s.replace(/\x00BS\x00/g, '\\');

    // 9b. Collapse spaces (but not tabs — \tab produces intentional column separators)
    s = s.replace(/ +/g, ' ');
    s = s.replace(/\n{3,}/g, '\n\n');

    return s.trim();
}

export const rtfExtractor: IExtractor = {
    name: 'rtf',
    mimeTypes: ['text/rtf', 'application/rtf'],

    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        // RTF is always ASCII/Windows-1252 — decode as latin1 to preserve
        // raw bytes for the hex-escape decoder above.
        const raw = input.toString('latin1');
        // R3-DOS-02 — cap to the 10 MB extracted-text budget.
        const text = capText(rtfToText(raw));

        const sparse = text.length < 50 && input.byteLength > 20_000;

        return {
            text,
            metadata: {
                originalBytes: input.byteLength,
                extractedChars: text.length,
            },
            confidence: sparse ? 0.4 : 0.9,
            mimeType,
            sourceBytes: input.byteLength,
            quality: sparse
                ? {
                    reliable: false,
                    reason: 'sparse_pdf', // reuse — "sparse document" semantics
                    suggestedUpgrade: 'either',
                    upgradeMessage: `RTF extracted very little text (${text.length} chars from ${Math.round(input.byteLength / 1024)} KB) — file may have complex structure or embedded objects a vision model can handle better.`,
                }
                : undefined,
        };
    },
};
