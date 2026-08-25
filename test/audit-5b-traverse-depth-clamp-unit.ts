#!/usr/bin/env tsx
/**
 * audit-5b-traverse-depth-clamp-unit.ts — regression for the Cluster-5 low
 * finding (2026-08-17 functional-correctness audit):
 *
 *   MCP traverse answered the same question differently depending on
 *   whether `ecosystem` was passed: the engine traverse() paths clamp
 *   depth to 1..5 (surrealGraphReads.ts / localGraphReads.ts) but the
 *   scoped confinedTraverse path (engines/graphNeighbors.ts) did not —
 *   so depth 0 walked ZERO hops and reported a confident "this node is
 *   isolated", and depth > 5 was unclamped on that path alone.
 *
 * Fix: confinedTraverse clamps depth to 1..5, identical to the engines.
 *
 * Drives the REAL confinedTraverse (the tool's scoped path) with a fake
 * NeighborGraph, comparing against the clamped engine contract.
 *
 * Run: npx tsx test/audit-5b-traverse-depth-clamp-unit.ts
 */

import assert from 'node:assert/strict';

import { confinedTraverse } from '../packages/lore/src/engines/graphNeighbors.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function node(id: string): LoreNode {
    return {
        id, type: 'note', label: `L ${id}`, content: `C ${id}`,
        tags: ['t'], project: 'p', ecosystem: 'e', metadata: '{}',
        createdAt: '', updatedAt: '', syncedAt: '',
    };
}

/** A straight chain: n0 → n1 → … → n9. */
const NODES = new Map(Array.from({ length: 10 }, (_, i) => [`n${i}`, node(`n${i}`)]));
const EDGES: LoreEdge[] = Array.from({ length: 9 }, (_, i) => ({
    sourceId: `n${i}`, targetId: `n${i + 1}`, relation: 'refers_to',
}));

const fakeGraph = {
    async queryEdges(q: { source?: string; target?: string }) {
        return EDGES.filter((e) => e.sourceId === q.source || e.targetId === q.target);
    },
    async getNodesByIds(ids: string[]) {
        return new Map(ids.map((id) => [id, NODES.get(id)!]));
    },
};

console.log('Audit cluster 5 — confinedTraverse depth clamp matches engine traverse (1..5)');

await test('depth 0 is clamped UP to 1 (was: zero-hop walk reported the node isolated)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hops = await confinedTraverse(fakeGraph as any, 'n0', 0, 'e');
    assert.ok(hops.length > 0, 'depth 0 must not produce an empty "isolated" walk on a connected node');
    assert.deepEqual(hops.map((h) => h.node.id), ['n1']);
    assert.ok(hops.every((h) => h.depth <= 1));
});

await test('depth 9 is clamped DOWN to 5 (was: unclamped on the scoped path)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hops = await confinedTraverse(fakeGraph as any, 'n0', 9, 'e');
    assert.equal(hops.length, 5, 'a 10-node chain at clamped depth 5 reaches exactly 5 hops');
    assert.ok(hops.every((h) => h.depth <= 5));
});

await test('in-range depth is unchanged', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hops = await confinedTraverse(fakeGraph as any, 'n0', 3, 'e');
    assert.equal(hops.length, 3);
    assert.deepEqual(hops.map((h) => h.depth), [1, 2, 3]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
