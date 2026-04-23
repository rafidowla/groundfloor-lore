/**
 * docx.ts — DOCX text extraction via mammoth.
 *
 * mammoth.extractRawText gives us plain text suitable for embedding
 * — no style markup, no image placeholders. For richer rendering
 * (preserve headings/emphasis), mammoth.convertToHtml is available;
 * we may add a second pass later if downstream consumers want it,
 * but keeping extraction uniform with text/PDF/EML for now.
 *
 * Confidence: 1.0 — mammoth's raw-text mode is deterministic.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';

export const docxExtractor: IExtractor = {
    name: 'docx',
    mimeTypes: [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('DOCX is empty', 'empty');
        }

        let mammoth: any;
        try {
            mammoth = await import('mammoth');
        } catch (err) {
            throw new ExtractorError(
                `mammoth unavailable: ${(err as Error).message}`,
                'unsupported',
            );
        }

        let result: { value: string; messages: Array<{ type: string; message: string }> };
        try {
            result = await mammoth.extractRawText({ buffer: input });
        } catch (err) {
            throw new ExtractorError(
                `Failed to parse DOCX: ${(err as Error).message}`,
                'corrupt',
            );
        }

        // mammoth messages include warnings about unknown styles etc.
        // We don't surface them to the LLM but include a count in
        // metadata for observability.
        const warnings = result.messages
            .filter((m) => m.type === 'warning')
            .map((m) => m.message);

        return {
            text: result.value,
            metadata: {
                warningCount: warnings.length,
                // Include the first few warnings for debugging —
                // helpful when a doc has unusual formatting.
                warningSamples: warnings.slice(0, 3),
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
        };
    },
};
