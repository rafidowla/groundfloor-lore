import type { QueryResult, RecordData } from "../types";
/**
 * Purpose: Interface defining options for native vector searches.
 * Inputs: Not applicable (data structure).
 * Outputs: Not applicable.
 * Error Behavior: None.
 * Side Effects: None.
 * State Contract: Simple state storage structure.
 * Determinism & Idempotency: Deterministic structure.
 * Concurrency Considerations: Thread-safe as a standard JS object.
 * Performance Notes: Zero runtime overhead.
 * Observability Expectations: No explicit logging.
 */
export interface VectorSearchOptions {
    vector: number[];
    limit?: number;
    filter?: object;
    connection?: string;
}
/**
 * Purpose: Client interface for the Groundfloor Vector extension, enabling nearest-neighbor RAG queries.
 * Inputs: Initialized with HTTP fetch context.
 * Outputs: Configured VectorClient object.
 * Error Behavior: Requires valid fetch initialization.
 * Side Effects: Stores reference to the network fetcher.
 * State Contract: Holds `fetchFunction` state internally.
 * Determinism & Idempotency: Deterministic execution.
 * Concurrency Considerations: Thread-safe operations.
 * Performance Notes: Immediate initialization.
 * Observability Expectations: Traceable via underlying HTTP metrics.
 */
export declare class VectorClient {
    private fetchFunction;
    /**
     * Purpose: Initializes the Vector binding.
     * Inputs:
     * - fetchFunction (Function): Required context network wrapper supplied by Root client.
     * Outputs: An initialized VectorClient.
     * Error Behavior: Fails on missing signature dynamically.
     * Side Effects: Rebinds state mappings to object instance explicitly.
     * State Contract: Mutates `fetchFunction` in-place.
     * Determinism & Idempotency: Idempotent object configuration.
     * Concurrency Considerations: Safe isolated memory space logic mapping.
     * Performance Notes: Non-blocking mapped operations wrapper bounds logic.
     * Observability Expectations: Fully unlogged local metrics wrapper context.
     */
    constructor(fetchFunction: <T>(path: string, options?: RequestInit) => Promise<T>);
    /**
     * Execute a nearest-neighbour vector search over a collection.
     *
     * TS-15: The tenant is derived from the authenticated credential — the old
     * leading `tenantId` argument was ignored. Call `search(collection, options)`.
     *
     * Returns `QueryResult<T>` (records, optionally with similarity metadata).
     * Read-only and idempotent.
     */
    search<T = RecordData>(collection: string, options: VectorSearchOptions): Promise<QueryResult<T>>;
    /**
     * @deprecated The leading `tenantId` is ignored (tenant comes from the
     * credential). Use `search(collection, options)`.
     */
    search<T = RecordData>(tenant: string, collection: string, options: VectorSearchOptions): Promise<QueryResult<T>>;
}
