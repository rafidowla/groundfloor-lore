/**
 * openaiGateway.ts — resolves which HTTP endpoint + model-name prefix an
 * OpenAI-compatible chat completion call should use, based on the shape of
 * the supplied API key.
 *
 * An OpenRouter key (`sk-or-...`) routes through OpenRouter's gateway. Two
 * cases:
 *   - A bare model id (no `/`, e.g. `gpt-4o-2024-08-06`) is assumed to be an
 *     OpenAI-branded model and gets the `openai/` provider prefix
 *     OpenRouter expects — OpenRouter proxies directly to OpenAI's own API
 *     for these, it does not rehost or re-quantize them, so this is a
 *     TRANSPORT difference only: the model identity judge.ts pins against
 *     (OFFICIAL_JUDGE_MODEL) is unchanged, and comparability is unaffected.
 *   - An already-qualified `provider/model` slug (e.g.
 *     `deepseek/deepseek-v4-flash-0731`) is passed through AS-IS — this is
 *     how any non-OpenAI model reaches OpenRouter; force-prefixing it with
 *     `openai/` would silently send the request to the wrong provider.
 *     (Found 2026-08-13: the original always-prefix version only ever
 *     needed to route OpenAI models, so the gap didn't show up until an
 *     answering-model comparison against a different provider was tried.)
 *
 * A direct OpenAI key (`sk-...`, no `-or-`) calls OpenAI's API unprefixed,
 * unchanged from before this file existed — the answering model there is
 * always an OpenAI model by construction, so no prefix logic applies.
 */

export interface OpenAiGateway {
    endpoint: string;
    /** Given the model id (bare, e.g. 'gpt-4o-2024-08-06', or an
     *  already-qualified 'provider/model' slug), returns the model string
     *  this gateway actually expects in the request body. */
    modelFor: (model: string) => string;
    /** Extra fields to merge into the request body — see
     *  REASONING_DISABLED_MODELS for what this is and isn't for. */
    extraBody: Record<string, unknown>;
}

const OPENROUTER_KEY_PREFIX = 'sk-or-';

/**
 * Models where OpenRouter's unified `reasoning: { enabled: false }` control
 * must be forced OFF, because leaving it on burns the model's whole token
 * budget on hidden chain-of-thought before any visible content
 * (finish_reason:"length" on non-trivial prompts) — confirmed live
 * 2026-08-13/14 for deepseek/deepseek-v4-flash-0731 specifically
 * (`thinking: { type: 'disabled' }` does NOT work through OpenRouter for
 * this model; `reasoning: { enabled: false }` does — verified 0/30
 * completion tokens on reasoning vs. 116/157 with the other parameter).
 *
 * This must NOT be applied blanket to every OpenRouter model. Found
 * 2026-08-14: it was originally applied to the whole gateway regardless of
 * model, which would have silently forced reasoning off for gpt-5-mini too
 * — a model whose published best-in-class LongMemEval result presumably
 * depends on its own reasoning being ON. Disabling reasoning is a per-model
 * workaround for a per-model problem, not a general OpenRouter setting.
 */
const REASONING_DISABLED_MODELS: ReadonlySet<string> = new Set([
    'deepseek/deepseek-v4-flash-0731',
]);

export function resolveOpenAiGateway(apiKey: string, model: string): OpenAiGateway {
    if (apiKey.startsWith(OPENROUTER_KEY_PREFIX)) {
        return {
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            modelFor: (m) => (m.includes('/') ? m : `openai/${m}`),
            extraBody: REASONING_DISABLED_MODELS.has(model) ? { reasoning: { enabled: false } } : {},
        };
    }
    return {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        modelFor: (m) => m,
        extraBody: {},
    };
}
