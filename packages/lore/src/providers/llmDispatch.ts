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

export type LlmProvider = 'embedded' | 'anthropic' | 'openai' | 'ollama' | string;

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

export interface LlmCapability {
    provider: LlmProvider;
    model: string;
    acceptsText: boolean;
    acceptsImages: boolean;
    acceptedMimeTypes: string[];
}

const DEFAULT_MODELS: Record<string, string> = {
    embedded: 'Xenova/Qwen1.5-0.5B-Chat',
    anthropic: 'claude-3-5-sonnet-latest',
    openai: 'gpt-4o-mini',
    ollama: 'llama3.2',
};

/**
 * isEmbeddedCapable — True when the provider is "embedded" (built-in Qwen).
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

    // Embedded Qwen 0.5B is text-only; no image/audio capability.
    if (provider === 'embedded') {
        return {
            provider,
            model: resolvedModel,
            acceptsText: true,
            acceptsImages: false,
            acceptedMimeTypes: ['text/plain', 'text/markdown'],
        };
    }

    // Multimodal families
    const multimodal =
        lower.includes('claude-3') ||
        lower.includes('gpt-4o') ||
        lower.includes('gpt-4-vision') ||
        lower.includes('llava') ||
        lower.includes('llama3.2-vision');

    return {
        provider,
        model: resolvedModel,
        acceptsText: true,
        acceptsImages: multimodal,
        acceptedMimeTypes: multimodal
            ? ['text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']
            : ['text/plain', 'text/markdown'],
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
    const resolvedModel = model ?? DEFAULT_MODELS[provider] ?? '';

    try {
        if (provider === 'embedded') {
            yield* streamEmbedded(message, resolvedModel);
            return;
        }

        if (provider === 'ollama') {
            yield* streamOllama(message, resolvedModel);
            return;
        }

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

        yield { kind: 'error', message: `Unknown LLM provider: ${provider}` };
    } catch (err) {
        yield { kind: 'error', message: `LLM unreachable: ${(err as Error).message}` };
    }
}

/**
 * streamEmbedded — Runs a built-in Qwen 0.5B through Transformers.js.
 *
 * First-run downloads ~500MB of ONNX weights to ~/.groundfloor/models/ (via
 * env.cacheDir). Subsequent runs are cache hits. No network calls once
 * cached — honors the offline-first ethos.
 *
 * Streaming: wraps Transformers.js's TextStreamer (which uses a callback
 * per token) in a Promise-queue so we can yield AsyncGenerator frames.
 *
 * Quality note: Qwen-0.5B is usable for simple Q&A but won't hold a candle
 * to Claude/GPT-4 class models. The UI surfaces a nudge banner whenever
 * this provider is active so the user knows why answers feel thin.
 */
// Module-level pipeline cache. The 500 MB ONNX file loads once per
// daemon lifetime, not per chat request. Keyed by model name so a
// future switch between two embedded models still works. The value is
// a Promise so concurrent requests during the first load all await the
// same pipeline rather than racing to re-load.
type EmbeddedGenerator = {
    tokenizer: unknown;
    (input: unknown, opts: Record<string, unknown>): Promise<unknown>;
};
const embeddedPipelineCache = new Map<string, Promise<EmbeddedGenerator>>();

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
            env.cacheDir = path.join(os.homedir(), '.groundfloor', 'models');
            env.allowRemoteModels = true;

            // Only load-and-cache the pipeline once per daemon. Subsequent
            // chat requests reuse the in-memory generator with no disk I/O
            // and no transformers-js re-initialization noise.
            let generator: EmbeddedGenerator;
            const cached = embeddedPipelineCache.get(model);
            if (cached) {
                generator = await cached;
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
                embeddedPipelineCache.set(model, pipelinePromise);
                try {
                    generator = await pipelinePromise;
                } catch (loadErr) {
                    // If loading failed, drop the cached promise so the
                    // next request can retry instead of failing forever.
                    embeddedPipelineCache.delete(model);
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
                { role: 'system', content: 'You are a concise assistant. Keep answers short.' },
                { role: 'user', content: message },
            ];
            await generator(prompt, {
                max_new_tokens: 256,
                do_sample: false,
                streamer,
            });
        } catch (err) {
            streamingError = { message: (err as Error).message };
        } finally {
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

async function* streamOllama(message: string, model: string): AsyncGenerator<LlmChunk> {
    const resp = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: message }],
            stream: true,
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
            max_tokens: 1024,
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

async function* streamOpenAI(message: string, apiKey: string, model: string): AsyncGenerator<LlmChunk> {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
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
