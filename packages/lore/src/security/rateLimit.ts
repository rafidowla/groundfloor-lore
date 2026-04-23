/**
 * rateLimit.ts — In-memory token-bucket rate limiter for the HTTP daemon (S5).
 *
 * Why: without a limit, any local process (including a glitching UI in a
 * retry loop, or a hostile local binary) can hammer expensive routes —
 * /api/graph/reconnect, /api/graph/reconsume, /api/extract, /api/chat.
 * Reconnect alone is minutes of CPU; extract can incur real dollars if
 * a cloud LLM is the active provider.
 *
 * Design:
 *   - One bucket per endpoint class (not per caller). We're localhost-
 *     only; there's no meaningful client identity beyond the auth token,
 *     and the auth token is shared across all legitimate callers on this
 *     machine. A per-class bucket is the right granularity.
 *   - Token bucket: `capacity` tokens max, refills at `refillPerMs`
 *     tokens per millisecond. Each allowed request debits one token.
 *     When empty, return 429 with a Retry-After indicating when the
 *     next token will be available.
 *   - In-memory only — resets on daemon restart. That's the correct
 *     semantics: limits should be soft and recover on operator action.
 *
 * Not handled here (future):
 *   - Per-token / per-origin sub-buckets (when multiple users share a
 *     daemon in a future multi-user model).
 *   - Distributed rate limiting across a cluster (not relevant to the
 *     single-node local model).
 *   - Sliding-window analytics / observability. For now, 429s land in
 *     stderr, and failures happen in the caller's retry logic.
 */

export interface BucketConfig {
    /** Max tokens the bucket holds. Burst capacity. */
    capacity: number;
    /** Refill rate in tokens per millisecond. */
    refillPerMs: number;
}

interface Bucket extends BucketConfig {
    tokens: number;
    lastRefillMs: number;
}

/**
 * Default buckets by endpoint class.
 *
 * Tuned to be generous enough that a human user never hits them in
 * normal flow, but tight enough to stop a runaway client quickly.
 *
 *   chat          — 60/min burst 30: supports interactive conversation
 *                   with occasional multi-shot; catches a retry loop fast.
 *   reconnect     — 5 per 10 min burst 2: reconnect is minutes of CPU,
 *                   and legitimate use is "click and wait" — never 5/sec.
 *   reconsume     — 5 per 10 min burst 2: same cost profile as reconnect.
 *   extract       — 30/min burst 10: external LLM call, cost/latency
 *                   sensitive.
 *   destructive   — 20/min burst 5: DELETE workspace, reset config,
 *                   orphan-drop. Legit but rare; runaway = expensive.
 *   generic       — 300/min burst 100: everything else (config reads,
 *                   node fetches, topology).
 */
const DEFAULT_BUCKETS: Record<string, BucketConfig> = {
    chat:        { capacity: 30,  refillPerMs: 60 / 60_000 },
    reconnect:   { capacity: 2,   refillPerMs: 5 / 600_000 },
    reconsume:   { capacity: 2,   refillPerMs: 5 / 600_000 },
    extract:     { capacity: 10,  refillPerMs: 30 / 60_000 },
    destructive: { capacity: 5,   refillPerMs: 20 / 60_000 },
    generic:     { capacity: 100, refillPerMs: 300 / 60_000 },
};

/**
 * Classify an HTTP request into a rate-limit bucket. Callers that land in
 * the `null` bucket are skipped (rate-limit-exempt — health, bootstrap).
 */
export function classifyRequest(url: string, method: string): string | null {
    const pathOnly = url.split('?')[0];

    // Exempt: liveness + auth bootstrap.
    if (pathOnly === '/health' || pathOnly === '/api/health' || pathOnly === '/api/auth/bootstrap') {
        return null;
    }

    if (pathOnly === '/api/chat') return 'chat';
    if (pathOnly === '/api/graph/reconnect') return 'reconnect';
    if (pathOnly === '/api/graph/reconsume') return 'reconsume';
    if (pathOnly === '/api/extract') return 'extract';

    // Destructive-class: DELETE, or known mutation endpoints.
    if (method === 'DELETE') return 'destructive';
    if (pathOnly === '/api/orphan' && method === 'POST') return 'destructive';
    if (pathOnly === '/api/workspaces/switch' && method === 'POST') return 'destructive';

    // Catch-all for /api/*. Non-/api/ (e.g. /mcp) is not rate-limited here
    // because the MCP SDK has its own session semantics; bolting a bucket
    // on /mcp would need per-session accounting.
    if (pathOnly.startsWith('/api/')) return 'generic';

    return null;
}

export class RateLimiter {
    private readonly buckets: Map<string, Bucket>;
    private readonly configs: Record<string, BucketConfig>;

    constructor(configs: Record<string, BucketConfig> = DEFAULT_BUCKETS) {
        this.configs = configs;
        this.buckets = new Map();
    }

    /**
     * Attempt to debit one token from `bucketName`. Returns:
     *   { allowed: true }                      — proceed with request
     *   { allowed: false, retryAfterSec: N }   — reject with 429
     */
    tryConsume(bucketName: string, nowMs: number = Date.now()): { allowed: true } | { allowed: false; retryAfterSec: number } {
        const cfg = this.configs[bucketName];
        if (!cfg) {
            // Unknown bucket — fail open. Should not happen if classifyRequest
            // only returns known names, but defense in depth.
            return { allowed: true };
        }

        let bucket = this.buckets.get(bucketName);
        if (!bucket) {
            bucket = { ...cfg, tokens: cfg.capacity, lastRefillMs: nowMs };
            this.buckets.set(bucketName, bucket);
        }

        // Refill based on elapsed time.
        const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
        const refill = elapsedMs * bucket.refillPerMs;
        bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill);
        bucket.lastRefillMs = nowMs;

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return { allowed: true };
        }

        // Bucket empty — compute when next token will be available.
        const tokensNeeded = 1 - bucket.tokens;
        const waitMs = tokensNeeded / bucket.refillPerMs;
        const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
        return { allowed: false, retryAfterSec };
    }
}
