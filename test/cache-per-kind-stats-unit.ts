#!/usr/bin/env tsx
/**
 * cache-per-kind-stats-unit.ts — pins the per-kind + loader-latency
 * tracking added to ReadCache 2026-05-14 for cloud-Redis cache sizing.
 *
 * Asserts that:
 *  - per-kind hit/miss counters increment correctly
 *  - loader latency is sampled only on cache miss (not on hit)
 *  - histogram buckets correctly assign observed latencies
 *  - resetStats() zeros counters without clearing entries
 */

import assert from 'node:assert/strict';
import { ReadCache, cacheKey, LATENCY_BUCKETS_MS } from '../packages/lore/src/engines/cache.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async (): Promise<void> => {
    console.log('ReadCache per-kind stats');

    await test('per-kind hits/misses increment independently', async () => {
        const c = new ReadCache({ maxSize: 100, ttlMs: 60_000 });
        const k1 = cacheKey('search', 'ws', c.epoch, { q: 'foo' });
        const k2 = cacheKey('getNode', 'ws', c.epoch, { id: 'n1' });
        // 2 misses on search, 1 miss on getNode
        await c.memoize(k1, async () => 'a');
        const k1b = cacheKey('search', 'ws', c.epoch, { q: 'bar' });
        await c.memoize(k1b, async () => 'b');
        await c.memoize(k2, async () => 'c');
        // 2 hits on search
        await c.memoize(k1, async () => 'NOT-CALLED');
        await c.memoize(k1b, async () => 'NOT-CALLED');
        const stats = c.stats();
        assert.equal(stats.byKind['search']?.hits, 2);
        assert.equal(stats.byKind['search']?.misses, 2);
        assert.equal(stats.byKind['getNode']?.hits, 0);
        assert.equal(stats.byKind['getNode']?.misses, 1);
    });

    await test('loader latency recorded only on miss', async () => {
        const c = new ReadCache({ maxSize: 100, ttlMs: 60_000 });
        const k = cacheKey('search', 'ws', c.epoch, { q: 'foo' });
        await c.memoize(k, async () => {
            await new Promise(r => setTimeout(r, 2));
            return 'a';
        });
        await c.memoize(k, async () => 'NOT-CALLED');  // cache hit
        await c.memoize(k, async () => 'NOT-CALLED');  // cache hit
        const lat = c.stats().byKind['search']!.loaderLatency;
        assert.equal(lat.n, 1, 'only the miss should record a latency sample');
        assert.ok(lat.sumMs >= 0, 'sumMs must be non-negative');
        assert.ok(lat.maxMs >= lat.minMs, 'max >= min');
    });

    await test('histogram bucket assignment is correct', async () => {
        const c = new ReadCache({ maxSize: 1000, ttlMs: 60_000 });
        // Force several misses with controlled latencies.
        const fakeLatencies = [0, 0, 3, 7, 30, 120, 2000];
        for (let i = 0; i < fakeLatencies.length; i++) {
            const k = cacheKey('traverse', 'ws', c.epoch, { i });
            const delay = fakeLatencies[i]!;
            await c.memoize(k, async () => {
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
                return i;
            });
        }
        const lat = c.stats().byKind['traverse']!.loaderLatency;
        assert.equal(lat.n, fakeLatencies.length);
        // Expected bucket counts. Boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000]
        // 0 → bucket 0 (<1), 0 → 0, 3 → bucket 1 (<5), 7 → bucket 2 (<10),
        // 30 → bucket 4 (<50), 120 → bucket 6 (<250), 2000 → bucket 9 (overflow)
        assert.equal(lat.counts.length, LATENCY_BUCKETS_MS.length + 1);
        // Bucket 0 (<1ms) should have at least the two zeros (timing slop may
        // push them up, so allow slight relaxation: at least 1 hit in <5ms).
        assert.ok(lat.counts[0]! + lat.counts[1]! >= 2, 'expected fast samples in low buckets');
        // The 2-second sample MUST land in the overflow bucket.
        assert.equal(lat.counts[LATENCY_BUCKETS_MS.length]!, 1, 'overflow bucket should have exactly one sample');
    });

    await test('resetStats zeros counters without clearing entries', async () => {
        const c = new ReadCache({ maxSize: 100, ttlMs: 60_000 });
        const k = cacheKey('search', 'ws', c.epoch, { q: 'foo' });
        await c.memoize(k, async () => 'a');
        await c.memoize(k, async () => 'NOT-CALLED');  // hit
        c.resetStats();
        const stats = c.stats();
        assert.equal(stats.hits, 0);
        assert.equal(stats.misses, 0);
        assert.equal(Object.keys(stats.byKind).length, 0);
        // Entry should still be present — next read should hit.
        const result = await c.memoize(k, async () => 'NEW-LOADER-VALUE');
        assert.equal(result, 'a', 'cache entry survived resetStats');
        assert.equal(c.stats().byKind['search']?.hits, 1);
    });

    await test('aggregate counters match sum of per-kind', async () => {
        const c = new ReadCache({ maxSize: 100, ttlMs: 60_000 });
        const k1 = cacheKey('search', 'ws', c.epoch, { q: 'foo' });
        const k2 = cacheKey('getNode', 'ws', c.epoch, { id: 'n1' });
        await c.memoize(k1, async () => 'a');
        await c.memoize(k2, async () => 'b');
        await c.memoize(k1, async () => 'NOT-CALLED');
        const s = c.stats();
        const sumHits = Object.values(s.byKind).reduce((a, b) => a + b.hits, 0);
        const sumMisses = Object.values(s.byKind).reduce((a, b) => a + b.misses, 0);
        assert.equal(sumHits, s.hits);
        assert.equal(sumMisses, s.misses);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
