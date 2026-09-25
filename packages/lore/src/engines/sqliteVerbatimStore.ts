/**
 * sqliteVerbatimStore.ts — SQLite-backed VerbatimStoreApi implementation.
 *
 * 3.21 step 2 part 1 (design: 321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md
 * section 1). `<ws>/.lore/verbatim.sqlite` — separate from `graph.sqlite` so
 * promotion (part 3) can retire it whole. Implements `VerbatimStoreApi`
 * directly (no subclassing — that seam is exactly what 3.21 step 2 part 0
 * built). Engine-specific concerns are split across sibling modules the
 * same way VerbatimStore splits into verbatimBatch.ts / verbatimHistory.ts:
 *
 *   - sqliteVerbatimSchema.ts  — DDL, pragmas, sqlite-vec load
 *   - sqliteVerbatimVector.ts  — vector search (native + JS brute force)
 *   - sqliteVerbatimFts.ts     — keyword (BM25) search, tokenizer selection
 *   - sqliteVerbatimHistory.ts — read-only queries (getById/listIds/export/history)
 *   - sqliteVerbatimWrite.ts   — write path (store/storeBatch/tombstone/delete)
 *
 * Semantics NOT reinvented — reused directly from the modules VerbatimStore
 * already shares: secret redaction (secretScan.ts), actor-scope filtering
 * (scopeFilter.ts), the Bm25Envelope contract (verbatimBm25Result.ts), the
 * embedding-fingerprint gate (verbatimFingerprintGate.ts /
 * embeddingFingerprint.ts — same JSON sidecar the Lance path reads/writes,
 * intentionally: vectors carry across promotion without re-embedding, so
 * both engines must agree on fingerprint identity), VERBATIM_CHUNK_SIZE /
 * dedupeByIdKeepLast (verbatimBatch.ts), buildVerbatimText (verbatimSchema.ts).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { log } from '../logger.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import type { EmbeddingProvider, VerbatimDocument, VerbatimSearchResult, VectorProvider, VerbatimQueryFilter } from '../providers/types.js';
import type { Bm25Envelope } from './verbatimBm25Result.js';
import type { FtsTokenizerSettings } from './ftsTokenizerProfile.js';
import type { VerbatimExportRow } from './verbatimHistory.js';
import type { VerbatimStoreApi } from './verbatimStoreApi.js';
import type { VerbatimStoreRole } from './verbatimStoreRole.js';
import { assertWritableRole } from './verbatimStoreRole.js';
import { applyFingerprintOnOpen, stampFingerprint } from './verbatimFingerprintGate.js';
import { applyActorScopeFilter } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import { redactSecrets } from '../security/secretScan.js';
import { buildSqlFilterEntries } from './verbatimHistory.js';
import { ReadCache, cacheKey } from './cache.js';
import { SqlitePieceIndex, type PieceSourceRow, type PieceSearchHit, type PieceIndexStatus } from './pieces/sqlitePieceIndex.js';

import { openSqliteVerbatimDb, type SqliteVecLoadResult } from './sqliteVerbatimSchema.js';
import { BruteForceVectorCache, nativeVectorSearch, decodeVector, encodeVector } from './sqliteVerbatimVector.js';
import { bm25Search as ftsBm25Search, detectSqliteTokenizer, currentFtsTokenizer, rebuildFtsTable } from './sqliteVerbatimFts.js';
import * as sqliteHistory from './sqliteVerbatimHistory.js';
import * as sqliteWrite from './sqliteVerbatimWrite.js';
import { maybeTriggerPromotion } from './verbatimPromotionTrigger.js';

export class SqliteVerbatimStore implements VerbatimStoreApi, VectorProvider {
    private initialized = false;
    private db: DatabaseType | null = null;
    private closed = false;
    private readonly basePath: string;
    private readonly embeddingProvider: EmbeddingProvider;
    private readonly role: VerbatimStoreRole;
    private readonly strictFingerprintCheck: boolean;
    private vecStatus: SqliteVecLoadResult = { loaded: false };
    private readonly vectorCache = new BruteForceVectorCache();
    /** D7 (3.23) — derived piece-level vector index (pieces/sqlitePieceIndex.ts).
     *  Nullable: it can only be constructed once `this.db` exists, i.e.
     *  inside initialize(); only ever populated when `pieceVectorsIntent`
     *  is on AND its sidecar is valid. */
    private pieceIndex: SqlitePieceIndex | null = null;
    private readonly pieceVectorsIntent: boolean;

    /**
     * Opus review follow-up (3.21 step 2): a short-TTL cache + single-flight
     * wrapper in front of search()/bm25Search() — the SAME `ReadCache`
     * class (cache.ts) VerbatimStore uses, not a Lance-specific mechanism
     * (cache.ts is already shared with SurrealGraph). SqliteVerbatimStore
     * previously implemented neither, which was flagged as a genuine
     * cross-engine semantics gap rather than an intentional Lance-only
     * feature: a SQLite-backed workspace paid a full query on every repeat
     * search, and N concurrent identical searches ran N times, where the
     * Lance path collapses both. Same contract: epoch-keyed invalidation
     * (bumped from onMutate(), which every write path already calls),
     * TTL via LORE_SEARCH_CACHE_TTL_MS (default 1500ms), max entries via
     * LORE_SEARCH_CACHE_MAX_ENTRIES (default 500), disable via
     * LORE_CACHE_DISABLED=1 — see verbatim-search-cache-unit.ts, routed
     * through both engines via test/helpers/testVerbatimStore.ts.
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

    /** 3.21 step 2 part 2 — cheap write counter for the auto-promotion
     *  trigger (design section 3: "a cheap counter, not COUNT(*)"). Seeded
     *  from one real COUNT(*) at initialize(), then incremented locally by
     *  every committed write. */
    private rowCountEstimate = 0;
    private readonly workspaceName?: string;
    private readonly home?: string;
    private readonly onLancePromoted?: (info: { newLanceDbPath: string }) => void | Promise<void>;

    constructor(
        basePath: string,
        embeddingProvider?: EmbeddingProvider,
        opts?: {
            role?: VerbatimStoreRole;
            strictFingerprintCheck?: boolean;
            /** Workspace name, when the caller already knows it — threaded
             *  into the auto-promotion trigger so it can flip
             *  workspaces.json's `vectorEngine` without a path-matching
             *  fallback lookup. */
            workspaceName?: string;
            /** LORE_HOME override, for the promotion trigger's own
             *  path-matching fallback when `workspaceName` is omitted. */
            home?: string;
            /** Called once a background promotion COMMITS — the resolver
             *  passes this to swap its cached store; omitted by callers
             *  (e.g. the boot store) that have nowhere to swap a live
             *  reference to. */
            onLancePromoted?: (info: { newLanceDbPath: string }) => void | Promise<void>;
            /** D7 (3.23) — whether piece-level vectors are on for this store.
             *  Already-resolved (host default + workspace override applied
             *  upstream, see openWorkspaceVerbatim.ts); this class only
             *  consumes the final boolean. */
            pieceVectors?: boolean;
        },
    ) {
        this.basePath = basePath;
        this.embeddingProvider = embeddingProvider ?? new LocalEmbeddingProvider();
        this.role = opts?.role ?? 'both';
        this.strictFingerprintCheck = opts?.strictFingerprintCheck ?? false;
        this.workspaceName = opts?.workspaceName;
        this.home = opts?.home;
        this.onLancePromoted = opts?.onLancePromoted;
        this.pieceVectorsIntent = opts?.pieceVectors ?? false;
        const rawMax = process.env.LORE_SEARCH_CACHE_MAX_ENTRIES;
        const maxEntries = (rawMax && rawMax.trim() !== '' && Number.isFinite(Number(rawMax)) && Number(rawMax) > 0)
            ? Number(rawMax)
            : 500;
        this.searchCache = new ReadCache({
            maxSize: maxEntries,
            ttlMs: SqliteVerbatimStore.SEARCH_CACHE_TTL_MS,
            disabled: process.env.LORE_CACHE_DISABLED === '1',
        });
    }

    /**
     * Cache + single-flight wrapper — mirrors VerbatimStore.cachedRead()
     * exactly (same key shape, same TTL knob, same in-flight-collapse
     * behavior), so the two engines share one observable contract even
     * though their loaders differ. `kind` namespaces 'verbatim-search' vs
     * 'verbatim-bm25' so the two read paths share one cache/map without
     * colliding.
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
                this.searchCache.set(key, result as unknown as VerbatimSearchResult[], SqliteVerbatimStore.SEARCH_CACHE_TTL_MS);
                return result;
            } finally {
                this.searchInFlight.delete(key);
            }
        })();
        this.searchInFlight.set(key, promise as unknown as Promise<unknown>);
        return await promise;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await this.embeddingProvider.initialize();
        const { db, tableExisted, vec } = await openSqliteVerbatimDb(this.basePath);
        this.db = db;
        this.vecStatus = vec;
        applyFingerprintOnOpen(this.basePath, tableExisted, this.embeddingProvider, this.strictFingerprintCheck);
        if (!tableExisted) {
            stampFingerprint(this.basePath, this.embeddingProvider, 'table birth');
        }
        // One real COUNT(*) at open — the ONE allowed per design section 3
        // ("a cheap counter, not COUNT(*)" refers to every WRITE after
        // this, not this one-time seed). Canonical rows only: history/
        // tombstone rows are not what the promotion threshold is sized
        // against.
        try {
            this.rowCountEstimate = (this.db!.prepare(
                `SELECT count(*) as c FROM verbatim WHERE is_canonical = 1`,
            ).get() as { c: number }).c;
        } catch {
            this.rowCountEstimate = 0;
        }
        this.initialized = true;
        this.closed = false;

        // D7 (3.23) — open/validate the derived piece index. Best-effort:
        // failures here must not block the canonical store from opening.
        try {
            this.pieceIndex = new SqlitePieceIndex(this.basePath, this.db, this.embeddingProvider);
            await this.pieceIndex.initialize({ intentOn: this.pieceVectorsIntent, canonicalIsEmpty: this.rowCountEstimate === 0 });
        } catch (err) {
            log.warn(`[SqliteVerbatimStore] piece index initialize failed (continuing without piece search): ${(err as Error).message}`);
        }
    }

    /** 3.21 step 2 part 2 — after every committed write, bump the cheap
     *  counter and check the auto-promotion threshold. Fire-and-forget:
     *  never awaited, never throws into the caller's write. */
    private checkPromotion(deltaRows: number): void {
        this.rowCountEstimate += deltaRows;
        maybeTriggerPromotion({
            basePath: this.basePath,
            workspaceName: this.workspaceName,
            home: this.home,
            rowCountEstimate: this.rowCountEstimate,
            dimension: this.embeddingProvider.dimension,
            onCommitted: this.onLancePromoted,
        });
    }

    private requireDb(): DatabaseType {
        if (!this.db) throw new Error('SqliteVerbatimStore: store not initialized');
        return this.db;
    }

    private onMutate = (): void => {
        this.vectorCache.invalidate();
        // Every write path (store/storeBatch/tombstone/delete/bulk*) calls
        // onMutate() already — bump the search-cache epoch here too so a
        // post-write search()/bm25Search() can never observe a pre-write
        // cache entry, matching VerbatimStore.bumpSearchEpoch()'s contract.
        this.searchCacheEpoch++;
    };

    private writeDeps(): sqliteWrite.SqliteWriteDeps {
        return { db: this.requireDb(), embeddingProvider: this.embeddingProvider, onMutate: this.onMutate };
    }

    // ---- writes ----------------------------------------------------------

    async store(doc: VerbatimDocument): Promise<void> {
        assertWritableRole(this.role, 'store');
        if (!this.initialized) return;
        await sqliteWrite.store(this.writeDeps(), doc);
        this.checkPromotion(1);
        // D7 (3.23) — best-effort piece maintenance. sqliteVerbatimWrite.ts
        // redacts doc.text into a LOCAL variable only (never writes it back
        // onto `doc`), unlike the Lance engine's store() which mutates
        // doc.text in place — so pieces must be built from an independently
        // redacted copy here, never the raw doc.text, to avoid embedding
        // un-redacted (potentially secret-containing) text.
        await this.pieceIndex?.upsertForRows([{
            id: doc.id, label: doc.metadata?.label, text: redactSecrets(doc.text), type: doc.metadata?.type,
            project: doc.metadata?.project, ecosystem: doc.metadata?.ecosystem, security_scopes: doc.metadata?.security_scopes,
        }]).catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece upsert failed for ${doc.id} (non-fatal): ${err.message}`));
    }

    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        assertWritableRole(this.role, 'storeBatch');
        if (!this.initialized || docs.length === 0) return;
        await sqliteWrite.storeBatch(this.writeDeps(), docs);
        this.checkPromotion(docs.length);
        // D7 (3.23) — same independent-redaction rationale as store() above.
        await this.pieceIndex?.upsertForRows(docs.map((doc) => ({
            id: doc.id, label: doc.metadata?.label, text: redactSecrets(doc.text), type: doc.metadata?.type,
            project: doc.metadata?.project, ecosystem: doc.metadata?.ecosystem, security_scopes: doc.metadata?.security_scopes,
        }))).catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece upsert failed for storeBatch (non-fatal): ${err.message}`));
    }

    async bulkAddPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void> {
        assertWritableRole(this.role, 'bulkAddPrebuiltRows');
        if (!this.initialized) return;
        sqliteWrite.bulkAddPrebuiltRows(this.writeDeps(), rows);
        this.checkPromotion(rows.length);
        // D7 (3.23) — bulk-loaded rows carry no redaction step upstream
        // (matches sqliteVerbatimWrite.ts's bulkAddPrebuiltRows, which does
        // not redact), so pieces are built from the row fields as supplied.
        await this.pieceIndex?.upsertForRows(rows as unknown as PieceSourceRow[])
            .catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece upsert failed for bulkAddPrebuiltRows (non-fatal): ${err.message}`));
    }

    async bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void> {
        assertWritableRole(this.role, 'bulkUpsertPrebuiltRows');
        if (!this.initialized) return;
        sqliteWrite.bulkUpsertPrebuiltRows(this.writeDeps(), rows);
        this.checkPromotion(rows.length);
        await this.pieceIndex?.upsertForRows(rows as unknown as PieceSourceRow[])
            .catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece upsert failed for bulkUpsertPrebuiltRows (non-fatal): ${err.message}`));
    }

    async delete(id: string): Promise<void> {
        await this.tombstone(id, 'legacy verbatim.delete() call (no reason supplied)');
    }

    async physicalDelete(id: string): Promise<void> {
        assertWritableRole(this.role, 'physicalDelete');
        if (!this.initialized) return;
        sqliteWrite.physicalDelete(this.writeDeps(), id);
        await this.pieceIndex?.deleteForIds([id]).catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece delete failed for ${id} (non-fatal): ${err.message}`));
    }

    async physicalDeleteMany(ids: string[]): Promise<number> {
        assertWritableRole(this.role, 'physicalDeleteMany');
        if (!this.initialized) return 0;
        const processed = sqliteWrite.physicalDeleteMany(this.writeDeps(), ids);
        await this.pieceIndex?.deleteForIds(ids).catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece delete failed for physicalDeleteMany (non-fatal): ${err.message}`));
        return processed;
    }

    async tombstone(id: string, reason: string): Promise<void> {
        assertWritableRole(this.role, 'tombstone');
        if (!this.initialized) return;
        await sqliteWrite.tombstone(this.writeDeps(), id, reason);
        // D7 (3.23) — tombstoned content is excluded from search/bm25Search,
        // so its pieces must also drop out of piece search.
        await this.pieceIndex?.deleteForIds([id]).catch((err: Error) => log.warn(`[SqliteVerbatimStore] piece delete failed for tombstone ${id} (non-fatal): ${err.message}`));
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
        const db = this.requireDb();
        const k = opts?.topK ?? 10;
        const q = Float32Array.from(queryVector);

        // D2: array-valued filter fields (e.g. `types: string[]`) become an
        // IN (...) pushdown instead of being silently dropped — see
        // buildSqlFilterEntries's docstring (verbatimHistory.ts).
        const filterEntries = buildSqlFilterEntries(opts?.filter as Record<string, unknown> | undefined);
        const extraWhereSql = filterEntries.map((e) => `${e.column} ${e.op}`).join(' AND ');
        const extraParams = filterEntries.flatMap((e) => e.params);
        // The SAME filter, shaped for the fallback path's post-filter
        // (see sqliteVerbatimVector.ts's RowFilter) — both paths MUST honor
        // an identical metadata filter regardless of which one serves the
        // query, or a native-vs-fallback toggle would silently change
        // result sets on a filtered search.
        const rowFilter = filterEntries.map((e) => [e.column, e.rowValue] as const);
        // includeHistory is not honored by the vector path on either engine
        // today — vector search only ever targets canonical, non-tombstoned
        // rows (matches VerbatimStore.searchByVector, which filters history
        // via a NOT LIKE clause it never lifts for this parameter either).

        let hits;
        if (this.vecStatus.loaded) {
            try {
                hits = nativeVectorSearch(db, q, k, extraWhereSql, extraParams);
            } catch {
                hits = this.vectorCache.search(db, queryVector.length, q, k, rowFilter);
            }
        } else {
            hits = this.vectorCache.search(db, queryVector.length, q, k, rowFilter);
        }

        const mapped: VerbatimSearchResult[] = hits.map((h) => ({
            id: h.row.id,
            score: h.score,
            text: h.row.text,
            metadata: {
                type: h.row.type ?? undefined,
                label: h.row.label ?? undefined,
                tags: h.row.tags ?? undefined,
                project: h.row.project ?? undefined,
                ecosystem: h.row.ecosystem ?? undefined,
                updatedAt: h.row.updatedAt ?? undefined,
                security_scopes: h.row.security_scopes ? JSON.parse(h.row.security_scopes) : [],
            },
        }));
        return applyActorScopeFilter(mapped, opts?.actorScopes ?? getCurrentActorScopes());
    }

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
            () => Promise.resolve(ftsBm25Search(this.requireDb(), query, limit, filter, actorScopes)),
        );
    }

    // ---- reads -------------------------------------------------------------

    async getById(id: string): ReturnType<VerbatimStoreApi['getById']> {
        if (!this.initialized) return null;
        return sqliteHistory.getById(this.requireDb(), id);
    }

    async getContentHashesByIds(ids: string[]): Promise<Map<string, string>> {
        if (!this.initialized) return new Map();
        return sqliteHistory.getContentHashesByIds(this.requireDb(), ids);
    }

    async listIds(prefix?: string, opts?: { project?: string; includeHistory?: boolean }): Promise<string[]> {
        if (!this.initialized) return [];
        return sqliteHistory.listIds(this.requireDb(), prefix, opts);
    }

    async exportRows(opts?: { project?: string }): Promise<{ modelId: string; dim: number; rows: VerbatimExportRow[] }> {
        await this.initialize();
        return {
            modelId: this.embeddingProvider.modelId,
            dim: this.embeddingProvider.dimension,
            rows: sqliteHistory.exportRows(this.requireDb(), opts),
        };
    }

    async getHistory(id: string): ReturnType<VerbatimStoreApi['getHistory']> {
        if (!this.initialized) return [];
        return sqliteHistory.getHistory(this.requireDb(), id);
    }

    /** Matches VerbatimStore.count()'s actual semantics EXACTLY: total
     *  physical row count, including history snapshots and tombstones —
     *  `table.countRows()` on the Lance side counts every row the table
     *  holds, with no is_canonical-equivalent filter. Parity, not a
     *  judgment that this is the more useful number (a store with a lot
     *  of edit history reports a much larger count than its live document
     *  count on EITHER engine — cross-engine test parity requires
     *  replicating that, not silently fixing it here). */
    async count(): Promise<number> {
        if (!this.initialized || !this.db) return 0;
        try {
            const row = this.db.prepare(`SELECT count(*) as c FROM verbatim`).get() as { c: number };
            return row.c;
        } catch {
            return 0;
        }
    }

    // ---- index maintenance ---------------------------------------------

    /** No ANN index is built for the sqlite-vec path (design section 1.1:
     *  a scalar-function full scan, not a vec0 index) — nothing to build.
     *  Always reports false. Kept on the interface for parity with Lance's
     *  `ensureVectorIndex`, which callers may invoke unconditionally. */
    async ensureVectorIndex(_opts?: { minRows?: number }): Promise<boolean> {
        return false;
    }

    /** Reconciles the FTS5 tokenizer against a fresh corpus sample — the
     *  SQLite analogue of the Lance path's index-build-is-the-one-place-
     *  tokenizer-drift-gets-fixed policy. Samples up to 200 canonical rows;
     *  rebuilds (drop+recreate+refill) only when the detected profile
     *  disagrees with what's on disk. Non-fatal: a failure here degrades to
     *  the existing tokenizer, matching the Lance path's stance. */
    async ensureFtsIndex(_opts?: { minRows?: number; tokenizer?: FtsTokenizerSettings }): Promise<boolean> {
        if (!this.initialized || !this.db) return false;
        try {
            const sample = this.db.prepare(
                `SELECT text FROM verbatim WHERE is_canonical = 1 LIMIT 200`,
            ).all() as Array<{ text: string }>;
            if (sample.length === 0) return false;
            const desired = detectSqliteTokenizer(sample.map((r) => r.text));
            const current = currentFtsTokenizer(this.db);
            if (current === desired) return false;
            rebuildFtsTable(this.db, desired);
            log.info(`[SqliteVerbatimStore] FTS5 tokenizer reconciled: ${current ?? '(none)'} -> ${desired}`);
            return true;
        } catch (err) {
            log.error(`[SqliteVerbatimStore] ensureFtsIndex failed (non-fatal): ${(err as Error).message}`);
            return false;
        }
    }

    /** SQLite's disk-reclaim equivalent of Lance's fragment-merge +
     *  version-prune `compact()`: `PRAGMA optimize` (query-planner stats)
     *  plus FTS5's `optimize` special command (merges the FTS b-tree
     *  segments the triggers accumulate). No fragment/version-count
     *  concept exists on this engine, so those fields report 0 — the
     *  interface shape is kept for parity, not because the numbers mean
     *  the same thing here. `deleteUnverified` has no SQLite analogue
     *  (there is no cross-process version-retention window to override)
     *  and is accepted but unused. */
    async compact(_opts?: { deleteUnverified?: boolean }): Promise<{
        fragmentsRemoved: number; filesRemoved: number; bytesRemoved: number; oldVersionsRemoved: number;
    } | null> {
        if (!this.initialized || !this.db) return null;
        try {
            this.db.exec(`INSERT INTO verbatim_fts(verbatim_fts) VALUES ('optimize')`);
            this.db.pragma('optimize');
            return { fragmentsRemoved: 0, filesRemoved: 0, bytesRemoved: 0, oldVersionsRemoved: 0 };
        } catch (err) {
            throw new Error(`[SqliteVerbatimStore:compact] ${(err as Error).message}`);
        }
    }

    /**
     * D7b — piece-level vector search delegator, mirroring
     * VerbatimStore.searchPieces's signature so retrieval routing can treat
     * both engines uniformly. `SqlitePieceIndex.searchPieces` already
     * accepts `string | number[]` and embeds internally only when given a
     * string (same as this class's own `search()` → `_searchUncached`), so
     * this delegator passes `query` straight through rather than resolving
     * it here — a raw string embeds once inside `SqlitePieceIndex`, and a
     * pre-embedded vector (as T1's direct store-level calls pass, see
     * `test/d7-piece-index-unit.ts` Section C) passes through untouched,
     * matching the `string | number[]` convention `VerbatimStore.
     * searchPieces` mirrors on the Lance side. `filter` is converted
     * through the same `buildSqlFilterEntries` → `RowFilter` shape
     * `searchByVector` already uses, so a piece query honors the identical
     * D2/E2 allowlist. No `gate` parameter: this engine has no cancellation
     * wiring on any read path today (`search`/`searchByVector` take none
     * either), so none is added here either — accepting one that no other
     * method on this class honors would be a false promise, not parity.
     */
    async searchPieces(
        query: string | number[],
        topK: number,
        filter?: VerbatimQueryFilter,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<PieceSearchHit[]> {
        if (!this.pieceIndex) return [];
        const filterEntries = buildSqlFilterEntries(filter as Record<string, unknown> | undefined);
        const rowFilter = filterEntries.map((e) => [e.column, e.rowValue] as const);
        return this.pieceIndex.searchPieces(query, topK, rowFilter, actorScopes ?? getCurrentActorScopes());
    }

    /** D7 (3.23) — observability/ops hook mirroring SqlitePieceIndex.status(). */
    pieceIndexStatus(): PieceIndexStatus {
        return this.pieceIndex?.status() ?? { open: false, valid: false, reason: 'not initialized' };
    }

    /** D7c — exposes this store's own piece-index instance for the migration
     *  CLI (pieceIndexBuild.ts) only; every other caller goes through
     *  searchPieces()/pieceIndexStatus() instead. */
    pieceIndexForMigration(): SqlitePieceIndex | null {
        return this.pieceIndex;
    }

    /** D7b — mirrors VerbatimStore.pieceVectorsIntentOn(); see its docblock
     *  for why retrieval routing needs intent as a signal distinct from
     *  index open/valid. */
    pieceVectorsIntentOn(): boolean {
        return this.pieceVectorsIntent;
    }

    // ---- observability / lifecycle -----------------------------------------

    readPoolStats(): { size: number; available: number; waitingCount: number } | null {
        // No read pool concept — one connection serves reads and writes
        // (SQLite's own MVCC/WAL readers handle concurrency at the file
        // level, not via a handle pool the way LanceDB's Table does).
        return null;
    }

    hashCacheSize(): number {
        // No separate hash cache — content-hash skip-identical reads
        // straight from the indexed content_hash column per call.
        return 0;
    }

    /** One better-sqlite3 connection — 1 while open, 0 once closed. Also
     *  reports which vector-search path is active via a debug log at
     *  initialize() (see initialize()'s vecStatus assignment); handleCount
     *  itself stays a plain number per the VerbatimStoreApi contract. */
    handleCount(): number {
        return this.db && !this.closed ? 1 : 0;
    }

    /** Which vector-search path this store is actually serving from —
     *  used by tests/ops to report native-vs-fallback without reaching
     *  into private state. */
    vectorSearchPath(): 'native' | 'fallback' {
        return this.vecStatus.loaded ? 'native' : 'fallback';
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.initialized = false;
        try {
            await this.pieceIndex?.close();
            this.db?.close();
        } catch (err) {
            throw new Error(`[SqliteVerbatimStore:close] ${(err as Error).message}`);
        } finally {
            this.db = null;
            this.vectorCache.invalidate();
        }
    }
}

// Re-exported for callers that need the raw BLOB codec (e.g. promotion's
// tail-copy in part 3) without reaching into sqliteVerbatimVector.ts directly.
export { encodeVector, decodeVector };
