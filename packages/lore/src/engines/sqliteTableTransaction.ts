/**
 * Shared SQLite mutation primitives and all-or-nothing table transactions.
 *
 * SqliteTableStorage delegates its public insert/update/delete methods here,
 * so transactions reuse exactly the same guarded, parameterized SQL paths.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { FilterNode } from './collectionStorage.js';
import { quoteSqliteIdent as quoteIdent } from './whereClause.js';
import type {
    ColumnType,
    DestructiveWriteOptions,
    Row,
    TableOp,
    TableOpResult,
    TableSchema,
} from '../contracts/tables.js';
import { MAX_TABLE_TX_OPS } from '../contracts/tables.js';

type WhereResult = { where: string; params: unknown[] };

export interface SqliteTableMutationContext {
    db: DatabaseType;
    requireSchema(table: string, op: string): TableSchema;
    encodeValue(value: unknown, type: ColumnType): unknown;
    buildWhere(filter: FilterNode | undefined, schema: TableSchema): WhereResult;
}

function coerceJsonObject(value: unknown): Record<string, unknown> | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object'
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

/**
 * X-allrows (2026-09-03) — second, DATA-AWARE layer of the unscoped-write
 * guard. `mcp/tools/collectionsFilterScope.ts`'s `classifyFilterScope` is
 * "deliberately syntactic" (its own doc comment): `{gte:{id:0}}`,
 * `{lte:{id:999999999}}` and `{not:{eq:{id:-999999}}}` all classify as
 * SCOPED — narrows to a data-dependent subset — because deciding they
 * match every row of a REAL table would require reading the rows, which
 * that layer never does. Against a table where every row's `id` happens
 * to satisfy the filter, that SCOPED classification is wrong in exactly
 * the same way an ALL classification would be: the whole table gets
 * mutated/deleted with no `all:true` and no refusal.
 *
 * This runs one level down, inside the SAME SQLite transaction as the
 * mutation it is guarding (better-sqlite3's `db.transaction()` uses a
 * SAVEPOINT when already inside one, so nesting inside
 * `runSqliteTableTransaction`'s wrapper is safe): COUNT(*) the whole
 * table and COUNT(*) the filtered subset. If a >1-row table's filtered
 * count equals its total count, the filter is a tautology BY DATA, not
 * just by construction — refuse it exactly like the syntactic ALL case,
 * unless the caller passed `all: true`. A 0- or 1-row table is exempted:
 * a filter that matches the table's one existing row is legitimately
 * scoped (it would still match only one row after another insert), not
 * an all-rows write in disguise.
 *
 * The refusal message deliberately reuses the literal phrase "empty/all
 * filter" (and "truncate") so `classifyStorageErr` (mcp/http/routes/
 * collections.ts) and `describeTransactionFailure`
 * (mcp/tools/collectionsTransaction.ts) — which both already recognize
 * that phrase from the syntactic guard's own throw — route this refusal
 * to the SAME `all_filter_refused` 400/error code, not a new one.
 */
function assertNotDataTautology(
    ctx: SqliteTableMutationContext,
    table: string,
    where: string,
    params: unknown[],
    opts: DestructiveWriteOptions | undefined,
    op: string,
    verb: 'update' | 'delete',
): void {
    if (opts?.all === true) return;
    const totalRow = ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get() as { c: number };
    if (totalRow.c <= 1) return; // 0/1-row table: a matching single row is legitimately scoped.
    const matchRow = ctx.db.prepare(
        `SELECT COUNT(*) AS c FROM ${quoteIdent(table)} ${where}`,
    ).get(...params) as { c: number };
    if (matchRow.c === totalRow.c) {
        throw new Error(
            `SqliteTableStorage.${op}: this filter matches all ${totalRow.c} rows of '${table}' — `
            + `treating it as an empty/all filter by data (even though the filter shape itself is `
            + `scoped). Pass all:true to confirm an intentional ${verb} of every row, or use `
            + 'truncate() for an unconditional full wipe.',
        );
    }
}

function primaryColumn(schema: TableSchema) {
    const columns = schema.columns.filter(column => column.primary);
    if (columns.length !== 1) {
        throw new Error(
            `SqliteTableStorage: schema requires exactly one primary column, got ${columns.length}`,
        );
    }
    return columns[0]!;
}

function assertKnownColumns(schema: TableSchema, row: Row, table: string, op: string): void {
    for (const key of Object.keys(row)) {
        if (!schema.columns.some(column => column.name === key)) {
            throw new Error(`SqliteTableStorage.${op}: unknown column '${key}' on table '${table}'`);
        }
    }
}

function buildInsert(
    ctx: SqliteTableMutationContext,
    schema: TableSchema,
    row: Row,
    table: string,
    op: string,
    rowIndex?: number,
): { columns: string[]; placeholders: string[]; params: unknown[] } {
    assertKnownColumns(schema, row, table, op);
    const columns: string[] = [];
    const placeholders: string[] = [];
    const params: unknown[] = [];

    for (const column of schema.columns) {
        if (!(column.name in row)) continue;
        columns.push(quoteIdent(column.name));
        placeholders.push('?');
        params.push(ctx.encodeValue(row[column.name], column.type));
        if (column.type !== 'json' || !column.extractedFields) continue;
        const object = coerceJsonObject(row[column.name]);
        for (const field of column.extractedFields) {
            columns.push(quoteIdent(`${column.name}__${field.key}`));
            placeholders.push('?');
            params.push(ctx.encodeValue(object?.[field.key], field.type));
        }
    }

    if (columns.length === 0) {
        const suffix = rowIndex === undefined ? '' : ` (row index ${rowIndex})`;
        throw new Error(`SqliteTableStorage.${op}: empty row for ${table}${suffix}`);
    }
    return { columns, placeholders, params };
}

export function insertSqliteTableRow(
    ctx: SqliteTableMutationContext,
    table: string,
    row: Row,
    op = 'insert',
    rowIndex?: number,
): unknown {
    const schema = ctx.requireSchema(table, op);
    const built = buildInsert(ctx, schema, row, table, op, rowIndex);
    ctx.db.prepare(
        `INSERT INTO ${quoteIdent(table)} (${built.columns.join(', ')}) `
        + `VALUES (${built.placeholders.join(', ')})`,
    ).run(...built.params);
    const primary = primaryColumn(schema);
    return row[primary.name];
}

export function updateSqliteTableRows(
    ctx: SqliteTableMutationContext,
    table: string,
    filter: FilterNode,
    patch: Partial<Row>,
    op = 'update',
    opts?: DestructiveWriteOptions,
): number {
    const schema = ctx.requireSchema(table, op);
    const sets: string[] = [];
    const setParams: unknown[] = [];

    for (const [key, value] of Object.entries(patch)) {
        const column = schema.columns.find(candidate => candidate.name === key);
        if (!column) {
            throw new Error(`SqliteTableStorage.${op}: unknown column '${key}' on table '${table}'`);
        }
        sets.push(`${quoteIdent(key)} = ?`);
        setParams.push(ctx.encodeValue(value, column.type));
        if (column.type !== 'json' || !column.extractedFields) continue;
        const object = coerceJsonObject(value);
        for (const field of column.extractedFields) {
            sets.push(`${quoteIdent(`${column.name}__${field.key}`)} = ?`);
            setParams.push(ctx.encodeValue(object?.[field.key], field.type));
        }
    }

    if (sets.length === 0) return 0;
    const { where, params } = ctx.buildWhere(filter, schema);
    // Round-S fix (2026-09-04) — this unconditionally refused a syntactically
    // empty/all filter even when the caller passed `all: true`, contradicting
    // every layer above it (assertScopedOrAllOptIn in mcp/tools/collections.ts,
    // the transaction op guard in collectionsTransaction.ts) which all promise
    // "pass all:true to confirm" for an ALL-scope filter — and contradicting
    // `assertNotDataTautology` just below, which HAS honored `opts.all` for
    // an ALL-by-DATA filter since X-allrows shipped. `classifyFilterScope`
    // treats every ALL-scope filter as equivalent regardless of shape; this
    // guard is the one place that used to disagree by refusing the literal
    // empty-filter subset even with the same confirmation. `all: true` now
    // means the same thing here as it does everywhere else on this surface.
    if (!where && opts?.all !== true) {
        throw new Error(
            `SqliteTableStorage.${op}: refusing to update all rows of '${table}' `
            + 'with an empty/all filter — provide a scoping filter, or pass all:true to confirm.',
        );
    }
    // X-allrows — second, data-aware layer + the mutation itself run inside
    // ONE SQLite transaction (a SAVEPOINT when already inside
    // runSqliteTableTransaction's own transaction) so the tautology check
    // and the write it guards can never observe different table states.
    const run = ctx.db.transaction(() => {
        assertNotDataTautology(ctx, table, where, params, opts, op, 'update');
        return ctx.db.prepare(
            `UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} ${where}`,
        ).run(...setParams, ...params).changes;
    });
    return run();
}

export function deleteSqliteTableRows(
    ctx: SqliteTableMutationContext,
    table: string,
    filter: FilterNode,
    op = 'delete',
    opts?: DestructiveWriteOptions,
): number {
    const schema = ctx.requireSchema(table, op);
    const { where, params } = ctx.buildWhere(filter, schema);
    // Round-S fix (2026-09-04) — see the matching comment in
    // updateSqliteTableRows above: `all: true` used to be silently ignored
    // for the literal empty-filter case, contradicting every caller that
    // promises it as a valid confirmation (handleDeleteByQuery,
    // assertScopedOrAllOptIn, the transaction op guard).
    if (!where && opts?.all !== true) {
        throw new Error(
            `SqliteTableStorage.${op}: refusing to delete all rows from '${table}' `
            + 'with no filter. Pass all:true to confirm, or use truncate() for that.',
        );
    }
    // X-allrows — see updateSqliteTableRows above: same one-transaction
    // check-then-mutate pairing for delete.
    const run = ctx.db.transaction(() => {
        assertNotDataTautology(ctx, table, where, params, opts, op, 'delete');
        return ctx.db.prepare(`DELETE FROM ${quoteIdent(table)} ${where}`).run(...params).changes;
    });
    return run();
}

export function runSqliteTableTransaction(
    ctx: SqliteTableMutationContext,
    ops: TableOp[],
): TableOpResult[] {
    if (ops.length === 0) {
        throw new Error('table transaction requires at least one operation');
    }
    if (ops.length > MAX_TABLE_TX_OPS) {
        throw new Error(
            `table transaction accepts at most ${MAX_TABLE_TX_OPS} operations (got ${ops.length})`,
        );
    }

    const execute = ctx.db.transaction((items: TableOp[]): TableOpResult[] => {
        const results: TableOpResult[] = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index]!;
            try {
                if (item.op === 'insert') {
                    const key = insertSqliteTableRow(ctx, item.collection, item.row, 'runTransaction');
                    results.push({ op: 'insert', collection: item.collection, key });
                } else if (item.op === 'update') {
                    const count = updateSqliteTableRows(
                        ctx, item.collection, item.filter, item.patch, 'runTransaction', { all: item.all },
                    );
                    results.push({ op: 'update', collection: item.collection, count });
                } else if (item.op === 'delete') {
                    const count = deleteSqliteTableRows(
                        ctx, item.collection, item.filter, 'runTransaction', { all: item.all },
                    );
                    results.push({ op: 'delete', collection: item.collection, count });
                } else {
                    const schema = ctx.requireSchema(item.collection, 'runTransaction');
                    assertKnownColumns(schema, item.row, item.collection, 'runTransaction');
                    const primary = primaryColumn(schema);
                    const key = item.row[primary.name];
                    if (key === undefined || key === null) {
                        throw new Error(
                            `SqliteTableStorage.runTransaction: upsert row for '${item.collection}' `
                            + `must include primary key '${primary.name}'`,
                        );
                    }
                    const encodedKey = ctx.encodeValue(key, primary.type);
                    const exists = ctx.db.prepare(
                        `SELECT 1 AS present FROM ${quoteIdent(item.collection)} `
                        + `WHERE ${quoteIdent(primary.name)} = ? LIMIT 1`,
                    ).get(encodedKey) as { present: number } | undefined;
                    if (exists) {
                        const patch = { ...item.row };
                        delete patch[primary.name];
                        if (Object.keys(patch).length > 0) {
                            updateSqliteTableRows(
                                ctx,
                                item.collection,
                                { eq: { [primary.name]: key } },
                                patch,
                                'runTransaction',
                            );
                        }
                    } else {
                        insertSqliteTableRow(ctx, item.collection, item.row, 'runTransaction');
                    }
                    results.push({ op: 'upsert', collection: item.collection, key });
                }
            } catch (error) {
                const wrapped = new Error(
                    `table transaction operation ${index} failed: ${(error as Error).message}`,
                    { cause: error },
                ) as Error & { failedOpIndex: number };
                wrapped.failedOpIndex = index;
                throw wrapped;
            }
        }
        return results;
    });

    return execute(ops);
}
