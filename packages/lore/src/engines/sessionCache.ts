/**
 * sessionCache.ts — Pluggable hot-session cache interface (Sprint 17).
 *
 * Closes DATAPLANE_INTEGRATION.md Section 10 sessionCache item:
 * proves the surface is cloud-pluggable so a Redis-backed implementation
 * can drop in during cloud activation (Task #12) without touching
 * LocalGraph or its callers.
 *
 * Current implementations:
 *   - SessionCacheManager (engines/localGraph.ts): JSON file + memory,
 *     debounced flush. Used in local mode today.
 *   - RedisSessionCache (this file): typed stub; throws
 *     SessionCacheNotImplementedError until cloud build wires the
 *     ioredis (or equivalent) client in.
 *
 * The interface is intentionally minimal — only the three methods
 * LocalGraph actually exercises today are required. Any extra Redis
 * affordances (TTLs, multi-key invalidation, pub/sub) ship as cloud-
 * impl detail behind the same surface.
 */

/** Snapshot of recent node ids the recall/chat path uses as a UX hint. */
export interface HotSessionSnapshot {
    recent_nodes: string[];
}

/** The contract every backend (local-file or Redis) must satisfy. */
export interface ISessionCache {
    /** Push a node id to the front of the recent list (deduplicated, capped). */
    pushNode(nodeId: string): void;
    /** Read the current snapshot — recall/chat reads this on the hot path. */
    getHotContext(): HotSessionSnapshot;
    /** Force a flush. Local impl writes to disk; Redis impl is a no-op. */
    flushNow(): void;
}

/** Diagnostic — which backend is wired. */
export type SessionCacheBackend = 'local-file' | 'redis';

/* ─── Cloud-mode stub ─────────────────────────────────────────────── */

export class SessionCacheNotImplementedError extends Error {
    public readonly code = 'session_cache_redis_not_implemented';
    constructor(op: string) {
        super(
            `[sessionCache] Redis-backed ${op} not implemented (Task #12). ` +
                `See DATAPLANE_INTEGRATION.md Section 10. The local-file ` +
                `SessionCacheManager is the only working backend today.`,
        );
        this.name = 'SessionCacheNotImplementedError';
    }
}

/**
 * RedisSessionCache — typed stub for cloud activation.
 *
 * The constructor accepts a Redis client handle (typed loosely so the
 * cloud build can swap the concrete client in without changing the
 * shape). Every method throws SessionCacheNotImplementedError until
 * Task #12 wires the routing.
 *
 * The point of this class is to prove that ISessionCache is genuinely
 * pluggable: a future commit replaces the throws with actual
 * `redisClient.lpush(...)` / `redisClient.lrange(...)` calls, and
 * LocalGraph (which now depends on ISessionCache, not the concrete
 * file-backed class) keeps working unchanged.
 */
export class RedisSessionCache implements ISessionCache {
    public readonly backend: SessionCacheBackend = 'redis';

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        private readonly redisClient: unknown,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        private readonly keyPrefix: string = 'lore:session:',
    ) {}

    pushNode(_nodeId: string): void {
        throw new SessionCacheNotImplementedError('pushNode');
    }

    getHotContext(): HotSessionSnapshot {
        throw new SessionCacheNotImplementedError('getHotContext');
    }

    flushNow(): void {
        throw new SessionCacheNotImplementedError('flushNow');
    }
}
