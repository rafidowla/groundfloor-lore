/**
 * boundedVectorCache.ts — SP-11.
 *
 * A tiny bounded (LRU-ish) hash→vector cache for the verbatim store's
 * hot-path contentHash lookup. Extracted from verbatimStore.ts so that
 * file stays within its size budget and the eviction logic is independently
 * testable.
 *
 * Each entry holds a full embedding vector (~4KB for 1024-dim Float32), so
 * an unbounded Map would approach the corpus size on a long-running,
 * high-write daemon (100k docs ≈ 150–400MB). This caps the Map with
 * insertion-order eviction (the same pattern ReadCache.set uses): on insert
 * past `max`, the oldest-inserted key is dropped. Re-inserting an existing
 * key refreshes its recency (delete-then-set moves it to the tail of Map
 * iteration order).
 *
 * NOT a durable store — the vectors live in LanceDB; this only avoids
 * round-tripping for repeated-content lookups within a single process run.
 */

export class BoundedVectorCache {
    private readonly map = new Map<string, Float32Array | number[]>();

    constructor(private readonly max: number = 10_000) {}

    get(hash: string): Float32Array | number[] | undefined {
        return this.map.get(hash);
    }

    /** Insert, evicting the oldest-inserted entry first at capacity. */
    set(hash: string, vec: Float32Array | number[]): void {
        if (this.map.has(hash)) {
            this.map.delete(hash);
        } else {
            while (this.map.size >= this.max) {
                const oldest = this.map.keys().next().value;
                if (oldest === undefined) break;
                this.map.delete(oldest);
            }
        }
        this.map.set(hash, vec);
    }

    get size(): number {
        return this.map.size;
    }
}
