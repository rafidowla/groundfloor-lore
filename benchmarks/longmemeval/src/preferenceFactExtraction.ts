/**
 * preferenceFactExtraction.ts — ingest-time extraction of stated
 * preferences/opinions (mirrors extractFacts.ts's countable-fact extraction,
 * see preferenceEvents.ts's header for why this pipeline exists).
 *
 * The one piece of this pipeline that costs API calls: ONE LLM call per
 * session reads the session's turns and returns every stated preference
 * (most sessions yield none — expected and fine, same as the countable
 * pipeline). Storage/schema safety lives in preferenceEvents.ts, not here;
 * the HTTP/provider/retry mechanics live in extractionLlmCall.ts, shared
 * with a future refactor of extractFacts.ts (see that file's header for why
 * extractFacts.ts itself wasn't folded over as part of this change).
 *
 * Cost control is the caller's responsibility (see extractPreferenceFacts.ts):
 * only extract for sessions of questions in the subset under test, and never
 * run a pass without first reporting the exact call count + cost. The prompt
 * builder and the response parser are pure and easy to unit test with zero
 * API calls; only extractPreferenceFactsFromSession touches the network.
 */

import { callOpenAiWithRetry, callAnthropicOnce } from './extractionLlmCall.js';
import type { LongMemEvalTurn } from './types.js';
import { buildNodeId } from './ingest.js';
import type { PreferenceFact, PreferenceSentiment } from './preferenceEvents.js';
import { callOllamaChat, isOllamaModel, stripOllamaPrefix } from './ollamaClient.js';

export class PreferenceExtractionUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'PreferenceExtractionUnavailableError';
    }
}

const OPENAI_EXTRACT_MODEL = 'gpt-4o-mini';
const ANTHROPIC_EXTRACT_MODEL = 'claude-3-5-haiku-latest';
// Preference statements are short and there are typically few per session
// (usually 0-3), unlike countable facts which can run long for a
// fact-dense session — half of extractFacts.ts's MAX_EXTRACT_TOKENS is
// ample headroom here. If a real run ever hits the truncation retry in
// extractionLlmCall.ts at this budget, raise it the same way that file's
// 2026-08-14 comment documents doing for the countable pipeline — don't
// assume this number is load-bearing tuning, it's a starting estimate.
const MAX_EXTRACT_TOKENS = 2000;

/**
 * Pure prompt builder — exported for unit tests (no API calls). Mirrors
 * extractFacts.ts's buildExtractionPrompt structure (turn-by-turn traversal,
 * include-when-unsure, one turn can yield several rows) but scoped to
 * preferences/opinions instead of countable facts.
 */
export function buildPreferenceExtractionPrompt(turns: LongMemEvalTurn[]): string {
    const turnLines = turns
        .map((t, i) => `[${i}] ${t.role}: ${t.content}`)
        .join('\n');
    return (
        `You are extracting the USER's stated preferences and opinions from ONE session of a long chat history between a user and an assistant.\n\n` +
        `A stated preference is anything the user says they like, dislike, prefer, enjoy, avoid, or have an opinion about. Include:\n` +
        `- direct statements of liking or disliking something ("I love spicy food", "I don't really like loud places")\n` +
        `- comparative preferences ("I prefer tea over coffee", "quiet restaurants are better than lively ones for me")\n` +
        `- habitual avoidance or seeking-out that implies a preference ("I always skip horror movies", "I try to sit near a window whenever I can")\n` +
        `- opinions about categories of thing relevant to a future question about the user's taste (food, music, environments, activities, work style, social settings, etc.)\n\n` +
        `Exclude preferences stated by or attributed to the ASSISTANT, one-off situational statements with no general preference behind them ("I'll have the salad today" says nothing about a general food preference on its own), and hypotheticals with no committed opinion ("I might like sushi, never tried it").\n\n` +
        `Work through the turns one at a time, in index order: for each turn, decide what preferences THAT turn states before moving to the next one. Do not skim the session as a whole.\n` +
        `A single turn can state zero, one, or several preferences. A turn saying "I love spicy food but I can't stand cilantro" states TWO preferences (one like, one dislike) — emit a separate row for each; never combine a like and a dislike into one row.\n` +
        `Do not emit duplicate rows for the same underlying preference: when a later turn in this session restates a preference an earlier turn already gave, emit it once.\n` +
        `When you are unsure whether a mention is a real stated preference, INCLUDE it. A row that turns out to be irrelevant is harmless, but nothing downstream can recover a preference you leave out.\n\n` +
        `Session turns:\n${turnLines}\n\n` +
        `Return ONLY a JSON array (no prose, no markdown fences). Each element has this exact shape:\n` +
        `{"topic": "<short label e.g. food, music, environment, activities, social, work>", "statement": "<short factual restatement, phrased as 'likes X' or 'dislikes Y'>", "sentiment": "like" or "dislike", "strength": <integer 1-5 or null — ONLY set this when the wording clearly conveys intensity, e.g. 'absolutely love'/'can't stand' vs. a plain statement>, "source_turn_index": <0-based index of the turn the preference came from>}\n\n` +
        `"statement" holds the preference alone — never your reasoning about whether to include it.\n\n` +
        `If the session contains no stated preferences, return [].`
    );
}

/** Pull the first JSON array out of a possibly-fenced, possibly-prose-wrapped
 *  model response. Same helper as extractFacts.ts's private extractJsonArray
 *  — kept as its own copy rather than imported, since neither module is
 *  meant to depend on the other's internals (see this file's header). */
function extractJsonArray(text: string): string | null {
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1]!.trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    return t.slice(start, end + 1);
}

function isPreferenceSentiment(v: unknown): v is PreferenceSentiment {
    return v === 'like' || v === 'dislike';
}

/**
 * Parse a raw extraction response into PreferenceFacts. Pure and defensive:
 * any malformed item is skipped (not thrown), and `source_turn_index` is
 * mapped to the deterministic node id (`<question_id>::<session_id>::<turn>`).
 * Mirrors extractFacts.ts's parseExtractionResult.
 */
export function parsePreferenceExtractionResult(
    text: string,
    questionId: string,
    sessionId: string,
): PreferenceFact[] {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') return [];

    const jsonText = extractJsonArray(trimmed);
    if (jsonText === null) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const facts: PreferenceFact[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const topic = typeof o.topic === 'string' ? o.topic.trim() : '';
        const statement = typeof o.statement === 'string' ? o.statement.trim() : '';
        const sentiment = isPreferenceSentiment(o.sentiment) ? o.sentiment : null;
        const sourceTurnIndex =
            typeof o.source_turn_index === 'number' && Number.isInteger(o.source_turn_index)
                ? o.source_turn_index
                : null;
        if (!topic || !statement || !sentiment || sourceTurnIndex == null) continue;

        const strength =
            typeof o.strength === 'number' && Number.isInteger(o.strength) && o.strength >= 1 && o.strength <= 5
                ? o.strength
                : null;

        facts.push({
            topic,
            statement,
            sentiment,
            strength,
            sourceNodeId: buildNodeId(questionId, sessionId, sourceTurnIndex),
        });
    }
    return facts;
}

/**
 * ONE LLM call for one session. Returns the stated preferences ([] when the
 * session has none). Throws PreferenceExtractionUnavailableError when no key
 * is set. Provider routing mirrors extractFacts.ts's extractFactsFromSession
 * exactly (Ollama first if requested, then OpenAI/OpenRouter, then Anthropic).
 */
export async function extractPreferenceFactsFromSession(opts: {
    questionId: string;
    sessionId: string;
    turns: LongMemEvalTurn[];
    modelOverride?: string;
}): Promise<PreferenceFact[]> {
    const prompt = buildPreferenceExtractionPrompt(opts.turns);

    if (opts.modelOverride && isOllamaModel(opts.modelOverride)) {
        const model = stripOllamaPrefix(opts.modelOverride);
        const { content } = await callOllamaChat(model, prompt, false);
        return parsePreferenceExtractionResult(content, opts.questionId, opts.sessionId);
    }

    const openAiKey = process.env['OPENAI_API_KEY'];
    if (openAiKey) {
        const raw = await callOpenAiWithRetry(openAiKey, prompt, opts.modelOverride ?? OPENAI_EXTRACT_MODEL, MAX_EXTRACT_TOKENS);
        return parsePreferenceExtractionResult(raw, opts.questionId, opts.sessionId);
    }

    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    if (anthropicKey) {
        const raw = await callAnthropicOnce(anthropicKey, prompt, ANTHROPIC_EXTRACT_MODEL, MAX_EXTRACT_TOKENS);
        return parsePreferenceExtractionResult(raw, opts.questionId, opts.sessionId);
    }

    throw new PreferenceExtractionUnavailableError(
        'Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set. No scriptable extraction model is available.',
    );
}
