/**
 * extractionCost.ts — per-model cost estimation for the extraction pass.
 *
 * Pure, no I/O — split out from extractCountableFacts.ts (a CLI script that
 * calls its own main() unconditionally at import time) so this can be
 * imported safely by a unit test without triggering a real run.
 *
 * This number directly gates a real spending decision (see
 * extractCountableFacts.ts's header) — keep MODEL_PRICING in sync with
 * whatever --model is actually used; a stale price here misinforms that
 * decision.
 */

export const DEFAULT_EXTRACT_MODEL = 'gpt-4o-mini';

export const EST_INPUT_TOKENS_PER_SESSION = 1500;
export const EST_OUTPUT_TOKENS_PER_SESSION = 100;

interface ModelPricing { inputPerM: number; outputPerM: number; }

const MODEL_PRICING: Record<string, ModelPricing> = {
    'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.60 },
    // OpenRouter's live /api/v1/models catalog, queried directly 2026-08-14
    // (an earlier cached figure from a model-comparison page said 0.08/0.252
    // — the live catalog is the authoritative source, use this one).
    'deepseek/deepseek-v4-flash-0731': { inputPerM: 0.14, outputPerM: 0.28 },
    // OpenRouter's live /api/v1/models catalog, queried directly 2026-08-14.
    // Key matches the exact string passed via --model (openai/gpt-5-mini),
    // same as the deepseek entry above — the modelFor() prefixing logic
    // passes an already-qualified 'provider/model' slug through unchanged,
    // so the pricing lookup key must match it exactly, not the bare model id.
    'openai/gpt-5-mini': { inputPerM: 0.25, outputPerM: 2.0 },
};

export interface ExtractionCostEstimate {
    inputTokens: number;
    outputTokens: number;
    usd: number;
    model: string;
    /** false when `model` isn't in MODEL_PRICING — the returned `usd` is a
     *  gpt-4o-mini-priced stand-in, not this model's real cost. */
    priceKnown: boolean;
}

export function estimateExtractionCost(
    sessionCount: number,
    model: string = DEFAULT_EXTRACT_MODEL,
): ExtractionCostEstimate {
    const inputTokens = sessionCount * EST_INPUT_TOKENS_PER_SESSION;
    const outputTokens = sessionCount * EST_OUTPUT_TOKENS_PER_SESSION;

    // A local Ollama model (`ollama:<model>`) genuinely costs $0 — this is a
    // real, known price, not an "unknown model, falling back" case. Reporting
    // it via the gpt-4o-mini stand-in (priceKnown:false) would misleadingly
    // flag a real $0 as "unreliable".
    if (model.startsWith('ollama:')) {
        return { inputTokens, outputTokens, usd: 0, model, priceKnown: true };
    }

    const pricing = MODEL_PRICING[model];
    const priceKnown = pricing !== undefined;
    const { inputPerM, outputPerM } = pricing ?? MODEL_PRICING[DEFAULT_EXTRACT_MODEL]!;
    const usd =
        (inputTokens / 1_000_000) * inputPerM +
        (outputTokens / 1_000_000) * outputPerM;
    return { inputTokens, outputTokens, usd: Number(usd.toFixed(2)), model, priceKnown };
}
