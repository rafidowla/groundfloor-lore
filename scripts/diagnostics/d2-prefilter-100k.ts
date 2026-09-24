#!/usr/bin/env tsx
/**
 * scripts/diagnostics/d2-prefilter-100k.ts — D2 type/kind prefilter,
 * one-off measurement at 100k distractor rows.
 *
 * Same fixture shape as test/d2-type-prefilter-unit.ts (1 `knowledge`
 * target + 79 `knowledge` filler rows + N `junk`-typed distractor rows,
 * engineered to always outrank the target on raw vector similarity and raw
 * BM25 term frequency), swept at N=0 and N=100000, measuring hit@1 (is the
 * top seed-store hit the target id?) through `resolveSeedStore()` with a
 * `types: ['knowledge']` prefilter, on the sqlite/sqlite engine pair
 * (SqliteVerbatimStore). Also attempts the surreal/lance pair
 * (VerbatimStore backed by LanceDB) at the same N, bounded by a wall-clock
 * budget — if it does not complete in that budget it is skipped and the
 * result JSON records why, per the task's "if it completes in reasonable
 * time" instruction.
 *
 * Run: npx tsx scripts/diagnostics/d2-prefilter-100k.ts
 * Output: scripts/diagnostics/results/d2-prefilter-100k-<timestamp>.json
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteVerbatimStore } from '../../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../../packages/lore/src/engines/verbatimStore.js';
import { resolveSeedStore, type RetrieveSeedStoreDeps } from '../../packages/lore/src/recall/retrieveSeedStore.js';
import type { EmbeddingProvider } from '../../packages/lore/src/providers/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIM = 8;
function vecForCosine(cos: number, saltDim: number, salt: number): number[] {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const v = new Array(DIM).fill(0);
    v[0] = cos;
    v[1] = sin;
    v[saltDim] = (salt % 997) * 1e-6;
    return v;
}
function hashOf(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
class FixedVectorEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'd2-100k-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return vecForCosine(1, 2, 0); }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        if (text.startsWith('TARGET')) return vecForCosine(0.9, 2, 1);
        if (text.startsWith('KDIST')) return vecForCosine(0.5, 2, hashOf(text));
        if (text.startsWith('JUNK')) return vecForCosine(0.999, 2, hashOf(text));
        throw new Error(`unexpected fixture text: ${text}`);
    }
}

const RARE_TOKEN = 'zzqueryword100k9182';
const RETRIEVE_WORST_CASE_WINDOW = 160; // limit(10) x SEED_MAX_HEADROOM(16), same as the unit test.

function tmpWorkspace(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function seedFixture(
    store: { store: (row: { id: string; text: string; metadata: Record<string, unknown> }) => Promise<unknown> },
    junkCount: number,
): Promise<{ targetId: string }> {
    const targetId = 'target-knowledge-1';
    await store.store({
        id: targetId,
        text: `TARGET the canonical answer document mentions ${RARE_TOKEN} exactly once`,
        metadata: { type: 'knowledge', ecosystem: 'e1' },
    });
    for (let i = 0; i < 79; i++) {
        await store.store({
            id: `kdist-${i}`,
            text: `KDIST unrelated knowledge filler row number ${i} about nothing in particular`,
            metadata: { type: 'knowledge', ecosystem: 'e1' },
        });
    }
    const junkTextTail = new Array(40).fill(RARE_TOKEN).join(' ');
    for (let i = 0; i < junkCount; i++) {
        await store.store({
            id: `junk-${i}`,
            text: `JUNK distractor row ${i} ${junkTextTail}`,
            metadata: { type: 'junk', ecosystem: 'e1' },
        });
    }
    return { targetId };
}

function depsFor(store: {
    count: () => number | Promise<number>;
    search: (q: string, n: number, filter?: unknown, opts?: unknown, actorScopes?: ReadonlyArray<string>) => unknown;
    bm25Search: (q: string, n: number, filter?: unknown, actorScopes?: ReadonlyArray<string>) => unknown;
}): RetrieveSeedStoreDeps {
    return {
        store: { storageClient: null },
        workspaceVerbatimResolver: {
            getOrOpen: async () => ({
                count: () => store.count(),
                search: (q: string, n: number, filter?: unknown, opts?: unknown, actorScopes?: ReadonlyArray<string>, _gate?: unknown) =>
                    store.search(q, n, filter, opts, actorScopes),
                bm25Search: (q: string, n: number, filter?: unknown, actorScopes?: ReadonlyArray<string>, _gate?: unknown) =>
                    store.bm25Search(q, n, filter, actorScopes),
            }),
        },
    } as unknown as RetrieveSeedStoreDeps;
}

interface LegResult {
    junkCount: number;
    hitAt1: boolean;
    topHitId: string | null;
    seedMs: number;
    queryMs: number;
}

async function measureSqlite(junkCount: number): Promise<{ vector: LegResult; bm25: LegResult }> {
    const store = new SqliteVerbatimStore(tmpWorkspace('d2-100k-sqlite-'), new FixedVectorEmbedProvider());
    await store.initialize();
    try {
        const seedStart = Date.now();
        const { targetId } = await seedFixture(store, junkCount);
        const seedMs = Date.now() - seedStart;

        const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, ['knowledge']);
        assert.ok(seedStore, 'resolveSeedStore must resolve for the non-boot workspace');

        const vecStart = Date.now();
        const vecHits = await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW);
        const vector: LegResult = {
            junkCount, hitAt1: vecHits[0]?.id === targetId, topHitId: vecHits[0]?.id ?? null,
            seedMs, queryMs: Date.now() - vecStart,
        };

        const bmStart = Date.now();
        const bmEnvelope = await seedStore!.bm25Search(RARE_TOKEN, RETRIEVE_WORST_CASE_WINDOW);
        const bm25: LegResult = {
            junkCount, hitAt1: bmEnvelope.hits[0]?.id === targetId, topHitId: bmEnvelope.hits[0]?.id ?? null,
            seedMs, queryMs: Date.now() - bmStart,
        };
        return { vector, bm25 };
    } finally {
        await store.close();
    }
}

async function measureLance(junkCount: number, budgetMs: number): Promise<{ vector: LegResult; bm25: LegResult } | { skipped: string }> {
    const deadline = Date.now() + budgetMs;
    const store = new VerbatimStore(tmpWorkspace('d2-100k-lance-'), new FixedVectorEmbedProvider());
    await store.initialize();
    try {
        const seedStart = Date.now();
        const { targetId } = await seedFixture(store as unknown as { store: (row: { id: string; text: string; metadata: Record<string, unknown> }) => Promise<unknown> }, junkCount);
        const seedMs = Date.now() - seedStart;
        if (Date.now() > deadline) return { skipped: `seeding ${junkCount} rows exceeded the ${budgetMs}ms budget (took ${seedMs}ms)` };

        const seedStore = await resolveSeedStore(depsFor(store as unknown as Parameters<typeof depsFor>[0]), 'ws1', false, '*', undefined, ['knowledge']);
        assert.ok(seedStore, 'resolveSeedStore must resolve for the non-boot workspace');

        const vecStart = Date.now();
        const vecHits = await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW);
        const vector: LegResult = {
            junkCount, hitAt1: vecHits[0]?.id === targetId, topHitId: vecHits[0]?.id ?? null,
            seedMs, queryMs: Date.now() - vecStart,
        };

        const bmStart = Date.now();
        const bmEnvelope = await seedStore!.bm25Search(RARE_TOKEN, RETRIEVE_WORST_CASE_WINDOW);
        const bm25: LegResult = {
            junkCount, hitAt1: bmEnvelope.hits[0]?.id === targetId, topHitId: bmEnvelope.hits[0]?.id ?? null,
            seedMs, queryMs: Date.now() - bmStart,
        };
        return { vector, bm25 };
    } finally {
        await store.close();
    }
}

async function main(): Promise<void> {
    console.log('d2-prefilter-100k diagnostic\n');
    const results: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        fixture: 'D2 unit-test shape: 1 knowledge target + 79 knowledge filler + N junk (vector cos=0.999, BM25 40x rare-token repeat), types:[\'knowledge\'] prefilter, topK=160',
        sweep: [0, 100000],
    };

    console.log('sqlite/sqlite pair:');
    const sqliteResults: unknown[] = [];
    for (const n of [0, 100000]) {
        console.log(`  seeding + querying N=${n}...`);
        const r = await measureSqlite(n);
        console.log(`    vector hit@1=${r.vector.hitAt1} (seed ${r.vector.seedMs}ms, query ${r.vector.queryMs}ms)`);
        console.log(`    bm25   hit@1=${r.bm25.hitAt1} (seed ${r.bm25.seedMs}ms, query ${r.bm25.queryMs}ms)`);
        sqliteResults.push({ junkCount: n, vector: r.vector, bm25: r.bm25 });
    }
    results['sqliteSqlite'] = sqliteResults;

    console.log('\nsurreal/lance pair (vector store leg only — graph engine is not exercised by resolveSeedStore):');
    const LANCE_BUDGET_MS = 5 * 60 * 1000; // 5 minutes per N; skip if exceeded.
    const lanceResults: unknown[] = [];
    for (const n of [0, 100000]) {
        console.log(`  seeding + querying N=${n} (budget ${LANCE_BUDGET_MS}ms)...`);
        const r = await measureLance(n, LANCE_BUDGET_MS);
        if ('skipped' in r) {
            console.log(`    SKIPPED: ${r.skipped}`);
            lanceResults.push({ junkCount: n, skipped: r.skipped });
        } else {
            console.log(`    vector hit@1=${r.vector.hitAt1} (seed ${r.vector.seedMs}ms, query ${r.vector.queryMs}ms)`);
            console.log(`    bm25   hit@1=${r.bm25.hitAt1} (seed ${r.bm25.seedMs}ms, query ${r.bm25.queryMs}ms)`);
            lanceResults.push({ junkCount: n, vector: r.vector, bm25: r.bm25 });
        }
    }
    results['surrealLance'] = lanceResults;

    const outDir = path.join(__dirname, 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `d2-prefilter-100k-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nresults written to ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
