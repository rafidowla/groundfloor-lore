/**
 * opencodeClient.ts — thin client for OpenCode Zen's OpenAI-compatible gateway
 * (https://opencode.ai/zen/v1/chat/completions), used to reach gpt-5.6-luna.
 *
 * Verified live 2026-08-16: `reasoning: {effort: ...}` produced byte-identical
 * token usage across none/low/medium on two real prompts (one trivial, one a
 * real judge prompt) — either this proxy doesn't pass the parameter through,
 * or the model doesn't reason for short classification prompts. Either way,
 * do not assume separate effort levels produce distinguishable results
 * through this gateway without re-verifying.
 *
 * Real OpenCode Zen pricing for gpt-5.6-luna, verified via web search
 * 2026-08-16: $0.10/M input, $0.60/M output — cheaper than OpenAI's own
 * direct pricing for the same model.
 */

import { fetchWithRetry } from './fetchWithRetry.js';

const OPENCODE_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';

export const OPENCODE_LUNA_PRICE_PER_M = { input: 0.10, output: 0.60 };

export interface OpenCodeResult {
    content: string;
    promptTokens: number;
    completionTokens: number;
}

interface OpenCodeChatResponse {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function callOnce(
    apiKey: string,
    model: string,
    prompt: string,
    maxTokens: number,
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high',
): Promise<{ content: string | null; usage: { promptTokens: number; completionTokens: number }; raw: unknown }> {
    const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
    };
    if (reasoningEffort) body['reasoning'] = { effort: reasoningEffort };

    const response = await fetchWithRetry(OPENCODE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`OpenCode call failed: HTTP ${response.status} ${bodyText.slice(0, 500)}`);
    }
    const json = (await response.json()) as OpenCodeChatResponse;
    return {
        content: json.choices?.[0]?.message?.content ?? null,
        usage: {
            promptTokens: json.usage?.prompt_tokens ?? 0,
            completionTokens: json.usage?.completion_tokens ?? 0,
        },
        raw: json,
    };
}

const DEFAULT_MAX_TOKENS = 10;

/**
 * One retry at a much larger token budget on empty content — found
 * 2026-08-16: real judge-batch runs hit an empty `message.content` with
 * `completion_tokens` already at/above the requested max_tokens on 5-10% of
 * real calls (always exactly the same shape — content missing, tokens spent)
 * despite `reasoning.effort` showing no observable effect on two earlier
 * probe prompts. Whatever is consuming the budget before content, it isn't
 * captured in this response shape the way Ollama's `message.thinking` is —
 * the fix mirrors extractFacts.ts's/answerModel.ts's existing pattern for
 * the same class of reasoning-model truncation: retry once with real
 * headroom rather than chase the exact mechanism through an opaque proxy.
 */
export async function callOpenCode(
    model: string,
    prompt: string,
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high',
): Promise<OpenCodeResult> {
    const apiKey = process.env['OPENCODE_API_KEY'];
    if (!apiKey) throw new Error('OPENCODE_API_KEY is not set.');

    const first = await callOnce(apiKey, model, prompt, DEFAULT_MAX_TOKENS, reasoningEffort);
    if (first.content) {
        return { content: first.content, promptTokens: first.usage.promptTokens, completionTokens: first.usage.completionTokens };
    }

    const retryTokens = DEFAULT_MAX_TOKENS * 20; // judge answers are 1 word; 200 tokens is ample headroom
    const second = await callOnce(apiKey, model, prompt, retryTokens, reasoningEffort);
    if (second.content) {
        // Report cumulative usage across both attempts — this is the real
        // cost incurred, not just the successful call's.
        return {
            content: second.content,
            promptTokens: first.usage.promptTokens + second.usage.promptTokens,
            completionTokens: first.usage.completionTokens + second.usage.completionTokens,
        };
    }

    throw new Error(`Unexpected OpenCode response (empty content even at ${retryTokens} max_tokens): ${JSON.stringify(second.raw).slice(0, 500)}`);
}

export const OPENCODE_MODEL_PREFIX = 'opencode:';

export function isOpenCodeModel(model: string): boolean {
    return model.startsWith(OPENCODE_MODEL_PREFIX);
}

export function stripOpenCodePrefix(model: string): string {
    return model.slice(OPENCODE_MODEL_PREFIX.length);
}
