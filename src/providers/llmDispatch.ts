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

export type LlmProvider = 'anthropic' | 'openai' | 'ollama' | string;

export interface LlmChunk {
    kind: 'token' | 'done' | 'error';
    content?: string;
    message?: string;
}

export interface LlmCapability {
    provider: LlmProvider;
    model: string;
    acceptsText: boolean;
    acceptsImages: boolean;
    acceptedMimeTypes: string[];
}

const DEFAULT_MODELS: Record<string, string> = {
    anthropic: 'claude-3-5-sonnet-latest',
    openai: 'gpt-4o-mini',
    ollama: 'llama3.2',
};

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
