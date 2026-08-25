#!/usr/bin/env tsx
/**
 * Q1.9 — Semantic-zoom overview aggregation integration test.
 *
 * Verifies getTopologyOverview() on SurrealGraph:
 *   - blobs = { project, nodeCount } grouped by project
 *   - aggregateEdges = cross-project edge counts only
 *   - intra-project edges are NOT counted in aggregateEdges
 *   - NULL / empty project folds into 'Global'
 *   - totalNodes matches the sum of blob nodeCounts
 *
 * Airplane-safe: all reads go through the embedded SurrealDB engine via
 * SurrealGraph; no network, no plugin hook involvement.
 */
import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.ts';

const workspace = join(tmpdir(), `lore-q1-9-overview-${randomUUID()}`);
if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });

const graph = new SurrealGraph(workspace, { workspaceId: 'q1-9' });
await graph.initialize();

// Three project clusters: "alpha" (3 nodes), "beta" (2 nodes), "" → Global (1).
const mk = async (id: string, project: string) => {
    await graph.upsertNode({
        id, type: 'note', label: id, content: '',
        tags: '', project, ecosystem: 'test', metadata: '{}',
    });
};
await mk('a1', 'alpha');
await mk('a2', 'alpha');
await mk('a3', 'alpha');
await mk('b1', 'beta');
await mk('b2', 'beta');
await mk('g1', ''); // falls into Global

// Edges:
//   intra-project (alpha → alpha): must NOT appear in aggregateEdges
//   cross-project (alpha → beta)  × 2: should coalesce to count=2
//   cross-project (beta  → alpha) × 1: separate directional bundle
//   cross-project (alpha → Global) × 1
await graph.addEdge({ sourceId: 'a1', targetId: 'a2', relation: 'related_to' });
await graph.addEdge({ sourceId: 'a1', targetId: 'b1', relation: 'related_to' });
await graph.addEdge({ sourceId: 'a2', targetId: 'b2', relation: 'related_to' });
await graph.addEdge({ sourceId: 'b1', targetId: 'a3', relation: 'related_to' });
await graph.addEdge({ sourceId: 'a3', targetId: 'g1', relation: 'related_to' });

const overview = await graph.getTopologyOverview();

// ── Blobs ──
assert.strictEqual(overview.totalNodes, 6, 'totalNodes should equal node count');
const byProject = new Map(overview.blobs.map((b) => [b.project, b.nodeCount]));
assert.strictEqual(byProject.get('alpha'), 3, 'alpha should have 3 nodes');
assert.strictEqual(byProject.get('beta'), 2, 'beta should have 2 nodes');
assert.strictEqual(byProject.get('Global'), 1, 'empty project should fold to Global');
assert.strictEqual(overview.blobs.length, 3, 'expected exactly 3 blobs');

// Sorted descending by nodeCount (alpha first).
assert.strictEqual(overview.blobs[0].project, 'alpha');

// ── Aggregate edges ──
const key = (e: { fromProject: string; toProject: string }) => `${e.fromProject}→${e.toProject}`;
const edgesByKey = new Map(overview.aggregateEdges.map((e) => [key(e), e.count]));

// intra-project alpha→alpha must not appear
assert.ok(!edgesByKey.has('alpha→alpha'), 'intra-project edges must be excluded');

// cross-project counts
assert.strictEqual(edgesByKey.get('alpha→beta'), 2, 'alpha→beta should count 2');
assert.strictEqual(edgesByKey.get('beta→alpha'), 1, 'beta→alpha should count 1 (directional)');
assert.strictEqual(edgesByKey.get('alpha→Global'), 1, 'alpha→Global should count 1');

assert.strictEqual(overview.aggregateEdges.length, 3, 'expected 3 distinct cross-project bundles');

console.log('Q1.9 overview test: OK');
console.log(`  blobs:          ${overview.blobs.length} (alpha=${byProject.get('alpha')}, beta=${byProject.get('beta')}, Global=${byProject.get('Global')})`);
console.log(`  aggregateEdges: ${overview.aggregateEdges.length} cross-project bundles`);
console.log(`  totalNodes:     ${overview.totalNodes}`);

// Cleanup
rmSync(workspace, { recursive: true, force: true });
process.exit(0);
