/**
 * index.ts — Built-in extractor bootstrap (Phase 2 / C3).
 *
 * One place that knows "these are the extractors core ships by default."
 * Callers (server.ts, CLI commands, connectors) call buildDefaultRegistry()
 * once at boot and cache the result. Plugins can register additional
 * extractors on the returned instance before ingestion starts.
 *
 * Heavy extractors (image/heic/pdf/xlsx/docx/eml) are registered as
 * STUB objects whose extract() method loads the real module on first call.
 * buildDefaultRegistry() itself is synchronous and imports nothing heavy —
 * the real extractor modules (and their native deps: sharp, @napi-rs/canvas,
 * pdfjs-dist, exceljs, mammoth, mailparser) are loaded only when a document
 * of that format is actually processed.  Hosts that never process those
 * formats (e.g. Atlas in code-only mode) pay zero load cost.
 */

import { ExtractorRegistry } from './registry.js';
import { textExtractor } from './text.js';
import { audioExtractor } from './audio.js';
import { pptxExtractor } from './pptx.js';
import { htmlExtractor } from './html.js';
import { epubExtractor } from './epub.js';
import { rtfExtractor } from './rtf.js';
import { videoExtractor } from './video.js';
import type { IExtractor } from './types.js';

export { ExtractorRegistry } from './registry.js';
export { ExtractorError } from './types.js';
export type { IExtractor, ExtractedContent } from './types.js';

/** Wrap a lazy module-load so the real extractor is loaded on first extract() call. */
function lazyExtractor(
    name: string,
    mimeTypes: string[],
    load: () => Promise<IExtractor>,
): IExtractor {
    return {
        name,
        mimeTypes,
        async extract(input, mimeType) {
            const real = await load();
            return real.extract(input, mimeType);
        },
    };
}

/**
 * buildDefaultRegistry — register every built-in extractor in priority
 * order. Most specific first so wildcards (`text/*` in textExtractor)
 * don't shadow explicit matches.
 *
 * Order matters: register() unshifts, so the LAST one registered here
 * is FIRST to be consulted. Put format-specific extractors after the
 * wildcards so they take precedence.
 *
 * Synchronous: heavy extractors are represented as stubs — their real
 * module is only loaded when extract() is first called.
 */
export function buildDefaultRegistry(): ExtractorRegistry {
    const registry = new ExtractorRegistry();
    // Register in reverse-preference order (unshift semantics).
    registry.register(textExtractor);  // last resort — text/* wildcard

    // Optional-dep stubs: module loads only on first extract() call.
    registry.register(lazyExtractor('eml', ['message/rfc822'],
        async () => (await import('./eml.js')).emlExtractor));
    registry.register(lazyExtractor('docx',
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        async () => (await import('./docx.js')).docxExtractor));
    registry.register(lazyExtractor('xlsx', [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.oasis.opendocument.spreadsheet',
    ], async () => (await import('./xlsx.js')).xlsxExtractor));

    registry.register(pptxExtractor);
    registry.register(epubExtractor);
    registry.register(rtfExtractor);
    registry.register(videoExtractor);
    registry.register(htmlExtractor);

    registry.register(lazyExtractor('heic', ['image/heic', 'image/heif'],
        async () => (await import('./image.js')).heicExtractor));
    registry.register(lazyExtractor('pdf', ['application/pdf'],
        async () => (await import('./pdf.js')).pdfExtractor));
    registry.register(audioExtractor);
    // image: last registered = first checked (most specific)
    registry.register(lazyExtractor('image',
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        async () => (await import('./image.js')).imageExtractor));
    return registry;
}

// Expose htmlToText for use by other extractors and tools.
export { htmlToText } from './html.js';
// setCloudVisionProvider is exported from image.ts directly (Phase 6 Lore-Cloud wiring).
export type { ICloudVisionProvider } from './image.js';
