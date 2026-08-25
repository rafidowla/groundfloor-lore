/**
 * dataplaneAdapter.ts — IStorageAdapter for cloud-mode Lore.
 *
 * Step #6 chunk 1 — composes the existing dataplane-backed surfaces
 * behind the same `IStorageAdapter` umbrella as `LocalAdapter`. Pure
 * additions; nothing about the Dataplane wire path changes.
 *
 * Surfaces:
 *   - graph       → DataplaneCollectionStorage (existing)
 *   - verbatim    → IVerbatimStore (auto-wrap a DataplaneVectorStore via
 *                   VerbatimStoreAdapter; same shape mapping the local
 *                   wrapper uses since both stores share the legacy
 *                   `{ metadata: {...} }` shape)
 *   - analytical  → STUB (rejects); a Postgres-backed
 *                   DataplaneAnalyticalStorage lands once the dataplane
 *                   exposes aggregation endpoints.
 *   - tables      → STUB (rejects); a Postgres-backed
 *                   DataplaneTableStorage lands alongside.
 *
 * The two stubs are deliberate — they mirror the LocalAdapter
 * tables-stub pattern so callers either work in both adapters or fail
 * loudly with the gap they need filled.
 */

import type {
    IAnalyticalStorage,
    IStorageAdapter,
    ITableStorage,
    IVerbatimStore,
    CollectionStorage,
    Row,
    TableSchema,
    JoinSpec,
    AggregationType,
    TimeBucket,
    GroupResult,
    TimeSeriesPoint,
} from '../contracts/index.js';
import type { Filter, FindOptions } from './collectionStorage.js';

export interface DataplaneAdapterDeps {
    graph: CollectionStorage;
    verbatim: IVerbatimStore;
    /** Optional once DataplaneAnalyticalStorage lands. */
    analytical?: IAnalyticalStorage;
    /** Optional once DataplaneTableStorage lands. */
    tables?: ITableStorage;
}

export class DataplaneAdapter implements IStorageAdapter {
    readonly mode = 'cloud' as const;
    readonly graph: CollectionStorage;
    readonly verbatim: IVerbatimStore;
    readonly analytical: IAnalyticalStorage;
    readonly tables: ITableStorage;

    constructor(deps: DataplaneAdapterDeps) {
        this.graph = deps.graph;
        this.verbatim = deps.verbatim;
        this.analytical = deps.analytical ?? unimplementedAnalytical();
        this.tables = deps.tables ?? unimplementedTables();
    }
}

function unimplementedAnalytical(): IAnalyticalStorage {
    const fail = <T>(op: string): Promise<T> =>
        Promise.reject(new Error(
            `DataplaneAdapter.analytical.${op}: not yet wired. ` +
            'DataplaneAnalyticalStorage (Postgres-backed aggregation) lands in step #6 follow-up.',
        ));
    return {
        count: (_c: string, _f?: Filter) => fail<number>('count'),
        sum: (_c: string, _fld: string, _f?: Filter) => fail<number>('sum'),
        avg: (_c: string, _fld: string, _f?: Filter) => fail<number>('avg'),
        min: <T = unknown>(_c: string, _fld: string, _f?: Filter) => fail<T | null>('min'),
        max: <T = unknown>(_c: string, _fld: string, _f?: Filter) => fail<T | null>('max'),
        groupBy: <TKey = unknown>(
            _c: string, _g: string, _a: AggregationType, _af: string | null, _f?: Filter, _l?: number,
        ) => fail<GroupResult<TKey>[]>('groupBy'),
        distinct: <T = unknown>(_c: string, _fld: string, _f?: Filter) => fail<T[]>('distinct'),
        timeSeries: <TKey = string>(
            _c: string, _t: string, _b: TimeBucket, _a: AggregationType, _af: string | null, _f?: Filter,
        ) => fail<TimeSeriesPoint<TKey>[]>('timeSeries'),
    };
}

function unimplementedTables(): ITableStorage {
    const fail = <T>(op: string): Promise<T> =>
        Promise.reject(new Error(
            `DataplaneAdapter.tables.${op}: not yet wired. ` +
            'DataplaneTableStorage (Postgres-backed CRUD) lands in step #6 follow-up.',
        ));
    return {
        capabilities: () => ({
            // Postgres-backed: real JOIN, case-INSENSITIVE ILIKE,
            // JSONB inner fields when wired, ALTER TABLE.
            // Stub today; reports what the eventual backend will support.
            join: true, caseSensitiveContains: false,
            extractedJsonFields: true, additiveSchemaEvolution: true,
        }),
        createTable: (_s: TableSchema) => fail<void>('createTable'),
        insert: (_t: string, _r: Row) => fail<void>('insert'),
        insertBatch: (_t: string, _r: Row[]) => fail<void>('insertBatch'),
        query: (_t: string, _f?: Filter, _o?: FindOptions) => fail<Row[]>('query'),
        getByKey: <T extends Row = Row>(_t: string, _k: unknown) => fail<T | null>('getByKey'),
        update: (_t: string, _f: Filter, _p: Partial<Row>) => fail<number>('update'),
        delete: (_t: string, _f: Filter) => fail<number>('delete'),
        count: (_t: string, _f?: Filter) => fail<number>('count'),
        truncate: (_t: string) => fail<number>('truncate'),
        join: (_lt: string, _j: JoinSpec, _f?: Filter, _o?: FindOptions) => fail<Row[]>('join'),
    };
}
