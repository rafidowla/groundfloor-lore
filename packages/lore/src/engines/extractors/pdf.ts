/**
 * pdf.ts — PDF text extraction via pdfjs-dist.
 *
 * Strategy: iterate every page, pull text items, join with spaces
 * within a line and newlines between lines. Preserve metadata
 * (title, author, page count, creation date) for downstream use.
 *
 * Scope note: this extractor ONLY handles PDFs whose text is already
 * selectable/encoded. Scanned image-only PDFs come out with empty
 * text — callers should check. OCR for those lives in C9 (vision
 * extractor) and will layer on top of this path when a PDF returns
 * text.length === 0.
 *
 * Why pdfjs-dist (not pdf-parse or pdf2json):
 *   - Actively maintained by Mozilla
 *   - Pure JS, no native bindings (pdf-parse pulls in poppler)
 *   - Reasonable API for our "bytes in, text out" use case
 *
 * pdfjs-dist v5 uses ES modules and is node-compatible via the
 * `pdfjs-dist/legacy/build/pdf.mjs` entry (the default entry is
 * browser-first and depends on DOMMatrix etc.).
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';

// Lazy-import so that environments that never touch PDFs don't pay
// the pdfjs-dist load cost. The top-level `await import(...)` here is
// inside an async function, not module scope — no init on import.
async function loadPdfjs(): Promise<any> {
    // The legacy bundle is the node-friendly one.
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return mod;
}

export const pdfExtractor: IExtractor = {
    name: 'pdf',
    mimeTypes: ['application/pdf'],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('PDF is empty', 'empty');
        }

        let pdfjs: any;
        try {
            pdfjs = await loadPdfjs();
        } catch (err) {
            throw new ExtractorError(
                `pdfjs-dist unavailable: ${(err as Error).message}`,
                'unsupported',
            );
        }

        let doc: any;
        try {
            // pdfjs accepts a Uint8Array. Buffer IS a Uint8Array, but we
            // copy to a plain Uint8Array to avoid any Buffer-aliasing
            // issues with the underlying ArrayBuffer.
            const data = new Uint8Array(input);
            const loadingTask = pdfjs.getDocument({
                data,
                // Suppress verbose console logging from pdfjs.
                verbosity: 0,
                // Disable font loading over network — offline-first.
                disableFontFace: true,
                useSystemFonts: false,
            });
            doc = await loadingTask.promise;
        } catch (err) {
            throw new ExtractorError(
                `Failed to open PDF: ${(err as Error).message}`,
                'corrupt',
            );
        }

        const pageTexts: string[] = [];
        try {
            for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
                const page = await doc.getPage(pageNum);
                const content = await page.getTextContent();
                // items are TextItem[], each with a .str. Join with
                // spaces — we don't try to reconstruct paragraph layout
                // (hard, error-prone; downstream chunkers are fine with
                // a stream of tokens).
                const text = (content.items as Array<{ str?: string }>)
                    .map((it) => it.str ?? '')
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (text) pageTexts.push(text);
            }
        } finally {
            // Free PDF internals
            try { await doc.cleanup(); } catch { /* ignore */ }
            try { await doc.destroy(); } catch { /* ignore */ }
        }

        const joinedText = pageTexts.join('\n\n');

        // Best-effort metadata extraction. The shape differs across
        // pdfjs versions; treat all fields as optional.
        let meta: any = {};
        try {
            const info = await doc.getMetadata?.();
            meta = info?.info ?? {};
        } catch { /* ignore */ }

        return {
            text: joinedText,
            metadata: {
                pageCount: doc.numPages,
                title: meta.Title ?? undefined,
                author: meta.Author ?? undefined,
                subject: meta.Subject ?? undefined,
                creator: meta.Creator ?? undefined,
                producer: meta.Producer ?? undefined,
                creationDate: meta.CreationDate ?? undefined,
                modificationDate: meta.ModDate ?? undefined,
                // Extraction hint — downstream can route image-only PDFs
                // through OCR (C9) when text is empty.
                textBearing: joinedText.length > 0,
            },
            // Selectable-text PDFs: full confidence. Empty-text PDFs:
            // still 1.0 that we extracted what we could (there just
            // wasn't any); OCR is a separate layer.
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
        };
    },
};
