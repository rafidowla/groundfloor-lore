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

// Cache Tesseract worker between calls. Creating a worker is slow
// (~2 s), executing it is fast.
let workerPromise: Promise<unknown> | null = null;

async function getWorker(): Promise<unknown> {
    if (!workerPromise) {
        workerPromise = (async () => {
            const tesseract = await import('tesseract.js');
            // Create a single reusable English worker.
            const w = await tesseract.createWorker('eng');
            return w;
        })();
    }
    return workerPromise;
}

export const imageExtractor: IExtractor = {
    name: 'image',
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
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
            text: enrichedText,
            metadata: {
                ocrEngine: 'tesseract-eng',
                ocrConfidence: confidence,
                fallbackUsed,
                fallbackSuggested,
            },
            confidence,
            mimeType,
            sourceBytes: input.byteLength,
        };
    },
};
