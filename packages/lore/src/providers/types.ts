/**
 * Base Lore Node definition representing a discrete piece of knowledge.
 */
export interface LoreNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    project: string;
    ecosystem: string;
    metadata: string;
    createdAt: string;
    updatedAt: string;
    syncedAt: string | null;
    security_scopes?: string[];
    /**
     * ISO 639-1 language code tagged by the caller at ingest, or null
     * when unknown. See docs/LANGUAGE_DETECTION.md: core never sets this
     * automatically — it's always an explicit tag from the ingest path
     * that knows the content (plugins, AI agents, UI). Nodes without a
     * tag stay null and are treated as English / default downstream.
     */
    language?: string | null;
    /**
     * Soft supersession (2026-04-28). When set, this node has been
     * replaced by `supersededBy` and is hidden from default recall +
     * faded in the network view. Edges remain intact — supersession
     * is metadata, not deletion. Empty string / null = "current".
     */
    supersededBy?: string | null;
    supersededAt?: string | null;
    supersededReason?: string | null;
    /**
     * Ephemeral scratchpad (Fix #5, 2026-05-07). When true, this node is
     * short-lived working memory for a multi-step agentic process. It is
     * auto-pruned when ttl_ms elapses (since createdAt). Never appears in
     * normal recall results — only surfaced when explicitly requested.
     * Survives context compression but does not pollute permanent memory.
     */
    ephemeral?: boolean;
    /**
     * Time-to-live in milliseconds (Fix #5). Only meaningful when
     * ephemeral=true. Measured from createdAt. The pruner deletes the
     * node once (Date.now() - createdAtMs) > ttl_ms. Default: 3600000 (1h).
     */
    ttl_ms?: number | null;
    /**
     * Stale flag (Gap #3). When true, this node's content may be out of
     * date because significant code changes were made after it was written.
     * Set by markStaleByTags() when a post-commit hook detects a large
     * changeset. Surfaced in recall responses as stale_warning:true so the
     * AI caller knows to verify before trusting the content. Default false.
     */
    stale?: boolean;
    /**
     * Access-time coldness signal (maintain / capacity management,
     * 2026-06-06). `lastAccessedAt` = ISO timestamp of the most recent
     * read of ANY kind (recall/search/getNode/traverse/graph-view).
     * `last_retrieved_at` = most recent INTENTIONAL retrieval only
     * (recall/search/get_full). Both LOCAL-ONLY (never synced) and written
     * via a deferred, epoch-/sync-bypassing path so reads don't invalidate
     * the recall cache or trigger re-embed. `lore maintain` reads these
     * (cold_signal policy) to find genuinely-unused nodes. null = never
     * recorded (selection falls back to updatedAt).
     */
    lastAccessedAt?: string | null;
    last_retrieved_at?: string | null;

    // ─── Feature 1: Knowledge Lifecycle ─────────────────────────────
    /**
     * Classification tier controlling shelf-life and recall priority.
     * 'foundational' = long-lived architectural truth (rarely expires).
     * 'tactical'     = medium-lived working knowledge (default).
     * 'observational'= short-lived observations / ephemeral-adjacent.
     * Default: 'tactical'.
     */
    classification?: 'foundational' | 'tactical' | 'observational';
    /**
     * Lifecycle status. 'active' = normal. 'archived' = soft-deleted
     * (hidden from recall by default). 'protected' = never prunable.
     * Default: 'active'.
     */
    status?: 'active' | 'archived' | 'protected';
    /**
     * ISO timestamp when the classification tier expires and the node
     * should be re-reviewed. null / empty = no expiry.
     */
    classification_expires_at?: string | null;

    // ─── Feature 2: Outcome Feedback ────────────────────────────────
    /** Count of times this node was flagged as contributing to a successful outcome. */
    success_count?: number;
    /** Count of failure outcomes attributed to this node. */
    failure_count?: number;
    /** Count of partial-success outcomes. */
    partial_count?: number;
    /**
     * Derived confidence score in [0,1] based on outcome feedback:
     *   score = success / (success + failure + partial * 0.5)
     * Recalculated by record_outcome. 0 when no outcomes recorded.
     */
    confirmation_score?: number;

    // ─── Feature 4: Evidence / Provenance ───────────────────────────
    /**
     * Source attribution for the node's content. JSON-serialized
     * Record<string, string> or free text. Examples:
     *   '{"url":"https://...","captured_at":"2026-05-26"}'
     *   'Meeting notes 2026-05-15'
     * Redactable via the redact_evidence MCP tool.
     */
    evidence?: string | null;

    // ─── Feature 6: Anchor Tracking (Phase 1) ───────────────────────
    /**
     * When true, one or more of this node's anchors have been detected
     * as stale (e.g. referenced URL changed, linked node superseded).
     */
    anchor_stale?: boolean;
    /** ISO timestamp when anchor_stale was first set. Empty = not stale. */
    anchor_stale_since?: string | null;
    /**
     * JSON-serialized Array<{type: string; ref: string}>.
     * Anchors are external references this node claims to be grounded in.
     * Example: '[{"type":"url","ref":"https://..."},{"type":"node","ref":"decision-xyz"}]'
     */
    anchors?: string | null;

    // ─── Bi-temporal: valid-time window ─────────────────────────────
    /**
     * Valid-time window (bi-temporal storage primitive). `validFrom` /
     * `validUntil` are ISO 8601 timestamps stating when a fact was/is
     * TRUE IN THE REAL WORLD — distinct from `createdAt`/`updatedAt`,
     * which record when Lore itself recorded the write (system/
     * transaction time). Core never sets these: they are always
     * caller-supplied, exactly like `language`. Null/omitted on either
     * end means "no bound on that side" — a node with neither set is
     * valid at every timestamp, which keeps every pre-existing node
     * (and every caller that never touches this feature) behaving
     * exactly as before. Core does not interpret overlaps or decide
     * which of two time-windowed nodes about the same fact wins; that
     * judgment (contradiction detection) is explicitly an application-
     * layer concern, not Core's.
     */
    validFrom?: string | null;
    /** See `validFrom`. Null/omitted = "still valid, no end bound". */
    validUntil?: string | null;
}

/**
 * Edge confidence tier (Phase 1 / C1).
 *
 *  - 'extracted': the user, or a deterministic rule, asserted this edge.
 *                 Treat as fact.
 *  - 'inferred':  semantic / similarity-based inference (e.g. reconnect).
 *                 Treat as a hint; LLM should acknowledge uncertainty.
 *  - 'ambiguous': ingestion produced a candidate edge but couldn't resolve
 *                 it cleanly (e.g. two Person nodes with the same name).
 *                 UI surfaces for human review.
 */
export type EdgeConfidence = 'extracted' | 'inferred' | 'ambiguous';

/**
 * Edge definition for graph relationships.
 */
export interface LoreEdge {
    sourceId: string;
    targetId: string;
    relation: string;
    /**
     * Optional confidence tier. Defaults to 'extracted' when omitted (the
     * conservative interpretation — callers that don't specify are
     * treated as user-asserted).
     */
    confidence?: EdgeConfidence;
    /**
     * Optional numeric confidence in [0,1]. Semantic-similarity edges
     * record the cosine similarity here; user-asserted edges default to 1.0.
     */
    confidenceScore?: number;
}

/**
 * Graph traversal result containing contextual discovery depth.
 */
export interface TraversalResult {
    node: LoreNode;
    depth: number;
    relation: string;
}

/**
 * A traversal step that records WHICH WAY the edge was followed.
 *
 * `TraversalResult` above deliberately has no direction: `traverse()` merges
 * the outgoing and incoming frontiers and reports only that a node was
 * reachable. That is the right answer for "what is near this node", and every
 * existing caller depends on it, so it is not changing.
 *
 * It is the wrong answer for anything reconstructing a DIRECTED graph. Atlas
 * says so in its own source: it will not use `traverse()` for call-graph work
 * because the fan-out "would merge in/out and invert" — so it pulls the entire
 * edge set into memory and walks it itself, which is the only way to keep
 * direction today. `traverseDirected` closes that gap: the same walk, plus the
 * direction each edge was followed in, so a caller can rebuild a directed
 * subgraph without materialising every edge in the workspace.
 *
 * `direction` is relative to `via`, the node this step was expanded from:
 * `'out'` means via → node, `'in'` means node → via. Together with `relation`
 * that is the exact directed edge, so no caller has to guess.
 */
export interface DirectedTraversalResult extends TraversalResult {
    /** Which way the edge points, relative to `via`. */
    direction: 'out' | 'in';
    /** The node this step was reached FROM. The seed itself is never returned. */
    via: string;
}

/**
 * The three fields a caller needs to build an id → view map, and nothing else.
 *
 * Measured on the 19,237-node `v3` corpus: whole records cost 163.9 ms against
 * 87.1 ms for these three on SurrealDB, because a document store materialises
 * whole documents. Atlas builds exactly this map and receives full `content`
 * it never reads.
 */
export interface LoreNodeSummary {
    id: string;
    type: string;
    label: string;
}

/**
 * Filter + pagination for GraphProvider.queryEdges (GET /api/edges).
 * Any of source/target/relation may be omitted (no filter on that axis).
 * limit/offset are caller-clamped before reaching the provider.
 */
export interface EdgeQuery {
    source?: string;
    target?: string;
    relation?: string;
    limit: number;
    offset: number;
}

/**
 * Cursor for GraphProvider.bulkList — a stable (updatedAt DESC, id ASC)
 * position. The HTTP layer base64url-encodes this; the provider sees the
 * decoded object.
 */
export interface BulkListCursor {
    updatedAt: string;
    id: string;
}

/**
 * Filter + pagination for GraphProvider.bulkList (POST /api/nodes/bulk-list).
 * `limit` is the page size (caller-clamped to ≤1000); the provider fetches
 * limit+1 internally to compute hasMore.
 */
export interface BulkListQuery {
    types?: string[];
    tags?: string[];
    project?: string;
    /** Ecosystem scope. Omitted/absent/`'*'` = no ecosystem filter (matches
     *  every ecosystem), matching the `'*'` convention `listNodes` uses
     *  elsewhere on this contract. A CONCRETE value also keeps rows whose own
     *  `ecosystem` is `'*'`/`''` — those are UNSCOPED nodes, not a distinct
     *  value (core/ecosystemMatch.ts, DEC-ECOSYSTEM-WILDCARD). */
    ecosystem?: string;
    limit: number;
    cursor?: BulkListCursor | null;
}

/**
 * One page of GraphProvider.bulkList output. `nodes` are raw row records
 * (id/type/label/content/tags/metadata/project/ecosystem/updatedAt/createdAt).
 * `nextCursor` is null when the page is the last one.
 */
export interface BulkListPage {
    nodes: Array<Record<string, unknown>>;
    hasMore: boolean;
    nextCursor: BulkListCursor | null;
}

/**
 * High-level statistics interface for Graph health monitoring.
 *
 * Core fields (nodeCount, edgeCount, typeBreakdown) describe the
 * LoreNode / LoreEdge surface. Lore Core is schema-agnostic; domain
 * stat breakdowns belong in client applications (e.g. Atlas).
 */
export interface GraphStats {
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
}

/**
 * Search/traverse/vector-search semantic contract.
 *
 * Every GraphProvider and VectorProvider adapter MUST honor the invariants
 * documented below. W5-CLOUD-SEARCH-ALIGN aligns the cloud (Dataplane)
 * adapter to this contract; W5-PARITY-HARNESS asserts equivalence between
 * all adapters automatically.
 *
 * Versioned so downstream tasks (W5-CLOUD-SEARCH-ALIGN, W5-PARITY-HARNESS)
 * can reference a stable anchor rather than re-reading prose.
 *
 * @see {@link GraphProvider.search} for keyword search semantics.
 * @see {@link GraphProvider.traverse} for traversal semantics.
 * @see {@link VectorProvider.search} for vector/semantic search semantics.
 */
export const SEARCH_CONTRACT_VERSION = 1;

/**
 * Abstract GraphProvider Interface
 * Defines the contract that ANY backend graph (Local Kùzu, Cloud Dataplane) must satisfy.
 */
export interface GraphProvider {
    initialize(): Promise<void>;
    upsertNode(nodeData: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode>;
    getNode(id: string): Promise<LoreNode | null>;
    /**
     * SW-16: batch-hydrate many nodes in one round-trip per chunk.
     * Returns a Map keyed by node id; missing ids are simply absent.
     * Callers strip any `lore:` prefix before passing ids in (same
     * contract as getNode).
     */
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
    deleteNode(id: string): Promise<boolean>;
    addEdge(edge: LoreEdge): Promise<void>;
    addBidirectionalEdge(edge: LoreEdge): Promise<void>;
    /**
     * Traverse the graph from `nodeId` up to `maxDepth` hops, optionally
     * filtering on edge `relation`.
     *
     * **CONTRACT (SEARCH_CONTRACT_VERSION = 1) — every adapter MUST honor:**
     *
     * - **Depth**: only nodes reachable within exactly `maxDepth` hops from
     *   `nodeId` may appear in the result. If `maxDepth` is omitted, the
     *   adapter MUST use a sensible default (e.g. 2) and MUST NOT silently
     *   collapse all results to depth 1. Each `TraversalResult.depth` field
     *   MUST reflect the true hop-distance of that node from `nodeId` — never
     *   hardcode to 1.
     *
     * - **Relation filter**: when `relation` is supplied (non-empty string),
     *   only edges whose `relation` field exactly matches (case-sensitive) the
     *   requested value may be traversed. Omitting `relation` traverses all
     *   edge types.
     *
     * - **Result ordering**: results MUST be sorted by `depth` ascending so
     *   callers receive closer neighbors before distant ones. Where two results
     *   share the same depth they may appear in any stable sub-order.
     *
     * - **No duplicates**: if a node is reachable by multiple paths at
     *   different depths, return it once at its *minimum* depth.
     *
     * - **Residual divergence**: if an SDK or backend genuinely cannot expose
     *   true per-node depth metadata, the adapter MUST document this inline
     *   (a `// CONTRACT-DEVIATION` comment) rather than silently mislabeling.
     *
     * @param nodeId  - ID of the seed node (without the `lore:` prefix).
     * @param maxDepth - Maximum traversal depth; adapter-default when omitted.
     * @param relation - Optional edge-relation filter (exact match).
     */
    traverse(nodeId: string, maxDepth?: number, relation?: string): Promise<TraversalResult[]>;
    /**
     * Keyword search over nodes, returning up to `limit` results.
     *
     * **CONTRACT (SEARCH_CONTRACT_VERSION = 1) — every adapter MUST honor:**
     *
     * - **Match surface**: the query string MUST be matched case-insensitively
     *   against all three of `label`, `content`, and `tags`. A node matches if
     *   the query appears as a substring in ANY of those fields. Adapters MUST
     *   NOT restrict matching to `label` only.
     *
     * - **Limit**: the result set MUST contain at most `limit` nodes (or the
     *   adapter default when `limit` is omitted). Returning more than `limit`
     *   nodes is a contract violation.
     *
     * - **Ordering**: results MUST be ordered by:
     *     1. **Relevance descending** — nodes where the query appears in more
     *        fields, or in the `label` field, are ranked higher. Where an
     *        adapter cannot compute a relevance score, it MUST fall back to
     *        the secondary sort below.
     *     2. **`updatedAt` descending** (tie-break) — among equally relevant
     *        nodes the most recently updated node appears first.
     *
     * - **Scope filters**: `project` and `ecosystem`, when supplied, act as
     *   additional AND-filters and are applied BEFORE ordering and limiting.
     *
     * - **Residual divergence**: if a backend genuinely cannot implement part
     *   of this contract (e.g. full-text search over `content` is not
     *   available in the SDK), the adapter MUST document the limitation
     *   inline with a `// CONTRACT-DEVIATION` comment and in DECISIONS.md
     *   (DEC-PARITY) rather than silently omitting results.
     *
     * @param query     - Query string; case-insensitive substring match.
     * @param limit     - Maximum number of results to return.
     * @param project   - Optional project scope filter (exact match). `'*'`
     *                    (the default) means no project filter.
     * @param ecosystem - Optional ecosystem scope filter. NOT exact match:
     *                    `'*'` as the SCOPE means every ecosystem, and a row
     *                    whose own `ecosystem` is unscoped (`'*'`, `''`, or
     *                    unset/NULL) matches EVERY scope. Adapters push this
     *                    down as the widened OR-predicate; the one definition
     *                    is `core/ecosystemMatch.ts` (`ecosystemMatches` /
     *                    `isUnscopedEcosystem`), which the pushdown may never
     *                    disagree with. See DECISIONS.md
     *                    DEC-ECOSYSTEM-WILDCARD.
     */
    search(query: string, limit?: number, project?: string, ecosystem?: string, excludeHidden?: boolean, signals?: { scanCapHit: boolean }): Promise<LoreNode[]>;
    listNodes(type?: string, tag?: string, project?: string, ecosystem?: string, limit?: number, opts?: { unbounded?: boolean }): Promise<LoreNode[]>;
    getStats(projectFilter?: string): Promise<GraphStats>;
    getTopology(limit?: number, projects?: string[] | string, edgeLimit?: number): Promise<{ nodes: any[]; edges: any[] }>;
}

/**
 * Raw document for semantic vectorization.
 */
export interface VerbatimDocument {
    id: string;
    text: string;
    metadata: {
        type?: string;
        label?: string;
        tags?: string;
        project?: string;
        ecosystem?: string;
        updatedAt?: string;
        security_scopes?: string[];
        /**
         * PR #69 P2 — content fingerprint of the verbatim text.
         * When supplied, verbatimStore.store() uses it to short-circuit
         * re-embedding on unchanged text. When omitted, store() computes
         * it from doc.text as a safety net. Either way it lands in the
         * LanceDB row's `contentHash` column.
         */
        contentHash?: string;
    };
}

/**
 * Contextual search result from similarity search.
 */
export interface VerbatimSearchResult {
    id: string;
    score: number;
    metadata: VerbatimDocument['metadata'];
    text: string;
}

/**
 * Abstract EmbeddingProvider Interface (Q2.2 slice 6a).
 *
 * Decouples *embedding* (text → vector) from *vector storage* (the
 * VectorProvider implementations below). Both VerbatimStore (local
 * LanceDB) and DataplaneVectorStore (cloud) used to instantiate the
 * Xenova Transformers.js pipeline directly via duplicated singletons.
 * This interface lets us swap in a cloud-side embedder later (slice 6b
 * routes embedding through Dataplane's BGE-M3 service so embeddings
 * happen tenant-side, not in the daemon process) and a different local
 * model (slice 7 swaps to multilingual-e5-small) without touching the
 * vector stores.
 *
 * Contract:
 *   - `dimension` and `modelId` are stable for the lifetime of the
 *     provider instance. Vector stores read `dimension` once at boot
 *     (LanceDB schema, Dataplane vector field decl).
 *   - `initialize()` lazy-loads any heavyweight resources (HF model
 *     download, SDK auth handshake). May be called multiple times;
 *     idempotent.
 *   - `embed(text)` is called per-document and per-query. Implementations
 *     should normalize the output to L2 length 1 (cosine similarity is
 *     the common case downstream — pgvector, Arango vector, LanceDB).
 *   - Errors bubble; vector stores wrap them into their own *StoreError.
 *
 * Implementations:
 *   - LocalEmbeddingProvider — Xenova Transformers.js pipeline in-process
 *     (slice 6a, current default).
 *   - DataplaneEmbeddingProvider — POSTs to Dataplane's embedding service
 *     (slice 6b).
 */
export interface EmbeddingProvider {
    /** Vector dimension produced by `embed()`. Stable for the instance. */
    readonly dimension: number;
    /** Identifier for telemetry / logs (e.g. `'Xenova/all-MiniLM-L6-v2'`). */
    readonly modelId: string;
    /**
     * Lazy initialization hook. Idempotent; safe to call multiple times.
     * Vector stores call this from their own `initialize()`.
     */
    initialize(): Promise<void>;
    /**
     * Generic embed — used for symmetric models (MiniLM, BGE-M3) where
     * queries and documents share an embedding space without prefixes.
     * For asymmetric models (e5 family) call sites should prefer
     * `embedQuery` / `embedDocument` so the implementation can prepend
     * the model-required `query: ` / `passage: ` prefix.
     *
     * Default behaviour: an implementation may treat `embed()` as a
     * synonym for `embedDocument()` — that's the safer choice for an
     * asymmetric model where the doc-side prefix is what's stored.
     */
    embed(text: string): Promise<number[]>;
    /**
     * Encode a query string into a vector. For asymmetric models like
     * `intfloat/multilingual-e5-small`, prepends "query: " before
     * embedding (the e5 model card requires this for retrieval to
     * work — without it cosine similarity scores collapse and recall
     * returns nothing). For symmetric models, equivalent to `embed()`.
     */
    embedQuery(text: string): Promise<number[]>;
    /**
     * Encode a document/passage string into a vector. For asymmetric
     * models, prepends "passage: " before embedding. For symmetric
     * models, equivalent to `embed()`.
     *
     * VerbatimStore.store() and DataplaneVectorStore.store() call this;
     * VerbatimStore.search() and DataplaneVectorStore.search() call
     * `embedQuery`. The asymmetric prefix lives in the provider, not
     * in the storage layer, so storage stays model-agnostic.
     */
    embedDocument(text: string): Promise<number[]>;
    /**
     * Layer 2 (reconnect-fix, 2026-04-30) — batch document embedding.
     * Bulk-embeds N texts in one model call instead of N sequential
     * calls. Optional on the interface (fallback to per-item embedDocument
     * if a provider doesn't override). Significant CPU speedup on local
     * Xenova where pipeline accepts arrays natively.
     */
    embedDocumentBatch?(texts: string[]): Promise<number[][]>;
}

/**
 * Abstract VectorProvider Interface
 * Defines the contract that ANY vector database (Local LanceDB, Pinecone, Cloud) must satisfy.
 */
export interface VectorProvider {
    initialize(): Promise<void>;
    store(doc: VerbatimDocument): Promise<void>;
    /**
     * Semantic / vector similarity search over stored documents.
     *
     * **CONTRACT (SEARCH_CONTRACT_VERSION = 1) — every adapter MUST honor:**
     *
     * - **Score range**: every `VerbatimSearchResult.score` MUST be in the
     *   closed interval [0, 1], where 1 represents maximum similarity and 0
     *   represents no similarity. Adapters that receive raw distance metrics
     *   (e.g. L2 distance from LanceDB, cosine distance from pgvector) MUST
     *   convert them to a similarity score before returning.
     *     - Cosine distance → `score = 1 - cosine_distance`
     *     - L2 distance → normalize by the maximum expected distance for the
     *       model's output dimension (or clamp to [0,1] via
     *       `score = 1 / (1 + l2_distance)`).
     *
     * - **Ordering**: results MUST be returned in descending score order
     *   (highest similarity first). The caller relies on this ordering to
     *   pick the top-k candidates for downstream reranking.
     *
     * - **Limit**: the result set MUST contain at most `limit` results (or the
     *   adapter default when `limit` is omitted). Returning more than `limit`
     *   results is a contract violation.
     *
     * - **Metadata filters**: when `filter` is supplied, only documents whose
     *   stored metadata fields match ALL supplied key-value pairs (exact,
     *   case-sensitive match per field) may appear in the result. Filters are
     *   applied BEFORE the score cut-off and limit.
     *
     * - **Scope (actorScopes)**: when `actorScopes` is supplied and non-empty,
     *   only documents whose `metadata.security_scopes` is absent (public) or
     *   overlaps with `actorScopes` may be returned. Adapters MUST enforce this
     *   server-side where possible; client-side post-filtering is acceptable
     *   only when the backend does not support field-level ACL predicates, and
     *   MUST be documented with a `// CONTRACT-DEVIATION` comment.
     *
     * - **Residual divergence**: if a backend cannot produce scores in [0,1]
     *   or cannot guarantee descending order, the adapter MUST document the
     *   limitation inline and in DECISIONS.md (DEC-PARITY).
     *
     * @param query       - Natural-language query; embedded by the provider.
     * @param limit       - Maximum number of results to return.
     * @param filter      - Optional metadata field filter (exact match, AND'd).
     * @param opts        - Additional options; `includeHistory` when true
     *                      allows superseded nodes to appear in results.
     * @param actorScopes - Caller's security scopes; restricts result set.
     */
    search(query: string, limit?: number, filter?: Partial<VerbatimDocument['metadata']>, opts?: { includeHistory?: boolean }, actorScopes?: ReadonlyArray<string>): Promise<VerbatimSearchResult[]>;
    delete(id: string): Promise<void>;
    count(): Promise<number>;
    close(): Promise<void>;
}
