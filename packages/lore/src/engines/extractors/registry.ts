/**
 * registry.ts — MIME → Extractor lookup (Phase 2 / C3).
 *
 * The registry is a thin dispatcher. Callers hand it bytes + a mime
 * type; it finds the right extractor and returns ExtractedContent.
 * Extension-to-mime inference is also done here (so callers can say
 * "extract this path" and the registry infers from the suffix).
 *
 * Design:
 *   - First-match semantics: extractors register in preferred order.
 *     A client application can override a built-in by registering
 *     earlier with the same mime (future — not exposed in C3 scope).
 *   - No automatic fallbacks: unknown mime returns null, caller
 *     decides to reject or to try a text passthrough.
 *   - Tiny surface so tests are trivial.
 */

import * as path from 'path';
import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';

export class ExtractorRegistry {
    private readonly extractors: IExtractor[] = [];

    /** Register an extractor. Later calls see the later additions first. */
    register(extractor: IExtractor): void {
        // Put newer at the front so plugins can override built-ins by
        // registering after them.
        this.extractors.unshift(extractor);
    }

    /**
     * Look up the extractor for a mime type, respecting wildcards like
     * `text/*`. Returns null if no match.
     */
    findByMime(mimeType: string): IExtractor | null {
        const lower = mimeType.toLowerCase().trim();
        for (const e of this.extractors) {
            for (const pattern of e.mimeTypes) {
                const p = pattern.toLowerCase();
                if (p === lower) return e;
                if (p.endsWith('/*')) {
                    const prefix = p.slice(0, -1); // e.g. "text/"
                    if (lower.startsWith(prefix)) return e;
                }
            }
        }
        return null;
    }

    /**
     * Infer a mime type from a file path's extension, for the common
     * case where a caller doesn't already know it.
     */
    mimeFromPath(filePath: string): string | null {
        const ext = path.extname(filePath).toLowerCase();
        return EXT_TO_MIME[ext] ?? null;
    }

    /**
     * Extract from a buffer. Throws ExtractorError('unsupported') if
     * no extractor is registered for the given mime.
     */
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        const e = this.findByMime(mimeType);
        if (!e) {
            throw new ExtractorError(`No extractor registered for ${mimeType}`, 'unsupported');
        }
        return await e.extract(input, mimeType);
    }

    /** List registered extractors — used by CLI "lore extractors" and by tests. */
    list(): Array<{ name: string; mimeTypes: readonly string[] }> {
        return this.extractors.map((e) => ({ name: e.name, mimeTypes: e.mimeTypes }));
    }
}

/**
 * EXT_TO_MIME — conservative mapping. Only extensions we ACTUALLY handle
 * today. Unknown extensions return null from mimeFromPath() so callers
 * can reject or explicitly pass a mime. We don't want to silently treat
 * an unknown extension as text/plain.
 */
const EXT_TO_MIME: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.eml': 'message/rfc822',
    '.mbox': 'application/mbox',
    // C7 audio (Whisper)
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.mp4a': 'audio/mp4',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.flac': 'audio/flac',
    // Video — property walkthroughs, screen recordings
    '.mp4':  'video/mp4',
    '.mov':  'video/quicktime',
    '.mkv':  'video/x-matroska',
    '.avi':  'video/avi',
    '.m4v':  'video/mp4',
    // C9 images (OCR) — extractor lands in same phase
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    // xlsx — ExcelJS replaces the previously blocked SheetJS (CVE).
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls':  'application/vnd.ms-excel',
    '.ods':  'application/vnd.oasis.opendocument.spreadsheet',
    // pptx
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt':  'application/vnd.ms-powerpoint',
    '.odp':  'application/vnd.oasis.opendocument.presentation',
    // html — tag-stripped by html.ts extractor
    '.html': 'text/html',
    '.htm':  'text/html',
    '.svg':  'image/svg+xml',
    // epub
    '.epub': 'application/epub+zip',
    // plain-text passthroughs — text.ts handles via text/* wildcard
    '.csv':  'text/csv',
    '.tsv':  'text/tab-separated-values',
    '.yaml': 'text/yaml',
    '.yml':  'text/yaml',
    '.toml': 'text/plain',
    '.xml':  'text/xml',
    '.rtf':  'text/rtf',
    // images — image.ts handles these via explicit mime registration
    '.gif':  'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
};
