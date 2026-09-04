#!/usr/bin/env tsx
/**
 * directed-traverse-bench.ts — cost of `traverseDirected` against `traverse`.
 *
 * `traverse` batches its BFS frontier (one statement per depth per direction).
 * `traverseDirected` was written against the older per-node shape, so it issues
 * two executions per frontier NODE per depth. This measures the gap so the
 * follow-up is justified by a number rather than by symmetry.
 *
 * One workspace per process invocation, for a cold reading each time.
 *
 *   LORE_HOME=<home> BENCH_WS=src|dst tsx scripts/diagnostics/directed-traverse-bench.ts
 */
import { LocalGraphRegistry } from '../../packages/lore/src/engines/localGraphRegistry.js';
import type { LoreNode } from '../../packages/lore/src/providers/types.js';

const HOME = process.env['LORE_HOME']; const WS = process.env['BENCH_WS'];
if (!HOME || !WS) throw new Error('LORE_HOME and BENCH_WS required');
const REPS = Number(process.env['BENCH_REPS'] ?? '5');

const pct = (a: number[], p: number): number =>
    a.length === 0 ? 0 : a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))]!;

const registry = new LocalGraphRegistry({ home: HOME });
const g = await registry.getGraphHandle(WS) as {
    listNodes(t?: string, tg?: string, p?: string, e?: string, l?: number, o?: { unbounded?: boolean }): Promise<LoreNode[]>;
    traverse(id: string, d?: number): Promise<unknown[]>;
    traverseDirected(id: string, d?: number): Promise<unknown[]>;
    constructor: { name: string };
};
const all = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
const sorted = all.map((n) => n.id).sort();
const spread = (k: number): string[] =>
    Array.from({ length: k }, (_, i) => sorted[Math.floor((i * sorted.length) / k)]!);
const seeds: string[] = [];
for (const id of spread(200)) { if (seeds.length >= 10) break; if ((await g.traverse(id, 1)).length > 0) seeds.push(id); }

const out: Array<Record<string, unknown>> = [];
for (const depth of [1, 2, 3, 4, 5]) {
    for (const [op, fn] of [['traverse', g.traverse.bind(g)], ['traverseDirected', g.traverseDirected.bind(g)]] as const) {
        const ts: number[] = []; let rows = 0;
        for (let i = 0; i < REPS; i++) {
            const t0 = performance.now();
            let n = 0; for (const s of seeds) n += (await fn(s, depth)).length;
            ts.push(performance.now() - t0); rows = n;
        }
        ts.sort((a, b) => a - b);
        out.push({ op, depth, p50: pct(ts, 50), p95: pct(ts, 95), rows });
    }
}
console.log(JSON.stringify({ engine: g.constructor.name, workspace: WS, results: out }, null, 2));
await registry.disposeAll();
