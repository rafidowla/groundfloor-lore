/**
 * postgresTableProvenance.ts - per-value provenance for structured tables (design 4.3).
 *
 * Every `lore_entity_value` row may carry where the value came from (document, page, the verbatim quote that
 * supports it), how sure the extractor was, whether a person must look at it, and who reviewed it. All of it is
 * optional: a plain `insert`/`update` writes none and the result shapes of `query`/`getByKey` do not change unless
 * the caller opts in with `{ provenance: true }`.
 */

import type { PoolClient, Pool } from 'pg';
import { TABLE_TABLES } from './postgresTableSchema.js';
import type { TableMeta } from './postgresTableCatalog.js';
import type { Encoded } from './postgresTableCodec.js';

const L = 'PostgresTableStorage';

/** Provenance a writer may attach to one value. Every field is optional. */
export interface ValueProvenance {
    sourceDocumentId?: string;
    sourcePage?: number;
    /** The verbatim text the extractor claims supports the value. */
    verifiedQuote?: string;
    /** 0..1. */
    confidence?: number;
    needsReview?: boolean;
    /** Engine id + version + model fingerprint. */
    extractor?: string;
    /** Extraction contract, e.g. `B/1`. */
    contract?: string;
    extractedAt?: Date | string;
    reviewedBy?: string;
    reviewedAt?: Date | string;
}

/** Provenance as read back (dates are ISO strings; unset fields are null). */
export interface StoredProvenance {
    sourceDocumentId: string | null;
    sourcePage: number | null;
    verifiedQuote: string | null;
    confidence: number | null;
    needsReview: boolean | null;
    extractor: string | null;
    contract: string | null;
    extractedAt: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
}

/** Provenance columns in a fixed order, with the SQL cast used when binding an unnest array. */
export const PROVENANCE_COLUMNS = [
    { col: 'source_document_id', cast: 'text' }, { col: 'source_page', cast: 'integer' },
    { col: 'verified_quote', cast: 'text' }, { col: 'confidence', cast: 'float8' },
    { col: 'needs_review', cast: 'boolean' }, { col: 'extractor', cast: 'text' },
    { col: 'contract', cast: 'text' }, { col: 'extracted_at', cast: 'timestamptz' },
    { col: 'reviewed_by', cast: 'text' }, { col: 'reviewed_at', cast: 'timestamptz' },
] as const;

/** A validated provenance record as bind values in PROVENANCE_COLUMNS order. */
export type ProvenanceBinds = Encoded[];

function iso(v: Date | string | undefined, ctx: string): string | null {
    if (v === undefined || v === null) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`${L}: provenance ${ctx} is not a valid date/time: ${JSON.stringify(v)}`);
    return d.toISOString();
}

function str(v: unknown, ctx: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new Error(`${L}: provenance ${ctx} must be a string`);
    return v;
}

/** Validate `p` for column `column` and return its bind values. */
export function provenanceBinds(p: ValueProvenance, column: string): ProvenanceBinds {
    const ctx = `for column '${column}'`;
    const known = new Set(['sourceDocumentId', 'sourcePage', 'verifiedQuote', 'confidence', 'needsReview', 'extractor', 'contract', 'extractedAt', 'reviewedBy', 'reviewedAt']);
    for (const k of Object.keys(p)) if (!known.has(k)) throw new Error(`${L}: unknown provenance field '${k}' ${ctx}`);
    if (p.confidence !== undefined && p.confidence !== null && !(typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1)) {
        throw new Error(`${L}: provenance confidence ${ctx} must be a number between 0 and 1`);
    }
    if (p.sourcePage !== undefined && p.sourcePage !== null && !(Number.isInteger(p.sourcePage) && p.sourcePage >= 0)) {
        throw new Error(`${L}: provenance sourcePage ${ctx} must be a non-negative integer`);
    }
    if (p.needsReview !== undefined && p.needsReview !== null && typeof p.needsReview !== 'boolean') {
        throw new Error(`${L}: provenance needsReview ${ctx} must be a boolean`);
    }
    return [
        str(p.sourceDocumentId, `sourceDocumentId ${ctx}`), p.sourcePage ?? null, str(p.verifiedQuote, `verifiedQuote ${ctx}`),
        p.confidence ?? null, p.needsReview ?? null, str(p.extractor, `extractor ${ctx}`), str(p.contract, `contract ${ctx}`),
        iso(p.extractedAt, `extractedAt ${ctx}`), str(p.reviewedBy, `reviewedBy ${ctx}`), iso(p.reviewedAt, `reviewedAt ${ctx}`),
    ];
}

/** Check that every provenance key names a column that is being written with a non-null, non-header value. */
export function assertProvenanceTargets(meta: TableMeta, table: string, written: Set<string>, prov: Record<string, ValueProvenance> | undefined, op: string): void {
    for (const k of Object.keys(prov ?? {})) {
        const f = meta.fields.get(k);
        if (!f) throw new Error(`${L}.${op}: provenance names unknown column '${k}' on table '${table}'`);
        if (f.header) throw new Error(`${L}.${op}: provenance cannot attach to reserved column '${k}' (it lives on the row header)`);
        if (!written.has(k)) throw new Error(`${L}.${op}: provenance for column '${k}' but no value is being written to it`);
    }
}

export type ProvenanceByColumn = Record<string, StoredProvenance>;

/** Map the provenance columns of one `lore_entity_value` row (as the driver returns them) to a StoredProvenance. */
export function storedProvenanceOf(row: Record<string, unknown>): StoredProvenance {
    const sp = row['source_page'];
    return {
        sourceDocumentId: (row['source_document_id'] as string | null) ?? null,
        sourcePage: sp == null ? null : Number(sp),
        verifiedQuote: (row['verified_quote'] as string | null) ?? null,
        confidence: row['confidence'] == null ? null : Number(row['confidence']),
        needsReview: (row['needs_review'] as boolean | null) ?? null,
        extractor: (row['extractor'] as string | null) ?? null,
        contract: (row['contract'] as string | null) ?? null,
        extractedAt: row['extracted_at'] == null ? null : (row['extracted_at'] as Date).toISOString(),
        reviewedBy: (row['reviewed_by'] as string | null) ?? null,
        reviewedAt: row['reviewed_at'] == null ? null : (row['reviewed_at'] as Date).toISOString(),
    };
}

/**
 * Read provenance for the given entities. `recordedAt` (a bound ISO instant) selects the values known then;
 * omit for the current values. Returns entity id -> column -> provenance (only columns that carry any).
 */
export async function loadProvenance(
    db: Pick<Pool | PoolClient, 'query'>, workspace: string, meta: TableMeta, entityIds: string[], recordedAt?: string,
): Promise<Map<string, ProvenanceByColumn>> {
    const out = new Map<string, ProvenanceByColumn>();
    if (entityIds.length === 0) return out;
    const nameById = new Map([...meta.fields].map(([n, f]) => [f.fieldId, n] as const));
    const cols = PROVENANCE_COLUMNS.map(c => `v.${c.col}`).join(', ');
    const live = recordedAt === undefined
        ? 'v.superseded_at IS NULL'
        : 'v.recorded_at <= $3::timestamptz AND (v.superseded_at IS NULL OR v.superseded_at > $3::timestamptz)';
    const r = await db.query(
        `SELECT v.entity_id, v.field_id, ${cols} FROM ${TABLE_TABLES.value} v
          WHERE v.workspace_id = $1 AND v.entity_id = ANY($2::bigint[]) AND ${live}`,
        recordedAt === undefined ? [workspace, entityIds] : [workspace, entityIds, recordedAt]);
    for (const row of r.rows as Array<Record<string, unknown>>) {
        const name = nameById.get(Number(row['field_id']));
        if (!name) continue;
        const stored = storedProvenanceOf(row);
        if (Object.values(stored).every(x => x === null)) continue;
        const key = String(row['entity_id']);
        let m = out.get(key);
        if (!m) { m = {}; out.set(key, m); }
        m[name] = stored;
    }
    return out;
}
