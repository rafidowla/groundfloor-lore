/**
 * storage.ts — Q2.2 slice 5a. Substrate-portable plugin storage primitives.
 *
 * Plugins write business logic against this small interface and never
 * touch Cypher, AQL, or the Dataplane SDK directly. Core provides two
 * implementations:
 *
 *   - KuzuPluginStorage    — translates `Filter` to Cypher (local mode)
 *   - DataplanePluginStorage — translates `Filter` to SDK calls (cloud mode)
 *
 * Wired up via `PluginGraphContext.storage` (set in createPluginGraphContext
 * on each engine). Plugin code is identical in both modes; the substrate
 * binding is decided at daemon boot per LORE_DEPLOYMENT_MODE.
 *
 * SLICE BOUNDARY (5a): this slice ships the interface + both adapters +
 * tests. Plugins are not migrated yet — existing developer-plugin code
 * keeps using PluginGraphContext.executeQuery/queryRows in local mode and
 * still throws in cloud mode (slice 4 stub error). Slice 5b cuts the
 * developer plugin over; slice 5c unifies schema declaration so edge
 * source/target labels become implicit instead of per-call hints.
 *
 * DESIGN CONSTRAINTS:
 *
 *   - No nested filters / no logical operators (AND/OR/NOT). Each filter
 *     key is conjunction-only ("AND across all clauses"). If a plugin
 *     needs disjunction, it makes two calls and merges client-side. The
 *     constraint keeps Cypher and SDK translations straightforward and
 *     forces plugins toward shapes that perform well across substrates.
 *
 *   - No joins / no cross-collection traversal in a single call. To walk
 *     from a plugin row to a `lore_node`, plugins store `lore_node_id` as
 *     a field and do two `find` calls. Saves us a substrate-translation
 *     headache and matches how a sane plugin author would write the code
 *     anyway.
 *
 *   - No aggregations beyond `count` in v1. SUM / AVG / GROUP BY would
 *     need substrate-specific handling (Kùzu's collect/aggregate vs
 *     Dataplane's analytical projection). Banking plugin's aggregation
 *     needs are handled in JS over `find` results for now; revisit if
 *     row volume forces it.
 */

/**
 * Filter — substrate-portable WHERE clause.
 *
 * All keys are AND-combined. Within each operator, all key/value pairs
 * are also AND-combined. Empty filter `{}` matches everything.
 *
 * Field names are plain (no `n.` or table prefix) — the storage adapter
 * adds substrate-specific qualification.
 *
 * Examples:
 *   { eq: { type: 'note', project: 'lore' } }
 *     // type = 'note' AND project = 'lore'
 *
 *   { contains: { label: 'auth' }, gt: { createdAt: '2026-01-01' } }
 *     // label CONTAINS 'auth' AND createdAt > '2026-01-01'
 *
 *   { in: { kind: ['function', 'method'] } }
 *     // kind IN ['function', 'method']
 */
export interface Filter {
    /** Exact equality. Multiple keys → AND. */
    eq?: Record<string, unknown>;
    /** Case-sensitive substring match. */
    contains?: Record<string, string>;
    /** Case-sensitive prefix match. */
    startsWith?: Record<string, string>;
    /** Strictly greater than. Use ISO strings for date/time fields. */
    gt?: Record<string, unknown>;
    /** Greater than or equal. */
    gte?: Record<string, unknown>;
    /** Strictly less than. */
    lt?: Record<string, unknown>;
    /** Less than or equal. */
    lte?: Record<string, unknown>;
    /** Set membership. */
    in?: Record<string, unknown[]>;
}

export interface FindOptions {
    /** Hard cap on row count returned. Adapters apply at the query level. */
    limit?: number;
    /** Field to order by (must be indexed for cloud-mode performance). */
    orderBy?: string;
    /** Order direction; defaults to 'asc'. */
    orderDir?: 'asc' | 'desc';
}

export interface TraverseOptions {
    /** Filter on edge-row properties (NOT the connected node's fields). */
    filter?: Filter;
    /** Hard cap on edge-row count returned. */
    limit?: number;
}

/**
 * EdgeRow — one row returned by `traverse`. Plugins generally cast
 * edgeProps to a typed shape they declared at schema time.
 */
export interface EdgeRow<TProps = Record<string, unknown>> {
    /** Edge property bag. Empty object if the edge has no properties. */
    edgeProps: TProps;
    /** Node id at the source side of the edge. */
    sourceId: string;
    /** Node id at the target side of the edge. */
    targetId: string;
}

/**
 * EdgeShapeHint — slice-5a transitional. Tells the Kùzu adapter the
 * source/target node labels for an edge collection (Cypher MATCH on a
 * REL needs the labels). Cloud adapter ignores this — its edge
 * collections carry source_id/target_id as plain string columns.
 *
 * Will be removed in slice 5c when `declareCollection` makes labels
 * implicit.
 *
 * Asymmetric idFields: developer-plugin edges connect tables whose
 * primary keys differ (e.g. FileContains links CodeFile.path → CodeSymbol.uid).
 * `srcIdField` / `tgtIdField` are the per-side overrides; if a side is
 * absent, the adapter falls back to `idField`, then to "id".
 */
export interface EdgeShapeHint {
    /** Kùzu node-table label of the source side. */
    srcLabel?: string;
    /** Kùzu node-table label of the target side. */
    tgtLabel?: string;
    /** Default id field for both sides (defaults to "id"). */
    idField?: string;
    /** Source-side id field; overrides `idField` for the source. */
    srcIdField?: string;
    /** Target-side id field; overrides `idField` for the target. */
    tgtIdField?: string;
}

/**
 * PluginStorage — the only storage surface a plugin author needs to
 * learn. ~10 methods, no substrate vocabulary, identical behavior in
 * local and cloud modes.
 *
 * All methods accept a fully-qualified collection name (e.g.
 * `developer_code_symbol`, `brain_todo`). The plugin owns its
 * collections; cross-plugin reads/writes go through the plugin's
 * exposed `api` field, never through PluginStorage.
 *
 * Errors:
 *   - Unknown collection → adapter-specific error string. Plugins should
 *     declareCollection (slice 5c) at boot to avoid this.
 *   - Filter referencing an unknown field → adapter-specific. Local mode
 *     usually returns 0 rows; cloud mode returns an error. Plugins
 *     should keep filters aligned with their declared schema.
 *   - Storage tier offline → throws; same retry semantics as the
 *     underlying engine (per-tenant init drop + retry on the next call
 *     in cloud mode).
 */
export interface PluginStorage {
    /**
     * Substrate flag — `'kuzu'` for the local KuzuPluginStorage adapter,
     * `'dataplane'` for the cloud DataplanePluginStorage adapter.
     *
     * Plugin code is substrate-portable, but a few callsites legitimately
     * need to know the mode — chiefly to translate between Kùzu PascalCase
     * table names (e.g. `CodeSymbol`) and the snake_case cloud collection
     * names (e.g. `developer_code_symbol`). Plugins should branch on this
     * sparingly; the long-term direction is `declareCollection` (slice 5c)
     * making the substrate-name remap implicit.
     */
    readonly mode: 'kuzu' | 'dataplane';

    /* ─── Node ops ───────────────────────────────────────────────── */

    /**
     * Idempotent insert-or-update by primary key.
     *
     * `keyField` names the column that holds the primary key. The doc
     * MUST include this field with a non-empty value.
     *
     * Behavior:
     *   - Local: Cypher `MERGE (n:coll {keyField: $key}) SET n.* = $doc`
     *   - Cloud: `updateByQuery` filtered on keyField → `insert` if 0 matched
     */
    upsert<T extends Record<string, unknown>>(
        coll: string,
        keyField: string,
        doc: T,
    ): Promise<void>;

    /**
     * Single-row read by primary key.
     *
     * Returns null if the row does not exist (NOT throws). Used for
     * "does this exist?" checks where the row may legitimately be
     * absent.
     */
    get<T = Record<string, unknown>>(
        coll: string,
        keyField: string,
        key: unknown,
    ): Promise<T | null>;

    /**
     * Multi-row read with filter.
     *
     * Empty filter `{}` returns all rows up to `opts.limit`. No `opts`
     * → no limit (be careful in cloud mode; row counts can be high).
     */
    find<T = Record<string, unknown>>(
        coll: string,
        filter: Filter,
        opts?: FindOptions,
    ): Promise<T[]>;

    /**
     * Row count. Empty filter counts everything.
     *
     * Cheaper than `find().length` because the adapter pushes the
     * count down to the substrate (Kùzu's count() / Dataplane's count).
     */
    count(coll: string, filter?: Filter): Promise<number>;

    /**
     * Bulk delete by filter. Returns rows-deleted count.
     *
     * NOTE on Kùzu: deleting nodes that participate in edges requires
     * `DETACH DELETE`. The KuzuPluginStorage adapter uses DETACH so
     * plugins don't need to clean up edges separately. (Cloud mode
     * doesn't have this distinction — edge collections are independent.)
     */
    deleteWhere(coll: string, filter: Filter): Promise<number>;

    /* ─── Edge ops ───────────────────────────────────────────────── */

    /**
     * Insert an edge row. Always inserts (does not check for existing).
     * Use `upsertEdge` for idempotent edge writes.
     *
     * The `hint` parameter (slice 5a only) tells the Kùzu adapter the
     * source/target node labels. Cloud adapter ignores it. Removed in
     * slice 5c when schema declaration makes labels implicit.
     */
    addEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props?: Record<string, unknown>,
        hint?: EdgeShapeHint,
    ): Promise<void>;

    /**
     * Idempotent edge write — inserts if no edge between the same
     * (sourceId, targetId) exists, otherwise updates the props.
     *
     * Local: Cypher MERGE on the edge.
     * Cloud: updateByQuery filtered on (source_id, target_id), insert if 0.
     */
    upsertEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props?: Record<string, unknown>,
        hint?: EdgeShapeHint,
    ): Promise<void>;

    /**
     * Edge traversal from a single anchor node id.
     *
     * `dir`:
     *   - 'out'  → edges where sourceId = anchor (this anchor → others)
     *   - 'in'   → edges where targetId = anchor (others → this anchor)
     *   - 'both' → either direction (no Cypher equivalent — the cloud
     *              adapter does two queries and unions; the Kùzu
     *              adapter uses bidirectional MATCH)
     *
     * Filter applies to edge properties only. To filter the connected
     * node, do a `find` on its collection in a follow-up call.
     */
    traverse<TProps = Record<string, unknown>>(
        coll: string,
        anchorId: string,
        dir: 'in' | 'out' | 'both',
        opts?: TraverseOptions,
        hint?: EdgeShapeHint,
    ): Promise<EdgeRow<TProps>[]>;

    /**
     * Bulk edge delete by filter on edge properties (or source/target
     * id, which are valid filter keys).
     */
    deleteEdgesWhere(
        coll: string,
        filter: Filter,
        hint?: EdgeShapeHint,
    ): Promise<number>;

    /**
     * Edge row count (slice 5b addition). Mirrors `count` for nodes —
     * needed because `find` doesn't traverse edge tables and plugins still
     * want raw "how many edges of this kind exist" stats (e.g. graph
     * stats, telemetry payloads). Filter applies to edge properties (or
     * `sourceId` / `targetId` as keyset shorthand the adapter remaps).
     *
     * Empty filter counts every edge in the collection.
     */
    countEdges(
        coll: string,
        filter?: Filter,
        hint?: EdgeShapeHint,
    ): Promise<number>;
}
