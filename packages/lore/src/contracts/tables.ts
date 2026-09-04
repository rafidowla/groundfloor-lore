/**
 * tables.ts — Tabular storage surface (collections that don't fit graph).
 *
 * For data that doesn't fit the graph (node/edge) model — pure tables
 * with rows and columns. Callers use this when they need:
 *
 *   - Pure relational shape (joins, indexed lookups, range queries)
 *   - Row volumes that would explode the graph (millions of immutable
 *     event-log rows, for instance)
 *   - Tabular projections of graph data for fast read paths
 *
 * Per Lore decision `lore-analytical-primitive-universal-2026-05-09`,
 * the tables surface is universal across both adapters. LocalAdapter
 * backs it with SQLite (`SqliteTableStorage`). DataplaneAdapter backs it
 * with Postgres.
 *
 * Step #1 of BUILD_ORDER.md ships this interface stub. Step #2
 * implements it for LocalAdapter. Step #6 implements for DataplaneAdapter.
 *
 *   - JOIN support — Postgres is trivial; marked optional in this
 *     interface, and adapters that don't support it throw a clear error.
 */

import type { Filter, FilterNode, FindOptions } from '../engines/collectionStorage.js';

/**
 * ColumnType — declared column type in a TableSchema. Maps to
 * substrate-native types (SQLite: TEXT/INTEGER/etc; Postgres: text/bigint/etc).
 */
export type ColumnType =
    | 'string'
    | 'integer'
    | 'float'
    | 'boolean'
    | 'date'      // ISO 8601 date string (YYYY-MM-DD)
    | 'datetime'  // ISO 8601 with time
    | 'json';     // arbitrary JSON; adapter stores as JSONB / VARCHAR

/**
 * ColumnDecl — one column in a table.
 */
export interface ColumnDecl {
    name: string;
    type: ColumnType;
    /** True if this is the primary key. Exactly one column per table is the pk. */
    primary?: boolean;
    /** True if values must be present. Defaults to false. */
    required?: boolean;
    /** True if values must be unique. Implies an index. */
    unique?: boolean;
    /** True if the adapter should create a btree-style index on this column. */
    indexed?: boolean;
    /**
     * Architecture gap #6 — extracted-and-indexed inner fields for
     * JSON columns. Only meaningful when `type === 'json'`.
     *
     * For each entry, the adapter adds a physical sidecar column
     * named `<name>__<key>` typed as `type`, indexes it when
     * `indexed: true`, and populates it on insert/update by reading
     * the inner field from the JSON. Query filters on these sidecar
     * columns use the same column name (e.g. `eq: {'meta__tag': 'foo'}`).
     *
     * Backends that don't support this silently ignore the option — the
     * JSON column still works, just without the indexed projection.
     */
    extractedFields?: Array<{ key: string; type: ColumnType; indexed?: boolean }>;
}

/**
 * TableSchema — what a client application declares to `createTable`.
 */
export interface TableSchema {
    /**
     * Namespaced table name. Convention: `<owner>_<table>` —
     * e.g. `domain_event_b`, `domain_event_a`. Adapter remaps
     * to substrate-native naming if needed.
     */
    name: string;
    columns: ColumnDecl[];
    /** Optional human-readable description. Surfaced in admin UI. */
    description?: string;
}

/**
 * TableSchemaSummary — one entry in `ITableStorage.listTables()`.
 *
 * Finding #7 (2026-09-03) — there was no way to discover what
 * collections exist short of already knowing a name to pass to
 * `getByKey`-style introspection. `primaryKey` is pulled out of
 * `columns` for convenience (every table has exactly one, per
 * `ColumnDecl.primary`'s doc comment). `createdAt` and `rowCount`
 * are optional because not every backend can produce them cheaply
 * (or at all) — adapters populate what they can.
 */
export interface TableSchemaSummary {
    name: string;
    columns: ColumnDecl[];
    /** Name of the column declared `primary: true`. Empty string if none. */
    primaryKey: string;
    createdAt?: string;
    rowCount?: number;
}

/**
 * ListTablesOptions — pagination + cost controls for `listTables`.
 *
 * QA finding B3 (round E, 2026-09-03) on the original finding #7 fix:
 * `listTables()` enumerated every declared table unconditionally and
 * ran a synchronous `COUNT(*)` per table on every call — no way to
 * page a large collection count, and no way to skip the count
 * fan-out (~7us/table, but linear and synchronous: 50k tables blocks
 * the event loop for ~350ms). All fields are optional and, taken
 * together as a whole omitted `opts` argument (or `{}`), preserve the
 * original unpaginated, always-counted behavior for existing direct
 * callers — only a caller that supplies these explicitly opts into
 * the cheaper/paginated path. `collection_schema_list` and
 * `GET /v1/schema` are the callers that do so, with their own
 * defaults (limit 100, withCounts false) — see
 * `handleSchemaListPaged` in `mcp/tools/collections.ts`.
 *
 * QA finding B3 (round E2, 2026-09-03) on the above: `offset` is a
 * raw numeric position into the name-sorted list, re-sorted fresh on
 * every call. Creating a table whose name sorts before a page
 * boundary shifts every later table's position by one, so an
 * offset-based cursor walk can return (or skip) an entry across two
 * page fetches. `after` is the fix — a keyset cursor naming the last
 * table already returned; the next page is `n > after` in the
 * name-sorted order, which is stable regardless of what gets created
 * or dropped elsewhere in the set. `offset` remains supported for
 * callers that pass it explicitly (e.g. "jump to page 3"), but it is
 * NOT stable under concurrent creates/drops — `handleSchemaListPaged`
 * only ever emits `after`-shaped cursors now; `offset` is documented
 * to callers as a best-effort/unstable positional param.
 */
export interface ListTablesOptions {
    /**
     * Zero-based offset into the name-sorted table list. Default 0.
     * Unstable under concurrent table creates/drops — the name-sorted
     * list is re-derived on every call, so a table created before the
     * current offset shifts everything after it by one position. Use
     * `after` for a stable walk across multiple calls.
     */
    offset?: number;
    /**
     * Keyset alternative to `offset`: only tables whose name sorts
     * strictly after this one (i.e. `n > after` in the name-sorted
     * order). Stable under concurrent creates/drops elsewhere in the
     * set, unlike `offset`. Takes precedence over `offset` when both
     * are given.
     */
    after?: string;
    /** Max entries to return. Omitted/undefined = no cap (original behavior). */
    limit?: number;
    /**
     * Compute `rowCount` (a `COUNT(*)`, or backend equivalent) for each
     * entry actually returned. Default true — matches the original,
     * always-counted behavior. Bounding this to only the *returned*
     * page (via `limit`) is what keeps the count fan-out cheap; setting
     * it false skips the count fan-out entirely.
     */
    withCounts?: boolean;
}

/**
 * Row — opaque dictionary keyed by column name. Caller code typically
 * casts to a typed shape it owns.
 */
export type Row = Record<string, unknown>;

/**
 * X-allrows (2026-09-03) — opt-in for a destructive update/delete that
 * really does intend to touch every row of a table. Covers both ways a
 * filter can turn out to match every row:
 *   - ALL by CONSTRUCTION — the filter shape itself is a tautology (an
 *     empty/all filter, or one that reduces to one — see
 *     `classifyFilterScope`'s ALL case, collectionsFilterScope.ts). The
 *     storage layer's own empty-WHERE guard in sqliteTableTransaction.ts
 *     honors `all: true` here directly (round-S fix, 2026-09-04 — this
 *     used to be refused unconditionally, the one ALL-scope shape that
 *     didn't honor the flag, contradicting every guard above it that
 *     promises "pass all:true to confirm").
 *   - ALL by DATA — the filter is merely SCOPED "by construction" (see
 *     `classifyFilterScope`'s SCOPED case) but happens to match every row
 *     of THIS table's data. Only the storage layer's data-aware check
 *     (the COUNT(*)-vs-COUNT(*WHERE) comparison in
 *     sqliteTableTransaction.ts) can see this; the syntactic guard in
 *     mcp/tools/collectionsFilterScope.ts never does.
 */
export interface DestructiveWriteOptions {
    all?: boolean;
}

/**
 * One typed mutation inside an all-or-nothing table transaction.
 * The public API accepts only these closed operations — never raw SQL.
 *
 * X-allrows — `update`/`delete` ops now carry the same `all` opt-in as
 * `collection_update`/`collection_delete` (see `DestructiveWriteOptions`),
 * so a transaction op that data-dependently matches every row of a >1-row
 * table can be confirmed instead of being unconditionally refused.
 */
export type TableOp =
    | { op: 'insert'; collection: string; row: Row }
    | { op: 'update'; collection: string; filter: FilterNode; patch: Partial<Row>; all?: boolean }
    | { op: 'delete'; collection: string; filter: FilterNode; all?: boolean }
    | { op: 'upsert'; collection: string; row: Row };

export type TableOpResult =
    | { op: 'insert' | 'upsert'; collection: string; key: unknown }
    | { op: 'update' | 'delete'; collection: string; count: number };

/** Bound SQLite's single-writer lock time for one public transaction. */
export const MAX_TABLE_TX_OPS = 100;

/**
 * JoinSpec — for the optional `join` method. Inner-join only;
 * left/right/outer joins are not exposed (adapters that need them
 * compose two `query` calls + client-side merge).
 */
export interface JoinSpec {
    /** Other table to join with. */
    table: string;
    /** Join condition. Both sides reference column names by short name. */
    on: { left: string; right: string };
}

/** One hop in joinMany. `on.from`/`on.to` are unprefixed column names (assertIdent). */
export interface JoinHop {
    collection: string;
    on: { from: string; to: string };
    type: 'inner' | 'left';
}

export const MAX_JOIN_HOPS = 4;

export interface JoinQuery {
    from: string;
    join: JoinHop[];
    where?: FilterNode;
    opts?: FindOptions;
}

/**
 * ITableStorage — universal tabular surface.
 *
 * Distinct from `CollectionStorage` (which is graph-shaped). Use this when
 * the data is genuinely tabular — events, log entries, projections,
 * dictionaries.
 */
/**
 * BackendCapabilities — declarative flags so callers can ask
 * "does this backend support X?" before using exotic features
 * (architecture gap #8). Callers that want to stay portable across
 * backends should consult these and fall back appropriately
 * (e.g. compose two queries + client-side merge when `join` is false).
 *
 * Convention: every implementation MUST return all flags. New flags
 * added here must default to `false` in implementations that haven't
 * yet decided their stance — opt-in is the safe default.
 */
export interface BackendCapabilities {
    /** Inner JOINs via the optional `join()` method. */
    join: boolean;
    /** Cap for `joinMany` hops when join is supported. Omit when join is false. */
    maxJoinHops?: number;
    /** `contains` / `startsWith` filters are case-sensitive. (false
     *  on backends whose LIKE is case-insensitive by default —
     *  Postgres ILIKE, SQLite without PRAGMA case_sensitive_like.) */
    caseSensitiveContains: boolean;
    /** Extracted-and-indexed JSON inner fields (the
     *  `extractedFields` option on ColumnDecl) are honored.
     *  Backends that ignore the option set this to false. */
    extractedJsonFields: boolean;
    /** Backend supports additive schema evolution via
     *  `evolveSchema()` — typically add-column, add-index. Destructive
     *  changes (drop column, type change) need the Phase 4
     *  orchestrator either way. */
    additiveSchemaEvolution: boolean;
}

export interface ITableStorage {
    /**
     * Architecture gap #8 — what this backend supports. See
     * `BackendCapabilities` for the flag set. Callers call this once
     * at startup (or before any cross-backend-portable code path).
     */
    capabilities(): BackendCapabilities;

    /**
     * Idempotent table creation. Re-declaring with the same shape is a
     * no-op; re-declaring with a changed shape is an error (adapters
     * surface a clear migration-required message).
     */
    createTable(schema: TableSchema): Promise<void>;

    /**
     * Finding #7 — list every table this backend currently has
     * declared. Complements `createTable`: callers otherwise have no
     * way to enumerate collections without already knowing their
     * names. Returns `[]` when nothing has been declared yet — never
     * throws for "no tables".
     *
     * `opts` (finding B3, round E) adds pagination + a `withCounts`
     * opt-out for the per-table `COUNT(*)` fan-out — see
     * `ListTablesOptions`. Omitted entirely = original behavior
     * (every table, every `rowCount` populated).
     */
    listTables(opts?: ListTablesOptions): Promise<TableSchemaSummary[]>;

    /**
     * Insert a single row. Throws on primary-key collision.
     */
    insert(table: string, row: Row): Promise<void>;

    /**
     * Insert many rows in one round-trip. Adapters batch.
     */
    insertBatch(table: string, rows: Row[]): Promise<void>;

    /**
     * Read with filter, sort, limit. Filter semantics match
     * `CollectionStorage.find` (see `src/engines/collectionStorage.ts` for `Filter`).
     */
    query(table: string, filter?: FilterNode, opts?: FindOptions): Promise<Row[]>;

    /**
     * Single-row read by primary key. Returns null if absent.
     */
    getByKey<T extends Row = Row>(table: string, key: unknown): Promise<T | null>;

    /**
     * Update rows matching the filter. Patch is column-name → new value.
     * Returns the count of rows updated.
     *
     * X-allrows — `opts.all: true` confirms a data-dependent all-rows match
     * (see `DestructiveWriteOptions`). Adapters that don't implement the
     * data-aware tautology check may ignore `opts`; SqliteTableStorage
     * enforces it.
     */
    update(table: string, filter: FilterNode, patch: Partial<Row>, opts?: DestructiveWriteOptions): Promise<number>;

    /**
     * Delete rows matching the filter. Returns the count of rows deleted.
     * X-allrows — see `update`'s `opts.all` doc above.
     */
    delete(table: string, filter: FilterNode, opts?: DestructiveWriteOptions): Promise<number>;

    /**
     * Phase 2.5 — count rows matching the filter. With no filter,
     * returns the total row count for the collection. Adapters
     * should implement as a server-side count (not a client-side
     * `query().length`) so the network cost is bounded.
     */
    count(table: string, filter?: FilterNode): Promise<number>;

    /**
     * Phase 2.5 — remove ALL rows from the collection while
     * preserving the schema. Returns the number of rows deleted.
     * The SDK's `truncate` is the designated endpoint for
     * intentional full wipes; `delete(filter)` with the empty filter
     * is rejected unless the caller confirms with
     * `DestructiveWriteOptions.all: true` (round-S fix, 2026-09-04 —
     * this used to be an unconditional refusal with no `all: true`
     * escape hatch, unlike every other ALL-scope filter shape).
     */
    truncate(table: string): Promise<number>;

    /**
     * Apply several typed mutations atomically. Either every operation commits
     * in order or the backend leaves every touched table unchanged.
     */
    runTransaction(ops: TableOp[]): Promise<TableOpResult[]>;

    /**
     * Optional inner-join. Adapters that don't implement it throw a
     * clear "join not supported on this adapter" error. Caller code
     * that needs cross-adapter portability should fall back to two
     * `query` calls + client-side merge.
     */
    join?(
        leftTable: string,
        join: JoinSpec,
        filter?: FilterNode,
        opts?: FindOptions,
    ): Promise<Row[]>;

    /**
     * Multi-hop join (1..MAX_JOIN_HOPS). Adapters without join throw or omit this.
     */
    joinMany?(query: JoinQuery): Promise<Row[]>;

    /**
     * Architecture gap #11 — additive schema evolution. Apply a new
     * TableSchema to an existing table. Only additive changes are
     * permitted at this layer:
     *
     *   - Adding a new column → ALTER TABLE ADD COLUMN
     *   - Adding a new index on an existing column → CREATE INDEX
     *   - Adding extractedFields to a json column → new sidecar columns
     *
     * Destructive changes (drop column, change column type, change
     * primary key) MUST go through the Phase 4 expand→migrate→contract
     * orchestrator — they need data migration, rollback snapshots,
     * and operator approval that this method deliberately doesn't
     * provide. evolveSchema rejects them with a clear error pointing
     * at the orchestrator.
     *
     * Returns a list of the operations applied so callers can log
     * what changed (or assert in tests).
     *
     * Backends without `additiveSchemaEvolution` capability throw
     * "schema evolution not supported on this adapter".
     */
    evolveSchema?(name: string, newSchema: TableSchema): Promise<EvolutionStep[]>;
}

/** One mutation applied by `evolveSchema`. Returned so callers can
 *  log the change set or audit it. */
export interface EvolutionStep {
    kind: 'add_column' | 'add_index' | 'add_extracted_field';
    column: string;
    /** For add_extracted_field: the inner-field key. */
    extractedKey?: string;
}
