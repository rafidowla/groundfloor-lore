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

import type { IExtractor, ExtractedContent, DetectedTable } from './types.js';
import { ExtractorError } from './types.js';
import { assertZipWithinBudget, assertZipRealBytesWithinBudget } from './zipGuard.js';
import { capText } from './textCap.js';
import { extractHtmlTables } from './htmlTables.js';

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

        // audit 2026-06-25 (HIGH, malicious-content DoS) — DOCX is an OOXML zip
        // and mammoth inflates entries internally with no size cap, so a small
        // "zip bomb" could OOM the daemon. The 2026-06-18 zip-guard covered
        // pptx/xlsx/epub but missed docx. Preflight the declared uncompressed
        // sizes with JSZip first; a non-zip input falls through to mammoth.
        try {
            const jszipMod = (await import('jszip')) as any;
            const JSZip = jszipMod.default ?? jszipMod;
            const zip = await JSZip.loadAsync(input);
            assertZipWithinBudget(zip, 'docx');
            await assertZipRealBytesWithinBudget(zip, 'docx'); // 4.1 — real-byte scan catches a lying header
        } catch (err) {
            if (/zip bomb|refusing to decompress/i.test((err as Error).message)) {
                throw new ExtractorError((err as Error).message, 'unsupported');
            }
            // Not a parseable zip → let mammoth handle/err appropriately.
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
        // Bucket C — detect tables via mammoth's HTML conversion (a
        // STRUCTURAL read: mammoth renders the doc's own <w:tbl> as <table>).
        // Best-effort and additive — a failure here must not fail the text
        // extraction, so it degrades to "no tables".
        let tables: DetectedTable[] = [];
        try {
            const htmlResult = await mammoth.convertToHtml({ buffer: input });
            tables = extractHtmlTables(htmlResult.value ?? '');
        } catch (err) {
            tables = [];
        }


        // mammoth messages include warnings about unknown styles etc.
        // We don't surface them to the LLM but include a count in
        // metadata for observability.
        const warnings = result.messages
            .filter((m) => m.type === 'warning')
            .map((m) => m.message);

        // F-E02 — cap total extracted text so a huge document can't blow memory.
        const cappedText = capText(result.value);

        const highWarnings = warnings.length > 5;
        // Very short text relative to file size suggests image-heavy doc
        // (embedded photos, charts) that text extraction silently drops.
        const bytesPerChar = result.value.length > 0
            ? input.byteLength / result.value.length
            : Infinity;
        const imageHeavy = result.value.length < 200 && input.byteLength > 100_000;

        return {
            text: cappedText, // F-E02
            metadata: {
                warningCount: warnings.length,
                warningSamples: warnings.slice(0, 3),
                bytesPerChar: isFinite(bytesPerChar) ? Math.round(bytesPerChar) : null,
            },
            confidence: highWarnings ? 0.7 : 1.0,
            mimeType,
            sourceBytes: input.byteLength,
            ...(tables.length > 0 ? { tables } : {}),
            quality: imageHeavy
                ? {
                    reliable: false,
                    reason: 'image_heavy_doc',
                    suggestedUpgrade: 'either',
                    upgradeMessage: `DOCX extracted very little text (${result.value.length} chars from ${Math.round(input.byteLength / 1024)} KB) — document may be image-heavy. A vision model can read embedded images.`,
                }
                : highWarnings
                ? {
                    reliable: false,
                    reason: 'high_warning_count',
                    suggestedUpgrade: 'local_llm',
                    upgradeMessage: `DOCX had ${warnings.length} formatting warnings — structure or content may be partially lost. A local model can re-read the original with better fidelity.`,
                }
                : undefined,
        };
    },
};
