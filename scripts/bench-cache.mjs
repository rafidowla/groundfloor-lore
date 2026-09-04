#!/usr/bin/env node
/**
 * bench-cache.mjs — Q1.3 SLO harness for the local read cache.
 *
 * Runs against SurrealGraph (the local engine since the legacy graph-engine
 * removal, Phase 3d 2026-08-21 — the cache surface it exercises is engine-agnostic:
 * search / listNodes / getNode / getCacheStats / write-invalidation).
 * What it measures:
 *   1. Cold baseline — repeated read hits with LORE_CACHE_DISABLED=1.
 *      (The cache module still loads; the disabled flag makes every
 *      memoize() call fall straight through to the loader.)
 *   2. Hot run — same read workload with the cache enabled.
 *
 * Acceptance (post_v2_plan.md §Q1.3):
 *   - 3× p95 improvement on repeat queries
 *   - 50–200ms p95 recall
 *   - Invalidation verified by write-then-read (writes a node,
 *     immediately getNode()s it, asserts the new label is returned).
 *
 * Usage:
 *   node scripts/bench-cache.mjs [iterations]
 *
 * Default iterations: 200.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// Prefer the built output — the harness is run from the repo root
// after `npm run build`. Falling back to tsx-style import would pull
// every transitive dep at runtime and mask a real build bug.
const { SurrealGraph } = await import(path.join(repoRoot, 'dist/lore/src/engines/surrealGraph.js'));

const ITERATIONS = Number(process.argv[2] ?? 200);
const BASE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bench-'));

process.on('exit', () => {
    try { fs.rmSync(BASE_PATH, { recursive: true, force: true }); } catch {}
});

async function seed(graph, count) {
    // Seed with a modest corpus so search has something to chew on but
    // cold-path latency stays on the same order of magnitude as a real
    // workspace. 100 nodes is ~10× the median local graph at boot; the
    // benchmark's point is relative speedup, not absolute dataset size.
    for (let i = 0; i < count; i++) {
        await graph.upsertNode({
            id: `bench-node-${i}`,
            type: 'note',
            label: `Bench note ${i}`,
            content: `Some content for node ${i}. Common search term: authorization retry pattern.`,
            tags: `bench,auth,retry,n${i}`,
            project: 'bench',
            ecosystem: 'groundfloor',
            metadata: '{}',
            security_scopes: [],
        });
    }
}

function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

async function timeRead(fn) {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
}

async function runWorkload(graph, iterations) {
    const samples = [];
    // Mix the three hottest read paths: search (recall's heavy
    // hitter), listNodes (FiltersPanel), getNode (traverse
    // hydration). Same mix both cold and hot so the speedup is
    // apples-to-apples.
    for (let i = 0; i < iterations; i++) {
        const pick = i % 3;
        if (pick === 0) {
            samples.push(await timeRead(() => graph.search('authorization retry', 20, '*', '*')));
        } else if (pick === 1) {
            samples.push(await timeRead(() => graph.listNodes('note', undefined, '*', '*')));
        } else {
            samples.push(await timeRead(() => graph.getNode(`bench-node-${i % 100}`)));
        }
    }
    return samples;
}

async function main() {
    console.log(`[bench-cache] temp dir: ${BASE_PATH}`);
    console.log(`[bench-cache] iterations: ${ITERATIONS}`);

    // Phase 1: cold baseline. Flip the disabled flag BEFORE we
    // construct the graph so ReadCache honors it.
    process.env.LORE_CACHE_DISABLED = '1';
    const cold = new SurrealGraph(BASE_PATH);
    await cold.initialize();
    await seed(cold, 100);
    const coldSamples = await runWorkload(cold, ITERATIONS);
    // Close the cold instance before opening the hot one: two handles on
    // one surrealkv directory contend on its asynchronously-released lock.
    await cold.close().catch(() => undefined);
    await new Promise((res) => setTimeout(res, 500));

    // Phase 2: hot (cached). Use a fresh engine instance on the same store
    // so the driver's own internal buffers aren't pre-warmed unfairly in
    // the cache's favor. We're measuring our cache against the engine
    // operating normally.
    process.env.LORE_CACHE_DISABLED = '';
    delete process.env.LORE_CACHE_DISABLED;
    const hot = new SurrealGraph(BASE_PATH);
    await hot.initialize();
    // One warmup pass to populate the cache; excluded from samples.
    await runWorkload(hot, ITERATIONS);
    const hotSamples = await runWorkload(hot, ITERATIONS);
    const stats = hot.getCacheStats();

    // Phase 3: invalidation correctness.
    await hot.upsertNode({
        id: 'bench-node-0',
        type: 'note',
        label: 'UPDATED',
        content: 'new content',
        tags: 'updated',
        project: 'bench',
        ecosystem: 'groundfloor',
        metadata: '{}',
        security_scopes: [],
    });
    const postWrite = await hot.getNode('bench-node-0');
    const invalidationOk = postWrite && postWrite.label === 'UPDATED';

    const report = {
        iterations: ITERATIONS,
        cold: {
            p50: percentile(coldSamples, 50).toFixed(3),
            p95: percentile(coldSamples, 95).toFixed(3),
            max: Math.max(...coldSamples).toFixed(3),
        },
        hot: {
            p50: percentile(hotSamples, 50).toFixed(3),
            p95: percentile(hotSamples, 95).toFixed(3),
            max: Math.max(...hotSamples).toFixed(3),
        },
        speedup_p95: (percentile(coldSamples, 95) / Math.max(percentile(hotSamples, 95), 1e-6)).toFixed(2) + 'x',
        hitRate: (stats.hits / Math.max(stats.hits + stats.misses, 1) * 100).toFixed(1) + '%',
        cacheStats: stats,
        invalidation_after_write: invalidationOk ? 'PASS' : 'FAIL',
    };

    console.log('\n=== Q1.3 cache benchmark ===');
    console.log(JSON.stringify(report, null, 2));

    const coldP95 = percentile(coldSamples, 95);
    const hotP95 = percentile(hotSamples, 95);
    const speedup = coldP95 / Math.max(hotP95, 1e-6);

    const sloHotP95Ok = hotP95 <= 200;
    const sloSpeedupOk = speedup >= 3.0;
    const allOk = invalidationOk && sloHotP95Ok && sloSpeedupOk;

    console.log('\n=== SLO check ===');
    console.log(`  hot p95 ≤ 200ms    : ${sloHotP95Ok ? 'PASS' : 'FAIL'} (${hotP95.toFixed(2)}ms)`);
    console.log(`  speedup ≥ 3×       : ${sloSpeedupOk ? 'PASS' : 'FAIL'} (${speedup.toFixed(2)}x)`);
    console.log(`  invalidation works : ${invalidationOk ? 'PASS' : 'FAIL'}`);

    process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
    console.error('[bench-cache] FAIL:', err);
    process.exit(2);
});
