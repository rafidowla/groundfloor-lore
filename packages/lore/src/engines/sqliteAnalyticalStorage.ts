/**
 * sqliteAnalyticalStorage.ts — analytical aggregates over the SQLite collection
 * store, replacing the prior graph-engine-backed implementation.
 *
 * ── WHY THIS REPLACES RATHER THAN PORTS ─────────────────────────────────────
 *
 * The prior analytical storage issued `MATCH (n:<table>) RETURN count(n)`
 * against the graph engine's node tables. Collections have written to
 * **SQLite** since 061e189 (2026-05-16), so it had been aggregating over a
 * substrate that stopped receiving collection writes twelve weeks ago.
 * Measured, not inferred: write 7 rows through the live `SqliteTableStorage`
 * path and ask each side for a count —
 *
 *     SqliteTableStorage.count('invoice')                     -> 7
 *     (prior graph-backed analytical store).count('invoice')  -> throws
 *                                  "Binder exception: Table invoice does not exist."
 *
 * That is an exposed MCP tool surface (`mcp/tools/analytical.ts`: count, sum,
 * avg, min, max, groupBy, distinct, timeSeries) failing in the open. So this is
 * a live-defect fix that happens to also remove a dependency on that prior
 * engine, which is why it was rebuilt rather than deleted.
 *
 * ── WHAT IS ACTUALLY NEW HERE ───────────────────────────────────────────────
 *
 * `timeSeries` was never implemented on the prior engine — its own header
 * said it was "stubbed pending verification of the engine's date-bucketing
 * functions". So this is a first implementation, not a port, and it is the
 * one place where SQLite is dramatically the better host: `strftime` does
 * calendar bucketing natively where the Cypher version had no answer at all.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Every interpolated identifier — table, aggregate field, group field, time
 * field — goes through the shared `assertIdent`/`quoteSqliteIdent` guards, and
 * every filter through `buildSqliteWhere`. SQLite has no parameter slot for an
 * identifier, so this is the same SW-01 discipline `sqliteTableStorage.ts`
 * follows. Values are always bound.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { assertIdent, buildSqliteWhere, quoteSqliteIdent } from './whereClause.js';
import { encodeValue, decodeValue } from './sqliteTableStorage.js';
import type { ColumnType } from '../contracts/tables.js';
import type { Filter } from './collectionStorage.js';
import {
    AnalyticalScanCapExceeded,
    ANALYTICAL_SCAN_CAP_DEFAULT,
    resolveGroupByLimit,
    type AggregationType,
    type GroupResult,
    type IAnalyticalStorage,
    type TimeBucket,
    type TimeSeriesPoint,
} from '../contracts/analytical.js';

/** Canonical collection name → physical SQLite table name. */
export type ResolveTableFn = (coll: string) => string;

/** Physical table name → declared column types (null when unknown). */
export type ColTypesFn = (table: string) => Map<string, ColumnType> | null;

/**
 * Per-call LORE_ANALYTICAL_SCAN_CAP override (docs/CONFIGURATION.md).
 *
 * Re-read on every call rather than cached at module load — matches the
 * prior legacy-engine-backed `timeSeriesScanCap()` read pattern, which the graph-
 * engine removal (2026-08-21) dropped when the analytical store was
 * rebuilt on SQLite. Restores the documented fail-loud cap: `timeSeries`
 * (JS-side bucketing) and `groupBy` (a full scan collapsed via `GROUP BY`)
 * both aggregate over the WHOLE matched set, so a query that would exceed
 * the cap must be refused rather than silently scanned/truncated.
 */
function analyticalScanCap(): number {
    const raw = Number(process.env['LORE_ANALYTICAL_SCAN_CAP']);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : ANALYTICAL_SCAN_CAP_DEFAULT;
}

/**
 * `strftime` format per bucket.
 *
 * Quarter has no `strftime` code, so it is composed: the year, then the
 * quarter index derived from the month. Week uses `%Y-W%W` (ISO-ish, Monday
 * start) rather than a date, because a week label is not a day.
 */
const BUCKET_FORMAT: Record<TimeBucket, string> = {
    minute: "strftime('%Y-%m-%dT%H:%M', {F})",
    hour: "strftime('%Y-%m-%dT%H:00', {F})",
    day: "strftime('%Y-%m-%d', {F})",
    week: "strftime('%Y-W%W', {F})",
    month: "strftime('%Y-%m', {F})",
    quarter: "(strftime('%Y', {F}) || '-Q' || ((CAST(strftime('%m', {F}) AS INTEGER) + 2) / 3))",
    year: "strftime('%Y', {F})",
};

export class SqliteAnalyticalStorage implements IAnalyticalStorage {
    constructor(
        private readonly db: DatabaseType,
        private readonly resolveTable: ResolveTableFn,
        private readonly colTypes?: ColTypesFn,
    ) { }

    /** Physical table name, validated before it can reach a SQL string. */
    private table(coll: string): string {
        return quoteSqliteIdent(assertIdent(this.resolveTable(coll)));
    }

    /**
     * WHERE builder that encodes filter values by DECLARED column type
     * (audit cluster 5, 2026-08-17): previously filters were built with no
     * type map, so a boolean filter either threw a raw better-sqlite3 bind
     * error (JS true/false is not bindable) or silently matched nothing
     * ('false' never equals the stored 0). Now the SAME encodeValue the
     * table store's write/read paths use is applied here.
     */
    private typedWhere(coll: string, filter?: Filter): { where: string; params: unknown[] } {
        const types = this.colTypes?.(this.resolveTable(coll)) ?? null;
        return buildSqliteWhere(filter, {
            encode: (k, v) => {
                const t = types?.get(k);
                return t !== undefined ? encodeValue(v, t) : v;
            },
        });
    }

    /** Decode a raw SQLite result value back to its declared column type
     *  (audit cluster 5): boolean 0/1 → true/false, json TEXT → parsed
     *  object. Unknown columns pass through raw, as before. */
    private decode(coll: string, field: string, v: unknown): unknown {
        if (v === null || v === undefined) return v;
        const t = this.colTypes?.(this.resolveTable(coll))?.get(field);
        return t !== undefined ? decodeValue(v, t) : v;
    }

    /** Validate an optional LIMIT argument (audit cluster 5 — the parameter
     *  declared on IAnalyticalStorage was silently ignored). */
    private static checkLimit(limit: number | undefined, method: string): number | null {
        if (limit === undefined) return null;
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error(`SqliteAnalyticalStorage.${method}: limit must be a positive integer, got ${limit}`);
        }
        return limit;
    }

    /**
     * Enforce LORE_ANALYTICAL_SCAN_CAP (docs/CONFIGURATION.md) before an
     * operation that aggregates over its FULL matched-row set (`timeSeries`
     * JS-side buckets every row; `groupBy` collapses every row via
     * `GROUP BY`). Cheapest correct check: a `SELECT COUNT(*)` over the
     * same filter — reusing the existing `scalar('count', …)` path — rather
     * than running the real aggregation just to discover it should have
     * been refused. Throws `AnalyticalScanCapExceeded` when the matched
     * count exceeds the cap; the caller must narrow the filter/time range
     * or raise the override, per the documented fail-loud contract.
     */
    private assertWithinScanCap(coll: string, filter: Filter | undefined, method: string): void {
        const cap = analyticalScanCap();
        const matched = Number(this.scalar(coll, 'count', null, filter) ?? 0);
        if (matched > cap) {
            throw new AnalyticalScanCapExceeded(`SqliteAnalyticalStorage.${method}`, cap, matched);
        }
    }

    /**
     * One scalar aggregate.
     *
     * `count` is `count(*)` rather than `count(field)`: the contract counts
     * ROWS, and `count(field)` silently skips NULLs, which would make `count`
     * disagree with `SqliteTableStorage.count` on any nullable column.
     */
    private scalar(coll: string, agg: AggregationType, field: string | null, filter?: Filter): unknown {
        const expr = agg === 'count'
            ? 'count(*)'
            : `${agg}(${quoteSqliteIdent(assertIdent(field ?? ''))})`;
        const { where, params } = this.typedWhere(coll, filter);
        const row = this.db
            .prepare(`SELECT ${expr} AS v FROM ${this.table(coll)} ${where}`)
            .get(...params) as { v: unknown } | undefined;
        return row?.v ?? null;
    }

    async count(coll: string, filter?: Filter): Promise<number> {
        return Number(this.scalar(coll, 'count', null, filter) ?? 0);
    }

    /**
     * `sum`/`avg` of no rows.
     *
     * SQLite returns NULL for both; the contract types them `number`. Zero is
     * the honest answer for a sum over nothing. For `avg` it is not — the mean
     * of an empty set is undefined — but the contract has no null channel, so
     * 0 is returned and this comment exists so the next reader knows it is a
     * contract limitation rather than a computed value.
     */
    async sum(coll: string, field: string, filter?: Filter): Promise<number> {
        return Number(this.scalar(coll, 'sum', field, filter) ?? 0);
    }

    async avg(coll: string, field: string, filter?: Filter): Promise<number> {
        return Number(this.scalar(coll, 'avg', field, filter) ?? 0);
    }

    /** `min`/`max` DO have a null channel in the contract, so absence is null. */
    async min<T = unknown>(coll: string, field: string, filter?: Filter): Promise<T | null> {
        const v = this.scalar(coll, 'min', field, filter) ?? null;
        return (v === null ? null : this.decode(coll, field, v)) as T | null;
    }

    async max<T = unknown>(coll: string, field: string, filter?: Filter): Promise<T | null> {
        const v = this.scalar(coll, 'max', field, filter) ?? null;
        return (v === null ? null : this.decode(coll, field, v)) as T | null;
    }

    /**
     * Aggregate per distinct value of `groupField`.
     *
     * Returns `count` alongside `value` for every aggregation — including
     * `count`, where they are equal — because a caller reading `sum` per group
     * almost always needs the group size to interpret it, and a second query
     * to get it would be a different snapshot.
     */
    async groupBy<TKey = unknown>(
        coll: string,
        groupField: string,
        aggregation: AggregationType,
        aggregationField: string | null,
        filter?: Filter,
        limit?: number,
    ): Promise<GroupResult<TKey>[]> {
        if (aggregation !== 'count' && !aggregationField) {
            throw new Error(
                `SqliteAnalyticalStorage.groupBy: aggregation '${aggregation}' requires aggregationField`,
            );
        }
        // Fail loud over LORE_ANALYTICAL_SCAN_CAP BEFORE the GROUP BY scan —
        // the cap bounds rows SCANNED, not groups returned, so a caller
        // `limit` on the output does not exempt an oversized input.
        this.assertWithinScanCap(coll, filter, 'groupBy');
        const key = quoteSqliteIdent(assertIdent(groupField));
        const expr = aggregation === 'count'
            ? 'count(*)'
            : `${aggregation}(${quoteSqliteIdent(assertIdent(aggregationField ?? ''))})`;
        const { where, params } = this.typedWhere(coll, filter);
        // Validate an explicit `limit`'s shape first (positive integer),
        // THEN resolve it against LORE_ANALYTICAL_GROUP_LIMIT — a caller
        // that passes NO limit no longer means "unbounded": a
        // high-cardinality groupField (id/hash/timestamp) would otherwise
        // materialize one row per distinct value with no bound (mirrors the
        // prior legacy-engine-backed implementation's default cap, dropped
        // in the SQLite rebuild). `resolveGroupByLimit` also clamps an explicit limit
        // above the cap; `mcp/tools/analytical.ts` and `mcp/http/routes/
        // analytics.ts` call the SAME function to decide whether to surface
        // `truncated: true` in the response.
        const checked = SqliteAnalyticalStorage.checkLimit(limit, 'groupBy');
        const { limit: lim } = resolveGroupByLimit(checked ?? undefined);
        const rows = this.db.prepare(
            `SELECT ${key} AS k, ${expr} AS v, count(*) AS c
             FROM ${this.table(coll)} ${where}
             GROUP BY ${key}
             ORDER BY ${key} ASC LIMIT ?`,
        ).all(...params, lim) as Array<{ k: unknown; v: unknown; c: number }>;
        return rows.map((r) => ({
            key: this.decode(coll, groupField, r.k) as TKey,
            value: Number(r.v ?? 0),
            count: Number(r.c),
        }));
    }

    /** Distinct values of `field`, ordered so repeated calls agree. */
    async distinct<T = unknown>(coll: string, field: string, filter?: Filter, limit?: number): Promise<T[]> {
        const col = quoteSqliteIdent(assertIdent(field));
        const { where, params } = this.typedWhere(coll, filter);
        // Same LORE_ANALYTICAL_GROUP_LIMIT cap groupBy() enforces above (see
        // its comment) — a caller passing no limit no longer means
        // "unbounded": a high-cardinality field otherwise returns one row
        // per distinct value with no bound. resolveGroupByLimit is also
        // what mcp/tools/analytical.ts and mcp/http/routes/analytics.ts
        // call to decide whether to surface `truncated: true`.
        const checked = SqliteAnalyticalStorage.checkLimit(limit, 'distinct');
        const { limit: lim } = resolveGroupByLimit(checked ?? undefined);
        const rows = this.db.prepare(
            `SELECT DISTINCT ${col} AS v FROM ${this.table(coll)} ${where} ORDER BY ${col} ASC LIMIT ?`,
        ).all(...params, lim) as Array<{ v: unknown }>;
        return rows.map((r) => this.decode(coll, field, r.v) as T);
    }

    /**
     * Aggregate bucketed by calendar period — the method the prior engine never implemented.
     *
     * Buckets are computed by `strftime` over the stored value, so `timeField`
     * must hold an ISO-8601 string or a value SQLite's date functions accept.
     * Rows whose time field does not parse produce a NULL bucket and are
     * DROPPED rather than collapsed into one anonymous bucket, which would
     * silently mix unrelated rows into a plausible-looking data point.
     */
    async timeSeries<TKey = string>(
        coll: string,
        timeField: string,
        bucket: TimeBucket,
        aggregation: AggregationType,
        aggregationField: string | null,
        filter?: Filter,
    ): Promise<TimeSeriesPoint<TKey>[]> {
        if (aggregation !== 'count' && !aggregationField) {
            throw new Error(
                `SqliteAnalyticalStorage.timeSeries: aggregation '${aggregation}' requires aggregationField`,
            );
        }
        // Fail loud over LORE_ANALYTICAL_SCAN_CAP BEFORE bucketing — restores
        // the cap the prior legacy-engine-backed implementation enforced, dropped when
        // the graph-engine removal (2026-08-21) rebuilt this store on SQLite.
        this.assertWithinScanCap(coll, filter, 'timeSeries');
        const tf = quoteSqliteIdent(assertIdent(timeField));
        const bucketExpr = BUCKET_FORMAT[bucket].replace(/\{F\}/g, tf);
        const expr = aggregation === 'count'
            ? 'count(*)'
            : `${aggregation}(${quoteSqliteIdent(assertIdent(aggregationField ?? ''))})`;
        const { where, params } = this.typedWhere(coll, filter);
        const guard = where ? `${where} AND ${bucketExpr} IS NOT NULL` : `WHERE ${bucketExpr} IS NOT NULL`;
        const rows = this.db.prepare(
            `SELECT ${bucketExpr} AS b, ${expr} AS v, count(*) AS c
             FROM ${this.table(coll)} ${guard}
             GROUP BY b
             ORDER BY b ASC`,
        ).all(...params) as Array<{ b: unknown; v: unknown; c: number }>;
        return rows.map((r) => ({ bucket: r.b as TKey, value: Number(r.v ?? 0), count: Number(r.c) }));
    }
}
