/**
 * rateLimit.ts — In-memory token-bucket rate limiter for the HTTP daemon.
 *
 * W9 (Sprint W follow-on) redesign:
 *   - Per-principal sub-buckets (was: single global bucket per class).
 *     Each Bearer token (or X-Lore-Workspace tenant key in cloud mode)
 *     gets its own bucket draining independently so one client's burst
 *     does not starve another's interactive turn.
 *   - Mode-aware defaults: local mode treats the daemon as
 *     single-operator (essentially unthrottled — circuit-breaker only,
 *     cap 5000 refill 500/s), cloud mode is the multi-tenant safe
 *     default (per-tenant cap 1000 refill 100/s — higher than the
 *     pre-W9 global 100 because tenant isolation prevents starvation).
 *   - Env overrides: LORE_RATE_LIMIT_CAP / LORE_RATE_LIMIT_REFILL
 *     (per-second), applied as overrides to the `generic` bucket only.
 *   - Bulk endpoints exempt (W4 bulk-list + 4 W9 bulk-write/delete/
 *     recall paths). The classifier returns `null` for these so they
 *     skip the limiter entirely. Auth + ReBAC gates still run.
 *
 * Why per-principal: pre-W9, deleting 5,829 atlas nodes via the
 * destructive bucket (cap 5, refill 5/min) took ~20 minutes for a
 * one-time cleanup. Per-principal lets the operator's cleanup tool
 * drain its own bucket without affecting other clients, and the much
 * larger local default (5000) makes one-time bulk ops complete in
 * seconds. Bulk endpoints are the surgical option — they are exempt.
 *
 * Why exempt vs higher-bucketed: simpler to reason about. Bulk
 * endpoints are intended for cron / cleanup / closure flows that
 * already do their own batching; adding a second bucket layer doubles
 * the failure modes without changing the operator's experience.
 *
 * In-memory only — resets on daemon restart. That's the correct
 * semantics: limits should be soft and recover on operator action.
 */

export type DeploymentMode = 'local' | 'cloud';

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

export interface RateLimitConfigSnapshot {
    mode: DeploymentMode;
    defaults: Record<string, { capacity: number; refillPerSec: number }>;
    exemptPaths: string[];
    envOverride: { cap: number | null; refillPerSec: number | null };
}

/* ── Exemption list ─────────────────────────────────────────────── */

/**
 * Paths the limiter never throttles. classifyRequest returns null for
 * these; the middleware skips tryConsume entirely. Auth + ReBAC gates
 * still run upstream. Kept as an exported constant so /api/health can
 * surface the same list operators see in code.
 */
export const RATE_LIMIT_EXEMPT_PATHS: ReadonlyArray<string> = [
    '/health',
    '/api/health',
    // /api/auth/bootstrap is NOT exempt — it has its own dedicated tight
    // `bootstrap` bucket (see buildDefaultBuckets). The UI calls it once
    // on load; an unauthenticated local process hammering it for the
    // master token must be throttled. The per-principal key collapses to
    // "anon" for unauthenticated callers, so all such callers drain one
    // shared bucket — the intended abuse-isolation shape.
    // W4: cursor-paginated full enumeration. Exempt from generic so a
    // 6-call full-workspace scan does not stall on the per-class cap.
    '/api/nodes/bulk-list',
    // W9: dedicated bulk-write / bulk-delete / bulk-recall endpoints.
    // Each accepts up to 1000 items per call and returns per-item
    // status; not throttled because they're the right tool for the
    // job the per-call bucket was tripping on.
    '/api/nodes/bulk',
    '/api/edges/bulk',
    '/api/nodes/bulk-delete',
    '/api/recall/bulk',
];
const EXEMPT_SET = new Set(RATE_LIMIT_EXEMPT_PATHS);

/* ── Defaults per mode ──────────────────────────────────────────── */

function readEnvNumber(name: string): number | null {
    const raw = process.env[name];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Build the default bucket table for `mode`, applying any env
 * overrides (LORE_RATE_LIMIT_CAP / LORE_RATE_LIMIT_REFILL) to the
 * `generic` bucket only — the targeted overrides for chat / extract /
 * reconnect would need their own env keys if/when that need surfaces.
 *
 * Tuning rationale (per W9 spec):
 *   chat        — 60/min burst 30: interactive turn cadence.
 *   reconnect   — 5 per 10 min burst 2: minutes of CPU per call.
 *   reconsume   — 5 per 10 min burst 2: same cost profile.
 *   extract     — 30/min burst 10: external-LLM cost/latency.
 *   destructive — local 100/min burst 50, cloud 60/min burst 20.
 *                 Pre-W9 was 20/min/burst 5 which is what blocked the
 *                 5,829-node atlas cleanup; bulk-delete is now the
 *                 surgical path, but raise the per-item ceiling too.
 *   generic     — local 30000/min burst 5000, cloud 6000/min burst 1000.
 *                 Local is sole-operator; cloud is per-tenant.
 */
export function buildDefaultBuckets(mode: DeploymentMode): Record<string, BucketConfig> {
    const envCap = readEnvNumber('LORE_RATE_LIMIT_CAP');
    const envRefillPerSec = readEnvNumber('LORE_RATE_LIMIT_REFILL');

    const isLocal = mode === 'local';
    const genericCapacity = envCap ?? (isLocal ? 5000 : 1000);
    const genericRefillPerSec = envRefillPerSec ?? (isLocal ? 500 : 100);

    return {
        chat:        { capacity: 30,  refillPerMs: 60 / 60_000 },
        reconnect:   { capacity: 2,   refillPerMs: 5 / 600_000 },
        reconsume:   { capacity: 2,   refillPerMs: 5 / 600_000 },
        extract:     { capacity: 10,  refillPerMs: 30 / 60_000 },
        // Bootstrap token mint: the UI fetches this once per load. A tight
        // burst of 5 + 5/min refill is generous for legitimate use (page
        // reloads, dev hot-reloads) but caps an unauthenticated local
        // process hammering the endpoint for the master token. The same
        // shape applies in both modes because the endpoint is always
        // localhost-bound and unauthenticated.
        bootstrap:   { capacity: 5,   refillPerMs: 5 / 60_000 },
        destructive: {
            // Local: sole operator — circuit-breaker only (cap 1000
            // refill 100/s mirrors generic). The /tmp/delete-atlas-nodes-v2.sh
            // cleanup that motivated W9 issued ~5,829 individual
            // DELETEs; under the pre-W9 cap (5/min) this took 20 min,
            // under local W9 it finishes in seconds. The proper tool
            // for bulk work is /api/nodes/bulk-delete (exempt) but the
            // per-call path must not be the bottleneck either.
            //
            // Cloud: per-tenant DELETE/orphan-drop cap stays tight
            // because the failure mode (irrecoverable data loss) is
            // worse than the recovery cost (operator waits and retries).
            capacity:    isLocal ? 1000 : 20,
            refillPerMs: isLocal ? 100 / 1000 : 60 / 60_000,
        },
        generic: {
            capacity:    genericCapacity,
            refillPerMs: genericRefillPerSec / 1000,
        },
    };
}

/* ── Request classifier ─────────────────────────────────────────── */

/**
 * Classify an HTTP request into a rate-limit bucket. Returns null
 * (skip the limiter) for exempt paths.
 */
export function classifyRequest(url: string, method: string): string | null {
    const pathOnly = url.split('?')[0];

    if (EXEMPT_SET.has(pathOnly)) return null;

    if (pathOnly === '/api/chat') return 'chat';
    if (pathOnly === '/api/graph/reconnect') return 'reconnect';
    if (pathOnly === '/api/graph/reconsume') return 'reconsume';
    if (pathOnly === '/api/extract') return 'extract';
    if (pathOnly === '/api/auth/bootstrap' && method === 'GET') return 'bootstrap';

    // Destructive-class: DELETE, or known mutation endpoints.
    if (method === 'DELETE') return 'destructive';
    if (pathOnly === '/api/orphan' && method === 'POST') return 'destructive';
    if (pathOnly === '/api/workspaces/switch' && method === 'POST') return 'destructive';

    // Catch-all for /api/*. Non-/api/ (e.g. /mcp) is not rate-limited
    // here — the MCP SDK has its own session semantics.
    if (pathOnly.startsWith('/api/')) return 'generic';

    // D2-auth-2 — the Bearer-gated /v1/* SDK tabular CRUD surface was
    // previously unbucketed, leaving destructive ops (DELETE
    // /v1/{collection}/delete-by-query, POST /v1/{collection}/truncate)
    // and all generic /v1 mutations entirely unthrottled. Mirror the
    // /api/* classification: DELETE / known wipes drain the destructive
    // bucket, everything else /v1 drains generic.
    if (pathOnly.startsWith('/v1/')) {
        if (method === 'DELETE') return 'destructive';
        if (pathOnly.endsWith('/truncate') && method === 'POST') return 'destructive';
        return 'generic';
    }

    return null;
}

/* ── Bucket key derivation ──────────────────────────────────────── */

export interface TryConsumeContext {
    /** Principal-side identity for per-token bucketing.
     *  - Local mode: the auth token prefix (or "bootstrap" for legacy)
     *  - Cloud mode: the X-Lore-Workspace tenant + token prefix
     *  - Unauthenticated: "anon" (caller is rare; auth gate fires first) */
    principalKey?: string;
    /** Optional cloud-mode tenant key (X-Lore-Workspace). Composed
     *  into the bucket id alongside principalKey so each (token,
     *  tenant) pair drains an isolated bucket. */
    tenantKey?: string;
}

function composeBucketKey(bucketClass: string, ctx: TryConsumeContext | undefined): string {
    const principal = ctx?.principalKey ?? 'anon';
    const tenant = ctx?.tenantKey ?? '';
    return tenant
        ? `${bucketClass}::${tenant}::${principal}`
        : `${bucketClass}::${principal}`;
}

/* ── RateLimiter class ──────────────────────────────────────────── */

/* ── SP-11 sweeper tuning ───────────────────────────────────────── */

/** Buckets idle (no refill/debit) longer than this are evicted. After a
 *  full idle period a bucket has refilled to capacity, so re-creation is
 *  free (a fresh bucket starts at capacity too). 1 hour mirrors the
 *  activeSessions idle horizon. */
const IDLE_BUCKET_TTL_MS = 60 * 60 * 1000;
/** How often the background sweep runs when autoSweep is enabled. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class RateLimiter {
    private readonly buckets: Map<string, Bucket>;
    private readonly configs: Record<string, BucketConfig>;
    private readonly mode: DeploymentMode;
    private readonly envOverride: { cap: number | null; refillPerSec: number | null };
    /** SP-11 — background idle-bucket sweep timer (when autoSweep). */
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(
        mode: DeploymentMode = 'local',
        configs?: Record<string, BucketConfig>,
        opts: { autoSweep?: boolean } = {},
    ) {
        this.mode = mode;
        this.configs = configs ?? buildDefaultBuckets(mode);
        this.envOverride = {
            cap: readEnvNumber('LORE_RATE_LIMIT_CAP'),
            refillPerSec: readEnvNumber('LORE_RATE_LIMIT_REFILL'),
        };
        this.buckets = new Map();
        // SP-11 — every unique (class × principal × tenant) tuple lazily
        // creates one Bucket that previously lived for the daemon's whole
        // lifetime (CI tokens, dev rotations, multiple IDE installs all
        // leak entries forever). The opt-in sweeper evicts buckets idle
        // past IDLE_BUCKET_TTL_MS. Off by default so tests/embedded uses
        // don't get a surprise timer; the daemon enables it explicitly.
        if (opts.autoSweep) this.startSweeper();
    }

    /** SP-11 — start the periodic idle-bucket sweep. Idempotent. The timer
     *  is unref()'d so it never keeps the process alive on its own. */
    startSweeper(): void {
        if (this.sweepTimer) return;
        const t = setInterval(() => this.sweepIdleBuckets(Date.now()), SWEEP_INTERVAL_MS);
        if (typeof t.unref === 'function') t.unref();
        this.sweepTimer = t;
    }

    /** SP-11 — stop the periodic sweep (wired into graceful shutdown). */
    stopSweeper(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    /** SP-11 — evict buckets whose lastRefillMs is older than
     *  IDLE_BUCKET_TTL_MS relative to `nowMs`. Returns the number removed.
     *  Directly unit-testable: fill buckets, advance the clock, call this,
     *  assert the Map shrinks. A re-created bucket starts at capacity, so
     *  eviction is behaviour-preserving for an idle principal. */
    sweepIdleBuckets(nowMs: number): number {
        let removed = 0;
        for (const [key, bucket] of this.buckets) {
            if (nowMs - bucket.lastRefillMs > IDLE_BUCKET_TTL_MS) {
                this.buckets.delete(key);
                removed++;
            }
        }
        return removed;
    }

    /** SP-11 test/observability hook — current tracked-bucket count. */
    bucketCount(): number {
        return this.buckets.size;
    }

    /**
     * Snapshot the current configuration. /api/health surfaces this so
     * operators can see live limits + the exemption list without
     * grepping source. Capacity / refill numbers are reported in
     * operator-friendly tokens/sec, not internal tokens/ms.
     */
    getConfigSnapshot(): RateLimitConfigSnapshot {
        const defaults: Record<string, { capacity: number; refillPerSec: number }> = {};
        for (const [name, cfg] of Object.entries(this.configs)) {
            defaults[name] = {
                capacity: cfg.capacity,
                refillPerSec: Math.round(cfg.refillPerMs * 1000 * 1000) / 1000,
            };
        }
        return {
            mode: this.mode,
            defaults,
            exemptPaths: [...RATE_LIMIT_EXEMPT_PATHS],
            envOverride: { ...this.envOverride },
        };
    }

    /**
     * Lookup or lazily create the bucket for `bucketClass × principal × tenant`.
     * Returns the Bucket object (mutable — caller debits in-place).
     */
    private getOrCreateBucket(bucketClass: string, key: string, nowMs: number): Bucket | null {
        const cfg = this.configs[bucketClass];
        if (!cfg) return null;
        let bucket = this.buckets.get(key);
        if (!bucket) {
            bucket = { ...cfg, tokens: cfg.capacity, lastRefillMs: nowMs };
            this.buckets.set(key, bucket);
        }
        return bucket;
    }

    /**
     * Attempt to debit one token. Returns { allowed, remaining, limit, resetSec }
     * regardless of outcome so middleware can attach X-RateLimit-* headers
     * uniformly. `allowed: false` carries retryAfterSec for the 429.
     *
     * Unknown bucket name → fail closed (returns allowed:false with a
     * 60s retry); classifyRequest should only return known names.
     */
    tryConsume(
        bucketClass: string,
        ctx?: TryConsumeContext,
        nowMs: number = Date.now(),
    ): {
        allowed: boolean;
        retryAfterSec: number;
        limit: number;
        remaining: number;
        resetSec: number;
    } {
        const key = composeBucketKey(bucketClass, ctx);
        const bucket = this.getOrCreateBucket(bucketClass, key, nowMs);
        if (!bucket) {
            return { allowed: false, retryAfterSec: 60, limit: 0, remaining: 0, resetSec: 60 };
        }

        // Refill based on elapsed time.
        const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
        const refill = elapsedMs * bucket.refillPerMs;
        bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill);
        bucket.lastRefillMs = nowMs;

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            const headroom = Math.max(0, bucket.capacity - bucket.tokens);
            // Seconds until the bucket is fully replenished (informational).
            const resetSec = Math.ceil(headroom / (bucket.refillPerMs * 1000));
            return {
                allowed: true,
                retryAfterSec: 0,
                limit: bucket.capacity,
                remaining: Math.floor(bucket.tokens),
                resetSec,
            };
        }

        // Bucket empty — compute when next token will be available.
        const tokensNeeded = 1 - bucket.tokens;
        const waitMs = tokensNeeded / bucket.refillPerMs;
        const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
        return {
            allowed: false,
            retryAfterSec,
            limit: bucket.capacity,
            remaining: 0,
            resetSec: retryAfterSec,
        };
    }
}
