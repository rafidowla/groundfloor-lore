/**
 * preferenceEvents.ts — the structured-records table for stated user
 * preferences/opinions (LongMemEval harness).
 *
 * Why this exists: `single-session-preference` questions ("what kind of
 * restaurant do I prefer") are the measurably weakest retrieval category in
 * this harness — recall_any@20 of only ~60%, against 90-100% for every other
 * category. The gap is not that the evidence is missing from the haystack: a
 * preference is usually stated once, indirectly, and off-topic relative to
 * how the eventual question is worded ("I love spicy food" / "I don't really
 * like loud places" instead of anything resembling "restaurant preference"),
 * so a similarity search over the raw turn text has nothing question-shaped
 * to match against. This table is the same fix `countable_events` already
 * applies to counting questions: an ingest-time LLM pass (see
 * preferenceFactExtraction.ts) reads each session once and writes every
 * stated preference as one row, so the answering step can read known
 * preferences directly instead of hoping search surfaces the right sentence.
 *
 * This mirrors countableEvents.ts's shape deliberately, not coincidentally —
 * same forced-common-schema-over-prose reasoning (the source is conversation
 * prose with no fixed shape, so ONE generic table beats a per-fact inferred
 * schema), same `ITableStorage` idempotent `createTable` + batch
 * `insertBatch`, same `_source_*`-style traceability via `source_node_id`
 * pointing at the originating conversation-turn node, and the same
 * content-hash idempotency so re-running extraction on an already-extracted
 * session is a no-op rather than a duplicate row. See countableEvents.ts's
 * header for the fuller rationale behind each of those choices — it is not
 * repeated here.
 *
 * What differs from CountableFact: no `numeric_value`/`event_date` pair
 * (preferences aren't dated or summed); instead a coarse `sentiment`
 * ('like' | 'dislike') for cheap categorical filtering, plus an optional
 * `strength` only when the wording clearly conveys intensity ("I absolutely
 * love X" vs. "X is fine, I guess") — most stated preferences carry no
 * intensity signal at all, so this is nullable exactly like `numeric_value`
 * is on the countable side.
 */

import { createHash } from 'node:crypto';
import type { ITableStorage, Row, TableSchema } from '../../../packages/lore/src/contracts/tables.js';

export const PREFERENCE_EVENTS_TABLE = 'preference_events';

/** Fixed schema — same reasoning as COUNTABLE_EVENTS_SCHEMA: the source has
 *  no natural shape, so we force one common shape rather than inferring a
 *  per-fact schema. */
const PREFERENCE_EVENTS_SCHEMA: TableSchema = {
    name: PREFERENCE_EVENTS_TABLE,
    description: 'Machine-extracted stated preferences/opinions from conversation sessions.',
    columns: [
        { name: 'id', type: 'string', primary: true, required: true },
        { name: 'ecosystem', type: 'string', required: true, indexed: true },
        { name: 'topic', type: 'string', required: true, indexed: true },
        { name: 'statement', type: 'string' },
        { name: 'sentiment', type: 'string', required: true, indexed: true },
        { name: 'strength', type: 'float' },
        { name: 'source_node_id', type: 'string' },
    ],
};

/** Coarse polarity of a stated preference. Deliberately two-valued, not
 *  three: a turn expressing both ("I like spicy food but not sushi") states
 *  TWO preferences, not one 'mixed' one — see the multi-fact-per-turn
 *  instruction in preferenceFactExtraction.ts's prompt, mirroring how
 *  extractFacts.ts's countable prompt handles one turn yielding several rows. */
export type PreferenceSentiment = 'like' | 'dislike';

/** One stated preference/opinion extracted from a session. */
export interface PreferenceFact {
    /** Free-text bucket the extraction step chose ("food", "music",
     *  "environment", "activities", ...). Not a fixed enum — do not
     *  hardcode one, same convention as CountableFact.category. */
    topic: string;
    /** Short factual restatement, phrased "likes X" / "dislikes Y" so the
     *  answering model can cite it directly without re-deriving polarity. */
    statement: string;
    /** Coarse like/dislike, redundant with the phrasing in `statement` but
     *  kept as its own indexed column so a query can filter on it cheaply
     *  without parsing prose. */
    sentiment: PreferenceSentiment;
    /** Nullable 1-5 intensity, populated ONLY when the wording clearly
     *  conveys one ("love"/"can't stand" ≈ 5, "kind of like"/"not really
     *  into" ≈ 2) — most statements carry no intensity signal, and guessing
     *  one where none was given would be fabricating a fact that wasn't
     *  stated. */
    strength?: number | null;
    /** Traceability: the deterministic Lore node id of the originating turn
     *  (`<question_id>::<session_id>::<turn_index>`), identical convention
     *  to CountableFact.sourceNodeId. */
    sourceNodeId: string;
}

/**
 * Deterministic key for a fact — same construction as countableEvents.ts's
 * `factId`: a content hash over the fact's own fields (including its source
 * node id) so idempotent re-extraction of the same session reproduces the
 * same key instead of inserting a duplicate row.
 */
export function factId(fact: PreferenceFact): string {
    const canonical = [
        fact.topic ?? '',
        fact.statement ?? '',
        fact.sentiment ?? '',
        fact.strength == null ? '' : String(fact.strength),
        fact.sourceNodeId ?? '',
    ].join('');
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Map one fact to its table row (keyed by the fixed schema column names). */
export function factToRow(fact: PreferenceFact, ecosystem: string): Row {
    return {
        id: factId(fact),
        ecosystem,
        topic: fact.topic,
        statement: fact.statement,
        sentiment: fact.sentiment,
        strength: fact.strength ?? null,
        source_node_id: fact.sourceNodeId,
    };
}

/**
 * Create-or-reconcile + batch-insert. Identical shape to
 * `writeCountableFacts` — the schema is fixed, so "reconcile" here is
 * row-level idempotency (dedupe against existing keys), never schema
 * evolution, and nothing here ever deletes or mutates an existing row.
 */
export async function writePreferenceFacts(
    tableStorage: ITableStorage,
    ecosystem: string,
    facts: PreferenceFact[],
): Promise<{ inserted: number; skipped: number }> {
    if (facts.length === 0) return { inserted: 0, skipped: 0 };

    // Idempotent create (same shape → no-op; changed shape → throws, which is
    // the intended safety signal — the schema is fixed by this module).
    await tableStorage.createTable(PREFERENCE_EVENTS_SCHEMA);

    const existingRows = await queryPreferenceFacts(tableStorage, ecosystem);
    const existingIds = new Set(existingRows.map((r) => String(r.id)));

    // Dedupe both against the table AND within this batch (two identical
    // facts from one extraction must not collide on the primary key).
    const seen = new Set<string>(existingIds);
    const newFacts: PreferenceFact[] = [];
    for (const fact of facts) {
        const id = factId(fact);
        if (seen.has(id)) continue;
        seen.add(id);
        newFacts.push(fact);
    }

    if (newFacts.length === 0) return { inserted: 0, skipped: facts.length };

    await tableStorage.insertBatch(
        PREFERENCE_EVENTS_TABLE,
        newFacts.map((f) => factToRow(f, ecosystem)),
    );
    return { inserted: newFacts.length, skipped: facts.length - newFacts.length };
}

/** Read every fact for an ecosystem, in schema order. */
export async function queryPreferenceFacts(
    tableStorage: ITableStorage,
    ecosystem: string,
): Promise<Row[]> {
    return await tableStorage.query(
        PREFERENCE_EVENTS_TABLE,
        { eq: { ecosystem } },
        { limit: 100_000 },
    );
}

/** Drop the leading `<ecosystem>::` segment of a source node id — identical
 *  helper to countableEvents.ts's private `shortSource` (not imported from
 *  there: it is a two-line pure function with zero shared state, and
 *  duplicating it keeps this module's only dependency on countableEvents.ts
 *  at zero, which matters because the two tables are meant to evolve
 *  independently). The id shape is `<question_id>::<session_id>::<turn_index>`
 *  (`buildNodeId` in ingest.ts); anything of a different shape passes
 *  through untouched. */
function shortSource(sourceNodeId: string): string {
    const parts = sourceNodeId.split('::');
    return parts.length === 3 ? `${parts[1]}::${parts[2]}` : sourceNodeId;
}

/**
 * Format structured rows for the answering prompt — one line per known
 * preference, so a preference question can be answered by reading this block
 * directly instead of trusting that search happened to surface the one
 * sentence it was stated in. Sorted deterministically (topic → sentiment →
 * node) so re-runs are stable. Pure. Empty input → empty string.
 */
export function formatPreferenceFacts(rows: Row[]): string {
    if (rows.length === 0) return '';

    const sorted = [...rows].sort((a, b) => {
        const ta = String(a.topic ?? '');
        const tb = String(b.topic ?? '');
        if (ta !== tb) return ta < tb ? -1 : 1;
        const sa = String(a.sentiment ?? '');
        const sb = String(b.sentiment ?? '');
        if (sa !== sb) return sa < sb ? -1 : 1;
        const na = String(a.source_node_id ?? '');
        const nb = String(b.source_node_id ?? '');
        return na < nb ? -1 : na > nb ? 1 : 0;
    });

    const lines = sorted.map((r) => {
        const head = `[${r.topic ?? 'preference'}] ${r.statement ?? ''}`.trim();
        const parts = [head];
        if (r.sentiment) parts.push(`sentiment=${r.sentiment}`);
        if (r.strength != null) parts.push(`strength=${r.strength}`);
        if (r.source_node_id) parts.push(`src=${shortSource(String(r.source_node_id))}`);
        return `- ${parts.join(', ')}`;
    });

    return (
        `The following ${lines.length} known preference(s) were extracted from the full conversation history (one per line). ` +
        `Treat these as the user's actual stated preferences/opinions — prefer this list over inferring a preference from the raw ` +
        `conversation text below, since these were already identified as preference statements at ingestion time. ` +
        `src=<session>::<turn> is the exact turn each preference was stated in:\n${lines.join('\n')}`
    );
}
