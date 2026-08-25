/**
 * verbatim.ts — Verbatim memory contract.
 *
 * The verbatim store holds original document content + provenance
 * (hash, source, ingested-at) so the rest of Lore can reference back
 * to source-of-truth text. Distinct from graph nodes — graph nodes
 * are *about* content; verbatim *is* the content.
 *
 * Today the local implementation lives at `engines/verbatimStore.ts`
 * as a `VerbatimStore` class. Step #1 of BUILD_ORDER.md formalizes
 * the interface so DataplaneAdapter can implement it too in step #6.
 *
 * The interface below is the DESIRED shape. Step #2 will refactor
 * the existing `VerbatimStore` class to implement it. No code is
 * moved or changed in this PR — this is the contract being declared.
 */

import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';

/**
 * VerbatimDocument — what callers `store`. The id is caller-supplied
 * (typically a content hash or canonical url); collisions update.
 */
export interface VerbatimDocument {
    id: string;
    text: string;
    /** Where this came from (e.g. 'gmail:msg-abc123', 'file:/Users/x/foo.pdf'). */
    source?: string;
    /** Optional human-readable label (subject line, file basename). */
    label?: string;
    /** Optional comma-separated tag string for ad-hoc grouping. */
    tags?: string;
    /** Optional ISO 8601 timestamp of original document creation. */
    sourceCreatedAt?: string;
    /** Optional bag of caller-specific metadata. */
    meta?: Record<string, unknown>;
}

/**
 * VerbatimSearchResult — one hit from `search` / `bm25Search`.
 */
export interface VerbatimSearchResult {
    id: string;
    score: number;
    text: string;
    label?: string;
    source?: string;
    snippet?: string;
}

/**
 * VerbatimSearchOpts — knobs for `search`.
 */
export interface VerbatimSearchOpts {
    limit?: number;
    /** When false, omit the full `text` and only return snippet + metadata. */
    includeText?: boolean;
}

/**
 * IVerbatimStore — universal verbatim contract.
 *
 * Both adapters implement this. LocalAdapter wraps the existing
 * `VerbatimStore` class (LanceDB-backed). DataplaneAdapter wraps a
 * dataplane verbatim collection.
 */
export interface IVerbatimStore {
    /**
     * Insert or update a verbatim document. Idempotent on `id`.
     * Adapter computes content hash, embeds the text, indexes for BM25.
     */
    store(doc: VerbatimDocument): Promise<void>;

    /**
     * Bulk insert. Adapters batch the embed + index work.
     */
    storeBatch(docs: VerbatimDocument[]): Promise<void>;

    /**
     * Hybrid search — BM25 + vector cosine, fused. Default ranking
     * is reciprocal-rank-fusion across the two scorers.
     */
    search(query: string, opts?: VerbatimSearchOpts): Promise<VerbatimSearchResult[]>;

    /**
     * BM25-only search, useful when callers want exact-keyword matching
     * without semantic drift. `ranked` on the returned envelope states
     * whether `hits` is a genuine BM25 ranking (safe to fuse via RRF) or
     * an unranked substring/LIKE fallback that must be excluded — see
     * engines/verbatimBm25Result.ts.
     */
    bm25Search(query: string, opts?: VerbatimSearchOpts): Promise<Bm25Envelope<VerbatimSearchResult>>;

    /**
     * Look up by id. Returns the content + hash if present, else null.
     * Cheap — no full-text load when called with `{ contentOnly: true }`.
     */
    getById(
        id: string,
        opts?: { contentOnly?: boolean },
    ): Promise<{ id: string; text?: string; contentHash?: string } | null>;

    /**
     * List ids, optionally filtered by id-prefix. Used by background
     * reconnect + admin operations.
     */
    listIds(prefix?: string): Promise<string[]>;

    /**
     * Hard-delete a document. Removes from BM25 index + vector store.
     * Use `tombstone` instead if you need an audit trail of the deletion.
     */
    delete(id: string): Promise<void>;

    /**
     * Soft-delete. Replaces text with a placeholder + records the
     * deletion reason. Useful for retention sweeps where the deletion
     * itself is auditable.
     */
    tombstone(id: string, reason: string): Promise<void>;

    /**
     * Audit history for a document — every update with timestamp + hash.
     */
    getHistory(id: string): Promise<Array<{
        at: string;
        contentHash: string;
        action: 'store' | 'tombstone' | 'delete';
        reason?: string;
    }>>;

    /**
     * Total document count.
     */
    count(): Promise<number>;
}
