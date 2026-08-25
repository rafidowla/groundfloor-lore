/**
 * extractFacts.ts — ingest-time extraction of countable/quantifiable facts.
 *
 * The one piece of this pipeline that costs API calls: ONE LLM call per
 * session reads the session's turns and returns every countable fact
 * (most sessions yield none — that's expected and fine). This is the
 * harness-side counterpart to Bucket A's pure structural mapping; here the
 * source is prose, so an LLM is genuinely required to decide what is
 * countable. Storage/schema safety lives in countableEvents.ts, not here.
 *
 * Cost control is the caller's responsibility (see extractCountableFacts.ts):
 * only extract for sessions of questions in the subset under test, and never
 * run a pass without first reporting the exact call count + cost. The prompt
 * builder and the response parser are pure and unit-tested with zero API
 * calls; only extractFactsFromSession touches the network.
 */

import { resolveOpenAiGateway } from './openaiGateway.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import type { LongMemEvalTurn } from './types.js';
import { buildNodeId } from './ingest.js';
import type { CountableFact } from './countableEvents.js';
import { callOllamaChat, isOllamaModel, stripOllamaPrefix } from './ollamaClient.js';

export class ExtractionUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'ExtractionUnavailableError';
    }
}

const OPENAI_EXTRACT_MODEL = 'gpt-4o-mini';
const ANTHROPIC_EXTRACT_MODEL = 'claude-3-5-haiku-latest';
// Raised from 2000 (found 2026-08-14): a real extraction run against
// deepseek/deepseek-v4-flash-0731 hit finish_reason:"length" at 2000 tokens
// on a session with many facts, via OpenRouter's "Phala" backend — reasoning
// is supposed to be off (gateway.extraBody), but OpenRouter fans requests
// out across multiple backend providers per model, and provider-level
// reasoning-disable compliance isn't something this harness has verified for
// every provider it might land on. 4000 matches the same headroom
// answerModel.ts already uses for the identical class of failure.
const MAX_EXTRACT_TOKENS = 4000;

/**
 * Pure prompt builder — exported for unit tests (no API calls).
 *
 * ─── Exhaustiveness (2026-08-14) ──────────────────────────────────────────
 *
 * The 20-question gpt-5-mini validation run left two questions wrong for the
 * same reason: the session-level extraction call read the turn and emitted
 * FEWER rows than the turn stated. Both misses were reproduced against the
 * real `countable_events` rows, and each one traces to a specific clause of
 * the previous version of this prompt:
 *
 * 1. "How many items of clothing do I need to pick up or return from a store?"
 *    (gold 3). Turn `answer_afa9873b_3::6` says: "I need to return some boots
 *    to Zara ... I exchanged them for a larger size. I just haven't had a
 *    chance to pick them up yet." Exactly one row came out —
 *    `purchase | Bought boots from Zara on February 5th`. Two clauses caused
 *    that:
 *      - the INCLUDE list was a closed set of three COMPLETED-action shapes
 *        (purchase / a visit-trip-event the user "actually did" / time spent).
 *        An outstanding item sitting at a shop matches none of them, so only
 *        the purchase half of the sentence was in scope at all.
 *      - the EXCLUDE line lumped "future plans" in with wishes and
 *        hypotheticals. "I still need to pick them up" is future-facing
 *        grammar, so it read as a plan and was dropped — even though an
 *        obligation with a concrete, already-existing object is precisely the
 *        thing the question counts. That the exclusion clause is where
 *        extraction models get stuck is not a guess: row
 *        `28dc39ac::cbd18c72::10` has the model's own deliberation leaked into
 *        the description field ("...not yet purchased, but mentioned as a plan
 *        - excluded per instructions? Actually it's a plan, so exclude").
 *
 * 2. "How many projects have I led or am currently leading?" (gold 2). Turn
 *    `answer_ec904b3c_1::0` ("my Marketing Research class project, where I led
 *    the data analysis team") and turn `answer_ec904b3c_2::2` ("I've been
 *    working on a solo project for my Data Mining class") produced NO rows at
 *    all. A role held and an undertaking in progress are neither a purchase,
 *    nor something the user "did" on a date, nor time spent — they fell
 *    through every bullet.
 *
 * So the fix is three specific include shapes (outstanding item, role held,
 * undertaking under way), a narrowed exclusion that keeps committed
 * obligations, an explicit statement that ONE turn can yield SEVERAL rows
 * (the Zara turn states three: bought / to return / to collect), turn-by-turn
 * traversal instead of skimming, and an include-when-unsure tiebreak — the
 * query side only ever reads this table, so an omitted row is unrecoverable
 * while a spurious one is merely ignorable.
 *
 * The anti-duplicate rule is kept but scoped to THIS session: cross-session
 * duplicates are structurally out of reach here (each session is its own
 * independent call with no visibility into any other), so widening the
 * instruction could not fix them and would only suppress real rows.
 */
export function buildExtractionPrompt(sessionDate: string | null, turns: LongMemEvalTurn[]): string {
    const dateLine = sessionDate ? `This session's date is ${sessionDate}.` : 'No session date is given.';
    const turnLines = turns
        .map((t, i) => `[${i}] ${t.role}: ${t.content}`)
        .join('\n');
    return (
        `You are extracting countable/quantifiable facts from ONE session of a long chat history between a user and an assistant.\n\n` +
        `A countable fact is anything that could later be counted, summed, or ordered. Include:\n` +
        `- a purchase or expense (put the amount in numeric_value)\n` +
        `- a visit, trip, event, or activity the user actually did (put the date in event_date when stated)\n` +
        `- time spent on something (hours/days/weeks, put the number in numeric_value)\n` +
        `- an outstanding item or obligation attached to a specific object: something to pick up, collect, return, exchange, or drop off, or something waiting for the user at a shop or service ("I still need to pick up the new pair", "my blazer is at the dry cleaner")\n` +
        `- a role or responsibility the user holds or held: leading, running, managing, organising, or being responsible for a team, project, group, or event\n` +
        `- an undertaking the user is in the middle of: a project, course, class, application, or piece of work already under way ("I've been working on a solo project for my Data Mining class")\n\n` +
        `Exclude opinions, preferences, and undecided intentions that have no committed object ("I want to", "I might", "I'm thinking about", "maybe one day").\n` +
        `An obligation with a concrete object is NOT an undecided intention. "I still need to return these boots" and "I have to collect my coat" are countable and MUST be included, even though they have not happened yet.\n\n` +
        `Work through the turns one at a time, in index order: for each turn, decide what countable facts THAT turn states before you move to the next one. Do not skim the session as a whole.\n` +
        `A single turn can yield zero, one, or several facts. A turn saying the user bought an item, needs to return it, and still needs to collect the replacement states THREE facts, not one — emit a separate row for each.\n` +
        `Do not emit duplicate rows for the same underlying event: when a later turn in this session restates a fact an earlier turn already gave, emit it once. Two different facts about the same object (buying it, and still needing to collect it) are NOT the same event.\n` +
        `When you are unsure whether a mention is countable, INCLUDE it. A row that turns out to be irrelevant is harmless, but nothing downstream can recover a fact you leave out.\n\n` +
        `${dateLine}\n\n` +
        `Session turns:\n${turnLines}\n\n` +
        `Return ONLY a JSON array (no prose, no markdown fences). Each element has this exact shape:\n` +
        `{"category": "<short label e.g. purchase, visit, trip, activity, reading, gaming, pending_item, leadership, project>", "description": "<short factual description>", "numeric_value": <number or null>, "event_date": "<YYYY-MM-DD or null>", "source_turn_index": <0-based index of the turn the fact came from>}\n\n` +
        `"description" holds the fact alone — never your reasoning about whether to include it.\n\n` +
        `If the session contains no countable facts, return [].`
    );
}

/** Pull the first JSON array out of a possibly-fenced, possibly-prose-wrapped
 *  model response. Returns null when no `[...]` span exists. */
function extractJsonArray(text: string): string | null {
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1]!.trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    return t.slice(start, end + 1);
}

/**
 * Parse a raw extraction response into CountableFacts. Pure and defensive:
 * any malformed item is skipped (not thrown), and `source_turn_index` is
 * mapped to the deterministic node id (`<question_id>::<session_id>::<turn>`).
 */
export function parseExtractionResult(
    text: string,
    questionId: string,
    sessionId: string,
): CountableFact[] {
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

    const facts: CountableFact[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const category = typeof o.category === 'string' ? o.category.trim() : '';
        const description = typeof o.description === 'string' ? o.description.trim() : '';
        const sourceTurnIndex =
            typeof o.source_turn_index === 'number' && Number.isInteger(o.source_turn_index)
                ? o.source_turn_index
                : null;
        if (!category || !description || sourceTurnIndex == null) continue;

        const numericValue =
            typeof o.numeric_value === 'number' && Number.isFinite(o.numeric_value)
                ? o.numeric_value
                : null;
        const eventDate =
            typeof o.event_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.event_date)
                ? o.event_date
                : null;

        facts.push({
            category,
            description,
            numericValue,
            eventDate,
            sourceNodeId: buildNodeId(questionId, sessionId, sourceTurnIndex),
        });
    }
    return facts;
}

async function callOpenAiExtractOnce(apiKey: string, prompt: string, model: string, maxTokens: number): Promise<{
    content: string | null;
    truncated: boolean;
    raw: unknown;
}> {
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
 * single outlier session (unusually many facts, or a backend provider that
 * doesn't honor the reasoning-disable flag; see MAX_EXTRACT_TOKENS comment)
 * shouldn't kill an entire multi-hundred-call extraction run.
 */
async function callOpenAiExtract(apiKey: string, prompt: string, model: string): Promise<string> {
    const first = await callOpenAiExtractOnce(apiKey, prompt, model, MAX_EXTRACT_TOKENS);
    if (first.content && !first.truncated) return first.content;

    const retryTokens = MAX_EXTRACT_TOKENS * 2;
    const second = await callOpenAiExtractOnce(apiKey, prompt, model, retryTokens);
    if (second.content && !second.truncated) return second.content;

    const finishHint = second.truncated
        ? ` (finish_reason="length" even at ${retryTokens} max_tokens — likely a reasoning model/provider not honoring the reasoning-disable flag; see MAX_EXTRACT_TOKENS comment)`
        : '';
    throw new Error(`Unexpected OpenAI extraction response${finishHint}: ${JSON.stringify(second.raw).slice(0, 500)}`);
}

async function callAnthropicExtract(apiKey: string, prompt: string): Promise<string> {
    const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: ANTHROPIC_EXTRACT_MODEL,
            max_tokens: MAX_EXTRACT_TOKENS,
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

/**
 * ONE LLM call for one session. Returns the countable facts ([] when the
 * session has none). Throws ExtractionUnavailableError when no key is set.
 */
export async function extractFactsFromSession(opts: {
    questionId: string;
    sessionId: string;
    sessionDate: string | null;
    turns: LongMemEvalTurn[];
    modelOverride?: string;
}): Promise<CountableFact[]> {
    const prompt = buildExtractionPrompt(opts.sessionDate, opts.turns);

    // Local Ollama (`ollama:<model>`) needs no API key — route it first, same
    // as answerModel.ts. Reasoning left OFF by default isn't forced here (the
    // caller decides), but extraction is a mechanical read-the-turns task, not
    // one where hidden reasoning is expected to earn its token cost the way it
    // might for answering — see extractCountableFacts.ts's --model docs.
    if (opts.modelOverride && isOllamaModel(opts.modelOverride)) {
        const model = stripOllamaPrefix(opts.modelOverride);
        const { content } = await callOllamaChat(model, prompt, false);
        return parseExtractionResult(content, opts.questionId, opts.sessionId);
    }

    const openAiKey = process.env['OPENAI_API_KEY'];
    if (openAiKey) {
        const raw = await callOpenAiExtract(openAiKey, prompt, opts.modelOverride ?? OPENAI_EXTRACT_MODEL);
        return parseExtractionResult(raw, opts.questionId, opts.sessionId);
    }

    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    if (anthropicKey) {
        const raw = await callAnthropicExtract(anthropicKey, prompt);
        return parseExtractionResult(raw, opts.questionId, opts.sessionId);
    }

    throw new ExtractionUnavailableError(
        'Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set. No scriptable extraction model is available.',
    );
}
