/**
 * postgresVerbatimStore.ts — Postgres-backed VerbatimStoreApi implementation.
 *
 * Postgres engine, verbatim slice. Method-by-method port of
 * `engines/sqliteVerbatimStore.ts` + its sqliteVerbatim{Write,History,Fts,
 * Vector,Import,Schema} siblings onto the frozen pg foundations
 * (postgresClient.ts, postgresVerbatimSchema.ts): one shared `verbatim`
 * table, `workspace_id` as the leading key column, `text_tsv` tsvector + GIN
 * for keyword search, pgvector + HNSW (cosine ops) for vector search, and
 * the same is_canonical/is_tombstone history model.
 *
 * Engine-specific concerns are split across sibling modules the same way the
 * SQLite store splits:
 *
 *   - postgresVerbatim/postgresVerbatimVector.ts  — pgvector codec + fidelity notes
 *   - postgresVerbatim/postgresVerbatimWrite.ts   — store/storeBatch/bulk/delete/tombstone
 *   - postgresVerbatim/postgresVerbatimHistory.ts — getById/listIds/export/getHistory/getVectors
 *   - postgresVerbatim/postgresVerbatimFts.ts     — bm25Search (tsquery + ts_rank)
 *
 * Semantics NOT reinvented — reused directly from the engine-neutral modules
 * exactly as the SQLite engine does: secret redaction (secretScan.ts),
 * actor-scope filtering (scopeFilter.ts), the Bm25Envelope contract
 * (verbatimBm25Result.ts), the embedding-fingerprint gate
 * (verbatimFingerprintGate.ts / embeddingFingerprint.ts — the SAME JSON
 * sidecar `<basePath>/.lore/lancedb/embedding_model.json` the Lance and
 * SQLite paths read/write), VERBATIM_CHUNK_SIZE / dedupeByIdKeepLast /
 * suppliedVector (verbatimBatch.ts), the filter allowlist
 * (verbatimHistory.ts), getVectors validation (verbatimGetVectors.ts), and
 * the shared ReadCache (cache.ts).
 *
 * DIMENSION SOURCING (never hard-coded): initialize() reads the embedding
 * manifest via embeddingFingerprint.readFingerprint (the engine's own read
 * path); the column dimension is the manifest's `dimension`, falling back to
 * a pre-existing pgvector column's declared width, then to the provider's
 * own dimension (the Lance table-birth source of truth), and only when
 * nothing declares a width (e.g. a NullEmbeddingProvider, dimension 0) to
 * the engine's legacy default via readFingerprintOrLegacy (384 today). The
 * fingerprint gate then runs exactly as on SQLite: applyFingerprintOnOpen on
 * an existing table, stampFingerprint('table birth') on a fresh one.
 *
 * VECTOR-SEARCH APPROXIMATION (documented divergence): SQLite computes an
 * EXACT brute-force cosine over the whole (workspace-filtered) store, so
 * its top-k ordering and set are exact. pgvector serves
 * `ORDER BY vector <=> $q LIMIT k` from the HNSW index — approximate
 * ordering (approximate-KNN can miss the true k-th neighbor), and its
 * WHERE-clause predicates are applied to the index's candidate fetch
 * (pre-iterative-scan behavior), so a heavily-filtered search can return
 * FEWER than k rows even when more matches exist. At small scale the planner
 * seq-scans small tables (exact), but at scale the result SET of a filtered
 * vector search is approximate on this engine; the contract's score
 * conversion is kept (cosine distance → `score = 1 - distance`, same shape
 * as the SQLite path's `1 - vec_distance_cosine`).
 *
 * INTENTIONALLY NOT PORTED (not part of VerbatimStoreApi; SQLite-sidecar
 * subsystems):
 *   - the D7 piece index (pieces/sqlitePieceIndex.ts + searchPieces/
 *     pieceIndexStatus/pieceVectorsIntentOn) — a SQLite-file sidecar with
 *     its own tables; the frozen pg schema has no piece table;
 *   - auto-promotion to Lance (verbatimPromotionTrigger) — the postgres
 *     engine is terminal; `workspaceName`/`home`/`onLancePromoted` are
 *     accepted for constructor parity with SqliteVerbatimStore and unused;
 *   - FTS tokenizer reconciliation (ensureFtsIndex rebuild): 'simple' is
 *     baked into the frozen trigger; there is no tokenizer to drift;
 *   - the raw-import handle (SqliteVerbatimStore.openRawImport): a
 *     migrate-vectors CLI seam for files on disk, not an API member.
 *
 * POOL OWNERSHIP: the pool is INJECTED (constructed by the caller via
 * createPostgresPool, shared with the graph store). close() marks this
 * store closed but does NOT end the pool — postgresClient.closePostgresPool
 * is the pool owner's shutdown call (see also readPoolStats/handleCount).
 */

import type { Pool } from 'pg';

import { log } from '../../logger.js';
import { warmEmbeddingProvider } from '../../providers/embeddingWarmup.js';
import type { EmbeddingProvider, VerbatimDocument, VerbatimSearchResult, VectorProvider, VerbatimQueryFilter } from '../../providers/types.js';
import type { Bm25Envelope } from '../verbatimBm25Result.js';
import type { FtsTokenizerSettings } from '../ftsTokenizerProfile.js';
import type { VerbatimExportRow } from '../verbatimHistory.js';
import type { VerbatimStoreApi } from '../verbatimStoreApi.js';
import type { BulkAddResult } from '../verbatimBatch.js';
import type { VerbatimStoreRole } from '../verbatimStoreRole.js';
import { assertWritableRole } from '../verbatimStoreRole.js';
import { applyFingerprintOnOpen, stampFingerprint } from '../verbatimFingerprintGate.js';
import { readFingerprint, readFingerprintOrLegacy } from '../embeddingFingerprint.js';
import { applyActorScopeFilter } from '../../security/scopeFilter.js';
import { getCurrentActorScopes } from '../../security/actorContext.js';
import { normalizeGetVectorsIds } from '../verbatimGetVectors.js';
import { ReadCache, cacheKey } from '../cache.js';

import { LocalEmbeddingProvider } from '../../providers/localEmbeddingProvider.js';

import { createPostgresPool, closePostgresPool, type PostgresPoolOptions } from './postgresClient.js';
import { connectForStartup, runSchemaBootstrap } from './postgresStartup.js';
import { cachedVerbatimCount, invalidateVerbatimCount, DEFAULT_COUNT_CACHE_TTL_MS } from './postgresVerbatimCount.js';
import { ensureVerbatimSchema } from './postgresVerbatimSchema.js';
import { bm25Search as ftsBm25Search, pgFilterSql } from './postgresVerbatim/postgresVerbatimFts.js';
import * as pgHistory from './postgresVerbatim/postgresVerbatimHistory.js';
import * as pgWrite from './postgresVerbatim/postgresVerbatimWrite.js';
import * as pgVectorSearch from './postgresVerbatim/postgresVerbatimVectorSearch.js';
import { poolGuardFor } from './postgresPoolGuard.js';

/** getById's row shape — named here because the owning VerbatimStoreApi
 *  declaration inlines it (verbatimStoreApi.ts is outside this slice). */
export interface VerbatimGetByIdResult {
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

/** getHistory's entry shape — same reasoning as VerbatimGetByIdResult. */
export interface VerbatimHistoryEntry {
    id: string;
    text: string;
    updatedAt: string;
    isTombstone: boolean;
    isCanonical: boolean;
}

export class PostgresVerbatimStore implements VerbatimStoreApi, VectorProvider {
    private initialized = false;
    private closed = false;
    private pool: Pool | null = null;
    private readonly basePath: string;
    private readonly workspaceId: string;
    private readonly poolOrFactory: Pool | (() => Pool);
    private readonly embeddingProvider: EmbeddingProvider;
    private readonly role: VerbatimStoreRole;
    private readonly strictFingerprintCheck: boolean;
    /** Dimension ensureVerbatimSchema ran with — the embedding manifest's
     *  verdict (see header); informational after initialize(). */
    private dimension = 0;

    /**
     * Short-TTL cache + single-flight wrapper in front of search()/
     * bm25Search() — the SAME ReadCache contract SqliteVerbatimStore
     * implements (same key shape, same TTL knob, same in-flight collapse),
     * so both engines share one observable search-cache contract.
     */
    private readonly searchCache: ReadCache;
    private readonly searchInFlight = new Map<string, Promise<unknown>>();
    private searchCacheEpoch = 0;
    private static readonly SEARCH_CACHE_TTL_MS: number = (() => {
        const raw = process.env.LORE_SEARCH_CACHE_TTL_MS;
        if (!raw || raw.trim() === '') return 1500;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : 1500;
    })();

    private readonly workspaceName?: string;
    private readonly home?: string;
    private readonly onLancePromoted?: (info: { newLanceDbPath: string }) => void | Promise<void>;
    private readonly pieceVectorsIntent: boolean;
    private readonly countCacheTtlMs: number;

    constructor(
        basePath: string,
        poolOrFactory: Pool | (() => Pool),
        workspaceId: string,
        embeddingProvider?: EmbeddingProvider,
        opts?: {
            role?: VerbatimStoreRole;
            strictFingerprintCheck?: boolean;
            /** Mirrors SqliteVerbatimStore's promotion opts — accepted for
             *  construction-site parity, unused: this engine never promotes
             *  to Lance (see header). */
            workspaceName?: string;
            home?: string;
            onLancePromoted?: (info: { newLanceDbPath: string }) => void | Promise<void>;
            /** D7 piece-vectors intent — accepted, unused: the piece index
             *  is a SQLite-sidecar subsystem with no pg schema (see header). */
            pieceVectors?: boolean;
            /** count() cache TTL in ms (default 5000; 0 disables). Writes through any handle in this process invalidate it. */
            countCacheTtlMs?: number;
        },
    ) {
        if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
            throw new Error('PostgresVerbatimStore: workspaceId must be a non-empty string');
        }
        this.basePath = basePath;
        this.workspaceId = workspaceId;
        this.poolOrFactory = poolOrFactory;
        this.embeddingProvider = embeddingProvider ?? new LocalEmbeddingProvider();
        this.role = opts?.role ?? 'both';
        this.strictFingerprintCheck = opts?.strictFingerprintCheck ?? false;
        this.workspaceName = opts?.workspaceName;
        this.home = opts?.home;
        this.onLancePromoted = opts?.onLancePromoted;
        this.pieceVectorsIntent = opts?.pieceVectors ?? false;
        this.countCacheTtlMs = process.env.LORE_CACHE_DISABLED === '1' ? 0 : (opts?.countCacheTtlMs ?? DEFAULT_COUNT_CACHE_TTL_MS);
        const rawMax = process.env.LORE_SEARCH_CACHE_MAX_ENTRIES;
        const maxEntries = (rawMax && rawMax.trim() !== '' && Number.isFinite(Number(rawMax)) && Number(rawMax) > 0)
            ? Number(rawMax)
            : 500;
        this.searchCache = new ReadCache({
            maxSize: maxEntries,
            ttlMs: PostgresVerbatimStore.SEARCH_CACHE_TTL_MS,
            disabled: process.env.LORE_CACHE_DISABLED === '1',
        });
    }

    /**
     * Cache + single-flight wrapper — mirrors SqliteVerbatimStore.cachedRead
     * exactly (same `kind` namespacing, same epoch-keyed invalidation bumped
     * from onMutate(), same TTL knob), so a post-write search()/bm25Search()
     * can never observe a pre-write cache entry on EITHER engine.
     */
    private async cachedRead<T>(
        kind: string,
        params: Record<string, unknown>,
        loader: () => Promise<T>,
    ): Promise<T> {
        const key = cacheKey(kind, 'default', this.searchCacheEpoch, params);
        const cached = this.searchCache.get<T>(key);
        if (cached !== undefined) return cached;
        const inFlight = this.searchInFlight.get(key) as Promise<T> | undefined;
        if (inFlight) return inFlight;
        const promise = (async (): Promise<T> => {
            try {
                const result = await loader();
                this.searchCache.set(key, result as unknown as VerbatimSearchResult[], PostgresVerbatimStore.SEARCH_CACHE_TTL_MS);
                return result;
            } finally {
                this.searchInFlight.delete(key);
            }
        })();
        this.searchInFlight.set(key, promise as unknown as Promise<unknown>);
        return await promise;
    }

    private resolvePool(): Pool {
        if (this.pool) return this.pool;
        this.pool = typeof this.poolOrFactory === 'function' ? this.poolOrFactory() : this.poolOrFactory;
        return this.pool;
    }

    private requirePool(): Pool {
        if (!this.pool) throw new Error('PostgresVerbatimStore: store not initialized');
        return this.pool;
    }

    private onMutate = (): void => {
        // Every write path calls onMutate() — bump the search-cache epoch so
        // a post-write search()/bm25Search() can never observe a pre-write
        // cache entry. (The SQLite engine also drops its brute-force vector
        // cache here; pgvector is always the native path, nothing to drop.)
        this.searchCacheEpoch++;
        invalidateVerbatimCount(this.pool, this.workspaceId); // shared by every handle on this pool+workspace
    };

    private writeDeps(): pgWrite.PostgresVerbatimWriteDeps {
        return {
            pool: this.requirePool(),
            workspaceId: this.workspaceId,
            embeddingProvider: this.embeddingProvider,
            onMutate: this.onMutate,
        };
    }

    // ---- lifecycle ---------------------------------------------------------

    async initialize(): Promise<void> {
        if (this.initialized) return;
        // Best-effort warm-up: a model-cache failure must not fail open; the first embed retries.
        await warmEmbeddingProvider(this.embeddingProvider, '[PostgresVerbatimStore]');
        const pool = this.resolvePool();

        // Probe what already exists BEFORE running DDL: did the verbatim
        // table exist (the fingerprint gate's `tableExists` argument, the
        // pg analogue of openSqliteVerbatimDb's file-level check), and does
        // its vector column already declare a width (the pg analogue of
        // legacyStampDimension's Lance schema probe)?
        let tableExisted = false;
        let storedDim: number | null = null;
        const client = await connectForStartup(pool);
        try {
            const tbl = await client.query<{ present: boolean }>(
                `SELECT to_regclass('verbatim') IS NOT NULL AS present`,
            );
            tableExisted = !!tbl.rows[0]?.present;
            if (tableExisted) {
                const probe = await client.query<{ col_type: string }>(
                    `SELECT format_type(a.atttypid, a.atttypmod) AS col_type
                       FROM pg_attribute a
                      WHERE a.attrelid = to_regclass('verbatim')
                        AND a.attname = 'vector'
                        AND a.attnum > 0
                        AND NOT a.attisdropped`,
                );
                const match = /^vector\((\d+)\)$/.exec(String(probe.rows[0]?.col_type ?? ''));
                storedDim = match ? Number(match[1]) : null;
            }
        } finally {
            client.release();
        }

        // DIMENSION SOURCING — read, never hard-coded: the embedding
        // manifest the engine's own modules maintain; then a pre-existing
        // column's declared width; then the provider's own dimension (the
        // Lance table-birth source of truth); and only when nothing
        // declares a width (NullEmbeddingProvider is 0) the engine's legacy
        // default via readFingerprintOrLegacy. A manifest/stored-column
        // disagreement fails LOUDLY inside ensureVerbatimSchema's
        // ensureVectorColumn gate (frozen), before anything is written.
        const manifest = readFingerprint(this.basePath);
        const legacyDim = readFingerprintOrLegacy(this.basePath).dimension;
        const dimension = manifest?.dimension
            ?? storedDim
            ?? (this.embeddingProvider.dimension > 0 ? this.embeddingProvider.dimension : legacyDim);
        await runSchemaBootstrap(pool, { requirePgvector: true },
            (ddlClient) => ensureVerbatimSchema(ddlClient, this.workspaceId, dimension));
        this.dimension = dimension;

        // The SAME fingerprint policy as SqliteVerbatimStore.initialize():
        // gate on an existing table (strict mode refuses a mismatched
        // injected provider), stamp on table birth.
        applyFingerprintOnOpen(this.basePath, tableExisted, this.embeddingProvider, this.strictFingerprintCheck, storedDim);
        if (!tableExisted) {
            stampFingerprint(this.basePath, this.embeddingProvider, 'table birth');
        }

        this.initialized = true;
        this.closed = false;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.initialized = false;
        // Cancel this store's background jobs (compact / index builds) so close never leaves a statement running on the shared pool.
        if (this.pool) await poolGuardFor(this.pool).cancelOwner(this);
        // The pool is injected and shared (graph store + siblings): NOT ended
        // here. postgresClient.closePostgresPool(pool) is the owner's call —
        // see the header's POOL OWNERSHIP note.
    }

    /** Test/ops seam mirroring closePostgresPool's ownership rule: callers
     *  that OWN the pool drain it through postgresClient directly; this
     *  accessor exists so the owner does not need to keep its own reference
     *  when the store was built with a factory. */
    poolHandle(): Pool | null {
        return this.pool;
    }

    // ---- writes (postgresVerbatimWrite.ts) ---------------------------------

    async store(doc: VerbatimDocument): Promise<void> {
        assertWritableRole(this.role, 'store');
        if (!this.initialized) return;
        await pgWrite.store(this.writeDeps(), doc);
    }

    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        assertWritableRole(this.role, 'storeBatch');
        if (!this.initialized || docs.length === 0) return;
        await pgWrite.storeBatch(this.writeDeps(), docs);
    }

    async bulkAddPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<BulkAddResult> {
        assertWritableRole(this.role, 'bulkAddPrebuiltRows');
        // J4 — ids are bound as parameters (no Lance WHERE-predicate
        // injection surface), so no id is rejected here; the result shape
        // matches the Lance/SQLite stores'.
        if (!this.initialized) return { rejectedCount: 0, rejectedIds: [] };
        await pgWrite.bulkAddPrebuiltRows(this.writeDeps(), rows);
        return { rejectedCount: 0, rejectedIds: [] };
    }

    async bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void> {
        assertWritableRole(this.role, 'bulkUpsertPrebuiltRows');
        if (!this.initialized) return;
        await pgWrite.bulkUpsertPrebuiltRows(this.writeDeps(), rows);
    }

    async delete(id: string): Promise<void> {
        await this.tombstone(id, 'legacy verbatim.delete() call (no reason supplied)');
    }

    async physicalDelete(id: string): Promise<void> {
        assertWritableRole(this.role, 'physicalDelete');
        if (!this.initialized) return;
        await pgWrite.physicalDelete(this.writeDeps(), id);
    }

    async physicalDeleteMany(ids: string[]): Promise<number> {
        assertWritableRole(this.role, 'physicalDeleteMany');
        if (!this.initialized) return 0;
        return pgWrite.physicalDeleteMany(this.writeDeps(), ids);
    }

    /** 3.27.0 — hard-delete `ids` AND their revision history (history rows
     *  share the id on this engine, exactly like SQLite). */
    async purgeWithHistory(ids: string[]): Promise<number> {
        assertWritableRole(this.role, 'purgeWithHistory');
        if (!this.initialized) return 0;
        return pgWrite.purgeRows(this.writeDeps(), ids);
    }

    async tombstone(id: string, reason: string): Promise<void> {
        assertWritableRole(this.role, 'tombstone');
        if (!this.initialized) return;
        await pgWrite.tombstone(this.writeDeps(), id, reason);
    }

    // ---- vector search -----------------------------------------------------

    async search(
        query: string,
        limit: number = 10,
        filter?: VerbatimQueryFilter,
        opts?: { includeHistory?: boolean },
        actorScopes?: ReadonlyArray<string>,
    ): Promise<VerbatimSearchResult[]> {
        if (!this.initialized) return [];
        const sortedScopes = actorScopes
            ? [...actorScopes].sort()
            : (getCurrentActorScopes() ? [...getCurrentActorScopes()!].sort() : null);
        const normFilter = filter
            ? Object.fromEntries(
                Object.entries(filter)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .sort(([a], [b]) => a.localeCompare(b)),
            )
            : null;
        return this.cachedRead<VerbatimSearchResult[]>(
            'verbatim-search',
            { q: query, limit, filter: normFilter, includeHistory: opts?.includeHistory ?? false, scopes: sortedScopes },
            () => this._searchUncached(query, limit, filter, opts, actorScopes),
        );
    }

    private async _searchUncached(
        query: string,
        limit: number,
        filter?: VerbatimQueryFilter,
        opts?: { includeHistory?: boolean },
        actorScopes?: ReadonlyArray<string>,
    ): Promise<VerbatimSearchResult[]> {
        const vector = await this.embeddingProvider.embedQuery(query);
        return this.searchByVector(vector, { topK: limit, filter, includeHistory: opts?.includeHistory, actorScopes });
    }

    async searchByVector(
        queryVector: number[],
        opts?: {
            topK?: number;
            filter?: VerbatimQueryFilter;
            includeHistory?: boolean;
            actorScopes?: ReadonlyArray<string>;
        },
    ): Promise<VerbatimSearchResult[]> {
        if (!this.initialized) return [];
        // includeHistory is not honored by the vector path on either engine: vector search only ever
        // targets canonical, non-tombstoned rows (matches SqliteVerbatimStore.searchByVector).
        // HNSW = approximate ordering + candidate-fetch filtering (see the header's approximation note).
        return pgVectorSearch.searchOne(
            this.requirePool(), this.workspaceId, queryVector, opts?.topK ?? 10, opts?.filter, opts?.actorScopes,
        );
    }

    /**
     * Link-on-arrival: many stored-vector queries in ONE round trip (LATERAL over unnest, see
     * postgresVerbatimVectorSearch.ts). Same filtering / scoping as `searchByVector`.
     */
    async searchByVectors(
        queries: Array<{ key: string; vector: number[] }>,
        opts: { topK: number; filter?: VerbatimQueryFilter; actorScopes?: ReadonlyArray<string> },
    ): Promise<Map<string, VerbatimSearchResult[]>> {
        if (!this.initialized) return new Map(queries.map((q) => [q.key, []]));
        return pgVectorSearch.searchMany(this.requirePool(), this.workspaceId, queries, opts);
    }

    // ---- keyword search (postgresVerbatimFts.ts) ---------------------------

    async bm25Search(
        query: string,
        limit: number = 10,
        filter?: VerbatimQueryFilter,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<Bm25Envelope<VerbatimSearchResult>> {
        if (!this.initialized) return { hits: [], ranked: true };
        const sortedScopes = actorScopes
            ? [...actorScopes].sort()
            : (getCurrentActorScopes() ? [...getCurrentActorScopes()!].sort() : null);
        const normFilter = filter
            ? Object.fromEntries(
                Object.entries(filter)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .sort(([a], [b]) => a.localeCompare(b)),
            )
            : null;
        return this.cachedRead<Bm25Envelope<VerbatimSearchResult>>(
            'verbatim-bm25',
            { q: query, limit, filter: normFilter, scopes: sortedScopes },
            () => ftsBm25Search(this.requirePool(), this.workspaceId, query, limit, filter, actorScopes),
        );
    }

    // ---- reads (postgresVerbatimHistory.ts) --------------------------------

    async getById(id: string): Promise<VerbatimGetByIdResult | null> {
        if (!this.initialized) return null;
        return pgHistory.getById(this.requirePool(), this.workspaceId, id);
    }

    /** 3.27.0 — which of `ids` have a canonical row (batched getById; nodeDeleteMany). */
    async getExistingIds(ids: string[]): Promise<string[]> {
        if (!this.initialized || ids.length === 0) return [];
        return pgHistory.getExistingIds(this.requirePool(), this.workspaceId, ids);
    }

    /** 3.35.0 - bulkIngest's pre-embed probe (see postgresVerbatimWrite.ts). */
    async findUnchangedRowIds(rows: Array<Record<string, unknown>>): Promise<string[]> {
        if (!this.initialized || rows.length === 0) return [];
        return pgWrite.findUnchangedRowIds(this.writeDeps(), rows);
    }

    /** 3.27.1 - stored embeddings by exact canonical row id (engine-neutral;
     *  verbatimGetVectors.ts validation + pg bit-exact decode). */
    async getVectors(ids: string[]): Promise<Map<string, number[]>> {
        const unique = normalizeGetVectorsIds(ids);
        if (!this.initialized || unique.length === 0) return new Map();
        return pgHistory.getVectors(this.requirePool(), this.workspaceId, unique);
    }

    /** 3.34.0 (N5) — of `ids`, those ANSWERED BY THE VECTOR INDEX right now.
     *  On this engine stored == searchable, exactly like the local Lance/
     *  SQLite engines: a committed row is visible to the HNSW scan
     *  immediately (no ArcadeDB-style replication lag to self-check
     *  against), so the answer set is the getVectors predicate (canonical,
     *  non-tombstoned, a real embedding) — evaluated via the same
     *  bit-exact read. At most 1,000 ids per call (matches the contract's
     *  ArcadeDB bound). */
    async indexedIds(ids: string[]): Promise<Set<string>> {
        const unique = normalizeGetVectorsIds(ids, 'indexedIds');
        if (unique.length > 1_000) {
            throw new Error(`indexedIds: at most 1,000 ids per call (got ${unique.length}); split the batch`);
        }
        if (!this.initialized || unique.length === 0) return new Set();
        const stored = await pgHistory.getVectors(this.requirePool(), this.workspaceId, unique);
        return new Set(stored.keys());
    }

    async getContentHashesByIds(ids: string[]): Promise<Map<string, string>> {
        if (!this.initialized) return new Map();
        return pgHistory.getContentHashesByIds(this.requirePool(), this.workspaceId, ids);
    }

    async listIds(prefix?: string, opts?: { project?: string; includeHistory?: boolean }): Promise<string[]> {
        if (!this.initialized) return [];
        return pgHistory.listIds(this.requirePool(), this.workspaceId, prefix, opts);
    }

    async exportRows(opts?: { project?: string }): Promise<{ modelId: string; dim: number; rows: VerbatimExportRow[] }> {
        await this.initialize();
        return {
            modelId: this.embeddingProvider.modelId,
            dim: this.embeddingProvider.dimension,
            rows: await pgHistory.exportRows(this.requirePool(), this.workspaceId, opts),
        };
    }

    async getHistory(id: string): Promise<VerbatimHistoryEntry[]> {
        if (!this.initialized) return [];
        return pgHistory.getHistory(this.requirePool(), this.workspaceId, id);
    }

    /** Matches VerbatimStore.count()'s semantics EXACTLY (and SqliteVerbatim
     *  Store's port of it): total physical row count for this workspace,
     *  INCLUDING history snapshots and tombstones — no is_canonical filter.
     *  Cross-engine test parity requires replicating that, not fixing it. */
    async count(): Promise<number> {
        if (!this.initialized) return 0;
        try {
            const pool = this.requirePool();
            // Short-TTL, write-invalidated (postgresVerbatimCount.ts): recall asks per query and the scan is O(rows).
            return await cachedVerbatimCount(pool, this.workspaceId, async () => {
                const res = await pool.query<{ c: string }>(
                    `SELECT count(*) AS c FROM verbatim WHERE workspace_id = $1`,
                    [this.workspaceId],
                );
                return Number(res.rows[0]?.c ?? 0);
            }, this.countCacheTtlMs);
        } catch {
            return 0;
        }
    }

    // ---- index maintenance -------------------------------------------------

    /** Idempotent: true only when the HNSW index was actually built. The
     *  frozen schema creates `verbatim_vector_hnsw` at table birth, so this
     *  is a reconcile path for a store whose index was dropped out-of-band.
     *  `minRows` gates the build on canonical row count, like the Lance
     *  path's default. */
    async ensureVectorIndex(opts?: { minRows?: number }): Promise<boolean> {
        if (!this.initialized) return false;
        const pool = this.requirePool();
        try {
            if (opts?.minRows !== undefined) {
                const res = await pool.query<{ c: string }>(
                    `SELECT count(*) AS c FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 AND vector IS NOT NULL`,
                    [this.workspaceId],
                );
                if (Number(res.rows[0]?.c ?? 0) < opts.minRows) return false;
            }
            const existing = await pool.query(
                `SELECT 1 FROM pg_indexes
                 WHERE schemaname = current_schema() AND tablename = 'verbatim' AND indexname = 'verbatim_vector_hnsw'`,
            );
            if ((existing.rowCount ?? 0) > 0) return false;
            // Index build = background-class work: runs under the pool guard (needs a slot, keeps the foreground reserve free).
            const built = await poolGuardFor(pool).run('verbatim-hnsw-index', (c) =>
                c.query(`CREATE INDEX IF NOT EXISTS verbatim_vector_hnsw ON verbatim USING hnsw(vector vector_cosine_ops)`), { owner: this });
            if (!built.ran) return false;
            log.info(`[PostgresVerbatimStore] HNSW vector index built (verbatim_vector_hnsw)`);
            return true;
        } catch (err) {
            log.error(`[PostgresVerbatimStore] ensureVectorIndex failed (non-fatal): ${(err as Error).message}`);
            return false;
        }
    }

    /** Idempotent: true only when the GIN tsvector index was actually built.
     *  No tokenizer reconcile is possible or needed: 'simple' is baked into
     *  the frozen schema's trigger, so there is no on-disk tokenizer that
     *  can drift from a detected profile (the `tokenizer` opt is accepted
     *  for interface parity and intentionally unused — see header). */
    async ensureFtsIndex(_opts?: { minRows?: number; tokenizer?: FtsTokenizerSettings }): Promise<boolean> {
        if (!this.initialized) return false;
        const pool = this.requirePool();
        try {
            const existing = await pool.query(
                `SELECT 1 FROM pg_indexes
                 WHERE schemaname = current_schema() AND tablename = 'verbatim' AND indexname = 'verbatim_text_tsv_gin'`,
            );
            if ((existing.rowCount ?? 0) > 0) return false;
            const built = await poolGuardFor(pool).run('verbatim-fts-index', (c) =>
                c.query(`CREATE INDEX IF NOT EXISTS verbatim_text_tsv_gin ON verbatim USING gin(text_tsv)`), { owner: this });
            if (!built.ran) return false;
            log.info(`[PostgresVerbatimStore] GIN tsvector index built (verbatim_text_tsv_gin)`);
            return true;
        } catch (err) {
            log.error(`[PostgresVerbatimStore] ensureFtsIndex failed (non-fatal): ${(err as Error).message}`);
            return false;
        }
    }

    /** Postgres's disk-reclaim equivalent of the Lance fragment-merge and
     *  SQLite `PRAGMA optimize`+FTS-optimize compacts: `VACUUM ANALYZE` on
     *  the verbatim table (+ the changes-log). VACUUM reclaims only dead
     *  tuples and ANALYZE only refreshes planner stats — NEVER destructive
     *  to other workspaces' live rows — but both operate on the whole
     *  shared table: workspace-scoped vacuum does not exist in Postgres
     *  (documented). Best-effort: a
     *  failure is logged, never thrown into the caller (deviation from the
     *  SQLite compact, which rethrows — a vacuum failure here does not
     *  impair any subsequent read or write). No fragment/version-count
     *  concept exists on this engine; those fields report 0, the interface
     *  shape kept for parity. `deleteUnverified` has no analogue and is
     *  accepted but unused. */
    async compact(_opts?: { deleteUnverified?: boolean }): Promise<{
        fragmentsRemoved: number; filesRemoved: number; bytesRemoved: number; oldVersionsRemoved: number;
    } | null> {
        if (!this.initialized) return null;
        const pool = this.requirePool();
        try {
            // VACUUM cannot run inside a transaction block — a bare client
            // in autocommit, never withTransaction.
            // Background-class work: runs under the pool guard (postgresPoolGuard.ts). Skipped (null) when the pool
            // is too small to spare a connection beyond the foreground reserve, or when this store closes mid-run.
            const ran = await poolGuardFor(pool).run('verbatim-compact', async (client) => {
                await client.query(`VACUUM ANALYZE verbatim`);
                await client.query(`VACUUM ANALYZE verbatim_changes_log`);
            }, { owner: this });
            if (!ran.ran) return null;
            return { fragmentsRemoved: 0, filesRemoved: 0, bytesRemoved: 0, oldVersionsRemoved: 0 };
        } catch (err) {
            log.error(`[PostgresVerbatimStore:compact] best-effort vacuum failed (continuing): ${(err as Error).message}`);
            return null;
        }
    }

    // ---- observability / lifecycle -----------------------------------------

    readPoolStats(): { size: number; available: number; waitingCount: number } | null {
        // pg pool totals: checked-out (total - idle), idle, and queued
        // waiters — the pg analogue of the Lance pool stats hook.
        const pool = this.pool;
        if (!pool || this.closed) return null;
        return {
            size: pool.totalCount,
            available: pool.idleCount,
            waitingCount: pool.waitingCount,
        };
    }

    hashCacheSize(): number {
        // No separate hash cache — content-hash skip-identical reads
        // straight from the indexed content_hash column per call (same as
        // the SQLite engine).
        return 0;
    }

    /** One pg Pool (owning up to LORE_PG_POOL_MAX sockets) counts as one
     *  native handle while open, 0 once closed — the write-gate/close-drain
     *  contract's coarse counter, same 0/1 shape the SQLite engine reports
     *  for its single connection. */
    handleCount(): number {
        return this.pool && !this.closed ? 1 : 0;
    }

    /** Which vector-search path this store serves from — always 'native'
     *  (pgvector + HNSW; there is no JS fallback to report, unlike the
     *  SQLite engine's sqlite-vec toggle). Ops parity helper. */
    vectorSearchPath(): 'native' | 'fallback' {
        return 'native';
    }
}

export { closePostgresPool, createPostgresPool, type PostgresPoolOptions };
