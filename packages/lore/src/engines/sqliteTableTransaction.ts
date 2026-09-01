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
    if (!where) {
        throw new Error(
            `SqliteTableStorage.${op}: refusing to update all rows of '${table}' `
            + 'with an empty/all filter — provide a scoping filter.',
        );
    }
    return ctx.db.prepare(
        `UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} ${where}`,
    ).run(...setParams, ...params).changes;
}

export function deleteSqliteTableRows(
    ctx: SqliteTableMutationContext,
    table: string,
    filter: FilterNode,
    op = 'delete',
): number {
    const schema = ctx.requireSchema(table, op);
    const { where, params } = ctx.buildWhere(filter, schema);
    if (!where) {
        throw new Error(
            `SqliteTableStorage.${op}: refusing to delete all rows from '${table}' `
            + 'with no filter. Use truncate() for that.',
        );
    }
    return ctx.db.prepare(`DELETE FROM ${quoteIdent(table)} ${where}`).run(...params).changes;
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
                        ctx, item.collection, item.filter, item.patch, 'runTransaction',
                    );
                    results.push({ op: 'update', collection: item.collection, count });
                } else if (item.op === 'delete') {
                    const count = deleteSqliteTableRows(
                        ctx, item.collection, item.filter, 'runTransaction',
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
