/**
 * index.ts — Built-in extractor bootstrap (Phase 2 / C3).
 *
 * One place that knows "these are the extractors core ships by default."
 * Callers (server.ts, CLI commands, connectors) call buildDefaultRegistry()
 * once at boot and cache the result. Plugins can register additional
 * extractors on the returned instance before ingestion starts.
 */

import { ExtractorRegistry } from './registry.js';
import { textExtractor } from './text.js';
import { pdfExtractor } from './pdf.js';
import { docxExtractor } from './docx.js';
import { emlExtractor } from './eml.js';
import { audioExtractor } from './audio.js';
import { imageExtractor } from './image.js';

export { ExtractorRegistry } from './registry.js';
export { ExtractorError } from './types.js';
export type { IExtractor, ExtractedContent } from './types.js';

/**
 * buildDefaultRegistry — register every built-in extractor in priority
 * order. Most specific first so wildcards (`text/*` in textExtractor)
 * don't shadow explicit matches.
 *
 * Order matters: register() unshifts, so the LAST one registered here
 * is FIRST to be consulted. Put format-specific extractors after the
 * wildcards so they take precedence.
 */
export function buildDefaultRegistry(): ExtractorRegistry {
    const registry = new ExtractorRegistry();
    // Register in reverse-preference order (unshift semantics).
    registry.register(textExtractor); // last resort text/*
    registry.register(emlExtractor);
    registry.register(docxExtractor);
    registry.register(pdfExtractor);
    registry.register(audioExtractor); // C7
    registry.register(imageExtractor); // C9 — last registered = first checked
    return registry;
}

// Expose setCloudVisionProvider for Phase 6 Lore-Cloud wiring.
export { setCloudVisionProvider, type ICloudVisionProvider } from './image.js';
