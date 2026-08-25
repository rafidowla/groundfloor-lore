/**
 * qualityAdvisor.ts — Maps extractor QualitySignals to user-facing upgrade advice.
 *
 * Checks what the machine can actually deliver (Ollama reachable? vision
 * model downloaded?) and returns a concrete recommendation rather than a
 * generic "upgrade suggested" message.
 *
 * Called only when an extractor flags reliable:false — happy path has zero
 * overhead. Ollama probe result is cached for 30 s to keep bulk ingestion fast.
 */

import { execFileSync, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 4.2 — async execFile for the long-running chandra OCR call. */
const execFileAsync = promisify(execFile);
import type { QualitySignal, QualityUpgradeHint } from './types.js';

// Vision-capable model name fragments (lowercase). Matched as substrings
// against Ollama's returned model names.
const VISION_MODEL_FRAGMENTS = ['qwen3-vl', 'qwen2.5vl', 'llava', 'minicpm-v', 'gemma4', 'internvl'];
const TEXT_MODEL_FRAGMENTS   = ['qwen3', 'qwen2.5', 'llama', 'mistral', 'gemma', 'phi'];

export interface MachineCapabilities {
    ollamaReachable: boolean;
    visionModel: string | null;   // first matching vision model name, or null
    textModel:   string | null;   // first matching text model name, or null
    chandraAvailable: boolean;    // chandra CLI on PATH
}

export interface UpgradeAdvice {
    /** Short label for the recommended action */
    action: 'use_chandra' | 'use_local_vision' | 'use_local_text' | 'use_cloud' | 'setup_needed';
    /** Specific model name to suggest, if known */
    modelHint?: string;
    /** Full human-readable message for the UI */
    message: string;
}

// --- Ollama probe cache ---
let _cachedCaps: MachineCapabilities | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 30_000;

// --- Chandra probe cache (longer TTL — binary presence changes rarely) ---
let _chandraAvailable: boolean | null = null;

function probeChandraSync(): boolean {
    if (_chandraAvailable !== null) return _chandraAvailable;
    try {
        execFileSync('chandra', ['--version'], { timeout: 3000, stdio: 'pipe' });
        _chandraAvailable = true;
    } catch {
        // Not on PATH or not installed
        _chandraAvailable = false;
    }
    return _chandraAvailable;
}

export async function probeMachineCapabilities(): Promise<MachineCapabilities> {
    const now = Date.now();
    if (_cachedCaps && now < _cacheExpiry) return _cachedCaps;

    let models: string[] = [];
    let reachable = false;
    try {
        const r = await fetch('http://localhost:11434/api/tags', {
            signal: AbortSignal.timeout(500),
        });
        if (r.ok) {
            reachable = true;
            const data = await r.json() as { models?: Array<{ name: string }> };
            models = (data.models ?? []).map((m) => m.name.toLowerCase());
        }
    } catch {
        // Ollama not running or not installed — not an error
    }

    const visionModel = reachable
        ? (models.find((m) => VISION_MODEL_FRAGMENTS.some((f) => m.includes(f))) ?? null)
        : null;
    const textModel = reachable
        ? (models.find((m) => TEXT_MODEL_FRAGMENTS.some((f) => m.includes(f))) ?? null)
        : null;

    _cachedCaps = {
        ollamaReachable: reachable,
        visionModel,
        textModel,
        chandraAvailable: probeChandraSync(),
    };
    _cacheExpiry = now + CACHE_TTL_MS;
    return _cachedCaps;
}

/** Invalidate the capability cache (e.g. after a user installs a new model). */
export function invalidateCapabilityCache(): void {
    _cachedCaps = null;
    _cacheExpiry = 0;
    _chandraAvailable = null; // re-probe chandra on next call too
}

/**
 * invokeChandraOcr — Run the `chandra` CLI on a buffer and return the
 * extracted Markdown text.
 *
 * Chandra CLI: `chandra <input_file> <output_dir>`
 * Output: <output_dir>/<basename>.md
 *
 * Supported inputs: images (PNG, JPEG, WebP) and PDFs.
 * Throws if chandra is not installed or the subprocess fails.
 */
export async function invokeChandraOcr(
    input: Buffer,
    mimeType: string,
): Promise<string> {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const ext = mimeType === 'application/pdf' ? '.pdf'
        : mimeType === 'image/png'  ? '.png'
        : mimeType === 'image/jpeg' ? '.jpg'
        : mimeType === 'image/webp' ? '.webp'
        : '.png';

    const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-chandra-'));
    const inFile   = path.join(tmpDir, `input${ext}`);
    const outDir   = path.join(tmpDir, 'out');

    try {
        fs.mkdirSync(outDir);
        fs.writeFileSync(inFile, input);

        await execFileAsync('chandra', [inFile, outDir], {
            timeout: 300_000, // 5 min for large PDFs on CPU
        });

        // Chandra writes <basename>.md into outDir
        const outFile = path.join(outDir, `input${ext.replace(/\.\w+$/, '.md')}`);
        const mdFile  = fs.existsSync(outFile) ? outFile
            : fs.readdirSync(outDir).find((f: string) => f.endsWith('.md'));

        if (!mdFile) throw new Error('chandra produced no markdown output');
        const resolved = typeof mdFile === 'string' && path.isAbsolute(mdFile)
            ? mdFile
            : path.join(outDir, mdFile as string);
        return fs.readFileSync(resolved, 'utf8').trim();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Build a concrete upgrade recommendation given a quality signal and
 * the current machine capabilities.
 *
 * Returns null if quality is reliable (callers should guard, but being
 * defensive here avoids crashes if called unconditionally).
 */
export function buildUpgradeAdvice(
    quality: QualitySignal,
    caps: MachineCapabilities,
): UpgradeAdvice | null {
    if (quality.reliable) return null;

    const hint: QualityUpgradeHint = quality.suggestedUpgrade ?? 'either';
    const reason = quality.reason;

    // Reasons that need a vision model
    const needsVision = reason === 'scanned_pdf'
        || reason === 'low_ocr_confidence'
        || reason === 'image_heavy_doc';

    // Reasons where a text model is sufficient
    const textSufficient = reason === 'high_warning_count' || reason === 'sparse_pdf';

    // Audio: Ollama text/vision models don't transcribe — always cloud
    // (user would need whisper-large-v3 installed separately)
    if (reason === 'short_transcript') {
        return {
            action: 'use_cloud',
            message:
                `${quality.upgradeMessage ?? 'Audio quality is low.'} ` +
                `For better transcription, use a cloud model (Gemini 2.5 Pro handles non-English ` +
                `and noisy audio natively) or install whisper-large-v3 locally via whisper.cpp.`,
        };
    }

    // Vision needed — Chandra > Ollama vision > cloud
    // Chandra 2 is preferred for South Asian scripts, handwriting, and complex
    // layouts. Ollama vision (qwen3-vl) is the fallback when Chandra is not
    // installed. Cloud is the last resort.
    if (needsVision) {
        if (caps.chandraAvailable) {
            return {
                action: 'use_chandra',
                modelHint: 'chandra',
                message:
                    `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                    `Chandra OCR is installed — re-process locally for better results ` +
                    `(supports handwriting, South Asian scripts, tables, and complex layouts).`,
            };
        }
        if (caps.visionModel) {
            return {
                action: 'use_local_vision',
                modelHint: caps.visionModel,
                message:
                    `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                    `Local vision model detected: ${caps.visionModel}. ` +
                    `Re-process with Local AI to extract content from images. ` +
                    `For South Asian or handwritten text, consider also installing Chandra OCR ` +
                    `(pip install chandra-ocr) for better accuracy.`,
            };
        }
        if (!caps.ollamaReachable) {
            return {
                action: 'setup_needed',
                message:
                    `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                    `To process this locally: install Chandra OCR (pip install chandra-ocr) ` +
                    `for best South Asian/handwriting support, or install Ollama + qwen3-vl:32b ` +
                    `for general vision. Or use a cloud model (Gemini 2.5 Pro).`,
            };
        }
        // Ollama running but no vision model and no chandra
        return {
            action: 'setup_needed',
            modelHint: 'qwen3-vl:32b',
            message:
                `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                `Options: install Chandra OCR (pip install chandra-ocr) for best accuracy, ` +
                `or pull a vision model (ollama pull qwen3-vl:32b), or use a cloud model.`,
        };
    }

    // Text model sufficient
    if (textSufficient) {
        if (hint === 'cloud_llm') {
            return {
                action: 'use_cloud',
                message:
                    `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                    `Re-process with a cloud model for better structure recovery.`,
            };
        }
        if (caps.textModel) {
            return {
                action: 'use_local_text',
                modelHint: caps.textModel,
                message:
                    `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                    `Local model detected: ${caps.textModel}. ` +
                    `Re-process with Local AI to recover document structure.`,
            };
        }
        return {
            action: 'use_cloud',
            message:
                `${quality.upgradeMessage ?? 'Extraction quality is low.'} ` +
                `No local model available — use a cloud model to recover document structure.`,
        };
    }

    // Fallback for any unhandled reason
    const fallbackAction = caps.chandraAvailable ? 'use_chandra'
        : caps.visionModel ? 'use_local_vision'
        : caps.textModel   ? 'use_local_text'
        : 'use_cloud';
    return {
        action: fallbackAction,
        modelHint: caps.chandraAvailable ? 'chandra' : caps.visionModel ?? caps.textModel ?? undefined,
        message: quality.upgradeMessage ?? 'Extraction quality may be low. Consider re-processing with a better model.',
    };
}

// ── Full capability probe (first-run wizard) ──────────────────────────────

export interface CapabilitySuggestion {
    id: string;
    name: string;
    description: string;
    installCommand: string;
    requiredRamGB?: number;
    canInstall: boolean;
}

export interface FullCapabilities {
    tier1: {
        alwaysAvailable: true;
        formats: string[];
    };
    tier2: {
        ffmpeg:     { available: boolean; version?: string };
        whisperCpp: { available: boolean };
        chandra:    { available: boolean };
        ollama: {
            reachable: boolean;
            textModel:       string | null;
            visionModel:     string | null;
            installedModels: string[];
        };
    };
    system: {
        platform:   string;
        arch:       string;
        totalRamGB: number;
    };
    suggestions: CapabilitySuggestion[];
}

function probeFfmpeg(): { available: boolean; version?: string } {
    try {
        const out = execFileSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 3000 })
            .toString()
            .split('\n')[0]; // "ffmpeg version 7.1 ..."
        const m = out.match(/version\s+(\S+)/i);
        return { available: true, version: m?.[1] };
    } catch {
        return { available: false };
    }
}

function probeWhisperCpp(): { available: boolean } {
    for (const bin of ['whisper', 'whisper-cpp', 'main']) {
        try {
            const r = spawnSync('which', [bin], { encoding: 'utf8', timeout: 1000 });
            if (r.status === 0 && r.stdout?.trim()) return { available: true };
        } catch { /* keep trying */ }
    }
    return { available: false };
}

export async function probeFullCapabilities(): Promise<FullCapabilities> {
    const os = await import('node:os');
    const totalRamGB = Math.round(os.totalmem() / (1024 ** 3));

    const basic = await probeMachineCapabilities();

    // Fetch installed model list for display
    let installedModels: string[] = [];
    if (basic.ollamaReachable) {
        try {
            const r = await fetch('http://localhost:11434/api/tags', {
                signal: AbortSignal.timeout(500),
            });
            if (r.ok) {
                const data = await r.json() as { models?: Array<{ name: string }> };
                installedModels = (data.models ?? []).map(m => m.name);
            }
        } catch { /* ignore */ }
    }

    const ffmpeg     = probeFfmpeg();
    const whisperCpp = probeWhisperCpp();

    // Build suggestions for gaps
    const suggestions: CapabilitySuggestion[] = [];

    if (!basic.ollamaReachable) {
        suggestions.push({
            id: 'ollama',
            name: 'Ollama (local AI runtime)',
            description: 'Runs text and vision models locally. Unlocks document Q&A, scanned PDF recovery, and property walkthrough descriptions.',
            installCommand: 'brew install ollama && ollama serve',
            canInstall: true,
        });
    } else if (!basic.textModel) {
        suggestions.push({
            id: 'text-model',
            name: 'Text model (qwen3:30b-a3b)',
            description: 'Powers document cleanup and knowledge graph Q&A. ~18 GB RAM.',
            installCommand: 'ollama pull qwen3:30b-a3b',
            requiredRamGB: 18,
            canInstall: totalRamGB >= 18,
        });
    }

    if (basic.ollamaReachable && !basic.visionModel) {
        suggestions.push({
            id: 'vision-model',
            name: 'Vision model (qwen3-vl:32b)',
            description: 'Describes scenes in property walkthroughs and recovers text from scanned PDFs and photos. ~20 GB RAM.',
            installCommand: 'ollama pull qwen3-vl:32b',
            requiredRamGB: 20,
            canInstall: totalRamGB >= 20,
        });
    }

    if (!ffmpeg.available) {
        suggestions.push({
            id: 'ffmpeg',
            name: 'ffmpeg',
            description: 'Enables video property walkthroughs — extracts frames and audio from MP4/MOV files.',
            installCommand: 'brew install ffmpeg',
            canInstall: true,
        });
    }

    if (!whisperCpp.available) {
        suggestions.push({
            id: 'whisper-cpp',
            name: 'whisper.cpp (large-v3)',
            description: 'High-accuracy transcription with timestamps for audio and video. Replaces the built-in whisper-base.en.',
            installCommand: 'brew install whisper-cpp',
            canInstall: true,
        });
    }

    if (!basic.chandraAvailable) {
        suggestions.push({
            id: 'chandra',
            name: 'Chandra OCR 2',
            description: 'Best-in-class OCR for South Asian scripts (Hindi, Tamil, Bengali, etc.) and handwriting.',
            installCommand: 'pip install chandra-ocr',
            canInstall: true,
        });
    }

    return {
        tier1: {
            alwaysAvailable: true,
            formats: [
                'PDF', 'Word (DOCX)', 'Excel (XLSX)', 'PowerPoint (PPTX)',
                'HTML', 'EPUB', 'RTF', 'Email (EML)',
                'Images — PNG, JPEG, WebP, GIF (OCR)',
                'Audio — MP3, WAV, M4A (whisper-base.en)',
                'Video — MP4, MOV (frames + audio)',
                'CSV, TSV, YAML, TOML, XML, Markdown',
            ],
        },
        tier2: {
            ffmpeg,
            whisperCpp,
            chandra: { available: basic.chandraAvailable },
            ollama: {
                reachable:       basic.ollamaReachable,
                textModel:       basic.textModel,
                visionModel:     basic.visionModel,
                installedModels,
            },
        },
        system: {
            platform:   os.platform(),
            arch:       os.arch(),
            totalRamGB,
        },
        suggestions,
    };
}
