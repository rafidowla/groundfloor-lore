/**
 * cache.ts — In-proc LRU + TTL read cache with epoch-bump invalidation.
 *
 * Q1.3 — "Local cache tier." Hot-path recall (search / listNodes /
 * getNode / traverse) repeats the same few queries in tight loops
 * (chat context-expansion, recall() dominating tool traffic, the
 * filter panel re-fetching topology on every open). Those queries
 * round-trip through Kùzu's prepare→execute→getAll, which even on
 * an embedded DB is 10–50× slower than a memory read. This module
 * is the in-proc substrate.
 *
 * Key contract (shared with Q2.3 Redis tier — swap substrate, not shape):
 *
 *     v1|<kind>|<workspace>|<epoch>|<params-sha1>
 *
 *   kind        — 'search', 'listNodes', 'getNode', 'traverse', …
 *   workspace   — active workspace id (default: 'default'). Cache is
 *                 per-workspace by construction; switching workspaces
 *                 never returns cross-workspace hits.
 *   epoch       — monotonic counter bumped on every write. Including
 *                 it in the key makes invalidation atomic: after a
 *                 write all prior entries become unreachable in O(1),
 *                 without scanning the cache. Stale entries age out
 *                 via LRU eviction.
 *   params-sha1 — first 16 hex chars of sha1(JSON.stringify(params))
 *                 with a stable key ordering.
 *
 * Invalidation strategy: coarse epoch bump. Every write
 * (upsertNode / addEdge / deleteNode / pruneInferredLoreEdges /
 * reconnect) calls `bumpEpoch()`. The current epoch flows into every
 * new cache key, so any read after a write observes the write. This
 * trades finer-grained invalidation for correctness — and for a
 * single-writer embedded DB the bump cost is one `++` per write.
 *
 * Airplane-mode: this cache is entirely in-proc. Zero network
 * dependencies, zero disk spill. Restart clears it.
 *
 * Thread safety: Node is single-threaded; no locks needed.
 */

import { createHash } from 'node:crypto';

/* ─── Key helpers ─────────────────────────────────────────────── */

/**
 * Canonicalise a params bag to a stable string by sorting keys. Used
 * so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash to the same key.
 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Build a cache key. See module-level comment for the contract.
 */
export function cacheKey(
    kind: string,
    workspace: string,
    epoch: number,
    params: Record<string, unknown>,
): string {
    const canonical = stableStringify(params);
    const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 16);
    return `v1|${kind}|${workspace}|${epoch}|${hash}`;
}

/** 4.3 — approximate serialized size (bytes) for the byte budget. Rough: a
 *  string's UTF-16 length × 2, fixed per-primitive/container overhead. The
 *  budget is an LRU bound, not accounting — exactness is not required. */
function estimateBytes(value: unknown): number {
    if (typeof value === 'string') return value.length * 2 + 8;
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;
    if (Array.isArray(value)) {
        let n = 8;
        for (const v of value) n += estimateBytes(v);
        return n;
    }
    if (typeof value === 'object') {
        let n = 16;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            n += k.length * 2 + estimateBytes(v);
        }
        return n;
    }
    return 16;
}

/* ─── LRU+TTL cache ───────────────────────────────────────────── */

interface CacheEntry<V> {
    value: V;
    /** epoch ms when the entry was inserted */
    insertedAt: number;
    /** epoch ms when the entry becomes stale (insertedAt + ttlMs) */
    expiresAt: number;
    /** 4.3 — approximate serialized size in bytes, for the byte budget. */
    bytes: number;
}

/**
 * Latency histogram bucket boundaries in ms — exclusive upper bound on each
 * bucket except the last (which catches >=1000ms). Aligned with what a Redis
 * tier would need to size against: anything <5ms is cache-fast; >50ms is
 * worth caching aggressively.
 */
export const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

export interface LatencyHistogram {
    /** count of samples in each bucket, plus a final overflow bucket */
    counts: number[];
    /** total observations */
    n: number;
    /** sum of all observed latencies in ms */
    sumMs: number;
    /** min observed (or 0 if none) */
    minMs: number;
    /** max observed (or 0 if none) */
    maxMs: number;
}

export interface PerKindStats {
    hits: number;
    misses: number;
    /** Loader latency distribution. Only sampled on cache MISS — that's the
     *  actual DB round-trip we're trying to measure for cloud-cache sizing. */
    loaderLatency: LatencyHistogram;
}

export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    invalidations: number;
    size: number;
    maxSize: number;
    epoch: number;
    /** Per-kind breakdown — keyed by the `<kind>` segment of cacheKey().
     *  Added 2026-05-14 to inform cloud Redis cache sizing. Each kind has
     *  its own hit/miss counters and a loader-latency histogram so we can
     *  see (a) which kinds benefit most from caching, (b) what the actual
     *  cold-Kùzu cost is per kind. */
    byKind: Record<string, PerKindStats>;
}

export interface CacheOptions {
    /** Maximum entries before LRU eviction. Default 500. */
    maxSize?: number;
    /** Default TTL in ms. Entries past ttlMs are treated as misses. Default 60_000. */
    ttlMs?: number;
    /** Disable the cache entirely (pass-through). Used by tests that want zero caching. */
    disabled?: boolean;
    /** 4.3 — approximate byte budget; entries are LRU-evicted once the running
     *  total exceeds this. Default 256 MiB. Count-only bounding (maxSize) let
     *  whole-corpus node arrays park unboundedly in heap. */
    maxBytes?: number;
}

/**
 * LRU cache with TTL and a monotonic epoch counter. The epoch is owned
 * by this instance and surfaces through `cacheKey()` — callers should
 * thread `cache.epoch` into their key construction, then call
 * `cache.bumpEpoch()` on every write.
 *
 * Eviction order: insertion order via `Map` iteration, with "touch on
 * read" semantics (hits move the entry to the end).
 */
export class ReadCache {
    private readonly map = new Map<string, CacheEntry<unknown>>();
    private maxSize: number;
    private ttlMs: number;
    private disabled: boolean;
    /** 4.3 — approximate byte budget for the whole cache. */
    private readonly maxBytes: number;
    private totalBytes = 0;
    private _epoch = 0;
    private _hits = 0;
    private _misses = 0;
    private _evictions = 0;
    private _invalidations = 0;
    /** Per-kind stats. Lazily allocated when a kind is first seen.
     *  Map key is the `<kind>` segment of cacheKey() output. (Added 2026-05-14
     *  for cloud-cache sizing — see CacheStats.byKind doc.) */
    private readonly byKind = new Map<string, PerKindStats>();
    /** Hard cap on tracked kinds so a bug in caller-supplied kind strings
     *  can't blow up memory. 64 distinct kinds is well above the ~5 we
     *  actually use (search, listNodes, getNode, traverse, recall). */
    private static readonly MAX_TRACKED_KINDS = 64;

    constructor(opts: CacheOptions = {}) {
        this.maxSize = opts.maxSize ?? 500;
        this.ttlMs = opts.ttlMs ?? 60_000;
        this.disabled = opts.disabled ?? false;
        this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    }

    /** Pull the `<kind>` segment from a cache key. Returns null when the key
     *  doesn't match the documented `v1|<kind>|...` shape — that should
     *  never happen for keys built via cacheKey(), but we don't want a
     *  malformed key to crash a hot-path read. */
    private kindOf(key: string): string | null {
        // Format: v1|<kind>|<workspace>|<epoch>|<hash>
        const firstBar = key.indexOf('|');
        if (firstBar < 0) return null;
        const secondBar = key.indexOf('|', firstBar + 1);
        if (secondBar < 0) return null;
        return key.slice(firstBar + 1, secondBar);
    }

    private statsForKind(kind: string): PerKindStats | null {
        let s = this.byKind.get(kind);
        if (!s) {
            if (this.byKind.size >= ReadCache.MAX_TRACKED_KINDS) return null;
            s = {
                hits: 0,
                misses: 0,
                loaderLatency: {
                    counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
                    n: 0,
                    sumMs: 0,
                    minMs: 0,
                    maxMs: 0,
                },
            };
            this.byKind.set(kind, s);
        }
        return s;
    }

    private recordLoaderLatency(kind: string | null, ms: number): void {
        if (kind === null) return;
        const s = this.statsForKind(kind);
        if (!s) return;
        const h = s.loaderLatency;
        let idx = LATENCY_BUCKETS_MS.findIndex((bound) => ms < bound);
        if (idx < 0) idx = LATENCY_BUCKETS_MS.length; // overflow bucket
        h.counts[idx]! += 1;
        h.n += 1;
        h.sumMs += ms;
        h.minMs = h.n === 1 ? ms : Math.min(h.minMs, ms);
        h.maxMs = Math.max(h.maxMs, ms);
    }

    get epoch(): number {
        return this._epoch;
    }

    /** Bump the epoch counter. All existing cache entries become
     *  unreachable to future reads — their keys embed the old epoch.
     *  We don't `.clear()` the map: LRU eviction retires stale entries
     *  naturally on pressure, which keeps bumpEpoch() O(1). */
    bumpEpoch(): void {
        this._epoch += 1;
        this._invalidations += 1;
        // 4.3 — clear, don't leave the stale entries as unreachable garbage: a
        // bumped-epoch key can never be looked up again (the lazy TTL check in
        // get() never fires for it), so it would otherwise accumulate full-
        // corpus arrays until later inserts finally pushed them out.
        this.map.clear();
        this.totalBytes = 0;
    }

    /** Read-through wrapper: check the cache, else run `loader`, cache its
     *  result, return it. `loader` is only awaited on miss.
     *
     *  Audit 2026-05-14: on miss, time the loader and record into the
     *  per-kind latency histogram. This is the actual Kùzu round-trip
     *  cost — the data point we need to size the Redis cache for cloud.
     *  Disabled-cache path is excluded so disabling the cache doesn't
     *  pollute the latency baseline. */
    async memoize<V>(key: string, loader: () => Promise<V>, ttlOverrideMs?: number): Promise<V> {
        if (this.disabled) return loader();
        const hit = this.get<V>(key);
        if (hit !== undefined) return hit;
        const kind = this.kindOf(key);
        const t0 = Date.now();
        const value = await loader();
        this.recordLoaderLatency(kind, Date.now() - t0);
        this.set(key, value, ttlOverrideMs);
        return value;
    }

    get<V>(key: string): V | undefined {
        if (this.disabled) return undefined;
        const kind = this.kindOf(key);
        const entry = this.map.get(key);
        if (!entry) {
            this._misses += 1;
            if (kind) { const s = this.statsForKind(kind); if (s) s.misses += 1; }
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            this.totalBytes -= entry.bytes;
            this._misses += 1;
            if (kind) { const s = this.statsForKind(kind); if (s) s.misses += 1; }
            return undefined;
        }
        // Refresh LRU position.
        this.map.delete(key);
        this.map.set(key, entry);
        this._hits += 1;
        if (kind) { const s = this.statsForKind(kind); if (s) s.hits += 1; }
        return entry.value as V;
    }

    set<V>(key: string, value: V, ttlOverrideMs?: number): void {
        if (this.disabled) return;
        const now = Date.now();
        const ttl = ttlOverrideMs ?? this.ttlMs;
        const bytes = estimateBytes(value);
        // Replace an existing key without double-counting its bytes.
        const existing = this.map.get(key);
        if (existing) this.totalBytes -= existing.bytes;
        // Evict LRU entries until under BOTH the count cap and the byte budget.
        while (this.map.size >= this.maxSize || this.totalBytes + bytes > this.maxBytes) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            const evicted = this.map.get(oldest);
            this.map.delete(oldest);
            if (evicted) this.totalBytes -= evicted.bytes;
            this._evictions += 1;
        }
        this.map.set(key, { value, insertedAt: now, expiresAt: now + ttl, bytes });
        this.totalBytes += bytes;
    }

    delete(key: string): void {
        const entry = this.map.get(key);
        if (entry) {
            this.totalBytes -= entry.bytes;
            this.map.delete(key);
            this._invalidations += 1;
        }
    }

    clear(): void {
        if (this.map.size > 0) this._invalidations += 1;
        this.map.clear();
    }

    /** Runtime reconfiguration — used by PATCH /api/config so the
     *  Settings toggle takes effect without a daemon restart. Shrinks
     *  the LRU on the spot if the new maxSize is smaller; flipping the
     *  disabled bit clears the map so stale entries can't leak past a
     *  disable. TTL changes only affect future inserts (existing
     *  entries keep the TTL they were inserted with). */
    configure(opts: Partial<CacheOptions>): void {
        if (typeof opts.maxSize === 'number' && opts.maxSize > 0) {
            this.maxSize = opts.maxSize;
            while (this.map.size > this.maxSize) {
                const oldest = this.map.keys().next().value;
                if (oldest === undefined) break;
                this.map.delete(oldest);
                this._evictions += 1;
            }
        }
        if (typeof opts.ttlMs === 'number' && opts.ttlMs > 0) {
            this.ttlMs = opts.ttlMs;
        }
        if (typeof opts.disabled === 'boolean') {
            if (opts.disabled && !this.disabled) this.clear();
            this.disabled = opts.disabled;
        }
    }

    stats(): CacheStats {
        const byKind: Record<string, PerKindStats> = {};
        for (const [kind, s] of this.byKind) {
            byKind[kind] = {
                hits: s.hits,
                misses: s.misses,
                loaderLatency: {
                    counts: [...s.loaderLatency.counts],
                    n: s.loaderLatency.n,
                    sumMs: s.loaderLatency.sumMs,
                    minMs: s.loaderLatency.minMs,
                    maxMs: s.loaderLatency.maxMs,
                },
            };
        }
        return {
            hits: this._hits,
            misses: this._misses,
            evictions: this._evictions,
            invalidations: this._invalidations,
            size: this.map.size,
            maxSize: this.maxSize,
            epoch: this._epoch,
            byKind,
        };
    }

    /** Zero all hit/miss/eviction/latency counters without clearing the
     *  cache itself. Used to start a fresh measurement window from the
     *  diagnostic endpoint (so we can collect "last 24h" style stats
     *  without restarting the daemon). epoch and size are NOT reset —
     *  those reflect live state, not cumulative counters. */
    resetStats(): void {
        this._hits = 0;
        this._misses = 0;
        this._evictions = 0;
        this._invalidations = 0;
        this.byKind.clear();
    }
}
