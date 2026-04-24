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

/* ─── LRU+TTL cache ───────────────────────────────────────────── */

interface CacheEntry<V> {
    value: V;
    /** epoch ms when the entry was inserted */
    insertedAt: number;
    /** epoch ms when the entry becomes stale (insertedAt + ttlMs) */
    expiresAt: number;
}

export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    invalidations: number;
    size: number;
    maxSize: number;
    epoch: number;
}

export interface CacheOptions {
    /** Maximum entries before LRU eviction. Default 500. */
    maxSize?: number;
    /** Default TTL in ms. Entries past ttlMs are treated as misses. Default 60_000. */
    ttlMs?: number;
    /** Disable the cache entirely (pass-through). Used by tests that want zero caching. */
    disabled?: boolean;
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
    private _epoch = 0;
    private _hits = 0;
    private _misses = 0;
    private _evictions = 0;
    private _invalidations = 0;

    constructor(opts: CacheOptions = {}) {
        this.maxSize = opts.maxSize ?? 500;
        this.ttlMs = opts.ttlMs ?? 60_000;
        this.disabled = opts.disabled ?? false;
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
    }

    /** Read-through wrapper: check the cache, else run `loader`, cache its
     *  result, return it. `loader` is only awaited on miss. */
    async memoize<V>(key: string, loader: () => Promise<V>, ttlOverrideMs?: number): Promise<V> {
        if (this.disabled) return loader();
        const hit = this.get<V>(key);
        if (hit !== undefined) return hit;
        const value = await loader();
        this.set(key, value, ttlOverrideMs);
        return value;
    }

    get<V>(key: string): V | undefined {
        if (this.disabled) return undefined;
        const entry = this.map.get(key);
        if (!entry) {
            this._misses += 1;
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            this._misses += 1;
            return undefined;
        }
        // Refresh LRU position.
        this.map.delete(key);
        this.map.set(key, entry);
        this._hits += 1;
        return entry.value as V;
    }

    set<V>(key: string, value: V, ttlOverrideMs?: number): void {
        if (this.disabled) return;
        const now = Date.now();
        const ttl = ttlOverrideMs ?? this.ttlMs;
        // Evict LRU entries if we'd exceed capacity.
        while (this.map.size >= this.maxSize) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
            this._evictions += 1;
        }
        this.map.set(key, { value, insertedAt: now, expiresAt: now + ttl });
    }

    delete(key: string): void {
        if (this.map.delete(key)) this._invalidations += 1;
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
        return {
            hits: this._hits,
            misses: this._misses,
            evictions: this._evictions,
            invalidations: this._invalidations,
            size: this.map.size,
            maxSize: this.maxSize,
            epoch: this._epoch,
        };
    }
}
