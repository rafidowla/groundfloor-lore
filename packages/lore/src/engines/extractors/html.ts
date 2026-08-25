/**
 * html.ts — HTML / SVG / XML text extraction (tag stripping).
 *
 * No library needed — regex-based stripping is sufficient for our goal:
 * produce clean embeddable text from markup. We are not rendering HTML
 * or building a DOM; we just want the human-readable content.
 *
 * Pipeline:
 *   1. Remove <script> and <style> blocks (content is code, not prose)
 *   2. Remove HTML comments
 *   3. F-E04 — neutralize inline event-handler attrs (onclick=...) and
 *      javascript:/data: URLs so no executable/injectable fragment survives
 *   4. Replace block-level closing tags with newlines (preserves paragraphs)
 *   5. Strip all remaining tags
 *   6. Decode common HTML entities
 *   7. F-E04 — final sweep: drop any javascript:/data: URL text that survived
 *      decoding (entity-obfuscated payloads) before returning
 *   8. Collapse whitespace
 *
 * F-E04 (2026-06-27, medium, prompt-injection) — extracted text is fed to an
 * LLM, so it must not carry executable/again-injectable fragments. We strip
 * <script>/<style> content (already), event-handler attributes, and
 * javascript:/data: URLs. Ordinary visible prose is preserved unchanged.
 *
 * SVG: text content lives in <text>, <title>, <desc> elements. The same
 * pipeline extracts it correctly — vector path data has no text nodes.
 *
 * XML / RTF: treated as text/plain via the text/* wildcard in text.ts;
 * this extractor only handles text/html and image/svg+xml explicitly.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { capText } from './textCap.js';

/** Shared HTML-to-text function, also used by epub.ts. */
export function htmlToText(html: string): string {
    return html
        // Remove script and style blocks entirely
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        // F-E04 — also drop <noscript> content (markup/code, not prose)
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        // Remove HTML comments
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // F-E04 — strip inline event-handler attributes (onclick=, onerror=, …)
        // so no handler code survives even if a tag is malformed/unclosed.
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, ' ')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, ' ')
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, ' ')
        // F-E04 — neutralize javascript:/data:/vbscript: URLs in attributes
        // (href/src/etc.) before tags are stripped.
        .replace(/\b(?:href|src|xlink:href|action|formaction|data|poster)\s*=\s*"(?:\s|&#\w+;)*(?:javascript|data|vbscript):[^"]*"/gi, ' ')
        .replace(/\b(?:href|src|xlink:href|action|formaction|data|poster)\s*=\s*'(?:\s|&#\w+;)*(?:javascript|data|vbscript):[^']*'/gi, ' ')
        // Block-level closing tags → paragraph breaks
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|nav|main|aside|figure|figcaption)>/gi, '\n')
        // Line-break tags → newline
        .replace(/<br\s*\/?>/gi, '\n')
        // Strip all remaining tags
        .replace(/<[^>]+>/g, ' ')
        // Decode common HTML entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        // F-E04 — final sweep: any javascript:/data:/vbscript: scheme that
        // survived decoding (e.g. entity-obfuscated in attribute text) is a
        // prompt-injection sink — drop the scheme token so no executable URL
        // reaches the LLM. Ordinary prose containing the word stays readable.
        .replace(/(?:javascript|vbscript|data)\s*:[^\s'"]*/gi, ' ')
        // Collapse horizontal whitespace, preserve paragraph breaks
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Extract <title> content from an HTML string. */
function extractTitle(html: string): string | undefined {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? m[1].trim() : undefined;
}

export const htmlExtractor: IExtractor = {
    name: 'html',
    mimeTypes: ['text/html', 'image/svg+xml'],

    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        // HTML is always text — decode as UTF-8 (most common) with
        // Latin-1 fallback for legacy pages.
        let raw: string;
        try {
            raw = input.toString('utf8');
        } catch {
            raw = input.toString('latin1');
        }

        // R3-DOS-02 — cap extracted text (10 MB budget) here, not inside
        // htmlToText (epub.ts reuses htmlToText per-chapter and caps its own join).
        const text = capText(htmlToText(raw));
        const title = extractTitle(raw);

        return {
            text,
            metadata: {
                title,
                originalBytes: input.byteLength,
                strippedChars: text.length,
                compressionRatio: input.byteLength > 0
                    ? Math.round((1 - text.length / input.byteLength) * 100)
                    : 0,
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
        };
    },
};
