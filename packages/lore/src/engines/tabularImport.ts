/**
 * tabularImport.ts — write already-structured uploads into a real,
 * queryable Collections table (Bucket A).
 *
 * The file-upload path (`POST /api/import`, `routes/import.ts`) already
 * parses CSV / XLSX / JSON / JSONL into `{ headers, rows }`, but then
 * discards the tabular shape: it maps each row onto a single LoreNode and
 * never persists the source's actual columns. That leaves only a per-row
 * node, so a correct COUNT or SUM over the source data is impossible —
 * the same root gap the counting-question fix closed at the
 * conversation-extraction layer, here fixed at the import layer.
 *
 * The source data already HAS a shape (the file's own columns), so no LLM
 * call is involved: this is a pure structural mapping (header row → table
 * columns, spreadsheet rows → table rows).
 *
 * Safety: table creation / evolution goes through `ITableStorage` —
 * `createTable` (idempotent; same shape → no-op, changed shape → error)
 * and `evolveSchema` (additive-only: add column / add index; refuses
 * drop-column and type-change, pointing at the Phase 4
 * expand→migrate→contract orchestrator). See
 * docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md. This module NEVER emits
 * raw DDL and NEVER changes or drops an existing column.
 *
 * Re-import reconcile policy (additive, never destructive):
 *   - existing columns keep their FIRST-import type;
 *   - new columns are appended (evolveSchema ADD COLUMN);
 *   - columns present in an earlier file but absent from the new one are
 *     KEPT (their values simply stay null in the new rows) — dropping is
 *     a contract-phase operation this layer deliberately does not do.
 *
 * Pure functions (inferColumnType, sanitizeIdentifier, inferTableSchema,
 * coerceValue, buildTableRow, unionSchema) are exported for zero-API-cost
 * unit tests; writeTabularRows is the single I/O entry point against an
 * `ITableStorage`.
 */

import type {
    ColumnDecl,
    ColumnType,
    EvolutionStep,
    ITableStorage,
    Row,
    TableSchema,
} from '../contracts/tables.js';

/* ------------------------------------------------------------------ */
/*  Type predicates (shared by inference AND coercion — they cannot     */
/*  diverge, or a value inferred as one type would coerce to another)  */
/* ------------------------------------------------------------------ */

const INTEGER_RE = /^-?\d+$/;
const FLOAT_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN_RE = /^(true|false)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Strict real-date check so `2024-13-45` doesn't pass DATE_RE alone. */
function isRealIsoDate(v: string): boolean {
    if (!DATE_RE.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
    return dt.getUTCFullYear() === y
        && dt.getUTCMonth() === (m as number) - 1
        && dt.getUTCDate() === d;
}

/* ------------------------------------------------------------------ */
/*  Column-name / table-name sanitation                                */
/* ------------------------------------------------------------------ */

/**
 * Turn an arbitrary spreadsheet header (or entity type) into a valid SQL
 * identifier matching the query builder's allowlist
 * (`^[a-zA-Z_][a-zA-Z0-9_]*$`, see `whereClause.assertIdent`). Runs of
 * non-alphanumeric characters collapse to a single underscore; a leading
 * digit is prefixed with `_`; an empty result uses `fallback`. Case is
 * preserved so the column stays recognisable against its source header.
 */
export function sanitizeIdentifier(raw: string, fallback: string): string {
    let s = String(raw ?? '').trim()
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (s.length === 0) s = fallback;
    if (!/^[A-Za-z_]/.test(s)) s = `_${s}`;
    return s;
}

/**
 * Derive the stable Collections table name for an import, keyed on the
 * caller-supplied entity type so a re-upload of the same dataset lands in
 * the same table. Lowercased to match the `<owner>_<table>` convention
 * (e.g. `entityType: "Invoice Line"` → `import_invoice_line`).
 */
export function deriveTableName(entityType: string): string {
    const base = sanitizeIdentifier(entityType, 'dataset').toLowerCase();
    return `import_${base}`;
}

/* ------------------------------------------------------------------ */
/*  Type inference + schema construction                               */
/* ------------------------------------------------------------------ */

/**
 * Infer the narrowest ColumnType every non-empty value satisfies, or
 * `'string'` when the column is empty or has no common numeric/date
 * shape. Empty / whitespace-only cells are treated as absent (null), not
 * as a type signal — an `N/A` in an otherwise-numeric column correctly
 * widens the whole column to string on first import.
 */
export function inferColumnType(values: readonly string[]): ColumnType {
    let hasAny = false;
    let allInteger = true;
    let allFloat = true;
    let allBoolean = true;
    let allDate = true;
    let allDatetime = true;

    for (const raw of values) {
        const v = (raw ?? '').trim();
        if (v === '') continue;
        hasAny = true;
        if (!INTEGER_RE.test(v)) allInteger = false;
        if (!FLOAT_RE.test(v)) allFloat = false;
        if (!BOOLEAN_RE.test(v)) allBoolean = false;
        if (!isRealIsoDate(v)) allDate = false;
        if (!DATETIME_RE.test(v)) allDatetime = false;
    }

    if (!hasAny) return 'string';
    if (allInteger) return 'integer';
    if (allFloat) return 'float';
    if (allBoolean) return 'boolean';
    if (allDate) return 'date';
    if (allDatetime) return 'datetime';
    return 'string';
}

/** One source column mapped to a sanitised name + inferred type. */
export interface InferredColumn {
    /** Original header in the parsed file — used to pull values from rows. */
    sourceHeader: string;
    /** Sanitised, unique column name (a valid SQL identifier). */
    name: string;
    type: ColumnType;
}

/**
 * Traceability columns present on every import table. `_row_id` is the
 * synthetic primary key (the source has no guaranteed-unique key); the
 * other three link each row back to its source file / import batch / row
 * ordinal, mirroring how the counting-question design links structured
 * rows back to their source turn.
 */
const TRACE_COLUMNS: ColumnDecl[] = [
    { name: '_row_id', type: 'string', primary: true, required: true },
    { name: '_import_id', type: 'string', required: true, indexed: true },
    { name: '_source_file', type: 'string' },
    { name: '_source_row', type: 'integer' },
];

export interface InferredTable {
    tableName: string;
    schema: TableSchema;
    columns: InferredColumn[];
}

/**
 * Derive a TableSchema shaped like the source's own columns: one column
 * per header (sanitised, de-duplicated, typed by inference) plus the
 * traceability columns. Pure — no I/O, no storage access.
 */
export function inferTableSchema(opts: {
    entityType: string;
    headers: string[];
    rows: Array<Record<string, string>>;
}): InferredTable {
    const tableName = deriveTableName(opts.entityType);
    const seen = new Set<string>(TRACE_COLUMNS.map((c) => c.name));
    const columns: InferredColumn[] = [];

    for (let i = 0; i < opts.headers.length; i++) {
        const sourceHeader = opts.headers[i]!;
        let name = sanitizeIdentifier(sourceHeader, `column_${i + 1}`);
        let candidate = name;
        let n = 2;
        while (seen.has(candidate)) candidate = `${name}_${n++}`;
        name = candidate;
        seen.add(name);

        const values = opts.rows.map((r) => r[sourceHeader] ?? '').filter((v) => v.trim() !== '');
        columns.push({ sourceHeader, name, type: inferColumnType(values) });
    }

    const schema: TableSchema = {
        name: tableName,
        description: `Rows imported from a tabular file into entity type '${opts.entityType}'.`,
        columns: [
            ...TRACE_COLUMNS,
            ...columns.map((c): ColumnDecl => ({ name: c.name, type: c.type })),
        ],
    };

    return { tableName, schema, columns };
}

/* ------------------------------------------------------------------ */
/*  Row mapping                                                        */
/* ------------------------------------------------------------------ */

/**
 * Coerce a raw cell string to its declared column type. TOTAL — never
 * throws: empty → null; a value that doesn't parse for its declared type
 * (only reachable on re-import, where the column keeps its first-import
 * type but a new value widened) is returned verbatim so the data is
 * preserved rather than silently dropped or corrupted.
 */
export function coerceValue(raw: string, type: ColumnType): unknown {
    const v = String(raw ?? '').trim();
    if (v === '') return null;
    switch (type) {
        case 'integer': return INTEGER_RE.test(v) ? Number.parseInt(v, 10) : v;
        case 'float':   return FLOAT_RE.test(v) ? Number.parseFloat(v) : v;
        case 'boolean': return BOOLEAN_RE.test(v) ? v.toLowerCase() === 'true' : v;
        // string / date / datetime / json are stored verbatim (date and
        // datetime are ISO strings per the ColumnType contract).
        default:        return v;
    }
}

export interface RowMeta {
    importId: string;
    sourceFile: string;
    sourceRow: number;
    /**
     * 1.9 (2026-08-17 audit) — stable, cross-import row identity. When set,
     * `_row_id` takes this value verbatim (e.g. the graph-side id
     * `${entityType}:${idValue}`), so re-importing the same file collides
     * on the PK and can be deduplicated. When absent, the legacy
     * `${importId}:${sourceRow}` shape is used (a fresh importId per call
     * guaranteed zero collisions — re-imports silently doubled every row).
     */
    rowKey?: string;
}

/**
 * Build one table Row from a parsed source row: sanitised column names,
 * typed values, and the traceability metadata. Pure.
 */
export function buildTableRow(
    sourceRow: Record<string, string>,
    columns: InferredColumn[],
    meta: RowMeta,
): Row {
    const row: Row = {
        _row_id: meta.rowKey ?? `${meta.importId}:${meta.sourceRow}`,
        _import_id: meta.importId,
        _source_file: meta.sourceFile,
        _source_row: meta.sourceRow,
    };
    for (const c of columns) {
        row[c.name] = coerceValue(sourceRow[c.sourceHeader] ?? '', c.type);
    }
    return row;
}

/* ------------------------------------------------------------------ */
/*  Reconcile + write                                                  */
/* ------------------------------------------------------------------ */

/**
 * Merge an existing schema with a newly-inferred one for re-import.
 * Existing columns keep their name/type/flags (never changed); columns
 * present only in the new file are appended as nullable, non-primary,
 * non-unique columns (always acceptable to `evolveSchema`). Columns only
 * in the existing schema are KEPT. Pure.
 */
export function unionSchema(existing: TableSchema, next: TableSchema): TableSchema {
    const seen = new Set(existing.columns.map((c) => c.name));
    const columns: ColumnDecl[] = [...existing.columns];
    for (const c of next.columns) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        columns.push({ name: c.name, type: c.type });
    }
    return {
        name: existing.name,
        description: next.description ?? existing.description,
        columns,
    };
}

/** Read the current cached schema for a table via the same side-channel
 *  `handleSchemaGet` uses; null when the adapter isn't introspectable. */
function readExistingSchema(storage: ITableStorage, name: string): TableSchema | null {
    const introspectable = storage as ITableStorage & { schemas?: Map<string, TableSchema> };
    return introspectable.schemas?.get(name) ?? null;
}

export interface TabularWriteResult {
    rowsWritten: number;
    disposition: 'created' | 'reused' | 'evolved';
    /** Column names added by an additive evolveSchema on re-import. */
    addedColumns: string[];
    /** 1.9 — rows skipped because their stable `_row_id` was already
     *  present from a prior import (or duplicated within this batch).
     *  Only countable when the caller supplied `rowKeys`. */
    rowsDeduplicated: number;
}

/**
 * Create-or-reconcile the table and write the source rows in one batch
 * (single transaction). This is the ONLY I/O in this module and the only
 * place that touches the schema-safety surface — createTable for first
 * import, evolveSchema (additive-only) for re-import reconciliation.
 */
export async function writeTabularRows(opts: {
    storage: ITableStorage;
    tableName: string;
    schema: TableSchema;
    columns: InferredColumn[];
    rows: Array<Record<string, string>>;
    importId: string;
    sourceFile: string;
    /** 1.9 — stable per-row identity (parallel to `rows`). When present,
     *  re-imports dedupe on it instead of doubling every row. */
    rowKeys?: string[];
}): Promise<TabularWriteResult> {
    const { storage, tableName, schema, columns, rows, importId, sourceFile, rowKeys } = opts;

    let disposition: 'created' | 'reused' | 'evolved' = 'created';
    let addedColumns: string[] = [];

    const existingBefore = readExistingSchema(storage, tableName);
    try {
        // Idempotent: same shape → no-op; first time → CREATE TABLE.
        await storage.createTable(schema);
        disposition = existingBefore ? 'reused' : 'created';
    } catch (err) {
        // Re-import with a changed shape → additive reconcile. The failed
        // createTable already loaded the schema cache, so read the real
        // current schema (not just the pre-call side-channel peek).
        if (!/different shape/i.test((err as Error).message ?? '')) throw err;
        const existing = readExistingSchema(storage, tableName) ?? existingBefore;
        if (!existing) throw err;
        if (!storage.evolveSchema) {
            throw new Error(
                `tabularImport: table '${tableName}' already exists with a different shape, ` +
                'but the storage adapter has no evolveSchema (additiveSchemaEvolution). ' +
                'Reconcile the schema manually.',
            );
        }
        const steps = await storage.evolveSchema(tableName, unionSchema(existing, schema));
        addedColumns = steps
            .filter((s: EvolutionStep) => s.kind === 'add_column')
            .map((s: EvolutionStep) => s.column);
        disposition = 'evolved';
    }

    if (rows.length === 0) {
        return { rowsWritten: 0, disposition, addedColumns, rowsDeduplicated: 0 };
    }

    // 1.9 — stable-key upsert semantics mirroring the graph side: (a)
    // within this batch keep the LAST occurrence (upsert last-write-wins);
    // (b) against the existing table, UPDATE rows whose key is already
    // present and INSERT the rest — re-importing the same file refreshes
    // instead of doubling. Previously the fresh-randomUUID importId made
    // `_row_id` collision impossible, so every re-import duplicated.
    let deduped = 0;
    let keepIdx: number[] = rows.map((_, i) => i);
    let existingKeys = new Set<string>();
    const hasKeys = !!rowKeys && rowKeys.length === rows.length;
    if (hasKeys) {
        const lastByKey = new Map<string, number>();
        for (let i = 0; i < rowKeys!.length; i++) lastByKey.set(rowKeys![i]!, i);
        const batchKeep: number[] = [];
        for (let i = 0; i < rows.length; i++) {
            if (lastByKey.get(rowKeys![i]!) === i) batchKeep.push(i);
            else deduped++;
        }
        // Existing-table collision probe, chunked to keep the IN predicate bounded.
        const EXISTING_CHUNK = 500;
        for (let i = 0; i < batchKeep.length; i += EXISTING_CHUNK) {
            const slice = batchKeep.slice(i, i + EXISTING_CHUNK).map((j) => rowKeys![j]!);
            const found = await storage.query(tableName, { in: { _row_id: slice } });
            for (const r of found) existingKeys.add(String(r['_row_id']));
        }
        keepIdx = batchKeep;
    }

    const toInsert: number[] = [];
    const toUpdate: number[] = [];
    for (const j of keepIdx) {
        if (hasKeys && existingKeys.has(rowKeys![j]!)) { deduped++; toUpdate.push(j); }
        else toInsert.push(j);
    }

    const buildRow = (j: number): Row =>
        buildTableRow(rows[j]!, columns, {
            importId,
            sourceFile,
            sourceRow: j + 2,
            rowKey: hasKeys ? rowKeys![j] : undefined,
        });

    // Updates first (per-row; imports are upload-size-capped), then one
    // batched insert transaction.
    for (const j of toUpdate) {
        const row = buildRow(j);
        const key = String(row['_row_id']);
        const { _row_id: _drop, ...patch } = row;
        await storage.update(tableName, { eq: { _row_id: key } }, patch);
    }
    const tableRows: Row[] = toInsert.map(buildRow);
    await storage.insertBatch(tableName, tableRows);

    return { rowsWritten: tableRows.length + toUpdate.length, disposition, addedColumns, rowsDeduplicated: deduped };
}
