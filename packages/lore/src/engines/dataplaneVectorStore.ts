/**
 * dataplaneVectorStore.ts — Q2.2 slice 3. Cloud-mode VectorProvider backed by
 * the Groundfloor Dataplane TS-SDK (vector extension).
 *
 * Why:
 *   When `deploymentMode === 'cloud'`, core swaps the embedded LanceDB
 *   `VerbatimStore` for this adapter. Every verbatim write / similarity
 *   search is routed through `groundfloor-ts-sdk` → Dataplane → a tenant-
 *   workspace-scoped vector connector (pgvector, Arango vector index, …). D-017:
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
 * Scope & schema (cloud parity A1):
 *   - One Dataplane workspace (credential-fixed; the engine ignores X-Tenant-Id)
 *     holds many Lore workspaces. Every row carries `org_id`, `lore_workspace`,
 *     `lore_id`; its physical `id` is the
 *     D2 row key (`dataplaneRowKey`) and reads map `lore_id` back to `id`.
 *   - `loreWorkspaceProvider` (default `requireCurrentWorkspaceId`, ALS) resolves
 *     the Lore workspace per op and fails closed when unbound.
 *   - Schema push is lazy and once per Dataplane workspace ("already exists" /
 *     409 swallowed); it adds the `scope_key` unique index.
 *
 * Write path (idempotent):
 *   embed → scoped `updateByQuery(lore_id eq …)` → insert on updated=0 (retry the
 *   update once on a 409 from a concurrent writer). See `scopedUpsert`.
 *
 * Read path:
 *   embed query → `client.vector.search(dataplaneWorkspaceId, 'lore_verbatim',
 *     { vector, limit: fetchLimit, filter: <engine tree> })`. The server filter is
 *   best-effort narrowing only (Arango ignores it; Qdrant keeps string-eq clauses);
 *   the client predicate from `buildDataplaneScopeFilter` is the guarantee and is
 *   applied to every result, over-fetching to compensate.
 *   Scores come from `normalizeVectorScore` (dataplaneScore.ts, D4): whichever key the
 *   connector returns is mapped to `1 - cosineDistance/2`, VerbatimStore's 0..1 scale.
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
    VerbatimQueryFilter,
    VerbatimSearchResult,
} from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { warmEmbeddingProvider } from '../providers/embeddingWarmup.js';
import { makeBm25Envelope } from './verbatimBm25Result.js';
import type { Bm25Envelope } from './verbatimBm25Result.js';
import { applyActorScopeFilter, normalizeScopes } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import { requireCurrentWorkspaceId } from '../security/workspaceContext.js';
import {
    buildDataplaneScopeFilter,
    resolveDataplaneScope,
    SCOPE_COLUMNS,
    SCOPE_KEY_INDEX,
    type DataplaneScope,
    type LoreWorkspaceRegistry,
    type ScopeFilterInput,
} from './dataplaneScopeFilter.js';
import { ensureCollection } from './dataplaneGraphSchema.js';
import { keepInScope, scopedGetRow, scopedUpsert } from './dataplaneScopedIo.js';
import { isCurrentRow, nextRevisionTimestamp, rowRevisionState, tombstoneText } from './dataplaneVerbatimHistory.js';
import { overwriteWithSnapshot, readVerbatimHistory, tombstoneFields, type VerbatimHistoryEntry } from './dataplaneVerbatimHistoryReads.js';
import { log } from '../logger.js';
import { normalizeVectorScore, scoreBm25Hits } from './dataplaneScore.js';
import { computeContentHash } from './contentHash.js';
import { fetchRowsByIds, storeVerbatimBatch } from './dataplaneVerbatimBatch.js';
import { isRevisionHistoryId } from './verbatimHistory.js';
import { LEGACY_DELETE_REASON, physicalDeleteRows } from './dataplaneVerbatimDelete.js';

export class DataplaneVectorStoreError extends Error {
    public operation: string;
    constructor(operation: string, message: string) {
        super(`[DataplaneVectorStore:${operation}] ${message}`);
        this.name = 'DataplaneVectorStoreError';
        this.operation = operation;
    }
}

/**
 * @deprecated Slice C removes tenant routing. When supplied (and
 * `loreWorkspaceProvider` is not) it is treated as the Lore-workspace provider —
 * never as a Dataplane tenant.
 */
export type TenantProvider = () => string;

export interface DataplaneVectorStoreConfig {
    /** Pre-constructed SDK client. Tests inject a fake that implements
     *  the subset used here (vector.search + insert + updateByQuery +
     *  deleteByQuery + count + createCollection). */
    client: GroundfloorClient;
    /** Groundfloor portal workspace = engine tenant; credential-fixed, not used for routing. */
    dataplaneWorkspaceId: string;
    /** Lore workspace for the current call. Default: requireCurrentWorkspaceId (ALS; throws when unbound). */
    loreWorkspaceProvider?: () => string;
    /** @deprecated use loreWorkspaceProvider. */
    tenantProvider?: TenantProvider;
    /** The Lore workspaces this instance serves (its own registry), consulted on every op. Required; no wildcard. */
    workspaceRegistry: LoreWorkspaceRegistry;
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

/** What getById returns; the same shape as the local VerbatimStore.getById. */
export interface StoredVerbatimRow {
    contentHash?: string;
    text?: string;
    type?: string;
    label?: string;
    tags?: string;
    project?: string;
    ecosystem?: string;
    updatedAt?: string;
    security_scopes?: string[];
}

// Typed handle to the SDK surface we actually use. Declared locally so the
// arch lint (no direct cloud driver imports) keeps ignoring this file.
interface SdkVectorClient {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
    getCollectionSchema?(tenantId: string, collection: string, connection?: string): Promise<unknown>;
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
    private client: SdkVectorClient;
    private readonly loreWorkspaceProvider: () => string;
    private readonly dataplaneWorkspaceId: string;
    private readonly workspaceRegistry: LoreWorkspaceRegistry;
    private readonly orgId: string;
    private readonly connection?: string;
    private readonly embeddingProvider: EmbeddingProvider;
    private hasCapability?: (capability: string) => Promise<boolean | null>;
    /**
     * Schema-push state, per Dataplane workspace. Same lazy pattern as
     * DataplaneGraph: first op creates the collection; concurrent first-hits
     * see the same in-flight promise; failures are dropped so the next
     * call retries rather than latching a permanent failed state.
     */
    private readonly tenantInit = new Map<string, Promise<void>>();
    /** Per Dataplane workspace: does lore_verbatim declare `revision_state`? (false on a legacy collection) */
    private readonly revisionColumn = new Map<string, boolean>();
    private warnedUnindexedHistory = false;

    constructor(config: DataplaneVectorStoreConfig) {
        this.client = config.client as unknown as SdkVectorClient;
        this.dataplaneWorkspaceId = config.dataplaneWorkspaceId;
        this.loreWorkspaceProvider = config.loreWorkspaceProvider ?? config.tenantProvider ?? requireCurrentWorkspaceId;
        if (!config.workspaceRegistry) throw new Error('DataplaneVectorStore requires a workspaceRegistry (no wildcard default)');
        this.workspaceRegistry = config.workspaceRegistry;
        this.orgId = config.orgId;
        this.connection = config.connection;
        this.embeddingProvider = config.embeddingProvider ?? new LocalEmbeddingProvider();
        this.hasCapability = config.hasCapability;
    }

    /**
     * Credential rebuild in place (cloud parity A2 item 5): adopt the client + capability probe
     * of a store built with the real (keychain) credential. The boot store is captured by value
     * across the daemon (sync engine, storage facade, tool deps), so it must keep its identity;
     * only the connection is swapped. Scope config (org, workspace, registry) is NOT taken.
     */
    adoptConnectionFrom(other: DataplaneVectorStore): void {
        this.client = other.client;
        this.hasCapability = other.hasCapability;
    }

    /** Per-call scope; throws DataplaneScopeError (fail closed) before any SDK call. */
    private scope(): DataplaneScope {
        return resolveDataplaneScope({
            orgId: this.orgId,
            dataplaneWorkspaceId: this.dataplaneWorkspaceId,
            workspaceRegistry: this.workspaceRegistry,
            loreWorkspaceProvider: this.loreWorkspaceProvider,
        });
    }

    /**
     * initialize — Warm the embedder.
     *
     * Cloud schema push is lazy (see DataplaneGraph for the rationale). Each
     * write/read method calls `ensureTenantInitialized(dataplaneWorkspaceId)`
     * internally. The boot-time
     * call here just kicks the embedder model-load so the first
     * request doesn't pay for it.
     */
    async initialize(): Promise<void> {
        await warmEmbeddingProvider(this.embeddingProvider, '[DataplaneVectorStore]'); // non-fatal; retried on first embed
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
                // Convenience column ('current' | 'history' | 'tombstone'): written and pushed down
                // only when declared; row state is always derived from lore_id/text (history item 8).
                { name: 'revision_state', field_type: 'string', indexed: true },
                { name: 'org_id', field_type: 'string', indexed: true, required: true },
                ...SCOPE_COLUMNS,
            ],
            indexes: [SCOPE_KEY_INDEX],
        };
        // Create-or-reconcile (review B #4): an older lore_verbatim collection is never sent a schema
        // naming columns it lacks (engine answers 500 ERR_SCHEMA and every store/search would fail).
        const missing = await ensureCollection(this.client, tenantId, schema, this.connection);
        this.revisionColumn.set(tenantId, !missing.includes('revision_state'));
    }

    private hasRevisionColumn(scope: DataplaneScope): boolean {
        return this.revisionColumn.get(scope.dataplaneWorkspaceId) ?? false;
    }

    async store(doc: VerbatimDocument): Promise<void> {
        try {
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            // Same as local: a supplied hash wins, otherwise derive it from the text, so the
            // dedup / only-changed paths work for callers that never pass one (item 3).
            const effectiveHash = (doc.metadata as { contentHash?: string } | undefined)?.contentHash || computeContentHash(doc.text);
            // Skip-identical (local parity): an unchanged re-store is a no-op. Never when the
            // stored row is a tombstone, and metadata must match too (a text-only match used to
            // drop metadata-only updates locally, audit 1.M9).
            const history = isRevisionHistoryId(doc.id);
            const existingRaw = history ? null : await scopedGetRow(this.client, scope, VERBATIM_COLLECTION, doc.id, this.connection);
            if (existingRaw) {
                const existing = this.toStoredRow(existingRaw);
                if (existing.contentHash === effectiveHash && this.sameStoredMetadata(existing, doc)) return;
            }
            const vector = await this.embeddingProvider.embedDocument(doc.text);
            const fields = this.rowFields(doc, effectiveHash, vector, this.hasRevisionColumn(scope));
            if (!existingRaw) {
                await scopedUpsert(this.client, scope, VERBATIM_COLLECTION, doc.id, fields, this.connection);
                return;
            }
            // Overwriting an existing row: its previous content is kept as a `<id>#rev<ts>` snapshot,
            // in one /v1/transaction when the route exists (else change first, snapshot second;
            // a snapshot failure is counted in /health, not thrown — R3).
            await this.writeWithSnapshot(scope, doc.id, fields, existingRaw);
        } catch (err) {
            throw new DataplaneVectorStoreError('store', (err as Error).message);
        }
    }

    /** Overwrite canonical row `id` with `fields`, snapshotting `existingRaw` first (dataplaneVerbatimHistoryReads.ts). */
    private writeWithSnapshot(scope: DataplaneScope, id: string, fields: Record<string, unknown>, existingRaw: Record<string, unknown>): Promise<void> {
        return overwriteWithSnapshot({ client: this.client as never, connection: this.connection, scope, collection: VERBATIM_COLLECTION, id, fields, existing: existingRaw, revisionColumn: this.hasRevisionColumn(scope), embed: (t) => this.embeddingProvider.embedDocument(t) });
    }

    /**
     * Soft-delete (local VerbatimStore.tombstone parity): snapshot, then replace the canonical text with
     * `[TOMBSTONED <ts> reason: …]\n\n<old text>` and re-embed. A no-op when the row is absent, already
     * tombstoned, or `id` is a history id. Throws DataplaneVectorStoreError on a real failure.
     */
    async tombstone(id: string, reason: string): Promise<void> {
        try {
            if (isRevisionHistoryId(id)) return;
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            const existing = await scopedGetRow(this.client, scope, VERBATIM_COLLECTION, id, this.connection);
            if (!existing || rowRevisionState(existing) === 'tombstone') return;
            const ts = nextRevisionTimestamp();
            const text = tombstoneText(ts, reason, String(existing['text'] ?? ''));
            const fields = tombstoneFields(existing, ts, text, await this.embeddingProvider.embedDocument(text), this.hasRevisionColumn(scope));
            await overwriteWithSnapshot({ client: this.client as never, connection: this.connection, scope, collection: VERBATIM_COLLECTION, id, fields, existing, revisionColumn: this.hasRevisionColumn(scope), embed: (t) => this.embeddingProvider.embedDocument(t), ts });
        } catch (err) {
            throw new DataplaneVectorStoreError('tombstone', (err as Error).message);
        }
    }

    /** Local getHistory parity: canonical row first, then `<id>#rev<ts>` snapshots newest first (scoped; see dataplaneVerbatimHistoryReads.ts). */
    async getHistory(id: string): Promise<VerbatimHistoryEntry[]> {
        const scope = this.scope();
        await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
        return readVerbatimHistory(this.client as never, scope, VERBATIM_COLLECTION, this.connection, id);
    }

    /**
     * Row columns for a doc (identity/scope columns are added by scopedUpsert).
     * security_scopes is a string[] in the metadata contract; pgvector / Arango connectors vary in
     * how they store arrays, so it is joined on a separator for portability and split on read.
     */
    private rowFields(doc: VerbatimDocument, contentHash: string, vector: number[], revisionColumn: boolean): Record<string, unknown> {
        return {
            ...(revisionColumn ? { revision_state: 'current' } : {}),
            vector,
            text: doc.text,
            type: doc.metadata?.type ?? '',
            label: doc.metadata?.label ?? '',
            tags: doc.metadata?.tags ?? '',
            project: doc.metadata?.project ?? '',
            ecosystem: doc.metadata?.ecosystem ?? '',
            updated_at: doc.metadata?.updatedAt ?? '',
            security_scopes: Array.isArray(doc.metadata?.security_scopes) ? (doc.metadata!.security_scopes as string[]).join(',') : '',
            content_hash: contentHash,
        };
    }

    /**
     * Translate a VerbatimQueryFilter into the scope-builder input. Unknown keys
     * are ignored (security_scopes is dropped as before: it round-trips as a joined
     * string and actor scopes are enforced client-side by applyActorScopeFilter).
     */
    private filterToInput(filter: VerbatimQueryFilter | undefined): ScopeFilterInput {
        const input: {
            -readonly [K in keyof ScopeFilterInput]: ScopeFilterInput[K];
        } = {};
        if (!filter) return input;
        const extra: NonNullable<ScopeFilterInput['extra']>[number][] = [];
        const nonEmpty = (v: unknown): v is string | string[] =>
            v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
        for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
            if (!nonEmpty(v)) continue;
            switch (k) {
                case 'type': input.type = v as string | string[]; break;
                case 'project': input.project = String(v); break;
                case 'ecosystem': input.ecosystem = String(v); break;
                case 'tags':
                    input.tags = (Array.isArray(v) ? v : String(v).split(','))
                        .map((t) => String(t).trim()).filter(Boolean);
                    break;
                case 'label': extra.push({ field: 'label', op: 'eq', value: String(v) }); break;
                case 'updatedAt': extra.push({ field: 'updated_at', op: 'eq', value: String(v) }); break;
                default: break; // security_scopes + unknown keys: see above
            }
        }
        if (extra.length > 0) input.extra = extra;
        return input;
    }

    private toResult(r: Record<string, unknown>, scopes: string[], score: number): VerbatimSearchResult {
        return {
            id: String(r['lore_id'] ?? ''),
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
    }

    async search(
        query: string,
        limit: number = 10,
        // fix/3.22.1-recall-parity review fix (2) — widened from
        // `Partial<VerbatimDocument['metadata']>` to `VerbatimQueryFilter`
        // (providers/types.ts) so this matches the `VectorProvider.search`
        // contract it implements (which already declared `VerbatimQueryFilter`
        // for D2's `type: string[]` pushdown). Pure type widening: the body
        // below already treats every filter entry generically via
        // `Object.entries(filter)`, so an array `type` value round-trips into
        // `metadataFilter.type` unchanged — whether the underlying Dataplane
        // connector's `filter` predicate supports an array value the same way
        // local LanceDB/SQLite IN(...) pushdown does is a connector-level
        // question, not something this signature change decides either way.
        filter?: VerbatimQueryFilter,
        // includeHistory: also return `<id>#rev…` snapshots and tombstoned rows (local parity).
        opts?: { includeHistory?: boolean },
        actorScopes?: ReadonlyArray<string>,
    ): Promise<VerbatimSearchResult[]> {
        try {
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            const vector = await this.embeddingProvider.embedQuery(query);
            const includeHistory = opts?.includeHistory === true;
            const pushRevision = !includeHistory && this.hasRevisionColumn(scope);
            const built = buildDataplaneScopeFilter(scope, { ...this.filterToInput(filter), ...(pushRevision ? { revision: 'current' as const } : {}) }, 'vector', limit);
            // Without the column the server cannot drop history, so over-fetch to keep the cut full.
            if (!includeHistory && !pushRevision && !this.warnedUnindexedHistory) {
                this.warnedUnindexedHistory = true;
                log.warn('cloud_history_unindexed', { collection: VERBATIM_COLLECTION, effect: 'history/tombstone rows are filtered client-side; search over-fetches' });
            }
            const fetchLimit = !includeHistory && !pushRevision ? Math.min(100, Math.max(built.fetchLimit, limit * 3)) : built.fetchLimit;
            const res = await this.client.vector.search<Record<string, unknown>>(
                scope.dataplaneWorkspaceId,
                VERBATIM_COLLECTION,
                {
                    vector,
                    limit: fetchLimit,
                    ...(built.server ? { filter: built.server as object } : {}),
                    connection: this.connection,
                },
            );
            const records = (res.records ?? []).filter(built.clientPredicate).filter((r) => includeHistory || isCurrentRow(r));
            // D4: every connector names its similarity differently (F9); normalise to local's
            // 0..1 scale, then order best-first (stable, so a connector with no score — Arango —
            // keeps the server's order). Sort BEFORE the limit so the cut keeps the best rows.
            const ranked = records
                .map((r, i) => ({ r, i, score: normalizeVectorScore(r) }))
                .sort((x, y) => y.score - x.score || x.i - y.i);
            const mapped = ranked.slice(0, limit).map(({ r, score }) => {
                const scopesField = r['security_scopes'];
                const scopes =
                    Array.isArray(scopesField)
                        ? (scopesField as string[])
                        : typeof scopesField === 'string' && scopesField.length > 0
                        ? scopesField.split(',').filter((s) => s.length > 0)
                        : [];
                return this.toResult(r, scopes, score);
            });
            // CONTRACT-DEVIATION (cloud parity; Nokshi dataplane-ask #4, #10-#12): actor
            // security-scope filtering is CLIENT-SIDE only. security_scopes is a joined
            // string column the engine cannot match as a set, so it cannot be pushed into
            // metadata_filter. Consequence: with many restricted rows in the workspace,
            // top-K can be consumed by rows the actor may not see (recall loss, never a
            // leak — the filter below is unconditional). Org + Lore workspace scoping,
            // by contrast, is pushed down AND re-checked client-side (buildDataplaneScopeFilter).
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
     * `RankedFullTextSearch`. `ranked` is true only when EVERY visible hit
     * carried a numeric `_score`; substring-only backends (Postgres today)
     * return the hits with score 1.0 and `ranked:false` (RRF excludes that
     * lane) rather than an empty list — same as local's LIKE fallback.
     *
     * SCOPE (cloud parity A2 item 1): the engine's /search accepts NO filter,
     * so the request is over-fetched (`fetchLimit`) and the client predicate
     * from `buildDataplaneScopeFilter(route 'keyword')` — org + Lore workspace +
     * caller filter — is ALWAYS applied before scores are normalised
     * (`dataplaneScore.ts`, raw / max(max,1)). Ask A1 (server-side filter on
     * /search) would let the server do this before ranking.
     *
     * Default search fields match the dataplane connector's defaults
     * (name, title, description) plus the verbatim-store-specific text/
     * label/tags so the same query returns useful hits regardless of
     * which fields the row populates.
     */
    async bm25Search(
        query: string,
        limit: number = 10,
        // fix/3.22.1-recall-parity review fix (2) — same widening as
        // search() above, for interface-contract consistency (this param is
        // unused here already, prefixed `_`).
        filter?: VerbatimQueryFilter,
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
            // The Dataplane workspace is implicit via auth headers in the new SDK
            // signature. The engine's keyword /search accepts NO filter (F4), so
            // scope is enforced by the client predicate; over-fetch compensates.
            const scope = this.scope();
            // History and tombstones are never keyword hits: the engine /search has no filter, so
            // the over-fetch is widened to keep the cut full after they are dropped client-side.
            const built = buildDataplaneScopeFilter(scope, this.filterToInput(filter), 'keyword', limit * 3);
            const rawHits = await this.client.search<Record<string, unknown>>(
                VERBATIM_COLLECTION,
                query,
                {
                    fields: ['text', 'label', 'tags', 'name', 'title', 'description'],
                    limit: built.fetchLimit,
                    connection: this.connection,
                },
            );
            // Client predicate is ALWAYS applied (org + Lore workspace + caller filter): the
            // engine's /search has no filter, so a foreign workspace's rows are in `rawHits`
            // and must be dropped here, fail closed, before anything else looks at them.
            // (Foreign rows are EXPECTED here — no server filter — so no error log.)
            const inScope = (rawHits as Array<Record<string, unknown>>).filter(built.clientPredicate).filter(isCurrentRow);

            const mapped = inScope.map((r) => {
                const scopesRaw = r['security_scopes'];
                // L-006: parse security_scopes identically to the semantic
                // path — cloud connectors round-trip scopes as a comma-joined
                // string, so an array-only parse silently dropped them to [] and
                // leaked scoped rows through the BM25 lane. normalizeScopes is the
                // canonical normalizer (handles array + comma-string).
                const scopes: string[] = normalizeScopes(scopesRaw);
                return {
                    id: String(r['lore_id'] ?? ''),
                    score: typeof r['_score'] === 'number' ? (r['_score'] as number) : 0,
                    text: String(r['text'] ?? ''),
                    _hit: r,
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
            // Actor security scopes stay client-side (see search()); then normalise scores
            // over the FINAL visible set so a filtered-out row can never skew them (D4).
            const visible = applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes()).slice(0, limit);
            const { scores, ranked } = scoreBm25Hits(visible.map((v) => v._hit));
            // Substring backends (no `_score`, e.g. Postgres today): hits are kept with score
            // 1.0 and ranked:false — RRF excludes an unranked lane; better than the old empty list.
            return makeBm25Envelope(
                visible.map(({ _hit, ...rest }, i) => { void _hit; return { ...rest, score: scores[i]! }; }),
                ranked,
            );
        } catch (err) {
            // Non-fatal — match VerbatimStore semantics. RRF falls through
            // to semantic-only retrieval on empty BM25 list. An error is an
            // UNKNOWN state, not a verified ranking — fail closed.
            console.error(`[DataplaneVectorStore] bm25Search failed (non-fatal): ${(err as Error).message}`);
            return makeBm25Envelope([], false);
        }
    }

    /** Local parity: `delete()` is a tombstone (history kept); the hard delete is `physicalDelete` (dataplaneVerbatimDelete.ts). */
    async delete(id: string): Promise<void> { await this.tombstone(id, LEGACY_DELETE_REASON); }

    async physicalDelete(id: string): Promise<void> { await this.physicalDeleteMany([id]); }

    /** Hard-delete canonical rows (orphan sweeper / reaper); their snapshots stay. Throws on a real failure, like local. */
    async physicalDeleteMany(ids: string[]): Promise<number> {
        try {
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            return await physicalDeleteRows(this.client, scope, VERBATIM_COLLECTION, this.connection, ids);
        } catch (err) {
            throw new DataplaneVectorStoreError('physicalDelete', (err as Error).message);
        }
    }

    async count(): Promise<number> {
        try {
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            const built = buildDataplaneScopeFilter(scope, {}, 'crud', 0);
            return await this.client.count(
                scope.dataplaneWorkspaceId,
                VERBATIM_COLLECTION,
                built.server as object,
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
    async getById(id: string): Promise<StoredVerbatimRow | null> {
        try {
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            return await this.readRow(scope, id);
        } catch {
            return null;
        }
    }

    /** One scoped read by logical id: GET by row key + guardScope (null when absent or foreign; transient errors throw). */
    private async readRow(scope: DataplaneScope, id: string): Promise<StoredVerbatimRow | null> {
        const row = await scopedGetRow(this.client, scope, VERBATIM_COLLECTION, id, this.connection);
        return row ? this.toStoredRow(row) : null;
    }

    private toStoredRow(row: Record<string, unknown>): StoredVerbatimRow {
        return {
            contentHash: (row['content_hash'] as string | undefined) ?? '',
            text: (row['text'] as string | undefined) ?? '',
            type: (row['type'] as string | undefined) ?? '',
            label: (row['label'] as string | undefined) ?? '',
            tags: (row['tags'] as string | undefined) ?? '',
            project: (row['project'] as string | undefined) ?? '',
            ecosystem: (row['ecosystem'] as string | undefined) ?? '',
            updatedAt: (row['updated_at'] as string | undefined) ?? '',
            security_scopes: normalizeScopes(row['security_scopes']),
        };
    }

    /**
     * Skip-identical check: content hash (caller) + every metadata field Lore writes EXCEPT
     * `updated_at`. The engine overwrites `updated_at` with its own rfc3339 server time on every
     * update / update-by-query (audit_on_update_into, handlers.rs, on by default), so after the
     * first change the stored value never equals the caller's `metadata.updatedAt` and comparing
     * it made every later identical store() re-embed and re-write (review B #3). The caller's own
     * timestamp is NOT kept in a separate column: a new column on an existing collection is the
     * schema-drift problem of review B #4. On cloud, `updatedAt` read back is therefore the
     * server write time once a row has been updated (documented in docs/CLOUD_GAP_AUDIT.md).
     */
    private sameStoredMetadata(existing: StoredVerbatimRow, doc: VerbatimDocument): boolean {
        if ((existing.text ?? '').startsWith('[TOMBSTONED')) return false;
        const m = doc.metadata;
        const sortedJoin = (a: readonly string[] | undefined) => JSON.stringify([...(a ?? [])].sort());
        return (existing.type ?? '') === (m?.type || '')
            && (existing.label ?? '') === (m?.label || '')
            && (existing.tags ?? '') === (m?.tags || '')
            && (existing.project ?? '') === (m?.project || '')
            && (existing.ecosystem ?? '') === (m?.ecosystem || '')
            && sortedJoin(existing.security_scopes) === sortedJoin(Array.isArray(m?.security_scopes) ? (m!.security_scopes as string[]) : []);
    }

    /**
     * SW-20 (E3) / cloud parity B item 3: bulk-resolve logical id -> content_hash in chunked
     * `lore_id in (...)` queries (200 ids each), scoped by org + Lore workspace with the
     * client-side guard applied to every row. Ids with no row or no hash are absent from the
     * map (callers treat that as "changed", same as a local getById miss).
     */
    async getContentHashesByIds(ids: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        if (ids.length === 0) return out;
        const scope = this.scope();
        await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
        const rows = await fetchRowsByIds(this.client, scope, VERBATIM_COLLECTION, this.connection, ids,
            ['lore_id', 'content_hash', 'org_id', 'lore_workspace'], 'dataplaneVectorStore.getContentHashesByIds');
        for (const [id, r] of rows) {
            const hash = r['content_hash'];
            if (typeof hash === 'string' && hash !== '') out.set(id, hash);
        }
        return out;
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
     * storeBatch — batch write (cloud parity B item 10): dedupe ids (keep last), one scoped existence
     * query per 200 ids, skip-identical rows without embedding, then per-row scopedUpsert with bounded
     * concurrency (NOT `/bulk`: the engine ignores the caller id there — review B #1). See
     * dataplaneVerbatimBatch.ts.
     */
    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        if (docs.length === 0) return;
        try {
            const scope = this.scope();
            await this.ensureTenantInitialized(scope.dataplaneWorkspaceId);
            await storeVerbatimBatch({
                client: this.client,
                scope,
                collection: VERBATIM_COLLECTION,
                connection: this.connection,
                embedding: this.embeddingProvider,
                docs,
                hashOf: (d) => (d.metadata as { contentHash?: string } | undefined)?.contentHash || computeContentHash(d.text),
                projection: ['lore_id', 'org_id', 'lore_workspace', 'content_hash', 'text', 'type', 'label', 'tags', 'project', 'ecosystem', 'updated_at', 'security_scopes'],
                isUnchanged: (row, doc, hash) => {
                    if (isRevisionHistoryId(doc.id)) return false;
                    const stored = this.toStoredRow(row);
                    return stored.contentHash === hash && this.sameStoredMetadata(stored, doc);
                },
                buildFields: (doc, hash, vector) => this.rowFields(doc, hash, vector, this.hasRevisionColumn(scope)),
                revisionColumn: this.hasRevisionColumn(scope),
            });
        } catch (err) {
            throw new DataplaneVectorStoreError('storeBatch', (err as Error).message);
        }
    }
}
