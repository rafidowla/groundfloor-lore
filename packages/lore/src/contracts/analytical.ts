/**
 * analytical.ts — Universal analytical/aggregation surface.
 *
 * Per Lore decision `lore-analytical-primitive-universal-2026-05-09`,
 * the analytical surface is universal across both adapters. No
 * "cloud-only" returns; LocalAdapter (`SqliteAnalyticalStorage`) and
 * DataplaneAdapter (Postgres) both implement the full contract.
 *
 * Performance characteristics differ — cloud handles bigger scale —
 * but capabilities don't. A user query 'how many emails per month from
 * my mom' is universally available.
 *
 * Step #1 of BUILD_ORDER.md ships this interface stub. Step #2
 * implements it on `SqliteAnalyticalStorage`. Step #6 implements on
 * DataplaneCollectionStorage.
 *
 * Existing CollectionStorage already exposes `count` — that method MOVES
 * to this interface in step #2 (the `coll`-keyed shape stays;
 * IAnalyticalStorage is not coll-bound, it's filter-bound across
 * declared collections).
 */

import type { Filter } from '../engines/collectionStorage.js';

/**
 * Default LORE_ANALYTICAL_SCAN_CAP (docs/CONFIGURATION.md). Matches the
 * prior legacy-engine-backed implementation's TIME_SERIES_SCAN_CAP_DEFAULT so the
 * documented default is unchanged across the graph-engine removal
 * (2026-08-21).
 */
export const ANALYTICAL_SCAN_CAP_DEFAULT = 200_000;

/**
 * AnalyticalScanCapExceeded — thrown by an IAnalyticalStorage implementation
 * when honoring LORE_ANALYTICAL_SCAN_CAP (docs/CONFIGURATION.md) requires
 * refusing an operation rather than scanning past the cap.
 *
 * Fail loud, not silently truncate: `timeSeries` buckets and `groupBy`
 * groups the FULL matched set — a truncated scan would silently corrupt the
 * aggregation (missing buckets/groups, wrong sums) instead of merely
 * shrinking it. Callers must narrow the filter/time range or raise the cap.
 */
export class AnalyticalScanCapExceeded extends Error {
    constructor(
        public readonly method: string,
        public readonly cap: number,
        public readonly matched: number,
    ) {
        super(
            `${method}: scan would exceed the ${cap}-row analytical scan cap ` +
            `(matched ${matched} rows) — narrow the filter or time range, or ` +
            `raise LORE_ANALYTICAL_SCAN_CAP to override.`,
        );
        this.name = 'AnalyticalScanCapExceeded';
    }
}

/**
 * AggregationType — the operation to apply over the matching rows.
 */
export type AggregationType = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * Time bucket size for `timeSeries`. Adapter chooses substrate-native
 * bucketing (SQLite uses `strftime`-based date-truncation; Postgres uses
 * `date_trunc`).
 */
export type TimeBucket = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * GroupResult — one row per group key. The aggregate is computed per
 * group; the key is the group_field value for that group.
 */
export interface GroupResult<TKey = unknown> {
    key: TKey;
    value: number;
    count: number;
}

/**
 * TimeSeriesPoint — one bucket on the time axis with the aggregate
 * computed over the rows whose `time_field` falls in the bucket.
 */
export interface TimeSeriesPoint<TKey = string> {
    bucket: TKey;
    value: number;
    count: number;
}

/**
 * IAnalyticalStorage — universal analytical surface.
 *
 * All methods accept a `coll` (the declared collection / SQLite table /
 * Dataplane collection name) and a `Filter`. Filter semantics
 * match `CollectionStorage` — see `src/engines/collectionStorage.ts`.
 * D2-hygiene-2: stale plugins/storage.ts ref (moved v3.11.0).
 *
 * Methods that need a numeric field (`sum` / `avg`) return 0 if no
 * rows match. `min` / `max` return `null` if no rows match.
 */
export interface IAnalyticalStorage {
    /**
     * Count rows matching the filter. Substrate-pushed (not `find().length`).
     * Cheaper than the eponymous `CollectionStorage.count` because it does
     * not require a `coll`-bound storage instance.
     */
    count(coll: string, filter?: Filter): Promise<number>;

    /**
     * Sum a numeric field over matching rows.
     */
    sum(coll: string, field: string, filter?: Filter): Promise<number>;

    /**
     * Average a numeric field. Returns 0 if no rows match.
     */
    avg(coll: string, field: string, filter?: Filter): Promise<number>;

    /**
     * Minimum of a field over matching rows. Returns null if empty.
     * Field can be numeric, string, or date-like — adapter compares
     * substrate-natively.
     */
    min<T = unknown>(coll: string, field: string, filter?: Filter): Promise<T | null>;

    /**
     * Maximum of a field over matching rows. Returns null if empty.
     */
    max<T = unknown>(coll: string, field: string, filter?: Filter): Promise<T | null>;

    /**
     * Group rows by a field, apply an aggregation per group.
     *
     * Example:
     *   groupBy('email', 'fromDomain', 'count', 'count', { gte: { receivedAt: '2026-01-01' } })
     *   → [
     *       { key: 'gmail.com',   value: 412, count: 412 },
     *       { key: 'outlook.com', value: 89,  count: 89  },
     *       ...
     *     ]
     */
    groupBy<TKey = unknown>(
        coll: string,
        groupField: string,
        aggregation: AggregationType,
        aggregationField: string | null,
        filter?: Filter,
        limit?: number,
    ): Promise<GroupResult<TKey>[]>;

    /**
     * Distinct values of a field across matching rows.
     */
    distinct<T = unknown>(coll: string, field: string, filter?: Filter, limit?: number): Promise<T[]>;

    /**
     * Time-series aggregation. Bucket by `timeField` at `bucket` granularity,
     * apply `aggregation` per bucket.
     *
     * Returns one point per non-empty bucket, ordered ascending by bucket.
     *
     * Example:
     *   timeSeries('email', 'receivedAt', 'month', 'count', null, { gte: { receivedAt: '2026-01-01' } })
     *   → [
     *       { bucket: '2026-01', value: 142, count: 142 },
     *       { bucket: '2026-02', value: 178, count: 178 },
     *       ...
     *     ]
     */
    timeSeries<TKey = string>(
        coll: string,
        timeField: string,
        bucket: TimeBucket,
        aggregation: AggregationType,
        aggregationField: string | null,
        filter?: Filter,
    ): Promise<TimeSeriesPoint<TKey>[]>;
}
