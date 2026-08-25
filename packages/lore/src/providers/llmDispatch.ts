/**
 * llmDispatch.ts — Minimal BYOK LLM streaming dispatcher for /api/chat.
 *
 * Purpose:
 *   Route a single user message to the configured LLM provider and yield
 *   content chunks as they arrive. The surface is deliberately tiny for
 *   Phase 0; Phase 2+ will extend this to handle file uploads and
 *   capability manifests.
 *
 * Supported providers:
 *   - ollama     → POST http://localhost:11434/api/chat (streams NDJSON)
 *   - anthropic  → POST https://api.anthropic.com/v1/messages (SSE)
 *   - openai     → POST https://api.openai.com/v1/chat/completions (SSE)
 *
 * Capability manifest (Phase 2 consumer):
 *   Each provider also reports text/multimodal acceptance so /api/extract
 *   can gate file uploads against what the active model actually handles.
 *
 * Side Effects: Network calls to the configured provider.
 * Error Behavior: Yields { kind: "error", message } instead of throwing;
 *                 the caller serializes errors as SSE error frames.
 * Determinism: Non-deterministic (LLM output).
 */

import { loreHomePath } from '../config/loreHome.js';

export type LlmProvider = 'embedded' | 'anthropic' | 'openai' | 'ollama' | 'local-llama' | string;

export interface LlmChunk {
    kind: 'token' | 'done' | 'error' | 'model_loading';
    content?: string;
    message?: string;
    /** Download/progress fraction in [0, 1] for 'model_loading' frames. */
    progress?: number;
    /** File being downloaded, e.g. "onnx/decoder_model_merged_quantized.onnx". */
    file?: string;
    /** Human-readable status tag: "download" | "ready". */
    status?: string;
}

/**
 * Tool-calling capability tier for a given model.
 *
 * V2.2 (2026-04-20): three-tier model. Pure plumbing for now —
 * consumed by future chat UI work to decide whether to (a) invoke
 * native function calls, (b) emit structured `{{action:...}}`
 * suggestion tokens the UI renders as buttons, or (c) stay in
 * text-only mode.
 *
 *   'native'          — reliable function-calling. Claude 3.5+,
 *                       GPT-4o / o-series, Gemma 3 4B+, Qwen3 1.7B+.
 *   'suggestion_only' — emits `{{action:...}}` tokens for UI to
 *                       render as buttons. User confirms per action.
 *                       Gemma 3 1B (our embedded default), smaller
 *                       local models, unknown Ollama models.
 *   'none'            — pure text generation; no structured output
 *                       expected. Fallback for truly limited models.
 *
 * Safety property: a model classified as 'suggestion_only' or 'none'
 * MUST NOT be granted native function-calling even if future BYOK
 * wiring makes it available. Reverse is also true — 'native' models
 * can still emit suggestion tokens if the prompt asks; both patterns
 * coexist per consumer choice.
 */
export type ToolCapability = 'native' | 'suggestion_only' | 'none';

export interface LlmCapability {
    provider: LlmProvider;
    model: string;
    acceptsText: boolean;
    acceptsImages: boolean;
    acceptedMimeTypes: string[];
    toolCalling: ToolCapability;
}

/**
 * Parse an integer env var with a fallback default.
 * Returns the default when the var is unset, empty, or not a valid integer.
 */
function parseEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Embedded model ID — env override: LORE_EMBEDDED_MODEL.
 * Default: 'onnx-community/gemma-3-1b-it-ONNX' (Gemma 3 1B, V2.2 2026-04-20).
 */
const EMBEDDED_MODEL_DEFAULT = 'onnx-community/gemma-3-1b-it-ONNX';
function getEmbeddedModel(): string {
    return process.env.LORE_EMBEDDED_MODEL || EMBEDDED_MODEL_DEFAULT;
}

/**
 * Ollama context window size — env override: LORE_LLM_NUM_CTX.
 * Default: 32768. Forces a larger context so the system prompt is not silently truncated.
 */
const OLLAMA_NUM_CTX_DEFAULT = 32768;
function getOllamaNumCtx(): number {
    return parseEnvInt('LORE_LLM_NUM_CTX', OLLAMA_NUM_CTX_DEFAULT);
}

/**
 * Anthropic max_tokens — env override: LORE_LLM_MAX_TOKENS.
 * Default: 1024.
 */
const ANTHROPIC_MAX_TOKENS_DEFAULT = 1024;
function getAnthropicMaxTokens(): number {
    return parseEnvInt('LORE_LLM_MAX_TOKENS', ANTHROPIC_MAX_TOKENS_DEFAULT);
}

/**
 * Ollama LLM host — env override: LORE_OLLAMA_HOST.
 * Default: 'http://localhost:11434' (mirrors pickEmbeddingProvider.ts pattern
 * which reads OLLAMA_HOST || LORE_OLLAMA_HOST || 'http://127.0.0.1:11434').
 * Only the LLM dispatch path uses this; embedding uses pickEmbeddingProvider.
 *
 * hc-ollama-llm-host-hardcoded (NW-7c).
 */
const OLLAMA_LLM_HOST_DEFAULT = 'http://localhost:11434';
export function getOllamaLlmHost(): string {
    return process.env.LORE_OLLAMA_HOST || OLLAMA_LLM_HOST_DEFAULT;
}

const DEFAULT_MODELS: Record<string, string> = {
    // V2.2 upgrade (2026-04-20): Gemma 3 1B — better instruction-following
    // (IFEval ~80), stays in-context well, Apache-compatible license,
    // ~0.8 GB on disk q4f16, ~1.2-1.5 GB resident. Overrideable via
    // LORE_EMBEDDED_MODEL. See DECISIONS.md entry dated 2026-04-20.
    embedded: EMBEDDED_MODEL_DEFAULT,
    anthropic: 'claude-3-5-sonnet-latest',
    openai: 'gpt-4o-mini',
    ollama: 'qwen3-coder:30b',  // demo 2026-05-04: switched from qwen3:30b-a3b to coder for tenant graph traversal
    openrouter: 'deepseek/deepseek-chat',
};

/**
 * isEmbeddedCapable — True when the provider is "embedded" (built-in Gemma 3 1B).
 * Used by the UI to decide whether to show the upgrade nudge banner.
 */
export function isEmbeddedCapable(provider: LlmProvider): boolean {
    return provider === 'embedded';
}

/**
 * getCapability — Returns the capability manifest for a provider/model.
 *
 * For Phase 0 / Phase 2 we hard-code known families. This is good enough
 * to decide text-only vs multimodal. When a new model is introduced the
 * table expands; no user-visible change.
 */
export function getCapability(provider: LlmProvider, model?: string): LlmCapability {
    const resolvedModel = model ?? DEFAULT_MODELS[provider] ?? 'unknown';
    const lower = resolvedModel.toLowerCase();

    // Embedded Gemma 3 1B is text-only; no image/audio capability.
    // Tool-calling is syntactically supported by Gemma 3 but unreliable
    // at the 1B tier — classify as 'suggestion_only' so future UI work
    // renders action-suggestion buttons instead of invoking tools.
    if (provider === 'embedded') {
        return {
            provider,
            model: resolvedModel,
            acceptsText: true,
            acceptsImages: false,
            acceptedMimeTypes: ['text/plain', 'text/markdown'],
            toolCalling: 'suggestion_only',
        };
    }

    // Multimodal families — models that accept image input
    const multimodal =
        lower.includes('claude-3') ||
        lower.includes('claude-4') ||
        lower.includes('gpt-4o') ||
        lower.includes('gpt-4-vision') ||
        lower.includes('llava') ||
        lower.includes('llama3.2-vision') ||
        lower.includes('qwen3-vl') ||       // Qwen3-VL vision-language family
        lower.includes('qwen2.5vl') ||      // Qwen2.5-VL vision-language family
        lower.includes('gemma4') ||         // Gemma 4 (all sizes accept images)
        lower.includes('minicpm-v') ||
        lower.includes('internvl');

    // Tool-calling tier per model family. Keep conservative: a model
    // only earns 'native' when it's a known-reliable function-caller.
    // Everything else (incl. unknown Ollama models) defaults to
    // 'suggestion_only' — UI treats it as prompt-for-buttons.
    const toolCalling: ToolCapability =
        // Anthropic: Claude 3.5+ and Claude 4+ are native tool-callers.
        (provider === 'anthropic' && (lower.includes('claude-3-5') || lower.includes('claude-4') || lower.includes('claude-sonnet-4') || lower.includes('claude-opus-4')))
            ? 'native'
        // OpenAI: GPT-4o / o-series are native tool-callers.
        : (provider === 'openai' && (lower.includes('gpt-4o') || lower.includes('gpt-5') || lower.startsWith('o1') || lower.startsWith('o3')))
            ? 'native'
        // OpenRouter: any model with a known-tool-calling prefix is native.
        // Slugs look like "deepseek/...", "anthropic/...", "openai/...", "meta-llama/...".
        : (provider === 'openrouter' && (
            lower.startsWith('deepseek/') ||
            lower.startsWith('anthropic/') ||
            lower.startsWith('openai/') ||
            lower.includes('llama-3') || lower.includes('llama3') ||
            lower.includes('qwen')
          ))
            ? 'native'
        // Ollama: conservative — depends heavily on loaded model. A few
        // model families are known-reliable function-callers under Ollama;
        // most aren't. Default suggestion_only unless explicitly on the list.
        : (provider === 'ollama' && (
            lower.includes('llama3.1') ||   // llama3.1:8b, llama3.1:70b — Meta's
            lower.includes('llama3.2') ||   // function-calling-tuned line; reliable
            lower.includes('llama3.3') ||   // tool callers across 8B/70B sizes
            lower.includes('qwen3') ||      // qwen3:30b-a3b, qwen3-vl:32b, etc.
            lower.includes('qwen2.5vl') ||
            lower.includes('gemma3:4b') || lower.includes('gemma3:12b') || lower.includes('gemma3:27b') ||
            lower.includes('gemma4') ||
            lower.includes('mistral')
          ))
            ? 'native'
        : 'suggestion_only';

    return {
        provider,
        model: resolvedModel,
        acceptsText: true,
        acceptsImages: multimodal,
        acceptedMimeTypes: multimodal
            ? ['text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']
            : ['text/plain', 'text/markdown'],
        toolCalling,
    };
}

/**
 * stream — Sends a single user message to the provider and yields chunks.
 *
 * Caller responsibility: serialize chunks into SSE frames.
 */
export async function* stream(
    provider: LlmProvider,
    message: string,
    apiKey: string | null,
    model?: string,
): AsyncGenerator<LlmChunk> {
    // For the embedded provider, always resolve the model via getEmbeddedModel()
    // so that LORE_EMBEDDED_MODEL is respected even when `model` is not passed.
    const resolvedModel = provider === 'embedded'
        ? (model ?? getEmbeddedModel())
        : (model ?? DEFAULT_MODELS[provider] ?? '');

    try {
        if (provider === 'embedded') {
            yield* streamEmbedded(message, resolvedModel);
            return;
        }

        if (provider === 'ollama') {
            yield* streamOllama(message, resolvedModel);
            return;
        }

        // M6 — node-llama-cpp GGUF (local-llama) path removed in TW-6b
        // along with the chat surface. The GGUF provider only ever served
        // /api/chat; extraction never used it. See DECISIONS.md (2026-06-15).

        if (!apiKey) {
            yield { kind: 'error', message: `No API key configured for provider "${provider}". Set it in Settings.` };
            return;
        }

        if (provider === 'anthropic') {
            yield* streamAnthropic(message, apiKey, resolvedModel);
            return;
        }

        if (provider === 'openai') {
            yield* streamOpenAI(message, apiKey, resolvedModel);
            return;
        }

        // OpenRouter: same OpenAI-compatible API. The base URL is passed as an
        // explicit override (L-027) — no global process.env mutation — so a
        // concurrent 'openai' stream can never observe the openrouter endpoint.
        if (provider === 'openrouter') {
            yield* streamOpenAI(message, apiKey, resolvedModel, 'https://openrouter.ai/api/v1');
            return;
        }

        yield { kind: 'error', message: `Unknown LLM provider: ${provider}` };
    } catch (err) {
        yield { kind: 'error', message: `LLM unreachable: ${(err as Error).message}` };
    }
}

/**
 * streamEmbedded — Runs the built-in Gemma 3 1B through Transformers.js.
 *
 * Model ID defaults to 'onnx-community/gemma-3-1b-it-ONNX'; override via
 * LORE_EMBEDDED_MODEL. First-run downloads ~0.8–1.2 GB of ONNX weights to
 * ~/.groundfloor/models/ (via env.cacheDir). Subsequent runs are cache hits.
 * No network calls once cached — honors the offline-first ethos.
 *
 * Streaming: wraps Transformers.js's TextStreamer (which uses a callback
 * per token) in a Promise-queue so we can yield AsyncGenerator frames.
 *
 * Quality note: Gemma 3 1B is usable for simple Q&A but won't hold a candle
 * to Claude/GPT-4 class models. The UI surfaces a nudge banner whenever
 * this provider is active so the user knows why answers feel thin.
 */
// V2.2: module-level pipeline cache with idle-unload.
//
// The embedded-model ONNX (~0.8-1.2 GB on disk, ~1.2-1.5 GB resident
// once loaded) gets loaded on first chat request and kept warm so
// subsequent requests are instant. Holding it forever, though, is a
// real memory cost on laptops already under pressure (e.g. Dataplane
// containers + IDE + browser). Default behavior: after N minutes of
// no queries, dispose the pipeline, freeing the RAM. Next query pays
// one reload (~5-10 s) and re-caches.
//
// TW-6b: the user-facing keep-hot toggle was removed with the chat
// surface; idle-unload is always on (override the window via
// LORE_MODEL_IDLE_UNLOAD_MS).
type EmbeddedGenerator = {
    tokenizer: unknown;
    dispose?: () => void | Promise<void>;
    (input: unknown, opts: Record<string, unknown>): Promise<unknown>;
};

interface CachedPipeline {
    promise: Promise<EmbeddedGenerator>;
    lastUsedAt: number;
    /**
     * Active-consumer refcount. Bumped on every entry to streamEmbedded
     * that touches this cache entry (pre-load AND during generation),
     * decremented in the finally. Bug fix 2026-04-24: the idle sweeper
     * used to dispose sessions while they were still being awaited —
     * a download taking longer than IDLE_UNLOAD_MS, or a single
     * generation that outran the timer, would throw "Session already
     * disposed" and the subsequent reload spin the model from scratch.
     * Sweeper now skips any entry with inFlight > 0.
     */
    inFlight: number;
}

const embeddedPipelineCache = new Map<string, CachedPipeline>();

/**
 * Idle-unload timeout for the embedded model — env override: LORE_MODEL_IDLE_UNLOAD_MS.
 * Default: 180000 (3 minutes). Set to 0 to effectively disable (use keepModelHot instead).
 */
const IDLE_UNLOAD_MS_DEFAULT = 3 * 60 * 1000;   // 3 minutes
const IDLE_UNLOAD_MS = parseEnvInt('LORE_MODEL_IDLE_UNLOAD_MS', IDLE_UNLOAD_MS_DEFAULT);
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;       // check every 30s

// TW-6b: the user-facing "keep embedded model hot" toggle
// (config knob `keepEmbeddedModelHot` + setEmbeddedModelKeepHot setter)
// was removed with the chat surface. The embedded pipeline always
// idle-unloads after LORE_MODEL_IDLE_UNLOAD_MS so a database never
// pins ~1.2-1.5 GB of RAM indefinitely. See DECISIONS.md (2026-06-15).
const keepModelHot = false;
let idleSweeper: ReturnType<typeof setInterval> | null = null;

function ensureIdleSweeper(): void {
    if (idleSweeper !== null || keepModelHot) return;
    idleSweeper = setInterval(() => {
        const now = Date.now();
        for (const [modelName, cached] of embeddedPipelineCache.entries()) {
            // Bug fix 2026-04-24: never dispose an entry that still has
            // an active consumer. A query that's downloading the model
            // for the first time (can exceed 3 min on cold caches) or
            // a slow generation (long prompt, slow hardware) would
            // otherwise have its session ripped out from underneath.
            if (cached.inFlight > 0) continue;
            if (now - cached.lastUsedAt < IDLE_UNLOAD_MS) continue;
            // Drop the cache entry. The underlying Pipeline object loses
            // its only reference and becomes GC-eligible. Transformers.js
            // pipelines expose an optional dispose() hook on some
            // architectures; call it if present for deterministic
            // release of the ONNX runtime session.
            console.error(`[llmDispatch] Idle-unload embedded model ${modelName} (idle ${Math.floor((now - cached.lastUsedAt) / 1000)}s)`);
            embeddedPipelineCache.delete(modelName);
            void cached.promise.then((gen) => {
                try { gen.dispose?.(); } catch { /* ignore */ }
            }).catch(() => { /* ignore */ });
        }
    }, IDLE_CHECK_INTERVAL_MS);
    // Don't keep the event loop alive for this timer alone.
    idleSweeper.unref?.();
}

/** Stop the embedded-model idle-unload sweeper (host dispose). Idempotent. */
export function stopIdleSweeper(): void {
    if (idleSweeper !== null) {
        clearInterval(idleSweeper);
        idleSweeper = null;
    }
}

// 4.6 (2026-08-17) — no module-eval timer. The idle sweeper is armed lazily on
// the first embedded-model load (see the cache.set below) and stopped via
// stopIdleSweeper(), so importing this module registers no timers and an
// embedding host that disposes its Lore instance has nothing left firing.

/**
 * Phase 1 grounding prompt. See DECISIONS.md entry 2026-04-20 —
 * "Embedded model upgrade + strict grounding." Kept here as a const
 * so tests can import and verify, and so future edits are reviewable.
 */
const EMBEDDED_SYSTEM_PROMPT = `You are a knowledge-graph assistant for Lore, a local-first knowledge base. You answer ONLY from the context nodes provided in this conversation. If the context does not contain the answer, say exactly: "I don't have enough information in the knowledge graph to answer that." Do not speculate. Do not invent.

Hard rules:
- Never invent method names, API routes, node IDs, function names, or procedural steps that don't appear verbatim in the provided context.
- Never claim you can perform actions (editing edges, re-running reconnect, deleting nodes, etc.). You cannot mutate anything directly.
- When asked to DO something that Lore supports, emit a structured action token the UI will render as a clickable button. The user clicks to confirm. DO NOT emit action tokens without a matching user request — don't volunteer buttons the user didn't ask for.
- Cite specific claims with the node ID in brackets, like [lore:decision-foo].
- Be concise: 2-4 sentences unless more detail is explicitly asked.
- If the user asks about a node that's missing from the context, say the node wasn't attached to this conversation.

Action tokens (use EXACTLY this format, on its own line):
  {{action:reconnect_node|id=<node-id>|label=Reconnect this node}}
    → rebuilds semantic_neighbor edges for one node. Use when a
      user asks to fix/repair/reconnect a SPECIFIC node.
  {{action:open_reconnect_settings|label=Open Graph Connections}}
    → jumps the UI to Settings → Graph Connections. Use when a
      user asks to reconnect the whole graph or isn't specifying
      a single node.

Valid action names are ONLY the two above. Never invent new action names. If you're unsure whether an action exists, describe what the user should click in prose instead of guessing.`;

async function* streamEmbedded(message: string, model: string): AsyncGenerator<LlmChunk> {
    // Queue holds LlmChunks so it can interleave model-loading progress
    // frames with token frames. Both flow through the same notify() gate.
    const queue: LlmChunk[] = [];
    let streamingDone = false;
    let streamingError: { message: string } | null = null;
    let resolveNext: (() => void) | null = null;
    const notify = (): void => {
        const r = resolveNext;
        resolveNext = null;
        if (r) r();
    };

    // Held across the IIFE so the finally block can always decrement
    // inFlight and stamp lastUsedAt regardless of which branch we took
    // or whether we threw. See CachedPipeline.inFlight for the contract.
    let activeCache: CachedPipeline | null = null;

    const genPromise = (async () => {
        try {
            const transformers = await import('@huggingface/transformers');
            const { pipeline, env, TextStreamer } = transformers as unknown as {
                pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<EmbeddedGenerator>;
                env: { cacheDir?: string; allowRemoteModels?: boolean };
                TextStreamer: new (tokenizer: unknown, opts: Record<string, unknown>) => unknown;
            };
            const os = await import('node:os');
            const path = await import('node:path');
            env.cacheDir = loreHomePath('models');
            env.allowRemoteModels = true;

            // Load-and-cache the pipeline once per daemon (or once per
            // idle-unload cycle — see ensureIdleSweeper).
            let generator: EmbeddedGenerator;
            const cached = embeddedPipelineCache.get(model);
            if (cached) {
                // Claim the entry BEFORE we await its promise so the
                // sweeper can't dispose it out from under us.
                cached.inFlight++;
                activeCache = cached;
                generator = await cached.promise;
                cached.lastUsedAt = Date.now();
            } else {
                console.error(`[llmDispatch] Loading embedded model ${model} (first run downloads to ${env.cacheDir})...`);

                // Surface ONLY true network download progress to the UI.
                // Transformers.js fires progress_callback for cache-hit
                // initiate/done events too; we silently drop those so the
                // UI doesn't render a misleading "Downloading model…"
                // panel on every chat request after the first.
                const progress_callback = (p: {
                    status?: string;
                    file?: string;
                    loaded?: number;
                    total?: number;
                    progress?: number;
                }): void => {
                    if (!p) return;
                    // Only emit on actual network download phases. The
                    // two observed download-phase status values are
                    // 'download' (start) and 'progress' (in-flight bytes).
                    // 'initiate', 'done', 'ready' all fire on cache hits
                    // and carry no progress signal worth rendering.
                    if (p.status !== 'download' && p.status !== 'progress') return;
                    const frac = typeof p.progress === 'number'
                        ? Math.max(0, Math.min(1, p.progress / 100))
                        : p.total && p.loaded ? p.loaded / p.total : 0;
                    queue.push({
                        kind: 'model_loading',
                        status: p.status,
                        file: p.file,
                        progress: frac,
                    });
                    notify();
                };

                const pipelinePromise = pipeline('text-generation', model, {
                    quantized: true,
                    progress_callback,
                });
                const cacheEntry: CachedPipeline = {
                    promise: pipelinePromise,
                    lastUsedAt: Date.now(),
                    // Claim immediately — the download IS the in-flight
                    // work. Without this, a >3 min download gets swept
                    // out mid-load and we're back to "loading again
                    // and again" after every failed stream.
                    inFlight: 1,
                };
                activeCache = cacheEntry;
                embeddedPipelineCache.set(model, cacheEntry);
                ensureIdleSweeper(); // 4.6 — arm only once a model is actually loaded
                try {
                    generator = await pipelinePromise;
                } catch (loadErr) {
                    // If loading failed, drop the cached entry so the
                    // next request can retry instead of failing forever.
                    embeddedPipelineCache.delete(model);
                    activeCache = null; // already gone; skip the finally decrement
                    throw loadErr;
                }
            }

            const streamer = new TextStreamer(generator.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (text: string) => {
                    if (text) {
                        queue.push({ kind: 'token', content: text });
                        notify();
                    }
                },
            });

            const prompt = [
                { role: 'system', content: EMBEDDED_SYSTEM_PROMPT },
                { role: 'user', content: message },
            ];
            await generator(prompt, {
                max_new_tokens: 256,
                do_sample: false,
                streamer,
            });
        } catch (err) {
            streamingError = { message: (err as Error).message };
            // If the error looks like a disposed/closed ONNX session,
            // evict the cache so the next query reloads cleanly rather
            // than re-hitting the same dead handle. Belt-and-braces —
            // the inFlight guard above should prevent this, but if a
            // disposal slipped through (e.g. user-driven reconfigure),
            // we don't want the next chat to loop on the same corpse.
            const msg = (err as Error | undefined)?.message ?? '';
            if (activeCache && /dispos|closed|session/i.test(msg)) {
                if (embeddedPipelineCache.get(model) === activeCache) {
                    embeddedPipelineCache.delete(model);
                }
            }
        } finally {
            if (activeCache) {
                activeCache.inFlight = Math.max(0, activeCache.inFlight - 1);
                activeCache.lastUsedAt = Date.now();
            }
            streamingDone = true;
            notify();
        }
    })();

    while (!streamingDone || queue.length > 0) {
        if (queue.length === 0 && !streamingDone) {
            await new Promise<void>((r) => { resolveNext = r; });
        }
        while (queue.length > 0) {
            yield queue.shift()!;
        }
    }
    await genPromise;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedError: any = streamingError;
    if (capturedError && typeof capturedError.message === 'string') {
        yield { kind: 'error', message: `Embedded model failed: ${capturedError.message}` };
        return;
    }
    yield { kind: 'done' };
}

// Agent-layer extraction (2026-05-17): OllamaTool + streamOllamaWithTools
// + streamOpenAIWithTools used to live in llmAgenticTools.ts (deleted in
// Phase 4 final cleanup). Host apps owning their own tool loops talk to
// the LLM provider directly. See docs/architecture/agent-layer-extraction-2026-05-17.md.

async function* streamOllama(message: string, model: string): AsyncGenerator<LlmChunk> {
    // num_ctx default in Ollama is 2048 — too small for our system-prompt-injected
    // workspaces (a domain workspace brief is ~10k tokens). Force a large context so the
    // model sees the system prompt instead of having it silently truncated.
    // Override via LORE_LLM_NUM_CTX (default: 32768).
    const resp = await fetch(`${getOllamaLlmHost()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: message }],
            stream: true,
            options: { num_ctx: getOllamaNumCtx() },
        }),
    });
    if (!resp.ok || !resp.body) {
        yield { kind: 'error', message: `Ollama HTTP ${resp.status}` };
        return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
                const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
                const chunk = obj.message?.content;
                if (chunk) yield { kind: 'token', content: chunk };
                if (obj.done) {
                    yield { kind: 'done' };
                    return;
                }
            } catch {
                // Ignore malformed line, continue stream
            }
        }
    }
    yield { kind: 'done' };
}

async function* streamAnthropic(message: string, apiKey: string, model: string): AsyncGenerator<LlmChunk> {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: getAnthropicMaxTokens(),
            stream: true,
            messages: [{ role: 'user', content: message }],
        }),
    });
    if (!resp.ok || !resp.body) {
        yield { kind: 'error', message: `Anthropic HTTP ${resp.status}` };
        return;
    }
    yield* parseSseTokens(resp.body, (evt) => {
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            return evt.delta.text as string;
        }
        return null;
    });
    yield { kind: 'done' };
}

async function* streamOpenAI(message: string, apiKey: string, model: string, baseUrlOverride?: string): AsyncGenerator<LlmChunk> {
    // Allow base URL override so the same OpenAI provider can talk to
    // OpenRouter (or any OpenAI-compatible gateway) without a separate
    // provider. The base URL is threaded as an explicit PARAMETER (L-027) —
    // never read from a globally mutated process.env mid-stream, which let a
    // concurrent plain-'openai' stream observe the openrouter endpoint + leak
    // the OpenAI key/attribution to openrouter.ai. The env var remains a legacy
    // single-tenant default: set LORE_OPENAI_BASE_URL=https://openrouter.ai/api/v1
    // and use OpenRouter model slugs like "deepseek/deepseek-chat".
    const baseUrl = baseUrlOverride || process.env.LORE_OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
    // OpenRouter recommends these for attribution / app identification.
    if (baseUrl.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://lore.local';
        headers['X-Title'] = 'Lore';
    }
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: 'user', content: message }],
        }),
    });
    if (!resp.ok || !resp.body) {
        yield { kind: 'error', message: `OpenAI HTTP ${resp.status}` };
        return;
    }
    yield* parseSseTokens(resp.body, (evt) => {
        const tok = evt.choices?.[0]?.delta?.content;
        return typeof tok === 'string' ? tok : null;
    });
    yield { kind: 'done' };
}

// invokeOllamaVision, invokeOllamaText → extracted to llmOllamaDirect.ts

/**
 * parseSseTokens — Read an SSE body and yield token chunks using the
 * provider-specific extractor.
 */
async function* parseSseTokens(
    body: ReadableStream<Uint8Array>,
    extract: (evt: { [k: string]: unknown } & { type?: string; delta?: { type?: string; text?: string }; choices?: Array<{ delta?: { content?: string } }> }) => string | null,
): AsyncGenerator<LlmChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') return;
                try {
                    const evt = JSON.parse(data);
                    const tok = extract(evt);
                    if (tok) yield { kind: 'token', content: tok };
                } catch {
                    // Ignore malformed frame
                }
            }
        }
    }
}

// Re-exports for backward compatibility — callers that imported from
// llmDispatch.js continue to resolve without changes.
//
// Agent-layer extraction (2026-05-17, Phase 4 complete): the
// streamOllamaWithTools / streamOpenAIWithTools / OllamaTool exports
// and the llmAgenticTools.ts file they lived in are GONE. Host apps
// owning their own tool loops talk to the LLM provider directly. See
// docs/architecture/agent-layer-extraction-2026-05-17.md.
export { invokeOllamaVision, invokeOllamaText } from './llmOllamaDirect.js';
