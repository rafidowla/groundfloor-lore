#!/usr/bin/env tsx
/**
 * graph-engine-latency-unit.ts — 3.21 step 1b latency gate.
 *
 * `listNodes({ limit: 1 })` p50/p95 over 100 calls on a 10 000-node
 * SqliteGraph store: p50 < 5 ms is REQUIRED (this is the design doc's
 * gate — the whole point of an indexed `nodes` table). The same
 * measurement on a 100 000-node store, and on SurrealGraph at both sizes,
 * is REPORTED (not gated) for before/after comparison.
 *
 * Fixture population uses SqliteGraph's internal `importRaw` bulk loader
 * (one transaction, not N awaited `upsertNode` round-trips) so seeding
 * 100k rows is itself fast; SurrealGraph has no equivalent bulk-import
 * primitive at this layer, so it seeds through `bulkUpsertNodes` — slower,
 * but it is the fastest PUBLIC write surface this engine has, and build
 * time is not part of the measurement.
 *
 * Also measures the `queryEdges` full-pagination-walk cost on SurrealGraph
 * (3.21 step 1c): `queryEdges`/`getTopology` gained `ORDER BY` on both
 * engines so `graph-engine-parity-unit.ts` can compare pages bit-for-bit —
 * see `surreal/surrealGraphAggregates.ts`'s `queryEdges` doc comment. That
 * reintroduces a cost the SAME function's ORIGINAL doc comment measured and
 * removed ORDER BY specifically to avoid: 51,934 edges walked in 1,000-row
 * pages cost ~150 ms/page sorted (9,227 ms total) vs 407 ms unsorted, with
 * no supporting index (SurrealDB `DEFINE INDEX` leaks a libuv handle on this
 * `@surrealdb/node` build, so it stays opt-in-only). This suite measures the
 * cost AGAIN, at a smaller edge count than that original benchmark (Surreal
 * edge writes are one round-trip per edge with no bulk-import primitive, so
 * reproducing 51,934 edges here would make this suite itself the slow part
 * of `npm test`), rather than leaving the reintroduced cost unmeasured.
 *
 * Run: LORE_GRAPH_LATENCY_N=10000 npx tsx test/graph-engine-latency-unit.ts
 *   Env overrides: LORE_GRAPH_LATENCY_N (default 10000,100000 both run
 *   unless LORE_GRAPH_LATENCY_SKIP_100K=1), LORE_GRAPH_LATENCY_SKIP_SURREAL=1
 *   to skip the (much slower) SurrealGraph before/after comparison,
 *   LORE_GRAPH_LATENCY_EDGE_N (default 5000) for the queryEdges walk.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
    }
}

function fixtureNode(i: number): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id: `n${String(i).padStart(7, '0')}`,
        type: i % 5 === 0 ? 'decision' : 'note',
        label: `Node ${i}`,
        content: `Body content for node number ${i}, with some extra text to be realistic.`,
        tags: [`tag${i % 20}`],
        project: 'p',
        ecosystem: 'e',
        metadata: '{}',
    };
}

async function seedSqlite(g: SqliteGraph, n: number): Promise<void> {
    const now = new Date().toISOString();
    const nodes: LoreNode[] = [];
    for (let i = 0; i < n; i++) {
        const f = fixtureNode(i);
        nodes.push({ ...f, createdAt: now, updatedAt: now, syncedAt: null } as LoreNode);
    }
    await g.importRaw(nodes, []);
}

async function seedSurreal(g: SurrealGraph, n: number): Promise<void> {
    const BATCH = 500;
    for (let i = 0; i < n; i += BATCH) {
        const batch = [];
        for (let j = i; j < Math.min(i + BATCH, n); j++) batch.push(fixtureNode(j));
        await g.bulkUpsertNodes(batch);
    }
}

function percentile(sortedMs: number[], p: number): number {
    const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
    return sortedMs[idx]!;
}

async function measureListNodesLimit1(g: { listNodes: SurrealGraph['listNodes'] }, calls: number): Promise<{ p50: number; p95: number }> {
    const samples: number[] = [];
    for (let i = 0; i < calls; i++) {
        const t0 = process.hrtime.bigint();
        await g.listNodes(undefined, undefined, '*', '*', 1);
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return { p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

interface Result { engine: string; n: number; p50: number; p95: number; buildMs: number }
const results: Result[] = [];

/** Walk every page of `queryEdges` (1000-row pages) once; returns total wall time in ms. */
async function walkAllEdgesMs(g: { queryEdges: SurrealGraph['queryEdges'] }, edgeCount: number): Promise<number> {
    const t0 = Date.now();
    let offset = 0;
    const limit = 1000;
    for (;;) {
        const page = await g.queryEdges({ limit, offset });
        if (page.length === 0) break;
        offset += limit;
        if (offset > edgeCount + limit) break; // safety valve
    }
    return Date.now() - t0;
}

/** Seed `n` nodes + a chain of `n - 1` edges (node_i -> node_i+1). */
async function seedChainSqlite(g: SqliteGraph, n: number): Promise<void> {
    const now = new Date().toISOString();
    const nodes = Array.from({ length: n }, (_, i) => ({ ...fixtureNode(i), createdAt: now, updatedAt: now, syncedAt: null }) as LoreNode);
    const edges = Array.from({ length: n - 1 }, (_, i) => ({
        sourceId: nodes[i]!.id, targetId: nodes[i + 1]!.id, relation: 'next',
    }));
    await g.importRaw(nodes, edges);
}
async function seedChainSurreal(g: SurrealGraph, n: number): Promise<void> {
    await seedSurreal(g, n);
    for (let i = 0; i < n - 1; i++) {
        await g.addEdge({ sourceId: fixtureNode(i).id, targetId: fixtureNode(i + 1).id, relation: 'next' });
    }
}

async function main(): Promise<void> {
    console.log('GRAPH-ENGINE-LATENCY — listNodes({limit:1}) p50/p95 over 100 calls');
    console.log('='.repeat(72));

    const sizes = [10_000, ...(process.env['LORE_GRAPH_LATENCY_SKIP_100K'] ? [] : [100_000])];
    const skipSurreal = process.env['LORE_GRAPH_LATENCY_SKIP_SURREAL'] === '1';

    for (const n of sizes) {
        const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-latency-sqlite-${n}-`));
        const sqlite = new SqliteGraph(sqliteDir, { workspaceId: 'latency', cacheDisabled: true });
        await sqlite.initialize();
        try {
            const t0 = Date.now();
            await seedSqlite(sqlite, n);
            const buildMs = Date.now() - t0;
            const { p50, p95 } = await measureListNodesLimit1(sqlite, 100);
            results.push({ engine: 'sqlite', n, p50, p95, buildMs });
            console.log(`  sqlite  n=${n}  build=${buildMs}ms  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms`);
            if (n === 10_000) {
                await check(`sqlite listNodes({limit:1}) p50 < 5ms on ${n} nodes (REQUIRED)`, () => {
                    assert.ok(p50 < 5, `p50 was ${p50.toFixed(3)}ms`);
                });
            }
        } finally {
            await sqlite.close().catch(() => undefined);
            fs.rmSync(sqliteDir, { recursive: true, force: true });
        }

        if (!skipSurreal) {
            const surrealDir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-latency-surreal-${n}-`));
            const surreal = new SurrealGraph(surrealDir, { workspaceId: 'latency', cacheDisabled: true });
            await surreal.initialize();
            try {
                const t0 = Date.now();
                await seedSurreal(surreal, n);
                const buildMs = Date.now() - t0;
                const { p50, p95 } = await measureListNodesLimit1(surreal, 100);
                results.push({ engine: 'surreal', n, p50, p95, buildMs });
                console.log(`  surreal n=${n}  build=${buildMs}ms  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms`);
            } finally {
                await surreal.close().catch(() => undefined);
                fs.rmSync(surrealDir, { recursive: true, force: true });
            }
        }
    }

    console.log('');
    console.log('summary (before=surreal, after=sqlite):');
    for (const r of results) {
        console.log(`  ${r.engine.padEnd(8)} n=${String(r.n).padEnd(7)} build=${String(r.buildMs).padEnd(7)}ms p50=${r.p50.toFixed(3).padEnd(8)}ms p95=${r.p95.toFixed(3)}ms`);
    }

    // queryEdges full-walk cost, now that it carries an ORDER BY on both
    // engines (3.21 step 1c) — see this file's header.
    const edgeN = Number(process.env['LORE_GRAPH_LATENCY_EDGE_N'] ?? 5000);
    console.log('');
    console.log(`queryEdges full-pagination-walk (1000-row pages, ${edgeN - 1} edges, ORDER BY source/target/relation):`);
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-latency-edges-sqlite-'));
        const g = new SqliteGraph(dir, { workspaceId: 'edge-latency', cacheDisabled: true });
        await g.initialize();
        try {
            await seedChainSqlite(g, edgeN);
            const ms = await walkAllEdgesMs(g, edgeN - 1);
            console.log(`  sqlite  edges=${edgeN - 1}  walk=${ms}ms`);
        } finally {
            await g.close().catch(() => undefined);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    if (!skipSurreal) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-latency-edges-surreal-'));
        const g = new SurrealGraph(dir, { workspaceId: 'edge-latency', cacheDisabled: true });
        await g.initialize();
        try {
            const t0 = Date.now();
            await seedChainSurreal(g, edgeN);
            const buildMs = Date.now() - t0;
            const ms = await walkAllEdgesMs(g, edgeN - 1);
            console.log(`  surreal edges=${edgeN - 1}  build=${buildMs}ms  walk=${ms}ms`);
        } finally {
            await g.close().catch(() => undefined);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    console.log('');
    console.log(`latency: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
