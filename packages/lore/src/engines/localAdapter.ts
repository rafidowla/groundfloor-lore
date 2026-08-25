/**
 * localAdapter.ts — IStorageAdapter for local-mode Lore.
 *
 * Composes the four storage surfaces over Kùzu + LanceDB:
 *   - graph       → KuzuCollectionStorage (existing)
 *   - verbatim    → VerbatimStoreAdapter wrapping VerbatimStore
 *   - analytical  → KuzuAnalyticalStorage
 *   - tables      → KuzuTableStorage (or STUB that throws if `tables`
 *                   is omitted from the deps — useful for tests that
 *                   don't exercise the tables surface)
 *
 * Construction is dependency-injected: callers wire up the underlying
 * Kùzu Connection + VerbatimStore + table-resolver, then pass them in.
 * Keeps this class side-effect-free and easy to test.
 *
 * Step #2 of BUILD_ORDER.md (LocalAdapter). See `BUILD_ORDER.md` and
 * `docs/IStorageAdapter.md` for the umbrella contract rationale.
 */

import type {
    IStorageAdapter,
    CollectionStorage,
    IVerbatimStore,
    IAnalyticalStorage,
    ITableStorage,
    TableSchema,
    Row,
    JoinSpec,
} from '../contracts/index.js';
import type { Filter, FindOptions } from './collectionStorage.js';

export interface LocalAdapterDeps {
    graph: CollectionStorage;
    verbatim: IVerbatimStore;
    analytical: IAnalyticalStorage;
    /** Optional: omit to get the unimplementedTables stub. */
    tables?: ITableStorage;
}

export class LocalAdapter implements IStorageAdapter {
    readonly mode = 'local' as const;
    readonly graph: CollectionStorage;
    readonly verbatim: IVerbatimStore;
    readonly analytical: IAnalyticalStorage;
    readonly tables: ITableStorage;

    constructor(deps: LocalAdapterDeps) {
        this.graph = deps.graph;
        this.verbatim = deps.verbatim;
        this.analytical = deps.analytical;
        this.tables = deps.tables ?? unimplementedTables();
    }
}

/**
 * Stub ITableStorage that throws on every method. Used until
 * KuzuTableStorage lands in the next chunk. Intentional throw —
 * silent no-ops would mask caller bugs.
 */
function unimplementedTables(): ITableStorage {
    const fail = <T>(op: string): Promise<T> =>
        Promise.reject(new Error(
            `LocalAdapter.tables.${op}: KuzuTableStorage not yet implemented. ` +
            'Tracked as step-2 follow-up.',
        ));
    return {
        capabilities: () => ({
            join: false, caseSensitiveContains: false,
            extractedJsonFields: false, additiveSchemaEvolution: false,
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
