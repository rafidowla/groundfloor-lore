/**
 * detectQuestionType.ts — cheap keyword guess at which of the 6 LongMemEval
 * question categories a LIVE question belongs to.
 *
 * Why this exists: the dataset labels every instance with `question_type`
 * (types.ts), but that label is ground truth handed to the benchmark for
 * scoring — a real caller asking Lore a question at query time does not have
 * it. Every category-specific routing rule anyone might want to add (skip
 * recall entirely for a preference ask, prefer the newest matching fact for
 * a knowledge-update ask, widen the session window for multi-session, etc.)
 * is blocked until something can guess the category from the question text
 * alone. This is that guess. It mirrors detectCounting.ts exactly in spirit:
 * pattern/keyword matching, no LLM call, so it costs nothing extra on the
 * hot path, and a wrong guess only ever picks a suboptimal downstream rule —
 * it can never crash, because every branch below falls through to the next
 * and the final fallback is unconditional.
 *
 * ─── How the keyword lists were chosen ─────────────────────────────────────
 *
 * Not guessed blindly: grounded by pulling all 500 questions out of
 * data/longmemeval_s_cleaned.json, grouping by the dataset's own
 * `question_type`, and reading ~50 real examples per category (see the
 * category comments below for what stood out) before writing a single
 * pattern. Two categories turned out to have near-perfect textual tells:
 *
 *   - single-session-assistant questions are almost always phrased as a
 *     literal callback to the assistant's own earlier turn — "remind me",
 *     "our previous conversation/chat", "you mentioned/recommended/said/
 *     told/wrote". 42/56 contain "remind me" alone; the union of these cues
 *     covers 54/56 (96%) with zero false positives anywhere else in the
 *     500 (verified — see detectQuestionType.unit.ts).
 *   - single-session-preference questions ask the assistant to generate a
 *     NEW recommendation ("can you recommend/suggest…", "any tips/
 *     suggestions/advice…"), never to recall a past one. Checking this
 *     AFTER the assistant-recall check (order matters — see below) picks up
 *     26/30 (87%) cleanly.
 *
 * The other four categories are structurally harder, and the measured
 * numbers below are honest about that:
 *
 *   - temporal-reasoning has a strong but partial tell: elapsed-time/
 *     ordering grammar ("… ago", "passed", "order of", "happened first/
 *     last", "which X … first/last"). 99/133 (74%).
 *   - multi-session and knowledge-update mostly do NOT announce themselves
 *     in the question text — "How many bikes do I currently own?"
 *     (knowledge-update) and "How many bikes do I own?" (single-session-
 *     user) are asking literally the same thing; what makes one a
 *     knowledge-update question is that the haystack contains a stale
 *     answer superseded by a newer one, which is a fact about the
 *     CONVERSATION HISTORY, not about the question string. No amount of
 *     keyword tuning on the question alone closes that gap — the honest
 *     ceiling here is aggregation words ("in total", "combined", "across",
 *     "in the past N months") for multi-session (57/133, 43%) and
 *     recency/change words ("currently", "have I", "previously", "how
 *     often", "recently") for knowledge-update (43/78, 55%).
 *   - single-session-user has no positive signal of its own — it is what's
 *     left after every other category's cues fail to fire — so it is the
 *     unconditional final fallback, not a checked branch.
 *
 * Measured overall accuracy across all 500 instances: 343/500 (68.6%),
 * roughly 4x the 16.7% a 6-way random guess would score. Re-verify this
 * number with detectQuestionType.unit.ts before changing any pattern list;
 * the numbers above are what motivated the cascade order, not a target to
 * chase by overfitting new per-question patterns (that would just memorize
 * this 500-row sample instead of generalizing to a live caller's question).
 *
 * ─── Why cascade order matters ─────────────────────────────────────────────
 *
 * Checks run in order and the first match wins, specifically so a stronger,
 * more specific signal is never shadowed by a weaker, more general one:
 * assistant-recall and preference are checked first because they are the
 * two near-unambiguous categories (a "remind me" question is never actually
 * a counting question). temporal-reasoning is checked before multi-session
 * because "how many days passed…" would otherwise also trip the aggregation
 * word "total" some of the time. multi-session is checked before
 * knowledge-update because its cues (aggregation across explicitly many
 * things) are higher-precision than knowledge-update's (recency/"have I",
 * which can just as easily describe a single-session fact). Reordering any
 * of this without re-running the unit test's accuracy report is how this
 * silently regresses.
 */

import type { LongMemEvalQuestionType } from './types.js';

/** single-session-assistant — the question explicitly recalls something the
 *  ASSISTANT said in an earlier turn, not something the user experienced. */
const ASSISTANT_RECALL_PATTERNS: readonly RegExp[] = [
    /\bremind me\b/i,
    /\bprevious (?:conversation|chat|session|game)\b/i,
    /\byou (?:mentioned|recommended|suggested|said|told|wrote|created|provided|gave|listed)\b/i,
    /\bdid you say\b/i,
];

/** single-session-preference — asks the assistant to generate fresh advice
 *  or a recommendation, rather than recalling a past one (checked after
 *  ASSISTANT_RECALL_PATTERNS, since "can you recommend" and "you
 *  recommended" are near-opposite asks that share a root word). */
const PREFERENCE_REQUEST_PATTERNS: readonly RegExp[] = [
    /\bcan you (?:recommend|suggest)\b/i,
    /\bany (?:tips|suggestions|advice|recommendations|ideas)\b/i,
    /\bwhat do you think\b/i,
    /\bdo you have any (?:tips|suggestions|ideas)\b/i,
    /\bdo you think\b/i,
];

/** temporal-reasoning — elapsed-time or event-ordering grammar. Deliberately
 *  narrower than detectCounting.ts's DATE_ARITHMETIC_CUES (this only needs
 *  to flag the category, not veto a separate counting decision), but the
 *  underlying phrasing is the same dataset vocabulary. */
const TEMPORAL_PATTERNS: readonly RegExp[] = [
    /\bago\b/i,
    /\bpassed\b/i,
    /\border of\b/i,
    /\bhappened (?:first|last)\b/i,
    /\b(?:which|who)\b[^?]*\b(?:first|last|earliest|latest)\b/i,
    /\bsince i\b/i,
];

/** multi-session — the question asks for something aggregated or compared
 *  ACROSS multiple past occurrences, which by construction requires
 *  evidence spread over more than one session. */
const MULTI_SESSION_PATTERNS: readonly RegExp[] = [
    /\bin total\b/i,
    /\bcombined\b/i,
    /\bcompared to\b/i,
    /\bacross\b/i,
    /\baverage\b/i,
    /\bin the past (?:few |two |three |couple of )?(?:month|week|year)s?\b/i,
    /\bhow many different\b/i,
    /\btotal\b/i,
];

/** knowledge-update — the question is framed around the CURRENT/latest state
 *  of something that plausibly changed, which is exactly the shape of a
 *  question whose answer in the haystack was later superseded. Lower
 *  precision than the categories above (see header) because "current state"
 *  framing also describes plenty of single-session-user questions. */
const KNOWLEDGE_UPDATE_PATTERNS: readonly RegExp[] = [
    /\bcurrently\b/i,
    /\bcurrent\b/i,
    /\bso far\b/i,
    /\bpreviously\b/i,
    /\bused to\b/i,
    /\bnow\?/i,
    /\bhave i\b/i,
    /\bhow often\b/i,
    /\brecently\b/i,
];

function matchesAny(q: string, patterns: readonly RegExp[]): boolean {
    return patterns.some((re) => re.test(q));
}

/**
 * Guesses which of the 6 LongMemEval categories `question` belongs to, from
 * the question text alone (no dataset label, no LLM call). See the header
 * comment for measured per-category accuracy and why the cascade is ordered
 * the way it is. Always returns a value — `single-session-user` is the
 * unconditional fallback, so this can never throw or return undefined.
 */
export function detectQuestionType(question: string): LongMemEvalQuestionType {
    const q = question.trim();

    if (matchesAny(q, ASSISTANT_RECALL_PATTERNS)) return 'single-session-assistant';
    if (matchesAny(q, PREFERENCE_REQUEST_PATTERNS)) return 'single-session-preference';
    if (matchesAny(q, TEMPORAL_PATTERNS)) return 'temporal-reasoning';
    if (matchesAny(q, MULTI_SESSION_PATTERNS)) return 'multi-session';
    if (matchesAny(q, KNOWLEDGE_UPDATE_PATTERNS)) return 'knowledge-update';

    return 'single-session-user';
}
