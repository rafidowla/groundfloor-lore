/**
 * audio.ts — Audio transcription via Whisper (Phase 4 / C7).
 *
 * Uses @huggingface/transformers's automatic-speech-recognition pipeline
 * with Xenova/whisper-base.en (~150 MB model, downloaded on first use,
 * cached after). Good accuracy for clear English speech; falls down on
 * heavy accents, background noise, music-over-speech.
 *
 * Model choice:
 *   - whisper-tiny.en:  40 MB, fast but noticeably worse on phone calls
 *   - whisper-base.en:  150 MB, good default (this file's choice)
 *   - whisper-small.en: 500 MB, better accuracy — upgrade candidate
 *     (config knob, not yet exposed)
 *
 * What this extractor accepts:
 *   - audio/wav, audio/mpeg, audio/mp4, audio/x-m4a, audio/webm, audio/ogg
 *   - Video MIME types are handled by a separate video.ts extractor that
 *     pulls the audio track and forwards to this module.
 *
 * Performance characteristics:
 *   - First run: ~10 s model download + ~0.3× realtime transcription
 *   - Subsequent: 0.3× realtime (10 s of audio → ~3 s transcript)
 *   - Model loads lazily on first extract() call; stays in memory after.
 *
 * Scope note:
 *   - This extractor does NOT do speaker diarization. The Personal
 *     plugin's "who said what" use case requires a separate diarization
 *     model — deferred.
 *   - Long files (> 30 min): transcription is single-pass; no chunk
 *     progress events yet. User-facing CLI shows a spinner.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'node:crypto';

// Cache the loaded pipeline so subsequent calls don't re-initialize
// the model. The pipeline is expensive to load (~1 s warm, ~10 s cold).
let pipelinePromise: Promise<unknown> | null = null;

async function getPipeline(): Promise<unknown> {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            const { pipeline } = await import('@huggingface/transformers');
            return pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', {
                device: 'cpu',
            });
        })();
    }
    return pipelinePromise;
}

export const audioExtractor: IExtractor = {
    name: 'audio',
    mimeTypes: [
        'audio/wav',
        'audio/x-wav',
        'audio/mpeg',
        'audio/mp4',
        'audio/x-m4a',
        'audio/webm',
        'audio/ogg',
        'audio/flac',
    ],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('Audio is empty', 'empty');
        }

        // The transformers pipeline expects a URL, filepath, or
        // Float32Array. Easiest path: write to a temp file and hand
        // over the path. Cleanup in finally.
        const tmpPath = path.join(
            os.tmpdir(),
            `lore-audio-${randomBytes(8).toString('hex')}.${guessExtension(mimeType)}`,
        );
        fs.writeFileSync(tmpPath, input, { mode: 0o600 });

        try {
            let pipe: unknown;
            try {
                pipe = await getPipeline();
            } catch (err) {
                throw new ExtractorError(
                    `Whisper pipeline unavailable: ${(err as Error).message}`,
                    'unsupported',
                );
            }

            let text = '';
            try {
                // @ts-expect-error pipeline signature varies
                const result = await pipe(tmpPath, {
                    // Chunk long files — 30s chunks with 5s stride is the
                    // transformers.js recommended default for whisper.
                    chunk_length_s: 30,
                    stride_length_s: 5,
                });
                // Pipeline returns { text } for single-pass, or array for batches.
                if (typeof result === 'object' && result !== null && 'text' in result) {
                    text = String((result as { text: unknown }).text ?? '').trim();
                } else if (Array.isArray(result)) {
                    text = result.map((r) => String((r as { text?: unknown }).text ?? '')).join(' ').trim();
                }
            } catch (err) {
                throw new ExtractorError(
                    `Whisper transcription failed: ${(err as Error).message}`,
                    'corrupt',
                );
            }

            return {
                text,
                metadata: {
                    transcriber: 'whisper-base.en',
                    chunkLengthSec: 30,
                    strideSec: 5,
                    hasContent: text.length > 0,
                },
                // Whisper transcription has REAL uncertainty. ~0.85 is
                // a reasonable prior for clean English speech; downstream
                // can lower it when quality heuristics suggest noise.
                confidence: 0.85,
                mimeType,
                sourceBytes: input.byteLength,
            };
        } finally {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
    },
};

function guessExtension(mime: string): string {
    switch (mime) {
        case 'audio/wav':
        case 'audio/x-wav':   return 'wav';
        case 'audio/mpeg':    return 'mp3';
        case 'audio/mp4':
        case 'audio/x-m4a':   return 'm4a';
        case 'audio/webm':    return 'webm';
        case 'audio/ogg':     return 'ogg';
        case 'audio/flac':    return 'flac';
        default:              return 'bin';
    }
}
