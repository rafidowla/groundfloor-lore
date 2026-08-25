/**
 * Purpose: Core type definitions matching the Groundfloor Data Plane and Rust Engine models.
 * Inputs: N/A.
 * Outputs: N/A.
 * Error Behavior: Strict compile-time typing.
 * Side Effects: None.
 * State Contract: Interfaces only.
 * Determinism & Idempotency: Deterministic schema.
 * Concurrency Considerations: Thread-safe schemas.
 * Performance Notes: Zero execution overhead.
 * Observability Expectations: N/A.
 */
export interface FieldSchema {
    name: string;
    field_type: string;
    required?: boolean;
    indexed?: boolean;
    unique?: boolean;
    primary_key?: boolean;
    /** Field-level encryption opt-in. When true the engine encrypts this column
     *  before storage and decrypts on read. Matches engine `FieldSchemaRequest.encrypted`. */
    encrypted?: boolean;
    /** Default value for the field. The engine deserializes this as a string
     *  (`FieldSchemaRequest.default: Option<String>`); non-string values are
     *  serialized to JSON on the wire. */
    default?: unknown;
    /** Human-readable field description. Matches engine `FieldSchemaRequest.description`. */
    description?: string;
}
export interface IndexSchema {
    name: string;
    fields: string[];
    unique?: boolean;
}
export interface CollectionSchema {
    name?: string;
    fields: FieldSchema[];
    indexes?: IndexSchema[];
    description?: string;
    /** Opt this collection into Change Data Capture. When true, committed
     *  create/update/delete writes are appended to the changelog and exposed via
     *  `client.changeFeed(collection)`. Matches engine `CreateCollectionRequest.cdc`. */
    cdc?: boolean;
    /**
     * @deprecated The engine's `CreateCollectionRequest` does NOT read this field,
     * so it is silently dropped on `createCollection`. Configure connector-specific
     * options (e.g. Redpanda partitions/retention) via `PUT /v1/schema/:collection/config`
     * instead. Kept here only so existing callers still compile.
     */
    metadata?: Record<string, string>;
}
export interface RecordData {
    id?: string;
    [key: string]: any;
}
/**
 * A record returned from `client.search(...)`.
 *
 * Intersects the caller's domain type `T` with an optional `_score: number`
 * field that connectors advertising `RankedFullTextSearch` (e.g. ArangoDB's
 * BM25 via `gf_text_en` analyzer + `AppDocumentsSearch` view) populate per
 * record.
 *
 * Connectors that only support the substring `FullTextSearch` capability
 * (e.g. Postgres today) return records WITHOUT a `_score` field — hence
 * `number | undefined`.  Callers doing hybrid retrieval should:
 *   1. Introspect the connector capability via `client.listConnectors()` /
 *      `GET /connectors` before assuming scores are present.
 *   2. Treat `_score === undefined` as "this backend does not rank — fall
 *      back to semantic-only or another retrieval signal."
 *
 * The leading underscore mirrors the dataplane's wire convention: `_score`,
 * like `_id` / `_key`, is server-derived metadata distinct from user fields.
 */
export type SearchableRecord<T = RecordData> = T & {
    _score?: number;
};
export interface QueryResult<T = RecordData> {
    records: T[];
    total_count?: number;
    has_more?: boolean;
}
export interface SqlExecutionResult {
    columns: string[];
    rows: Record<string, any>[];
    row_count: number;
    execution_time_ms: number;
    has_more: boolean;
}
export interface QueryOptions {
    filter?: object;
    sort?: Array<{
        field: string;
        direction: "asc" | "desc";
    }>;
    limit?: number;
    offset?: number;
    projection?: string[];
    distinct?: boolean;
}
export interface BulkInsertResult {
    inserted: number;
    ids: string[];
    total_requested: number;
}
export interface CountResult {
    count: number;
    collection: string;
}
export interface UpdateByQueryResult {
    updated: number;
    collection: string;
}
export interface DeleteByQueryResult {
    deleted: number;
    collection: string;
}
export interface TruncateResult {
    truncated: boolean;
    deleted: number;
    collection: string;
}
export interface AuthErrorResponse {
    error: string;
    message?: string;
}
export type TransactionOp = {
    op: "create";
    collection: string;
    fields: Record<string, unknown>;
    as?: string;
} | {
    op: "update";
    collection: string;
    filter: object;
    fields: Record<string, unknown>;
} | {
    op: "delete";
    collection: string;
    filter: object;
} | {
    op: "bulk_create";
    collection: string;
    records: Record<string, unknown>[];
    as?: string;
};
export interface TransactionOpResult {
    op_index: number;
    collection: string;
    id?: string;
    ids?: string[];
    alias?: string;
    matched?: number;
    modified?: number;
    deleted?: number;
}
export interface TransactionResult {
    results: TransactionOpResult[];
    committed: boolean;
    duration_ms: number;
}
export interface TransactionOptions {
    connection?: string;
    idempotencyKey?: string;
}
/**
 * One connector registered in the engine, with its advertised capabilities.
 * Matches engine `ConnectorInfo` (GET /connectors). Use `capabilities` to gate
 * features such as ranked full-text search (`_score`) before relying on them.
 */
export interface ConnectorInfo {
    name: string;
    version: string;
    /** Capability tokens, e.g. "RankedFullTextSearch", "Graph", "VectorSearch". */
    capabilities: string[];
}
/** Response of `GET /connectors`. */
export interface ConnectorsResult {
    connectors: ConnectorInfo[];
}
/**
 * One committed change read from a CDC-enabled collection's durable change-feed.
 * Matches the engine `change_feed_handler` wire shape (change_feed.rs).
 */
export interface ChangeFeedEvent {
    /** Operation kind: "create" | "update" | "delete" (engine-defined string). */
    op: string;
    /** Record id the change applies to. */
    id: string;
    /** After-image of the record. Null/absent for deletes. */
    after?: Record<string, any> | null;
    /** RFC3339 commit timestamp. */
    ts: string;
    /** Opaque per-row cursor; pass the page's `next_cursor` to resume. */
    cursor: string;
}
/**
 * A page of change-feed events plus the cursor to resume from.
 */
export interface ChangeFeedResult {
    collection: string;
    changes: ChangeFeedEvent[];
    /** Opaque cursor to pass on the next poll to continue after this page. */
    next_cursor: string;
    /** True iff the page filled to `limit` (more immediately available). */
    has_more: boolean;
}
/**
 * Current cursor positions for a CDC-enabled collection's change-feed.
 * Matches the engine `change_feed_cursor_handler` wire shape.
 */
export interface ChangeFeedCursorResult {
    collection: string;
    /** Cursor positioned after the latest logged change ("start from now"). */
    head_cursor: string;
    /** Cursor positioned before the earliest retained change ("full replay"). */
    oldest_cursor: string;
    /** Number of changes currently retained. */
    retained_changes: number;
}
/** Options for `changeFeed()`. */
export interface ChangeFeedOptions {
    /** Opaque resume cursor from a prior page's `next_cursor`. Omit to replay from earliest retained. */
    cursor?: string;
    /** Page size; engine default applies when omitted, capped server-side. */
    limit?: number;
    /** Optional connector name for multi-database routing. */
    connection?: string;
    /** Pass "head" to start at the tail (only honoured when `cursor` is omitted). */
    from?: "head";
}
/**
 * One historical version of a deployed authz schema.
 */
export interface AuthzSchemaHistoryEntry {
    version: number;
    deployed_at: string;
    deployed_by?: string | null;
}
/**
 * Active authz schema for a (tenant, app) pair with full version history.
 */
export interface AuthzSchemaResult {
    tenant: string;
    app: string;
    active_version: number;
    active_since: string;
    yaml: string;
    history: AuthzSchemaHistoryEntry[];
}
/**
 * Result of `applyAuthzSchema`. In normal mode contains version + safety
 * check fields; in `dryRun` mode also includes a `compiled_zed_preview`
 * with the YAML compiled to SpiceDB Zed schema text.
 */
export interface AuthzSchemaDeployResult {
    tenant: string;
    app: string;
    version?: number;
    deployed_at?: string;
    compatible: boolean;
    breaking_changes: string[];
    dry_run?: boolean;
    compiled_zed_preview?: string;
}
