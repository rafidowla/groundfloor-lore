/**
 * video.ts — Property walkthrough video extraction.
 *
 * Pipeline:
 *   1. ffmpeg: extract audio track → WAV
 *   2. whisper.cpp (large-v3) or whisper-base.en fallback → SRT transcript
 *      with per-segment timestamps
 *   3. ffmpeg: extract frames at adaptive rate (≤ 30 total)
 *   4. Skip near-identical consecutive frames (JPEG size proxy, <5% change)
 *   5. Ollama vision model: describe each key frame
 *   6. Assemble: scene headers, visual description, aligned transcript segment
 *
 * Graceful degradation:
 *   - No ffmpeg            → quality signal (install required)
 *   - No vision model      → transcript-only output + quality signal
 *   - No whisper / fallback → visual-only output
 *
 * Prerequisites: brew install ffmpeg  (vision: ollama pull qwen3-vl:32b)
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 4.2 — async execFile for the long-running ffmpeg/whisper calls. */
const execFileAsync = promisify(execFile);
import { findWhisperBin } from './whisperBin.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { capText } from './textCap.js';
import { invokeOllamaVision } from '../../providers/llmDispatch.js';
import { probeMachineCapabilities } from './qualityAdvisor.js';

// ── Binary probes ─────────────────────────────────────────────────────────

let _ffmpegBin: string | null | undefined = undefined;

function findFfmpegBin(): string | null {
    if (_ffmpegBin !== undefined) return _ffmpegBin;
    for (const bin of ['ffmpeg']) {
        try {
            execFileSync(bin, ['-version'], { stdio: 'pipe', timeout: 3000 });
            _ffmpegBin = bin;
            return bin;
        } catch { /* not found */ }
    }
    _ffmpegBin = null;
    return null;
}


// ── Video metadata ────────────────────────────────────────────────────────

function getVideoDuration(videoPath: string): number {
    try {
        const out = execFileSync('ffprobe', [
            '-v', 'quiet',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            videoPath,
        ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim();
        return parseFloat(out) || 0;
    } catch {
        return 0;
    }
}

// ── SRT parsing ───────────────────────────────────────────────────────────

export interface Segment { start: number; end: number; text: string }

export function parseSrt(srt: string): Segment[] {
    const segments: Segment[] = [];
    for (const block of srt.trim().split(/\n\n+/)) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const m = lines[1].match(
            /(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/,
        );
        const text = lines.slice(2).join(' ').trim();
        if (!m || !text) continue;
        const sec = (h: string, min: string, s: string, ms: string): number =>
            +h * 3600 + +min * 60 + +s + +ms / 1000;
        segments.push({
            start: sec(m[1], m[2], m[3], m[4]),
            end:   sec(m[5], m[6], m[7], m[8]),
            text,
        });
    }
    return segments;
}

export function segmentsNear(segs: Segment[], from: number, to: number): string {
    return segs.filter(s => s.start < to && s.end > from).map(s => s.text).join(' ').trim();
}

// ── Transcription ─────────────────────────────────────────────────────────

interface TranscriptResult {
    segments: Segment[];
    plain: string;
    model: string;
}

async function extractTranscript(
    ffmpegBin: string,
    videoPath: string,
    tmpDir: string,
): Promise<TranscriptResult> {
    const wavPath = path.join(tmpDir, 'audio.wav');
    try {
        await execFileAsync(ffmpegBin, [
            '-i', videoPath,
            '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
            wavPath,
        ], { timeout: 120_000 });
    } catch {
        return { segments: [], plain: '', model: 'none' };
    }

    // whisper.cpp path — outputs SRT alongside the WAV file
    const whisperBin = findWhisperBin();
    if (whisperBin) {
        const srtPath = `${wavPath}.srt`;
        try {
            await execFileAsync(whisperBin, [
                '--model', 'large-v3',
                '--output-srt',
                '--file', wavPath,
                '--no-prints',
            ], { timeout: 600_000 });
            if (fs.existsSync(srtPath)) {
                const segments = parseSrt(fs.readFileSync(srtPath, 'utf8'));
                try { fs.unlinkSync(srtPath); } catch { /* ignore */ }
                return {
                    segments,
                    plain: segments.map(s => s.text).join(' '),
                    model: 'whisper-large-v3',
                };
            }
        } catch { /* fall through to transformers */ }
        try { if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); } catch { /* ignore */ }
    }

    // transformers.js fallback — no timestamps
    try {
        const { pipeline } = await import('@huggingface/transformers');
        const pipe = await (pipeline as Function)(
            'automatic-speech-recognition', 'Xenova/whisper-base.en', { device: 'cpu' },
        );
        const result = await pipe(wavPath, { chunk_length_s: 30, stride_length_s: 5 }) as { text?: string };
        const plain = String(result?.text ?? '').trim();
        return { segments: [], plain, model: 'whisper-base.en' };
    } catch {
        return { segments: [], plain: '', model: 'none' };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function extensionForMime(mime: string): string {
    if (mime.includes('quicktime')) return '.mov';
    if (mime.includes('matroska')) return '.mkv';
    if (mime.includes('webm'))     return '.webm';
    if (mime.includes('avi') || mime.includes('msvideo')) return '.avi';
    return '.mp4';
}

const SCENE_PROMPT = (timestamp: string): string =>
    `Frame at ${timestamp} from a property walkthrough video. ` +
    `Describe in 2-3 sentences: room type, key architectural features ` +
    `(flooring, ceiling, windows, built-ins), notable assets (appliances, ` +
    `fixtures), any visible condition issues. Output only the description.`;

// ── Extractor ─────────────────────────────────────────────────────────────

export const videoExtractor: IExtractor = {
    name: 'video',
    mimeTypes: [
        'video/mp4',
        'video/quicktime',
        'video/x-matroska',
        'video/webm',
        'video/avi',
        'video/x-msvideo',
    ],

    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) throw new ExtractorError('Video is empty', 'empty');

        const ffmpegBin = findFfmpegBin();
        if (!ffmpegBin) {
            return {
                text: '',
                metadata: {},
                confidence: 0,
                mimeType,
                sourceBytes: input.byteLength,
                quality: {
                    reliable: false,
                    reason: 'sparse_pdf',
                    suggestedUpgrade: 'either',
                    upgradeMessage:
                        'Video extraction requires ffmpeg. Install it with: brew install ffmpeg',
                },
            };
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-video-'));
        try {
            const videoPath = path.join(tmpDir, `input${extensionForMime(mimeType)}`);
            fs.writeFileSync(videoPath, input);

            // Duration — needed for adaptive frame rate; 0 is safe (defaults to 5 s step)
            const duration = getVideoDuration(videoPath);

            // Transcript with per-segment timestamps when whisper.cpp is available
            const { segments, plain: transcriptPlain, model: audioModel } =
                await extractTranscript(ffmpegBin, videoPath, tmpDir);

            // Adaptive frame extraction — at most 30 frames regardless of duration
            const frameStepSec = duration > 0 ? Math.max(2, Math.ceil(duration / 30)) : 5;
            const framesDir = path.join(tmpDir, 'frames');
            fs.mkdirSync(framesDir);
            try {
                await execFileAsync(ffmpegBin, [
                    '-i', videoPath,
                    '-vf', `fps=1/${frameStepSec},scale=1280:-1`,
                    '-q:v', '5',
                    path.join(framesDir, 'frame_%04d.jpg'),
                ], { timeout: 120_000 });
            } catch { /* frame extraction failed — continue with audio only */ }

            const frameFiles = fs.readdirSync(framesDir)
                .filter(f => f.endsWith('.jpg'))
                .sort();

            // Vision descriptions — Chandra handles stills better but needs file path;
            // for in-process use we go through Ollama vision here.
            const caps = await probeMachineCapabilities();
            const visionModel = caps.visionModel;

            interface Scene { timestampSec: number; description: string; transcript: string }
            const scenes: Scene[] = [];

            if (visionModel && frameFiles.length > 0) {
                let prevSize = 0;
                for (let i = 0; i < frameFiles.length; i++) {
                    const framePath = path.join(framesDir, frameFiles[i]);
                    const currSize = fs.statSync(framePath).size;

                    // Skip near-identical frames — JPEG size correlates with visual complexity.
                    // <5% size change between consecutive frames → skip (camera barely moved).
                    if (i > 0 && Math.abs(currSize - prevSize) / Math.max(currSize, prevSize) < 0.05) {
                        prevSize = currSize;
                        continue;
                    }
                    prevSize = currSize;

                    const timestampSec = i * frameStepSec;
                    const ts = formatTime(timestampSec);
                    try {
                        const frameBuf = fs.readFileSync(framePath);
                        const desc = await invokeOllamaVision(
                            frameBuf, 'image/jpeg', visionModel, SCENE_PROMPT(ts),
                        );
                        if (desc.length > 10) {
                            scenes.push({
                                timestampSec,
                                description: desc,
                                transcript: segments.length > 0
                                    ? segmentsNear(segments, timestampSec, timestampSec + frameStepSec)
                                    : '',
                            });
                        }
                    } catch { /* failed frame — skip silently */ }
                }
            }

            // Assemble output
            const lines: string[] = [
                '# Video Walkthrough',
                [
                    duration > 0 ? `Duration: ${formatTime(duration)}` : null,
                    `Frames: ${frameFiles.length} captured, ${scenes.length} described`,
                    `Audio: ${audioModel}`,
                    visionModel ? `Vision: ${visionModel}` : null,
                ].filter(Boolean).join(' | '),
            ];

            if (scenes.length > 0) {
                for (const scene of scenes) {
                    lines.push(`\n## Scene at ${formatTime(scene.timestampSec)}`);
                    lines.push(`**Visual**: ${scene.description}`);
                    if (scene.transcript) lines.push(`**Audio**: ${scene.transcript}`);
                }
                // Append any transcript not covered by scene windows
                if (segments.length === 0 && transcriptPlain) {
                    lines.push(`\n## Full Transcript\n${transcriptPlain}`);
                }
            } else if (transcriptPlain) {
                lines.push(`\n## Transcript\n${transcriptPlain}`);
            }

            // R4-DOS-02 — cap to the 10 MB extracted-text budget.
            const text = capText(lines.join('\n'));
            const hasVision    = scenes.length > 0;
            const hasTranscript = transcriptPlain.length > 0;

            return {
                text,
                metadata: {
                    duration,
                    framesCaptured: frameFiles.length,
                    scenesDescribed: scenes.length,
                    audioModel,
                    visionModel: visionModel ?? null,
                    hasTimestamps: segments.length > 0,
                },
                confidence: hasVision ? 0.9 : hasTranscript ? 0.75 : 0.3,
                mimeType,
                sourceBytes: input.byteLength,
                quality: !hasVision && !caps.visionModel
                    ? {
                        reliable: false,
                        reason: 'image_heavy_doc',
                        suggestedUpgrade: 'local_llm',
                        upgradeMessage:
                            `Video has ${frameFiles.length} frames but no vision model is available ` +
                            `for scene descriptions. Install Ollama + qwen3-vl:32b for full ` +
                            `property walkthrough extraction.`,
                    }
                    : (!hasVision && !hasTranscript)
                    ? {
                        reliable: false,
                        reason: 'sparse_pdf',
                        suggestedUpgrade: 'either',
                        upgradeMessage:
                            'Could not extract content from this video. ' +
                            'Check that ffmpeg is installed and the file is not corrupted.',
                    }
                    : undefined,
            };
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    },
};
