/**
 * ollamaClient.ts — thin client for a local Ollama server's native chat API.
 *
 * Deliberately NOT routed through resolveOpenAiGateway / the OpenAI-compatible
 * `/v1/chat/completions` endpoint that answerModel.ts and extractFacts.ts use
 * for OpenAI/OpenRouter: verified live 2026-08-15 (real local calls against
 * qwen3.8:27b, not assumed) that Ollama's OpenAI-compat endpoint silently
 * ignores the `think` field — a request with `think:false` still came back
 * with a populated `reasoning` block and the full reasoning token cost. Only
 * the native `/api/chat` endpoint honors it: the same probe showed
 * `think:false` dropping a 37-token reasoning block to 3 output tokens (10.2s
 * -> 0.44s), and `think:"medium"` accepted as a graduated level distinct from
 * plain `true`. This module exists so that verified behavior — not the
 * OpenAI-shaped endpoint's silent no-op — is what the harness actually calls.
 *
 * No API key: this is an unauthenticated local daemon on localhost.
 */

import { fetchWithRetry } from './fetchWithRetry.js';

export type OllamaThinkMode = boolean | 'low' | 'medium' | 'high';

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

export interface OllamaChatResult {
    content: string;
    thinking: string | null;
}

export async function callOllamaChat(
    model: string,
    prompt: string,
    think?: OllamaThinkMode,
): Promise<OllamaChatResult> {
    const host = process.env['OLLAMA_HOST_URL'] ?? DEFAULT_OLLAMA_HOST;
    const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
    };
    if (think !== undefined) body['think'] = think;

    const response = await fetchWithRetry(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Ollama chat call failed: HTTP ${response.status} ${errBody.slice(0, 500)}`);
    }
    const json = (await response.json()) as { message?: { content?: string; thinking?: string } };
    const content = json.message?.content?.trim();
    if (!content) {
        throw new Error(`Unexpected Ollama response (empty content): ${JSON.stringify(json).slice(0, 300)}`);
    }
    return { content, thinking: json.message?.thinking ?? null };
}

/** `ollama:<model>` marks a --model / --answer-model string as routed to the
 *  local Ollama daemon instead of OpenAI/OpenRouter — e.g. `ollama:qwen3.8:27b`. */
export const OLLAMA_MODEL_PREFIX = 'ollama:';

export function isOllamaModel(model: string): boolean {
    return model.startsWith(OLLAMA_MODEL_PREFIX);
}

export function stripOllamaPrefix(model: string): string {
    return model.slice(OLLAMA_MODEL_PREFIX.length);
}
