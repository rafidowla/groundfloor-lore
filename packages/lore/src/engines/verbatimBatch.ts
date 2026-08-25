/**
 * verbatimBatch.ts — bulk / index helpers for VerbatimStore.
 *
 * Extracted from verbatimStore.ts (god-class split, SW-31). This module holds
 * the SW-25-era prebuilt-row bulk loaders (`bulkAddPrebuiltRows`,
 * `bulkUpsertPrebuiltRows`), the IVF-PQ / FTS index builders
 * (`ensureVectorIndex`, `ensureFtsIndex`), and the SW-20 chunked content-hash
 * resolvers (`getContentHashesByIds`, `bulkLookupByContentHash`).
 *
 * These functions take a small {@link VerbatimBatchCtx} carrying the mutable
 * bits they touch — the LanceDB connection + table handle, the verbatim
 * schema, the search-epoch bump, the bounded hash cache, and a one-shot
 * FTS-fallback-warned flag. VerbatimStore keeps thin delegators that pass a
 * `this`-bound context, so behavior is byte-for-byte identical: same chunk
 * sizes, same error swallowing, same `this.table` reassignment on first write,
 * same epoch bump, same cache refill.
 *
 * Why a context object (vs the (table, initialized) free-function shape used by
 * verbatimHistory.ts): unlike the pure passive reads in that module, these
 * helpers MUST be able to (a) create + REASSIGN the table handle on first
 * write, (b) bump the search-cache epoch, and (c) read/write the in-memory
 * hashCache. The context exposes exactly those couplings and nothing else.
 */

import * as lancedb from '@lancedb/lancedb';
import { Schema } from 'apache-arrow';

import { log } from '../logger.js';
import type { BoundedVectorCache } from './boundedVectorCache.js';
import { assertSafeLanceId, assertSafeLanceHash } from './verbatimHistory.js';
import { markBuildStart, markBuildDone } from './indexIntegrity.js';
import type { FtsTokenizerSettings } from './ftsTokenizerProfile.js';

/**
 * VERBATIM_CHUNK_SIZE — Row budget per LanceDB / IN-predicate batch operation.
 *
 * All verbatim bulk ops (upsert, delete, contentHash lookup, id→hash lookup,
 * storeBatch snapshot) chunk at this size so no single operation builds an
 * unbounded predicate string or payload. 500 rows × ~256 bytes ≈ 128 KB per
 * batch — well under LanceDB's practical payload cap.
 *
 * Exported so verbatimStore.ts (and future callers) share the one constant
 * rather than maintaining 5 independent inline copies (NW-7d).
 */
export const VERBATIM_CHUNK_SIZE = 500;

/**
 * dedupeByIdKeepLast — collapse duplicate `id` keys within ONE write batch,
 * keeping the LAST occurrence (2026-08-17, functional-correctness cluster 3,
 * findings 3.2/3.3/3.4).
 *
 * LanceDB's mergeInsert('id') reconciles source-vs-target, NOT duplicates
 * within the source batch itself: two rows sharing an id in one execute()
 * both land as separate physical canonical rows, and the row a later
 * getById/search happens to return first is (verified live) the STALE one —
 * permanently, since nothing re-consolidates after the fact. Callers hand us
 * batches in temporal order (outbox sequence order, bulkIngest array order),
 * so the last occurrence is the newest intent and must win.
 *
 * Used at both LanceDB write sinks (bulkUpsertPrebuiltRows here and
 * VerbatimStore.storeBatch) so every path that funnels into them — the SP-13
 * verbatim.upsert consolidation, the embed.batch consolidation, bulkIngest —
 * is covered regardless of which caller let a duplicate id through.
 */
export function dedupeByIdKeepLast<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
    const lastIndexById = new Map<string, number>();
    for (let i = 0; i < items.length; i++) lastIndexById.set(keyOf(items[i]!), i);
    if (lastIndexById.size === items.length) return [...items]; // no duplicates — common case
    const kept: T[] = [];
    for (let i = 0; i < items.length; i++) {
        if (lastIndexById.get(keyOf(items[i]!)) === i) kept.push(items[i]!);
    }
    return kept;
}

/**
 * Mutable surface the batch/index helpers need from VerbatimStore. Getters/
 * setters keep `this.table` / `this.ftsFallbackWarned` writes landing on the
 * live instance (a plain snapshot would let first-write table creation reassign
 * a local copy and silently lose the handle).
 */
export interface VerbatimBatchCtx {
    readonly initialized: boolean;
    readonly db: lancedb.Connection | null;
    table: lancedb.Table | null;
    readonly verbatimSchema: Schema;
    readonly hashCache: BoundedVectorCache;
    ftsFallbackWarned: boolean;
    /**
     * On-disk LanceDB directory for this store — the anchor for crash-safe
     * index-build markers (see indexIntegrity.ts). A build writes a marker
     * here before createIndex and clears it after, so a crash mid-build is
     * detectable on the next open.
     */
    readonly lancedbPath: string;
    bumpSearchEpoch(): void;
}

/**
 * ensureVerbatimTable — race-safe first-write table creation (2026-08-17,
 * functional-correctness cluster 3 medium: "Table 'lore_verbatim' already
 * exists").
 *
 * Two concurrent first writes to a cold workspace both observe `!ctx.table`
 * and both call createEmptyTable; the loser threw "already exists" — and on
 * the ingest-autolink path that error was only console-logged, so those
 * nodes silently never got semantic edges.
 *
 * Naively catching that error and calling openTable is NOT enough (verified
 * live): every racing caller then holds a DIFFERENT LanceDB table handle,
 * and a handle opened before the winner's first add() commits does not see
 * that row — a later mergeInsert on the stale handle insert-duplicates the
 * canonical row instead of matching it. So creation is SERIALIZED per store
 * instance through one shared in-flight promise: exactly one
 * createEmptyTable attempt, exactly one handle, every concurrent first write
 * awaits the same handle. The "already exists" catch remains as the
 * cross-process / leftover-dir fallback.
 *
 * Returns `created: true` when the shared ensure actually created the table
 * (all callers awaiting the creation see true), so callers can gate
 * table-birth side effects (fingerprint stamp). A plain add on the created
 * branch is safe for DISTINCT ids; a concurrent first write of the SAME id
 * is the separate 3.1-class double-writer race, closed at the
 * nodeService/autolink layer.
 */
const tableInitByCtx = new WeakMap<VerbatimBatchCtx, Promise<{ table: lancedb.Table; created: boolean }>>();

export async function ensureVerbatimTable(
    ctx: VerbatimBatchCtx,
): Promise<{ table: lancedb.Table; created: boolean }> {
    if (ctx.table) return { table: ctx.table, created: false };
    const inflight = tableInitByCtx.get(ctx);
    if (inflight) return inflight;
    if (!ctx.db) throw new Error('VerbatimStore: store not initialized');
    const db = ctx.db;
    const init = (async () => {
        try {
            ctx.table = await db.createEmptyTable('lore_verbatim', ctx.verbatimSchema);
            return { table: ctx.table, created: true };
        } catch (err) {
            // Cross-process / leftover-dir race — open what already exists.
            if (!/already exists/i.test((err as Error)?.message ?? '')) throw err;
            ctx.table = await db.openTable('lore_verbatim');
            return { table: ctx.table, created: false };
        }
    })();
    tableInitByCtx.set(ctx, init);
    // On failure clear the memo so a later call can retry; on success the
    // ctx.table fast-path above takes over.
    init.catch(() => tableInitByCtx.delete(ctx));
    return init;
}

/**
 * Sprint Z2 — substrate-native bulk loader append path. Accepts fully-built
 * rows matching the verbatim schema (vector + columns) and appends them in one
 * table.add() call. Skip-embed semantics: the caller passes placeholder
 * zero-vectors so this does NOT call the embedding provider.
 */
export async function bulkAddPrebuiltRows(
    ctx: VerbatimBatchCtx,
    rows: Array<Record<string, unknown>>,
): Promise<void> {
    if (rows.length === 0) return;
    if (!ctx.initialized || !ctx.db) {
        throw new Error('VerbatimStore.bulkAddPrebuiltRows: store not initialized');
    }
    // ensureVerbatimTable: a concurrent first write must open, not throw
    // "already exists" (see the helper's doc).
    const { table } = await ensureVerbatimTable(ctx);
    await table.add(rows as Array<{ [k: string]: unknown }>);
    ctx.bumpSearchEpoch();
}

/**
 * SW-03 (B4) — ATOMIC prebuilt-row upsert keyed on `id`. Collapses
 * delete+add into a single `mergeInsert('id')` op so a crash leaves the OLD or
 * NEW row, never neither. Chunked at the same CHUNK as physicalDeleteMany/
 * storeBatch so a large batch does not build an unbounded predicate / payload.
 */
export async function bulkUpsertPrebuiltRows(
    ctx: VerbatimBatchCtx,
    rows: Array<Record<string, unknown>>,
): Promise<void> {
    if (rows.length === 0) return;
    if (!ctx.initialized || !ctx.db) {
        throw new Error('VerbatimStore.bulkUpsertPrebuiltRows: store not initialized');
    }
    // ensureVerbatimTable: a concurrent first write must open, not throw
    // "already exists" (see the helper's doc).
    const { table } = await ensureVerbatimTable(ctx);
    // C3 3.2/3.4 — mergeInsert reconciles source-vs-target, NOT duplicates
    // WITHIN the source: two rows sharing an id in one batch both landed as
    // separate canonical rows (getById then returned the stale first one,
    // permanently). Collapse same-id rows keep-last before chunking; callers
    // hand rows in temporal order, so last = newest intent.
    const deduped = dedupeByIdKeepLast(rows, (r) => String(r['id'] ?? ''));
    for (let i = 0; i < deduped.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = deduped.slice(i, i + VERBATIM_CHUNK_SIZE) as Array<{ [k: string]: unknown }>;
        await table
            .mergeInsert('id')
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(chunk);
    }
    ctx.bumpSearchEpoch();
}

/**
 * Compute a safe IVF partition count for a table of `rows` vectors.
 *
 * fix/lancedb-ivf-pq-recall-loss: `table.createIndex('vector')` with no
 * explicit config builds an IVF_PQ index at a FIXED ~256 partitions
 * regardless of table size (verified empirically in 0.27.2 — LanceDB's own
 * docs say partitions should scale as sqrt(rows), but the plain call does
 * not do that). At Lore's real scale — most workspaces hold a few hundred to
 * a few thousand EMBEDDED rows, not tens of thousands, because only content
 * written with `embed: true` gets a vector — 256 partitions over ~4,000 rows
 * means ~15 rows/partition, far too few for k-means to find real clusters
 * ("more than 10% of clusters are empty" in the logs). Measured impact on a
 * real 4,170-row corpus: recall@1 dropped to 88-92%, i.e. a self-lookup
 * missed its own row 8-12% of the time, silently — no error, no warning
 * surfaced to the caller, just a wrong answer.
 *
 * `numPartitions = min(sqrt(rows), rows/50)` targets sqrt-scaling (LanceDB's
 * own guidance) while flooring at ~50 rows/partition so a partition always
 * has enough vectors to cluster meaningfully, however small the table is.
 */
export function computeIvfPartitions(rows: number): number {
    return Math.max(1, Math.min(Math.round(Math.sqrt(rows)), Math.floor(rows / 50)));
}

/**
 * Ensure a vector index exists on lore_verbatim. Idempotent: skips if a
 * vector index already exists. Returns true if it built one.
 *
 * fix/lancedb-ivf-pq-recall-loss: uses IVF_FLAT, not the default IVF_PQ.
 * IVF_PQ additionally quantizes (compresses) each vector — that compression
 * is where the remaining recall loss lives, independent of partition count
 * (measured: correct partitioning alone raised recall@1 from 92% to only
 * 95%; switching to IVF_FLAT with the same partitioning reached 100%,
 * matching an unindexed exact scan exactly). IVF_FLAT still partitions for
 * speed but keeps full-precision vectors within each partition. The
 * trade-off is memory: no compression means the index is larger than IVF_PQ
 * would be. At Lore's real per-workspace scale (384-dim × a few thousand
 * rows ≈ single-digit megabytes) that trade is clearly worth exact answers.
 * No `distanceType` override — Lore's vectors are already L2-normalised at
 * embed time (see localEmbeddingProvider.ts), so L2 and cosine rank
 * identically; overriding it would be an unrelated behaviour change bundled
 * into a correctness fix.
 */
export async function ensureVectorIndex(
    ctx: VerbatimBatchCtx,
    opts: { minRows?: number } = {},
): Promise<boolean> {
    if (!ctx.initialized || !ctx.table) return false;
    const minRows = opts.minRows ?? 256;
    try {
        // Check existing indices first. Not just "some index exists" — a
        // pre-fix IVF_PQ index (indexType 'IvfPq') is the exact defect this
        // fix corrects, so it must NOT count as "already indexed". Every
        // real workspace built before this fix has one and would otherwise
        // never be upgraded. createIndex's default `replace: true` swaps it
        // in place below.
        const indices = await ctx.table.listIndices?.();
        if (Array.isArray(indices)) {
            for (const idx of indices) {
                const idxObj = idx as { columns?: string[]; name?: string; indexType?: string };
                if (idxObj.columns?.includes('vector') && idxObj.indexType === 'IvfFlat') {
                    return false; // Already indexed with the correct type.
                }
            }
        }
        // Below threshold? Skip — index would be wasted and need
        // rebuilding once more rows arrive. Below this size a plain
        // (unindexed) vectorSearch is already sub-millisecond and exact.
        const count = await ctx.table.countRows();
        if (count < minRows) return false;

        const numPartitions = computeIvfPartitions(count);
        log.info(`[VerbatimStore] Building IVF_FLAT index on lore_verbatim.vector (${count} rows, ${numPartitions} partitions)...`);
        const t0 = Date.now();
        // Crash-safety: mark before, clear after. A process death between these
        // two points leaves the marker on disk → the next open detects the
        // interrupted build and heals (drop + rebuild) instead of reading a
        // half-written index.
        markBuildStart(ctx.lancedbPath, 'vector');
        try {
            await ctx.table.createIndex('vector', { config: lancedb.Index.ivfFlat({ numPartitions }) });
        } finally {
            markBuildDone(ctx.lancedbPath, 'vector');
        }
        log.info(`[VerbatimStore] Index built in ${((Date.now() - t0) / 1000).toFixed(1)}s. Search step is now sub-second regardless of corpus size.`);
        return true;
    } catch (err) {
        log.error(`[VerbatimStore] ensureVectorIndex failed (non-fatal): ${(err as Error).message}`);
        return false;
    }
}

/**
 * SW-20 (E11): ensure a full-text (FTS) index exists on the `text` column,
 * the keyword sibling of {@link ensureVectorIndex}. Returns true if it built
 * the index, false if already present, below threshold, or unsupported by the
 * installed LanceDB. Non-fatal on error — bm25Search degrades to the LIKE
 * fallback.
 *
 * fix/fts-index-and-tokenizer:
 *   - `minRows` default lowered 256 -> 25 -> 1. The threshold was pure cost
 *     avoidance, and the cost isn't there: a measured build is 11ms at 25
 *     rows and 40ms at 5,000. Meanwhile the threshold was actively harmful,
 *     because an unindexed table does NOT fall back to "no keyword search" —
 *     LanceDB answers the FTS query brute-force with its own DEFAULT
 *     tokenizer, ignoring the language-aware one this module configures. So
 *     a sub-threshold CJK workspace returned zero hits for a query whose
 *     term was verbatim in the corpus, and reported `ranked: true` while
 *     doing it (verified empirically: 10 rows, query 租约延长 present in a
 *     document, 0 hits). The tokenizer only exists on the index, so "no
 *     index" silently means "wrong tokenizer", not "slower". 1 (not 0) so a
 *     genuinely empty table still skips the build.
 *   - `opts.tokenizer` threads the caller's language-aware tokenizer choice
 *     (see engines/ftsTokenizerProfile.ts) into `Index.fts(...)`.
 *   - PRIOR BUG: this used to call `createIndex('text', { config: { type:
 *     'fts' } })` — a plain object, not a real `lancedb.Index` instance.
 *     LanceDB silently ignored the invalid `config` and inferred a BTREE
 *     index on the string column instead of FTS (confirmed empirically —
 *     `listIndices()` reported `indexType: "BTree"`). `Index.fts(options)`
 *     is the real, documented factory; it also plumbs the tokenizer.
 *   - The existing-index check now also verifies `indexType === 'FTS'`, so
 *     a stray legacy BTree index (built by the bug above, on any store that
 *     predates this fix) is treated as "not indexed yet" and gets replaced
 *     — `createIndex`'s default `replace: true` swaps it in place.
 */
export async function ensureFtsIndex(
    ctx: VerbatimBatchCtx,
    opts: { minRows?: number; tokenizer?: FtsTokenizerSettings } = {},
): Promise<boolean> {
    if (!ctx.initialized || !ctx.table) return false;
    const minRows = opts.minRows ?? 1;
    try {
        // Already FTS-indexed on `text`? (Not just "some index" — a legacy
        // BTree index from the pre-fix bug above must NOT count as done.)
        const indices = await ctx.table.listIndices?.();
        if (Array.isArray(indices)) {
            for (const idx of indices) {
                const idxObj = idx as { columns?: string[]; name?: string; indexType?: string };
                if (idxObj.columns && idxObj.columns.includes('text') && idxObj.indexType === 'FTS') {
                    return false; // Already FTS-indexed.
                }
            }
        }
        const count = await ctx.table.countRows();
        if (count < minRows) return false;

        const createIndex = (ctx.table as unknown as {
            createIndex?: (col: string, opts?: unknown) => Promise<void>;
        }).createIndex;
        if (typeof createIndex !== 'function') return false;

        const tokenizer = opts.tokenizer ?? { baseTokenizer: 'simple' as const };
        log.info(`[VerbatimStore] Building FTS index on lore_verbatim.text (${count} rows, tokenizer=${tokenizer.baseTokenizer})...`);
        const t0 = Date.now();
        // Crash-safety marker (see ensureVectorIndex): a death mid-build is
        // detected + healed on the next open rather than crash-looping reads.
        markBuildStart(ctx.lancedbPath, 'fts');
        try {
            await createIndex.call(ctx.table, 'text', { config: lancedb.Index.fts(tokenizer) } as unknown);
        } finally {
            markBuildDone(ctx.lancedbPath, 'fts');
        }
        log.info(`[VerbatimStore] FTS index built in ${((Date.now() - t0) / 1000).toFixed(1)}s. bm25Search now uses native full-text search instead of a LIKE scan.`);
        return true;
    } catch (err) {
        log.error(`[VerbatimStore] ensureFtsIndex failed (non-fatal): ${(err as Error).message}`);
        return false;
    }
}

/**
 * SW-20 (E7): bulk-resolve contentHash → vector for storeBatch. Consults the
 * in-memory hashCache first (and refills it with whatever the table returns),
 * then resolves cache-miss hashes in CHUNKED `contentHash IN (...)` queries.
 * Semantics identical to the per-doc path — just fewer round-trips.
 */
export async function bulkLookupByContentHash(
    ctx: VerbatimBatchCtx,
    hashes: string[],
): Promise<Map<string, Float32Array | number[]>> {
    const out = new Map<string, Float32Array | number[]>();
    // De-dupe and consult the in-memory cache first.
    const misses: string[] = [];
    const seen = new Set<string>();
    for (const h of hashes) {
        if (!h || seen.has(h)) continue;
        seen.add(h);
        const cached = ctx.hashCache.get(h);
        if (cached) { out.set(h, cached); continue; }
        misses.push(h);
    }
    if (misses.length === 0 || !ctx.table) return out;
    for (const h of misses) assertSafeLanceHash(h, 'bulkLookupByContentHash'); // SECURITY: assertSafeLanceHash — outside try so validation errors propagate
    try {
        for (let ci = 0; ci < misses.length; ci += VERBATIM_CHUNK_SIZE) {
            const chunk = misses.slice(ci, ci + VERBATIM_CHUNK_SIZE);
            const escChunk = chunk
                .map((h) => `'${h.replace(/'/g, "''")}'`)
                .join(',');
            const rows = await ctx.table
                .query()
                .where(`contentHash IN (${escChunk})`)
                .toArray();
            for (const r of rows as Array<Record<string, unknown>>) {
                const h = r.contentHash ? String(r.contentHash) : '';
                const vec = (r as { vector?: Float32Array | number[] }).vector;
                // First row wins per hash (any matching vector is valid —
                // identical text ⇒ identical embedding).
                if (h && vec && !out.has(h)) {
                    out.set(h, vec);
                    ctx.hashCache.set(h, vec);
                }
            }
        }
    } catch (err) {
        log.error(`[VerbatimStore] bulkLookupByContentHash failed (non-fatal): ${(err as Error).message}`);
    }
    return out;
}

/**
 * SW-20 (E3): bulk-resolve canonical-id → contentHash in CHUNKED `id IN (...)`
 * queries instead of one `getById` round-trip per node. Ids with no row (or no
 * contentHash) are simply absent from the map, which the caller treats as
 * "changed" (re-embed) — same semantics as a `getById` miss. Returns an empty
 * Map when the table isn't built.
 */
export async function getContentHashesByIds(
    ctx: VerbatimBatchCtx,
    ids: string[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ctx.initialized || !ctx.table || ids.length === 0) return out;
    for (const id of ids) assertSafeLanceId(id, 'getContentHashesByIds'); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
    // Same CHUNK as storeBatch's snapshot preflight so a large id set
    // never builds an unbounded predicate string.
    try {
        for (let ci = 0; ci < ids.length; ci += VERBATIM_CHUNK_SIZE) {
            const chunkIds = ids.slice(ci, ci + VERBATIM_CHUNK_SIZE);
            const escChunk = chunkIds
                .map((id) => `'${id.replace(/'/g, "''")}'`)
                .join(',');
            const rows = await ctx.table
                .query()
                .where(`id IN (${escChunk})`)
                .toArray();
            for (const r of rows as Array<Record<string, unknown>>) {
                const id = String(r.id ?? '');
                const hash = r.contentHash ? String(r.contentHash) : '';
                if (id && hash) out.set(id, hash);
            }
        }
    } catch (err) {
        log.error(`[VerbatimStore] getContentHashesByIds failed (non-fatal): ${(err as Error).message}`);
    }
    return out;
}
