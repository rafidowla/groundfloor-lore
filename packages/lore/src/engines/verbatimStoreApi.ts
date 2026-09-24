/**
 * verbatimStoreApi.ts — VerbatimStoreApi: the structural contract for a
 * local verbatim store (LanceDB-backed `VerbatimStore` today; the
 * SQLite-backed store from 3.21 step 2 part 1 tomorrow).
 *
 * 3.21 step 2 part 0 (design: 321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md
 * section 0). `VerbatimStore` was referred to NOMINALLY all over core — the
 * resolver, the shutdown drain, `instanceof VerbatimStore` narrowings, and
 * `VerbatimSearchWorkerProxy extends VerbatimStore` (purely so it kept
 * satisfying those `instanceof` checks). That made it impossible for the
 * resolver to hold a second, unrelated engine class (SqliteVerbatimStore)
 * without also making it `extends VerbatimStore`, which is exactly backwards.
 *
 * This interface lists every public member of `VerbatimStore` that a caller
 * OUTSIDE engines/verbatimStore.ts actually uses (found by grepping call
 * sites — bulk ingest, storage bundle, boot steps, the outbox resolver, HTTP
 * routes, the search-worker proxy/entry). `isVerbatimStore()` below is the
 * structural narrowing that replaces `instanceof VerbatimStore` at every one
 * of those call sites.
 *
 * ZERO BEHAVIOUR CHANGE: `VerbatimStore` already satisfies this interface
 * structurally today (every member here already exists on the class with
 * this exact signature) — retyping a call site from the concrete class to
 * this interface cannot change what code runs, only what the type checker
 * accepts. `SqliteVerbatimStore` (part 1) will implement it directly instead
 * of subclassing anything.
 */

import type { VectorProvider, VerbatimDocument, VerbatimSearchResult } from '../providers/types.js';
import type { Bm25Envelope } from './verbatimBm25Result.js';
import type { FtsTokenizerSettings } from './ftsTokenizerProfile.js';
import type { VerbatimExportRow } from './verbatimHistory.js';

/**
 * VerbatimStoreApi — everything a core caller may do to a local verbatim
 * store, independent of which engine (LanceDB, SQLite) backs it.
 *
 * Extends `VectorProvider` for `initialize` / `store` / `search` / `delete`
 * / `count` / `close` (identical signatures to `VerbatimStore`'s), and adds
 * every other public member `VerbatimStore` exposes today.
 */
export interface VerbatimStoreApi extends VectorProvider {
    storeBatch(docs: VerbatimDocument[]): Promise<void>;

    /**
     * Vector search with a pre-computed query vector — the IPC path for the
     * search-worker proxy, and the primary retrieval path for engines that
     * don't want to re-embed. Same filtering/scoping/history semantics as
     * `search`.
     */
    searchByVector(
        queryVector: number[],
        opts?: {
            topK?: number;
            filter?: Partial<VerbatimDocument['metadata']>;
            includeHistory?: boolean;
            actorScopes?: ReadonlyArray<string>;
        },
    ): Promise<VerbatimSearchResult[]>;

    /** Keyword (BM25) search. See verbatimBm25Result.ts for the
     *  ranked/unranked envelope contract every engine must honor. */
    bm25Search(
        query: string,
        limit?: number,
        filter?: Partial<VerbatimDocument['metadata']>,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<Bm25Envelope<VerbatimSearchResult>>;

    getById(id: string): Promise<{
        contentHash?: string;
        text?: string;
        type?: string;
        label?: string;
        tags?: string;
        project?: string;
        ecosystem?: string;
        updatedAt?: string;
        security_scopes?: string[];
    } | null>;

    getContentHashesByIds(ids: string[]): Promise<Map<string, string>>;

    listIds(prefix?: string, opts?: { project?: string; includeHistory?: boolean }): Promise<string[]>;

    exportRows(opts?: { project?: string }): Promise<{
        modelId: string;
        dim: number;
        rows: VerbatimExportRow[];
    }>;

    /** Hard delete, no tombstone — orphan-cascade path. */
    physicalDelete(id: string): Promise<void>;
    /** Bulk hard delete, chunked. Returns the number of ids processed. */
    physicalDeleteMany(ids: string[]): Promise<number>;

    /** Reclaim disk after bulk deletes. Lance-specific today (fragment
     *  merge + version prune); a SQLite engine may make this a cheap no-op
     *  (VACUUM is handled elsewhere) but must still implement the method. */
    compact(opts?: { deleteUnverified?: boolean }): Promise<{
        fragmentsRemoved: number;
        filesRemoved: number;
        bytesRemoved: number;
        oldVersionsRemoved: number;
    } | null>;

    /** Soft-delete with an audit-trail reason; preserves prior content as
     *  a `#rev` history snapshot. */
    tombstone(id: string, reason: string): Promise<void>;

    getHistory(id: string): Promise<Array<{
        id: string;
        text: string;
        updatedAt: string;
        isTombstone: boolean;
        isCanonical: boolean;
    }>>;

    /** Substrate-native bulk loader append path — no embed, caller supplies
     *  placeholder vectors. Bulk-ingest-only, not a hot-path API. */
    bulkAddPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void>;
    /** Atomic prebuilt-row upsert keyed on `id` — delete+add collapsed into
     *  one op so a crash mid-write leaves the OLD or NEW row, never neither. */
    bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>): Promise<void>;

    ensureVectorIndex(opts?: { minRows?: number }): Promise<boolean>;
    ensureFtsIndex(opts?: { minRows?: number; tokenizer?: FtsTokenizerSettings }): Promise<boolean>;

    /** Test/observability hook — read-pool sizing, or null when the pool
     *  hasn't been built (an engine without a pool concept may always
     *  return null). */
    readPoolStats(): { size: number; available: number; waitingCount: number } | null;
    /** Observability hook — current bounded-hash-cache size. */
    hashCacheSize(): number;
    /** Live native-handle count, for the write-gate/close-drain contract
     *  (3.20.0). A single-connection engine (SQLite) reports 0 or 1. */
    handleCount(): number;
}

/**
 * isVerbatimStore — structural guard replacing `instanceof VerbatimStore`
 * at every call site that used to narrow `LoreVectorStore` (`VerbatimStoreApi
 * | DataplaneVectorStore`) down to the local engine.
 *
 * Discriminators: `bulkUpsertPrebuiltRows`, `handleCount` and `tombstone`.
 * All three exist on every local verbatim engine (LanceDB today, SQLite
 * from part 1) and NONE exist on `DataplaneVectorStore` (verified directly
 * against engines/dataplaneVectorStore.ts) — the only other member of the
 * `LoreVectorStore` union, so this guard is exhaustive for every caller that
 * previously wrote `x instanceof VerbatimStore`.
 */
export function isVerbatimStore(x: unknown): x is VerbatimStoreApi {
    if (!x || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    return (
        typeof o.bulkUpsertPrebuiltRows === 'function' &&
        typeof o.handleCount === 'function' &&
        typeof o.tombstone === 'function'
    );
}
