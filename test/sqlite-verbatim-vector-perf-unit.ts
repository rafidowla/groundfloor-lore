#!/usr/bin/env tsx
/**
 * test/sqlite-verbatim-vector-perf-unit.ts — 3.21 step 2 part 1.
 *
 * Design CHECK: "100K x 384-d store: searchByVector(k=10) p50 < 50 ms.
 * Report sqlite-vec and fallback separately." + "small-store (1K rows) RSS
 * cost per open store."
 *
 * Rows are written via bulkAddPrebuiltRows (pre-built vectors, no embedder
 * call) — this test is about SEARCH latency, not insert/embed throughput.
 * Vectors are synthetic (deterministic PRNG), 384-d to match the default
 * local embedder's dimension.
 *
 * Runtime note: building + searching a 100K-row store takes real wall time
 * (tens of seconds). Not part of the default `npm test` chain for that
 * reason — run explicitly via `npm run test:unit:sqlite-verbatim-vector-perf`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 384;
const ROWS = 100_000;
const K = 10;
const QUERIES = 30;

/** Deterministic xorshift PRNG — reproducible vectors without pulling in a
 *  dependency, and fast enough to generate 100K x 384 floats quickly. */
function makeRng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

function randomUnitVector(rng: () => number, dim: number): number[] {
    const v = new Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) { const x = rng() * 2 - 1; v[i] = x; norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
}

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'perf-test-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { return randomUnitVector(makeRng(1), DIM); }
    async embedQuery(): Promise<number[]> { return randomUnitVector(makeRng(1), DIM); }
    async embedDocument(): Promise<number[]> { return randomUnitVector(makeRng(1), DIM); }
}

function percentile(sorted: number[], p: number): number {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
}

async function buildStore(basePath: string, rows: number): Promise<{ store: SqliteVerbatimStore; needle: number[]; needleId: string }> {
    const store = new SqliteVerbatimStore(basePath, new DetEmbedProvider());
    await store.initialize();
    const rng = makeRng(42);
    const CHUNK = 1000;
    let needle: number[] | null = null;
    let needleId = '';
    for (let base = 0; base < rows; base += CHUNK) {
        const batch: Array<Record<string, unknown>> = [];
        const n = Math.min(CHUNK, rows - base);
        for (let i = 0; i < n; i++) {
            const idx = base + i;
            const vec = randomUnitVector(rng, DIM);
            const id = `perf-row-${idx}`;
            if (idx === Math.floor(rows / 2)) { needle = vec; needleId = id; }
            batch.push({ id, text: `synthetic row ${idx} for vector perf benchmark`, vector: vec });
        }
        await store.bulkAddPrebuiltRows(batch);
    }
    assert.ok(needle, 'needle vector must have been set during generation');
    return { store, needle: needle!, needleId };
}

async function measureSearch(store: SqliteVerbatimStore, needle: number[], label: string): Promise<number[]> {
    const latenciesMs: number[] = [];
    for (let i = 0; i < QUERIES; i++) {
        // Perturb the needle slightly per query so the store can't just
        // memoize/cache an identical lookup across all 30 queries.
        const q = needle.map((x) => x + (Math.random() - 0.5) * 0.001);
        const t0 = performance.now();
        await store.searchByVector(q, { topK: K });
        latenciesMs.push(performance.now() - t0);
    }
    const sorted = [...latenciesMs].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    console.log(`    [${label}] p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=${QUERIES}, ${ROWS} rows x ${DIM}d)`);
    return sorted;
}

async function main(): Promise<void> {
    console.log(`sqlite-verbatim-vector-perf-unit — ${ROWS} rows x ${DIM}d, k=${K}, ${QUERIES} queries per path\n`);

    // ---- native (sqlite-vec) path ----
    await test(`native (sqlite-vec) path: searchByVector(k=${K}) p50 < 50ms at ${ROWS} rows`, async () => {
        const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-verbatim-perf-native-'));
        const { store, needle } = await buildStore(basePath, ROWS);
        assert.equal((store as unknown as { vectorSearchPath(): string }).vectorSearchPath(), 'native',
            'this leg requires sqlite-vec to actually be loaded — if this fails, sqlite-vec is not installed/loadable on this machine and the native number cannot be measured');
        const sorted = await measureSearch(store, needle, 'native');
        const p50 = percentile(sorted, 50);
        await store.close();
        assert.ok(p50 < 50, `native p50 ${p50.toFixed(2)}ms exceeds the 50ms budget`);
    });

    // ---- JS brute-force fallback path (cached matrix — cache budget raised
    // to comfortably hold 100K x 384 x 4 bytes ~= 150MB) ----
    await test(`JS fallback (cached matrix) path: searchByVector(k=${K}) latency reported at ${ROWS} rows`, async () => {
        const prevDisable = process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE;
        const prevBudget = process.env.LORE_SQLITE_VECTOR_CACHE_MB;
        process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE = '1';
        process.env.LORE_SQLITE_VECTOR_CACHE_MB = '256';
        try {
            const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-verbatim-perf-fallback-'));
            const { store, needle } = await buildStore(basePath, ROWS);
            assert.equal((store as unknown as { vectorSearchPath(): string }).vectorSearchPath(), 'fallback');
            const sorted = await measureSearch(store, needle, 'fallback (cached)');
            const p50 = percentile(sorted, 50);
            await store.close();
            // NOT asserted against the 50ms budget — the design's 50ms
            // target is native-path-specific ("Report sqlite-vec and
            // fallback separately", not "both must meet the same bound").
            // A pure-JS O(n) cosine scan over 100K x 384 floats is
            // inherently slower than a native SIMD scalar function; this
            // test's job is to MEASURE and print that number honestly, not
            // to assert an arbitrary pass/fail line for it. Sanity bound
            // only: must complete, and not be absurdly slow (10x the
            // native budget) which would indicate an actual bug (e.g. the
            // cache rebuilding on every query instead of once).
            assert.ok(p50 < 500, `fallback p50 ${p50.toFixed(2)}ms is unreasonably slow for a warm cached-matrix scan — likely a cache-rebuild-per-query bug, not just "JS is slower than native"`);
        } finally {
            if (prevDisable === undefined) delete process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE; else process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE = prevDisable;
            if (prevBudget === undefined) delete process.env.LORE_SQLITE_VECTOR_CACHE_MB; else process.env.LORE_SQLITE_VECTOR_CACHE_MB = prevBudget;
        }
    });

    // ---- small-store (1K rows) RSS cost per open store ----
    await test('small store (1K rows): RSS cost per open store is reported', async () => {
        if (typeof (globalThis as { gc?: () => void }).gc !== 'function') {
            console.log('    (run with --expose-gc for a precise reading; reporting an unforced sample instead)');
        }
        const before = process.memoryUsage().rss / (1024 * 1024);
        const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-verbatim-perf-small-'));
        const { store } = await buildStore(basePath, 1000);
        (globalThis as { gc?: () => void }).gc?.();
        const after = process.memoryUsage().rss / (1024 * 1024);
        console.log(`    RSS before=${before.toFixed(1)}MB after=${after.toFixed(1)}MB delta=${(after - before).toFixed(1)}MB for a 1K-row store`);
        await store.close();
        assert.ok(after - before < 100, `a 1K-row store should cost well under 100MB RSS, measured ${(after - before).toFixed(1)}MB`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
