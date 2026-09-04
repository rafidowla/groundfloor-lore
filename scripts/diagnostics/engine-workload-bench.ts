#!/usr/bin/env tsx
/**
 * engine-workload-bench.ts — Phase 7 item 3: head-to-head on the real corpus,
 * at the operation shapes Atlas actually issues.
 *
 * This is deliberately NOT a general benchmark. Phase 2 already produced one and
 * its headline numbers (`listNodes` 25× slower, `search` 4.4×) were measured at
 * shapes nobody checked against a consumer. Item 1 of this phase established
 * what Atlas really calls, so this measures those shapes and no others:
 *
 *   - `listNodes` UNBOUNDED, and type-filtered unbounded — Atlas's hot path.
 *     `subgraph.ts:261-262`, `embeddedReader.ts:123` and `memorySync.ts:236`
 *     all pass no limit, and `EmbeddedLore.listNodes` turns that into
 *     `{ unbounded: true }`.
 *   - Full edge enumeration via paginated `queryEdges` — Atlas's `listEdges()`,
 *     the other half of every graph surface it exposes.
 *   - `listNodes` at bounded limits, to test whether the 25× headline describes
 *     any request a caller actually makes.
 *   - `traverse` depths 1–5, which Atlas does NOT call (kept for completeness
 *     and because it is the only operation SurrealDB wins).
 *   - `getNode` and `search`, for the surfaces that do use them.
 *
 * p50 and p95, never means: one slow first-open dominates a mean and hides the
 * distribution, which is exactly how a misleading headline gets produced.
 *
 * ONE WORKSPACE PER PROCESS INVOCATION, so each reading starts cold rather
 * than warmed by a prior run's buffer pool.
 *
 *   LORE_HOME=<home> BENCH_WS=src|dst tsx scripts/diagnostics/engine-workload-bench.ts
 */

import { LocalGraphRegistry } from '../../packages/lore/src/engines/localGraphRegistry.js';
import type { LoreNode } from '../../packages/lore/src/providers/types.js';

const HOME = process.env['LORE_HOME'];
const WS = process.env['BENCH_WS'];
if (!HOME || !WS) throw new Error('engine-workload-bench: LORE_HOME and BENCH_WS are required');

const REPS = Number(process.env['BENCH_REPS'] ?? '7');

interface Sample { op: string; p50: number; p95: number; n: number; reps: number }

function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i]!;
}

const results: Sample[] = [];

/**
 * Time `fn` `reps` times and record p50/p95.
 *
 * The read cache is disabled on both engines for this run, so every repetition
 * is a real query — otherwise repetition 2..n would measure the memoizer and
 * both engines would look identically fast.
 */
async function bench(op: string, fn: () => Promise<number>): Promise<void> {
    const times: number[] = [];
    let n = 0;
    for (let i = 0; i < REPS; i++) {
        const t0 = performance.now();
        n = await fn();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({ op, p50: pct(times, 50), p95: pct(times, 95), n, reps: REPS });
}

const registry = new LocalGraphRegistry({ home: HOME });
const g = await registry.getGraphHandle(WS) as {
    listNodes(t?: string, tag?: string, p?: string, e?: string, l?: number, o?: { unbounded?: boolean }): Promise<LoreNode[]>;
    queryEdges(q: { limit: number; offset: number }): Promise<unknown[]>;
    traverse(id: string, depth?: number): Promise<unknown[]>;
    getNode(id: string): Promise<LoreNode | null>;
    search(q: string, limit?: number, p?: string, e?: string): Promise<LoreNode[]>;
    getStats(): Promise<{ nodeCount: number; edgeCount: number }>;
    constructor: { name: string };
};

const engine = g.constructor.name;
const stats = await g.getStats();

// Seeds for point/traversal ops: spread across the id space, and only nodes
// that actually have neighbours — a degree-0 seed makes traversal look free.
const all = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
const sortedIds = all.map((n) => n.id).sort();
const spread = (k: number): string[] =>
    Array.from({ length: k }, (_, i) => sortedIds[Math.floor((i * sortedIds.length) / k)]!);
const seeds: string[] = [];
for (const id of spread(200)) {
    if (seeds.length >= 10) break;
    if ((await g.traverse(id, 1)).length > 0) seeds.push(id);
}

/* ── Atlas's actual hot path: unbounded listNodes ─────────────────── */
await bench('listNodes UNBOUNDED (all types)', async () =>
    (await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true })).length);
for (const type of ['code_file', 'code_symbol']) {
    await bench(`listNodes UNBOUNDED type=${type}`, async () =>
        (await g.listNodes(type, undefined, '*', '*', undefined, { unbounded: true })).length);
}

/* ── bounded limits, to test whether the headline describes a real call ── */
for (const limit of [1, 100, 1000, 10000]) {
    await bench(`listNodes LIMIT ${limit}`, async () =>
        (await g.listNodes(undefined, undefined, '*', '*', limit)).length);
}

/* ── Atlas's listEdges(): full edge enumeration ───────────────────── */
await bench('queryEdges FULL enumeration (page 1000)', async () => {
    let n = 0;
    for (let off = 0; ; off += 1000) {
        const page = await g.queryEdges({ limit: 1000, offset: off });
        n += page.length;
        if (page.length < 1000) break;
    }
    return n;
});

/* ── traverse: the one SurrealDB wins, and Atlas does not call ────── */
for (const depth of [1, 2, 3, 4, 5]) {
    await bench(`traverse depth ${depth} (10 seeds)`, async () => {
        let n = 0;
        for (const s of seeds) n += (await g.traverse(s, depth)).length;
        return n;
    });
}

/* ── point reads and search ───────────────────────────────────────── */
await bench('getNode ×100', async () => {
    let n = 0;
    for (const id of spread(100)) if (await g.getNode(id)) n++;
    return n;
});
for (const limit of [10, 100]) {
    await bench(`search "workspace" LIMIT ${limit}`, async () =>
        (await g.search('workspace', limit, '*', '*')).length);
}

console.log(JSON.stringify({
    engine, workspace: WS, reps: REPS,
    nodes: stats.nodeCount, edges: stats.edgeCount,
    results,
}, null, 2));

await registry.disposeAll();
