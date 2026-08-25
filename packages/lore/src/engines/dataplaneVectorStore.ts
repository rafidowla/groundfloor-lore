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

// TW-1b: type-only — GroundfloorClient is used solely as the type of the
// pre-constructed `client` field below. The optional, cloud-only SDK is never
// statically loaded by this module.
import type { GroundfloorClient } from 'groundfloor-ts-sdk';

import type {
    EmbeddingProvider,
    VectorProvider,
    VerbatimDocument,
    VerbatimSearchResult,
} from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { makeBm25Envelope } from './verbatimBm25Result.js';
import type { Bm25Envelope } from './verbatimBm25Result.js';
import { applyActorScopeFilter, normalizeScopes } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';

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
    /**
     * Optional capability probe used by bm25Search to skip the
     * underlying search call when the backend can't rank
     * (RankedFullTextSearch). When omitted, bm25Search falls through
     * to the implicit `_score`-presence heuristic.
     *
     * Returns:
     *   true  → backend advertises the capability → make the call
     *   false → no backend advertises it → return [] immediately
     *   null  → probe failed → fall open (run the call anyway)
     */
    hasCapability?: (capability: string) => Promise<boolean | null>;
}

const VERBATIM_COLLECTION = 'lore_verbatim';

// Typed handle to the SDK surface we actually use. Declared locally so the
// arch lint (no direct cloud driver imports) keeps ignoring this file.
interface SdkVectorClient {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    /** Full-text search. Returns `_score` populated when the underlying
     *  connector advertises `RankedFullTextSearch` (e.g. Arango), undefined
     *  otherwise (e.g. Postgres substring path). New top-level signature —
     *  no tenantId positional arg (auth-driven). Shipped on dataplane
     *  2026-05-09 (groundfloor-dataplane-oss commits 7494c51 + 8270022). */
    search<T = unknown>(
        collection: string,
        query: string,
        opts?: { fields?: string[]; limit?: number; connection?: string },
    ): Promise<Array<T & { _score?: number }>>;
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
    private readonly hasCapability?: (capability: string) => Promise<boolean | null>;
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
        this.hasCapability = config.hasCapability;
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
            const vector = await this.embeddingProvider.embedDocument(doc.text);
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
        // opts.includeHistory is a LocalVerbatimStore extension; Dataplane ignores it.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _opts?: { includeHistory?: boolean },
        actorScopes?: ReadonlyArray<string>,
    ): Promise<VerbatimSearchResult[]> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            const vector = await this.embeddingProvider.embedQuery(query);
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
            const mapped = records.map((r) => {
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
            // Row-level enforcement: SpiceDB has already gated workspace
            // access; here we filter rows by their security_scopes against
            // the actor's effective scope set. Undefined / empty scopes
            // disables filtering (daemon-internal callers).
            return applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes());
        } catch (err) {
            throw new DataplaneVectorStoreError('search', (err as Error).message);
        }
    }

    /**
     * bm25Search — Cloud parity for VerbatimStore.bm25Search (verbatimStore.ts:800).
     *
     * Routes to the dataplane FTS handler. Backend was upgraded to BM25
     * ranked retrieval on Arango on 2026-05-09 (groundfloor-dataplane-oss
     * commits 7494c51 + 8270022); Postgres still falls back to substring.
     * Capability detection happens via the typed SDK return: each record
     * carries `_score?: number`, present iff the connector advertises
     * `RankedFullTextSearch`. When `_score` is uniformly absent, the
     * connector returned substring matches — this already returns an EMPTY
     * hit list rather than fake-ranked results in that case (see below), so
     * `ranked` on the returned envelope is `true` whenever `hits` is
     * non-empty: a populated `_score` is exactly the gate that lets
     * non-empty results out of this method at all.
     *
     * Default search fields match the dataplane connector's defaults
     * (name, title, description) plus the verbatim-store-specific text/
     * label/tags so the same query returns useful hits regardless of
     * which fields the row populates.
     */
    async bm25Search(
        query: string,
        limit: number = 10,
        _filter?: Partial<VerbatimDocument['metadata']>,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<Bm25Envelope<VerbatimSearchResult>> {
        if (!query || !query.trim()) return makeBm25Envelope([], true);
        try {
            // Upfront capability probe — when bound, skip the search call
            // entirely if no connector advertises RankedFullTextSearch.
            // Falls open on probe failure (null) so a flaky probe doesn't
            // disable BM25.
            if (this.hasCapability) {
                const supported = await this.hasCapability('RankedFullTextSearch');
                if (supported === false) return makeBm25Envelope([], true);
            }
            // tenantId is implicit via auth headers in the new SDK signature.
            const hits = await this.client.search<Record<string, unknown>>(
                VERBATIM_COLLECTION,
                query,
                {
                    fields: ['text', 'label', 'tags', 'name', 'title', 'description'],
                    limit,
                    connection: this.connection,
                },
            );

            // Substring-only backends (Postgres today) don't populate
            // _score. Return empty so RRF falls through to semantic-only.
            // Note: even one populated _score signals BM25 capability,
            // so we check the first row.
            if (hits.length === 0) return makeBm25Envelope([], true);
            const first = hits[0] as Record<string, unknown>;
            if (first['_score'] === undefined) return makeBm25Envelope([], true);

            const mapped = hits.map((h) => {
                const r = h as Record<string, unknown>;
                const scopesRaw = r['security_scopes'];
                // L-006: parse security_scopes identically to the semantic
                // path — cloud connectors round-trip scopes as a comma-joined
                // string, so an array-only parse silently dropped them to [] and
                // leaked scoped rows through the BM25 lane. normalizeScopes is the
                // canonical normalizer (handles array + comma-string).
                const scopes: string[] = normalizeScopes(scopesRaw);
                return {
                    id: String(r['id'] ?? ''),
                    score: typeof r['_score'] === 'number' ? (r['_score'] as number) : 0,
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
            return makeBm25Envelope(applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes()), true);
        } catch (err) {
            // Non-fatal — match VerbatimStore semantics. RRF falls through
            // to semantic-only retrieval on empty BM25 list. An error is an
            // UNKNOWN state, not a verified ranking — fail closed.
            console.error(`[DataplaneVectorStore] bm25Search failed (non-fatal): ${(err as Error).message}`);
            return makeBm25Envelope([], false);
        }
    }

    async delete(id: string): Promise<void> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            await this.client.deleteByQuery(
                tenantId,
                VERBATIM_COLLECTION,
                { id_eq: id, org_id: this.orgId }, // RA2-reaudit2 — org-scope the destructive delete
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
    async getById(id: string): Promise<{ contentHash?: string; text?: string } | null> {
        try {
            const tenantId = this.tenantProvider();
            await this.ensureTenantInitialized(tenantId);
            // Use query-by-id since Dataplane doesn't expose a single-record
            // GET endpoint on the verbatim collection.
            const res = await this.client.query<Record<string, unknown>>(
                tenantId,
                VERBATIM_COLLECTION,
                { filter: { id_eq: id }, limit: 1 },
                this.connection,
            );
            const row = res.records?.[0];
            if (!row) return null;
            return {
                contentHash: (row['contentHash'] as string | undefined) ?? '',
                text: (row['text'] as string | undefined) ?? '',
            };
        } catch {
            return null;
        }
    }

    /**
     * SW-20 (E3): cloud stub for reconnect's chunked hash-resolution path.
     *
     * Returning an empty Map means reconnect treats every node as
     * "changed" → re-embeds — identical to the per-id `getById` stub above
     * (the cloud reconnect path lands in a later slice). Bandwidth-suboptimal
     * but correct; mirrors VerbatimStore when the table isn't built.
     */
    async getContentHashesByIds(_ids: string[]): Promise<Map<string, string>> {
        return new Map();
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

    /**
     * storeBatch — Cloud parity for VerbatimStore.storeBatch (verbatimStore.ts:426).
     *
     * VerbatimStore's local impl does Layer-2 preflight (one bulk query
     * for already-existing ids, one delete-by-id-list, one .add()) for
     * speed. Cloud has no equivalent batch-delete-by-id-set primitive;
     * the SDK's bulkInsert helper exists but doesn't carry our history-
     * snapshot semantics. So this implementation loops `store(doc)` —
     * correctness over throughput. Used by reconnectGraph (the bulk
     * reembed path), which is itself an admin op, not a hot-path.
     */
    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        if (docs.length === 0) return;
        for (const doc of docs) {
            await this.store(doc);
        }
    }
}
