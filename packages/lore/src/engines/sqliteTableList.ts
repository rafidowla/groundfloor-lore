/**
 * sqliteTableList.ts — `SqliteTableStorage.listTables` body, split out
 * (file-size cap) so sqliteTableStorage.ts stays under the 800-line hard
 * cap. Mirrors the sqliteTableTransaction.ts pattern: a plain function
 * taking a small context object instead of `this`.
 *
 * Finding #7 (2026-09-03) — enumerate every table declared in a store's
 * schema map. Row counts are best-effort: a table dropped out from under
 * the schema cache (e.g. the .db file was reset but schemas.json wasn't)
 * reports `rowCount: undefined` instead of failing the whole listing.
 *
 * Finding B3 (round E, 2026-09-03) — this used to run one synchronous
 * `COUNT(*)` per table, unconditionally, for every table ever declared
 * (50k tables blocks the event loop for ~350ms; there was also no way to
 * page the name/column listing itself). `opts` bounds both costs:
 * entries are sorted by name for a stable, restart-safe pagination
 * order, `offset`/`limit` slice BEFORE any counting happens, and
 * `withCounts` (default true, matching the original always-counted
 * behavior) gates whether `count()` runs at all — when a caller also
 * passes `limit`, the fan-out this was written to fix is bounded to at
 * most `limit` synchronous `COUNT(*)` calls, not the full table set.
 * See `handleSchemaListPaged` (mcp/tools/collectionsSchemaList.ts), the
 * actual caller that turns this into a cursor-paginated,
 * counts-off-by-default response.
 *
 * Finding B3 (round E2, 2026-09-03) — `offset` is a raw position into
 * the name-sorted list, which is re-derived from `ctx.schemas` fresh on
 * every call. Creating a table whose name sorts before a page boundary
 * shifts every later name's position by one, so two `offset`-cursor
 * fetches straddling a create can return the boundary entry twice (or
 * skip one). `after` fixes this: it slices on `n > after` in the
 * sorted name order — a keyset position that doesn't move when
 * something is created or dropped elsewhere in the set. `after` takes
 * precedence over `offset` when both are given.
 */

import type { ColumnDecl, ListTablesOptions, TableSchema, TableSchemaSummary } from '../contracts/tables.js';

export interface SqliteTableListContext {
    schemas: Map<string, TableSchema>;
    count(table: string): Promise<number>;
    pickPrimary(cols: ColumnDecl[]): ColumnDecl;
}

export async function listSqliteTables(
    ctx: SqliteTableListContext,
    opts: ListTablesOptions = {},
): Promise<TableSchemaSummary[]> {
    const { offset = 0, limit, withCounts = true, after } = opts;
    const names = Array.from(ctx.schemas.keys()).sort();
    // `after` (keyset) takes precedence over `offset` (raw position) —
    // see the finding B3 (round E2) doc comment above.
    const start = after !== undefined ? names.findIndex((n) => n > after) : offset;
    const sliceStart = start === -1 ? names.length : start;
    const pageNames = limit === undefined ? names.slice(sliceStart) : names.slice(sliceStart, sliceStart + limit);
    const out: TableSchemaSummary[] = [];
    for (const name of pageNames) {
        const schema = ctx.schemas.get(name)!;
        let rowCount: number | undefined;
        if (withCounts) {
            try {
                rowCount = await ctx.count(schema.name);
            } catch {
                rowCount = undefined;
            }
        }
        out.push({
            name: schema.name,
            columns: schema.columns,
            primaryKey: ctx.pickPrimary(schema.columns).name,
            rowCount,
        });
    }
    return out;
}
