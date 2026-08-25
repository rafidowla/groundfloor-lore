/**
 * detectCounting.ts — cheap keyword gate for counting/aggregation/ordering
 * questions.
 *
 * This is deliberately a heuristic, not a classifier: a false positive only
 * costs one local SQLite read (and a short structured section in the prompt);
 * a false negative falls back to the normal recall-only path, so this is
 * additive and can never regress the existing pipeline. The keyword list is
 * grounded in the actual LongMemEval question phrasings (see the 100-question
 * results file): "how many", "how much", "total", "order of", "combined", etc.
 *
 * ─── The elapsed-time veto (2026-08-14) ───────────────────────────────────
 *
 * The keyword list alone over-fires: "how many" also opens every elapsed-time
 * question in the dataset ("how many weeks ago did I visit my aunt", "how many
 * days passed between X and Y"). Those are ONE date subtraction — they are
 * owned by a different, already-shipped fix (the answering prompt is given
 * today's date and told to compute elapsed time itself), and the
 * countable_events rows can never answer them.
 *
 * That over-firing was not academic: in the 20-question counting validation
 * run, every question that flipped wrong→right was a misclassified date-math
 * question, so the counting system's measured "wins" were really the date
 * fix's wins. The veto exists to make the two systems measurable apart.
 *
 * Design: the veto only engages for questions that ask for a QUANTITY OF TIME
 * ("how many days/weeks/months/hours…", "how much time", "how long"). A count
 * of *things* ("how many babies", "how many different doctors", "order of the
 * six museums") is never touched. Inside that narrow branch the question is
 * classified by what the number spans:
 *
 *   one before/after date pair  → elapsed time, veto  ("how many days ago…")
 *   many scattered occurrences  → counting, keep      ("…in total", "…each day")
 *
 * The hard case is the pair "how many days did I spend on my solo camping trip
 * to Yosemite" (one trip = one start/end pair = date math) vs "how many hours
 * have I spent playing games in total" (many sessions scattered across the
 * conversation = enumeration). Surface wording is nearly identical, so
 * BOUNDED_EPISODE_FRAME keys on the actual difference: time spent *on a single
 * named episode* ("on my … trip", "during our … vacation"). Plural forms do
 * not match (`\b` blocks "trips"), because many trips is an enumeration again.
 */

/** Stage 1 — counting/aggregation/ordering vocabulary. Unchanged. */
const COUNTING_KEYWORDS: readonly string[] = [
    'how many',
    'how much',
    'how often',
    'how frequently',
    'in total',
    'total amount',
    'total money',
    'total number',
    'total spend',
    'total hours',
    'total days',
    'total weeks',
    'total time',
    'order of',
    'number of times',
    'combined',
];

/** Time units that can be the ASKED-FOR quantity ("how many days"). Not the
 *  same as units appearing anywhere in the question — "how many times did I
 *  bake in the past two weeks" counts bakes, not weeks. */
const TIME_UNIT = 'seconds?|minutes?|hours?|days?|weeks?|months?|years?|decades?';

/**
 * Stage 2a — does the question ask for a quantity of TIME (rather than a count
 * of things)? The unit must be the head noun, so at most one modifier word is
 * allowed between "how many" and the unit ("how many *total* hours"). That gap
 * is deliberately tiny: a wider one would swallow "how many times a week".
 */
const TIME_QUANTITY_PATTERNS: readonly RegExp[] = [
    new RegExp(String.raw`\bhow\s+many\s+(?:\w+\s+)?(?:${TIME_UNIT})\b`),
    /\bhow\s+much\s+(?:\w+\s+)?time\b/,
    /\bhow\s+long\b/,
];

/**
 * Stage 2b — explicit "sum across several things" markers. These OUTRANK the
 * date cues below, because they say outright that more than one occurrence is
 * in scope: "how long did I take to finish 'Evelyn Hugo' and 'The Nightingale'
 * combined" is two durations added up, i.e. still an aggregation.
 */
const TOTALLING_MARKERS: readonly string[] = [
    'in total',
    'total',
    'combined',
    'altogether',
    'all together',
    'on average',
];

/**
 * Stage 2c — date-arithmetic grammar. Only consulted for time-quantity
 * questions, which is what makes the loose-looking cues safe: "since" vetoes
 * "how many months have passed since I last visited a museum" but never
 * "how much total money have I spent … since the start of the year" (that one
 * asks for money, so it never reaches this list).
 */
const DATE_ARITHMETIC_CUES: readonly RegExp[] = [
    /\bago\b/,
    new RegExp(String.raw`\b(?:${TIME_UNIT})\s+(?:before|prior|earlier)\b`),
    /\bpassed?\b/,
    /\bsince\b/,
    /\bbetween\b[^?]*\band\b/,
    /\bdid\s+it\s+take\b/,
    /\bwhen\s+(?:i|my|we|he|she|they)\b/,
    /\b(?:older|younger)\b/,
];

/**
 * Stage 2d — time spent on ONE bounded episode. A trip/vacation/stay has
 * exactly one start date and one end date, so its length is a subtraction, not
 * an enumeration. The frame ("on/during/for/was + determiner + … + episode
 * noun") is required so that "spend driving to my three road trip
 * destinations" — where "trip" is only a modifier — does not match.
 */
const BOUNDED_EPISODE_NOUN =
    'trip|vacation|holiday|honeymoon|getaway|cruise|retreat|safari|expedition|excursion|sabbatical|staycation|stay';
const BOUNDED_EPISODE_FRAME = new RegExp(
    String.raw`\b(?:on|during|for|was|were)\s+(?:my|our|the|this|that|a|an)\s+(?:[\w'-]+\s+){0,3}?(?:${BOUNDED_EPISODE_NOUN})\b`,
);

function matchesAny(q: string, patterns: readonly RegExp[]): boolean {
    return patterns.some((re) => re.test(q));
}

/**
 * True when `question` asks for elapsed time / a duration — a single date
 * subtraction the answering model does itself from the question date, NOT
 * something the countable_events rows can answer.
 *
 * Exported so the unit test can pin the *reason* a question is excluded, and
 * so a future caller can route these to the date-math path explicitly.
 * `question` is expected lower-cased and trimmed.
 */
export function isElapsedTimeQuestion(question: string): boolean {
    const q = question.trim().toLowerCase();

    // Only questions asking for an amount of TIME can be elapsed-time
    // questions. Everything else ("how many babies", "how many doctors") is
    // out of scope for the veto entirely.
    if (!matchesAny(q, TIME_QUANTITY_PATTERNS)) return false;

    // "…in total" / "…combined" explicitly spans several occurrences.
    if (TOTALLING_MARKERS.some((kw) => q.includes(kw))) return false;

    if (matchesAny(q, DATE_ARITHMETIC_CUES)) return true;
    if (BOUNDED_EPISODE_FRAME.test(q)) return true;

    // Ambiguous time-quantity question with no date-math grammar and no single
    // episode ("how many hours of jogging and yoga did I do last week", "how
    // many days a week do I attend fitness classes"). Default to counting: the
    // structured-fact lookup is cheap and additive, while wrongly vetoing a
    // real counting question would understate the system this gate measures.
    return false;
}

/**
 * True when `question` looks like a counting/aggregation/ordering question
 * AND is not an elapsed-time/date-math question.
 * Case-insensitive; `question` is trimmed before matching.
 */
export function isCountingQuestion(question: string): boolean {
    const q = question.trim().toLowerCase();
    if (!COUNTING_KEYWORDS.some((kw) => q.includes(kw))) return false;
    return !isElapsedTimeQuestion(q);
}
