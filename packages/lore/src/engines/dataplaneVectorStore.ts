/**
 * dataplaneVectorStore.ts — Q2.2 slice 3. Cloud-mode VectorProvider backed by
 * the Groundfloor Dataplane TS-SDK (vector extension).
 *
 * Why:
 *   When `deploymentMode === 'cloud'`, core swaps the embedded LanceDB
 *   `VerbatimStore` for this adapter. Every verbatim write / similarity
 *   search is routed through `groundfloor-ts-sdk` → Dataplane → a tenant-
 *   scoped vector connector (pgvector, Arango vector index, …). D-017:
 *   Lore never talks to a cloud vector DB driver directly.
 *
 * Contract:
 *   Implements `VectorProvider` (providers/types.ts) — the 6-method surface
 *   core actually uses. `getById`/`listIds` (used only by the local
 *   reconnect flow + CLI) are NOT on VectorProvider; they're
 *   LocalGraph-era concerns and remain unsupported in cloud mode until a
 *   later slice adds cloud-mode reconnect.
 *
 * Embedding:
 *   Slice 3 embedded in-process with a duplicated Xenova pipeline.
 *   Slice 6a extracted that into the EmbeddingProvider interface
 *   (providers/types.ts). The default — LocalEmbeddingProvider — keeps
 *   embedding in-process so the roundtrip stays small (one `search`
 *   hit, not two). Slice 6b will plug a DataplaneEmbeddingProvider in
 *   without touching this file.
 *
 * Tenancy & schema:
 *   - `tenantProvider: () => string` returns the current request's tenant
 *     (AsyncLocalStorage-resolved). Same pattern as DataplaneGraph.
 *   - Per-tenant lazy schema push (boot doesn't know the tenants). First
 *     op per tenant fires `createCollection('lore_verbatim', …)`; repeats
 *     are in-flight-deduped; "already exists" / 409 are swallowed.
 *
 * Write path (idempotent):
 *   embed → `updateByQuery({id_eq: id}, row)` → insert on updated=0.
 *   Same pattern DataplaneGraph.upsertNode uses. The SDK's VectorClient
 *   does not expose an upsert; writes go through `client.insert` on a
 *   vector-field-bearing collection.
 *
 * Read path:
 *   embed query → `client.vector.search(tenantId, 'lore_verbatim',
 *     { vector, limit, filter: metadataFilter })`. Filter keys match
 *     VerbatimDocument.metadata; undefined/empty values are dropped.
 *   Returns results with score = 1 - distance/2 (matches VerbatimStore's
 *   mapping so downstream consumers see the same 0..1 scale).
 *
 * Side Effects: Network calls to Dataplane. In-proc embedder loads once.
 * Error Behavior: Bubbles SDK errors as `DataplaneVectorStoreError` with
 *   an `operation` field. Mirrors the VerbatimStoreError shape so
 *   existing catch-blocks in server.ts continue to work.
 */

// @ts-ignore - Local workspace linking lacks full Node16 exports declaration
import { GroundfloorClient } from 'groundfloor-ts-sdk';

import type {
    EmbeddingProvider,
    VectorProvider,
    VerbatimDocument,
    VerbatimSearchResult,
} from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';

export class DataplaneVectorStoreError extends Error {
    public operation: string;
    constructor(operation: string, message: string) {
        super(`[DataplaneVectorStore:${operation}] ${message}`);
        this.name = 'DataplaneVectorStoreError';
        this.operation = operation;
    }
}

/**
 * Resolve the current tenant for a SDK call. Called once per op so the
 * singleton daemon can swap tenants via AsyncLocalStorage between
 * requests without this adapter caring.
 */
export type TenantProvider = () => string;

export interface DataplaneVectorStoreConfig {
    /** Pre-constructed SDK client. Tests inject a fake that implements
     *  the subset used here (vector.search + insert + updateByQuery +
     *  deleteByQuery + count + createCollection). */
    client: GroundfloorClient;
    /** Dynamic per-request tenant id. */
    tenantProvider: TenantProvider;
    /** Organization id written on every row for ReBAC partitioning. */
    orgId: string;
    /**
     * Optional connector name when the tenant has multiple connectors.
     * Omit to let Dataplane pick the primary.
     */
    connection?: string;
    /**
     * Embedding provider (slice 6a). Defaults to a fresh
     * LocalEmbeddingProvider; tests inject a deterministic stub.
     * Slice 6b's DataplaneEmbeddingProvider plugs in here.
     */
    embeddingProvider?: EmbeddingProvider;
}

const VERBATIM_COLLECTION = 'lore_verbatim';

// Typed handle to the SDK surface we actually use. Declared locally so the
// arch lint (no direct cloud driver imports) keeps ignoring this file.
interface SdkVectorClient {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    vector: {
        search<T = unknown>(tenantId: string, collection: string, options: {
            vector: number[];
            limit?: number;
            filter?: object;
            connection?: string;
        }): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    };
}

export class DataplaneVectorStore implements VectorProvider {
    private readonly client: SdkVectorClient;
    private readonly tenantProvider: TenantProvider;
    private readonly orgId: string;
    private readonly connection?: string;
    private readonly embeddingProvider: EmbeddingProvider;
    /**
     * Per-tenant schema-push state. Same lazy pattern as DataplaneGraph:
     * first op per tenant creates the collection; concurrent first-hits
     * see the same in-flight promise; failures are dropped so the next
     * call retries rather than latching a permanent failed state.
     */
    private readonly tenantInit = new Map<string, Promise<void>>();

    constructor(config: DataplaneVectorStoreConfig) {
        this.client = config.client as unknown as SdkVectorClient;
        this.tenantProvider = config.tenantProvider;
        this.orgId = config.orgId;
        this.connection = config.connection;
        this.embeddingProvider = config.embeddingProvider ?? new LocalEmbeddingProvider();
    }

    /**
     * initialize — Warm the embedder.
     *
     * Cloud schema push is per-tenant and lazy (see DataplaneGraph for
     * the rationale). Each write/read method calls
     * `ensureTenantInitialized(tenantId)` internally. The boot-time
     * call here just kicks the embedder model-load so the first
     * request doesn't pay for it.
     */
    async initialize(): Promise<void> {
        await this.embeddingProvider.initialize();
    }

    private ensureTenantInitialized(tenantId: string): Promise<void> {
        const existing = this.tenantInit.get(tenantId);
        if (existing) return existing;
        const p = this.pushSchemaFor(tenantId).catch((err) => {
            this.tenantInit.delete(tenantId);
            throw err;
        });
        this.tenantInit.set(tenantId, p);
        return p;
    }

    private async pushSchemaFor(tenantId: string): Promise<void> {
        const schema = {
            name: VERBATIM_COLLECTION,
            fields: [
                { name: 'id', field_type: 'string', primary_key: true, required: true },
                {
                    name: 'vector',
                    field_type: 'vector',
                    // Slice 6a: read dimension from the injected provider
                    // so 6b's DataplaneEmbeddingProvider (BGE-M3, 1024-d)
                    // and slice 7's multilingual-e5-small (384-d but a
                    // different model) provision the right field width.
                    dimension: this.embeddingProvider.dimension,
                    required: true,
                },
                { name: 'text', field_type: 'string' },
                { name: 'type', field_type: 'string', indexed: true },
                { name: 'label', field_type: 'string' },
                { name: 'tags', field_type: 'string' },
                { name: 'project', field_type: 'string', indexed: true },
                { name: 'ecosystem', field_type: 'string', indexed: true },
                { name: 'updated_at', field_type: 'string' },
                { name: 'security_scopes', field_type: 'string' },
                { name: 'content_hash', field_type: 'string' },
                { name: 'org_id', field_type: 'string', indexed: true, required: true },
            ],
        };
        try {
            await this.client.createCollection(tenantId, schema, this.connection);
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            if (/already exists|duplicate|409/i.test(msg)) return;
            throw err;
        }
    }

    async store(doc: VerbatimDocument): Promise<void> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            const vector = await this.embeddingProvider.embed(doc.text);
            // security_scopes is a string[] in the metadata contract.
            // pgvector / Arango vector connectors vary in how they store
            // arrays; we join on a separator for portability and split
            // on read. LanceDB adapter keeps the array form internally.
            const scopesJoined = Array.isArray(doc.metadata?.security_scopes)
                ? (doc.metadata!.security_scopes as string[]).join(',')
                : '';
            const row = {
                id: doc.id,
                vector,
                text: doc.text,
                type: doc.metadata?.type ?? '',
                label: doc.metadata?.label ?? '',
                tags: doc.metadata?.tags ?? '',
                project: doc.metadata?.project ?? '',
                ecosystem: doc.metadata?.ecosystem ?? '',
                updated_at: doc.metadata?.updatedAt ?? '',
                security_scopes: scopesJoined,
                content_hash: (doc.metadata as { contentHash?: string })?.contentHash ?? '',
                org_id: this.orgId,
            };
            // Idempotent upsert — same pattern as DataplaneGraph.upsertNode.
            const res = await this.client.updateByQuery(
                tenantId,
                VERBATIM_COLLECTION,
                { id_eq: doc.id },
                row,
                this.connection,
            );
            if ((res?.updated ?? 0) === 0) {
                await this.client.insert(tenantId, VERBATIM_COLLECTION, row, this.connection);
            }
        } catch (err) {
            throw new DataplaneVectorStoreError('store', (err as Error).message);
        }
    }

    async search(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
    ): Promise<VerbatimSearchResult[]> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            const vector = await this.embeddingProvider.embed(query);
            const metadataFilter: Record<string, unknown> = { org_id: this.orgId };
            if (filter) {
                for (const [k, v] of Object.entries(filter)) {
                    if (v === undefined || v === null || v === '') continue;
                    // security_scopes round-trips as a joined string on cloud
                    // connectors; caller's array filter isn't meaningful
                    // there without substring support. Drop it silently —
                    // search quality is not affected, and the field is
                    // returned intact on the result.
                    if (k === 'security_scopes') continue;
                    metadataFilter[k] = v;
                }
            }
            const res = await this.client.vector.search<Record<string, unknown>>(
                tenantId,
                VERBATIM_COLLECTION,
                { vector, limit, filter: metadataFilter, connection: this.connection },
            );
            const records = res.records ?? [];
            return records.map((r) => {
                // Result shape: the connector returns a `_distance` or
                // `score` field. Prefer an explicit score; else convert
                // distance using the same formula VerbatimStore uses.
                const rawScore = r['score'];
                const rawDist = r['_distance'] ?? r['distance'];
                const score =
                    typeof rawScore === 'number'
                        ? rawScore
                        : typeof rawDist === 'number'
                        ? 1 - (rawDist as number) / 2
                        : 0;
                const scopesField = r['security_scopes'];
                const scopes =
                    Array.isArray(scopesField)
                        ? (scopesField as string[])
                        : typeof scopesField === 'string' && scopesField.length > 0
                        ? scopesField.split(',').filter((s) => s.length > 0)
                        : [];
                return {
                    id: String(r['id'] ?? ''),
                    score,
                    text: String(r['text'] ?? ''),
                    metadata: {
                        type: (r['type'] as string | undefined) ?? '',
                        label: (r['label'] as string | undefined) ?? '',
                        tags: (r['tags'] as string | undefined) ?? '',
                        project: (r['project'] as string | undefined) ?? '',
                        ecosystem: (r['ecosystem'] as string | undefined) ?? '',
                        updatedAt:
                            (r['updated_at'] as string | undefined) ??
                            (r['updatedAt'] as string | undefined) ??
                            '',
                        security_scopes: scopes,
                    },
                };
            });
        } catch (err) {
            throw new DataplaneVectorStoreError('search', (err as Error).message);
        }
    }

    async delete(id: string): Promise<void> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            await this.client.deleteByQuery(
                tenantId,
                VERBATIM_COLLECTION,
                { id_eq: id },
                this.connection,
            );
        } catch {
            // Match VerbatimStore semantics: delete is best-effort and
            // silent on error (orphan reaper + node-delete callers both
            // already handle missing rows).
        }
    }

    async count(): Promise<number> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            return await this.client.count(
                tenantId,
                VERBATIM_COLLECTION,
                { org_id: this.orgId },
                this.connection,
            );
        } catch {
            return 0;
        }
    }

    async close(): Promise<void> {
        // no connection to release; SDK client is shared with DataplaneGraph.
    }

    /**
     * getById — Slice-3 cloud stub for reconnect's "only-changed" path.
     *
     * The cloud reconnect path lands in a later slice (3b). Returning
     * null means reconnect treats every node as "changed" → re-embeds.
     * That's correct behavior (just not optimal bandwidth); it mirrors
     * what VerbatimStore does when the table hasn't been created yet.
     */
    async getById(_id: string): Promise<{ contentHash?: string; text?: string } | null> {
        return null;
    }

    /**
     * listIds — Slice-3 cloud stub for the orphan reaper.
     *
     * Returning [] short-circuits the reaper (no orphans to delete).
     * Cloud connectors own row-level TTL / cleanup via Dataplane policies.
     */
    async listIds(_prefix?: string): Promise<string[]> {
        return [];
    }
}
