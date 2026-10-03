/**
 * mock-dataplane-client.ts — a fetch-based, collection-first client for the
 * mock Dataplane (test/helpers/mock-dataplane.ts), shaped like the Lore-facing
 * tenant-first SDK surface the adapters consume (`TenantFirstSdk` + `vector`,
 * `graph`, `search`).
 *
 * Why it exists: the real groundfloor-ts-sdk ships no JavaScript in this repo
 * (types only), so tests that want the ADAPTERS to run against the MOCK's real
 * HTTP semantics (engine filter grammar, 409s, credential-fixed workspace) need
 * a client. Like the live client it:
 *   - sends `Authorization: Bearer <apiKey>` (the workspace is fixed by it);
 *   - deliberately sends NO `X-Tenant-Id` — the engine ignores it;
 *   - unwraps `ApiResponse` envelopes tolerantly (raw or `{success,data}`) on
 *     every call EXCEPT `get`, which returns the raw JSON exactly like the real
 *     SDK (`src/client.ts` `get` -> `fetch<T>` returns `response.json()` as is).
 *     The engine answers GET with the `ApiResponse` envelope and a MISSING record
 *     is HTTP 200 + `{success:false, error:{code:'ERR_NOT_FOUND'}}`, so callers
 *     must unwrap and must not expect a throw on not-found;
 *   - throws ONLY when the HTTP status is not ok (like the SDK's `fetch`), as a
 *     `GroundfloorError`-shaped Error: message = the engine's `error.message` (else
 *     `error.code`, else "HTTP <status>"), `statusCode` = the HTTP status. NOTHING ELSE:
 *     the real GroundfloorError (groundfloor-ts-sdk exceptions.ts) has no `code`, no
 *     `status` and no body, so a caller that classifies on `err.code` (e.g. an
 *     `IN_FLIGHT` check) only passes against a mock that invents the field (review C #5);
 *   - forwards `connection` EXACTLY where the real SDK puts it (client.ts): in the JSON
 *     BODY for createCollection / insert / query / updateByQuery / deleteByQuery / count /
 *     bulkInsert / search / vector.search / graph.*, and in the QUERY STRING (`?connection=`)
 *     for get / getCollectionSchema / transaction (review C #1);
 *   - `transaction()` returns `result.data ?? result` (client.ts :916), so an engine that
 *     answers with something else (an old engine's single-record create) hands the caller
 *     that body unchanged (review C #4).
 * The first positional argument (the historical tenantId) is accepted and
 * discarded, exactly like `asLoreDataplaneSdk`.
 */

type Rec = Record<string, unknown>;

/** The real SDK's GroundfloorError: `message` and `statusCode`, nothing else. */
export interface MockSdkError extends Error {
    statusCode: number;
}

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown, rawEnvelope = false, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    const env = json as Rec | null;
    // The real SDK throws only on a non-2xx status. A 200 `{success:false}` envelope
    // (engine GET not-found, graph traverse errors) is RETURNED, not thrown. The
    // other calls here keep throwing on it for the historical tests; `get` is the
    // faithful one (rawEnvelope).
    if (!res.ok || (!rawEnvelope && env && env['success'] === false)) {
        // client.ts toError: error string, else error.message, else String(error.code), else
        // "HTTP <status> <text>"; a 200 success:false throws with the HTTP status.
        const raw = env?.['error'];
        const err = (raw && typeof raw === 'object' ? raw : {}) as Rec;
        const msg = typeof raw === 'string' ? raw
            : typeof err['message'] === 'string' && err['message'] ? err['message']
            : err['code'] ? String(err['code'])
            : `HTTP ${res.status} ${res.statusText}`.trim();
        const e = new Error(msg) as MockSdkError;
        e.name = 'GroundfloorError';
        e.statusCode = res.status;
        // 3.x SDK (client.ts TS-3): a 200 `{success:false}` body keeps the symbolic code on `engineCode`.
        if (res.ok && typeof err['code'] === 'string' && err['code'] !== '') (e as MockSdkError & { engineCode?: string }).engineCode = err['code'];
        throw e;
    }
    return json;
}

/** Unwrap `{success:true,data}` when present; otherwise return as-is. */
function unwrap<T>(json: unknown): T {
    const env = json as Rec | null;
    if (env && typeof env === 'object' && 'success' in env && 'data' in env) return env['data'] as T;
    return json as T;
}

const enc = encodeURIComponent;
/** `?connection=<name>` exactly like the SDK (empty when no connection). */
const qs = (connection?: string): string => (connection ? `?connection=${enc(connection)}` : '');
/** Body-level connection exactly like the SDK (`if (connection) payload.connection = connection`). */
const withConn = <T extends object>(payload: T, connection?: string): T & { connection?: string } =>
    connection ? { ...payload, connection } : payload;

export interface MockDataplaneSdk {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    getCollectionSchema(tenantId: string, collection: string, connection?: string): Promise<unknown>;
    bulkInsert(tenantId: string, collection: string, records: Array<Record<string, unknown>>, connection?: string): Promise<unknown>;
    search<T = unknown>(collection: string, query: string, opts?: { fields?: string[]; limit?: number; connection?: string }): Promise<Array<T & { _score?: number }>>;
    /** `POST /v1/transaction` (SDK: `transaction(operations, {connection, idempotencyKey})`, tenant arg dropped). Throws with `statusCode`/`code` on a non-2xx. */
    transaction(tenantId: string, operations: unknown[], options?: { connection?: string; idempotencyKey?: string }): Promise<{ results: Array<Record<string, unknown>>; committed: boolean; duration_ms: number }>;
    vector: {
        search<T = unknown>(tenantId: string, collection: string, options: { vector: number[]; limit?: number; filter?: object; connection?: string }): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    };
    graph: {
        createEdge(tenantId: string, collection: string, options: { fromId: string; toId: string; edgeCollection: string; properties?: Record<string, unknown>; connection?: string }): Promise<{ edge_id: string }>;
        traverse<T = unknown>(tenantId: string, collection: string, options: { startId: string; edgeCollection?: string; edgeCollections?: string[]; direction?: 'in' | 'out' | 'both'; minDepth?: number; maxDepth?: number; connection?: string }): Promise<{ records: T[] }>;
    };
}

/**
 * `sdk` picks which real client build to imitate for `get`: '1.x' (default; main, returns the raw
 * envelope, a miss is a RESPONSE) or '3.x' (v3-enterprise-scale: a 200 `{success:false}` THROWS a
 * GroundfloorError with the symbolic code on `engineCode`, and a success is unwrapped to `data`).
 */
export function createMockDataplaneClient(baseUrl: string, apiKey: string, opts: { sdk?: '1.x' | '3.x' } = {}): MockDataplaneSdk {
    const c = (method: string, path: string, body?: unknown) => call(baseUrl, apiKey, method, path, body);
    return {
        createCollection: async (_t, schema, conn) => unwrap(await c('POST', '/v1/schema', withConn(schema as object, conn))),
        insert: async (_t, coll, record, conn) => unwrap(await c('POST', `/v1/${enc(coll)}`, withConn(record as object, conn))),
        get: async (_t, coll, id, conn) => {
            if (opts.sdk === '3.x') {
                const r = (await call(baseUrl, apiKey, 'GET', `/v1/${enc(coll)}/${enc(id)}${qs(conn)}`)) as Rec | null;
                return ((r as { data?: unknown } | null)?.data ?? r) as never;
            }
            return (await call(baseUrl, apiKey, 'GET', `/v1/${enc(coll)}/${enc(id)}${qs(conn)}`, undefined, true)) as never;
        },
        query: async (_t, coll, options, conn) => {
            const raw = unwrap<Rec>(await c('POST', `/v1/${enc(coll)}/query`, withConn((options ?? {}) as object, conn)));
            return raw as never;
        },
        updateByQuery: async (_t, coll, filter, fields, conn) =>
            unwrap(await c('PUT', `/v1/${enc(coll)}/update-by-query`, withConn({ filter, fields }, conn))),
        deleteByQuery: async (_t, coll, filter, conn) =>
            unwrap(await c('DELETE', `/v1/${enc(coll)}/delete-by-query`, withConn({ filter }, conn))),
        count: async (_t, coll, filter, conn) => {
            const r = unwrap<Rec>(await c('POST', `/v1/${enc(coll)}/count`, withConn(filter ? { filter } : {}, conn)));
            return Number(r['count'] ?? 0);
        },
        getCollectionSchema: async (_t, coll, conn) => unwrap(await c('GET', `/v1/schema/${enc(coll)}${qs(conn)}`)),
        bulkInsert: async (_t, coll, records, conn) => unwrap(await c('POST', `/v1/${enc(coll)}/bulk`, withConn({ records }, conn))),
        search: async (coll, query, opts) => {
            const r = unwrap<{ records: never[] }>(await c('POST', `/v1/${enc(coll)}/search`, withConn({ query, fields: opts?.fields, limit: opts?.limit }, opts?.connection)));
            return r.records;
        },
        transaction: async (_t, operations, options) => {
            const json = await call(baseUrl, apiKey, 'POST', `/v1/transaction${qs(options?.connection)}`, { operations }, false,
                options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {});
            // client.ts: `return (result as any).data ?? result;`
            const r = json as Rec | null;
            return ((r && r['data'] !== undefined && r['data'] !== null ? r['data'] : json)) as never;
        },
        vector: {
            search: async (_t, coll, o) =>
                unwrap(await c('POST', `/v1/${enc(coll)}/vector/search`, withConn({ vector: o.vector, limit: o.limit, metadata_filter: o.filter }, o.connection))),
        },
        graph: {
            createEdge: async (_t, coll, o) =>
                unwrap(await c('POST', `/v1/${enc(coll)}/graph/edge`, withConn({
                    from_id: o.fromId, to_id: o.toId, edge_collection: o.edgeCollection, properties: o.properties,
                }, o.connection))),
            traverse: async (_t, coll, o) =>
                unwrap(await c('POST', `/v1/${enc(coll)}/graph/traverse`, withConn({
                    start_id: o.startId,
                    edge_collection: o.edgeCollection,
                    edge_collections: o.edgeCollections,
                    direction: o.direction,
                    min_depth: o.minDepth,
                    max_depth: o.maxDepth,
                }, o.connection))),
        },
    };
}
