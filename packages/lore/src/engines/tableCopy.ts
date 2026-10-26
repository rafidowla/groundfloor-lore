/**
 * tableCopy.ts - copy every table of one ITableStorage into another (the engine behind `lore tables copy`).
 *
 * Built for one job: a workspace whose graph engine was switched to `postgres` leaves its `tables.sqlite`
 * behind and starts with no tables in Postgres. Everything goes through the ITableStorage surface on BOTH sides,
 * so it keeps working while either backend's physical layout changes.
 *
 * Stateless resume. There is no progress marker. Before any write the plan compares the target with the source
 * row by row (by primary key, on normalised values):
 *   - target row absent                     -> missing  (will be copied)
 *   - target row equal to the source row    -> identical (left alone)
 *   - target row differs / not in source    -> conflict (refused unless `replace`)
 * so a crashed copy (target = a clean subset of the source) simply plans as "resume", and a finished one as "done".
 * Writes are upserts in transactions of at most MAX_TABLE_TX_OPS ops, so re-running converges to the same result.
 *
 * `replace` is per table and only for tables the plan marks `conflict`: the target table's rows are truncated
 * (schema kept) and the source rows are copied in. Tables that exist only in the target are never touched, a
 * table whose SHAPE differs is never altered, and the source is never written to.
 *
 * Verification after a copy: per table, equal row count and an order-independent digest over the normalised rows.
 */

import { createHash } from 'node:crypto';
import type { ITableStorage, Row, TableOp, TableSchema } from '../contracts/tables.js';
import { MAX_TABLE_TX_OPS } from '../contracts/tables.js';
import type { FilterNode } from './collectionStorage.js';
import { encodePgValue } from './postgres/postgresTableCodec.js';
import { canonical, sameSchema } from './postgres/postgresTableCatalog.js';

export type TableCopyStatus =
    | 'copy'             // target table absent: create it and copy every row
    | 'resume'           // target holds a clean subset of the source: copy what is missing
    | 'done'             // target already identical: nothing to do
    | 'conflict'         // target holds rows that differ from / are not in the source: needs --replace
    | 'schema_mismatch'  // target table exists with a different shape: never altered, always refused
    | 'error';           // the source cannot be converted (bad value / unsupported schema)

export interface TableCopyPlanEntry {
    name: string;
    status: TableCopyStatus;
    sourceRows: number;
    /** Rows currently in the target table; null when the table does not exist there yet. */
    targetRows: number | null;
    missing: number;
    identical: number;
    differing: number;
    /** Target rows whose primary key is not in the source. */
    extra: number;
    detail?: string;
}

export interface TableCopyPlan {
    tables: TableCopyPlanEntry[];
    /** Work to do: some table is `copy`, `resume`, or `conflict` with replace. */
    blocking: TableCopyPlanEntry[];
}

export interface TableCopyOptions {
    /** Truncate-and-recopy tables the plan marks `conflict`. */
    replace?: boolean;
    /** Rows per source page (default 500). */
    pageSize?: number;
    /** Ops per target transaction (default and cap MAX_TABLE_TX_OPS = 100). */
    batchSize?: number;
    /** Throws for a schema the target cannot hold, so a dry run can say so before any write. */
    validateTargetSchema?: (schema: TableSchema) => void;
    onProgress?: (msg: string) => void;
}

export interface TableVerifyEntry { name: string; ok: boolean; sourceRows: number; targetRows: number; sourceDigest: string; targetDigest: string }

export interface TableCopyResult {
    copied: Array<{ name: string; rowsWritten: number; truncated: boolean }>;
    verification: TableVerifyEntry[];
    verified: boolean;
}

// --------------------------------------------------------------------------------------------- normalisation

/** One value in a canonical, backend-neutral form (so a SQLite value and its Postgres round trip compare equal). */
export function normalizeValue(v: unknown, type: TableSchema['columns'][number]['type'], ctx: string): unknown {
    if (v === null || v === undefined) return null;
    const e = encodePgValue(v, type, ctx);
    if (e === null) return null;
    switch (type) {
        case 'integer': return BigInt(String(e)).toString();
        case 'datetime': return new Date(String(e)).toISOString();
        case 'json': return canonical(JSON.parse(String(e)));
        default: return e;
    }
}

export function normalizeRow(row: Row, schema: TableSchema, table: string): Row {
    const out: Row = {};
    for (const c of schema.columns) out[c.name] = normalizeValue(row[c.name], c.type, `${table}.${c.name}`);
    return out;
}

const rowKey = (n: Row, schema: TableSchema): string => JSON.stringify(schema.columns.map((c) => n[c.name]));

function pkOf(schema: TableSchema): string {
    return schema.columns.find((c) => c.primary)!.name;
}

/** Stream every row of `store.table` in primary-key order, one page at a time. */
async function* pages(store: ITableStorage, schema: TableSchema, pageSize: number): AsyncGenerator<Row[]> {
    const pk = pkOf(schema);
    let after: unknown;
    let first = true;
    for (;;) {
        const filter: FilterNode | undefined = first ? undefined : { gt: { [pk]: after } };
        const rows = await store.query(schema.name, filter, { orderBy: pk, orderDir: 'asc', limit: pageSize });
        if (rows.length === 0) return;
        yield rows;
        if (rows.length < pageSize) return;
        after = rows[rows.length - 1]![pk];
        first = false;
    }
}

async function targetRowsFor(target: ITableStorage, schema: TableSchema, keys: unknown[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    return target.query(schema.name, { in: { [pkOf(schema)]: keys } }, { limit: keys.length + 1 });
}

// --------------------------------------------------------------------------------------------- plan

export async function planTableCopy(source: ITableStorage, target: ITableStorage, opts: TableCopyOptions = {}): Promise<TableCopyPlan> {
    const pageSize = opts.pageSize ?? 500;
    const srcTables = await source.listTables({ withCounts: true });
    const tgtByName = new Map((await target.listTables({ withCounts: true })).map((t) => [t.name, t]));
    const tables: TableCopyPlanEntry[] = [];
    const srcSchemas = new Map<string, TableSchema>();

    for (const t of srcTables) {
        const schema: TableSchema = { name: t.name, columns: t.columns };
        // listTables does not carry the description; the SQLite schema map does not either way, so compare shape on columns.
        srcSchemas.set(t.name, schema);
        const entry: TableCopyPlanEntry = {
            name: t.name, status: 'copy', sourceRows: t.rowCount ?? 0, targetRows: null, missing: 0, identical: 0, differing: 0, extra: 0,
        };
        tables.push(entry);
        try {
            opts.validateTargetSchema?.(schema);
        } catch (err) {
            entry.status = 'error'; entry.detail = `schema cannot be created in the target: ${(err as Error).message}`;
            continue;
        }
        const existing = tgtByName.get(t.name);
        if (existing) {
            const same = sameSchema({ name: t.name, columns: existing.columns }, schema);
            if (!same) {
                entry.status = 'schema_mismatch'; entry.targetRows = existing.rowCount ?? 0;
                entry.detail = 'the target table exists with a different shape; it is never altered by this command';
                continue;
            }
            entry.targetRows = existing.rowCount ?? 0;
        }
        try {
            if (!existing) {
                // Still walk the source so an unconvertible value is found before any write.
                for await (const page of pages(source, schema, pageSize)) {
                    for (const r of page) normalizeRow(r, schema, t.name);
                    entry.missing += page.length;
                }
                entry.status = 'copy';
                continue;
            }
            for await (const page of pages(source, schema, pageSize)) {
                const pk = pkOf(schema);
                const tgt = new Map<string, string>();
                for (const r of await targetRowsFor(target, schema, page.map((p) => p[pk]))) {
                    const n = normalizeRow(r, schema, t.name);
                    tgt.set(String(n[pk]), rowKey(n, schema));
                }
                for (const r of page) {
                    const n = normalizeRow(r, schema, t.name);
                    const have = tgt.get(String(n[pk]));
                    if (have === undefined) entry.missing++;
                    else if (have === rowKey(n, schema)) entry.identical++;
                    else entry.differing++;
                }
            }
            entry.extra = Math.max(0, (entry.targetRows ?? 0) - entry.identical - entry.differing);
            if (entry.differing > 0 || entry.extra > 0) {
                entry.status = 'conflict';
                entry.detail = `${entry.differing} row(s) differ from the source and ${entry.extra} row(s) are not in the source`;
            } else if (entry.missing === 0) entry.status = 'done';
            else entry.status = 'resume';
        } catch (err) {
            entry.status = 'error'; entry.detail = (err as Error).message;
        }
    }
    const blocking = tables.filter((e) => e.status === 'copy' || e.status === 'resume' || e.status === 'conflict');
    return { tables, blocking };
}

/** Reasons the plan cannot run at all (no write may happen). Empty = go. */
export function planRefusals(plan: TableCopyPlan, opts: Pick<TableCopyOptions, 'replace'>): string[] {
    const out: string[] = [];
    for (const e of plan.tables) {
        if (e.status === 'error') out.push(`${e.name}: ${e.detail}`);
        else if (e.status === 'schema_mismatch') out.push(`${e.name}: ${e.detail}`);
        else if (e.status === 'conflict' && !opts.replace) {
            out.push(`${e.name}: target already holds data that differs from the source (${e.detail}); re-run with --replace to truncate and re-copy this table`);
        }
    }
    return out;
}

// --------------------------------------------------------------------------------------------- execute

export async function executeTableCopy(
    source: ITableStorage, target: ITableStorage, plan: TableCopyPlan, opts: TableCopyOptions = {},
): Promise<TableCopyResult> {
    const refusals = planRefusals(plan, opts);
    if (refusals.length > 0) throw new Error(`table copy refused: ${refusals.join('; ')}`);
    const pageSize = opts.pageSize ?? 500;
    const batch = Math.max(1, Math.min(opts.batchSize ?? MAX_TABLE_TX_OPS, MAX_TABLE_TX_OPS));
    const srcTables = new Map((await source.listTables({ withCounts: false })).map((t) => [t.name, t]));
    const result: TableCopyResult = { copied: [], verification: [], verified: true };

    for (const entry of plan.tables) {
        if (entry.status === 'done') continue;
        const st = srcTables.get(entry.name)!;
        const schema: TableSchema = { name: st.name, columns: st.columns };
        const existedBefore = entry.targetRows !== null;
        await target.createTable(schema);
        let truncated = false;
        let skipCompare = !existedBefore;
        if (entry.status === 'conflict') {
            await target.truncate(entry.name);
            truncated = true; skipCompare = true;
        }
        let written = 0;
        for await (const page of pages(source, schema, pageSize)) {
            const pk = pkOf(schema);
            let todo = page;
            if (!skipCompare) {
                const have = new Map<string, string>();
                for (const r of await targetRowsFor(target, schema, page.map((p) => p[pk]))) {
                    const n = normalizeRow(r, schema, entry.name);
                    have.set(String(n[pk]), rowKey(n, schema));
                }
                todo = page.filter((r) => {
                    const n = normalizeRow(r, schema, entry.name);
                    return have.get(String(n[pk])) !== rowKey(n, schema);
                });
            }
            for (let i = 0; i < todo.length; i += batch) {
                const ops: TableOp[] = todo.slice(i, i + batch).map((row) => ({ op: 'upsert', collection: entry.name, row }));
                await target.runTransaction(ops);
                written += ops.length;
            }
        }
        opts.onProgress?.(`${entry.name}: wrote ${written} row(s)${truncated ? ' (target truncated first)' : ''}`);
        result.copied.push({ name: entry.name, rowsWritten: written, truncated });
    }

    // Verify every source table (including ones that were already `done`).
    for (const [name, st] of srcTables) {
        const schema: TableSchema = { name, columns: st.columns };
        const [s, t] = [await digestTable(source, schema, pageSize), await digestTable(target, schema, pageSize)];
        const ok = s.rows === t.rows && s.digest === t.digest;
        if (!ok) result.verified = false;
        result.verification.push({ name, ok, sourceRows: s.rows, targetRows: t.rows, sourceDigest: s.digest, targetDigest: t.digest });
    }
    return result;
}

/** Row count + an order-independent digest (sum mod 2^256 of per-row sha256) over normalised rows. */
export async function digestTable(store: ITableStorage, schema: TableSchema, pageSize = 500): Promise<{ rows: number; digest: string }> {
    const MOD = 1n << 256n;
    let acc = 0n;
    let rows = 0;
    for await (const page of pages(store, schema, pageSize)) {
        for (const r of page) {
            const n = normalizeRow(r, schema, schema.name);
            acc = (acc + BigInt('0x' + createHash('sha256').update(rowKey(n, schema)).digest('hex'))) % MOD;
            rows++;
        }
    }
    return { rows, digest: acc.toString(16).padStart(64, '0') };
}
