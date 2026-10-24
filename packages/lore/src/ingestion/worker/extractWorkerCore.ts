/**
 * ingestion/worker/extractWorkerCore.ts - the extraction step itself, shared by every front door (forked child,
 * loopback HTTP worker, and the in-process path when only vision is configured).
 *
 *   bytes + mime -> the existing extractor registry (PDF, Office, email, HTML, OCR, Whisper, ffmpeg ...) -> ExtractedContent
 *
 * Local vision is layered on top, and only for the two cases the text extractors cannot serve:
 *   - the file is an image: the vision model reads it instead of OCR;
 *   - the file is a PDF with no text layer (`metadata.textBearing === false`): its pages are rendered and read one
 *     by one, and the result carries `Page_Number: N` markers so every piece of text has a page reference.
 * With no vision engine the registry result is returned untouched, byte for byte what the in-process path returns today.
 */
import { buildDefaultRegistry } from '../../engines/extractors/index.js';
import type { ExtractorRegistry } from '../../engines/extractors/registry.js';
import { ExtractorError, type ExtractedContent } from '../../engines/extractors/types.js';
import { capText } from '../../engines/extractors/textCap.js';
import { ProcessorError } from '../contracts.js';
import { VISION_CONFIDENCE, type VisionEngine } from '../processors/localVision.js';
import { renderPdfPages } from './pdfRender.js';

export interface ExtractCoreDeps {
    registry: ExtractorRegistry;
    vision: VisionEngine | null;
    /** Scanned PDFs: pages read per file. */
    visionMaxPages: number;
    /** 0 = no cap (the unchanged in-process default). */
    maxFileBytes: number;
}

export function makeCoreDeps(o: Partial<ExtractCoreDeps> = {}): ExtractCoreDeps {
    return { registry: o.registry ?? buildDefaultRegistry(), vision: o.vision ?? null, visionMaxPages: o.visionMaxPages ?? 25, maxFileBytes: o.maxFileBytes ?? 0 };
}

const VISION_IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const HEIF = new Set(['image/heic', 'image/heif']);
const baseMime = (m: string) => m.split(';')[0]!.trim().toLowerCase();

/** The extractor registry's failures are deterministic for a given file, so they are not retried. Vision/HTTP errors keep their own flag. */
export function classifyError(err: unknown): { message: string; retryable: boolean; code?: string } {
    if (err instanceof ProcessorError) return { message: err.message, retryable: err.retryable, code: 'processor_error' };
    if (err instanceof ExtractorError) return { message: `extraction failed: ${err.message}`, retryable: false, code: err.code };
    return { message: `extraction failed: ${(err as Error)?.message ?? String(err)}`, retryable: false };
}

export async function extractCore(deps: ExtractCoreDeps, bytes: Buffer, mimeType: string): Promise<ExtractedContent> {
    if (deps.maxFileBytes > 0 && bytes.byteLength > deps.maxFileBytes) {
        throw new ProcessorError(`file is ${bytes.byteLength} bytes; the extractor cap is ${deps.maxFileBytes}`, false);
    }
    const mime = baseMime(mimeType);
    if (deps.vision && (VISION_IMAGE.has(mime) || HEIF.has(mime))) return readImage(deps.vision, bytes, mimeType, mime);
    const out = await deps.registry.extract(bytes, mimeType);
    if (deps.vision && mime === 'application/pdf' && out.metadata['textBearing'] === false) return readScan(deps, bytes, mimeType, out);
    return out;
}

async function readImage(vision: VisionEngine, bytes: Buffer, mimeType: string, mime: string): Promise<ExtractedContent> {
    let image = bytes; let sent = mime;
    if (HEIF.has(mime)) {
        try { image = await (await import('sharp')).default(bytes).jpeg({ quality: 90 }).toBuffer(); sent = 'image/jpeg'; }
        catch (err) { throw new ProcessorError(`could not decode ${mime}: ${(err as Error).message}`, false); }
    }
    const text = await vision.describe(image, sent);
    return {
        text: capText(text), mimeType, sourceBytes: bytes.byteLength, confidence: VISION_CONFIDENCE,
        metadata: { source: 'vision', visionEngine: vision.engine, visionModel: vision.model },
    };
}

async function readScan(deps: ExtractCoreDeps, bytes: Buffer, mimeType: string, out: ExtractedContent): Promise<ExtractedContent> {
    const vision = deps.vision!;
    const rendered = await renderPdfPages(bytes, deps.visionMaxPages);
    const parts: string[] = [];
    for (const p of rendered.pages) {
        const text = await vision.describe(p.png, 'image/png', { page: p.page });
        if (text) parts.push(`Page_Number: ${p.page}\n${text}`);
    }
    return {
        text: capText(parts.join('\n\n')), mimeType, sourceBytes: bytes.byteLength, confidence: VISION_CONFIDENCE,
        metadata: {
            ...out.metadata, source: 'vision', visionEngine: vision.engine, visionModel: vision.model,
            visionPages: rendered.pages.length, visionTruncated: rendered.pageCount > rendered.pages.length,
        },
    };
}
