/**
 * structuredFactsAggregate.ts — exact COUNT over countable_events, computed by
 * Lore's OWN aggregate engine instead of left for the answering LLM to count
 * by hand.
 *
 * Why this exists: `countable_events` (countableEvents.ts) is written and read
 * through `ITableStorage`, the exact same contract Lore's relational substrate
 * exposes `IAnalyticalStorage` over (`engines/analyticalStorageFactory.ts` —
 * `createAnalyticalStorage(tableStorage)`, universal across local and cloud per
 * decision `lore-analytical-primitive-universal-2026-05-09`). Before this file,
 * the counting path (runSubset.ts) fetched every row and serialized it to prose
 * (`formatStructuredFacts`) for the answering model to count by hand — never
 * delegated to Lore's real aggregate engine, even though the rows already live
 * in a table that engine can query directly. This file closes that gap for
 * COUNT only: it computes an exact row count via SQL, over a lexically-scoped
 * subset of the rows, and hands the answering model a labeled, pre-computed
 * number alongside the existing (unchanged) full row listing.
 *
 * ─── SUM is deliberately NOT computed here (2026-09-20) ───────────────────
 *
 * An earlier version of this file also called `analytical.sum('numeric_value')`
 * over the same on-topic subset. Tested against the real gpt4_d84a3211 data
 * ("how much have I spent on bike expenses", gold $185): the SQL sum came back
 * $2,356. Cause: LongMemEval sessions re-narrate the same past event across
 * multiple turns (recaps), so the SAME $40 purchase got extracted as 3
 * separate rows — a keyword filter has no way to know those three rows
 * describe one real-world purchase, and `SUM()` has even less: it just adds
 * 40+40+40. Deduplicating by "same real-world event" needs source/semantic
 * judgment (which turn, which sentence, is this a restatement or a second
 * occurrence), which is exactly the reasoning `formatStructuredFacts`'s own
 * `src=` provenance tagging exists to support — see that function's header
 * comment for why similarity-based row-merging was already rejected once (the
 * 25hr/30hr example) as an unsafe way to solve this. A blind SQL sum has the
 * same failure mode with none of that judgment, so it is not "a database
 * function" in the sense that matters here: it is a database function
 * pointed at un-deduplicated input, which produces a confidently wrong
 * number. COUNT of on-topic rows doesn't have this problem in the same way —
 * verified against 6d550036 ("how many projects have you led", gold 2): the
 * lexical filter kept exactly the 2 real leadership rows and excluded the
 * Nigeria distractor, and `count()` returned 2, exactly right.
 *
 * If duplicate-mention handling for SUM is tackled later, it needs its own
 * dedup step (grouped by real-world-event identity, not lexical overlap)
 * BEFORE any aggregate call — do not just add `analytical.sum(...)` back
 * without that.
 *
 * `formatStructuredFacts` and its no-drop contract (countableEvents.ts,
 * pinned by countableEvents.unit.ts) are untouched: this file is additive
 * prose in front of that block, not a replacement for it.
 */

import type { Row } from '../../../packages/lore/src/contracts/tables.js';
import type { IAnalyticalStorage } from '../../../packages/lore/src/contracts/analytical.js';
import type { Filter } from '../../../packages/lore/src/engines/collectionStorage.js';
import { COUNTABLE_EVENTS_TABLE } from './countableEvents.js';

/**
 * Trimmed for the LongMemEval question corpus — not exhaustive English
 * stopwords. Includes generic temporal/quantity filler ("since", "start",
 * "year", "related"…) that recurs across nearly every question template
 * ("since the start of the year", "in the past month", "combined") without
 * carrying topic information — found via a real failure: on gpt4_d84a3211
 * ("…bike-related expenses since the start of the year"), "start" matched 12
 * unrelated rows (a MacBook purchase, yoga, reading) purely because those
 * rows separately said "started practicing yoga" / "starting with 'The
 * Upanishads'" etc. Those words are rare enough within any one ecosystem to
 * survive a document-frequency filter, so they must be excluded up front.
 */
const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'were', 'have', 'has', 'had', 'did',
    'does', 'this', 'that', 'these', 'those', 'with', 'from', 'into', 'about',
    'you', 'your', 'yourself', 'me', 'my', 'mine', 'i', 'we', 'our', 'ours',
    'what', 'when', 'where', 'which', 'who', 'whom', 'how', 'many', 'much',
    'total', 'combined', 'over', 'all', 'any', 'each', 'a', 'an', 'of', 'in',
    'on', 'to', 'is', 'it', 'been', 'be', 'do', 'did', 'am', 'or', 'per',
    'related', 'since', 'start', 'started', 'starting', 'year', 'years',
    'month', 'months', 'week', 'weeks', 'day', 'days', 'ago', 'past', 'last',
    'recently', 'currently',
]);

/** Lower-cases, strips punctuation, drops stopwords/short tokens. Pure. */
export function extractContentWords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9$]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export interface RelevancePartition {
    onTopic: Row[];
    other: Row[];
}

/**
 * Above this document-frequency fraction, a question word recurs in too many
 * of THIS ecosystem's rows to mean anything as a topic signal. Common words
 * are filtered out per-ecosystem (not via a fixed list) because what counts
 * as "generic filler" depends on what this particular ecosystem's rows
 * happen to repeat, not on English in general.
 */
const TOPIC_WORD_DOC_FREQ_CAP = 0.3;

/**
 * Splits `rows` by lexical overlap between the question's content words and
 * each row's `category`+`description`. A row is on-topic if it shares at
 * least one *topic* word with the question — a content word is only promoted
 * to a topic word if it does NOT recur across most of this ecosystem's rows
 * (see `TOPIC_WORD_DOC_FREQ_CAP`); otherwise every candidate word is used
 * as-is, since filtering everything away would be worse than filtering
 * nothing.
 *
 * Falls back to "everything is on-topic" (never an empty aggregate scope)
 * when the question has zero usable content words, or when the overlap rule
 * would otherwise produce zero on-topic rows — an aggregate silently computed
 * over nothing is a worse failure mode than an unfiltered one, since nothing
 * downstream would notice.
 */
export function partitionByRelevance(question: string, rows: Row[]): RelevancePartition {
    const candidateWords = extractContentWords(question);
    if (candidateWords.length === 0 || rows.length === 0) return { onTopic: rows, other: [] };

    const rowTexts = rows.map((r) => `${r.category ?? ''} ${r.description ?? ''}`.toLowerCase());
    const topicWords = candidateWords.filter((w) => {
        const docFreq = rowTexts.filter((t) => t.includes(w)).length / rowTexts.length;
        return docFreq > 0 && docFreq <= TOPIC_WORD_DOC_FREQ_CAP;
    });
    const words = topicWords.length > 0 ? topicWords : candidateWords;

    const onTopic: Row[] = [];
    const other: Row[] = [];
    rowTexts.forEach((rowText, i) => {
        const hit = words.some((w) => rowText.includes(w));
        (hit ? onTopic : other).push(rows[i]!);
    });
    if (onTopic.length === 0) return { onTopic: rows, other: [] };
    return { onTopic, other };
}

export interface ComputedAggregate {
    computedCount: number;
}

/**
 * Exact count, computed via Lore's real `IAnalyticalStorage` over exactly
 * `onTopicIds` within `ecosystem` — never a JS array-length stand-in. Empty
 * `onTopicIds` short-circuits to `{ computedCount: 0 }` without a query (an
 * empty `in` filter is not guaranteed meaningful across substrates).
 *
 * SUM is intentionally not offered here — see this file's header comment.
 */
export async function computeStructuredAggregate(
    analytical: IAnalyticalStorage,
    ecosystem: string,
    onTopicIds: readonly string[],
): Promise<ComputedAggregate> {
    if (onTopicIds.length === 0) return { computedCount: 0 };
    const filter: Filter = { eq: { ecosystem }, in: { id: [...onTopicIds] } };
    const computedCount = await analytical.count(COUNTABLE_EVENTS_TABLE, filter);
    return { computedCount };
}

/** Renders the computed-aggregate block prepended ahead of `formatStructuredFacts`'s output. */
export function formatComputedAggregateBlock(input: {
    totalRows: number;
    onTopicCount: number;
    aggregate: ComputedAggregate;
}): string {
    const { totalRows, onTopicCount, aggregate } = input;
    return (
        `Computed by Lore's own SQL aggregate engine (exact, not LLM counting): of the ` +
        `${totalRows} structured record(s) below, ${onTopicCount} were auto-selected as ` +
        `on-topic for this question by keyword overlap, and that on-topic set contains ` +
        `exactly ${aggregate.computedCount} record(s). Use this as the count of matching ` +
        `items ONLY if the question asks for a count of distinct things — it is not a sum, ` +
        `and it is not reliable if the same item is described more than once below (check ` +
        `\`src=\` on the records below for that). Auto-selection is a heuristic keyword ` +
        `match, not a guarantee: verify it against the full record list, especially if a ` +
        `record you'd expect to be included is missing, or an unrelated one was pulled in.`
    );
}
