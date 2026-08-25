/**
 * Purpose: Defines the standard OpenTelemetry (OTLP) structure for metrics representation.
 * Inputs: N/A
 * Outputs: N/A
 * Error Behavior: Strict compile-time typing.
 * Side Effects: None.
 * State Contract: Interfaces only.
 * Determinism & Idempotency: Deterministic schema.
 * Concurrency Considerations: Thread-safe schemas.
 * Performance Notes: Zero execution overhead.
 * Observability Expectations: N/A.
 */
export interface OtlpMetric {
    name: string;
    value: number;
    attributes: Record<string, any>;
    timestamp: number;
}
/**
 * Purpose: Defines the standard OpenTelemetry (OTLP) structure for log representation mapping traces natively.
 * Inputs: N/A
 * Outputs: N/A
 * Error Behavior: Strict compile-time typing.
 * Side Effects: None.
 * State Contract: Interfaces only.
 * Determinism & Idempotency: Deterministic schema.
 * Concurrency Considerations: Thread-safe schemas.
 * Performance Notes: Zero execution overhead.
 * Observability Expectations: N/A.
 */
export interface OtlpLog {
    timestamp: number;
    severity: string;
    body: string;
    attributes: Record<string, any>;
}
/**
 * Purpose: Defines the structured payload format sent to the Groundfloor Dataplane ingest endpoint.
 * Inputs: N/A
 * Outputs: N/A
 * Error Behavior: Strict compile-time typing.
 * Side Effects: None.
 * State Contract: Interfaces only.
 * Determinism & Idempotency: Deterministic schema.
 * Concurrency Considerations: Thread-safe schemas.
 * Performance Notes: Zero execution overhead.
 * Observability Expectations: N/A.
 */
export interface OtlpPayload {
    metrics: OtlpMetric[];
    logs: OtlpLog[];
}
/**
 * Purpose: A lightweight OpenTelemetry (OTLP) Emitter Client that manages an internal buffer of
 * metrics and traces, periodically flushing them to the Groundfloor Dataplane asynchronously.
 * Inputs: None (class boundary).
 * Outputs: TelemetryClient instance. Stable contract.
 * Error Behavior: Handles network ingestion failures gracefully and drops payloads silently to prevent application crashes.
 * Side Effects: Installs a background interval for periodic polling of internal buffers.
 *               Makes async POST requests over the network.
 * State Contract: Mutates an internal memory array holding metrics and traces pending delivery.
 *                 Buffer arrays are emptied upon flush attempts.
 * Determinism & Idempotency: Nondeterministic flushing timeline depending on environment timer logic. Flush logic removes processed state.
 * Concurrency Considerations: Thread-safe representation. In JavaScript event loop contexts, Array mutation functions are synchronous.
 * Performance Notes: Internal array operations are high speed. Periodic flush operations occur asynchronously and are completely non-blocking to the main execution thread.
 * Observability Expectations: Client ingestion failures output a silent `console.warn` message mapping Dataplane errors, mitigating application noise.
 */
/**
 * Optional tuning for {@link TelemetryClient}. Secure, conservative defaults
 * are applied when omitted.
 */
export interface TelemetryOptions {
    /** Flush interval in milliseconds. Default 5000. */
    flushIntervalMs?: number;
    /** Max retained entries per buffer (metrics and logs each). Oldest entries
     *  are dropped when exceeded (and counted in `droppedCount`). Default 10000. */
    maxBufferSize?: number;
    /** Optional callback invoked when a flush fails or entries are dropped, so
     *  the app can react to observability loss. */
    onDrop?: (info: {
        reason: "flush_failed" | "buffer_overflow";
        dropped: number;
        error?: Error;
    }) => void;
}
export declare class TelemetryClient {
    private fetchMethod;
    private metricsBuffer;
    private logsBuffer;
    private intervalRef;
    private readonly flushIntervalMs;
    private readonly maxBufferSize;
    private readonly onDrop?;
    /** Total entries dropped over the client's lifetime (overflow + flush failure). */
    private droppedCount;
    /** Serializes flushes — prevents overlapping in-flight POSTs (Finding 7). */
    private flushing;
    private closed;
    /**
     * Purpose: Initializes the TelemetryClient attaching the injected HTTP transport layer.
     * Inputs:
     * - fetchMethod: Bound asynchronous network executor injected by the GroundfloorClient parent. Required.
     * Outputs: Configured TelemetryClient. Stable contract.
     * Error Behavior: Fails on missing executor argument logically.
     * Side Effects: Spawns a background timer to iteratively evaluate and empty local telemetry buffers every 5000ms.
     * State Contract: Initializes empty buffer arrays and local variables mapping configuration state bounds.
     * Determinism & Idempotency: Deterministic setup constraints.
     * Concurrency Considerations: Safe initialization mappings without external lock dependencies.
     * Performance Notes: Negligible sync logic block allocation impact.
     * Observability Expectations: Unlogged instantiation tracking.
     */
    constructor(fetchMethod: <T>(path: string, options?: RequestInit) => Promise<T>, options?: TelemetryOptions);
    /** Number of telemetry entries dropped over this client's lifetime. */
    getDroppedCount(): number;
    /** Enforce the per-buffer cap by dropping the oldest entries (Finding 6). */
    private enforceCap;
    /**
     * Purpose: Records a discrete measurement mapping against standard tags iteratively capturing runtime metrics securely into local buffer stores.
     * Inputs:
     * - name (string): Target metric identifier string. Required.
     * - value (number): Numeric state magnitude representation. Required.
     * - tags (Record<string, string>): Dictionary map referencing contextual state bounds. Required.
     * Outputs: void.
     * Error Behavior: Unvalidated memory map append block preventing type conflicts on properly shaped data.
     * Side Effects: Mutates local `metricsBuffer` by allocating and pushing an `OtlpMetric` representation into array scope.
     * State Contract: Mutates internal array in-place.
     * Determinism & Idempotency: Deterministic memory push operation. Repeated identical calls produce array append replicas natively.
     * Concurrency Considerations: Synchronous operation array push safe on single-threaded event loop bound applications.
     * Performance Notes: Nano-second class internal tracking speeds.
     * Observability Expectations: Silent block operation with unlogged event markers.
     */
    recordMetric(name: string, value: number, tags?: Record<string, string>): void;
    /**
     * Purpose: Logs time-series latency events matching execution blocks wrapping logic chains within an environment mapping.
     * Inputs:
     * - name (string): Execution block operation identity. Required.
     * - durationMs (number): Number recording logic duration span. Required.
     * - tags (Record<string, string>): Property set appending additional analytical bounds safely. Required.
     * Outputs: void.
     * Error Behavior: Never throws. Appends structure block memory locally mapping duration properties mapped against generic logic.
     * Side Effects: Appends formatted `OtlpLog` instance representation inside `logsBuffer` target dynamically.
     * State Contract: Memory structure boundary object mapped locally array logic bounds mutating actively.
     * Determinism & Idempotency: Deterministically updates array targets. Iterative repeat calls duplicate memory block elements.
     * Concurrency Considerations: Loop safety guarantees non-concurrent array modifications locally.
     * Performance Notes: Non-blocking synchronous local map manipulation achieving high speed block completions.
     * Observability Expectations: Metrics remain locally mapped and untouched by external console interfaces.
     */
    recordTrace(name: string, durationMs: number, tags?: Record<string, any>): void;
    /**
     * Purpose: Asynchronously dispatches batched memory buffers containing stored traces and metrics into Dataplane OTLP ingestion networks mapping.
     * Inputs: None.
     * Outputs: Promise<boolean> indicating successfully transmitted buffer status map values.
     * Error Behavior: Catches external network HTTP 500/503 states internally dropping structures safely emitting single logic warning string preventing app crash block structures.
     * Side Effects: Wipes internal memory buffer pointers securely, initiates async unblocking external IO fetching payloads directly.
     * State Contract: Discards and resets array maps representing bounds logic locally. Resets buffer memory in place immediately upon dispatch execution call.
     * Determinism & Idempotency: Non-Idempotent execution. Network transmission state dependent on current array targets payload size length maps statically.
     * Concurrency Considerations: Non-blocking fetch bounds execution gracefully across execution stack logic trees dynamically mapping against Node.js/Browser thread patterns.
     * Performance Notes: External boundary IO mapped execution block mapping payload constraints matching JSON serialization times.
     * Observability Expectations: Logs an internal silent warning exclusively on failure catch blocks without throwing blocking exceptions disrupting calling client stacks.
     */
    flush(): Promise<boolean>;
    /** Stop the background timer and attempt one final synchronous-await flush so
     *  buffered telemetry is drained on clean shutdown (Finding 7). Safe to call
     *  more than once. */
    close(): Promise<void>;
    /**
     * Purpose: Initializes an unblocking environmental timer iteratively executing standard memory buffer extraction payloads matching network ingestion maps dynamically.
     * Inputs: None.
     * Outputs: void.
     * Error Behavior: Silently operates without unhandled logical rejections based on standard timer mappings safely wrapping buffer state executions.
     * Side Effects: Modifies JavaScript global registry attaching intervals securely executing logic calls.
     * State Contract: Attaches interval variable against local class instance references directly.
     * Determinism & Idempotency: Expected repetitive task block trigger structure tracking elapsed timestamps sequentially.
     * Concurrency Considerations: Fully non-blocking event runtime dependent loop operations.
     * Performance Notes: Background mapping event utilizing 5000ms pause patterns preventing CPU overhead spikes reliably safely.
     * Observability Expectations: Runs invisibly logic mapping triggers continuously mapping blocks internally.
     */
    private startBackgroundFlush;
}
