/**
 * Bridge Lore's tenant-first Dataplane calls onto the current
 * groundfloor-ts-sdk (collection-first CRUD; tenant via header / RLS).
 *
 * The SDK dropped `tenantId` from insert/query/updateByQuery/count/
 * createCollection paths (`/v1/{collection}`). Lore adapters still
 * pass tenant first. Calling the live client with that arity sent the
 * tenant as the collection name and 404'd ("not found").
 *
 * Vector + graph extensions still use `/v1/{tenant}/{collection}/...`.
 */

import { getCurrentWorkspaceId } from '../security/workspaceContext.js';

export const SDK_TENANT_ID_HEADER = 'X-Tenant-Id';

/** Minimal SDK surface the wrapper forwards to. */
export interface CollectionFirstSdk {
    createCollection(schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(collection: string, record: T, connection?: string): Promise<T>;
    get<T = unknown>(collection: string, id: string, connection?: string): Promise<T>;
    query<T = unknown>(collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(collection: string, filter?: object, connection?: string): Promise<number>;
    vector?: unknown;
    graph?: unknown;
}

export interface TenantFirstSdk {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    vector?: unknown;
    graph?: unknown;
}

type ClientCtor = new (baseUrl: string, apiKey: string) => CollectionFirstSdk;

/**
 * Subclass the live SDK so every HTTP call carries the request's tenant
 * (AsyncLocalStorage workspace). Mock Dataplane keys isolation on this header.
 * Must subclass (not patch after construct): VectorClient captures
 * `this.fetch.bind(this)` inside the parent constructor.
 */
export function makeTenantAwareDataplaneClient(
    Ctor: ClientCtor,
    baseUrl: string,
    apiKey: string,
): CollectionFirstSdk {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    class TenantAware extends (Ctor as any) {
        protected async fetch<T>(path: string, options?: RequestInit): Promise<T> {
            const tenant = getCurrentWorkspaceId();
            const headers = {
                ...(options?.headers as Record<string, string> | undefined),
                ...(tenant ? { [SDK_TENANT_ID_HEADER]: tenant } : {}),
            };
            return super.fetch(path, { ...options, headers }) as Promise<T>;
        }
    }
    const Inst = TenantAware as unknown as new (a: string, b: string) => CollectionFirstSdk;
    return new Inst(baseUrl, apiKey);
}

/** Tenant-aware live client + tenant-first Lore façade. */
export function createLoreDataplaneSdk(
    Ctor: ClientCtor,
    baseUrl: string,
    apiKey: string,
): TenantFirstSdk {
    return asLoreDataplaneSdk(makeTenantAwareDataplaneClient(Ctor, baseUrl, apiKey));
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
        vector: raw.vector,
        graph: raw.graph,
    };
}
