/**
 * extractPropositions.ts — Mosaic's proposition-decomposition pass.
 *
 * Root cause this exists to fix (found 2026-08-16, see the 19-case retrieval-
 * gap dig): a short, relevant fact stated as an aside inside a turn whose
 * main topic is something else gets diluted into that turn's single whole-
 * turn embedding. "By the way, I made a baguette on Saturday" buried inside
 * a question about crispy chicken wings scores lower on similarity to "how
 * many times did I bake" than a turn that's purely about baking — 17 of 19
 * confirmed retrieval-gap failures traced to exactly this pattern.
 *
 * The fix: one LLM pass per session that rewrites every standalone fact in
 * the session as its own self-contained sentence — resolving pronouns and
 * implicit references so "it cost $25" becomes "the bike chain replacement
 * cost $25" — and each proposition gets embedded and stored as ITS OWN node,
 * alongside (never replacing) the original turn-level nodes ingest.ts already
 * creates. Search can then match the proposition directly, independent of
 * whatever else was in its source turn.
 *
 * Unlike extractFacts.ts's countable-facts pass (numeric/countable facts
 * only, user-stated only, feeds Bucket B's structured-record table), this
 * pass extracts ANY standalone fact from ANY role — LongMemEval's own
 * evidence turns include assistant messages (e.g. "what was the 7th job in
 * the list you gave me" — the evidence is the assistant's own prior list).
 */

import { callAnthropic, HAIKU_MODEL } from './anthropicClient.js';
import type { LongMemEvalTurn } from './types.js';

export class PropositionExtractionUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'PropositionExtractionUnavailableError';
    }
}

/**
 * The model was still cut off at `max_tokens` after the retry at double the
 * budget. Distinct class (not a bare Error) so a caller can tell "this session
 * is too dense to extract in one call" apart from a transport/parse failure —
 * the fix is a bigger budget or splitting the session, not a re-run.
 */
export class PropositionExtractionTruncatedError extends Error {
    constructor(readonly attemptedMaxTokens: number, reason: string) {
        super(reason);
        this.name = 'PropositionExtractionTruncatedError';
    }
}

/**
 * The response completed normally but no JSON array could be recovered from
 * it. Thrown rather than returned as `[]` on purpose: an unparseable response
 * means we do NOT know how many facts the session had, which is a different
 * fact about the world than "this session genuinely has none", and the old
 * silent `[]` made the two identical to every caller.
 */
export class PropositionParseError extends Error {
    constructor(readonly rawSample: string, reason: string) {
        super(reason);
        this.name = 'PropositionParseError';
    }
}

export interface Proposition {
    /** Self-contained factual statement — no pronouns or implicit references
     *  back to earlier turns; must be understandable completely on its own. */
    text: string;
    sourceTurnIndex: number;
}

const MAX_PROPOSITION_TOKENS = 2000;

/** Pure prompt builder — exported for unit tests (no API calls). */
export function buildPropositionPrompt(sessionDate: string | null, turns: LongMemEvalTurn[]): string {
    const dateLine = sessionDate ? `This session's date is ${sessionDate}.` : 'No session date is given.';
    const turnLines = turns.map((t, i) => `[${i}] ${t.role}: ${t.content}`).join('\n');
    return (
        `You are decomposing ONE session of a long chat history into standalone factual propositions, for a search index.\n\n` +
        `A proposition is ONE fact, rewritten so it is understandable completely on its own, with NO pronouns and NO implicit ` +
        `references to anything said earlier or later in the conversation. Replace "it", "that", "the trip", "this" etc. with ` +
        `what they actually refer to, using names/subjects spelled out in full.\n\n` +
        `Example: the turn "I recently got a new set of bike lights installed, which were $40" becomes the proposition ` +
        `"The user's new bike lights cost $40."\n\n` +
        `Extract a proposition for EVERY standalone fact stated in this session — from EITHER the user or the assistant. This ` +
        `includes: things the user did, bought, owns, or experienced; dates and durations; preferences and opinions the user ` +
        `stated; roles, relationships, and identities; and anything the ASSISTANT stated that the user might later ask about ` +
        `(e.g. a list, a recommendation, an explanation) — LongMemEval questions sometimes ask the user to recall something the ` +
        `assistant itself said. Do not extract generic assistant filler that states no fact (greetings, "I'd be happy to help").\n\n` +
        `A turn mentioned only as a passing aside inside a longer message about something else is EXACTLY the case this exists ` +
        `for — extract it as fully as any turn whose main topic is that fact.\n\n` +
        `${dateLine}\n\n` +
        `Session turns:\n${turnLines}\n\n` +
        `Return ONLY a JSON array (no prose, no markdown fences). Each element has this exact shape:\n` +
        `{"text": "<standalone proposition, no pronouns>", "source_turn_index": <0-based index of the turn it came from>}\n\n` +
        `If the session contains no extractable facts, return [].`
    );
}

/** Pull the first JSON array out of a possibly-fenced, possibly-prose-wrapped
 *  model response. Mirrors extractFacts.ts's extractJsonArray. */
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
 * Outcome of parsing one response. `ok` carries the propositions and may
 * legitimately be EMPTY — the model returning `[]` for a session with no
 * extractable facts is a correct answer, not a failure. `unparseable` means
 * nothing valid could be recovered, so the true count is unknown.
 *
 * This split is the whole point: `parsePropositionResult` collapsed both into
 * `[]`, so a malformed or truncated response looked exactly like a genuinely
 * empty session and sessions silently contributed nothing to the index.
 */
export type PropositionParseOutcome =
    | { status: 'ok'; propositions: Proposition[] }
    | { status: 'unparseable'; reason: string };

/** Pure parser that preserves WHY it failed — exported for unit tests. */
export function parsePropositionResultDetailed(text: string): PropositionParseOutcome {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') return { status: 'unparseable', reason: 'empty response body' };
    const jsonText = extractJsonArray(trimmed);
    if (jsonText === null) return { status: 'unparseable', reason: 'no JSON array found in response' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        // The signature of a cut-off response: a `[` opened, never closed.
        return { status: 'unparseable', reason: `JSON.parse failed: ${(err as Error).message}` };
    }
    if (!Array.isArray(parsed)) return { status: 'unparseable', reason: 'parsed JSON is not an array' };

    return { status: 'ok', propositions: collectPropositions(parsed) };
}

/**
 * Lenient parser kept for callers that only want the propositions.
 *
 * NOTE: this still flattens every failure to `[]` — that is exactly the
 * ambiguity Bug C is about. `extractPropositionsFromSession` uses
 * `parsePropositionResultDetailed` instead. Prefer that in new code.
 */
export function parsePropositionResult(text: string): Proposition[] {
    const outcome = parsePropositionResultDetailed(text);
    return outcome.status === 'ok' ? outcome.propositions : [];
}

/** Shape-check + normalise the items of an already-parsed array. */
function collectPropositions(parsed: unknown[]): Proposition[] {
    const props: Proposition[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const propText = typeof o.text === 'string' ? o.text.trim() : '';
        const sourceTurnIndex =
            typeof o.source_turn_index === 'number' && Number.isInteger(o.source_turn_index)
                ? o.source_turn_index
                : null;
        if (!propText || sourceTurnIndex == null) continue;
        props.push({ text: propText, sourceTurnIndex });
    }
    return props;
}

export interface ExtractPropositionsResult {
    propositions: Proposition[];
    /** Token totals across EVERY attempt, so a retried session's real cost is
     *  reported rather than just the successful call's. */
    inputTokens: number;
    outputTokens: number;
    /** True when the first attempt came back truncated and the retry at double
     *  the budget was used. Surfaced so a run can report how close it is to
     *  needing a bigger default. */
    retried: boolean;
    /**
     * True only when the model returned a well-formed, genuinely EMPTY array —
     * i.e. "this session really has 0 facts", verified, not assumed. A failure
     * never sets this; it throws instead.
     */
    emptySession: boolean;
}

/** Injection seam for unit tests — the real transport by default. */
export type PropositionCaller = (prompt: string, maxTokens: number) => Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
    stopReason: string | null;
}>;

const defaultCaller: PropositionCaller = (prompt, maxTokens) =>
    callAnthropic(prompt, maxTokens, HAIKU_MODEL);

/**
 * ONE Haiku call for one session, with ONE retry at double the token budget
 * when the response was truncated — mirroring extractFacts.ts's
 * `callOpenAiExtract`. A single unusually fact-dense session shouldn't come
 * back empty (and unnoticed) just because it overflowed the default budget.
 *
 * Failure modes are now DISTINGUISHABLE instead of all collapsing to `[]`:
 *   - still truncated after the retry → PropositionExtractionTruncatedError
 *   - completed but unparseable       → PropositionParseError
 *   - completed and genuinely empty   → returns `{ emptySession: true }`
 *   - no API key                      → PropositionExtractionUnavailableError
 *
 * The two new errors flow into buildMosaic.ts's existing `failedSessions`
 * array (the established visibility pattern, same as extractCountableFacts.ts)
 * so a failed session is reported at the end of the run rather than silently
 * contributing zero propositions to the index.
 */
export async function extractPropositionsFromSession(opts: {
    sessionDate: string | null;
    turns: LongMemEvalTurn[];
    /** Test seam. Production callers omit this. */
    caller?: PropositionCaller;
}): Promise<ExtractPropositionsResult> {
    const caller = opts.caller;
    if (!caller && !process.env['ANTHROPIC_API_KEY']) {
        throw new PropositionExtractionUnavailableError('ANTHROPIC_API_KEY is not set. No scriptable proposition-extraction model is available.');
    }
    const call = caller ?? defaultCaller;
    const prompt = buildPropositionPrompt(opts.sessionDate, opts.turns);

    const first = await call(prompt, MAX_PROPOSITION_TOKENS);
    let inputTokens = first.inputTokens;
    let outputTokens = first.outputTokens;

    // The retry is gated on BOTH signals, not on `stop_reason` alone.
    // `stop_reason: "max_tokens"` says the model ran out of budget; it does NOT
    // say the payload is unusable. A common shape is a COMPLETE JSON array
    // followed by trailing prose that got cut mid-sentence — `extractJsonArray`
    // recovers that array perfectly. Retrying it burned a second full-size
    // Haiku call (at DOUBLE the budget) to re-derive propositions we already
    // had. Only a truncation that actually costs us the data is worth paying to
    // redo, so: truncated AND unparseable.
    let final = first;
    let retried = false;
    let outcome = parsePropositionResultDetailed(first.content);
    if (first.stopReason === 'max_tokens' && outcome.status === 'unparseable') {
        retried = true;
        const retryTokens = MAX_PROPOSITION_TOKENS * 2;
        const second = await call(prompt, retryTokens);
        inputTokens += second.inputTokens;
        outputTokens += second.outputTokens;
        final = second;
        outcome = parsePropositionResultDetailed(second.content);
        // Same gate on the way out: a retry that came back truncated but
        // PARSEABLE gave us the data, so it is a success, not a hard failure.
        if (second.stopReason === 'max_tokens' && outcome.status === 'unparseable') {
            throw new PropositionExtractionTruncatedError(
                retryTokens,
                `Proposition extraction truncated (stop_reason="max_tokens") even at ${retryTokens} max_tokens — ` +
                    `session is too fact-dense for one call. Propositions for it are UNKNOWN, not zero.`,
            );
        }
    }

    if (outcome.status === 'unparseable') {
        throw new PropositionParseError(
            final.content.slice(0, 300),
            `Proposition extraction response could not be parsed (${outcome.reason})` +
                `${retried ? ' [after a truncation retry]' : ''}. Propositions for this session are UNKNOWN, not zero.`,
        );
    }

    return {
        propositions: outcome.propositions,
        inputTokens,
        outputTokens,
        retried,
        emptySession: outcome.propositions.length === 0,
    };
}
