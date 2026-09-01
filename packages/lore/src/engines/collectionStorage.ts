/** collectionStorage.ts — Substrate-portable storage primitives (Filter, FindOptions, CollectionStorage, etc.). Moved from plugins/storage.ts in v3.11.0. */

/**
 * Filter — substrate-portable WHERE clause.
 *
 * All keys are AND-combined. Within each operator, all key/value pairs
 * are also AND-combined. Empty filter `{}` matches everything.
 *
 * Field names are plain (no `n.` or table prefix) — the storage adapter
 * adds substrate-specific qualification.
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
    /**
     * Index signature — allows typed operator-keyed assignment without `as any`.
     * The concrete operators above are the canonical set; this slot lets
     * buildEdgeWhere/remapFilter iterate over them programmatically.
     * Value type matches the widest operator bag (Record<string, unknown>).
     */
    [op: string]: Record<string, unknown> | undefined;
}

/** Max parenthesized and/or/not depth for FilterNode. Deeper throws filter_too_nested. */
export const MAX_FILTER_NESTING = 8;

/**
 * Nested boolean WHERE tree. Leaves are the existing conjunctive `Filter`.
 * Do not put `and`/`or`/`not` inside a leaf Filter bag — that collides with `eq`.
 */
export type FilterNode =
    | Filter
    | { and: FilterNode[] }
    | { or: FilterNode[] }
    | { not: FilterNode };

export function isFilterAnd(node: FilterNode): node is { and: FilterNode[] } {
    return typeof node === 'object' && node !== null && Array.isArray((node as { and?: unknown }).and);
}

export function isFilterOr(node: FilterNode): node is { or: FilterNode[] } {
    return typeof node === 'object' && node !== null && Array.isArray((node as { or?: unknown }).or);
}

export function isFilterNot(node: FilterNode): node is { not: FilterNode } {
    const candidate = node as { not?: unknown };
    return typeof node === 'object' && node !== null && 'not' in node && candidate.not !== undefined
        && !Array.isArray(candidate.not);
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
 * EdgeRow — one row returned by `traverse`. Callers generally cast
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
 * EdgeShapeHint — tells the Kùzu adapter the source/target node labels
 * for an edge collection. Cloud adapter ignores it. New code should use
 * `declareCollection` at boot instead.
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
 * CollectionStorage — substrate-portable storage interface for collections
 * that don't map to core LoreNode/LoreEdge tables.
 */
export interface CollectionStorage {
    /** Substrate identifier — 'kuzu' for local, 'dataplane' for cloud. */
    readonly mode: 'kuzu' | 'dataplane';

    /** Register a collection for automatic name/key resolution. Idempotent. */
    declareCollection(decl: CollectionDecl): void;

    /** Idempotent insert-or-update by primary key field. */
    upsert<T extends Record<string, unknown>>(
        coll: string,
        keyField: string,
        doc: T,
    ): Promise<void>;

    /** Single-row read by primary key. Returns null when absent. */
    get<T = Record<string, unknown>>(
        coll: string,
        keyField: string,
        key: unknown,
    ): Promise<T | null>;

    /** Multi-row read with filter. */
    find<T = Record<string, unknown>>(
        coll: string,
        filter: Filter,
        opts?: FindOptions,
    ): Promise<T[]>;

    /** Row count. Empty filter counts everything. */
    count(coll: string, filter?: Filter): Promise<number>;

    /** Bulk delete by filter. Returns rows-deleted count. */
    deleteWhere(coll: string, filter: Filter): Promise<number>;

    /** Insert an edge row (always inserts). */
    addEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props?: Record<string, unknown>,
        hint?: EdgeShapeHint,
    ): Promise<void>;

    /** Idempotent edge write — inserts or updates. */
    upsertEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props?: Record<string, unknown>,
        hint?: EdgeShapeHint,
    ): Promise<void>;

    /** Edge traversal from a single anchor node id. */
    traverse<TProps = Record<string, unknown>>(
        coll: string,
        anchorId: string,
        dir: 'in' | 'out' | 'both',
        opts?: TraverseOptions,
        hint?: EdgeShapeHint,
    ): Promise<EdgeRow<TProps>[]>;

    /** Bulk edge delete by filter on edge properties. */
    deleteEdgesWhere(
        coll: string,
        filter: Filter,
        hint?: EdgeShapeHint,
    ): Promise<number>;

    /** Edge row count. */
    countEdges(
        coll: string,
        filter?: Filter,
        hint?: EdgeShapeHint,
    ): Promise<number>;
}

/**
 * NodeCollectionDecl — declarative metadata for a node collection.
 * After registration, storage ops resolve substrate-specific names
 * and primary-key fields automatically.
 */
export interface NodeCollectionDecl {
    kind: 'node';
    /** Canonical name used in storage ops. */
    name: string;
    /** Primary key field name. Defaults to "id". */
    primaryKey?: string;
    /** Kùzu NODE TABLE label. Defaults to `name`. */
    kuzuTable?: string;
    /** Cloud collection name. Defaults to `name`. */
    cloudCollection?: string;
}

/**
 * EdgeCollectionDecl — declarative metadata for an edge collection.
 * `source` and `target` reference previously-declared node collections
 * by canonical `name`.
 */
export interface EdgeCollectionDecl {
    kind: 'edge';
    /** Canonical name used in storage edge ops. */
    name: string;
    /** Canonical name of the node collection on the source side. */
    source: string;
    /** Canonical name of the node collection on the target side. */
    target: string;
    /** Kùzu REL TABLE label. Defaults to `name`. */
    kuzuTable?: string;
    /** Cloud collection name. Defaults to `name`. */
    cloudCollection?: string;
}

/** Discriminated union for `declareCollection`. */
export type CollectionDecl = NodeCollectionDecl | EdgeCollectionDecl;
