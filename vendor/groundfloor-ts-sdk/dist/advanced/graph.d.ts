import type { QueryResult, RecordData } from "../types";
/**
 * Purpose: Defines the parameter contract for issuing a graph traversal request
 *          against the Groundfloor Data Plane Rust engine.
 *
 * Inputs:
 *   - startId (string, required): The document `_key` or `_id` to begin traversal from.
 *   - edgeCollection (string, optional): Single edge collection (backward compat).
 *   - edgeCollections (string[], optional): Multiple edge collections for multi-hop traversals.
 *     At least one of `edgeCollection` or `edgeCollections` must be provided.
 *   - direction ("in" | "out" | "both", optional): Edge direction filter. Defaults to "out".
 *   - minDepth (number, optional): Minimum hop depth. Defaults to 1.
 *   - maxDepth (number, optional): Maximum hop depth. Defaults to 1.
 *
 * Outputs: Not applicable (data structure).
 * Error Behavior: The Rust engine rejects payloads missing both edge collection fields with ERR_MISSING_EDGE_COLLECTION.
 * Side Effects: None.
 * State Contract: Plain configuration object — no mutable state.
 * Determinism & Idempotency: Deterministic structure.
 * Concurrency Considerations: Thread-safe value object.
 * Performance Notes: Zero runtime overhead.
 * Observability Expectations: None.
 */
export interface GraphTraverseOptions {
    startId: string;
    edgeCollection?: string;
    edgeCollections?: string[];
    direction?: "in" | "out" | "both";
    minDepth?: number;
    maxDepth?: number;
    connection?: string;
}
/**
 * Purpose: Defines the parameter contract for creating a graph edge (relationship).
 *
 * Inputs:
 *   - fromId (string, required): Source vertex ID (e.g., "users/alice").
 *   - toId (string, required): Target vertex ID (e.g., "roles/admin").
 *   - edgeCollection (string, required): Edge collection name.
 *   - properties (Record, optional): Additional edge properties.
 *   - connection (string, optional): Multi-connector routing.
 *
 * Error Behavior: Returns 400 if required fields are missing.
 */
export interface GraphEdgeOptions {
    fromId: string;
    toId: string;
    edgeCollection: string;
    properties?: Record<string, any>;
    connection?: string;
}
/**
 * Purpose: Defines the parameter contract for creating a graph vertex (document).
 *
 * Inputs:
 *   - data (Record, required): Vertex document body — arbitrary key-value properties.
 *   - connection (string, optional): Multi-connector routing.
 *
 * Error Behavior: Returns 400 if data is missing or empty.
 */
export interface GraphVertexOptions {
    data: Record<string, any>;
    connection?: string;
}
/**
 * Purpose: Graph client enabling relational data operations over the Groundfloor Data Plane engine.
 * Inputs: Valid fetch callback mapper.
 * Outputs: GraphClient instance with traverse, createEdge, and createVertex methods.
 * Error Behavior: Fails on network operations if improperly bounded.
 * Side Effects: Manages HTTP requests to graph endpoints.
 * State Contract: Holds a single fetchFunction reference internally.
 * Determinism & Idempotency: Fully deterministic binding mechanism.
 * Concurrency Considerations: Thread-safe instance representation.
 * Performance Notes: Zero overhead instantiation.
 * Observability Expectations: Standard error bubbling on requests.
 */
export declare class GraphClient {
    private fetchFunction;
    constructor(fetchFunction: <T>(path: string, options?: RequestInit) => Promise<T>);
    /**
     * Execute a graph traversal, walking edges from a start vertex. Supports
     * single and multi-edge-collection traversals.
     *
     * TS-15: The tenant is derived from the authenticated credential — the old
     * leading `tenantId` argument was ignored. Call `traverse(collection, options)`.
     *
     * Outputs: Promise<QueryResult<T>> — traversed records with metadata.
     * Error Behavior: 400 on missing edge collections / invalid direction; 404 if
     *   the collection is missing. Deterministic given a stable graph; safe to retry.
     */
    traverse<T = RecordData>(collection: string, options: GraphTraverseOptions): Promise<QueryResult<T>>;
    /**
     * @deprecated The leading `tenantId` is ignored (tenant comes from the
     * credential). Use `traverse(collection, options)`.
     */
    traverse<T = RecordData>(tenant: string, collection: string, options: GraphTraverseOptions): Promise<QueryResult<T>>;
    /**
     * Create a graph edge (relationship) between two vertices.
     *
     * TS-15: The tenant is derived from the authenticated credential — the old
     * leading `tenantId` argument was ignored. Call `createEdge(collection, options)`.
     *
     * Outputs: Promise<{ edge_id: string }>. 400 on missing fields; 501 if the
     *   connector lacks graph support. Not idempotent — each call creates an edge.
     */
    createEdge(collection: string, options: GraphEdgeOptions): Promise<{
        edge_id: string;
    }>;
    /**
     * @deprecated The leading `tenantId` is ignored (tenant comes from the
     * credential). Use `createEdge(collection, options)`.
     */
    createEdge(tenant: string, collection: string, options: GraphEdgeOptions): Promise<{
        edge_id: string;
    }>;
    /**
     * Create a graph vertex with auto-injected audit metadata (did, created_at,
     * updated_at, created_by, updated_by).
     *
     * TS-15: The tenant is derived from the authenticated credential — the old
     * leading `tenantId` argument was ignored. Call `createVertex(collection, options)`.
     *
     * Outputs: Promise<{ did, created_at }>. 400 on missing/empty data. Not
     *   idempotent — each call creates a new vertex.
     */
    createVertex(collection: string, options: GraphVertexOptions): Promise<{
        did: string;
        created_at: string;
    }>;
    /**
     * @deprecated The leading `tenantId` is ignored (tenant comes from the
     * credential). Use `createVertex(collection, options)`.
     */
    createVertex(tenant: string, collection: string, options: GraphVertexOptions): Promise<{
        did: string;
        created_at: string;
    }>;
}
