#!/usr/bin/env tsx
/**
 * summary-read-bench.ts — what does the narrow node read actually save?
 *
 * `listNodeSummaries` returns `id`/`type`/`label` where `listNodes` returns
 * whole `LoreNode` records. The prediction was that it helps SurrealDB most,
 * because a document store materialises whole documents while Kùzu is columnar
 * and can skip the columns nobody asked for. That is a prediction; this
 * measures it on both engines against the same corpus.
 *
 * One engine per process — kuzu-lite's open/close ceiling, and so each reading
 * is cold rather than warmed by the other engine's buffer pool.
 *
 *   LORE_HOME=<home> BENCH_WS=src|dst tsx scripts/diagnostics/summary-read-bench.ts
 */

import { LocalGraphRegistry } from '../../packages/lore/src/engines/localGraphRegistry.js';
import type { LoreNode, LoreNodeSummary } from '../../packages/lore/src/providers/types.js';

const HOME = process.env['LORE_HOME'];
const WS = process.env['BENCH_WS'];
if (!HOME || !WS) throw new Error('summary-read-bench: LORE_HOME and BENCH_WS are required');
const REPS = Number(process.env['BENCH_REPS'] ?? '7');

interface Row { op: string; p50: number; p95: number; rows: number }

function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

const out: Row[] = [];
async function bench(op: string, fn: () => Promise<number>): Promise<void> {
    const ts: number[] = [];
    let rows = 0;
    for (let i = 0; i < REPS; i++) {
        const t0 = performance.now();
        rows = await fn();
        ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    out.push({ op, p50: pct(ts, 50), p95: pct(ts, 95), rows });
}

const registry = new LocalGraphRegistry({ home: HOME });
const g = await registry.getGraphHandle(WS) as {
    listNodes(t?: string, tag?: string, p?: string, e?: string, l?: number, o?: { unbounded?: boolean }): Promise<LoreNode[]>;
    listNodeSummaries(t?: string, tag?: string, p?: string, e?: string, l?: number, o?: { unbounded?: boolean }): Promise<LoreNodeSummary[]>;
    getStats(): Promise<{ nodeCount: number; edgeCount: number }>;
    constructor: { name: string };
};
const stats = await g.getStats();

// Atlas's shapes: unbounded, and unbounded per type (subgraph.ts calls it twice).
await bench('listNodes       UNBOUNDED', async () =>
    (await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true })).length);
await bench('listNodeSummaries UNBOUNDED', async () =>
    (await g.listNodeSummaries(undefined, undefined, '*', '*', undefined, { unbounded: true })).length);

for (const type of ['code_file', 'code_symbol']) {
    await bench(`listNodes       type=${type}`, async () =>
        (await g.listNodes(type, undefined, '*', '*', undefined, { unbounded: true })).length);
    await bench(`listNodeSummaries type=${type}`, async () =>
        (await g.listNodeSummaries(type, undefined, '*', '*', undefined, { unbounded: true })).length);
}

console.log(JSON.stringify({
    engine: g.constructor.name, workspace: WS, reps: REPS,
    nodes: stats.nodeCount, edges: stats.edgeCount, results: out,
}, null, 2));

await registry.disposeAll();
