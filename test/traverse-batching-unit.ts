#!/usr/bin/env tsx
/**
 * traverse-batching-unit.ts — `traverse` batches the BFS frontier, and must
 * return exactly what the per-node walk returned.
 *
 * Why the change exists: the original Kùzu engine issued TWO prepared-
 * statement executions per frontier NODE per depth, while the SurrealDB
 * engine issued one query per DEPTH for the whole frontier. Batching closed
 * that gap; both engines now walk the frontier in 256-wide chunks, so the
 * chunking itself is part of the shared LoreGraphHandle contract this file
 * pins (the observable shape — set, depths, via, direction, order — not the
 * engine that executes it).
 *
 * Why these tests: batching moves rows out of frontier order, so the code
 * regroups them by originating node. Three things can silently break — the
 * result SET, the depth labels, and the sub-ORDER — and only the third is
 * invisible to a casual check. The cross-engine parity suite would catch a
 * sub-order break too, but it runs a small fixture; these exercise the
 * boundaries the batching logic actually branches on:
 *
 *   - frontier <= SMALL_FRONTIER (8)   → width-1 path, inline `{id: $id}` match
 *   - frontier >  SMALL_FRONTIER       → chunked `IN [...]` path
 *   - frontier >  TRAVERSE_CHUNK_SIZE  → MULTIPLE chunks, where a regrouping
 *                                        bug would drop or duplicate rows
 *
 * Run: npx tsx test/traverse-batching-unit.ts
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p7-trav-'));
const g = new SurrealGraph(dir, { workspaceId: 'w', cacheDisabled: true });
await g.initialize();

/**
 * A hub with 300 direct neighbours — deliberately past the 256 chunk width, so
 * depth 2 fans out across MULTIPLE chunks. Each neighbour has one child, giving
 * a depth-3 layer reachable only through the chunked hop.
 */
const FANOUT = 300;
await g.upsertNode(node('hub'));
for (let i = 0; i < FANOUT; i++) {
    const mid = `mid-${String(i).padStart(4, '0')}`;
    const leaf = `leaf-${String(i).padStart(4, '0')}`;
    await g.upsertNode(node(mid));
    await g.upsertNode(node(leaf));
    await g.addEdge({ sourceId: 'hub', targetId: mid, relation: 'refers_to' });
    await g.addEdge({ sourceId: mid, targetId: leaf, relation: 'refers_to' });
}
// A small separate component to exercise the width-1 (small-frontier) path.
for (const [a, b] of [['s0', 's1'], ['s1', 's2'], ['s2', 's3']]) {
    for (const id of [a!, b!]) await g.upsertNode(node(id));
    await g.addEdge({ sourceId: a!, targetId: b!, relation: 'refers_to' });
}

console.log(`Phase 7 — traverse frontier batching (fanout ${FANOUT}, chunk width 256)`);

await test('small frontier: a linear chain returns the right nodes at the right depths', async () => {
    // Frontier is 1-2 nodes throughout, so this only ever takes the width-1 path.
    const r = await g.traverse('s0', 3);
    assert.deepEqual(r.map((x) => x.node.id), ['s1', 's2', 's3'], 'set AND order');
    assert.deepEqual(r.map((x) => x.depth), [1, 2, 3], 'depth labels follow hop distance');
});

await test('frontier LARGER than one chunk: every node is found exactly once', async () => {
    // depth 2 walks a 300-node frontier => 2 chunks (256 + 44). A regrouping
    // bug here drops the second chunk or double-counts the first, and either
    // shows up as a wrong count rather than a wrong-looking result.
    const r = await g.traverse('hub', 2);
    const ids = r.map((x) => x.node.id);
    assert.equal(ids.length, new Set(ids).size, 'no duplicates across chunk boundaries');
    assert.equal(r.filter((x) => x.depth === 1).length, FANOUT, 'all 300 mids at depth 1');
    assert.equal(r.filter((x) => x.depth === 2).length, FANOUT, 'all 300 leaves at depth 2');
});

await test('nodes straddling the chunk boundary are present, not silently dropped', async () => {
    // The specific rows a slice-off-by-one loses: the last of chunk 1 and the
    // first of chunk 2.
    const r = await g.traverse('hub', 2);
    const ids = new Set(r.map((x) => x.node.id));
    for (const i of [0, 255, 256, 299]) {
        assert.ok(ids.has(`mid-${String(i).padStart(4, '0')}`), `mid-${i} present`);
        assert.ok(ids.has(`leaf-${String(i).padStart(4, '0')}`), `leaf-${i} present`);
    }
});

await test('depth ordering holds: every depth-1 result precedes every depth-2 result', async () => {
    const r = await g.traverse('hub', 2);
    const firstDepth2 = r.findIndex((x) => x.depth === 2);
    assert.ok(firstDepth2 > 0, 'there is a depth-2 section');
    assert.ok(r.slice(0, firstDepth2).every((x) => x.depth === 1), 'no depth-2 leaks into the depth-1 run');
    assert.ok(r.slice(firstDepth2).every((x) => x.depth >= 2), 'and none go back');
});

await test('sub-order is deterministic across repeated calls', async () => {
    // The batched path regroups rows by originating frontier node. If that
    // regrouping ever became map-iteration-order dependent, this is what fails
    // — and cross-engine parity would start flapping rather than failing.
    const a = (await g.traverse('hub', 2)).map((x) => x.node.id).join('|');
    const b = (await g.traverse('hub', 2)).map((x) => x.node.id).join('|');
    assert.equal(b, a);
});

await test('traversal is undirected: an inbound-only neighbour is still reached', async () => {
    // Both directions are fetched and merged; a batching change that kept only
    // the outgoing statement would pass every test above.
    await g.upsertNode(node('parent-of-hub'));
    await g.addEdge({ sourceId: 'parent-of-hub', targetId: 'hub', relation: 'refers_to' });
    const ids = (await g.traverse('hub', 1)).map((x) => x.node.id);
    assert.ok(ids.includes('parent-of-hub'), 'inbound edge traversed');
    assert.equal(ids.length, FANOUT + 1, 'and outbound still all there');
});

/* ─── traverseDirected takes the SAME batched path ───────────────── */
//
// It was written against the older per-node shape and measured 7.9x slower
// than the batched `traverse` at depth 5 on the 19,237-node corpus
// (22,841 ms vs 2,944 ms). Now batched identically. Batching a DIRECTED walk
// has one extra way to go wrong that the undirected tests above cannot catch:
// the two direction legs are fetched as separate grouped maps and replayed
// per frontier node, so a regrouping bug can attach a row to the wrong origin
// — which shows up as a wrong `via`, or as a direction flip, not as a wrong
// node set.

await test('directed: frontier past one chunk finds every node exactly once', async () => {
    const r = await g.traverseDirected('hub', 2);
    const ids = r.map((x) => x.node.id);
    assert.equal(ids.length, new Set(ids).size, 'no duplicates across chunk boundaries');
    assert.equal(r.filter((x) => x.depth === 1).length, FANOUT + 1, 'all mids plus the inbound parent');
    assert.equal(r.filter((x) => x.depth === 2).length, FANOUT, 'all leaves at depth 2');
});

await test('directed: `via` survives batching — every step names its true origin', async () => {
    // The regrouping bug this catches: rows returned for the whole frontier in
    // one query, then attributed to the wrong frontier node. Depth-2 leaves
    // must each be reached via their OWN mid, not an arbitrary one.
    const r = await g.traverseDirected('hub', 2);
    for (const step of r.filter((x) => x.depth === 2)) {
        const n = step.node.id.replace('leaf-', '');
        assert.equal(step.via, `mid-${n}`, `${step.node.id} must be reached via mid-${n}, got ${step.via}`);
    }
    for (const step of r.filter((x) => x.depth === 1 && x.node.id.startsWith('mid-'))) {
        assert.equal(step.via, 'hub', 'depth-1 mids are reached from the seed');
    }
});

await test('directed: direction survives batching in BOTH legs', async () => {
    // hub->mid-* are outgoing; parent-of-hub->hub is incoming. Both legs are
    // fetched by separate batched queries, so both need checking.
    const r = await g.traverseDirected('hub', 1);
    const mid = r.find((x) => x.node.id === 'mid-0000');
    const parent = r.find((x) => x.node.id === 'parent-of-hub');
    assert.ok(mid && parent, 'both legs represented');
    assert.equal(mid!.direction, 'out', 'hub->mid is outgoing');
    assert.equal(parent!.direction, 'in', 'parent-of-hub->hub is incoming');
});

await test('directed: nodes straddling the chunk boundary keep id, via AND direction', async () => {
    const r = await g.traverseDirected('hub', 2);
    const byId = new Map(r.map((x) => [x.node.id, x]));
    for (const i of [0, 255, 256, 299]) {
        const pad = String(i).padStart(4, '0');
        const m = byId.get(`mid-${pad}`);
        const l = byId.get(`leaf-${pad}`);
        assert.ok(m && l, `mid-${pad} and leaf-${pad} present`);
        assert.equal(m!.direction, 'out', `mid-${pad} outgoing from hub`);
        assert.equal(l!.via, `mid-${pad}`, `leaf-${pad} via its own mid`);
    }
});

await test('directed: repeated calls are byte-identical', async () => {
    const key = (r: Awaited<ReturnType<typeof g.traverseDirected>>): string =>
        r.map((x) => `${x.via}-[${x.relation}:${x.direction}]->${x.node.id}@${x.depth}`).join('|');
    assert.equal(key(await g.traverseDirected('hub', 2)), key(await g.traverseDirected('hub', 2)));
});

await g.close().catch(() => undefined);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
