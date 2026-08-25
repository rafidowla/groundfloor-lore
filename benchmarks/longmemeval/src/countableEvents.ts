/**
 * countableEvents.ts — the structured-records table for counting/aggregation
 * questions (LongMemEval harness).
 *
 * Why this exists: ~40-45% of wrong answers in the 100-question run are
 * counting/aggregation questions ("how many times did I X", "total spend on
 * Y"). Similarity recall can never *guarantee* it surfaced every matching
 * turn, so a confidently-wrong count is worse than no answer. This table is
 * the fix: an ingest-time LLM pass (see extractFacts.ts) writes every
 * countable/quantifiable fact as one row, and query-time detection
 * (detectCounting.ts) feeds the exact rows into the answering model.
 *
 * The source data is conversation *prose* — no fixed shape — so this is ONE
 * generic table with a forced common shape (the suggested schema from the
 * task brief), NOT a per-fact inferred schema. The schema-safety surface is
 * identical to packages/lore/src/engines/tabularImport.ts (Bucket A): idempotent
 * `createTable` + batch `insertBatch`, never hand-rolled DDL, and the same
 * `_id`/`_ecosystem`/`_source_*` traceability naming convention (here the
 * source link is `source_node_id` → the originating conversation-turn node).
 *
 * Idempotency: `factId()` is a deterministic SHA-256 over the fact's own
 * fields (incl. its source node id), so re-running extraction on the same
 * session yields the same key and `writeCountableFacts` dedupes against
 * existing rows instead of inserting duplicates. Re-extraction reconcile is
 * additive-only: nothing here ever deletes or mutates an existing row.
 */

import { createHash } from 'node:crypto';
import type { ITableStorage, Row, TableSchema } from '../../../packages/lore/src/contracts/tables.js';

export const COUNTABLE_EVENTS_TABLE = 'countable_events';

/** Fixed schema — the source has no natural shape, so we force one common
 *  shape rather than inferring per-fact schemas (unlike Bucket A). */
const COUNTABLE_EVENTS_SCHEMA: TableSchema = {
    name: COUNTABLE_EVENTS_TABLE,
    description: 'Machine-extracted countable/quantifiable facts from conversation sessions.',
    columns: [
        { name: 'id', type: 'string', primary: true, required: true },
        { name: 'ecosystem', type: 'string', required: true, indexed: true },
        { name: 'category', type: 'string', required: true, indexed: true },
        { name: 'description', type: 'string' },
        { name: 'numeric_value', type: 'float' },
        { name: 'event_date', type: 'string' },
        { name: 'source_node_id', type: 'string' },
    ],
};

/** One countable/quantifiable fact extracted from a session. */
export interface CountableFact {
    /** Free-text bucket the extraction step chose ("purchase", "visit",
     *  "trip", "activity", ...). Not a fixed enum — do not hardcode one. */
    category: string;
    /** Short factual description, for the answering model to cite. */
    description: string;
    /** Nullable numeric magnitude — dollar amount, hours, count-within-one-event. */
    numericValue?: number | null;
    /** Nullable ISO date (YYYY-MM-DD) — for "in the past month" filtering/ordering. */
    eventDate?: string | null;
    /** Traceability: the deterministic Lore node id of the originating turn
     *  (`<question_id>::<session_id>::<turn_index>`). */
    sourceNodeId: string;
}

/**
 * Deterministic key for a fact. Mirrors the `_row_id` idea in
 * `tabularImport.ts` but is content-derived (hash over the fact's own
 * fields) rather than sequence-derived, so an idempotent re-extraction of
 * the same session produces the same key.
 */
export function factId(fact: CountableFact): string {
    const canonical = [
        fact.category ?? '',
        fact.description ?? '',
        fact.numericValue == null ? '' : String(fact.numericValue),
        fact.eventDate ?? '',
        fact.sourceNodeId ?? '',
    ].join('\u001f');
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Map one fact to its table row (keyed by the fixed schema column names). */
export function factToRow(fact: CountableFact, ecosystem: string): Row {
    return {
        id: factId(fact),
        ecosystem,
        category: fact.category,
        description: fact.description,
        numeric_value: fact.numericValue ?? null,
        event_date: fact.eventDate ?? null,
        source_node_id: fact.sourceNodeId,
    };
}

/**
 * Create-or-reconcile + batch-insert, following `tabularImport.ts`'s
 * `writeTabularRows` shape. The schema is fixed, so "reconcile" here is
 * row-level idempotency (dedupe against existing keys), not schema evolution.
 * Returns how many rows were newly inserted vs skipped as already-present.
 */
export async function writeCountableFacts(
    tableStorage: ITableStorage,
    ecosystem: string,
    facts: CountableFact[],
): Promise<{ inserted: number; skipped: number }> {
    if (facts.length === 0) return { inserted: 0, skipped: 0 };

    // Idempotent create (same shape → no-op; changed shape → throws, which is
    // the intended safety signal — the schema is fixed by this module).
    await tableStorage.createTable(COUNTABLE_EVENTS_SCHEMA);

    const existingRows = await queryCountableFacts(tableStorage, ecosystem);
    const existingIds = new Set(existingRows.map((r) => String(r.id)));

    // Dedupe both against the table AND within this batch (two identical
    // facts from one extraction must not collide on the primary key).
    const seen = new Set<string>(existingIds);
    const newFacts: CountableFact[] = [];
    for (const fact of facts) {
        const id = factId(fact);
        if (seen.has(id)) continue;
        seen.add(id);
        newFacts.push(fact);
    }

    if (newFacts.length === 0) return { inserted: 0, skipped: facts.length };

    await tableStorage.insertBatch(
        COUNTABLE_EVENTS_TABLE,
        newFacts.map((f) => factToRow(f, ecosystem)),
    );
    return { inserted: newFacts.length, skipped: facts.length - newFacts.length };
}

/** Read every fact for an ecosystem, in schema order. */
export async function queryCountableFacts(
    tableStorage: ITableStorage,
    ecosystem: string,
): Promise<Row[]> {
    return await tableStorage.query(
        COUNTABLE_EVENTS_TABLE,
        { eq: { ecosystem } },
        { limit: 100_000 },
    );
}

/**
 * Drop the leading `<ecosystem>::` segment of a source node id. Every row in
 * one block belongs to the same ecosystem, so that segment is identical on
 * every line and carries no information for the answering model. The id shape
 * is `<question_id>::<session_id>::<turn_index>` (`buildNodeId` in ingest.ts);
 * anything of a different shape is passed through untouched rather than
 * mangled.
 */
function shortSource(sourceNodeId: string): string {
    const parts = sourceNodeId.split('::');
    return parts.length === 3 ? `${parts[1]}::${parts[2]}` : sourceNodeId;
}

/**
 * Format structured rows for the answering prompt — one line per event, so a
 * count is "number of matching lines" and a total is "sum of their values".
 * Sorted deterministically (category → date → node) so re-runs are stable.
 * Pure. Empty input → empty string.
 *
 * ─── Why each line carries `src=` (2026-08-14) ────────────────────────────
 *
 * "How many hours have I spent playing games in total?" (gold 140) was
 * answered 110 from a table that already held every number needed. The rows
 * were right; the rendering hid the distinction the model had to make. Four
 * rows named The Last of Us Part II — two narrative-only, two numeric (25 and
 * 30) — and the row carrying the 30 read `Time spent playing The Last of Us
 * Part II, value=30` with no qualifier of its own, i.e. it looked exactly like
 * a rollup or a restatement of the 25. The model suppressed it and summed
 * 70+25+10+5.
 *
 * The qualifier that legitimises the 30 was on a DIFFERENT row (`Completed The
 * Last of Us Part II on hard difficulty`, no value) — and those two rows carry
 * the *same* `source_node_id` (`answer_8d015d9d_2::0`), because they were
 * extracted from the same sentence. The 25-hour row's source is a different
 * turn in a different session (`answer_8d015d9d_1::0`). So the table already
 * knows these are two playthroughs; the prompt just never showed it. Emitting
 * the source turn is therefore not a heuristic — it is provenance that is
 * already stored, already used as the sort tiebreaker (so same-source rows
 * render adjacent), and free.
 *
 * Note what this deliberately is NOT: no row is merged, dropped, or rewritten.
 * Similarity-based deduplication would have been the wrong mechanism here —
 * the 25-hour and 30-hour rows are near-identical in wording and BOTH real, so
 * merging them produces a confidently wrong 110 instead of a recoverable one.
 * The reasoning rules that consume `src=` live in `buildPrompt` (answerModel.ts).
 */
export function formatStructuredFacts(rows: Row[]): string {
    if (rows.length === 0) return '';

    const sorted = [...rows].sort((a, b) => {
        const ca = String(a.category ?? '');
        const cb = String(b.category ?? '');
        if (ca !== cb) return ca < cb ? -1 : 1;
        const da = String(a.event_date ?? '');
        const db = String(b.event_date ?? '');
        if (da !== db) return da < db ? -1 : 1;
        const na = String(a.source_node_id ?? '');
        const nb = String(b.source_node_id ?? '');
        return na < nb ? -1 : na > nb ? 1 : 0;
    });

    const lines = sorted.map((r) => {
        const head = `[${r.category ?? 'event'}] ${r.description ?? ''}`.trim();
        const parts = [head];
        if (r.numeric_value != null) parts.push(`value=${r.numeric_value}`);
        if (r.event_date) parts.push(`date=${r.event_date}`);
        if (r.source_node_id) parts.push(`src=${shortSource(String(r.source_node_id))}`);
        return `- ${parts.join(', ')}`;
    });

    return (
        `The following ${lines.length} countable event(s) were extracted from the full conversation history (one per line). ` +
        `src=<session>::<turn> is the exact turn each event was extracted from, so two lines sharing a src came from the same sentence ` +
        `and two lines with different srcs were stated separately:\n${lines.join('\n')}`
    );
}
