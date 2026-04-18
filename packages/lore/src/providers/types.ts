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
}

/**
 * Edge definition for graph relationships.
 */
export interface LoreEdge {
    sourceId: string;
    targetId: string;
    relation: string;
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
 */
export interface GraphStats {
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
    codeSymbolCount: number;
    codeRelationCount: number;
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
