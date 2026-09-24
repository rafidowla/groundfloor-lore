/**
 * extractionLlmCall.ts — shared provider-routing + retry scaffolding for a
 * single ingest-time extraction LLM call (one chat completion per session,
 * temperature 0, expected to return a JSON array).
 *
 * Why this exists: extractFacts.ts (countable-fact extraction) and
 * preferenceFactExtraction.ts (preference extraction, added alongside this
 * file) are structurally identical past the prompt text and the JSON shape
 * returned — both fire ONE OpenAI/OpenRouter-or-Anthropic call per session
 * and need the same truncation retry. That retry exists for a real, already-
 * paid-for incident: extractFacts.ts's original MAX_EXTRACT_TOKENS comment
 * (2026-08-14) documents a real extraction run hitting
 * finish_reason:"length" on an unusually fact-dense session, via a backend
 * provider that doesn't honor the reasoning-disable flag. A second
 * extraction pipeline would hit the exact same failure mode for the exact
 * same reason, so this factors the fix out once instead of re-deriving (or
 * silently forgetting) it a second time.
 *
 * `extractFacts.ts` itself is intentionally left as its own copy rather than
 * refactored to call this file — this task's scope is additive (new files
 * for preference extraction), and extractFacts.ts already has passing unit
 * coverage that didn't need to be re-verified against a behavioral change.
 * Folding extractFacts.ts over to this shared module is a pure, low-risk
 * follow-up (same function bodies, only the import site moves) whenever
 * that's convenient — see this repo's countableEvents.ts pairing for why
 * mirroring instead of sharing is an accepted pattern here when two
 * pipelines are still expected to evolve independently.
 */

import { resolveOpenAiGateway } from './openaiGateway.js';
import { fetchWithRetry } from './fetchWithRetry.js';

interface OneShotResult {
    content: string | null;
    truncated: boolean;
    raw: unknown;
}

async function callOpenAiOnce(
    apiKey: string,
    prompt: string,
    model: string,
    maxTokens: number,
): Promise<OneShotResult> {
    const gateway = resolveOpenAiGateway(apiKey, model);
    const response = await fetchWithRetry(gateway.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: gateway.modelFor(model),
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: maxTokens,
            ...gateway.extraBody,
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenAI extraction call failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    const content = json.choices?.[0]?.message?.content?.trim() ?? null;
    const truncated = json.choices?.[0]?.finish_reason === 'length';
    return { content, truncated, raw: json };
}

/**
 * One retry at double the token budget on a truncated/empty response — a
 * single outlier session shouldn't kill an entire multi-hundred-call
 * extraction run. `baseMaxTokens` is caller-supplied (not a shared constant)
 * because different fact types have different expected output sizes — see
 * each pipeline's own MAX_EXTRACT_TOKENS-equivalent for its reasoning.
 */
export async function callOpenAiWithRetry(
    apiKey: string,
    prompt: string,
    model: string,
    baseMaxTokens: number,
): Promise<string> {
    const first = await callOpenAiOnce(apiKey, prompt, model, baseMaxTokens);
    if (first.content && !first.truncated) return first.content;

    const retryTokens = baseMaxTokens * 2;
    const second = await callOpenAiOnce(apiKey, prompt, model, retryTokens);
    if (second.content && !second.truncated) return second.content;

    const finishHint = second.truncated
        ? ` (finish_reason="length" even at ${retryTokens} max_tokens — likely a reasoning model/provider not honoring the reasoning-disable flag; see extractFacts.ts's MAX_EXTRACT_TOKENS comment)`
        : '';
    throw new Error(`Unexpected OpenAI extraction response${finishHint}: ${JSON.stringify(second.raw).slice(0, 500)}`);
}

/** No retry-on-truncation here, matching extractFacts.ts's original
 *  callAnthropicExtract — Anthropic's `max_tokens` behavior on this pipeline
 *  hasn't shown the same truncation failure mode the OpenAI/OpenRouter path
 *  needed a retry for, so this stays as simple as the thing it mirrors. */
export async function callAnthropicOnce(
    apiKey: string,
    prompt: string,
    model: string,
    maxTokens: number,
): Promise<string> {
    const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Anthropic extraction call failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const content = json.content?.find((b) => b.type === 'text')?.text?.trim();
    if (!content) throw new Error(`Unexpected Anthropic extraction response: ${JSON.stringify(json).slice(0, 300)}`);
    return content;
}
