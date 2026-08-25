#!/usr/bin/env tsx
/**
 * lancedb-ivf-flat-vector-index-unit.ts — fix/lancedb-ivf-pq-recall-loss.
 *
 * Covers the mechanics of the fix:
 *   1. ensureVectorIndex builds IVF_FLAT, never the default IVF_PQ.
 *   2. Partition count scales with row count (computeIvfPartitions), not a
 *      fixed value.
 *   3. A pre-fix IVF_PQ index gets MIGRATED (dropped + rebuilt as IVF_FLAT),
 *      not left in place — ensureVectorIndex's "already indexed" check now
 *      requires indexType === 'IvfFlat', matching the exact same pattern the
 *      FTS fix used for its own indexType === 'FTS' check.
 *   4. The migration also runs PROACTIVELY at store open — a workspace that
 *      is only ever reopened for reads (never written to again) must still
 *      get upgraded, mirroring the FTS fix's proactive-build-at-open.
 *   5. A basic recall sanity check on a real corpus size.
 *
 * On recall QUALITY itself: this file does NOT attempt to reproduce the
 * measured recall loss with synthetic vectors. It doesn't reproduce —
 * confirmed empirically (see below) — because real text embeddings occupy a
 * narrow-band similarity manifold (pairwise cosine similarities cluster in a
 * moderate range) that IVF_PQ's quantization genuinely blurs, whereas
 * synthetic random or topic-clustered vectors are separated enough that even
 * a badly-partitioned, quantized index still finds the right neighbour. The
 * recall claim (88-92% -> 100% recall@1) is verified against 4,170 REAL
 * embeddings read from a live Atlas workspace and documented in
 * verbatimBatch.ts's ensureVectorIndex/computeIvfPartitions doc comments and
 * the Lorebase node lancedb-ann-index-recall-loss-small-scale-2026-08-04 — not
 * re-derived here, because committing real embeddings into the test suite
 * is not appropriate and synthetic vectors cannot honestly stand in for them.
 *
 * Run: npx tsx test/lancedb-ivf-flat-vector-index-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { computeIvfPartitions } from '../packages/lore/src/engines/verbatimBatch.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ivfflat-home-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
}

function tmpDir(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `ivfflat-${label}-`));
}

/** Deterministic pseudo-random unit vector, seeded so runs are reproducible. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function unitVec(seed: number, dim: number): number[] {
    const r = rng(seed);
    const v = Array.from({ length: dim }, () => r() * 2 - 1);
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / n);
}

/** Maps "row:<i>" -> a known base vector, "query:<i>:<seed>" -> that same
 *  base vector plus small deterministic noise (a controlled near-duplicate,
 *  the way a real fuzzy query relates to its target document). */
const EMBED_DIM = 48;
class KnownVectorEmbedder implements EmbeddingProvider {
    readonly modelId = 'known-vector-mock';
    readonly dimension = EMBED_DIM;
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map((t) => this.vec(t)); }
    private vec(text: string): number[] {
        const m = /^(row|query):(\d+)(?::(\d+))?$/.exec(text);
        if (!m) throw new Error(`KnownVectorEmbedder: unexpected text "${text}"`);
        const i = Number(m[2]);
        const noiseSeed = m[3] !== undefined ? Number(m[3]) : null;
        const base = unitVec(i + 1, this.dimension);
        if (noiseSeed === null) return base;
        const r = rng(90_000 + noiseSeed);
        const noisy = base.map((x) => x + (r() * 0.06 - 0.03));
        const n = Math.sqrt(noisy.reduce((a, b) => a + b * b, 0)) || 1;
        return noisy.map((x) => x / n);
    }
}

/** Reach into the store's LanceDB table to read raw index metadata — the
 *  same test-only introspection pattern used throughout this test suite for
 *  Kùzu/LanceDB internals not exposed on the public VerbatimStore API. */
async function listVectorIndices(store: VerbatimStore): Promise<Array<{ indexType?: string; columns?: string[] }>> {
    const table = (store as unknown as { table: lancedb.Table | null }).table;
    if (!table) return [];
    const indices = await table.listIndices?.();
    return Array.isArray(indices) ? (indices as Array<{ indexType?: string; columns?: string[] }>) : [];
}

async function main(): Promise<void> {
    await test('computeIvfPartitions: scales with rows, floors at ~50 rows/partition, never below 1', () => {
        assert.equal(computeIvfPartitions(10), 1, 'tiny table: floor at 1, never 0');
        assert.equal(computeIvfPartitions(100), 2, 'sqrt(100)=10, floor(100/50)=2 -> min is the /50 floor');
        assert.equal(computeIvfPartitions(2500), 50, 'sqrt(2500)=50 == floor(2500/50)=50');
        assert.equal(computeIvfPartitions(4170), 65, 'matches the real 4,170-row corpus measurement (round(sqrt(4170))=65)');
        assert.equal(computeIvfPartitions(90_000), 300, 'large tables: sqrt dominates, /50 floor no longer binds');
    });

    await test('ensureVectorIndex builds IVF_FLAT, never the default IVF_PQ', async () => {
        const dir = tmpDir('ivfflat');
        const store = new VerbatimStore(dir, new KnownVectorEmbedder());
        await store.initialize();
        const docs = Array.from({ length: 60 }, (_, i) => ({ id: `lore:v${i}`, text: `row:${i}`, metadata: {} }));
        await store.storeBatch(docs);
        const built = await store.ensureVectorIndex({ minRows: 50 });
        assert.equal(built, true, 'index should build once past the (lowered, test-only) row threshold');
        const indices = await listVectorIndices(store);
        const vecIdx = indices.find((idx) => idx.columns?.includes('vector'));
        assert.ok(vecIdx, 'a vector index must exist');
        assert.equal(vecIdx!.indexType, 'IvfFlat', `expected IvfFlat, got ${vecIdx!.indexType} (IvfPq quantizes and loses recall at this scale)`);
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('migration: a pre-fix IvfPq index is detected as wrong-type and rebuilt as IvfFlat', async () => {
        const dir = tmpDir('migrate');
        const store = new VerbatimStore(dir, new KnownVectorEmbedder());
        await store.initialize();
        const docs = Array.from({ length: 260 }, (_, i) => ({ id: `lore:m${i}`, text: `row:${i}`, metadata: {} })); // >= 256: the row count LanceDB's plain createIndex('vector') itself REQUIRES to train PQ at all -- below that it errors outright, which is exactly why 256 was the historical minRows
        await store.storeBatch(docs);

        // Simulate a workspace built by pre-fix code: the bare createIndex
        // call this fix replaced, with no explicit config -> LanceDB's
        // plain-call default, which is IVF_PQ.
        const table = (store as unknown as { table: lancedb.Table }).table;
        await table.createIndex('vector');
        const before = await listVectorIndices(store);
        assert.equal(before.find((i) => i.columns?.includes('vector'))?.indexType, 'IvfPq', 'precondition: simulated pre-fix index is IvfPq');

        const built = await store.ensureVectorIndex({ minRows: 50 });
        assert.equal(built, true, 'a wrong-type existing index must NOT be treated as "already indexed" — it must be rebuilt');
        const after = await listVectorIndices(store);
        assert.equal(after.find((i) => i.columns?.includes('vector'))?.indexType, 'IvfFlat', 'post-migration index must be IvfFlat');

        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('proactive migration at open: reopening a store with a stale IvfPq index upgrades it with no write', async () => {
        const dir = tmpDir('reopen');
        const writer = new VerbatimStore(dir, new KnownVectorEmbedder());
        await writer.initialize();
        const docs = Array.from({ length: 260 }, (_, i) => ({ id: `lore:r${i}`, text: `row:${i}`, metadata: {} })); // >= 256, see the migration test above for why
        await writer.storeBatch(docs);
        const writerTable = (writer as unknown as { table: lancedb.Table }).table;
        await writerTable.createIndex('vector'); // simulate pre-fix state again
        await writer.close();

        // A fresh instance, as a real restart would create — no storeBatch,
        // no explicit ensureVectorIndex call from the test. If migration only
        // happened reactively (after a write), this would stay IvfPq forever.
        const reopened = new VerbatimStore(dir, new KnownVectorEmbedder());
        await reopened.initialize();
        const indices = await listVectorIndices(reopened);
        const vecIdx = indices.find((idx) => idx.columns?.includes('vector'));
        assert.equal(vecIdx?.indexType, 'IvfFlat', 'initialize() alone (no write) must upgrade a stale IvfPq index, mirroring the FTS proactive-build-at-open fix');

        await reopened.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('recall sanity: the fix does not regress correctness on an ordinary corpus', async () => {
        const dir = tmpDir('sanity');
        const store = new VerbatimStore(dir, new KnownVectorEmbedder());
        await store.initialize();
        const N = 300;
        const docs = Array.from({ length: N }, (_, i) => ({ id: `lore:s${i}`, text: `row:${i}`, metadata: {} }));
        await store.storeBatch(docs);
        await store.ensureVectorIndex({ minRows: 50 });

        let hits = 0;
        const QUERIES = 50;
        for (let k = 0; k < QUERIES; k++) {
            const idx = (k * 7) % N;
            const results = await store.search(`query:${idx}:${k}`, 10);
            if (results[0]?.id === `lore:s${idx}`) hits++;
        }
        assert.ok(hits >= QUERIES * 0.9, `expected >=90% recall@1 on a well-separated sanity corpus, got ${hits}/${QUERIES}`);

        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

void main();
