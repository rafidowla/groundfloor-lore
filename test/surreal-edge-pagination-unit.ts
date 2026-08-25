#!/usr/bin/env tsx
/**
 * surreal-edge-pagination-unit.ts — `queryEdges` paginates without an ORDER BY,
 * and must still return every edge exactly once.
 *
 * The SurrealDB implementation used to append `ORDER BY relation ASC`. That is
 * not in the `EdgeQuery` contract, and `LocalGraph`'s Cypher has no ORDER BY
 * either — so it was a gratuitous full sort of every matching edge, repeated on
 * EVERY page. Enumerating 51,934 edges in 1,000-row pages spent ~150 ms per
 * page re-sorting the same rows: 9,227 ms total, against 469 ms without it.
 * That single sort was most of the reason a SurrealDB-backed workspace looked
 * 10× slower than Kùzu for Atlas, whose every graph surface enumerates all
 * edges.
 *
 * Removing a sort from a paginated query is exactly the change that silently
 * drops or duplicates rows, so completeness is asserted here rather than
 * assumed. SurrealDB returns record-id order, which is stable across pages —
 * these tests are what pins that.
 *
 * Run: npx tsx test/surreal-edge-pagination-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id, type: 'decision', label: `L ${id}`, content: `C ${id}`,
        tags: ['t'], project: 'p', ecosystem: 'e', metadata: '{}',
    };
}

const NODES = 120;
const PAGE = 25;
const RELATIONS = ['refers_to', 'calls', 'imports'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p7-edgepage-'));
const g = new SurrealGraph(dir, { cacheDisabled: true });
await g.initialize();

for (let i = 0; i < NODES; i++) await g.upsertNode(node(`n${String(i).padStart(4, '0')}`));
// A ring plus a chord, so every node has degree >= 2 and relations interleave —
// if pagination were relation-ordered, page boundaries would fall differently.
const expected = new Set<string>();
for (let i = 0; i < NODES; i++) {
    for (const [j, rel] of [[(i + 1) % NODES, RELATIONS[i % 3]!], [(i + 7) % NODES, RELATIONS[(i + 1) % 3]!]] as const) {
        const src = `n${String(i).padStart(4, '0')}`;
        const tgt = `n${String(j).padStart(4, '0')}`;
        await g.addEdge({ sourceId: src, targetId: tgt, relation: rel });
        expected.add(`${src}|${tgt}|${rel}`);
    }
}

console.log(`Phase 7 — SurrealDB edge pagination without ORDER BY (${expected.size} edges, page ${PAGE})`);

/** Walk every page the way `readAllEdges` and Atlas's `listEdges()` do. */
async function walkAll(): Promise<string[]> {
    const seen: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
        const page = await g.queryEdges({ limit: PAGE, offset });
        for (const e of page) seen.push(`${e.sourceId}|${e.targetId}|${e.relation}`);
        if (page.length < PAGE) break;
    }
    return seen;
}

await test('full pagination returns every edge exactly once', async () => {
    const seen = await walkAll();
    assert.equal(seen.length, expected.size, 'no rows lost or repeated across page boundaries');
    assert.equal(new Set(seen).size, expected.size, 'no duplicates');
    assert.deepEqual(new Set(seen), expected, 'the exact edge set');
});

await test('page order is STABLE across repeated walks', async () => {
    // Without an ORDER BY, coherent pagination depends on the engine returning
    // a stable order. If that ever stopped being true, pages would overlap and
    // the test above would fail intermittently rather than outright — so pin it.
    const a = (await walkAll()).join(',');
    const b = (await walkAll()).join(',');
    assert.equal(b, a);
});

await test('pages do not overlap: consecutive pages are disjoint', async () => {
    const p0 = await g.queryEdges({ limit: PAGE, offset: 0 });
    const p1 = await g.queryEdges({ limit: PAGE, offset: PAGE });
    const k = (e: { sourceId: string; targetId: string; relation: string }) => `${e.sourceId}|${e.targetId}|${e.relation}`;
    const s0 = new Set(p0.map(k));
    assert.equal(p1.filter((e) => s0.has(k(e))).length, 0, 'page 2 must not repeat page 1');
});

await test('an offset past the end returns empty, not a wrapped page', async () => {
    assert.deepEqual(await g.queryEdges({ limit: PAGE, offset: expected.size + PAGE }), []);
});

await test('filters still work and still paginate', async () => {
    // The WHERE clause survived the ORDER BY removal — a filtered walk must
    // return exactly the edges of that relation, once each.
    const rel = RELATIONS[0]!;
    const want = [...expected].filter((e) => e.endsWith(`|${rel}`));
    const got: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
        const page = await g.queryEdges({ limit: PAGE, offset, relation: rel });
        for (const e of page) got.push(`${e.sourceId}|${e.targetId}|${e.relation}`);
        if (page.length < PAGE) break;
    }
    assert.equal(got.length, want.length, `every ${rel} edge, once`);
    assert.deepEqual(new Set(got), new Set(want));
});

await test('a source-filtered query returns that node\'s outgoing edges only', async () => {
    const src = 'n0000';
    const page = await g.queryEdges({ limit: 100, offset: 0, source: src });
    assert.ok(page.length >= 2, 'the ring plus chord give at least two');
    assert.ok(page.every((e) => e.sourceId === src), 'no foreign sources leaked in');
});

await g.close().catch(() => undefined);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
