/**
 * sessionCacheManager.ts — local-file hot-session cache.
 *
 * Tracks the N most-recently-touched node ids for the "hot context" UX hint
 * (recall pushes traversal neighbours through it). Backed by a single
 * <basePath>/.lore/hot_session.json file, written through an in-memory cache
 * with a debounced flush so a burst of pushNode() calls collapses to one
 * syscall per second rather than a read-parse-write per push.
 *
 * Extracted from localGraph.ts (Wave 4 god-class split): it implements
 * ISessionCache and has no dependency on LocalGraph, so it stands alone.
 * localGraph.ts re-exports it for backward-compatible imports.
 */

import path from 'path';
import fs from 'fs';
import type { ISessionCache, HotSessionSnapshot } from './sessionCache.js';

export class SessionCacheManager implements ISessionCache {
    public readonly backend: 'local-file' = 'local-file';
    private cachePath: string;
    private maxItems = 10;
    private memCache: { recent_nodes: string[] } | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Debounce window for disk flush. The cache is just a UX hint, so
     * losing the last 1s on a hard crash is acceptable. */
    private readonly flushDelayMs = 1000;

    constructor(basePath: string) {
        this.cachePath = path.join(basePath, '.lore', 'hot_session.json');
    }

    // INTEGRITY/PERF (Audit 2026-05-13): `recall` calls pushNode in a loop
    // (10 traversal neighbours per call), so the previous fs.readFileSync +
    // JSON.parse + fs.writeFileSync per push burned 50-100ms on the
    // first-byte chat path. Switched to an in-memory cache with a debounced
    // disk flush — N pushes collapse to one syscall per second.
    pushNode(nodeId: string): void {
        const cache = this.ensureCache();
        cache.recent_nodes = cache.recent_nodes.filter((id) => id !== nodeId);
        cache.recent_nodes.unshift(nodeId);
        if (cache.recent_nodes.length > this.maxItems) {
            cache.recent_nodes = cache.recent_nodes.slice(0, this.maxItems);
        }
        this.scheduleFlush();
    }

    getHotContext(): HotSessionSnapshot {
        // Return a defensive copy so external mutation doesn't dirty the cache.
        return { recent_nodes: [...this.ensureCache().recent_nodes] };
    }

    /** Force a synchronous flush. Call on daemon shutdown. */
    flushNow(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.memCache) this.writeCacheToDisk(this.memCache);
    }

    private ensureCache(): { recent_nodes: string[] } {
        if (!this.memCache) this.memCache = this.readCacheFromDisk();
        return this.memCache;
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            if (this.memCache) this.writeCacheToDisk(this.memCache);
        }, this.flushDelayMs);
    }

    private readCacheFromDisk(): { recent_nodes: string[] } {
        try {
            if (fs.existsSync(this.cachePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
                // A corrupt cache file (`{}`, an array, a scalar, or a shape
                // whose recent_nodes isn't a string[]) must degrade to empty,
                // not feed pushNode an object whose .filter(...) throws.
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    && Array.isArray(parsed.recent_nodes)) {
                    return { recent_nodes: parsed.recent_nodes.filter((id: unknown) => typeof id === 'string') };
                }
            }
        } catch {
            // IGNORE
        }
        return { recent_nodes: [] };
    }

    private writeCacheToDisk(cache: { recent_nodes: string[] }): void {
        try {
            fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            // IGNORE
        }
    }
}
