/**
 * linkTypes.ts - the engine-neutral link-on-arrival contracts.
 *
 * `Linker` is the one contract; each engine supplies a `LinkSubstrate` (stored
 * vector reads + batched kNN + batched inferred-edge write) and the shared
 * `StoredVectorLinker` does selection on top. SQLite implements the substrate
 * methods in this slice; the Postgres engine implements the same methods
 * (see the handback notes) and must pass test/link-batch-engine-contract-unit.ts.
 */
import type { EdgeProvenance, VerbatimSearchResult } from '../providers/types.js';

export const SEMANTIC_RELATION = 'semantic_neighbor';

/** One `semantic_neighbor` edge to write. Stored as a sorted (lo, hi) pair, like the legacy autolink. */
export interface InferredEdge {
    sourceId: string;
    targetId: string;
    /** Always `semantic_neighbor` today; carried so the batch method stays relation-agnostic. */
    relation: string;
    confidenceScore: number;
    /** Provenance stamped on the row (engines that store it); the batch defaults `origin` to 'link_on_arrival'. */
    provenance?: EdgeProvenance;
}

export interface BatchEdgeResult {
    /** Rows inserted or refreshed (the existing row was itself inferred). */
    written: number;
    /** Dropped because an endpoint no longer exists (node deleted since the vector committed). */
    skippedMissingEndpoint: number;
    /** Left untouched because a non-inferred (caller-supplied) edge already holds the triple. */
    keptExisting: number;
}

/** Optional graph capability: write many inferred edges in one transaction, never touching caller edges. */
export interface InferredEdgeBatchCapable {
    addInferredEdgesBatch(edges: InferredEdge[]): Promise<BatchEdgeResult>;
}

export interface KnnQuery {
    /** Opaque key echoed back in the result map (the arriving node's verbatim row id). */
    key: string;
    vector: number[];
}

export interface KnnOptions {
    topK: number;
    filter?: Record<string, unknown>;
    actorScopes?: ReadonlyArray<string>;
    /**
     * Which columns each hit carries. `'link'` = only what link selection / confinement reads: `id`, `score`,
     * `metadata.ecosystem` and `metadata.security_scopes` (`text` is `''`, the other metadata fields are unset).
     * Default / `'full'` = the whole row. An engine may ignore this and return full rows.
     */
    columns?: 'full' | 'link';
}

/** Optional verbatim capability: one call, many stored-vector queries. */
export interface BatchKnnCapable {
    searchByVectors(queries: KnnQuery[], opts: KnnOptions): Promise<Map<string, VerbatimSearchResult[]>>;
}

/** A near-duplicate pair for the supersession-candidate list. `a`/`b` are plain node ids, a < b. */
export interface DuplicateCandidate {
    a: string;
    b: string;
    score: number;
}

export interface LinkItem {
    /** Plain node id (no `lore:` prefix). */
    id: string;
    /** Known at enqueue time when the writer had it; otherwise the linker reads it from the stored row. */
    ecosystem?: string;
}

export interface LinkBatchResult {
    /** Items fully handled (linked, or nothing to link). Failed ids are NOT here. */
    done: string[];
    /** Items to retry later (transient failure: no vector yet, store error). */
    retry: Array<{ id: string; reason: string }>;
    edgesWritten: number;
    keptExisting: number;
    skippedMissingEndpoint: number;
    duplicates: DuplicateCandidate[];
    /** Loop B only: stale links soft-invalidated (`valid_to`) because they no longer qualify. */
    invalidated?: number;
    /** Loop B only: kept links whose stamp or score was re-asserted in place. */
    refreshed?: number;
    /** True when the batch inserted or re-asserted at least one edge: the cap-prune sweep then re-checks the workspace. */
    wroteEdges?: boolean;
}

/** Engine-neutral. Reads the arriving nodes' STORED vectors (never re-embeds). */
export interface Linker {
    /** Loop A: link an arriving node. Adds and refreshes edges; never invalidates. */
    linkBatch(workspace: string, items: LinkItem[]): Promise<LinkBatchResult>;
    /**
     * Loop B: refresh the links of nodes whose content or vector CHANGED. Same selection as `linkBatch`, then
     * the same diff as the rebuild: links that no longer qualify are soft-invalidated (never deleted). Absent
     * on a Linker (or engine) that cannot soft-invalidate; the service then falls back to `linkBatch`.
     */
    refreshBatch?(workspace: string, items: LinkItem[]): Promise<LinkBatchResult>;
}

/** Live link-health numbers of one workspace's graph (link-origin `semantic_neighbor` edges only). */
export interface LinkEdgeStats {
    /** Live (`valid_to` NULL) linker edges. */
    live: number;
    /** Soft-invalidated linker edges (kept, not deleted). */
    invalidated: number;
    /** Mean `confidenceScore` of the live linker edges; null when there are none. */
    meanStrength: number | null;
    /** Highest live linker degree (edges touching one node); 0 when there are none. */
    maxDegree: number;
    /** Live linker edges stamped with a different policy version or model than the current ones. */
    stale: number;
}

/**
 * Optional graph capability: link-health counts and the over-cap scan the background prune uses. Both read
 * ONLY edges whose origin is `link_on_arrival`; caller, import and legacy edges are neither counted nor evictable.
 */
export interface LinkEdgeStatsCapable {
    linkEdgeStats(current: { policyVersion: string; modelFingerprint: string | null }): Promise<LinkEdgeStats>;
    /** Plain node ids with more than `cap` live linker edges, ascending by id, strictly after `afterId`. */
    linkNodesOverCap(cap: number, limit: number, afterId?: string | null): Promise<string[]>;
}

/**
 * Optional graph capability: the durable per-node link opt-out (`autolink:false`).
 * The flag lives in the workspace's own graph store (SQLite `graph.sqlite` /
 * Postgres), so it travels with backup and restore. Keyed by plain node id and
 * independent of the node row: it can be recorded before the node exists, and a
 * node upsert/replace never touches it. `deleteNode` removes it.
 */
export interface LinkOptOutCapable {
    /** The subset of `ids` currently opted out. Chunked internally; unknown ids are simply absent. */
    getLinkOptOuts(ids: readonly string[]): Promise<Set<string>>;
    /** `true` records the opt-out (idempotent); `false` clears it. */
    setLinkOptOuts(ids: readonly string[], optOut: boolean): Promise<void>;
}

/** Type guard for the optional opt-out capability. */
export function hasLinkOptOutSupport<T extends object>(g: T): g is T & LinkOptOutCapable {
    const c = g as Partial<LinkOptOutCapable>;
    return typeof c.getLinkOptOuts === 'function' && typeof c.setLinkOptOuts === 'function';
}

/**
 * The write-side half of link-on-arrival: "this node's vector is now committed".
 * `signal` is synchronous, durable, never throws, never waits for linking. Write
 * paths take this (not the whole service) so they stay decoupled from the worker.
 */
export interface LinkSignaler {
    signal(workspace: string, items: ReadonlyArray<LinkItem>): void;
    /**
     * Record a write's explicit `autolink` choice BEFORE its vector commits; see
     * applyLinkIntent(). `false` sets the durable opt-out, `true` clears it,
     * `undefined` leaves it as it is. Resolves once the flag is durable; never rejects.
     */
    setIntent?(workspace: string, ids: ReadonlyArray<string>, autolink: boolean | undefined): Promise<void>;
}
