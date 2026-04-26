/**
 * Base Lore Node definition representing a discrete piece of knowledge.
 */
export interface LoreNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string;
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
 * High level statistics interface for Graph health monitoring.
 *
 * Core fields (nodeCount, edgeCount, typeBreakdown) describe the
 * LoreNode / LoreEdge surface core owns. Plugin-specific counts
 * (e.g. code symbols, memories, contracts) live under `pluginStats`,
 * keyed by plugin name then by metric name. Core never names these
 * metrics — they're whatever a plugin returns from `contributeStats`.
 *
 * Example:
 *   pluginStats: {
 *     developer: { codeSymbolCount: 241, codeRelationCount: 496 },
 *     personal:  { memoryCount: 54 },
 *   }
 */
export interface GraphStats {
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
    pluginStats: Record<string, Record<string, number>>;
}

/**
 * Abstract GraphProvider Interface
 * Defines the contract that ANY backend graph (Local Kùzu, Cloud Dataplane) must satisfy.
 */
export interface GraphProvider {
    initialize(): Promise<void>;
    upsertNode(nodeData: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode>;
    getNode(id: string): Promise<LoreNode | null>;
    deleteNode(id: string): Promise<boolean>;
    addEdge(edge: LoreEdge): Promise<void>;
    addBidirectionalEdge(edge: LoreEdge): Promise<void>;
    traverse(nodeId: string, maxDepth?: number): Promise<TraversalResult[]>;
    search(query: string, limit?: number, project?: string, ecosystem?: string): Promise<LoreNode[]>;
    listNodes(type?: string, tag?: string, project?: string, ecosystem?: string): Promise<LoreNode[]>;
    getStats(): Promise<GraphStats>;
    getTopology(limit?: number): Promise<{ nodes: any[]; edges: any[] }>;
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
}

/**
 * Abstract VectorProvider Interface
 * Defines the contract that ANY vector database (Local LanceDB, Pinecone, Cloud) must satisfy.
 */
export interface VectorProvider {
    initialize(): Promise<void>;
    store(doc: VerbatimDocument): Promise<void>;
    search(query: string, limit?: number, filter?: Partial<VerbatimDocument['metadata']>): Promise<VerbatimSearchResult[]>;
    delete(id: string): Promise<void>;
    count(): Promise<number>;
    close(): Promise<void>;
}
