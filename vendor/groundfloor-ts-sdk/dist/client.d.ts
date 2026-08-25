import type { CollectionSchema, QueryOptions, QueryResult, RecordData, SearchableRecord, SqlExecutionResult, BulkInsertResult, UpdateByQueryResult, DeleteByQueryResult, TruncateResult, TransactionOp, TransactionOptions, TransactionResult, AuthzSchemaDeployResult, AuthzSchemaResult, ChangeFeedResult, ChangeFeedCursorResult, ChangeFeedOptions, ConnectorInfo } from "./types";
import { VectorClient } from "./advanced/vector";
import { GraphClient } from "./advanced/graph";
import { AnalyticsClient } from "./advanced/analytics";
import { TelemetryClient } from "./telemetry";
import { Subscription, SubscribeOptions } from "./subscription";
import { QueryBuilder } from "./query_builder";
/**
 * Purpose: Main asynchronous client for the Groundfloor Data Plane. Manages HTTP connection configuration and acts as a unified router to standard CRUD and Advanced database extensions.
 * Inputs: None (class boundary).
 * Outputs: GroundfloorClient instance. Stable contract.
 * Error Behavior: Instantiating without required parameters throws an Error.
 * Side Effects: None.
 * State Contract: Reads initialization params. In-place object configuration.
 * Determinism & Idempotency: Deterministic.
 * Concurrency Considerations: Thread-safe instance representation.
 * Performance Notes: Lightweight instantiation.
 * Observability Expectations: Errors on invalid parameters are unlogged externally but explicitly thrown internally.
 */
/**
 * Optional transport / reliability configuration for {@link GroundfloorClient}.
 * All fields are optional; secure, conservative defaults are applied when omitted.
 */
export interface GroundfloorClientOptions {
    /** Per-request timeout in milliseconds before the request is aborted. Default 30000. */
    timeoutMs?: number;
    /** Number of retry attempts for transient failures (network errors, 429, 5xx).
     *  Total attempts = retries + 1. Default 2 (i.e. up to 3 attempts). */
    retries?: number;
    /** Base backoff in milliseconds for retry attempts; doubled each retry with jitter. Default 200. */
    retryBackoffMs?: number;
    /** Cap on the backoff delay between retries, in milliseconds. Default 5000. */
    retryMaxBackoffMs?: number;
    /** Browser WebSocket auth strategy for `subscribe()`. The current engine only
     *  reads the `Authorization` header, which browsers cannot set on a WS handshake.
     *  - "error" (default): fail loudly in the browser instead of silently opening an
     *    unauthenticated socket.
     *  - "query": append the token as a `?access_token=` query param (only safe behind a
     *    gateway/proxy that translates it into the Authorization header).
     *  - "subprotocol": send the token via the `Sec-WebSocket-Protocol` header
     *    (`bearer.<token>`) for the same proxy-translation use case. */
    browserWsAuth?: "error" | "query" | "subprotocol";
    /** Optional structured logger for transport observability (request/retry/error).
     *  Receives a stable event shape; defaults to no-op (silent). */
    logger?: (event: GroundfloorLogEvent) => void;
    /** Gate the raw-SQL/AQL channel (`executeRaw`/`executeSql`). Defaults to
     *  `false`: the raw-query endpoint is retired on current engines and returns
     *  `410 RAW_QUERY_DISABLED` for ALL credentials (tenant *and* platform), so
     *  the SDK throws locally before issuing a doomed request. Setting this `true`
     *  only un-gates the SDK-side guard; the live call will still surface the
     *  engine's `410`. Use the structured `query`/`get`/`count` methods or the
     *  `/authz` API instead. */
    enableRawQueries?: boolean;
}
/** Structured transport observability event emitted via {@link GroundfloorClientOptions.logger}. */
export interface GroundfloorLogEvent {
    level: "debug" | "info" | "warn" | "error";
    msg: string;
    method?: string;
    path?: string;
    status?: number;
    attempt?: number;
    durationMs?: number;
    err?: string;
}
export declare class GroundfloorClient {
    private baseUrl;
    private apiKey;
    private readonly timeoutMs;
    private readonly retries;
    private readonly retryBackoffMs;
    private readonly retryMaxBackoffMs;
    private readonly browserWsAuth;
    private readonly logger?;
    private readonly enableRawQueries;
    vector: VectorClient;
    graph: GraphClient;
    analytics: AnalyticsClient;
    telemetry: TelemetryClient;
    /**
     * Purpose: Initializes the Groundfloor Client.
     * Inputs:
     * - baseUrl (string): Required. The base URL of the Groundfloor Engine.
     * - apiKey (string): Required. The secret API Key for Zero-Trust Authentication.
     * Outputs: A configured GroundfloorClient and initialized sub-clients.
     * Error Behavior: Throws Error if baseUrl or apiKey is empty.
     * Side Effects: Initializes advanced sub-clients (Vector, Graph, Analytics, Telemetry).
     * State Contract: Writes baseUrl, apiKey, and extension clients to the object instance.
     * Determinism & Idempotency: Deterministic, Idempotent.
     * Concurrency Considerations: Thread-safe in isolated contexts. No external locking.
     * Performance Notes: Non-blocking, instant execution.
     * Observability Expectations: No active logging during instantiation.
     */
    constructor(baseUrl: string, apiKey: string, options?: GroundfloorClientOptions);
    private log;
    /**
     * Purpose: Internal unified network router that adds authorization headers and seamlessly manages core JSON parsing logic.
     * Inputs:
     * - path (string): The URL endpoint path. Required.
     * - options (RequestInit): Optional HTTP Request overriding parameters.
     * Outputs: A parsed Promise<T> representing the response payload.
     * Error Behavior:
     * - Throws GroundfloorAuthError natively on 401 or 403 API responses.
     * - Throws GroundfloorError unconditionally on other HTTP failure states.
     * - TS-3: Throws GroundfloorError when HTTP 200 body carries {success:false,error}
     *   (engine-side connector failures that don't surface as non-2xx HTTP status).
     * Side Effects: Makes a network call to the Groundfloor Rust Engine HTTP layer.
     * State Contract: Reads API key. Mutates no internal state.
     * Determinism & Idempotency: Nondeterministic execution dependent on Engine networking. Not inherently idempotent.
     * Concurrency Considerations: Thread-safe runtime. Dependent on underlying async Node.js / browser environment APIs.
     * Performance Notes: Blocking async HTTP task with potential environment/network latency.
     * Observability Expectations: No built-in logging. Bubbles up error metrics clearly through standard Exceptions.
     */
    protected fetch<T>(path: string, options?: RequestInit): Promise<T>;
    /** Exponential backoff with full jitter, capped at retryMaxBackoffMs. */
    private backoffDelay;
    /** Build a GroundfloorError from a non-2xx response, preferring the engine's
     *  structured `error` field and avoiding verbatim dumps of unknown payloads
     *  (which could leak engine internals into client logs). */
    private toError;
    /**
     * Purpose: Creates a new collection defined by a JSON schema.
     * Inputs:
     * - tenantId (string): Multi-tenant isolation boundary identifier. Required.
     * - schema (CollectionSchema): Blueprint to generate table constraints, variables, and columns. Required.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Resulting CollectionSchema object confirmed by the engine. Stable contract.
     * Error Behavior: Bubbles up Network/Auth errors directly.
     * Side Effects: Makes a POST request to external system, mutating the remote Data Plane.
     * State Contract: Unmodified internal state.
     * Determinism & Idempotency: Idempotent dependent on remote database Engine behavior.
     * Concurrency Considerations: Safe.
     * Performance Notes: External DB API latency on DDL action.
     * Observability Expectations: Handled via underlying DB observability and external tracking.
     */
    createCollection(schema: CollectionSchema, connection?: string): Promise<CollectionSchema>;
    /**
     * Purpose: Retrieves explicit metadata of an isolated collection schema for verification logic.
     * Inputs:
     * - tenantId (string): Active Multi-tenant boundary constraint target. Required.
     * - collection (string): Name identifier for an existing engine collection. Required.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Promise resolving to the CollectionSchema structure.
     * Error Behavior: Throws GroundfloorError on missing collection references.
     * Side Effects: External Read-Only HTTP operation.
     * State Contract: Internal unmodified state handling.
     * Determinism & Idempotency: Deterministic operation on stable table schemas. Idempotent logic.
     * Concurrency Considerations: Non-interfering. Safe for parallel runtime loops.
     * Performance Notes: High speed meta-data fetch relying on engine caching mechanisms.
     * Observability Expectations: Unlogged in user context.
     */
    getCollectionSchema(collection: string, connection?: string): Promise<CollectionSchema>;
    /**
     * Purpose: Unrecoverably deletes a specified data table environment mapping.
     * Inputs:
     * - tenantId (string): Active isolation segment. Required.
     * - collection (string): Target schema logic wrapper to remove. Required.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Promise revealing dropped true/false Boolean identifier wrapping JSON logic.
     * Error Behavior: Throws GroundfloorError upon schema dependency conflicts.
     * Side Effects: Permanent network state removal call execution.
     * State Contract: Internal unmodified mapping. Remote DB mutation triggered.
     * Determinism & Idempotency: Idempotent - subsequent calls on removed objects raise equivalent handled errors.
     * Concurrency Considerations: Dangerous for parallel access tasks acting concurrently across table resources.
     * Performance Notes: Heavy DDL action inducing external wait time.
     * Observability Expectations: No local footprint recording executed drop event.
     */
    dropCollection(collection: string, connection?: string): Promise<{
        dropped: boolean;
    }>;
    /**
     * Purpose: Mutates array sets mapping structural document instances to the persistent Rust database target.
     * Inputs:
     * - tenantId (string): RLS Tenant ID defining insert boundaries. Required.
     * - collection (string): Parent Collection grouping target identifier. Required.
     * - records (T[]): Contiguous logic block representation grouping fields. Required.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Generic Array representation mapping original objects with assigned persistent UUIDs.
     * Error Behavior: Bubbles HTTP 4xx conflicts representing bad formatting.
     * Side Effects: Network state IO. Persists unchangeable target representations if append-only tables are configured.
     * State Contract: Remote Engine persistence modification parameters. Unchanged Class boundary logic.
     * Determinism & Idempotency: Nondeterministic - re-invocations on default generated id objects will issue multiple discrete documents.
     * Concurrency Considerations: Parallel safety guaranteed dynamically via Rust Data Plane layer control.
     * Performance Notes: Blocking IO dependent heavily on bulk size logic array bounds target.
     * Observability Expectations: Standard. Unlogged unless proxy mapped.
     */
    insert<T = RecordData>(collection: string, record: T, connection?: string): Promise<T>;
    /**
     * Purpose: Retries targeted logic matching row-level unique identifier elements dynamically.
     * Inputs:
     * - tenantId (string): Required constraint isolation block.
     * - collection (string): Table context boundary map. Required.
     * - id (string): Valid targeted system-managed unique identifier. Required.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Structured Payload generic map. Promise based.
     * Error Behavior: Explicit HTTP errors directly on non-existence parameters matching logic.
     * Side Effects: Remote retrieval execution wrapper. None localized.
     * State Contract: Unmodified wrapper. Reads only.
     * Determinism & Idempotency: Deterministic fetch pattern matching UUID consistency. Idempotent network IO.
     * Concurrency Considerations: Fully parallel non-disruptive logic execution boundaries setup.
     * Performance Notes: Light blocking dependency lookup logic IO. Sub-10ms lookup expected against proper engine mappings.
     * Observability Expectations: Empty. Metrics collected server side implicitly.
     */
    get<T = RecordData>(collection: string, id: string, connection?: string): Promise<T>;
    /**
     * Purpose: Generates remote multi-conditional extraction of unstructured logical sets matching dynamically provided queries.
     * Inputs:
     * - tenantId (string): Constrained block identity format. Required.
     * - collection (string): Search environment boundary. Required.
     * - options (QueryOptions): Formatted object wrapping limit mappings, filter payloads, offsets and desc/asc sorts.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Wraps standard payload with has_more bools and total logic numbers.
     * Error Behavior: Exceptions directly mapped against invalid JSON query string definitions.
     * Side Effects: Executable HTTP read actions targeting database boundaries sequentially.
     * State Contract: Standard read logic variables sent over network logic streams. Local memory completely unmarked.
     * Determinism & Idempotency: Dependent deterministically on dataset stability boundaries. Fully idempotent.
     * Concurrency Considerations: Executed gracefully within async non-blocking JavaScript patterns.
     * Performance Notes: Time sensitive to table volumes mapping indexed logic ranges. Memory scaling bound by payload returns.
     * Observability Expectations: Missing local metrics on scan ranges dynamically generated. Unlogged.
     */
    query<T = RecordData>(collection: string, options?: QueryOptions, connection?: string): Promise<QueryResult<T>>;
    /**
     * Purpose: Submits granular structural permutations across documents matching multi-condition map boundaries.
     * Inputs:
     * - tenantId (string): Isolation layer tenant structure. Required.
     * - collection (string): Name targeting constraint logic sets. Required.
     * - filter (object): Targeted condition logic array boundary defining documents valid for change. Required.
     * - updates (Partial<T>): Object containing replacement parameters replacing original schema mapped values. Required.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Numeric validation response determining row modifications executed dynamically.
     * Error Behavior: Errors thrown against missing object types map configurations or engine logical issues.
     * Side Effects: DB-level values irrevocably overwritten causing underlying logical database event chain updates.
     * State Contract: Modifies persistent object remote state in-place representations heavily.
     * Determinism & Idempotency: Re-executing triggers matching overrides consistently rendering logical idempotency.
     * Concurrency Considerations: Lock bounds managed via Rust Zookeeper implementations. Safe at SDK boundary layer mappings.
     * Performance Notes: Filter scanning maps affect runtime speed heavily. Uses indexed mapping to prevent degraded returns.
     * Observability Expectations: Not instrumented inline locally.
     * ClickHouse Note: Updates run as async ALTER mutations — a successful response means the
     *   update was accepted, not that it is visible. Rows may continue to return previous values
     *   for seconds to minutes. See docs/CLICKHOUSE_QDRANT_DEEP_DIVE.md §1.3.
     */
    update<T = RecordData>(collection: string, filter: object, updates: Partial<T>, connection?: string): Promise<{
        updated: number;
    }>;
    /**
     * Purpose: Enforces permanent memory drop configurations mapping document states matching condition sets.
     * Inputs:
     * - tenantId (string): Mandatory tenant target structure definition string mapping to database bounds.
     * - collection (string): Root table collection context environment mapping logic sets defining target documents. Required.
     * - filter (object): Query logic representation wrapper defining targets strictly for destruction.
     * - connection (string): Optional connection parameter for multi-tenant database routing.
     * Outputs: Promise capturing an object structure wrapping total documents removed accurately.
     * Error Behavior: Fails on invalid connection blocks or invalid query formats.
     * Side Effects: Persistent objects mapped within database storage destroyed without possible reversion recovery logic boundaries.
     * State Contract: Persistent state mutated negatively within external bounds tracking sets.
     * Determinism & Idempotency: Standard Idempotent logical mapping execution block. Second call hits 0 targets dropped reliably.
     * Concurrency Considerations: Engine managed blocking deletion mapping states. Safe for general application runtime.
     * Performance Notes: Heavy remote operation mapping against index scans triggering volume sensitive blocking delays.
     * Observability Expectations: Handled server side natively. No local wrapper generation blocks setup for metrics capture.
     * ClickHouse Note: Deletes run as async ALTER mutations — a successful response means the
     *   delete was accepted, not that the row is gone. Rows may remain visible for seconds to
     *   minutes; disk reclamation runs during background merges. See docs/CLICKHOUSE_QDRANT_DEEP_DIVE.md §1.3.
     */
    delete(collection: string, filter: object, connection?: string): Promise<{
        deleted: number;
    }>;
    /**
     * Purpose: Update a single record by its ID.
     * Inputs:
     * - collection (string): Target collection. Required.
     * - id (string): Record ID. Required.
     * - fields (Partial<T>): Fields to update. Required.
     * - connection (string): Optional connection parameter for multi-connector routing.
     * Outputs: Promise resolving to the updated record.
     */
    updateById<T = RecordData>(collection: string, id: string, fields: Partial<T>, connection?: string): Promise<T>;
    /**
     * Purpose: Delete a single record by its ID.
     * Inputs:
     * - collection (string): Target collection. Required.
     * - id (string): Record ID. Required.
     * - connection (string): Optional connection parameter for multi-connector routing.
     * Outputs: Promise resolving to the deletion result.
     */
    deleteById(collection: string, id: string, connection?: string): Promise<{
        deleted: number;
    }>;
    /**
     * Purpose: (RETIRED) Historically executed a raw native query (SQL / AQL)
     *   against a tenant's database connector. The `/v1/sql/execute` endpoint is
     *   now disabled on all current engines and responds `410 RAW_QUERY_DISABLED`
     *   for EVERY credential — tenant and platform alike. This method is retained
     *   only for source-compatibility; prefer the structured query surface.
     * Inputs:
     * - query (string): Raw query string. Required to be non-empty (validated locally).
     * - options.limit (number): Sent as `limit` if the endpoint were live. Default 500.
     * - options.timeout (number): Sent as `timeout` (seconds) if live. Default 15.
     * - options.params (unknown[] | Record): IGNORED by current engines — the
     *   endpoint never reaches a connector. Kept in the signature for source
     *   compatibility only; do NOT rely on bound-parameter substitution here.
     * - connection (string): Optional connector name for multi-database routing.
     * Outputs: Promise<SqlExecutionResult> — unreachable on current engines.
     * Error Behavior: Throws locally when `enableRawQueries` is false (the default)
     *   or the query is empty; otherwise the live call surfaces `410 RAW_QUERY_DISABLED`.
     * Side Effects: None on current engines (request rejected before connector dispatch).
     * State Contract: N/A.
     * Determinism & Idempotency: N/A (endpoint retired).
     * Concurrency Considerations: Thread-safe — stateless HTTP call.
     * Performance Notes: Single round-trip that the engine rejects with 410.
     * Observability Expectations: 410 surfaces as a GroundfloorError(statusCode=410).
     */
    /**
     * @deprecated Retired on current engines. The dataplane returns
     * `410 RAW_QUERY_DISABLED` for the `/v1/sql/execute` route regardless of
     * credential class (tenant *or* platform/operator) because raw queries
     * bypass row-level authorization (`gf_permissions` projection +
     * connector RLS) and break tenant isolation.
     *
     * Use the structured CRUD methods (`query`, `get`, `count`) and the
     * `/authz` API methods (`checkPermission`, `grantRelation`,
     * `applyAuthzSchema`) for customer requests — those paths automatically
     * enforce `rebac_enrich_middleware` and only return rows the caller is
     * permitted to see.
     */
    executeRaw(query: string, options?: {
        limit?: number;
        timeout?: number;
        params?: unknown[] | Record<string, unknown>;
    }, connection?: string): Promise<SqlExecutionResult>;
    /** Default row cap applied to `executeRaw` when the caller omits `limit`. */
    private static readonly RAW_DEFAULT_LIMIT;
    /** Default execution timeout (seconds) sent in the `executeRaw` body when omitted. */
    private static readonly RAW_DEFAULT_TIMEOUT_S;
    /**
     * @deprecated Use `executeRaw` instead. `executeSql` will be removed in a future major version.
     */
    executeSql(query: string, options?: {
        limit?: number;
        timeout?: number;
    }, connection?: string): Promise<SqlExecutionResult>;
    /**
     * Deploy a `gf_authz.yaml` schema for a tenant + app.
     *
     * The engine compiles the YAML to SpiceDB Zed, runs a migration
     * safety check against the previously deployed version, and (unless
     * `dryRun`) writes the new schema and bumps the version number.
     *
     * Returns `version`, `deployedAt`, `compatible`, `breakingChanges`.
     * In `dryRun` mode also includes `compiledZedPreview`.
     *
     * Throws on `409 SCHEMA_MIGRATION_UNSAFE` when the migration would
     * introduce breaking changes and `force` is false.
     */
    applyAuthzSchema(yaml: string, options?: {
        app?: string;
        force?: boolean;
        dryRun?: boolean;
    }): Promise<AuthzSchemaDeployResult>;
    /**
     * Fetch the active schema for `(tenant, app)` with version history.
     * Throws `404 SCHEMA_NOT_FOUND` if no schema has been deployed.
     */
    getAuthzSchema(app: string): Promise<AuthzSchemaResult>;
    /**
     * Check whether `subject` has `permission` on `resource`. Returns
     * `true` if the permission is granted, `false` otherwise.
     *
     * Tenant prefixing is handled engine-side — pass plain ids.
     */
    checkPermission(params: {
        subjectType: string;
        subjectId: string;
        permission: string;
        resourceType: string;
        resourceId: string;
    }): Promise<boolean>;
    /**
     * Grant `subject` the `relation` on `resource` (e.g. make Alice an
     * `owner` of `chunks/abc-123`). Both ids are prefixed with the tenant
     * before being written to SpiceDB so cross-tenant collisions are
     * impossible.
     */
    grantRelation(params: {
        resourceType: string;
        resourceId: string;
        relation: string;
        subjectType: string;
        subjectId: string;
    }): Promise<{
        granted: boolean;
    }>;
    /**
     * Revoke `subject`'s `relation` on `resource`. Inverse of grantRelation.
     */
    revokeRelation(params: {
        resourceType: string;
        resourceId: string;
        relation: string;
        subjectType: string;
        subjectId: string;
    }): Promise<{
        revoked: boolean;
    }>;
    /**
     * Purpose: Insert multiple records in a single HTTP call.
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - collection (string): Target collection name. Required.
     * - records (RecordData[]): Array of record objects to insert. Must be non-empty.
     * - connection (string): Optional connector name for multi-database routing.
     * Outputs: Promise<BulkInsertResult> with inserted count, ids, and total_requested.
     * Error Behavior: Throws Error if records is empty. Throws GroundfloorError on server rejection.
     * Side Effects: Persists records in the remote database.
     * State Contract: Remote write.
     * Determinism & Idempotency: Non-deterministic — each call creates new records with new IDs.
     * Concurrency Considerations: Thread-safe.
     * Performance Notes: Single round-trip for N records.
     * Observability Expectations: Standard.
     */
    bulkInsert(collection: string, records: RecordData[], connection?: string): Promise<BulkInsertResult>;
    /**
     * Purpose: Execute a batch of write operations atomically in a single DB transaction.
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - operations (TransactionOp[]): List of ops (create/update/delete/bulk_create). Non-empty.
     * - options (TransactionOptions): Optional { connection, idempotencyKey }.
     * Outputs: Promise<TransactionResult> with per-op results, committed flag, duration_ms.
     * Error Behavior: Throws Error if operations empty. Throws GroundfloorError on server
     *   rejection (400 validation, 501 unsupported connector, 409 op-level failure, 500 internal).
     *   Transaction rolls back on any failure — no partial state persists.
     * Side Effects: Writes multiple records atomically across collections.
     * State Contract: All ops in a single DB transaction.
     * Determinism & Idempotency: Non-deterministic without idempotencyKey.
     *   With idempotencyKey, retries within 24h with the same key return the cached
     *   response without re-running. Concurrent retries return 409 IN_FLIGHT.
     *   Max 128 chars, scoped per tenant. See docs/IDEMPOTENCY_KEY_REFERENCE.md.
     * Concurrency Considerations: Thread-safe. Concurrent overlapping writes may conflict
     *   and return TRANSACTION_CONFLICT; caller may retry.
     * Performance Notes: Single HTTP call + single DB transaction. Max 100 ops per request.
     * Observability Expectations: Standard.
     *
     * @example
     * // Tenant is taken from the authenticated credential — no tenant argument.
     * const result = await client.transaction([
     *   { op: "create", collection: "workspaces", fields: { name: "Acme" }, as: "ws" },
     *   { op: "create", collection: "memberships",
     *     fields: { workspace_id: "$ws.id", role: "owner" } },
     * ], { connection: "arangodb" });
     * console.log(result.results[0].id);  // generated workspace id
     */
    transaction(operations: TransactionOp[], options?: TransactionOptions): Promise<TransactionResult>;
    /**
     * Purpose: Full-text search across configured text fields in a collection.
     *   Returns substring matches on `FullTextSearch`-capable backends and
     *   BM25-ranked results on `RankedFullTextSearch`-capable backends.
     * Inputs:
     * - collection (string): Collection to search.
     * - query (string): Search term.
     * - opts (optional): { fields, limit, connection }.
     * Outputs: `Promise<SearchableRecord<T>[]>` — each record is `T` plus an
     *   optional `_score: number` field present iff the underlying connector
     *   advertises `RankedFullTextSearch`.  Use `client.listConnectors()` to
     *   introspect capabilities before relying on `_score`.
     * Error Behavior: Throws GroundfloorError on server-side failures.
     * Side Effects: Read-only.
     * State Contract: Read-only.
     * Determinism & Idempotency: Deterministic for a given snapshot. Idempotent.
     * Concurrency Considerations: Thread-safe.
     * Performance Notes:
     *   - Postgres today: substring `Filter::Contains` on the configured fields.
     *   - ArangoDB today: native ArangoSearch view + `gf_text_en` analyzer
     *     + `SORT BM25(doc) DESC`.  `_score` populated on every record.
     * Observability Expectations: Standard.
     *
     * @example Substring search (any backend)
     *   const hits = await client.search<{ name: string }>(
     *     "products", "sword",
     *     { fields: ["name", "description"], limit: 25 },
     *   );
     *
     * @example Ranked search (Arango / other RankedFullTextSearch backend)
     *   const hits = await client.search<{ name: string }>(
     *     "documents", "machine learning",
     *   );
     *   // hits is sorted DESC by _score; combine with vector similarity
     *   // for hybrid retrieval re-ranking.
     *   for (const hit of hits) {
     *     console.log(hit.name, hit._score ?? "(no scoring on this backend)");
     *   }
     */
    search<T = RecordData>(collection: string, query: string, opts?: {
        fields?: string[];
        limit?: number;
        connection?: string;
    }): Promise<SearchableRecord<T>[]>;
    /**
     * List the connectors registered in the engine along with their advertised
     * capabilities (e.g. `RankedFullTextSearch`, `Graph`, `VectorSearch`). Use
     * this to gate capability-dependent behavior — for example, whether
     * `search()` results carry a `_score` — before relying on it.
     *
     * Idempotent GET to `/connectors`.
     */
    listConnectors(): Promise<ConnectorInfo[]>;
    /**
     * Purpose: Open a fluent query builder chain for a collection (v3.2 Block 3).
     *   Pure client-side sugar on top of `query()`.
     * Inputs: tenantId, collection.
     * Outputs: QueryBuilder instance; call `.fetch()` to execute.
     * Example:
     *   const users = await client.from("acme", "users")
     *     .where("email", "=", "x@y.com")
     *     .limit(5)
     *     .fetch();
     */
    from<T extends RecordData = RecordData>(collection: string): QueryBuilder<T>;
    /**
     * Purpose: Open a WebSocket subscription to real-time create/update/delete
     *   events on a collection (v3.2 Block 2 Live Subscribe).
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - options (SubscribeOptions): collection, optional filter/events/onEvent/onError.
     * Outputs: Subscription handle; call `.close()` to terminate.
     * Error Behavior: onError(err, retryable) for reconnectable failures; terminal
     *   auth failures halt the subscription.
     * Side Effects: Opens a long-lived WebSocket with auto-reconnect.
     * State Contract: Each call opens one socket = one subscription. Multiplexing
     *   deferred to Phase 2.
     * Determinism & Idempotency: Not deterministic (real-time stream). On
     *   reconnect, events may be re-delivered; consumer dedup by id is the
     *   app's responsibility.
     * Concurrency Considerations: Many subscriptions in parallel are fine.
     * Performance Notes: Server evaluates filter server-side and drops non-matches
     *   before sending.
     * Observability Expectations: Errors go through onError; there's no separate
     *   log channel in the SDK.
     *
     * @example
     * // Tenant is taken from the authenticated credential — no tenant argument.
     * const sub = client.subscribe({
     *   collection: "combat_events",
     *   filter: { type: "field", field: "player_id", operator: "eq", value: "p1" },
     *   onEvent: (ev) => console.log(ev.kind, ev.record),
     * });
     * // later: await sub.close();
     */
    subscribe(options: SubscribeOptions): Subscription;
    /**
     * Purpose: Return the count of records in a collection, optionally filtered.
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - collection (string): Collection name. Required.
     * - filter (object): Optional filter expression.
     * - connection (string): Optional connector name.
     * Outputs: Promise<number> — integer count of matching records.
     * Error Behavior: Throws GroundfloorError on server errors.
     * Side Effects: None — read-only.
     * State Contract: Read-only.
     * Determinism & Idempotency: Deterministic for a given snapshot. Idempotent.
     * Concurrency Considerations: Thread-safe.
     * Performance Notes: Lightweight — no record data transferred.
     * Observability Expectations: Standard.
     */
    count(collection: string, filter?: object, connection?: string): Promise<number>;
    /**
     * Purpose: Update all records matching a filter condition.
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - collection (string): Collection name. Required.
     * - filter (object): Required filter expression targeting records to update.
     * - fields (object): Key-value pairs to set on all matching records. Required.
     * - connection (string): Optional connector name.
     * Outputs: Promise<UpdateByQueryResult> with updated count.
     * Error Behavior: Throws GroundfloorError if filter or fields are invalid.
     * Side Effects: Modifies matching records in the database.
     * State Contract: Remote write.
     * Determinism & Idempotency: Idempotent if updates are absolute values.
     * Concurrency Considerations: Thread-safe.
     * Performance Notes: Depends on number of matching records.
     * Observability Expectations: Standard.
     */
    updateByQuery(collection: string, filter: object, fields: object, connection?: string): Promise<UpdateByQueryResult>;
    /**
     * Purpose: Delete all records matching a filter condition.
     *   Safety guard: Filter::All is rejected by the server. Use truncate() instead.
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - collection (string): Collection name. Required.
     * - filter (object): Required filter expression. Cannot be "all".
     * - connection (string): Optional connector name.
     * Outputs: Promise<DeleteByQueryResult> with deleted count.
     * Error Behavior: Throws GroundfloorError if filter is "all" or invalid.
     * Side Effects: Permanently removes matching records.
     * State Contract: Remote write (destructive).
     * Determinism & Idempotency: Idempotent — second call deletes 0.
     * Concurrency Considerations: Thread-safe.
     * Performance Notes: Depends on matching record count.
     * Observability Expectations: Standard.
     */
    deleteByQuery(collection: string, filter: object, connection?: string): Promise<DeleteByQueryResult>;
    /**
     * Purpose: Remove all records from a collection while preserving its schema.
     *   This is the designated endpoint for intentional full wipes.
     * Inputs:
     * - tenantId (string): Target tenant identifier. Required.
     * - collection (string): Collection name. Required.
     * - connection (string): Optional connector name.
     * Outputs: Promise<TruncateResult> with truncated flag and deleted count.
     * Error Behavior: Throws GroundfloorError on server errors.
     * Side Effects: Permanently removes ALL records. Schema preserved.
     * State Contract: Remote write (destructive).
     * Determinism & Idempotency: Idempotent — second call truncates 0 records.
     * Concurrency Considerations: Thread-safe.
     * Performance Notes: O(N) where N is the number of records.
     * Observability Expectations: Standard.
     */
    truncate(collection: string, connection?: string): Promise<TruncateResult>;
    /**
     * Poll the durable change-feed for committed create/update/delete events on a
     * CDC-enabled collection, ordered oldest-first, at-least-once.
     *
     * Pass the prior page's `next_cursor` as `opts.cursor` to resume; omit it to
     * replay from the earliest retained change, or pass `from: "head"` to start at
     * the tail ("from now"). `limit` is capped server-side.
     *
     * Errors: throws on a non-CDC collection (400 CDC_NOT_ENABLED), a malformed
     * cursor (400), or a cursor older than the retained window (410 CURSOR_EXPIRED).
     */
    changeFeed(collection: string, opts?: ChangeFeedOptions): Promise<ChangeFeedResult>;
    /**
     * Return the current cursor positions for a CDC-enabled collection's
     * change-feed: `head_cursor` (resume "from now"), `oldest_cursor` (full
     * replay), and `retained_changes`. Use `head_cursor` to start a consumer
     * without replaying history.
     */
    changeFeedCursor(collection: string, connection?: string): Promise<ChangeFeedCursorResult>;
    /** Mint a presigned PUT URL the client can use to upload bytes direct
     *  to the configured S3-compatible backend. */
    storageUploadUrl(bucket: string, key: string, opts?: {
        expiresInSeconds?: number;
        connection?: string;
    }): Promise<{
        url: string;
        method: "PUT";
        expires_in_seconds: number;
    }>;
    /** Mint a presigned GET URL for direct-from-backend download. */
    storageDownloadUrl(bucket: string, key: string, opts?: {
        expiresInSeconds?: number;
        connection?: string;
    }): Promise<{
        url: string;
        method: "GET";
        expires_in_seconds: number;
    }>;
    /** Encode an object key for safe interpolation into a URL path. Object keys
     *  legitimately contain `/` (logical delimiters), spaces, `?`, `#`, `%`, etc.
     *  `encodeURIComponent` would escape `/` too, so we split on `/`, encode each
     *  segment, and rejoin — preserving the key's logical hierarchy while
     *  neutralizing query/fragment/path-injection characters. */
    private encodeStorageKey;
    /** Delete an object server-side. No bytes through the dataplane. */
    storageDeleteObject(bucket: string, key: string): Promise<{
        ok: boolean;
    }>;
    /** Server-side copy (S3 CopyObject). No bytes through the dataplane. */
    storageCopyObject(bucket: string, sourceKey: string, destinationKey: string, opts?: {
        connection?: string;
    }): Promise<{
        ok: boolean;
    }>;
    /** Existence probe for a stored object.
     *
     *  A HTTP `HEAD` response carries NO body, so the SDK cannot return
     *  `size`/`etag`/`content_type` from it — that metadata lives only in the
     *  response *headers*, which `fetch()` does not currently surface. (Honest
     *  header-based metadata would require threading `Response` headers up through
     *  the transport; out of scope here.) This method therefore reports only
     *  whether the object exists:
     *  - 2xx  → `{ exists: true }`
     *  - 404  → `{ exists: false }`
     *  - other errors propagate. */
    storageHeadObject(bucket: string, key: string): Promise<{
        exists: boolean;
    }>;
    /** Convenience: mint a presigned URL and actually upload Blob /
     *  ArrayBuffer bytes in one call. Bytes flow direct to the backend,
     *  not through the dataplane. */
    storageUploadBlob(bucket: string, key: string, body: Blob | ArrayBuffer | Uint8Array, opts?: {
        contentType?: string;
        expiresInSeconds?: number;
        connection?: string;
    }): Promise<{
        key: string;
        etag?: string;
    }>;
    /** Start a multipart upload. Returns { upload_id, key }. */
    storageCreateMultipart(bucket: string, key: string, opts?: {
        connection?: string;
    }): Promise<{
        upload_id: string;
        key: string;
    }>;
    /** Mint a presigned PUT URL for one part. `partNumber` is 1-based. */
    storagePartUrl(bucket: string, key: string, uploadId: string, partNumber: number, opts?: {
        expiresInSeconds?: number;
        connection?: string;
    }): Promise<{
        url: string;
        method: "PUT";
        part_number: number;
        expires_in_seconds: number;
    }>;
    /** Finalize a multipart upload. `parts[].etag` must be the verbatim
     *  ETag header from the per-part PUT response (quotes included). */
    storageCompleteMultipart(bucket: string, key: string, uploadId: string, parts: Array<{
        part_number: number;
        etag: string;
    }>, opts?: {
        connection?: string;
    }): Promise<{
        ok: boolean;
    }>;
    /** Discard an in-flight multipart upload. */
    storageAbortMultipart(bucket: string, key: string, uploadId: string, opts?: {
        connection?: string;
    }): Promise<{
        ok: boolean;
    }>;
    /** Convenience: full multipart dance for a Blob/ArrayBuffer/Uint8Array.
     *
     *  Default `partSize` is 8 MiB — above the S3 5 MiB-per-part minimum
     *  (which applies to every part except the last). Aborts on exception.
     */
    storageMultipartUploadBlob(bucket: string, key: string, body: Blob | ArrayBuffer | Uint8Array, opts?: {
        partSize?: number;
        contentType?: string;
        expiresInSeconds?: number;
        connection?: string;
    }): Promise<{
        key: string;
        upload_id: string;
        parts: number;
    }>;
}
