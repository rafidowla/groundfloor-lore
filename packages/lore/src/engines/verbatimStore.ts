import * as lancedb from '@lancedb/lancedb';
import { Schema } from 'apache-arrow';
import * as fs from 'fs';
import { buildVerbatimSchema } from './verbatimSchema.js';
import * as path from 'path';

import type { EmbeddingProvider, VectorProvider, VerbatimDocument, VerbatimSearchResult } from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { checkCompatibility, readFingerprint, writeFingerprint } from './embeddingFingerprint.js';
import { applyActorScopeFilter } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import { LanceTablePool, resolveLancePoolSize } from './lanceTablePool.js';
import { resolvePoolMaxWaiters, resolvePoolAcquireTimeoutMs } from './poolLimits.js';
import { log } from '../logger.js';
import { timeRecallStage } from '../recall/recallStageTiming.js';
import { ReadCache, cacheKey } from './cache.js';
import { BoundedVectorCache } from './boundedVectorCache.js';
import { computeContentHash } from './contentHash.js';
import * as verbatimHistory from './verbatimHistory.js';
import { assertSafeLanceId, assertSafeLanceHash, isRevisionHistoryId, HISTORY_ID_LIKE_PATTERN } from './verbatimHistory.js';
import { redactSecrets } from '../security/secretScan.js';
import * as verbatimBatch from './verbatimBatch.js';
import type { VerbatimBatchCtx } from './verbatimBatch.js';
import { VERBATIM_CHUNK_SIZE } from './verbatimBatch.js';
import { embedBatchCap, awaitEmbedMemoryHeadroom } from '../embed/memoryBudget.js';
import { SearchGate } from './searchGate.js';
import {
    hasInterruptedBuild,
    clearAllBuildMarkers,
    dropAllIndices,
    isIndexCorruptionError,
} from './indexIntegrity.js';
import {
    writeTokenizerFingerprint as writeTokenizerFingerprintFile,
} from './ftsTokenizerProfile.js';
import type { FtsTokenizerSettings } from './ftsTokenizerProfile.js';
import { detectDesiredTokenizer, reconcileFtsTokenizer } from './verbatimFtsReconcile.js';
import type { FtsReconcileCtx } from './verbatimFtsReconcile.js';
import { makeBm25Envelope } from './verbatimBm25Result.js';
import type { VerbatimFtsRow, Bm25Envelope } from './verbatimBm25Result.js';
export type { VerbatimDocument, VerbatimSearchResult };

export class VerbatimStoreError extends Error {
    public operation: string;
    constructor(operation: string, message: string) {
        super(`[VerbatimStore:${operation}] ${message}`);
        this.name = 'VerbatimStoreError';
        this.operation = operation;
    }
}

export class VerbatimStore implements VectorProvider {
    private initialized: boolean = false;
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    /**
     * Read-side pool of N additional Table handles on the same on-disk
     * `lore_verbatim` table. Built lazily on first search() (or eagerly
     * in initialize() when the table already exists). Writes continue
     * to use `this.table` because LanceDB serializes writes at its
     * internal write lock regardless of handle count. See
     * packages/lore/src/engines/lanceTablePool.ts and Lore node
     * `rc3-deferred-embedding-recall-bottleneck`.
     */
    private readPool: LanceTablePool | null = null;
    private readPoolInit: Promise<LanceTablePool | null> | null = null;
    /**
     * Short-TTL result cache fronting the read pool.
     *
     * Why this exists: even with the LanceTablePool removing per-handle
     * dispatch serialization, the underlying vectorSearch is CPU/IO
     * saturated under 10-concurrent load — per-call cost stays at
     * ~500ms regardless of pool depth (verified empirically against a
     * high-volume production workspace). Recall is read-heavy and topics repeat
     * heavily across chat/UI/hook flows, so a short-TTL cache deflects
     * the bulk of concurrent identical queries to a microsecond
     * memory read.
     *
     * Cache vs single-flight: the cache handles repeated queries
     * across time (TTL ~1.5s = "this topic was just asked, reuse the
     * answer"). The in-flight registry handles SIMULTANEOUS identical
     * queries (10 callers arrive at the same moment, only 1 actually
     * hits LanceDB, the other 9 await the same promise). ReadCache.
     * memoize() is intentionally NOT single-flight, so we wire the
     * registry next to it rather than reaching into cache.ts.
     *
     * Invalidation: writes (store/storeBatch/tombstone/delete) call
     * bumpSearchEpoch(); the epoch is embedded in every cache key so
     * post-write reads can't observe pre-write entries.
     *
     * TTL chosen at 1500ms — long enough to deflect a burst, short
     * enough that staleness windows after a write are bounded even
     * before the epoch bump propagates (e.g. cross-process writes
     * never happen today, but if a sync engine ever ships pull-side
     * writes we want the bounded TTL as a safety net).
     */
    private readonly searchCache: ReadCache;
    // Shared in-flight registry — keyed by cacheKey(), which already
    // includes a `kind` discriminator ('verbatim-search' vs
    // 'verbatim-bm25'), so semantic + bm25 paths can share one map
    // without ever colliding on the same key.
    private readonly searchInFlight = new Map<string, Promise<VerbatimSearchResult[]>>();
    private searchCacheEpoch = 0;
    /** hc-verbatim-search-cache-hardcoded (NW-7c) — env override: LORE_SEARCH_CACHE_TTL_MS (default 1500 ms). */
    private static readonly SEARCH_CACHE_TTL_MS: number = (() => {
        const raw = process.env.LORE_SEARCH_CACHE_TTL_MS;
        if (!raw || raw.trim() === '') return 1500;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : 1500;
    })();
    private lancedbPath: string;
    private readonly embeddingProvider: EmbeddingProvider;
    private readonly verbatimSchema: Schema;

    /** Cached basePath so initialize() can read/write the fingerprint sidecar. */
    private readonly basePath: string;

    constructor(basePath: string, embeddingProvider?: EmbeddingProvider) {
        this.basePath = basePath;
        this.lancedbPath = path.join(basePath, '.lore', 'lancedb');
        fs.mkdirSync(this.lancedbPath, { recursive: true });
        // Default to the local Xenova provider when none is injected.
        // Slice 6b/7 will inject a different provider from the server
        // factory; existing direct constructions (CLI scripts, tests
        // built before 6a) keep working unchanged.
        this.embeddingProvider = embeddingProvider ?? new LocalEmbeddingProvider();
        this.verbatimSchema = buildVerbatimSchema(this.embeddingProvider.dimension);
        // SP-22: bumped to 500 — 200 could churn with moderately varied filters.
        // Key normalisation (sortedCacheKey) prevents unique-per-call proliferation
        // from filter/scope variations produced by recall loops.
        // hc-verbatim-search-cache-hardcoded (NW-7c): LORE_SEARCH_CACHE_MAX_ENTRIES overrides 500.
        const rawMax = process.env.LORE_SEARCH_CACHE_MAX_ENTRIES;
        const maxEntries = (rawMax && rawMax.trim() !== '' && Number.isFinite(Number(rawMax)) && Number(rawMax) > 0)
            ? Number(rawMax)
            : 500;
        this.searchCache = new ReadCache({
            maxSize: maxEntries,
            ttlMs: VerbatimStore.SEARCH_CACHE_TTL_MS,
            disabled: process.env.LORE_CACHE_DISABLED === '1',
        });
    }

    /** Bump the search-cache epoch so post-write reads cannot return
     *  pre-write entries. Called from every verbatim write path. */
    private bumpSearchEpoch(): void {
        this.searchCacheEpoch++;
    }

    /**
     * NW-4b — shared cache + single-flight wrapper for read paths.
     *
     * Why this exists: `search()` (semantic) had its own inline cache +
     * single-flight; `bm25Search()` (keyword) did not, so every hybrid
     * recall paid the full BM25 cost on repeated identical queries and
     * N concurrent identical queries duplicated work. Extracting the
     * wrapper here lets both paths share one cache (per epoch) and one
     * in-flight registry, keyed by a `kind` discriminator so semantic
     * and bm25 entries can never collide.
     *
     * Contract:
     *  - `kind` separates the namespaces ('verbatim-search' /
     *    'verbatim-bm25').
     *  - `params` is hashed via cacheKey()'s stable stringifier (sorted
     *    keys, recursive) so filter/scope variations don't churn.
     *  - The epoch is folded into the key, so any write that calls
     *    `bumpSearchEpoch()` invalidates BOTH search and bm25 entries
     *    in O(1) — matches the existing semantic-path semantics.
     *  - TTL is the existing SEARCH_CACHE_TTL_MS knob (unchanged).
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
                this.searchCache.set(key, result as unknown as VerbatimSearchResult[], VerbatimStore.SEARCH_CACHE_TTL_MS);
                return result;
            } finally {
                this.searchInFlight.delete(key);
            }
        })();
        // The in-flight map stores VerbatimSearchResult[] promises for
        // both kinds — they have the same result shape. The cast is
        // local to this helper.
        this.searchInFlight.set(key, promise as unknown as Promise<VerbatimSearchResult[]>);
        return await promise;
    }

    /**
     * Mutable context handed to the verbatimBatch.ts helpers (SW-31 split).
     * Getters/setters bind to `this` so first-write table creation and the
     * one-shot FTS-fallback flag land on the live instance, not a snapshot.
     * Built once and cached.
     */
    private _batchCtx: VerbatimBatchCtx | null = null;
    private get batchCtx(): VerbatimBatchCtx {
        if (this._batchCtx) return this._batchCtx;
        const self = this;
        this._batchCtx = {
            get initialized() { return self.initialized; },
            get db() { return self.db; },
            get table() { return self.table; },
            set table(t: lancedb.Table | null) { self.table = t; },
            get verbatimSchema() { return self.verbatimSchema; },
            get hashCache() { return self.hashCache; },
            get ftsFallbackWarned() { return self.ftsFallbackWarned; },
            set ftsFallbackWarned(v: boolean) { self.ftsFallbackWarned = v; },
            get lancedbPath() { return self.lancedbPath; },
            bumpSearchEpoch() { self.bumpSearchEpoch(); },
        };
        return this._batchCtx;
    }

    async initialize(): Promise<void> {
        try {
            if (this.initialized) return;
            // Warm the embedder so the first store()/search() doesn't
            // pay the model-load latency on the request path.
            await this.embeddingProvider.initialize();
            this.db = await lancedb.connect(this.lancedbPath);
            try {
                this.table = await this.db.openTable('lore_verbatim');
            } catch (e) {
                // Table doesn't exist yet; it will be created on first store()
                this.table = null;
            }
            // Embedding-model fingerprint check (slice 7 follow-up).
            // Two cases:
            //   1. Table exists + no fingerprint on disk → legacy store
            //      (pre-fingerprint MiniLM/384). Stamp it now so the
            //      next config change can detect a mismatch. We assume
            //      the configured provider is what the legacy operator
            //      used, which holds for the default install.
            //   2. Table exists + fingerprint exists → check it matches
            //      the configured provider. On mismatch, log a clear
            //      action item and continue (warn-only): refusing to
            //      start the daemon over a config drift would be worse
            //      UX than degraded retrieval until the operator runs
            //      `lore migrate embedding-model`.
            //   3. Table missing → defer the fingerprint write until
            //      first store(); we don't know yet that this install
            //      will actually use embeddings (some operators run
            //      core-only).
            const expected = {
                modelId: this.embeddingProvider.modelId,
                dimension: this.embeddingProvider.dimension,
            };
            const onDisk = readFingerprint(this.basePath);
            if (this.table && onDisk == null) {
                // Stamp legacy store with what the runtime provider thinks.
                try {
                    writeFingerprint(this.basePath, expected);
                } catch (err) {
                    // Best-effort; missing fingerprint is non-fatal.
                    log.error(`[VerbatimStore] could not stamp legacy fingerprint: ${(err as Error).message}`);
                }
            } else if (this.table && onDisk != null) {
                const compat = checkCompatibility(this.basePath, expected);
                if (!compat.matches) {
                    // Multi-line warn — mismatch is structurally important.
                    for (const line of compat.message.split('\n')) {
                        log.error(`[VerbatimStore] ${line}`);
                    }
                }
            }
            this.initialized = true;

            // CRASH-SAFE INDEX HEAL (2026-07-01). A build marker that survived
            // into this open means the last index build did not finish — the
            // on-disk index is suspect and reading it could hard-crash the
            // process (crash-loop). Heal BEFORE any read: drop every index
            // (metadata-only, safe on a corrupt index) so the table serves via
            // a brute-force scan, then rebuild in the background under the
            // exclusive gate. The base rows survive, so this fully self-heals a
            // workspace instead of bricking it. Runs before the read pool so
            // the pool builds on the healed (index-less) table.
            //
            // `healRan` (fix/fts-index-and-tokenizer) — when this branch runs
            // it already rebuilds the FTS index via the tokenizer-aware
            // ensureFtsIndex() below, so the proactive startup build right
            // after this block skips itself rather than doing the same work
            // (and the same table sample read) twice.
            let healRan = false;
            if (this.table && hasInterruptedBuild(this.lancedbPath)) {
                healRan = true;
                log.error('[VerbatimStore] Detected an interrupted index build for this workspace — the search index is suspect. Dropping it and rebuilding from the surviving data (self-heal).');
                try {
                    // SYNCHRONOUS heal: drop the suspect index then rebuild it
                    // before returning, so the store opens with a HEALTHY index
                    // and the first read never touches the corrupt one. (A
                    // half-built LanceDB index does not reliably brute-force
                    // after a bare drop — only a full drop+rebuild restores
                    // working search — and awaiting here also avoids a
                    // background rebuild racing a reactive heal into a
                    // CreateIndex commit conflict.) This blocks startup for the
                    // rebuild, which is acceptable: it only happens after a
                    // crash mid-build, and a clean workspace beats a fast-but-
                    // broken one. The rebuild's own markBuildStart/Done makes
                    // the rebuild itself crash-safe.
                    const dropped = await dropAllIndices(this.table);
                    log.info(`[VerbatimStore] Self-heal: dropped ${dropped} suspect index(es); rebuilding...`);
                    await verbatimBatch.ensureVectorIndex(this.batchCtx).catch((err) => {
                        log.error(`[VerbatimStore] vector index rebuild during heal failed (non-fatal): ${(err as Error).message}`);
                    });
                    await this.ensureFtsIndex().catch((err) => {
                        log.error(`[VerbatimStore] FTS index rebuild during heal failed (non-fatal): ${(err as Error).message}`);
                    });
                    // Belt-and-suspenders: clear any marker the rebuild didn't
                    // (e.g. a kind that stayed below the build threshold).
                    clearAllBuildMarkers(this.lancedbPath);
                    log.info('[VerbatimStore] Self-heal complete — search index rebuilt.');
                } catch (err) {
                    // Heal is best-effort; a failure here must not stop the
                    // store from opening.
                    log.error(`[VerbatimStore] index self-heal encountered an error (continuing): ${(err as Error).message}`);
                }
            }

            // PROACTIVE FTS INDEX BUILD AT OPEN (item 1): previously only
            // built reactively (after heal, a failed query, or the LIKE
            // fallback), so the FIRST query after any restart ran degraded.
            // Safe to run unconditionally — ensureFtsIndex/reconcile both
            // no-op once already correct — and runs under searchGate here
            // for free: nothing holds a read permit before the host starts
            // serving requests. Skipped when the heal above already rebuilt
            // the index with fresh tokenizer settings.
            if (this.table && !healRan) {
                await reconcileFtsTokenizer(this.ftsReconcileCtx).catch((err) => {
                    log.error(`[VerbatimStore] proactive FTS index build at open failed (non-fatal — degrades to the reactive build on first query): ${(err as Error).message}`);
                });
            }

            // PROACTIVE VECTOR INDEX MIGRATION AT OPEN (fix/lancedb-ivf-pq-
            // recall-loss): ensureVectorIndex is otherwise only invoked after
            // storeBatch() writes or during crash-heal — a workspace that is
            // simply reopened for READS (the common case: a restart with no
            // new writes) would keep a pre-fix IVF_PQ index forever, silently
            // returning wrong nearest-neighbours on every query. Runs
            // unconditionally like the FTS build above; ensureVectorIndex is
            // itself idempotent (skips once the index is already IvfFlat) so
            // this is a no-op on an already-migrated or below-threshold table.
            if (this.table && !healRan) {
                await this.ensureVectorIndex().catch((err) => {
                    log.error(`[VerbatimStore] proactive vector index build/migration at open failed (non-fatal — degrades to the reactive build after the next write): ${(err as Error).message}`);
                });
            }

            // Eagerly build the read pool if the table already exists.
            // First-install installs won't have a table yet — the pool
            // builds lazily on first search() once the table is
            // created by a store() call.
            if (this.table) {
                await this.ensureReadPool().catch((err) => {
                    // Non-fatal: search will fall back to the single
                    // handle. Log so operators see when the pool fails
                    // to build (it shouldn't, but better visible than
                    // silently degraded).
                    log.error(`[VerbatimStore] read pool init failed (falling back to single handle): ${(err as Error).message}`);
                });
            }
        } catch (error: any) {
            throw new VerbatimStoreError('initialize', error.message);
        }
    }

    /**
     * Lazily build the read-side pool. Idempotent + concurrency-safe:
     * concurrent first-callers all await the same in-flight init
     * promise. Returns null when the table doesn't exist (so the
     * caller falls back to the single-handle path that already
     * handles the empty-table case).
     */
    private async ensureReadPool(): Promise<LanceTablePool | null> {
        if (!this.db || !this.table) return null;
        if (this.readPool) return this.readPool;
        if (this.readPoolInit) return this.readPoolInit;
        const initStart = (async (): Promise<LanceTablePool | null> => {
            const pool = new LanceTablePool(this.db!, 'lore_verbatim', resolveLancePoolSize(), {
                maxWaiters: resolvePoolMaxWaiters(),
                acquireTimeoutMs: resolvePoolAcquireTimeoutMs(),
            });
            await pool.initialize();
            this.readPool = pool;
            return pool;
        })().finally(() => { this.readPoolInit = null; });
        this.readPoolInit = initStart;
        return initStart;
    }

    /** Test/observability hook — current pool sizing. Returns null
     *  when the pool hasn't been built yet (no table / not warmed). */
    readPoolStats(): { size: number; available: number; waitingCount: number } | null {
        if (!this.readPool) return null;
        return {
            size: this.readPool.size,
            available: this.readPool.available(),
            waitingCount: this.readPool.waitingCount(),
        };
    }

    /** SP-11 observability hook — current bounded-hashCache size. */
    hashCacheSize(): number { return this.hashCache.size; }

    /**
     * Verbatim is the institutional memory — it is never destructively
     * deleted. When a canonical id is overwritten, the previous row is
     * snapshotted as `<id>#rev<timestamp>` so the full revision history
     * is recoverable. When a node "goes away", call `tombstone(id, reason)`
     * which preserves the last-known content and marks the canonical row
     * as superseded. Snapshot rows are filtered out of `search()` by
     * default; pass `{ includeHistory: true }` to surface them.
     *
     * History row id format: `<canonicalId>#rev<unix-millis-iso>`.
     * Tombstone reason recorded in the canonical text prefix.
     */
    private isHistoryId(id: string): boolean {
        // Anchored to the internal `#rev<ISO timestamp>` suffix shape (audit
        // 5.6) — a node id merely CONTAINING '#rev' (URL fragment etc.) is a
        // canonical row, not a snapshot.
        return isRevisionHistoryId(id);
    }

    /**
     * Sprint Z2 — substrate-native bulk loader append path. Accepts
     * fully-built rows matching the verbatim schema (vector + columns)
     * and appends them in one table.add() call. Skip-embed semantics:
     * the caller (loadJobsRunner via LanceBulkLoaderAdapter) passes
     * placeholder zero-vectors so this method does NOT call the
     * embedding provider. The Sprint E re-embed job can backfill
     * later.
     *
     * Used by `lanceAdapter.addRows` via the LanceAddRowsFn callback
     * wired in mcp/server.ts. NOT a hot-path API — bulk loads only.
     */
    async bulkAddPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void> {
        return verbatimBatch.bulkAddPrebuiltRows(this.batchCtx, rows);
    }

    /**
     * SW-03 (B4) — ATOMIC prebuilt-row upsert keyed on `id`. The outbox
     * embed.batch path previously did `physicalDeleteMany(ids)` then
     * `bulkAddPrebuiltRows(rows)` (replace-then-add — there is no LanceDB
     * upsert in the bulk path). A crash/throw between the two left the
     * canonical vectors deleted-but-not-re-added: the nodes vanished from
     * /api/recall until a full re-embed. This collapses delete+add into a
     * single `mergeInsert('id')` op — the same atomic primitive store()
     * uses for the single-write canonical upsert (SP-18) — so a crash
     * leaves the OLD or NEW row, never neither.
     *
     * Chunked at the same CHUNK as physicalDeleteMany/storeBatch so a
     * large batch does not build an unbounded predicate / payload.
     */
    async bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void> {
        return verbatimBatch.bulkUpsertPrebuiltRows(this.batchCtx, rows);
    }

    async ensureVectorIndex(opts: { minRows?: number } = {}): Promise<boolean> {
        return verbatimBatch.ensureVectorIndex(this.batchCtx, opts);
    }

    /**
     * SW-20 (E11): ensure a full-text (FTS) index exists on the `text`
     * column, the keyword sibling of {@link ensureVectorIndex}.
     *
     * Without an FTS index, `bm25Search` falls back to a
     * `lower(text) LIKE '%...%'` full-table scan on every hybrid recall —
     * a full vector-table scan per query on a large corpus. Building the
     * index once lets LanceDB serve BM25 keyword search natively.
     *
     * Returns true if it built the index, false if already present, below
     * threshold, or unsupported by the installed LanceDB. Non-fatal on
     * error — bm25Search degrades to the LIKE fallback (now warned).
     *
     * This is now the ONE place an FTS build happens (every call site in
     * this class routes through it), so every build uses the SAME
     * language-aware tokenizer choice and the sidecar fingerprint never
     * drifts from disk. `opts.tokenizer` lets a caller (reconcileFtsTokenizer,
     * or a test) supply a precomputed choice; omitted, it auto-detects.
     */
    async ensureFtsIndex(opts: { minRows?: number; tokenizer?: FtsTokenizerSettings } = {}): Promise<boolean> {
        // Build under the EXCLUSIVE gate: it drains in-flight searches and blocks
        // new ones for the (one-time, short) build, so the index build never
        // overlaps live reads on the same LanceDB table — the concurrent
        // read-while-rebuild condition that hard-crashed the process. The build
        // is fired fire-and-forget from bm25Search's fallback path; the exclusive
        // acquire simply waits for that triggering read to release first.
        return this.searchGate.exclusive(async () => {
            const tokenizer = opts.tokenizer ?? await detectDesiredTokenizer(this.ftsReconcileCtx);
            const built = await verbatimBatch.ensureFtsIndex(this.batchCtx, { minRows: opts.minRows, tokenizer });
            if (built) {
                try {
                    writeTokenizerFingerprintFile(this.basePath, tokenizer);
                } catch (err) {
                    log.error(`[VerbatimStore] could not write FTS tokenizer fingerprint (non-fatal): ${(err as Error).message}`);
                }
            }
            return built;
        });
    }

    /** Mutable surface engines/verbatimFtsReconcile.ts needs from this
     *  instance. `ensureFtsIndex` closes over `this` so its rebuild call
     *  lands on the live gated/sidecar-writing path. Cached (batchCtx's pattern). */
    private _ftsReconcileCtx: FtsReconcileCtx | null = null;
    private get ftsReconcileCtx(): FtsReconcileCtx {
        if (this._ftsReconcileCtx) return this._ftsReconcileCtx;
        const self = this;
        this._ftsReconcileCtx = {
            get table() { return self.table; },
            get basePath() { return self.basePath; },
            ensureFtsIndex(opts) { return self.ensureFtsIndex(opts); },
        };
        return this._ftsReconcileCtx;
    }

    /** Guards against overlapping reactive heals (see scheduleIndexHeal). */
    private healing = false;

    /**
     * Reactive index self-heal, triggered when a READ hits a corrupt-index
     * error (the proactive sibling runs on open from a build marker). At most
     * one heal runs at a time. Fire-and-forget by contract: a read holds a
     * SearchGate permit, so it must NOT await the exclusive() heal inline or the
     * gate would deadlock (read waits for heal, heal waits for the read to
     * release). The heal takes the exclusive gate itself — draining in-flight
     * reads — drops the suspect indices, resets the read pool (so pooled handles
     * drop their stale index reference), clears markers, then rebuilds in the
     * background. The triggering query degrades to a brute-force/LIKE result or
     * a catchable "rebuilding" error; the process never dies.
     */
    private scheduleIndexHeal(): void {
        if (this.healing || !this.table) return;
        this.healing = true;
        void (async () => {
            try {
                const dropped = await this.searchGate.exclusive(async () => {
                    const n = this.table ? await dropAllIndices(this.table) : 0;
                    // Reset the read pool under the exclusive gate (in-flight
                    // reads already drained) so new handles reflect the drop.
                    if (this.readPool) {
                        await this.readPool.close().catch(() => undefined);
                        this.readPool = null;
                    }
                    return n;
                });
                clearAllBuildMarkers(this.lancedbPath);
                log.error(`[VerbatimStore] Reactive index self-heal after a read error: dropped ${dropped} suspect index(es); rebuilding in the background.`);
                void this.ensureVectorIndex().catch(() => { /* non-fatal */ });
                void this.ensureFtsIndex().catch(() => { /* non-fatal */ });
            } catch (err) {
                log.error(`[VerbatimStore] reactive index self-heal failed (non-fatal): ${(err as Error).message}`);
            } finally {
                this.healing = false;
            }
        })();
    }

    /**
     * Coerce a LanceDB-returned vector field into a plain number[].
     * Reads come back as Arrow Float32Array-backed structures; writing
     * those back as-is fails with "Found field not in schema: vector.isValid"
     * because Arrow's nullable-sentinel slots leak through. Iterating
     * by index produces a plain JS array LanceDB will accept.
     */
    private toPlainVector(v: unknown): number[] {
        if (!v) return [];
        if (Array.isArray(v)) {
            // Already a plain array, but Arrow may have leaked a single
            // FixedSizeList element (a nested array) — flatten one level
            // if so. Otherwise just coerce to numbers.
            if (v.length === 1 && Array.isArray((v as unknown[])[0])) {
                return ((v as unknown[])[0] as unknown[]).map((x) => Number(x));
            }
            return v.map((x) => Number(x));
        }
        // Arrow Vector — has .toArray() that yields the underlying TypedArray.
        const arrowLike = v as { toArray?: () => unknown };
        if (typeof arrowLike.toArray === 'function') {
            const inner = arrowLike.toArray();
            if (Array.isArray(inner)) {
                if (inner.length === 1 && Array.isArray(inner[0])) {
                    return (inner[0] as unknown[]).map((x) => Number(x));
                }
                return inner.map((x) => Number(x));
            }
            // toArray() can return a Float32Array directly.
            const ta = inner as { length?: number; [k: number]: number };
            if (typeof ta?.length === 'number') {
                const out: number[] = new Array(ta.length);
                for (let i = 0; i < ta.length; i++) out[i] = Number(ta[i]);
                return out;
            }
        }
        // Last-ditch: index access (Float32Array / TypedArray case).
        const indexed = v as { length?: number; [k: number]: number };
        if (typeof indexed.length === 'number') {
            const out: number[] = new Array(indexed.length);
            for (let i = 0; i < indexed.length; i++) out[i] = Number(indexed[i]);
            return out;
        }
        return [];
    }

    /** Same Arrow-sentinel coercion for List<Utf8> fields. */
    private toPlainStringList(v: unknown): string[] {
        if (!v) return [];
        if (Array.isArray(v)) return v.map((x) => String(x));
        const indexed = v as { length?: number; [k: number]: unknown };
        if (typeof indexed.length === 'number') {
            const out: string[] = new Array(indexed.length);
            for (let i = 0; i < indexed.length; i++) out[i] = String(indexed[i]);
            return out;
        }
        return [];
    }

    private async snapshotForRev(canonicalId: string): Promise<void> {
        if (!this.initialized || !this.table) return;
        if (this.isHistoryId(canonicalId)) return; // never snapshot a snapshot
        assertSafeLanceId(canonicalId, 'snapshotForRev'); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
        try {
            const safe = canonicalId.replace(/'/g, "''");
            const rows = await this.table
                .query()
                .where(`id = '${safe}'`)
                .limit(1)
                .toArray();
            if (rows.length === 0) return;
            const r = rows[0] as Record<string, unknown>;
            const ts = new Date().toISOString();
            const snapshotRow = {
                vector: this.toPlainVector(r.vector),
                id: `${canonicalId}#rev${ts}`,
                text: r.text ?? '',
                type: r.type ?? '',
                label: r.label ?? '',
                tags: r.tags ?? '',
                project: r.project ?? '',
                ecosystem: r.ecosystem ?? '',
                updatedAt: r.updatedAt ?? '',
                security_scopes: this.toPlainStringList(r.security_scopes),
                contentHash: r.contentHash ?? '',
            };
            await this.table.add([snapshotRow]);
        } catch (err) {
            log.error(`[VerbatimStore] snapshotForRev failed for ${canonicalId}: ${(err as Error).message}`);
        }
    }

    /**
     * Reconnect-fix Layer 1+3 (2026-04-30): in-memory contentHash → vector
     * cache populated lazily from LanceDB. Survives reconnect's full pass by
     * avoiding re-embedding any text whose contentHash already lives in the
     * table under any id. Embedder-version safe: embeddingFingerprint
     * rebuilds the whole table on model change, so any cached hash matches
     * the current embedder. SP-11 — bounded (LRU) via BoundedVectorCache;
     * its set() enforces the cap on every write.
     */
    private hashCache = new BoundedVectorCache(10_000);

    /** SW-20 (E11): one-shot guard so the no-FTS LIKE-scan warning logs once. */
    private ftsFallbackWarned = false;

    // Admission control for the native search engine. Bounds concurrent reads
    // (a burst of searches becomes an orderly line, not a native-layer stampede),
    // and the FTS index BUILD runs exclusively so it never overlaps live reads —
    // the "read while the index is being rebuilt" race that crashed the process.
    private readonly searchGate = new SearchGate();

    /**
     * Lookup a vector by contentHash. First tries the in-memory hashCache,
     * then queries LanceDB. Returns null on miss. Used by store() to
     * skip the expensive embed call.
     */
    private async lookupByContentHash(contentHash: string): Promise<Float32Array | number[] | null> {
        if (!contentHash) return null;
        const cached = this.hashCache.get(contentHash);
        if (cached) return cached;
        if (!this.table) return null;
        assertSafeLanceHash(contentHash, 'lookupByContentHash'); // SECURITY: assertSafeLanceHash — outside try so validation errors propagate
        try {
            const safe = contentHash.replace(/'/g, "''");
            const rows = await this.table
                .query()
                .where(`contentHash = '${safe}'`)
                .limit(1)
                .toArray();
            if (rows.length === 0) return null;
            const vec = (rows[0] as { vector?: Float32Array | number[] }).vector;
            if (!vec) return null;
            this.hashCache.set(contentHash, vec);
            return vec;
        } catch {
            return null;
        }
    }

    /**
     * SW-20 (E7): bulk-resolve contentHash → vector for storeBatch.
     *
     * storeBatch Phase 1 previously did `await lookupByContentHash(hash)`
     * once per doc — a 16k-doc reconnect issued up to 16k serial LanceDB
     * scans before embedding could start. This resolves the cache-miss
     * hashes in CHUNKED `contentHash IN (...)` queries (mirroring the
     * snapshot preflight's chunked id-IN), keeping the predicate string
     * bounded. The in-memory hashCache is consulted first (and refilled
     * with whatever the table returns), so semantics are identical to the
     * per-doc path — just fewer round-trips.
     *
     * Returns a Map keyed by contentHash → vector for every hash found.
     */
    private async bulkLookupByContentHash(
        hashes: string[],
    ): Promise<Map<string, Float32Array | number[]>> {
        return verbatimBatch.bulkLookupByContentHash(this.batchCtx, hashes);
    }

    async store(doc: VerbatimDocument): Promise<void> {
        try {
            if (!this.initialized || !this.db) {
                throw new Error('Store not initialized');
            }
            const rawText = doc.text;
            doc.text = redactSecrets(doc.text); // 2.6 — screen secrets before embed/persist
            const wasRedacted = doc.text !== rawText;

            // INTEGRITY (Audit 2026-05-13): embed FIRST, then snapshot+delete+add.
            // Previously the sequence was snapshot → delete-canonical → embed → add,
            // which meant a failed embed (OOM, model unloaded, provider 5xx) left
            // the canonical row deleted with the history snapshot present and no
            // live row — silent corruption of verbatim history. By embedding
            // first, a failure short-circuits BEFORE we touch the existing row.
            // Layer 1+3 — contentHash cache lookup.
            //
            // If the text is already embedded under any id (same
            // contentHash), reuse the vector instead of re-embedding.
            // This is the architectural fix that closes the
            // "post-cutover reconnect re-embeds everything" gap.
            //
            // Asymmetric models (e5 family) expect documents to be
            // prefixed "passage: " before tokenization. embedDocument
            // adds the prefix when the provider needs it; for
            // symmetric models (MiniLM, BGE-M3) it's a passthrough.
            // PR #69 P2: auto-compute when caller omits; supplied wins.
            const effectiveHash = (doc.metadata as { contentHash?: string })?.contentHash || computeContentHash(doc.text);
            // SP-13 — skip-identical: unchanged re-store is a no-op (no snapshot+delete+add + fragment). History ids bypass.
            // Audit 5.7 (2026-08-17): when redaction rewrote the text, NEVER
            // skip-identical — two genuinely-different inputs can redact to the
            // same '[REDACTED]' placeholder (and thus the same contentHash),
            // which would silently discard the second write.
            // 1.10 (2026-08-17 audit) — a TOMBSTONED row preserves the
            // ORIGINAL contentHash, so a re-store of the same content used to
            // match the stale hash and no-op, leaving the row invisible to
            // search/bm25 forever while reporting success. Never skip when
            // the existing row is a tombstone (the '[TOMBSTONED' marker that
            // search()/bm25Search() already exclude on).
            // 1.M9 — "identical" must also cover the metadata columns the row
            // persists; a text-only match used to silently drop metadata-only
            // updates (project/ecosystem/type/updatedAt/security_scopes).
            if (!this.isHistoryId(doc.id) && !wasRedacted && effectiveHash) {
                const existing = await this.getById(doc.id);
                if (existing && existing.contentHash === effectiveHash) {
                    const tombstoned = (existing.text ?? '').startsWith('[TOMBSTONED');
                    const sameScopes = JSON.stringify([...(existing.security_scopes ?? [])].sort())
                        === JSON.stringify([...(doc.metadata?.security_scopes ?? [])].sort());
                    const sameMetadata =
                        (existing.type ?? '') === (doc.metadata?.type || '') &&
                        (existing.label ?? '') === (doc.metadata?.label || '') &&
                        (existing.tags ?? '') === (doc.metadata?.tags || '') &&
                        (existing.project ?? '') === (doc.metadata?.project || '') &&
                        (existing.ecosystem ?? '') === (doc.metadata?.ecosystem || '') &&
                        (existing.updatedAt ?? '') === (doc.metadata?.updatedAt || '') &&
                        sameScopes;
                    if (!tombstoned && sameMetadata) return;
                }
            }
            let vector = await this.lookupByContentHash(effectiveHash);
            if (!vector) {
                vector = await this.embeddingProvider.embedDocument(doc.text);
                this.hashCache.set(effectiveHash, vector);
            }

            // Snapshot the prior canonical row into history before replacing it
            // (history rows — id contains `#rev` — bypass; already snapshots).
            if (!this.isHistoryId(doc.id)) {
                await this.snapshotForRev(doc.id);
            }

            const row = {
                vector: this.toPlainVector(vector), // PR #69 P2: normalize Float32Array from cache-hit
                id: doc.id,
                text: doc.text,
                type: doc.metadata?.type || '',
                label: doc.metadata?.label || '',
                tags: doc.metadata?.tags || '',
                project: doc.metadata?.project || '',
                ecosystem: doc.metadata?.ecosystem || '',
                updatedAt: doc.metadata?.updatedAt || '',
                security_scopes: doc.metadata?.security_scopes || [],
                contentHash: effectiveHash,
            };

            // C3-medium (2026-08-17) — race-safe first-write creation. Two
            // concurrent stores to a cold workspace both saw `!this.table` and
            // both called createEmptyTable; the loser threw "Table
            // 'lore_verbatim' already exists" (on the ingest-autolink path
            // that error was only console-logged — the node's semantic edges
            // were silently never drawn). ensureVerbatimTable turns the lost
            // race into an openTable; `createdTable` tells us whether WE
            // created it (plain add into a guaranteed-empty table is safe) or
            // must take the normal upsert path below.
            let createdTable = false;
            if (!this.table) {
                log.info('[VerbatimStore] Creating new table with explicit schema...');
                createdTable = (await verbatimBatch.ensureVerbatimTable(this.batchCtx)).created;
                if (createdTable) {
                    // Stamp the fingerprint at table-birth so subsequent
                    // daemon starts can detect a model-config drift.
                    try {
                        writeFingerprint(this.basePath, {
                            modelId: this.embeddingProvider.modelId,
                            dimension: this.embeddingProvider.dimension,
                        });
                    } catch (err) {
                        log.error(`[VerbatimStore] could not write fingerprint on table create: ${(err as Error).message}`);
                    }
                }
            }
            const table = this.table!; // set: either pre-existing or just ensured above
            if (createdTable) {
                await table.add([row]);
            } else if (this.isHistoryId(doc.id)) {
                // History rows are append-only snapshots — plain add.
                await table.add([row]);
            } else {
                // SP-18 — ATOMIC canonical upsert. Was delete(id)+add(row): a
                // crash between them lost the canonical row permanently (only
                // restorable manually from history, never via /api/recall).
                // LanceDB mergeInsert collapses delete+add into one atomic op
                // keyed on id — a crash leaves the old OR new row, never neither.
                await table
                    .mergeInsert('id')
                    .whenMatchedUpdateAll()
                    .whenNotMatchedInsertAll()
                    .execute([row]);
            }
            // Invalidate search cache so the next recall sees this write.
            this.bumpSearchEpoch();
        } catch (error: any) {
            throw new VerbatimStoreError('store', error.message);
        }
    }

    /**
     * Layer 2 (reconnect-fix, 2026-04-30) — batch store. For each input
     * doc:
     *   1. Look up by contentHash. If hit (same text already embedded),
     *      reuse the cached vector — no model call.
     *   2. Collect cache misses into a single batch.
     *   3. One embedDocumentBatch call for all misses.
     *   4. Append all rows to LanceDB.
     *
     * Falls back to per-item store() loop if the embedding provider
     * doesn't implement embedDocumentBatch (e.g. older OpenAI-compat
     * provider). Batch size capped at 32 to keep memory bounded —
     * Xenova's typical CPU batch sweet-spot is 16-64; on a 384-dim
     * model 32 fits in <1MB working memory.
     */
    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        if (!this.initialized || !this.db) {
            throw new Error('Store not initialized');
        }
        if (docs.length === 0) return;
        for (const d of docs) d.text = redactSecrets(d.text); // 2.6 — screen secrets
        // C3 3.2/3.3 (2026-08-17) — collapse duplicate canonical ids WITHIN
        // this batch, keep-last. Phase 3 below is ONE delete(id IN (...)) +
        // ONE table.add with a row per doc: two docs sharing an id (e.g. two
        // rapid edits consolidated into one outbox verbatim.upsert.batch run
        // by collectVerbatimUpsertRun) otherwise landed as TWO permanent
        // canonical rows, with getById returning the stale first one forever.
        // Batches arrive in temporal order (outbox sequence), so the last
        // occurrence is the newest intent. History ids (#rev snapshots) are
        // unique by construction; dedupe on the raw id is harmless for them.
        docs = verbatimBatch.dedupeByIdKeepLast(docs, (d) => d.id);
        if (docs.length === 0) return;

        // Layer 2 preflight (2026-04-30): instead of N round-trips (one
        // delete + one snapshot per doc), do ONE bulk query for the set
        // of canonical ids that already exist, write history snapshots
        // in one .add(), then ONE delete with id IN (...). Net: 3 ops
        // instead of 2N. The first per-item-loop implementation hung
        // for 25min on a 16k-doc batch because each LanceDB delete is
        // a small but non-trivial round-trip.
        //
        // C-R2-01 (HIGH, data-loss): the canonical DELETE is DEFERRED out of
        // this preflight into Phase 3 (just before the bulk add). Collect the
        // chunk predicates here; the actual delete runs only after embedding
        // succeeds, so a throw/crash during the seconds-long Phase 2 embed can
        // never leave canonicals deleted-but-not-re-added.
        const deferredCanonicalDeletes: string[] = [];
        if (this.table) {
            const targetIds = docs
                .filter((d) => !this.isHistoryId(d.id))
                .map((d) => d.id);
            if (targetIds.length > 0) {
                targetIds.forEach((id) => assertSafeLanceId(id, 'storeBatch.preflight')); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
                try {
                    // 1. Bulk query existing canonical rows.
                    // SP-25 F4: chunk the IN predicate (same CHUNK as physicalDeleteMany)
                    // so a large batch does not build an unbounded predicate string.
                    const existing: unknown[] = [];
                    const chunkEscIdsList: string[] = [];
                    for (let ci = 0; ci < targetIds.length; ci += VERBATIM_CHUNK_SIZE) {
                        const chunkIds = targetIds.slice(ci, ci + VERBATIM_CHUNK_SIZE);
                        const escChunk = chunkIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
                        chunkEscIdsList.push(escChunk);
                        const rows = await this.table.query().where(`id IN (${escChunk})`).toArray();
                        existing.push(...rows);
                    }

                    // 2. Bulk-add them as <id>#rev<ts> snapshots.
                    if (existing.length > 0) {
                        const ts = new Date().toISOString();
                        const snapshotRows = existing.map((r) => {
                            const rec = r as Record<string, unknown>;
                            return {
                                vector: this.toPlainVector(rec.vector),
                                id: `${String(rec.id ?? '')}#rev${ts}`,
                                text: rec.text ?? '',
                                type: rec.type ?? '',
                                label: rec.label ?? '',
                                tags: rec.tags ?? '',
                                project: rec.project ?? '',
                                ecosystem: rec.ecosystem ?? '',
                                updatedAt: rec.updatedAt ?? '',
                                security_scopes: this.toPlainStringList(rec.security_scopes),
                                contentHash: rec.contentHash ?? '',
                            };
                        });
                        // History snapshot is BEST-EFFORT — a snapshot write
                        // failure must not block the canonical update (but it must
                        // also not skip the delete below).
                        try {
                            await this.table.add(snapshotRows);
                        } catch (snapErr) {
                            log.error(`[VerbatimStore] storeBatch history snapshot failed (history may be incomplete): ${(snapErr as Error).message}`);
                        }

                        // 3. C-R2-01: DEFER the canonical delete to Phase 3
                        //    (after embed). Collect the predicates now; the
                        //    bulk-add in Phase 3 deletes immediately before it
                        //    adds, so the delete+add stay adjacent and a failed
                        //    embed in between leaves the canonicals intact.
                        for (const escChunk of chunkEscIdsList) deferredCanonicalDeletes.push(escChunk);
                    }
                } catch (err) {
                    // audit 2026-06-18 (HIGH, data integrity) — DO NOT swallow.
                    // The existing-canonical QUERY is not optional: its result
                    // drives the deferred Phase-3 delete that stops the bulk-add
                    // from creating DUPLICATE canonical ids. If it fails we cannot
                    // know which canonicals to retire, so propagate and let the
                    // whole batch fail atomically for the caller to retry — never
                    // add new canonicals over a failed preflight. (The history
                    // snapshot above is the one best-effort step; the canonical
                    // delete itself is deferred to Phase 3 per C-R2-01.)
                    log.error(`[VerbatimStore] storeBatch preflight failed — aborting batch to avoid duplicate canonicals: ${(err as Error).message}`);
                    throw err;
                }
            }
        }

        // Phase 1: cache lookup. PR #69 P2: auto-compute hash if omitted.
        // SW-20 (E7): resolve all hashes in CHUNKED `contentHash IN (...)`
        // queries up front instead of one serial `lookupByContentHash` scan
        // per doc — a 16k-doc reconnect previously issued up to 16k serial
        // LanceDB scans before embedding could start.
        type Resolved = { doc: VerbatimDocument; vector: Float32Array | number[] | null; hash: string };
        const hashes = docs.map(
            (doc) => (doc.metadata as { contentHash?: string })?.contentHash || computeContentHash(doc.text),
        );
        const hashToVector = await this.bulkLookupByContentHash(hashes);
        const resolved: Resolved[] = docs.map((doc, i) => {
            const hash = hashes[i];
            return { doc, vector: hashToVector.get(hash) ?? null, hash };
        });

        // Phase 2: batch-embed the misses.
        const missIndices = resolved
            .map((r, i) => (r.vector === null ? i : -1))
            .filter((i) => i >= 0);
        if (missIndices.length > 0 && this.embeddingProvider.embedDocumentBatch) {
            // MVP-mem (2026-06-28): per-call batch is RAM-adaptive (embedBatchCap;
            // ≥32 GB → 256, small machines lower) so a forward pass can't OOM a
            // constrained host, and awaitEmbedMemoryHeadroom() back-pressures the
            // run when this process is over its RAM budget. hot store() unchanged.
            const BATCH_SIZE = embedBatchCap();
            for (let i = 0; i < missIndices.length; i += BATCH_SIZE) {
                await awaitEmbedMemoryHeadroom();
                const slice = missIndices.slice(i, i + BATCH_SIZE);
                const texts = slice.map((idx) => resolved[idx].doc.text);
                const vectors = await this.embeddingProvider.embedDocumentBatch(texts);
                for (let j = 0; j < slice.length; j++) {
                    const idx = slice[j];
                    resolved[idx].vector = vectors[j];
                    if (resolved[idx].hash) this.hashCache.set(resolved[idx].hash, vectors[j]);
                }
            }
        } else if (missIndices.length > 0) {
            // Fallback: per-item embed (older provider with no batch support).
            for (const idx of missIndices) {
                const v = await this.embeddingProvider.embedDocument(resolved[idx].doc.text);
                resolved[idx].vector = v;
                if (resolved[idx].hash) this.hashCache.set(resolved[idx].hash, v);
            }
        }

        // Phase 3: append all rows to LanceDB in one .add() call.
        // Normalise vector to plain number[] — Arrow's schema inference
        // gets confused if some rows have Float32Array (from cache lookup
        // that read LanceDB's stored TypedArray) and others have number[]
        // (from a fresh embed call). Mixing produces "Found field not in
        // schema: vector.isValid" because Arrow tries to serialise the
        // TypedArray's null-bitmap as a separate column.
        const rows = resolved.map(({ doc, vector, hash }) => ({
            vector: this.toPlainVector(vector ?? []),
            id: doc.id,
            text: doc.text,
            type: doc.metadata?.type || '',
            label: doc.metadata?.label || '',
            tags: doc.metadata?.tags || '',
            project: doc.metadata?.project || '',
            ecosystem: doc.metadata?.ecosystem || '',
            updatedAt: doc.metadata?.updatedAt || '',
            security_scopes: doc.metadata?.security_scopes || [],
            contentHash: hash,
        }));

        // C3-medium — race-safe creation (see store()'s comment): open the
        // table a concurrent first write just made instead of throwing
        // "already exists"; only plain-add into a table WE created.
        let createdTable = false;
        if (!this.table) {
            createdTable = (await verbatimBatch.ensureVerbatimTable(this.batchCtx)).created;
            if (createdTable) {
                try {
                    writeFingerprint(this.basePath, {
                        modelId: this.embeddingProvider.modelId,
                        dimension: this.embeddingProvider.dimension,
                    });
                } catch (err) {
                    log.error(`[VerbatimStore] could not write fingerprint on table create: ${(err as Error).message}`);
                }
            }
        }
        const table = this.table!; // set: either pre-existing or just ensured above
        if (createdTable) {
            await table.add(rows);
        } else {
            // C-R2-01: embedding (Phase 2) has now succeeded — delete the prior
            // canonicals (collected in the preflight) immediately before the add
            // so we never duplicate them, while a failed embed above would have
            // thrown before reaching here, leaving the canonicals untouched.
            for (const escChunk of deferredCanonicalDeletes) {
                await table.delete(`id IN (${escChunk})`);
            }
            await table.add(rows);
        }

        // Bulk add touches a lot of canonical rows — invalidate the
        // search cache so the next recall sees the writes.
        this.bumpSearchEpoch();

        // Build the IVF-PQ index after a bulk add if we've crossed the
        // threshold. Idempotent — skips if already indexed. Surfaces
        // the build cost to the operator log so they know what's
        // happening on first reconnect.
        await this.ensureVectorIndex();

        // fix/fts-index-and-tokenizer (hole #4, adversarial-review find):
        // mirror the vector-index build for FTS. Without this, a store
        // populated via storeBatch() AFTER open() (the common embedded-host
        // pattern: initialize() on an empty table, then bulk-import) never
        // builds an FTS index until a LATER bm25Search() call reactively
        // triggers one — and every query before that reactive trigger runs
        // LanceDB's UNINDEXED brute-force full-text scan, which does NOT use
        // this class's configured tokenizer (baseTokenizer/stem/ngram — see
        // ftsTokenizerProfile.ts). That unindexed default measurably
        // mis-ranks queries with discriminating numeric/compound tokens
        // (verified: a corpus of near-identical docs differing only by a
        // trailing number returned uniform near-zero scores for every doc,
        // never surfacing the one genuine match — see
        // test/verbatim-search-worker-e2e.ts's worker/direct parity test).
        // Idempotent and gated the same way as ensureVectorIndex — safe to
        // call unconditionally after every bulk write.
        await this.ensureFtsIndex();
    }

    async search(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
        opts?: { includeHistory?: boolean },
        actorScopes?: ReadonlyArray<string>,
    ): Promise<VerbatimSearchResult[]> {
        if (!this.initialized || !this.table) {
            return [];
        }

        // Cache + single-flight wrap (extracted to cachedRead helper
        // in NW-4b so bm25Search can share the same machinery). Key
        // includes every argument that can change the result;
        // actorScopes is sorted so call-order doesn't fragment cache
        // entries. The actorScope post-filter (applyActorScopeFilter)
        // runs INSIDE the cached body so cached results already
        // reflect the caller's permissions — different scopes get
        // different cache entries.
        const sortedScopes = actorScopes
            ? [...actorScopes].sort()
            : (getCurrentActorScopes() ? [...getCurrentActorScopes()!].sort() : null);
        // SP-22: normalise filter to a stable, sorted shape so callers that
        // vary key insertion order or include undefined values don't generate
        // spurious cache misses and churn the LRU.
        const normFilter = filter
            ? Object.fromEntries(
                Object.entries(filter)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .sort(([a], [b]) => a.localeCompare(b)),
            )
            : null;
        return this.cachedRead<VerbatimSearchResult[]>(
            'verbatim-search',
            {
                q: query,
                limit,
                filter: normFilter,
                includeHistory: opts?.includeHistory ?? false,
                scopes: sortedScopes,
            },
            // Native read runs under the admission gate (bounded concurrency).
            // Wraps the loader, so cache HITS never take a permit — only real
            // native reads do.
            () => this.searchGate.read(() => this._searchUncached(query, limit, filter, opts, actorScopes)),
        );
    }

    /**
     * Vector search with a pre-computed query vector — the IPC path for
     * the search-worker proxy. The parent process embeds the query locally
     * and sends the vector to the child, so the child never loads an
     * embedding model for reads. Otherwise identical to {@link search}:
     * same filtering, actor-scoping, history exclusion, read-pool routing,
     * and cache/single-flight wrapping.
     *
     * @param queryVector - Pre-computed embedding vector (parent-embedded).
     * @param opts.topK    - Maximum results (default 10).
     * @param opts.filter  - Metadata field exact-match filter, AND'd.
     * @param opts.includeHistory - When true, history snapshots and
     *   tombstoned rows are included in results.
     * @param opts.actorScopes - Caller's security scopes for row-level
     *   filtering.
     */
    async searchByVector(
        queryVector: number[],
        opts?: {
            topK?: number;
            filter?: Partial<VerbatimDocument['metadata']>;
            includeHistory?: boolean;
            actorScopes?: ReadonlyArray<string>;
        },
    ): Promise<VerbatimSearchResult[]> {
        if (!this.initialized || !this.table) {
            return [];
        }
        const limit = opts?.topK ?? 10;
        // Cache + single-flight wrap (same machinery as search()).
        const sortedScopes = opts?.actorScopes
            ? [...opts.actorScopes].sort()
            : (getCurrentActorScopes() ? [...getCurrentActorScopes()!].sort() : null);
        const normFilter = opts?.filter
            ? Object.fromEntries(
                Object.entries(opts.filter)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .sort(([a], [b]) => a.localeCompare(b)),
            )
            : null;
        // Cache key uses a truncated-vector fingerprint so the key is small
        // but still distinct across different query vectors.
        const vecFingerprint = queryVector.slice(0, 8).map((v) => v.toFixed(4)).join(',');
        return this.cachedRead<VerbatimSearchResult[]>(
            'verbatim-searchByVector',
            {
                vecFp: vecFingerprint,
                limit,
                filter: normFilter,
                includeHistory: opts?.includeHistory ?? false,
                scopes: sortedScopes,
            },
            () => this.searchGate.read(() => this._runVectorSearchUncached(queryVector, limit, opts?.filter, opts?.includeHistory, opts?.actorScopes, 'searchByVector')),
        );
    }

    /** Shared uncached vector-search body for both search() (embeds locally
     *  then delegates) and searchByVector() (pre-computed parent vector).
     *  Filters, history exclusion, read-pool routing, row-level scoping,
     *  corruption self-heal — identical semantics for both entry points.
     *  @param operation - Operation label for VerbatimStoreError ('search'
     *    or 'searchByVector'). */
    private async _runVectorSearchUncached(
        vector: number[],
        limit: number,
        filter: Partial<VerbatimDocument['metadata']> | undefined,
        includeHistory: boolean | undefined,
        actorScopes: ReadonlyArray<string> | undefined,
        operation: string,
    ): Promise<VerbatimSearchResult[]> {
        try {
            const conditions: string[] = [];
            if (!includeHistory) {
                conditions.push(`id NOT LIKE '${HISTORY_ID_LIKE_PATTERN}'`);
                conditions.push("text NOT LIKE '[TOMBSTONED%'");
            }
            if (filter) {
                for (const [key, value] of Object.entries(filter)) {
                    // SECURITY (SP-05): allowlist key + escape value (see helpers).
                    if (value && !Array.isArray(value) && verbatimHistory.VERBATIM_FILTERABLE_COLUMNS.has(key)) {
                        conditions.push(`${key} = '${verbatimHistory.escapeSqlLiteral(String(value))}'`);
                    }
                }
            }
            const pool = await this.ensureReadPool();
            const runVectorSearch = async (tbl: lancedb.Table) => {
                let qb = tbl.vectorSearch(vector).limit(limit);
                if (conditions.length > 0) {
                    qb = qb.filter(conditions.join(' AND '));
                }
                return await qb.toArray();
            };
            const results = pool
                ? await pool.withTable(runVectorSearch)
                : await runVectorSearch(this.table!);
            const mapped = results.map((r: any) => ({
                id: r.id,
                score: 1 - (r._distance / 2),
                text: r.text,
                metadata: {
                    type: r.type,
                    label: r.label,
                    tags: r.tags,
                    project: r.project,
                    ecosystem: r.ecosystem,
                    updatedAt: r.updatedAt,
                    security_scopes: r.security_scopes || [],
                },
            }));
            return applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes());
        } catch (error: any) {
            if (isIndexCorruptionError(error)) {
                this.scheduleIndexHeal();
            }
            throw new VerbatimStoreError(operation, error.message);
        }
    }
    private async _searchUncached(
        query: string, limit: number,
        filter: Partial<VerbatimDocument['metadata']> | undefined,
        opts: { includeHistory?: boolean } | undefined, actorScopes: ReadonlyArray<string> | undefined,
    ): Promise<VerbatimSearchResult[]> {
        const vector = await timeRecallStage('embed', () => this.embeddingProvider.embedQuery(query));
        return timeRecallStage('vector', () => this._runVectorSearchUncached(vector, limit, filter, opts?.includeHistory, actorScopes, 'search'));
    }

    /**
     * V2.1: getById — Return the stored metadata (without re-running the
     * embedder) for a single id. Used by reconnectGraph's --only-changed
     * path to skip nodes whose contentHash hasn't changed.
     *
     * Returns null if the row doesn't exist or the table hasn't been
     * created yet.
     */
    async getById(id: string): Promise<{
        contentHash?: string;
        text?: string;
        type?: string;
        label?: string;
        tags?: string;
        project?: string;
        ecosystem?: string;
        updatedAt?: string;
        security_scopes?: string[];
    } | null> {
        return verbatimHistory.getById(this.table, this.initialized, id);
    }

    /**
     * SW-20 (E3): bulk-resolve canonical-id → contentHash in CHUNKED
     * `id IN (...)` queries instead of one `getById` round-trip per node.
     *
     * Reconnect's `--only-changed` skip-check previously called
     * `verbatim.getById(prefixedId)` once per LoreNode — at 1M nodes that's
     * 1M serial LanceDB scans. This resolves the whole set in
     * ceil(N / CHUNK) queries, mirroring the chunked-IN predicate already
     * used by storeBatch's snapshot preflight and physicalDeleteMany.
     *
     * Returns a Map keyed by the requested id → its stored contentHash.
     * Ids with no row (or no contentHash) are simply absent from the map,
     * which the caller treats as "changed" (re-embed) — same semantics as
     * a `getById` miss. Returns an empty Map when the table isn't built.
     */
    async getContentHashesByIds(ids: string[]): Promise<Map<string, string>> {
        return verbatimBatch.getContentHashesByIds(this.batchCtx, ids);
    }

    /**
     * F2b (Phase 7a): list every stored id, optionally filtered by prefix.
     * The orphan-embedding reaper uses `listIds('lore:')` to find
     * verbatim rows whose corresponding graph node no longer exists.
     *
     * `opts.project` (2026-06-09) — workspace-scoping filter. Required for
     * the consistency diagnostic when multiple workspaces alias the same
     * physical lance table (Sprint L5b: per-workspace separation is via
     * the `project` column). Without it the diagnostic reports the OTHER
     * aliased workspace's vectors as orphans.
     *
     * Returns [] if the table isn't initialized (caller treats as "no
     * records" — safe).
     */
    async listIds(prefix?: string, opts?: { project?: string }): Promise<string[]> {
        return verbatimHistory.listIds(this.table, this.initialized, prefix, opts);
    }

    /** Slice-4 EXPORT read path — every canonical verbatim row with its RAW
     *  embedding vector, plus this store's embed model id + dim so the caller
     *  can stamp a migration manifest and decide carry-vs-re-embed. Ensures the
     *  table is opened first (initialize is idempotent). See
     *  verbatimHistory.listRowsWithVectors. */
    async exportRows(opts?: { project?: string }): Promise<{
        modelId: string;
        dim: number;
        rows: verbatimHistory.VerbatimExportRow[];
    }> {
        await this.initialize();
        return {
            modelId: this.embeddingProvider.modelId,
            dim: this.embeddingProvider.dimension,
            rows: await verbatimHistory.listRowsWithVectors(this.table, this.initialized, opts),
        };
    }

    /**
     * @deprecated Verbatim is now append-only memory. Calls to this
     * method are routed to `tombstone()` so the prior content is
     * preserved with a "legacy delete" reason. Existing call sites
     * that were paired with a follow-up `store()` (i.e. update flows)
     * should drop the delete entirely — `store()` auto-snapshots.
     */
    async delete(id: string): Promise<void> {
        await this.tombstone(id, 'legacy verbatim.delete() call (no reason supplied)');
    }

    /** PR #69 P3 — hard delete (no tombstone). Used by the sweeper's
     *  orphan-cascade path; tombstones are for user-initiated deletes
     *  where history matters. Bumps search-cache epoch. */
    async physicalDelete(id: string): Promise<void> {
        assertSafeLanceId(id, 'physicalDelete'); // D2-inj-1: guard id before WHERE interpolation, mirroring physicalDeleteMany/tombstone — outside try so validation errors propagate
        try {
            if (!this.initialized || !this.table) return;
            await this.table.delete(`id = '${id.replace(/'/g, "''")}'`);
            this.bumpSearchEpoch();
        } catch (error) {
            throw new VerbatimStoreError('physicalDelete', (error as Error).message);
        }
    }

    /**
     * physicalDeleteMany — bulk hard-delete by id, batched into chunked
     * `id IN (...)` predicates. The per-id physicalDelete writes one LanceDB
     * version per row; at orphan-cleanup scale (tens of thousands) that is
     * pathologically slow and version-bloated. Batching collapses N deletes
     * into ceil(N/CHUNK) delete operations — seconds instead of tens of
     * minutes, and a handful of versions for compact() to merge.
     *
     * Returns the number of ids processed (ids are escaped + chunked; a
     * non-matching id in a chunk is a harmless no-op). Bumps the search
     * epoch once at the end.
     */
    async physicalDeleteMany(ids: string[]): Promise<number> {
        if (!this.initialized || !this.table || ids.length === 0) return 0;
        // SP-25 F2: reject oversized ids before building the IN predicate.
        // 512 chars is generous for any legitimate lore: / sha-style id.
        const MAX_ID_LEN = 512;
        for (const id of ids) {
            if (id.length > MAX_ID_LEN) {
                throw new VerbatimStoreError('physicalDeleteMany', `id too long (${id.length} chars; max ${MAX_ID_LEN})`);
            }
        }
        ids.forEach((id) => assertSafeLanceId(id, 'physicalDeleteMany')); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
        let processed = 0;
        try {
            for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
                const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
                const list = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
                await this.table.delete(`id IN (${list})`);
                processed += chunk.length;
            }
            this.bumpSearchEpoch();
            return processed;
        } catch (error) {
            throw new VerbatimStoreError('physicalDeleteMany', (error as Error).message);
        }
    }

    /**
     * compact — reclaim disk after bulk deletes (LanceDB `optimize`, modeled
     * on VACUUM): merge small fragments into larger ones + prune old versions.
     * Deleting N rows leaves the table fragmented (each delete writes a new
     * version); without this, freed rows still occupy disk. Called by the
     * consistency sweep after an orphan cascade-delete and by the on-demand
     * cleanup endpoint. Best-effort + idempotent (cheap no-op when already
     * optimized).
     *
     * `deleteUnverified` defaults to FALSE for safety — LanceDB will not prune
     * files newer than 7 days (they may belong to an in-progress write) unless
     * the caller can guarantee no concurrent writer. On a live multi-session
     * daemon we keep it false: the fragment-merge still reclaims the bulk of
     * the freed space, and recent-version disk is reclaimed within LanceDB's
     * 7-day window. Offline/quiet maintenance may pass true for immediate
     * full reclaim.
     */
    async compact(opts: { deleteUnverified?: boolean } = {}): Promise<{
        fragmentsRemoved: number;
        filesRemoved: number;
        bytesRemoved: number;
        oldVersionsRemoved: number;
    } | null> {
        if (!this.initialized || !this.table) return null;
        try {
            // 2026-06-09 — keep a 10-minute "grace window" on cleanupOlderThan
            // to avoid provoking lance#3718, the upstream race where
            // auto_cleanup deletes a manifest mid-commit. Lance's docs
            // (lancedb#2470) explicitly recommend a cleanup horizon at least
            // as long as the typical write latency. Passing `new Date()`
            // (now) maximizes the race window — observed as continuous
            // `auto_cleanup_hook` "manifest not found" errors and unbounded
            // _versions/ growth. The 10-min horizon still prunes essentially
            // every prunable version (writes settle in milliseconds), but
            // gives in-flight commits a safe head-start. Aggressive reclaim
            // (deleteUnverified:true) is the operator escape hatch for
            // quiet-window full reclaim.
            // hc-compact-grace-hardcoded (NW-7c): LORE_COMPACT_GRACE_MS overrides the 10-min default.
            const rawGrace = process.env.LORE_COMPACT_GRACE_MS;
            const GRACE_MS = (rawGrace && rawGrace.trim() !== '' && Number.isFinite(Number(rawGrace)) && Number(rawGrace) >= 0)
                ? Number(rawGrace)
                : 10 * 60 * 1000;
            const stats = await this.table.optimize({
                cleanupOlderThan: new Date(Date.now() - GRACE_MS),
                deleteUnverified: opts.deleteUnverified ?? false,
            });
            // optimize rewrites files — refresh the write handle so later
            // writes target the new manifest. Read-pool handles auto-refresh
            // via checkoutLatest() on acquire, so no pool reset is needed.
            try { await this.table.checkoutLatest(); } catch { /* best-effort */ }
            this.bumpSearchEpoch();
            return {
                fragmentsRemoved: stats.compaction?.fragmentsRemoved ?? 0,
                filesRemoved: stats.compaction?.filesRemoved ?? 0,
                bytesRemoved: stats.prune?.bytesRemoved ?? 0,
                oldVersionsRemoved: stats.prune?.oldVersionsRemoved ?? 0,
            };
        } catch (error) {
            throw new VerbatimStoreError('compact', (error as Error).message);
        }
    }

    /**
     * Mark the canonical row at `id` as superseded without losing its
     * content. Snapshots the previous content as `<id>#rev<ts>` and
     * rewrites the canonical row with a tombstone prefix that records
     * who/why. The row remains queryable (e.g. via `getById`) but is
     * filtered out of vector `search()` since its content is no longer
     * authoritative.
     *
     * History queries (`getHistory(id)`) include the tombstone
     * canonical row plus every preceding `#rev` snapshot.
     */
    async tombstone(id: string, reason: string): Promise<void> {
        assertSafeLanceId(id, 'tombstone'); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
        try {
            if (!this.initialized || !this.table) return;
            if (this.isHistoryId(id)) return; // never tombstone a snapshot
            const safe = id.replace(/'/g, "''");
            const rows = await this.table.query().where(`id = '${safe}'`).limit(1).toArray();
            if (rows.length === 0) return;
            const r = rows[0] as Record<string, unknown>;
            const existingText = String(r.text ?? '');
            if (existingText.startsWith('[TOMBSTONED')) return; // already tombstoned — no-op
            const ts = new Date().toISOString();
            // Snapshot the previous content under a #rev id (explicit
            // field copy — see snapshotForRev for why spread is unsafe
            // against Arrow-backed rows).
            const snapshotRow = {
                vector: this.toPlainVector(r.vector),
                id: `${id}#rev${ts}`,
                text: r.text ?? '',
                type: r.type ?? '',
                label: r.label ?? '',
                tags: r.tags ?? '',
                project: r.project ?? '',
                ecosystem: r.ecosystem ?? '',
                updatedAt: r.updatedAt ?? '',
                security_scopes: this.toPlainStringList(r.security_scopes),
                contentHash: r.contentHash ?? '',
            };
            await this.table.add([snapshotRow]);
            // Build the tombstone canonical content. Keep the original
            // text accessible after a "TOMBSTONED" marker so a human
            // (or recall) can still read what used to be there.
            const tombstoneText = `[TOMBSTONED ${ts} reason: ${reason}]\n\n${existingText}`;
            const newVector = await this.embeddingProvider.embedDocument(tombstoneText);
            // C3-medium (2026-08-17) — ATOMIC canonical replace. Was
            // delete(id) then add(row): a crash or a failing add between the
            // two permanently lost the canonical row while the caller saw
            // success. mergeInsert collapses them into one atomic op keyed on
            // id — the same SP-18 pattern store() already uses above; a crash
            // leaves the OLD or the tombstone row, never neither.
            await this.table
                .mergeInsert('id')
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute([{
                    vector: newVector,
                    id,
                    text: tombstoneText,
                    type: r.type ?? '',
                    label: r.label ?? '',
                    tags: r.tags ?? '',
                    project: r.project ?? '',
                    ecosystem: r.ecosystem ?? '',
                    updatedAt: ts,
                    security_scopes: this.toPlainStringList(r.security_scopes),
                    contentHash: r.contentHash ?? '',
                }]);
            // Tombstone is a logical delete from search results — invalidate.
            this.bumpSearchEpoch();
        } catch (error) {
            // 1.M10 (2026-08-17 audit) — was a bare `catch {}`: every failure
            // (LanceDB IO, embed provider down) was swallowed while callers
            // (delete_node, POST /api/verbatim/tombstone, prune_nodes,
            // bulk-delete, reap, auto-archive) reported success for a delete
            // that never happened. Propagate, mirroring physicalDelete's
            // VerbatimStoreError contract. The graceful no-op cases (store
            // not initialized, row absent, already tombstoned, history id)
            // still return normally above.
            throw new VerbatimStoreError('tombstone', (error as Error).message);
        }
    }

    /**
     * Return every revision row for `id`: the canonical row (current,
     * possibly tombstoned) plus every `<id>#rev*` snapshot, ordered
     * newest first. Empty array if nothing has ever been stored at
     * this id.
     */
    async getHistory(id: string): Promise<Array<{
        id: string;
        text: string;
        updatedAt: string;
        isTombstone: boolean;
        isCanonical: boolean;
    }>> {
        return verbatimHistory.getHistory(this.table, this.initialized, id);
    }

    /**
     * bm25Search — Fix #1: keyword-based BM25 search over the verbatim store.
     *
     * Tries LanceDB's native full-text search (FTS) first — indexed when an
     * index exists, or an unindexed brute-force scan otherwise; both are
     * ranked. Falls back to a substring scan against the `text` column
     * (same coverage as the old graph-engine CONTAINS path) ONLY when native FTS
     * itself errors (corrupt/unsupported index) — never merely because a
     * query legitimately found zero matches. A genuine no-match query
     * returns `{ hits: [], ranked: true }` directly; see
     * _bm25SearchUncached's inline comment for why re-scanning via LIKE on
     * a real zero-hit result would both regress the perf cliff this fix
     * closed and contradict the tokenizer's own stopword filtering.
     *
     * Returns a `Bm25Envelope`: `hits` in the same shape as `search()` so
     * callers can pass them to reciprocalRankFusion without a conversion
     * step, and `ranked` stating whether `hits` is a genuine BM25 ranking
     * (native FTS) or the unranked substring/LIKE fallback (every hit
     * forced to 1.0 — see verbatimBm25Result.ts). The signal used to be a
     * Symbol-keyed marker on the array; that did not survive the
     * search-worker process boundary or an intermediate `.map()` — see
     * verbatimBm25Result.ts's header for both confirmed failure modes. It
     * now travels explicitly inside the returned data instead.
     *
     * Used by the hybrid recall path in server.ts — run alongside the
     * semantic search leg and merge via RRF.
     */
    async bm25Search(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<Bm25Envelope<VerbatimSearchResult>> {
        if (!this.initialized || !this.table) return makeBm25Envelope([], true);
        // NW-4b — same cache + single-flight wrapper used by search().
        // Hybrid recall fires bm25 + semantic concurrently on every
        // call; without this, every hybrid round paid the full BM25
        // cost on repeated identical queries, and N concurrent
        // identical recalls duplicated the underlying FTS work.
        // Sorted-scopes / normalised-filter shape matches search()'s
        // key contract so identical bm25 args hit the same cache slot
        // regardless of caller key-insertion order.
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
            {
                q: query,
                limit,
                filter: normFilter,
                scopes: sortedScopes,
            },
            () => this.searchGate.read(() => timeRecallStage('fts', () => this._bm25SearchUncached(query, limit, filter, actorScopes))),
        );
    }

    /**
     * Uncached BM25 body. Wrapped by bm25Search() with cache +
     * single-flight (NW-4b). Split so the caching layer reads cleanly
     * without nesting another try/catch around the work.
     */
    private async _bm25SearchUncached(
        query: string,
        limit: number,
        filter: Partial<VerbatimDocument['metadata']> | undefined,
        actorScopes: ReadonlyArray<string> | undefined,
    ): Promise<Bm25Envelope<VerbatimSearchResult>> {
        try {
            if (!this.initialized || !this.table) return makeBm25Envelope([], true);

            const conditions: string[] = [
                `id NOT LIKE '${HISTORY_ID_LIKE_PATTERN}'`,
                "text NOT LIKE '[TOMBSTONED%'",
            ];
            if (filter) {
                for (const [key, value] of Object.entries(filter)) {
                    // SECURITY (SP-05): allowlist key + escape value (matches search()).
                    if (value && !Array.isArray(value) && verbatimHistory.VERBATIM_FILTERABLE_COLUMNS.has(key)) {
                        conditions.push(`${key} = '${verbatimHistory.escapeSqlLiteral(String(value))}'`);
                    }
                }
            }
            const whereClause = conditions.join(' AND ');

            // Native BM25 full-text search. `table.query().fullTextSearch(...)`
            // scores via the FTS index when one exists (fast) and transparently
            // falls back to an unindexed brute-force BM25 scan when it doesn't
            // (still correctly ranked, just O(n) — ensureFtsIndex closes that
            // gap once the table crosses minRows).
            //
            // PRIOR BUG (fix/fts-index-and-tokenizer): this used to call
            // `table.search(query, { queryType: 'fts' })`. Table.search's
            // SECOND parameter is a plain STRING ('vector' | 'fts' | 'auto'),
            // not an options object (node_modules/@lancedb/lancedb/dist/
            // table.js: `search(query, queryType = "auto", ftsColumns)`,
            // checked via `queryType === "fts"`). Passing an object silently
            // failed that check, fell through to embedding-based vector-search
            // inference, and threw "No embedding functions are defined in the
            // table" on EVERY call (verified empirically). That exception was
            // swallowed by the catch below, so native FTS never actually ran —
            // bm25Search always degraded straight to the LIKE scan, regardless
            // of whether an index existed. `table.query().fullTextSearch(...)`
            // is the real, always-available API for this LanceDB version.
            try {
                const rows = await this.table
                    .query()
                    .fullTextSearch(query, { columns: 'text' })
                    .filter(whereClause)
                    .limit(limit)
                    .toArray() as unknown as VerbatimFtsRow[];
                if (rows.length > 0) {
                    // Normalize scores to [0,1]. FTS score is BM25 — positive,
                    // higher = better, no fixed upper bound. Normalize by
                    // dividing by the max score in the result set.
                    const rawScores = rows.map((r) => Number(r._score ?? r.score ?? 1));
                    const maxScore = Math.max(...rawScores, 1);
                    const mapped = rows.map((r, i) => ({
                        id: String(r.id),
                        score: rawScores[i]! / maxScore,
                        text: String(r.text ?? ''),
                        metadata: {
                            type: r.type,
                            label: r.label,
                            tags: r.tags,
                            project: r.project,
                            ecosystem: r.ecosystem,
                            updatedAt: r.updatedAt,
                            security_scopes: r.security_scopes || [],
                        },
                    }));
                    // BM25-ranked (native FTS, indexed or brute-force) — safe
                    // to fuse via RRF.
                    return makeBm25Envelope(applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes()), true);
                }
                // Native FTS RAN SUCCESSFULLY and genuinely found zero rows —
                // NOT a "no usable index" situation, just no match. Return
                // that directly (ranked:true, empty hits) instead of falling
                // through to the LIKE scan below. Post-review fix (2026-08-04):
                // this branch used to fall through unconditionally, so EVERY
                // no-match keyword search paid a full-table LIKE scan — the
                // exact perf cliff the fallback comment warns about, moved
                // onto the common "no genuine match" path instead of the rare
                // "no usable index" path. It also contradicts the tokenizer:
                // a query term the tokenizer legitimately excludes (e.g. an
                // English stopword) correctly finding nothing via FTS should
                // NOT then be resurrected by a raw substring LIKE scan that
                // ignores stopword filtering entirely.
                return makeBm25Envelope([], true);
            } catch (ftsErr) {
                // FTS itself errored (not just "zero hits") — THIS is the
                // "no usable index" case the LIKE-scan safety net exists for.
                // If the FTS index is corrupt (vs simply absent/unsupported),
                // schedule a background self-heal so keyword search recovers
                // native speed instead of degrading to a LIKE scan forever.
                // Every non-throwing path above already returned, so falling
                // out of this try/catch only happens via this catch — the
                // LIKE scan below is reached ONLY on a genuine FTS error.
                if (isIndexCorruptionError(ftsErr)) {
                    this.scheduleIndexHeal();
                }
            }

            // Native FTS itself errored → degrade to a full-table LIKE scan
            // as a last-resort recall net. Now that storeBatch() proactively
            // rebuilds the FTS index and scheduleIndexHeal() repairs
            // corruption in the background, this path is a rare safety net,
            // not the common case — log at debug, not error, so a normal
            // no-match query never floods operator logs. Kick off a
            // best-effort index build so a future query gets index-
            // accelerated FTS again. Fire-and-forget — must not block this
            // recall.
            if (!this.ftsFallbackWarned) {
                this.ftsFallbackWarned = true;
                log.debug('[VerbatimStore] bm25Search: native FTS errored — falling back to a full-table LIKE scan (slow on large corpora, and every hit scores 1.0 — not a ranking). Building/repairing the FTS index in the background if the table qualifies.');
                void this.ensureFtsIndex().catch(() => { /* non-fatal */ });
            }

            // Substring fallback: scan text column for query terms.
            // Split query into tokens, require all to appear (AND semantics).
            const tokens = query
                .toLowerCase()
                .split(/\s+/)
                .filter((t) => t.length > 1);
            if (tokens.length === 0) return makeBm25Envelope([], true);

            const tokenClauses = tokens
                // D2-inj-2: escape LIKE wildcards (% _ \) then single-quotes, and append
                // ESCAPE '\' — mirrors the sibling LIKE paths (verbatimHistory escapeLanceLike)
                // so a query containing % or _ is matched literally, not as a wildcard.
                .map((t) => `lower(text) LIKE '%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/'/g, "''")}%' ESCAPE '\\'`)
                .join(' AND ');
            const fullWhere = `(${whereClause}) AND (${tokenClauses})`;

            const rows = await this.table
                .query()
                .where(fullWhere)
                .limit(limit)
                .toArray() as unknown as VerbatimFtsRow[];

            const mapped = rows.map((r) => ({
                id: String(r.id),
                score: 1.0, // binary substring match — NOT a ranking.
                text: String(r.text ?? ''),
                metadata: {
                    type: r.type,
                    label: r.label,
                    tags: r.tags,
                    project: r.project,
                    ecosystem: r.ecosystem,
                    updatedAt: r.updatedAt,
                    security_scopes: r.security_scopes || [],
                },
            }));
            // UNRANKED — every hit forced to 1.0. Callers (recall/retrieve.ts)
            // must not fuse this into RRF alongside genuinely-ranked results.
            return makeBm25Envelope(applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes()), false);
        } catch (error: any) {
            // Non-fatal — callers fall back to semantic-only retrieval. An
            // error is an UNKNOWN state, not a verified ranking — fail closed.
            log.error(`[VerbatimStore] bm25Search failed (non-fatal): ${error.message}`);
            return makeBm25Envelope([], false);
        }
    }

    async count(): Promise<number> {
        try {
            if (!this.initialized || !this.table) return 0;
            return await this.table.countRows();
        } catch (error: any) {
            return 0; // return 0 on error
        }
    }

    async close(): Promise<void> {
        try {
            this.initialized = false;
            // NW-1e — Drain the read pool BEFORE nulling this.db/this.table
            // so any in-flight `withTable(...)` (vectorSearch) gets to
            // finish on its borrowed Table handle before native close.
            // Closing a borrowed Table mid-query was a documented
            // use-after-close SIGSEGV on darwin-arm64 (audit:
            // conc-close-does-not-drain-inflight-reads). Drain has a
            // 5s timeout; on timeout we log + best-effort close, never
            // crash the daemon. Queued (not-yet-acquired) waiters are
            // rejected by drain() with a clear "pool is closed" error.
            if (this.readPool) {
                await this.readPool.close().catch(() => undefined);
                this.readPool = null;
            }
            this.db = null;
            this.table = null;
        } catch (error: any) {
            throw new VerbatimStoreError('close', error.message);
        }
    }
}
