#!/usr/bin/env tsx
/**
 * test/r3221-calibration-cache-bound-unit.ts — 3.22.1 security fix.
 *
 * The D1 calibration cache is keyed per (workspace, types-set). 3.22.1 made
 * `types` reachable from REST (`?types=`), so an authenticated caller can mint
 * an unbounded number of distinct keys. Before this fix each new key:
 *   - added a cache entry that was never evicted (unbounded memory), and
 *   - on the non-blocking path launched a 128-probe background fit with no
 *     concurrency limit (unbounded CPU / store load).
 *
 * Pins:
 *   1. cache entries per store identity stay <= MAX_CALIBRATION_KEYS_PER_STORE
 *      after many distinct types keys (blocking path).
 *   2. concurrent background fits stay <= MAX_BACKGROUND_FITS while a flood
 *      of distinct keys arrives on the non-blocking path, and every flooded
 *      call still returns promptly with status 'pending'.
 *   3. a recently-used key survives eviction (LRU, not FIFO).
 */

import assert from 'node:assert/strict';
import {
    _resetCalibrationCacheForTests,
    _calibrationCacheSizeForTests,
    _backgroundFitCountForTests,
    getCalibration,
    drainBackgroundCalibrations,
    MAX_CALIBRATION_KEYS_PER_STORE,
    MAX_BACKGROUND_FITS,
} from '../packages/lore/src/recall/calibration.js';

type SeedStore = NonNullable<Parameters<typeof getCalibration>[0]>;

function fastStore(): { store: SeedStore; searches: () => number } {
    let searches = 0;
    const store = {
        calibrationIdentity: {},
        count: async () => 10_000,
        search: async () => { searches++; return [{ id: 'n', score: 0.2 + (searches % 7) * 0.01 }]; },
        bm25Search: async () => ({ ranked: true, results: [] }),
    };
    return { store: store as unknown as SeedStore, searches: () => searches };
}

function gatedStore(): { store: SeedStore; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = {
        calibrationIdentity: {},
        count: async () => 10_000,
        search: async () => { await gate; return [{ id: 'n', score: 0.2 }]; },
        bm25Search: async () => ({ ranked: true, results: [] }),
    };
    return { store: store as unknown as SeedStore, release };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failures++; console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

console.log('r3221 calibration cache bound');

await check('cache size per store stays bounded under many distinct types keys', async () => {
    _resetCalibrationCacheForTests();
    const { store } = fastStore();
    const N = 500;
    for (let i = 0; i < N; i++) await getCalibration(store, 'ws', `t${i}`);
    const size = _calibrationCacheSizeForTests(store);
    assert.ok(typeof MAX_CALIBRATION_KEYS_PER_STORE === 'number', 'MAX_CALIBRATION_KEYS_PER_STORE must be exported');
    assert.ok(size <= MAX_CALIBRATION_KEYS_PER_STORE, `cache grew to ${size} entries for ${N} keys (cap ${MAX_CALIBRATION_KEYS_PER_STORE})`);
});

await check('recently used key survives eviction (LRU)', async () => {
    _resetCalibrationCacheForTests();
    const { store, searches } = fastStore();
    await getCalibration(store, 'ws', 'hot');
    for (let i = 0; i < 300; i++) {
        await getCalibration(store, 'ws', `cold${i}`);
        if (i % 10 === 0) await getCalibration(store, 'ws', 'hot');
    }
    const before = searches();
    await getCalibration(store, 'ws', 'hot');
    assert.equal(searches(), before, "'hot' was evicted and re-fitted despite recent use");
});

await check('concurrent background fits stay bounded under a flood of distinct keys', async () => {
    _resetCalibrationCacheForTests();
    const { store, release } = gatedStore();
    const N = 200;
    const results = [];
    for (let i = 0; i < N; i++) results.push(await getCalibration(store, 'ws', `flood${i}`, { blocking: false }));
    const inflight = _backgroundFitCountForTests();
    release();
    await drainBackgroundCalibrations(5000);
    assert.ok(results.every((r) => r.status === 'pending'), 'every flooded call must return pending');
    assert.ok(typeof MAX_BACKGROUND_FITS === 'number', 'MAX_BACKGROUND_FITS must be exported');
    assert.ok(inflight <= MAX_BACKGROUND_FITS, `${inflight} background fits in flight for ${N} keys (cap ${MAX_BACKGROUND_FITS})`);
    assert.ok(_calibrationCacheSizeForTests(store) <= MAX_CALIBRATION_KEYS_PER_STORE, 'cache bounded after the flood drains');
});

if (failures > 0) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll calibration cache bound tests passed');
