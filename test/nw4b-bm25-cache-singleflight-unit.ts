#!/usr/bin/env tsx
/**
 * nw4b-bm25-cache-singleflight-unit.ts — NW-4b regression.
 *
 * Pins the cache + single-flight behaviour that VerbatimStore.bm25Search
 * was missing before NW-4b. Without this wrapper, every hybrid recall
 * paid the full BM25 cost on repeated identical queries, and N
 * concurrent identical queries duplicated the underlying FTS work.
 *
 * Two assertions:
 *
 *   (a) Cache — calling bm25Search() twice with identical args within
 *       the TTL hits the cache; the underlying _bm25SearchUncached
 *       runs exactly once.
 *
 *   (b) Single-flight — firing N concurrent identical bm25Search()
 *       calls dispatches exactly ONE underlying execution; all N
 *       callers resolve to the same result.
 *
 * The spy patches the private `_bm25SearchUncached` so the test is
 * decoupled from LanceDB FTS availability — the cache/SF layer is what
 * we're pinning, not the FTS path itself.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/nw4b-bm25-cache-singleflight-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nw4b-lore-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['NW4B_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

(async () => {
    console.log('NW-4b — bm25Search cache + single-flight');

    const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');

    /**
     * Helper: build a VerbatimStore against a fresh tmpdir, store one
     * doc so the table exists + `initialized` flips true, then wrap
     * `this.table` with a counting spy that intercepts EVERY path
     * bm25Search() can take to do its underlying work: `search()`
     * (newer FTS API), `fullTextSearch()` (legacy FTS API), and
     * `query()` (LIKE-fallback). Counts the unique invocations of
     * those entry points — that's what cache + single-flight should
     * deduplicate. The spy preserves the underlying behaviour by
     * delegating, so the LIKE-fallback path keeps working end-to-end.
     */
    async function buildSpiedStore(label: string, delayMs: number) {
        const store = new VerbatimStore(path.join(TEST_HOME, label));
        await store.initialize();
        // Seed one row so the table is built and `initialized` is true.
        await store.store({ id: `lore:${label}-seed`, text: 'seed text', metadata: {} });

        let calls = 0;
        const realTable = (store as any).table;
        const spied = new Proxy(realTable, {
            get(target, prop, recv) {
                // We count ONLY the LIKE-fallback path (`query`) since
                // the FTS-try path (`search`/`fullTextSearch`) throws in
                // this fixture (no embedding functions / no FTS index)
                // and bm25Search catches that internally and falls back
                // to `query`. Counting just `query` keeps the spy
                // robust across LanceDB versions and avoids unhandled
                // rejections from the FTS-try chain.
                if (prop === 'query') {
                    return function (...args: unknown[]) {
                        calls++;
                        const builder = (target as any)[prop](...args);
                        if (delayMs > 0 && builder && typeof builder.toArray === 'function') {
                            const origToArray = builder.toArray.bind(builder);
                            builder.toArray = async () => {
                                await new Promise((r) => setTimeout(r, delayMs));
                                return await origToArray();
                            };
                        }
                        return builder;
                    };
                }
                return Reflect.get(target, prop, recv);
            },
        });
        (store as any).table = spied;
        // The read pool, if built, holds its own handles to the
        // unspied table — but bm25Search() goes through this.table
        // directly, not the pool, so the spy covers the bm25 path.
        return { store, getCalls: () => calls };
    }

    /* ── (a) Cache: identical args within TTL → one underlying call ── */
    await test('a — cache hit: second identical bm25Search does NOT re-execute', async () => {
        const { store, getCalls } = await buildSpiedStore('ws-cache', 0);
        try {
            const r1 = await store.bm25Search('alpha beta', 5);
            const firstCalls = getCalls();
            assert.ok(firstCalls >= 1, 'first call must hit the underlying table at least once');
            const r2 = await store.bm25Search('alpha beta', 5);
            assert.equal(getCalls(), firstCalls,
                `cached call must NOT touch the table again (was ${firstCalls}, now ${getCalls()})`);
            assert.deepEqual(r2, r1, 'cached result is identical to the first');
            // Differing args MUST re-execute (sanity that the key
            // includes the args, not just the kind).
            await store.bm25Search('gamma delta', 5);
            assert.ok(getCalls() > firstCalls, 'different query → fresh execution');
        } finally {
            await store.close();
        }
    });

    /* ── (b) Single-flight: N concurrent → one underlying call ────── */
    await test('b — single-flight: N concurrent identical calls → 1 underlying execution', async () => {
        const { store, getCalls } = await buildSpiedStore('ws-sf', 25);
        try {
            // Baseline: one call to learn the per-bm25Search underlying
            // table-call count (may be 1 LIKE-fallback or 2 if FTS-try
            // executes too). N concurrent identical calls must NOT
            // multiply this — they must share one underlying execution.
            await store.bm25Search('warmup query', 5);
            // The warmup populated the cache for "warmup query" — pick
            // a fresh phrase for the concurrent leg.
            const baseline = getCalls();
            assert.ok(baseline >= 1, 'baseline established');

            const N = 10;
            const promises = Array.from({ length: N }, () => store.bm25Search('concurrent query', 5));
            const results = await Promise.all(promises);
            const afterConcurrent = getCalls() - baseline;
            // Single-flight: the N concurrent identical calls must
            // execute the underlying work exactly ONCE, so the delta
            // matches one bm25Search worth of table calls — NOT N×.
            assert.ok(afterConcurrent === baseline || afterConcurrent <= baseline,
                `expected ≤${baseline} underlying calls under N=${N} concurrent identical bm25Search, got ${afterConcurrent}`);
            assert.equal(results.length, N, 'all N callers resolved');
            // Every caller resolves to the same shape — proves they
            // all observed the same single underlying execution.
            const first = JSON.stringify(results[0]);
            for (const r of results) {
                assert.equal(JSON.stringify(r), first, 'all N callers got the same result');
            }
            // Post-SF identical call → cache hit, no new table work.
            const before = getCalls();
            await store.bm25Search('concurrent query', 5);
            assert.equal(getCalls(), before, 'post-SF identical call served from cache');
        } finally {
            await store.close();
        }
    });

    /* ── (c) Epoch bump (write) invalidates bm25 cache ───────────── */
    await test('c — write bumps epoch → bm25 cache invalidated', async () => {
        const { store, getCalls } = await buildSpiedStore('ws-epoch', 0);
        try {
            await store.bm25Search('epoch test', 5);
            const afterFirst = getCalls();
            assert.ok(afterFirst >= 1, 'first call executes');
            await store.bm25Search('epoch test', 5);
            assert.equal(getCalls(), afterFirst,
                `second identical call cached (was ${afterFirst}, now ${getCalls()})`);
            // A write bumps the epoch — next read MUST re-execute.
            await store.store({ id: 'lore:epoch-new', text: 'fresh write', metadata: {} });
            await store.bm25Search('epoch test', 5);
            assert.ok(getCalls() > afterFirst,
                `post-write read re-executes — epoch invalidation (was ${afterFirst}, now ${getCalls()})`);
        } finally {
            await store.close();
        }
    });

    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
