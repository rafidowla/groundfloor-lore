/**
 * Purpose: WebSocket client for v3.2 Block 2 Live Subscribe. Connects to
 *   `/v1/:collection/subscribe` (v2.0 — tenant comes from authenticated
 *   credential), handles JSON framing, server-driven heartbeat/pong, and
 *   auto-reconnect with exponential backoff.
 * Inputs: SubscribeOptions with collection/filter/events/handlers.
 * Outputs: Subscription handle with close() + async iteration.
 * Error Behavior: onError(err, retryable) invoked for all failures; unhandled
 *   ones terminate the subscription. Auth failures (401/403) are non-retryable.
 * Side Effects: Opens a WebSocket connection; keeps a reconnect loop running
 *   until close() is called.
 * State Contract: No shared state with the parent client beyond the Bearer
 *   token captured at construction.
 * Determinism & Idempotency: The reconnect path re-delivers events produced
 *   post-disconnect; consumer dedup by id is the app's responsibility.
 * Concurrency Considerations: One WebSocket = one subscription. Multiple
 *   subscriptions can run in parallel; each spawns its own connect loop.
 * Performance Notes: O(1) frame delivery; events that fail filter match are
 *   server-side dropped before sending.
 * Observability Expectations: onError is the single callback surface.
 */
export type SubscribeEventKind = "created" | "updated" | "deleted";
export interface SubscribeEvent {
    kind: SubscribeEventKind;
    collection: string;
    id: string;
    record: Record<string, any>;
    ts: number;
    partial?: boolean;
}
export interface SubscribeOptions {
    collection: string;
    filter?: Record<string, any>;
    events?: SubscribeEventKind[];
    onEvent?: (ev: SubscribeEvent) => void | Promise<void>;
    onError?: (err: Error, retryable: boolean) => void | Promise<void>;
    /** Initial reconnect backoff in ms (doubled each attempt). Default 100. */
    reconnectBaseMs?: number;
    /** Maximum reconnect backoff ceiling in ms. Default 10000. */
    reconnectMaxMs?: number;
    /** Maximum number of reconnect attempts before giving up and invoking
     *  `onError(..., false)`. Default Infinity (reconnect forever). */
    maxReconnectAttempts?: number;
}
/**
 * Transport-level configuration injected by GroundfloorClient.
 */
export interface SubscriptionTransportOptions {
    /** Browser WebSocket auth strategy — the browser WebSocket API cannot set an
     *  `Authorization` header on the handshake, which is the only credential the
     *  engine reads. Strategies:
     *  - "error" (default): throw a clear, actionable error instead of silently
     *    opening an UNAUTHENTICATED socket.
     *  - "query": append `?access_token=<token>` (only safe behind a gateway that
     *    translates it into the Authorization header).
     *  - "subprotocol": pass the token as the `bearer.<token>` WebSocket
     *    subprotocol (same gateway-translation use case). */
    browserWsAuth?: "error" | "query" | "subprotocol";
}
export declare class SubscriptionError extends Error {
    readonly code?: string;
    constructor(message: string, code?: string);
}
export declare class Subscription {
    private baseUrl;
    private apiKey;
    private opts;
    private closed;
    private ws;
    private loopPromise;
    private backoff;
    private readonly backoffMax;
    private readonly maxAttempts;
    private attempts;
    private readonly browserWsAuth;
    constructor(baseUrl: string, apiKey: string, opts: SubscribeOptions, transport?: SubscriptionTransportOptions);
    close(): Promise<void>;
    private buildUrl;
    /**
     * TS-9: Invoke the user's `onError` callback without ever letting it crash
     * the reconnect loop. A throwing (or rejecting) `onError` would otherwise
     * become an unhandled promise rejection — which terminates the Node process
     * by default. Failures inside `onError` are swallowed (best-effort) since
     * there is no higher error channel to route them to.
     */
    private safeOnError;
    private run;
    private runOnce;
}
