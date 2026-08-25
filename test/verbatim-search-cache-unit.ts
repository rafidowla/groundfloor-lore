#!/usr/bin/env tsx
/**
 * test/verbatim-search-cache-unit.ts — short-TTL cache + single-flight
 * front of VerbatimStore.search.
 *
 * What this proves:
 *   1. Cache hit — second identical search returns substantially
 *      faster than the first (cold-load vs memory lookup).
 *   2. Single-flight — 10 concurrent identical searches result in
 *      ONE underlying vectorSearch (verified by counting actual
 *      embed calls via a wrapping EmbeddingProvider).
 *   3. Write invalidation — after store(), the next search() does
 *      NOT return the stale pre-store cache entry.
 *   4. Distinct queries don't share cache.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/** Embedding provider that counts embedQuery calls — lets us prove
 *  the single-flight + cache layers actually short-circuit work. */
class CountingEmbedProvider implements EmbeddingProvider {
    queryCalls = 0;
    documentCalls = 0;
    constructor(private inner: EmbeddingProvider) {}
    get modelId() { return this.inner.modelId; }
    get dimension() { return this.inner.dimension; }
    async initialize() { await this.inner.initialize(); }
    async embedQuery(text: string) { this.queryCalls++; return this.inner.embedQuery(text); }
    async embedDocument(text: string) { this.documentCalls++; return this.inner.embedDocument(text); }
}

async function run() {
    console.log('\n=== VerbatimStore search cache + single-flight ===\n');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-verbatim-cache-'));
    const counting = new CountingEmbedProvider(new LocalEmbeddingProvider());
    const store = new VerbatimStore(tmp, counting);
    try {
        await store.initialize();

        // Seed
        for (let i = 0; i < 20; i++) {
            await store.store({
                id: `seed-${i}`,
                text: `tenant alpha bravo ${i}`,
                metadata: {
                    type: 'note',
                    label: `Seed ${i}`,
                    tags: `seed,${i % 3}`,
                    project: '*',
                    ecosystem: '*',
                    updatedAt: new Date().toISOString(),
                    security_scopes: [],
                },
            });
        }

        await test('cache hit: repeated identical search reuses result', async () => {
            counting.queryCalls = 0;
            await store.search('tenant alpha', 5);
            const firstCount = counting.queryCalls;
            assert.equal(firstCount, 1, 'first search should call embedQuery once');
            // Second call (within TTL) — should hit cache, no embed
            await store.search('tenant alpha', 5);
            assert.equal(counting.queryCalls, 1, 'second search should be a cache hit (no new embedQuery)');
            // Third with different limit — different cache key, embed runs
            await store.search('tenant alpha', 7);
            assert.equal(counting.queryCalls, 2, 'distinct cache key should re-embed');
        });

        await test('single-flight: 10 concurrent identical searches → 1 embed', async () => {
            counting.queryCalls = 0;
            const results = await Promise.all(Array.from({ length: 10 }, () =>
                store.search('tenant single-flight unique-topic', 5),
            ));
            assert.equal(results.length, 10);
            assert.equal(
                counting.queryCalls, 1,
                `expected 1 embedQuery call across 10 concurrent identical searches, got ${counting.queryCalls}`,
            );
            // All results should be the SAME array reference (single-flight resolves once)
            for (let i = 1; i < results.length; i++) {
                assert.equal(results[i], results[0], 'all concurrent callers must receive the same result');
            }
        });

        await test('write invalidation: store() bumps epoch — next search re-embeds', async () => {
            counting.queryCalls = 0;
            await store.search('invalidation probe', 5);
            assert.equal(counting.queryCalls, 1);
            // Second call → cache hit
            await store.search('invalidation probe', 5);
            assert.equal(counting.queryCalls, 1);
            // Write happens → bump epoch
            await store.store({
                id: 'invalidation-trigger',
                text: 'a brand new document',
                metadata: {
                    type: 'note', label: 'Inv',
                    tags: 'inv', project: '*', ecosystem: '*',
                    updatedAt: new Date().toISOString(), security_scopes: [],
                },
            });
            // Next search must re-embed (cache key changed via epoch)
            await store.search('invalidation probe', 5);
            assert.equal(counting.queryCalls, 2, 'post-write search must miss the cache');
        });

        await test('distinct queries are independently cached', async () => {
            counting.queryCalls = 0;
            await store.search('topic-A', 5);
            await store.search('topic-B', 5);
            await store.search('topic-A', 5); // cached
            await store.search('topic-B', 5); // cached
            assert.equal(counting.queryCalls, 2, 'topic-A and topic-B each embed once');
        });
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
