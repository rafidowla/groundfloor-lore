#!/usr/bin/env tsx
/**
 * cache-unit.ts — Q1.3 ReadCache + cacheKey unit tests.
 *
 * No framework — tsx-run, assert-based, exits non-zero on first
 * failure. Matches the rest of the test/ harness (http-test.ts,
 * smoke-test.ts).
 *
 * Covers the invariants called out in docs/cache-key-contract.md:
 *
 *   1. Stable key ordering — {a:1,b:2} and {b:2,a:1} hash identically.
 *   2. Workspace isolation — same kind+params, different workspace,
 *      different key.
 *   3. Epoch discipline — bumpEpoch() makes prior keys unreachable.
 *   4. LRU eviction — exceeding maxSize retires the oldest entry.
 *   5. TTL — entries past ttlMs miss and are dropped from the map.
 *   6. Disabled mode — get() always misses, set() is a no-op.
 *   7. configure() — shrinks LRU on the spot; flip-to-disabled clears.
 */

import assert from 'node:assert/strict';
import { ReadCache, cacheKey } from '../packages/lore/src/engines/cache.js';

function test(name: string, fn: () => void | Promise<void>): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error((err as Error).stack ?? String(err));
            process.exit(1);
        }
    };
}

const tests = [
    test('stableStringify: key ordering is canonical', () => {
        const k1 = cacheKey('search', 'w', 0, { a: 1, b: 2 });
        const k2 = cacheKey('search', 'w', 0, { b: 2, a: 1 });
        assert.equal(k1, k2, 'param order must not affect the key');
    }),

    test('stableStringify: nested objects stable', () => {
        const k1 = cacheKey('search', 'w', 0, { filter: { project: 'p', ecosystem: 'e' } });
        const k2 = cacheKey('search', 'w', 0, { filter: { ecosystem: 'e', project: 'p' } });
        assert.equal(k1, k2);
    }),

    test('cacheKey: workspace isolates', () => {
        const k1 = cacheKey('search', 'alpha', 0, { q: 'x' });
        const k2 = cacheKey('search', 'beta', 0, { q: 'x' });
        assert.notEqual(k1, k2, 'different workspaces must not collide');
    }),

    test('cacheKey: epoch invalidates', () => {
        const k1 = cacheKey('search', 'w', 0, { q: 'x' });
        const k2 = cacheKey('search', 'w', 1, { q: 'x' });
        assert.notEqual(k1, k2, 'bumping epoch must change the key');
    }),

    test('cacheKey: v1 prefix locked', () => {
        const k = cacheKey('search', 'w', 0, {});
        assert.ok(k.startsWith('v1|'), 'contract version prefix must be v1');
    }),

    test('get/set: hit and miss', () => {
        const c = new ReadCache();
        assert.equal(c.get('k'), undefined, 'miss returns undefined');
        c.set('k', 42);
        assert.equal(c.get<number>('k'), 42, 'set then get returns the value');
    }),

    test('bumpEpoch: prior entries unreachable by new key', () => {
        const c = new ReadCache();
        const k0 = cacheKey('search', 'w', c.epoch, { q: 'x' });
        c.set(k0, 'old');
        c.bumpEpoch();
        const k1 = cacheKey('search', 'w', c.epoch, { q: 'x' });
        assert.notEqual(k0, k1);
        assert.equal(c.get(k1), undefined, 'new epoch key misses');
        // 4.3 — the old entry is CLEARED on bump (its key embeds the old epoch
        // and is unreachable by any caller, so leaving it in the map was an
        // un-freeable heap leak of whole-corpus arrays).
        assert.equal(c.get(k0), undefined, 'old entry cleared on epoch bump');
    }),

    test('LRU eviction: exceeds maxSize', () => {
        const c = new ReadCache({ maxSize: 3 });
        c.set('a', 1);
        c.set('b', 2);
        c.set('c', 3);
        c.set('d', 4); // evicts 'a'
        assert.equal(c.get('a'), undefined, 'oldest evicted');
        assert.equal(c.get('d'), 4, 'newest present');
        assert.equal(c.stats().evictions, 1);
    }),

    test('LRU: hit refreshes position', () => {
        const c = new ReadCache({ maxSize: 3 });
        c.set('a', 1);
        c.set('b', 2);
        c.set('c', 3);
        c.get('a'); // touch — moves to end
        c.set('d', 4); // evicts 'b' now, not 'a'
        assert.equal(c.get('a'), 1, 'touched entry survives');
        assert.equal(c.get('b'), undefined, 'untouched oldest evicted');
    }),

    test('TTL: expired entries miss and drop', async () => {
        const c = new ReadCache({ ttlMs: 20 });
        c.set('k', 'v');
        assert.equal(c.get('k'), 'v', 'fresh hit');
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(c.get('k'), undefined, 'expired miss');
        // Re-get after expiry must not leave a zombie entry.
        assert.equal(c.stats().size, 0, 'expired entry dropped');
    }),

    test('memoize: loader runs exactly once per key', async () => {
        const c = new ReadCache();
        let loaderCalls = 0;
        const loader = async () => {
            loaderCalls += 1;
            return 'payload';
        };
        const v1 = await c.memoize('k', loader);
        const v2 = await c.memoize('k', loader);
        assert.equal(v1, 'payload');
        assert.equal(v2, 'payload');
        assert.equal(loaderCalls, 1, 'second call served from cache');
    }),

    test('disabled: pass-through mode', async () => {
        const c = new ReadCache({ disabled: true });
        c.set('k', 'v');
        assert.equal(c.get('k'), undefined, 'disabled get always misses');
        let loaderCalls = 0;
        await c.memoize('k', async () => { loaderCalls += 1; return 'x'; });
        await c.memoize('k', async () => { loaderCalls += 1; return 'x'; });
        assert.equal(loaderCalls, 2, 'disabled memoize reruns loader every call');
    }),

    test('configure: shrinks LRU on the spot', () => {
        const c = new ReadCache({ maxSize: 10 });
        for (let i = 0; i < 10; i++) c.set(`k${i}`, i);
        c.configure({ maxSize: 3 });
        assert.equal(c.stats().size, 3, 'LRU trimmed to new ceiling');
        assert.equal(c.get('k9'), 9, 'newest survive');
        assert.equal(c.get('k0'), undefined, 'oldest evicted');
    }),

    test('configure: flipping to disabled clears', () => {
        const c = new ReadCache();
        c.set('k', 'v');
        c.configure({ disabled: true });
        assert.equal(c.stats().size, 0, 'disable clears the map');
        assert.equal(c.get('k'), undefined);
    }),

    test('stats shape', () => {
        const c = new ReadCache({ maxSize: 100 });
        c.set('k', 1);
        c.get('k');
        c.get('miss');
        c.bumpEpoch();
        const s = c.stats();
        assert.equal(s.hits, 1);
        assert.equal(s.misses, 1);
        assert.equal(s.maxSize, 100);
        assert.equal(s.epoch, 1);
        assert.ok('invalidations' in s);
    }),
];

async function main() {
    console.log('Q1.3 ReadCache unit tests');
    for (const t of tests) await t();
    console.log(`\nall ${tests.length} tests passed`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
