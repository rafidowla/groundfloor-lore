/**
 * postgresTableReview.ts - the review queue for structured-table values (design 5.1 step 5, 4.3).
 *
 * A value NEEDS REVIEW when it is the current value of its (row, column), nobody has reviewed it, and either the
 * extractor flagged it (`needs_review`) or its `confidence` is below the workspace threshold
 * (`reviewConfidenceThreshold`, default 0.8: the design does not state one). A review never edits a value in place and
 * never deletes one: `confirm` and `correct` write a NEW value row (reviewed_by/reviewed_at set, `needs_review` false,
 * `supersedes_value_id` pointing at the extractor row) and close the old row with `superseded_at`, so the extractor's
 * answer stays readable in history.
 *
 * Concurrency: the value_id the reviewer saw is the compare-and-swap token. The row header and then the value row are
 * locked (the same order `update()` uses). A second reviewer arriving after the first finds the row already superseded
 * and gets a `conflict` error naming the winner; the same reviewer repeating the same action gets the first result back
 * (`idempotent: true`) instead of a second write.
 */

import type { Pool, PoolClient } from 'pg';
import type { ColumnType } from '../../contracts/tables.js';
import { withTransaction } from './postgresClient.js';
import { CURRENCY_COLUMN, PG_TYPE, TABLE_TABLES, VALUE_COLUMN } from './postgresTableSchema.js';
import { loadCatalog, type FieldMeta, type TableMeta } from './postgresTableCatalog.js';
import { decodePgValue, encodePgValue, splitMoney, type Encoded } from './postgresTableCodec.js';
import { PROVENANCE_COLUMNS, storedProvenanceOf, type StoredProvenance } from './postgresTableProvenance.js';
import { TableReviewError } from './postgresTableErrors.js';

const { value: VALUE, entity: ENTITY, settings: SETTINGS } = TABLE_TABLES;
type Db = Pick<Pool | PoolClient, 'query'>;

export const DEFAULT_REVIEW_THRESHOLD = 0.8;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const MAX_REVIEWER_CHARS = 256;
const CURSOR_PREFIX = 'v1:';

export interface ReviewCtx { pool: Pool; workspace: string }

const bad = (message: string): TableReviewError => new TableReviewError('invalid_argument', message);

/** SQL for "this value row needs review"; `thr` is a placeholder for the threshold (a float8). */
export const needsReviewSql = (a: string, thr: string): string =>
    `${a}.superseded_at IS NULL AND ${a}.reviewed_at IS NULL AND (${a}.needs_review IS TRUE OR ${a}.confidence < ${thr})`;

// ---- settings ----------------------------------------------------------------------------------------------------

export interface ReviewSettings {
    /** Values with a confidence below this need review even when `needs_review` is false. */
    reviewConfidenceThreshold: number;
    /** True when the workspace never set one and the built-in default applies. */
    isDefault: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
}

/** The workspace's threshold (the default when none is stored). Safe inside a READ ONLY transaction. */
export async function loadReviewThreshold(db: Db, workspace: string): Promise<number> {
    const r = await db.query(`SELECT review_confidence_threshold AS t FROM ${SETTINGS} WHERE workspace_id = $1`, [workspace]);
    return r.rows.length > 0 ? Number((r.rows[0] as { t: number }).t) : DEFAULT_REVIEW_THRESHOLD;
}

export async function getReviewSettings(ctx: ReviewCtx): Promise<ReviewSettings> {
    const r = await ctx.pool.query(
        `SELECT review_confidence_threshold AS t, updated_at, updated_by FROM ${SETTINGS} WHERE workspace_id = $1`, [ctx.workspace]);
    if (r.rows.length === 0) return { reviewConfidenceThreshold: DEFAULT_REVIEW_THRESHOLD, isDefault: true, updatedAt: null, updatedBy: null };
    const row = r.rows[0] as { t: number; updated_at: Date; updated_by: string | null };
    return { reviewConfidenceThreshold: Number(row.t), isDefault: false, updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by };
}

export async function setReviewConfidenceThreshold(ctx: ReviewCtx, threshold: number, updatedBy?: string): Promise<ReviewSettings> {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw bad('reviewConfidenceThreshold must be a number between 0 and 1');
    }
    await ctx.pool.query(
        `INSERT INTO ${SETTINGS} (workspace_id, review_confidence_threshold, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id) DO UPDATE SET review_confidence_threshold = EXCLUDED.review_confidence_threshold,
             updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [ctx.workspace, threshold, updatedBy ?? null]);
    return getReviewSettings(ctx);
}

// ---- queue -------------------------------------------------------------------------------------------------------

export interface ReviewQueueQuery {
    table?: string;
    /** A column name; with `table` it must exist on it, without `table` it matches that column on every table. */
    field?: string;
    sourceDocumentId?: string;
    /** Only values whose confidence is strictly below this (0..1). */
    maxConfidence?: number;
    /** Page size, default 100, max 1000. */
    limit?: number;
    /** `nextCursor` from the previous page. */
    cursor?: string;
}

export interface ReviewQueueItem {
    /** The token to pass to confirm/correct. */
    valueId: string;
    entityId: string;
    table: string;
    field: string;
    /** The row's primary key. */
    rowKey: unknown;
    value: unknown;
    reason: 'flagged' | 'low_confidence' | 'flagged_and_low_confidence';
    provenance: StoredProvenance;
    recordedAt: string;
}

export interface ReviewQueuePage { items: ReviewQueueItem[]; nextCursor: string | null; threshold: number }

interface FieldRef { table: string; name: string; meta: TableMeta; field: FieldMeta }

const fieldRefs = (catalog: Map<string, TableMeta>): Map<number, FieldRef> => {
    const out = new Map<number, FieldRef>();
    for (const [table, meta] of catalog) {
        for (const [name, field] of meta.fields) if (!field.header) out.set(field.fieldId, { table, name, meta, field });
    }
    return out;
};

/** The typed value columns of a value row, ready for `decodeValue`. */
const VALUE_SELECT = `v.v_text, v.v_int::text AS v_int, v.v_num, v.v_bool,
    to_char(v.v_date, 'YYYY-MM-DD') AS v_date, to_char(v.v_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS v_ts,
    v.v_json, v.v_amount::text AS v_amount, v.v_currency`;

function decodeValue(row: Record<string, unknown>, type: ColumnType): unknown {
    switch (type) {
        case 'string': return row['v_text'] ?? null;
        case 'integer': return decodePgValue(row['v_int'], 'integer');
        case 'float': return row['v_num'] ?? null;
        case 'boolean': return row['v_bool'] ?? null;
        case 'date': return row['v_date'] ?? null;
        case 'datetime': return row['v_ts'] ?? null;
        case 'json': return row['v_json'] ?? null;
        case 'money': return row['v_amount'] == null ? null : decodePgValue({ amount: row['v_amount'], currency: row['v_currency'] }, 'money');
    }
}

function parseCursor(c: string | undefined): string | null {
    if (c === undefined) return null;
    if (!c.startsWith(CURSOR_PREFIX) || !/^\d{1,18}$/.test(c.slice(CURSOR_PREFIX.length))) throw bad('cursor is not a cursor returned by this queue');
    return c.slice(CURSOR_PREFIX.length);
}

function queueQuery(q: ReviewQueueQuery, workspace: string, threshold: number, catalog: Map<string, TableMeta>, withCursor: boolean): { where: string; params: unknown[]; refs: Map<number, FieldRef> } | null {
    if (q.table !== undefined && !catalog.has(q.table)) throw bad(`unknown table '${q.table}'`);
    const all = fieldRefs(catalog);
    const refs = new Map([...all].filter(([, r]) => (q.table === undefined || r.table === q.table) && (q.field === undefined || r.name === q.field)));
    if (q.field !== undefined && q.table !== undefined && refs.size === 0) throw bad(`unknown column '${q.field}' on table '${q.table}'`);
    if (refs.size === 0) return null;
    const params: unknown[] = [workspace, threshold];
    const conds = ['v.workspace_id = $1', needsReviewSql('v', '$2::float8')];
    const add = (v: unknown, cast: string): string => { params.push(v); return `$${params.length}::${cast}`; };
    if (q.table !== undefined || q.field !== undefined) conds.push(`v.field_id = ANY(${add([...refs.keys()], 'bigint[]')})`);
    if (q.sourceDocumentId !== undefined) {
        if (typeof q.sourceDocumentId !== 'string' || q.sourceDocumentId === '') throw bad('sourceDocumentId must be a non-empty string');
        conds.push(`v.source_document_id = ${add(q.sourceDocumentId, 'text')}`);
    }
    if (q.maxConfidence !== undefined) {
        if (typeof q.maxConfidence !== 'number' || !(q.maxConfidence >= 0 && q.maxConfidence <= 1)) throw bad('maxConfidence must be a number between 0 and 1');
        conds.push(`v.confidence < ${add(q.maxConfidence, 'float8')}`);
    }
    const cursor = withCursor ? parseCursor(q.cursor) : null;
    if (cursor !== null) conds.push(`v.value_id > ${add(cursor, 'bigint')}`);
    return { where: conds.join(' AND '), params, refs };
}

export async function listReviewQueue(ctx: ReviewCtx, q: ReviewQueueQuery = {}): Promise<ReviewQueuePage> {
    const limit = q.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw bad(`limit must be an integer 1..${MAX_PAGE}`);
    const threshold = await loadReviewThreshold(ctx.pool, ctx.workspace);
    const built = queueQuery(q, ctx.workspace, threshold, await loadCatalog(ctx.pool, ctx.workspace), true);
    if (!built) return { items: [], nextCursor: null, threshold };
    built.params.push(limit + 1);
    const prov = PROVENANCE_COLUMNS.map(c => `v.${c.col}`).join(', ');
    const r = await ctx.pool.query(
        `SELECT v.value_id::text AS value_id, v.entity_id::text AS entity_id, v.field_id, v.recorded_at, e.pk_text, ${VALUE_SELECT}, ${prov}
           FROM ${VALUE} v JOIN ${ENTITY} e ON e.workspace_id = v.workspace_id AND e.entity_id = v.entity_id
          WHERE ${built.where} ORDER BY v.value_id LIMIT $${built.params.length}`, built.params);
    const rows = r.rows as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    const items = page.map((row): ReviewQueueItem => {
        const ref = built.refs.get(Number(row['field_id']))!;
        const p = storedProvenanceOf(row);
        const flagged = p.needsReview === true;
        const low = p.confidence !== null && p.confidence < threshold;
        return {
            valueId: String(row['value_id']), entityId: String(row['entity_id']), table: ref.table, field: ref.name,
            rowKey: decodePgValue(row['pk_text'], ref.meta.pk.type), value: decodeValue(row, ref.field.col.type),
            reason: flagged && low ? 'flagged_and_low_confidence' : flagged ? 'flagged' : 'low_confidence',
            provenance: p, recordedAt: (row['recorded_at'] as Date).toISOString(),
        };
    });
    return { items, nextCursor: rows.length > limit ? `${CURSOR_PREFIX}${items[items.length - 1]!.valueId}` : null, threshold };
}

/** How many values match the same filters (the cursor and limit are ignored). */
export async function countReviewQueue(ctx: ReviewCtx, q: ReviewQueueQuery = {}): Promise<number> {
    const threshold = await loadReviewThreshold(ctx.pool, ctx.workspace);
    const built = queueQuery(q, ctx.workspace, threshold, await loadCatalog(ctx.pool, ctx.workspace), false);
    if (!built) return 0;
    const r = await ctx.pool.query(`SELECT count(*)::text AS n FROM ${VALUE} v WHERE ${built.where}`, built.params);
    return Number((r.rows[0] as { n: string }).n);
}

// ---- confirm / correct -------------------------------------------------------------------------------------------

export interface ConfirmInput { valueId: string; reviewer: string }
export interface CorrectInput {
    valueId: string;
    reviewer: string;
    /** The corrected value, in the column's type. Clearing a value is `update()`, not a review. */
    value: unknown;
    /** Page of the source the reviewer checked; default: the extractor's page. */
    sourcePage?: number;
    /** The text that supports the corrected value; default: none (the extractor's quote supported the old value). */
    verifiedQuote?: string;
}

export interface ReviewOutcome {
    action: 'confirm' | 'correct';
    /** The current value row after the review (the new one, or the existing reviewed one when idempotent). */
    valueId: string;
    /** The row this review closed (the extractor row). Repeated on an idempotent repeat; null only when the id given was already the reviewed row. */
    supersededValueId: string | null;
    reviewedBy: string;
    reviewedAt: string;
    /** True when nothing was written because the same review had already been recorded. */
    idempotent: boolean;
}

interface Loaded {
    value_id: string; entity_id: string; field_id: string; superseded_at: Date | null; reviewed_by: string | null;
    reviewed_at: Date | null; supersedes_value_id: string | null;
}

const ALL_VALUE_COLS = ['v_text', 'v_int', 'v_num', 'v_bool', 'v_date', 'v_ts', 'v_json', 'v_amount', CURRENCY_COLUMN] as const;

/** SQL that is true when row alias `c` holds the value a confirm keeps (`r`'s) or a correct sets (`params`). */
function sameValueSql(mode: 'confirm' | 'correct', type: ColumnType, firstParam: number, enc: Encoded): { sql: string; params: Encoded[] } {
    if (mode === 'confirm') return { sql: ALL_VALUE_COLS.map(c => `c.${c} IS NOT DISTINCT FROM r.${c}`).join(' AND '), params: [] };
    if (type === 'money') {
        const m = splitMoney(enc);
        return { sql: `c.v_amount IS NOT DISTINCT FROM $${firstParam}::numeric AND c.v_currency IS NOT DISTINCT FROM $${firstParam + 1}::text`, params: [m.amount, m.currency] };
    }
    const col = VALUE_COLUMN[type];
    return { sql: `c.${col} IS NOT DISTINCT FROM $${firstParam}::${PG_TYPE[type]}`, params: [enc] };
}

function checkId(valueId: unknown): string {
    if (typeof valueId !== 'string' || !/^\d{1,18}$/.test(valueId)) throw bad('valueId must be the value id string returned by the review queue');
    return valueId;
}
function checkReviewer(reviewer: unknown): string {
    if (typeof reviewer !== 'string' || reviewer.trim() === '' || reviewer.length > MAX_REVIEWER_CHARS) {
        throw bad(`reviewer must be a non-empty string of at most ${MAX_REVIEWER_CHARS} characters`);
    }
    return reviewer;
}

export function confirmValue(ctx: ReviewCtx, input: ConfirmInput): Promise<ReviewOutcome> {
    return reviewValue(ctx, 'confirm', input);
}
export function correctValue(ctx: ReviewCtx, input: CorrectInput): Promise<ReviewOutcome> {
    return reviewValue(ctx, 'correct', input);
}

async function reviewValue(ctx: ReviewCtx, mode: 'confirm' | 'correct', input: ConfirmInput | CorrectInput): Promise<ReviewOutcome> {
    const reviewer = checkReviewer(input.reviewer);
    const id = checkId(input.valueId);
    const corr = mode === 'correct' ? input as CorrectInput : undefined;
    if (corr) {
        if (corr.value === undefined || corr.value === null) throw bad('a correction needs a value; clear a value with update(), not a review');
        if (corr.sourcePage !== undefined && !(Number.isInteger(corr.sourcePage) && corr.sourcePage >= 0)) throw bad('sourcePage must be a non-negative integer');
        if (corr.verifiedQuote !== undefined && typeof corr.verifiedQuote !== 'string') throw bad('verifiedQuote must be a string');
    }
    try {
        return await withTransaction(ctx.pool, (client) => reviewTx(client, ctx.workspace, mode, id, reviewer, corr));
    } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new TableReviewError('conflict', 'the corrected value violates a unique constraint on its column');
        throw err;
    }
}

async function reviewTx(client: PoolClient, workspace: string, mode: 'confirm' | 'correct', id: string, reviewer: string, corr: CorrectInput | undefined): Promise<ReviewOutcome> {
    const notFound = (): TableReviewError => new TableReviewError('not_found', `value ${id} does not exist in this workspace`);
    const found = await client.query(`SELECT entity_id, field_id FROM ${VALUE} WHERE workspace_id = $1 AND value_id = $2`, [workspace, id]);
    if (found.rows.length === 0) throw notFound();
    const { entity_id: entityId, field_id: fieldId } = found.rows[0] as { entity_id: string; field_id: string };
    // Header first, then the value row: the same order update() locks in, so the two never deadlock.
    const hdr = await client.query(`SELECT 1 FROM ${ENTITY} WHERE workspace_id = $1 AND entity_id = $2 FOR UPDATE`, [workspace, entityId]);
    if (hdr.rows.length === 0) throw notFound();
    const ref = fieldRefs(await loadCatalog(client, workspace)).get(Number(fieldId));
    if (!ref) throw notFound();
    const type = ref.field.col.type;
    let enc: Encoded = null;
    if (corr) {
        if (ref.field.col.primary) throw bad(`'${ref.table}.${ref.name}' is the primary key; a key cannot be corrected through review`);
        try { enc = encodePgValue(corr.value, type, `column '${ref.name}'`); } catch (e) { throw bad((e as Error).message); }
    }
    const cur = (await client.query(
        `SELECT value_id::text, entity_id::text, field_id::text, superseded_at, reviewed_by, reviewed_at, supersedes_value_id::text
           FROM ${VALUE} WHERE workspace_id = $1 AND value_id = $2 FOR UPDATE`, [workspace, id])).rows[0] as Loaded | undefined;
    if (!cur) throw notFound();

    if (cur.superseded_at !== null) {
        const same = sameValueSql(mode, type, 5, enc);
        const succ = (await client.query(
            `SELECT c.value_id::text, c.reviewed_by, c.reviewed_at, c.supersedes_value_id::text, (${same.sql}) AS same
               FROM ${VALUE} c JOIN ${VALUE} r ON r.workspace_id = c.workspace_id AND r.value_id = $2
              WHERE c.workspace_id = $1 AND c.entity_id = $3 AND c.field_id = $4 AND c.superseded_at IS NULL`,
            [workspace, id, entityId, fieldId, ...same.params])).rows[0] as
            { value_id: string; reviewed_by: string | null; reviewed_at: Date | null; supersedes_value_id: string | null; same: boolean } | undefined;
        if (!succ) throw new TableReviewError('conflict', `value ${id} was superseded and the field has no current value now; reload the queue`, { valueId: id });
        const detail = { valueId: id, currentValueId: succ.value_id };
        if (succ.supersedes_value_id === id && succ.reviewed_at !== null) {
            if (succ.reviewed_by === reviewer && succ.same) {
                return { action: mode, valueId: succ.value_id, supersededValueId: id, reviewedBy: reviewer, reviewedAt: succ.reviewed_at.toISOString(), idempotent: true };
            }
            const who = succ.reviewed_by === reviewer ? 'by you, with a different outcome' : `by ${succ.reviewed_by ?? 'another reviewer'}`;
            throw new TableReviewError('conflict', `value ${id} was already reviewed ${who} at ${succ.reviewed_at.toISOString()}; the current value is ${succ.value_id}`, detail);
        }
        throw new TableReviewError('conflict', `value ${id} was superseded by a newer write (current value ${succ.value_id}); reload the queue`, detail);
    }
    if (mode === 'confirm' && cur.reviewed_at !== null) {
        return { action: mode, valueId: id, supersededValueId: cur.supersedes_value_id, reviewedBy: cur.reviewed_by ?? reviewer, reviewedAt: cur.reviewed_at.toISOString(), idempotent: true };
    }

    await client.query(`UPDATE ${VALUE} SET superseded_at = now() WHERE workspace_id = $1 AND value_id = $2 AND superseded_at IS NULL`, [workspace, id]);
    const ins = mode === 'confirm' ? await insertConfirmed(client, workspace, id, reviewer) : await insertCorrected(client, workspace, id, reviewer, type, enc, corr!);
    return { action: mode, valueId: ins.valueId, supersededValueId: id, reviewedBy: reviewer, reviewedAt: ins.reviewedAt, idempotent: false };
}

const PROV_KEEP = ['source_document_id', 'source_page', 'verified_quote', 'confidence', 'extractor', 'contract', 'extracted_at'] as const;

/** New current row = the extractor's value and provenance, reviewed. The original confidence is kept for audit. */
async function insertConfirmed(client: PoolClient, workspace: string, id: string, reviewer: string): Promise<{ valueId: string; reviewedAt: string }> {
    const r = await client.query(
        `INSERT INTO ${VALUE} (workspace_id, entity_id, field_id, ${ALL_VALUE_COLS.join(', ')}, ${PROV_KEEP.join(', ')}, needs_review, reviewed_by, reviewed_at, supersedes_value_id)
         SELECT r.workspace_id, r.entity_id, r.field_id, ${ALL_VALUE_COLS.map(c => `r.${c}`).join(', ')}, ${PROV_KEEP.map(c => `r.${c}`).join(', ')}, false, $3, now(), r.value_id
           FROM ${VALUE} r WHERE r.workspace_id = $1 AND r.value_id = $2
         RETURNING value_id::text, reviewed_at`, [workspace, id, reviewer]);
    const row = r.rows[0] as { value_id: string; reviewed_at: Date };
    return { valueId: row.value_id, reviewedAt: row.reviewed_at.toISOString() };
}

/** New current row = the reviewer's value. The extractor's confidence, quote and extractor id described the OLD value, so they are not carried over. */
async function insertCorrected(client: PoolClient, workspace: string, id: string, reviewer: string, type: ColumnType, enc: Encoded, corr: CorrectInput): Promise<{ valueId: string; reviewedAt: string }> {
    const money = type === 'money';
    const m = money ? splitMoney(enc) : null;
    const cols: string[] = money ? ['v_amount', CURRENCY_COLUMN] : [VALUE_COLUMN[type]];
    const vals: Encoded[] = money ? [m!.amount, m!.currency] : [enc];
    const casts = money ? ['numeric', 'text'] : [PG_TYPE[type]];
    const ph = vals.map((_, i) => `$${i + 6}::${casts[i]}`);
    const r = await client.query(
        `INSERT INTO ${VALUE} (workspace_id, entity_id, field_id, ${cols.join(', ')}, source_document_id, source_page, verified_quote, contract, needs_review, reviewed_by, reviewed_at, supersedes_value_id)
         SELECT r.workspace_id, r.entity_id, r.field_id, ${ph.join(', ')}, r.source_document_id, COALESCE($4::integer, r.source_page), $5::text, r.contract, false, $3, now(), r.value_id
           FROM ${VALUE} r WHERE r.workspace_id = $1 AND r.value_id = $2
         RETURNING value_id::text, reviewed_at`, [workspace, id, reviewer, corr.sourcePage ?? null, corr.verifiedQuote ?? null, ...vals]);
    const row = r.rows[0] as { value_id: string; reviewed_at: Date };
    return { valueId: row.value_id, reviewedAt: row.reviewed_at.toISOString() };
}
