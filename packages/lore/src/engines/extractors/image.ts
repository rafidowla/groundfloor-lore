/**
 * image.ts — Image OCR via Tesseract.js (Phase 4 / C9).
 *
 * Scope:
 *   - Extract printed text from screenshots, scanned docs, photos of
 *     signs/whiteboards where the text is legible.
 *   - Fails on handwriting, heavy noise, small text, rotated text. For
 *     those, the cloud-vision fallback hook kicks in (see below).
 *
 * Why Tesseract.js:
 *   - Pure JS (WASM), no native bindings to fight with on install.
 *   - Same library many document-ingestion tools use.
 *   - English-only by default (~4 MB); other languages add 4 MB each.
 *
 * HEIC/HEIF support (2026-05-14):
 *   - iPhone photos default to HEIC. Tesseract cannot decode HEIC.
 *   - `sharp` (libvips wrapper) handles the conversion in-process — no
 *     external binary, no temp file. We convert to JPEG buffer in
 *     memory then route through the standard OCR pipeline. Native
 *     module so adds ~30 MB to install footprint; the win is iPhone
 *     photos finally index without an LLM.
 *
 * Confidence:
 *   - Tesseract returns a per-image confidence score (0–100). We
 *     normalize to 0–1. A typical clean screenshot scores 90+; a
 *     noisy photo might score 30–50. Downstream chunkers can discard
 *     low-confidence extracts or route them through the cloud-vision
 *     fallback.
 *
 * Cloud-vision fallback (stub):
 *   - `ICloudVisionProvider` interface defined here. Concrete impl
 *     lands with Lore Cloud (Phase 6+). Until then: when confidence
 *     < 0.5, metadata.fallbackSuggested = true. Caller decides.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { capText } from './textCap.js';

/**
 * ICloudVisionProvider — interface for the C9 cloud-vision fallback.
 *
 * When OCR confidence is below a threshold (0.5 by default), a
 * downstream caller can pass the same buffer to a cloud vision
 * model (Claude 3.5 Sonnet vision, GPT-4V, etc.) which handles
 * handwriting, complex layouts, and charts that OCR can't.
 *
 * Phase 4 ships the interface + a `null` provider. Lore Cloud will
 * register a real provider when it exists.
 */
export interface ICloudVisionProvider {
    describe(imageBuffer: Buffer, mimeType: string): Promise<{
        text: string;
        confidence: number;
    }>;
}

let cloudVisionProvider: ICloudVisionProvider | null = null;

export function setCloudVisionProvider(provider: ICloudVisionProvider | null): void {
    cloudVisionProvider = provider;
}

/**
 * heicExtractor — HEIC/HEIF images from Apple devices.
 *
 * sharp (libvips) converts HEIC to JPEG in-memory; the OCR path is
 * identical to PNG/JPEG. iPhone photos containing legible printed
 * text (receipts, signs, screenshots cast to HEIC) become searchable.
 *
 * Past behaviour (pre-2026-05-14): returned empty text + "upgrade
 * suggested." Kept the upgrade-message path for the case where sharp
 * fails (corrupt HEIC, unsupported variant) so the caller still gets
 * a clear signal.
 */
export const heicExtractor: IExtractor = {
    name: 'heic',
    mimeTypes: ['image/heic', 'image/heif'],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('Image is empty', 'empty');
        }

        let convertedBuffer: Buffer;
        try {
            const sharp = (await import('sharp')).default;
            // Convert to JPEG at quality 90 — good enough for OCR, keeps
            // the buffer small. Tesseract reads JPEG natively.
            convertedBuffer = await sharp(input).jpeg({ quality: 90 }).toBuffer();
        } catch (err) {
            // sharp couldn't decode (corrupt HEIC, unsupported variant,
            // missing libvips on host). Fall back to the prior behaviour:
            // surface a clear signal so the caller can route to vision.
            return {
                text: '',
                metadata: {
                    format: mimeType,
                    conversionError: (err as Error).message,
                },
                confidence: 0,
                mimeType,
                sourceBytes: input.byteLength,
                quality: {
                    reliable: false,
                    reason: 'low_ocr_confidence',
                    suggestedUpgrade: 'either',
                    upgradeMessage: `HEIC/HEIF conversion failed (${(err as Error).message}). A vision model (local or cloud) can read this format directly.`,
                },
            };
        }

        // Route the converted buffer through the standard OCR path.
        // Note: imageExtractor.mimeTypes do NOT include heic/heif, so
        // this composition does not create an infinite loop.
        return imageExtractor.extract(convertedBuffer, 'image/jpeg').then(result => ({
            ...result,
            // Preserve the caller-visible MIME so downstream logging /
            // routing sees the source format, not the intermediate JPEG.
            mimeType,
            metadata: {
                ...result.metadata,
                format: mimeType,
                converted: 'heic-to-jpeg',
            },
            sourceBytes: input.byteLength,
        }));
    },
};

/**
 * Default OCR languages, preloaded into a single multi-lang Tesseract
 * worker. Covers the top ~10 languages by speaker count — ~60% of the
 * world population. Tesseract.js downloads each lang pack (~10-20 MB)
 * from CDN on first use; cumulative ~150 MB first-use cost. After
 * that, OCR runs locally with no network.
 *
 * Override via env var: `LORE_OCR_LANGUAGES=eng,fra,deu` (comma-separated
 * Tesseract codes, see https://tesseract-ocr.github.io/tessdoc/Data-Files.html).
 *
 * Language codes (Tesseract format):
 *   eng = English      chi_sim = Chinese (simplified)
 *   spa = Spanish      hin = Hindi
 *   ara = Arabic       por = Portuguese
 *   ben = Bengali      rus = Russian
 *   jpn = Japanese     fra = French
 */
const DEFAULT_OCR_LANGUAGES = [
    'eng', 'chi_sim', 'spa', 'hin', 'ara',
    'por', 'ben', 'rus', 'jpn', 'fra',
];

function getOcrLanguages(): string[] {
    const env = process.env.LORE_OCR_LANGUAGES?.trim();
    if (!env) return DEFAULT_OCR_LANGUAGES;
    const parsed = env.split(',').map(s => s.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_OCR_LANGUAGES;
}

// Cache Tesseract worker between calls. Creating a worker is slow
// (~2 s), executing it is fast. The worker is keyed on the language
// list so a runtime env-var override gets picked up on first use.
let workerPromise: Promise<unknown> | null = null;
let workerLanguages: string[] | null = null;

async function getWorker(): Promise<unknown> {
    const langs = getOcrLanguages();
    if (!workerPromise || !workerLanguages || workerLanguages.join(',') !== langs.join(',')) {
        workerLanguages = langs;
        workerPromise = (async () => {
            const tesseract = await import('tesseract.js');
            // Multi-language worker: Tesseract OCRs in all configured
            // languages at once. The first call downloads any missing
            // lang packs from CDN to the local Tesseract cache.
            const w = await tesseract.createWorker(langs);
            return w;
        })();
    }
    return workerPromise;
}

export const imageExtractor: IExtractor = {
    name: 'image',
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('Image is empty', 'empty');
        }

        let worker: any;
        try {
            worker = await getWorker();
        } catch (err) {
            throw new ExtractorError(
                `Tesseract unavailable: ${(err as Error).message}`,
                'unsupported',
            );
        }

        let text = '';
        let confidence = 0;
        try {
            const result = await worker.recognize(input);
            text = String(result?.data?.text ?? '').trim();
            // Tesseract confidence is 0–100; normalize to 0–1.
            confidence = Math.max(0, Math.min(1, (result?.data?.confidence ?? 0) / 100));
        } catch (err) {
            throw new ExtractorError(
                `OCR failed: ${(err as Error).message}`,
                'corrupt',
            );
        }

        // Low-confidence path: try cloud vision if a provider is
        // registered. Otherwise flag for downstream retry.
        let enrichedText = text;
        let fallbackUsed: string | undefined;
        let fallbackSuggested = false;
        if (confidence < 0.5) {
            if (cloudVisionProvider) {
                try {
                    const cloudResult = await cloudVisionProvider.describe(input, mimeType);
                    if (cloudResult.text.length > text.length || cloudResult.confidence > confidence) {
                        enrichedText = cloudResult.text;
                        confidence = cloudResult.confidence;
                        fallbackUsed = 'cloud-vision';
                    }
                } catch (cloudErr) {
                    console.error(`[image-extractor] cloud vision fallback failed: ${(cloudErr as Error).message}`);
                    fallbackSuggested = true;
                }
            } else {
                fallbackSuggested = true;
            }
        }

        return {
            // R4-DOS-03 — cap OCR/vision text to the 10 MB extracted-text budget.
            text: capText(enrichedText),
            metadata: {
                ocrEngine: `tesseract:${(workerLanguages ?? []).join('+') || 'eng'}`,
                ocrConfidence: confidence,
                fallbackUsed,
                fallbackSuggested,
            },
            confidence,
            mimeType,
            sourceBytes: input.byteLength,
            quality: fallbackSuggested
                ? {
                    reliable: false,
                    reason: 'low_ocr_confidence',
                    suggestedUpgrade: 'either',
                    upgradeMessage: `OCR confidence is low (${Math.round(confidence * 100)}%). The image may contain handwriting, non-Latin script, or poor lighting. A vision model will produce better results.`,
                }
                : undefined,
        };
    },
};
