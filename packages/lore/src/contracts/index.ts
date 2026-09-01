/**
 * contracts/index.ts — Lore Core storage contract umbrella.
 *
 * The four universal surfaces every storage backend implements. See
 * `docs/IStorageAdapter.md` for the rationale and adapter-coverage
 * matrix.
 *
 * Status (2026-05-09):
 *   - graph       — EXISTS as `CollectionStorage` (re-exported here)
 *   - verbatim    — EXISTS as `VerbatimStore` class; interface
 *                   `IVerbatimStore` declared here, refactor in step #2
 *   - analytical  — interface declared here, NOT YET IMPLEMENTED
 *   - tables      — interface declared here, NOT YET IMPLEMENTED
 *
 * Step #2 of BUILD_ORDER.md (LocalAdapter) implements the missing
 * pieces against Kùzu + LanceDB. Step #6 implements them against
 * the dataplane SDK.
 */

import type { CollectionStorage } from '../engines/collectionStorage.js';
import type { IVerbatimStore } from './verbatim.js';
import type { IAnalyticalStorage } from './analytical.js';
import type { ITableStorage } from './tables.js';

export type { CollectionStorage } from '../engines/collectionStorage.js';
export type {
    IVerbatimStore,
    VerbatimDocument,
    VerbatimSearchResult,
    VerbatimSearchOpts,
} from './verbatim.js';
export type {
    IAnalyticalStorage,
    AggregationType,
    TimeBucket,
    GroupResult,
    TimeSeriesPoint,
} from './analytical.js';
export type {
    ITableStorage,
    TableSchema,
    ColumnType,
    ColumnDecl,
    Row,
    JoinSpec,
    JoinHop,
    JoinQuery,
    TableOp,
    TableOpResult,
} from './tables.js';

/**
 * IStorageAdapter — the umbrella contract every storage backend
 * implements. Lore Core works against this; never imports
 * adapter-specific code.
 *
 * Two implementations:
 *   - LocalAdapter — Kùzu + LanceDB + (Kùzu node tables for tables)
 *   - DataplaneAdapter — ts-sdk → ArangoDB + Qdrant + Postgres
 *
 * Performance characteristics differ; capabilities don't. There is no
 * "cloud-only" surface — anything cloud can do, local can do (possibly
 * slower at scale).
 *
 * The adapter receives an already-resolved workspace context from the
 * service layer above it. The adapter does not handle:
 *   - Auth (middleware concern)
 *   - Tenancy / workspace routing
 *   - Sync / WAL (SyncEngine sits above)
 *   - Embedding generation (providers/embeddingBackend.ts)
 */
export interface IStorageAdapter {
    /** Substrate identifier. */
    readonly mode: 'local' | 'cloud';

    /** Graph storage — nodes, edges, vector search. Existing CollectionStorage. */
    graph: CollectionStorage;

    /** Verbatim memory — original content + provenance + hybrid search. */
    verbatim: IVerbatimStore;

    /** Analytical surface — count, sum, avg, groupBy, timeSeries, etc. */
    analytical: IAnalyticalStorage;

    /** Tables surface — application-defined tabular CRUD. */
    tables: ITableStorage;
}
