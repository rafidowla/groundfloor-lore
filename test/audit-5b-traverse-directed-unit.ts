#!/usr/bin/env tsx
/**
 * audit-5b-traverse-directed-unit.ts — regression for the Cluster-5 medium
 * finding (2026-08-17 functional-correctness audit):
 *
 *   traverseDirected returned at most ONE edge per reached node, so the
 *   "rebuild a directed subgraph" contract (providers/types.ts) was silently
 *   incomplete whenever a node had multiple incoming edges within the walk
 *   (measured ~57% of edges missing on the audit corpus).
 * Fix: engines/surreal/surrealGraphDirected.ts now emits every distinct
 * (via, direction, relation, target) edge; the visited set only gates
 * frontier EXPANSION. This test pins the absolute behavior through the
 * real SurrealGraph.traverseDirected entry point.
 *
 * Run: npx tsx test/audit-5b-traverse-directed-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id, type: 'decision', label: `L ${id}`, content: `C ${id}`,
        tags: ['t'], project: 'p', ecosystem: 'e', metadata: '{}',
    };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit5b-trav-'));
const g = new SurrealGraph(dir, { workspaceId: 'w', cacheDisabled: true });
await g.initialize();

// Diamond: S→A, S→B, A→X, B→X — X is reachable via TWO distinct edges.
// Plus a parallel-relation pair: A→X (calls) AND A→X (imports).
for (const id of ['S', 'A', 'B', 'X']) await g.upsertNode(node(id));
await g.addEdge({ sourceId: 'S', targetId: 'A', relation: 'refers_to' });
await g.addEdge({ sourceId: 'S', targetId: 'B', relation: 'refers_to' });
await g.addEdge({ sourceId: 'A', targetId: 'X', relation: 'calls' });
await g.addEdge({ sourceId: 'B', targetId: 'X', relation: 'calls' });
await g.addEdge({ sourceId: 'A', targetId: 'X', relation: 'imports' });

console.log('Audit cluster 5 — traverseDirected emits every directed edge');

await test('a node reached via two incoming edges contributes BOTH edges', async () => {
    const rows = await g.traverseDirected('S', 2);
    const keys = rows.map((r) => `${r.via}-[${r.relation}:${r.direction}]->${r.node.id}`).sort();
    assert.deepEqual(keys, [
        'A-[calls:out]->X',
        'A-[imports:out]->X',
        'B-[calls:out]->X',
        'S-[refers_to:out]->A',
        'S-[refers_to:out]->B',
    ]);
});

await test('no duplicate rows for the exact same edge triple', async () => {
    const rows = await g.traverseDirected('S', 3);
    const keys = rows.map((r) => `${r.via}|${r.direction}|${r.relation}|${r.node.id}`);
    assert.equal(new Set(keys).size, keys.length, 'every emitted row is a distinct edge');
});

await test('the seed is never returned, even when an edge points back at it', async () => {
    await g.upsertNode(node('Y'));
    await g.addEdge({ sourceId: 'X', targetId: 'S', relation: 'refers_to' });
    const rows = await g.traverseDirected('S', 3);
    assert.ok(rows.every((r) => r.node.id !== 'S'), 'seed must not appear as a result node');
    // ...but the walk still expands through X's other edges.
});

await g.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
