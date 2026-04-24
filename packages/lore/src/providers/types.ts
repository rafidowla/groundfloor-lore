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
