/**
 * TS-4: Correct return type for `window()`. The engine returns
 * `TimeSeriesResponse { points, total_count }` (models.rs:650-659),
 * not `QueryResult { records }`.
 */
export interface TimeSeriesPoint {
    window_start: string;
    value: number;
}
export interface TimeSeriesResult {
    points: TimeSeriesPoint[];
    total_count: number;
}
/**
 * Purpose: Defines parameters for analytics windowing operations.
 * Inputs: N/A.
 * Outputs: N/A.
 * Error Behavior: N/A.
 * Side Effects: None.
 * State Contract: Plain interface.
 * Determinism & Idempotency: Deterministic format.
 * Concurrency Considerations: Thread-safe native object.
 * Performance Notes: Zero overhead.
 * Observability Expectations: N/A.
 */
export interface AnalyticsWindowOptions {
    timeField: string;
    aggregation: "count" | "sum" | "avg" | "min" | "max";
    valueField?: string;
    windowDuration: string;
}
/**
 * Purpose: Binds advanced time-series Analytics queries to the Groundfloor cluster.
 * Inputs: Valid network fetcher.
 * Outputs: AnalyticsClient instance.
 * Error Behavior: Requires valid initialization.
 * Side Effects: None.
 * State Contract: Stores fetch callback.
 * Determinism & Idempotency: Deterministic struct.
 * Concurrency Considerations: Safe for async access.
 * Performance Notes: Lightweight wrapper.
 * Observability Expectations: No explicit logging natively.
 */
export declare class AnalyticsClient {
    private fetchFunction;
    /**
     * Purpose: Initializes an Analytics endpoint binding.
     * Inputs:
     * - fetchFunction (Function): Required network callback.
     * Outputs: Object instance.
     * Error Behavior: Fails if callback is invalid.
     * Side Effects: Binds callback to object.
     * State Contract: Mutates local state during setup.
     * Determinism & Idempotency: Idempotent initialization.
     * Concurrency Considerations: Safe.
     * Performance Notes: Non-blocking.
     * Observability Expectations: Silent setup.
     */
    constructor(fetchFunction: <T>(path: string, options?: RequestInit) => Promise<T>);
    /**
     * Group records into time-windows and apply a metric aggregation.
     *
     * TS-4: Returns `TimeSeriesResult { points, total_count }` (engine
     * `TimeSeriesResponse`, models.rs:650-659).
     *
     * TS-15: The tenant is derived from the authenticated credential — the old
     * leading `tenantId` argument was ignored. Call `window(collection, options)`.
     */
    window(collection: string, options: AnalyticsWindowOptions): Promise<TimeSeriesResult>;
    /**
     * @deprecated The leading `tenantId` is ignored (tenant comes from the
     * credential). Use `window(collection, options)`.
     */
    window(tenant: string, collection: string, options: AnalyticsWindowOptions): Promise<TimeSeriesResult>;
}
