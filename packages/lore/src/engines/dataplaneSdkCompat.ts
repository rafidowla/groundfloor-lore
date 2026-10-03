/**
 * Bridge Lore's tenant-first Dataplane calls onto the current
 * groundfloor-ts-sdk (collection-first CRUD; the Dataplane workspace is fixed
 * by the API credential).
 *
 * The SDK dropped `tenantId` from insert/query/updateByQuery/count/
 * createCollection paths (`/v1/{collection}`). Lore adapters still
 * pass tenant first. Calling the live client with that arity sent the
 * tenant as the collection name and 404'd ("not found").
 *
 * Vector + graph extensions still use `/v1/{tenant}/{collection}/...`.
 */

/** `POST /v1/transaction` operations (engine dsl/types.rs:306 `BatchOp`; the SDK's `TransactionOp`). */
export type TransactionOp =
    | { op: 'create'; collection: string; fields: Record<string, unknown>; as?: string }
    | { op: 'update'; collection: string; filter: object; fields: Record<string, unknown> }
    | { op: 'delete'; collection: string; filter: object }
    | { op: 'bulk_create'; collection: string; records: Array<Record<string, unknown>>; as?: string };

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

export interface TransactionResult { results: TransactionOpResult[]; committed: boolean; duration_ms: number }

export interface TransactionOptions { connection?: string; idempotencyKey?: string }

/** Minimal SDK surface the wrapper forwards to. */
export interface CollectionFirstSdk {
    createCollection(schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(collection: string, record: T, connection?: string): Promise<T>;
    get<T = unknown>(collection: string, id: string, connection?: string): Promise<T>;
    query<T = unknown>(collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(collection: string, filter?: object, connection?: string): Promise<number>;
    /** Collection metadata (declared fields). Used only for the F8 schema-drift report. */
    getCollectionSchema?(collection: string, connection?: string): Promise<unknown>;
    /** `POST /v1/:collection/bulk`. The engine ignores a caller `id` here (so Lore does NOT use it for D2-keyed rows; it stays only for passthrough callers). */
    bulkInsert?(collection: string, records: Array<Record<string, unknown>>, connection?: string): Promise<unknown>;
    /** Keyword (BM25 / substring) search. Newer SDK builds only; `_score` is set iff the connector ranks. */
    search?<T = unknown>(collection: string, query: string, opts?: SearchOpts): Promise<Array<T & { _score?: number }>>;
    /** `POST /v1/transaction`: every op commits or none does. Present only in newer SDK builds. */
    transaction?(operations: TransactionOp[], options?: TransactionOptions): Promise<TransactionResult>;
    vector?: unknown;
    graph?: unknown;
}

/** Options accepted by the SDK's keyword `search` (the engine takes NO filter on this route). */
export interface SearchOpts { fields?: string[]; limit?: number; connection?: string }

export interface TenantFirstSdk {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    getCollectionSchema?(tenantId: string, collection: string, connection?: string): Promise<unknown>;
    /** Present only when the underlying SDK build has `bulkInsert`. Not used by Lore's D2-keyed stores (the engine ignores a caller `id`). */
    bulkInsert?(tenantId: string, collection: string, records: Array<Record<string, unknown>>, connection?: string): Promise<unknown>;
    /** Collection-first like the SDK: keyword search has never carried a tenant argument. */
    search?<T = unknown>(collection: string, query: string, opts?: SearchOpts): Promise<Array<T & { _score?: number }>>;
    /** Tenant-first like the rest of the façade (the tenant is discarded). Absent when the SDK build has no `transaction`. */
    transaction?(tenantId: string, operations: TransactionOp[], options?: TransactionOptions): Promise<TransactionResult>;
    vector?: unknown;
    graph?: unknown;
}

type ClientCtor = new (baseUrl: string, apiKey: string) => CollectionFirstSdk;

/**
 * Lore-shaped (tenant-first) façade over the live SDK.
 *
 * No `X-Tenant-Id` header is injected (cloud parity C item 11, D9). The engine ignores it —
 * the Dataplane workspace is fixed by the API credential (F2) — and a Lore workspace is an
 * application tenant carried in the `lore_workspace` column, never a Dataplane routing input.
 * Forging a header from the Lore workspace implied a boundary that does not exist.
 *
 * Follow-up outside this repo: groundfloor-ts-sdk `cac19a4` (no tenant header / tenant-less
 * paths) must be merged to its main and a JS build published; until then Lore calls whatever
 * build is installed, and the fail-safe is unchanged (every row is scope-filtered and
 * re-checked client-side).
 */
export function createLoreDataplaneSdk(
    Ctor: ClientCtor,
    baseUrl: string,
    apiKey: string,
): TenantFirstSdk {
    return asLoreDataplaneSdk(new Ctor(baseUrl, apiKey));
}

/** Adapt tenant-first Lore call sites onto a collection-first SDK instance. */
export function asLoreDataplaneSdk(raw: CollectionFirstSdk): TenantFirstSdk {
    return {
        createCollection: (_tenantId, schema, connection) => raw.createCollection(schema, connection),
        insert: (_tenantId, collection, record, connection) => raw.insert(collection, record, connection),
        get: (_tenantId, collection, id, connection) => raw.get(collection, id, connection),
        query: (_tenantId, collection, options, connection) => raw.query(collection, options, connection),
        updateByQuery: (_tenantId, collection, filter, fields, connection) =>
            raw.updateByQuery(collection, filter, fields, connection),
        deleteByQuery: (_tenantId, collection, filter, connection) =>
            raw.deleteByQuery(collection, filter, connection),
        count: (_tenantId, collection, filter, connection) => raw.count(collection, filter, connection),
        getCollectionSchema: async (_tenantId, collection, connection) => {
            if (typeof raw.getCollectionSchema !== 'function') throw new Error('groundfloor-ts-sdk build has no getCollectionSchema()');
            return raw.getCollectionSchema(collection, connection);
        },
        ...(typeof raw.bulkInsert === 'function'
            ? { bulkInsert: (_tenantId: string, collection: string, records: Array<Record<string, unknown>>, connection?: string) => raw.bulkInsert!(collection, records, connection) }
            : {}),
        // Only forwarded when the SDK build has it: a missing method is how the transaction
        // runner learns "no transactions here" without sending anything.
        ...(typeof raw.transaction === 'function'
            ? { transaction: (_tenantId: string, operations: TransactionOp[], options?: TransactionOptions) => raw.transaction!(operations, options) }
            : {}),
        // Forwarded (cloud parity A2 item 1): previously dropped, so every keyword search
        // failed and recall silently fell back to meaning-only. NOTE the engine's /search
        // takes no filter; DataplaneVectorStore.bm25Search enforces scope client-side.
        search: async <T = unknown>(collection: string, query: string, opts?: SearchOpts) => {
            if (typeof raw.search !== 'function') {
                throw new Error('groundfloor-ts-sdk build has no keyword search() — keyword search unavailable');
            }
            return raw.search<T>(collection, query, opts);
        },
        vector: raw.vector,
        graph: raw.graph,
    };
}
