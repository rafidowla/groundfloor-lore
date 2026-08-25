/**
 * audio.ts — Audio transcription via Whisper (Phase 4 / C7).
 *
 * Two-tier transcription strategy:
 *
 *   Tier 1 — whisper.cpp binary (large-v3 model, ~3 GB):
 *     Probed at first use via `which whisper` / `whisper --version`.
 *     If installed: used for ALL audio. ~1× realtime on Apple Silicon
 *     via Metal, multilingual, word-level timestamps. Preferred path.
 *
 *   Tier 1 fallback — @huggingface/transformers (whisper-base.en, ~150 MB):
 *     Used when whisper.cpp is not on PATH. English-only, ~0.3× realtime.
 *     Flags low-quality results via QualitySignal so callers can suggest
 *     installing whisper.cpp or routing to cloud.
 *
 * What this extractor accepts:
 *   - audio/wav, audio/mpeg, audio/mp4, audio/x-m4a, audio/webm, audio/ogg
 *
 * Scope note:
 *   - No speaker diarization (deferred).
 *   - Long files (> 30 min): single-pass; no chunk progress events.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { capText } from './textCap.js';
import { ExtractorError } from './types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 4.2 — async execFile (event loop stays free during the subprocess). */
const execFileAsync = promisify(execFile);
import { findWhisperBin } from './whisperBin.js';

async function transcribeWithWhisperCpp(tmpPath: string): Promise<{ text: string; model: string }> {
    const bin = findWhisperBin()!;
    // whisper.cpp CLI: whisper --model large-v3 --output-txt --file <path>
    // Output is written to <path>.txt alongside the input file.
    const outTxt = `${tmpPath}.txt`;
    try {
        await execFileAsync(bin, [
            '--model', 'large-v3',
            '--output-txt',
            '--file', tmpPath,
            '--no-prints',   // suppress progress bars to stderr
        ], { timeout: 600_000 }); // 10 min max for long files
        const text = fs.existsSync(outTxt)
            ? fs.readFileSync(outTxt, 'utf8').trim()
            : '';
        return { text, model: 'whisper-large-v3' };
    } finally {
        try { if (fs.existsSync(outTxt)) fs.unlinkSync(outTxt); } catch { /* ignore */ }
    }
}

// ─── transformers.js fallback ────────────────────────────────────────────────

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

async function transcribeWithTransformers(tmpPath: string): Promise<{ text: string; model: string }> {
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
        const result = await pipe(tmpPath, { chunk_length_s: 30, stride_length_s: 5 });
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
    return { text, model: 'whisper-base.en' };
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
            const usingCpp = findWhisperBin() !== null;
            const { text, model } = usingCpp
                ? await transcribeWithWhisperCpp(tmpPath)
                : await transcribeWithTransformers(tmpPath);

            const bytesPerChar = text.length > 0 ? input.byteLength / text.length : Infinity;
            // Flag short results only when using the fallback base model —
            // whisper-large-v3 via whisper.cpp is authoritative even if sparse.
            const isShort = !usingCpp && text.length < 100 && input.byteLength > 50_000;

            return {
                // R4-DOS-01 — cap to the 10 MB extracted-text budget (mirrors
                // the doc/text extractors); a long transcript is caller-reachable.
                text: capText(text),
                metadata: {
                    transcriber: model,
                    usingWhisperCpp: usingCpp,
                    hasContent: text.length > 0,
                    bytesPerChar: isFinite(bytesPerChar) ? Math.round(bytesPerChar) : null,
                },
                confidence: usingCpp ? 0.95 : isShort ? 0.4 : 0.85,
                mimeType,
                sourceBytes: input.byteLength,
                quality: isShort
                    ? {
                        reliable: false,
                        reason: 'short_transcript',
                        suggestedUpgrade: 'either',
                        upgradeMessage: `Audio produced very little text (${text.length} chars from ${Math.round(input.byteLength / 1024)} KB). whisper-base.en is English-only — install whisper.cpp for multilingual support, or use a cloud model.`,
                    }
                    : undefined,
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
