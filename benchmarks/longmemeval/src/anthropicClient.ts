/**
 * anthropicClient.ts — thin client for Anthropic's Messages API, used for
 * Mosaic's proposition-extraction pass (see extractPropositions.ts).
 *
 * Separate from extractFacts.ts's existing callAnthropicExtract (which is
 * scoped to that file's own countable-facts prompt/model choice) so this
 * module owns its own model pin and can report real token usage back to the
 * caller for cost tracking — extractFacts.ts's version doesn't need to,
 * since that path was never run at meaningful volume against a paid key.
 */

import { fetchWithRetry } from './fetchWithRetry.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Current Haiku model id (Haiku 4.5) — NOT claude-3-5-haiku-latest, which
 *  extractFacts.ts's older Anthropic path still uses. */
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** Live Anthropic pricing for claude-haiku-4-5, verified 2026-08-16 via web
 *  search: $1/M input, $5/M output. Used only to turn real usage tokens into
 *  a real dollar figure to print — never to gate whether a call happens. */
export const HAIKU_PRICE_PER_M = { input: 1.0, output: 5.0 };

export interface AnthropicResult {
    content: string;
    inputTokens: number;
    outputTokens: number;
    /**
     * Raw `stop_reason` from the API. `'max_tokens'` means the model was cut
     * off mid-response — the JSON it was writing is truncated and will not
     * parse. Callers that parse structured output MUST check this: without it
     * a truncated response is indistinguishable from a genuinely empty one
     * (both end up as `[]` after a failed parse). Mirrors the
     * `finish_reason === 'length'` check extractFacts.ts's OpenAI path does.
     */
    stopReason: string | null;
}

interface AnthropicMessagesResponse {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string | null;
    error?: { message?: string; type?: string };
}

export async function callAnthropic(
    prompt: string,
    maxTokens: number,
    model: string = HAIKU_MODEL,
): Promise<AnthropicResult> {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

    const response = await fetchWithRetry(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`Anthropic call failed: HTTP ${response.status} ${bodyText.slice(0, 500)}`);
    }
    const json = (await response.json()) as AnthropicMessagesResponse;
    const content = json.content?.find((b) => b.type === 'text')?.text;
    if (!content) {
        throw new Error(`Unexpected Anthropic response (no text content): ${JSON.stringify(json).slice(0, 300)}`);
    }
    return {
        content,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        stopReason: json.stop_reason ?? null,
    };
}
