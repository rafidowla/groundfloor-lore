#!/usr/bin/env tsx
/**
 * sw17-topology-cap-unit.ts — SW-17 regression: topology overview caps.
 *
 * Originally this drove `computeTopologyOverviewByType` (engines/
 * graphTopology.ts) through a stubbed Kùzu WithConnection and asserted its
 * Cypher LIMIT clauses. That half died with graphTopology.ts and the engine
 * (Kùzu removal Phase 3d, 2026-08-21). What the caps MEAN — `truncated` is
 * computed from the node cap, blobs/edges fold correctly — lives in the
 * engine-agnostic `foldTopologyOverview` (engines/topologyOverviewFold.ts)
 * and is what this file pins now, against plain rows.
 */

import assert from 'node:assert/strict';
import {
    TOPOLOGY_OVERVIEW_NODE_CAP,
    TOPOLOGY_OVERVIEW_EDGE_CAP,
    foldTopologyOverview,
    type GroupCountRow,
    type GroupTypeCountRow,
    type EdgePairRow,
} from '../packages/lore/src/engines/topologyOverviewFold.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/* ── A. Constants sanity — confirm we're testing against the real values ── */

test('A1: TOPOLOGY_OVERVIEW_NODE_CAP is 50000', () => {
    assert.equal(TOPOLOGY_OVERVIEW_NODE_CAP, 50_000);
});

test('A2: TOPOLOGY_OVERVIEW_EDGE_CAP is 200000', () => {
    assert.equal(TOPOLOGY_OVERVIEW_EDGE_CAP, 200_000);
});

/* ── C. truncated flag set when node rows equal the cap ── */

test('C1: truncated=true when the node scan returns exactly NODE_CAP rows', () => {
    const blobRows: GroupCountRow[] = Array.from({ length: TOPOLOGY_OVERVIEW_NODE_CAP }, () => ({
        group: 'g',
        count: 1,
    }));
    const result = foldTopologyOverview(blobRows, [], []);
    assert.equal(result.truncated, true, 'truncated must be true when the node scan hits the cap');
});

test('C2: truncated absent/undefined when node rows are under the cap', () => {
    const blobRows: GroupCountRow[] = [
        { group: 'decision', count: 5 },
        { group: 'bug_pattern', count: 3 },
        { group: 'architecture', count: 1 },
    ];
    const result = foldTopologyOverview(blobRows, [], []);
    assert.ok(
        result.truncated === undefined || result.truncated === false,
        `truncated must be absent/false for a small graph; got ${result.truncated}`,
    );
});

/* ── D. Correctness: result shape is correct on a normal (under-cap) graph ── */

test('D1: blobs are built from node rows, sorted descending by nodeCount', () => {
    const blobRows: GroupCountRow[] = [
        { group: 'decision', count: 10 },
        { group: 'architecture', count: 5 },
    ];
    const typeRows: GroupTypeCountRow[] = [
        { group: 'decision', type: 'decision', count: 10 },
        { group: 'architecture', type: 'architecture', count: 5 },
    ];
    const edgeRows: EdgePairRow[] = [
        { from: 'decision', to: 'architecture' },
        { from: 'architecture', to: 'decision' },
    ];
    const result = foldTopologyOverview(blobRows, typeRows, edgeRows);

    assert.equal(result.blobs.length, 2);
    assert.equal(result.blobs[0].project, 'decision');
    assert.equal(result.blobs[0].nodeCount, 10);
    assert.equal(result.blobs[1].project, 'architecture');
    assert.equal(result.blobs[1].nodeCount, 5);
    assert.equal(result.totalNodes, 15);
});

test('D2: aggregateEdges built from edge rows; intra-group edges excluded', () => {
    const blobRows: GroupCountRow[] = [{ group: 'decision', count: 1 }];
    const edgeRows: EdgePairRow[] = [
        { from: 'decision', to: 'convention' },
        { from: 'decision', to: 'convention' },
        { from: 'convention', to: 'decision' },
        { from: 'decision', to: 'decision' },
    ];
    const result = foldTopologyOverview(blobRows, [], edgeRows);

    assert.equal(result.aggregateEdges.length, 2);
    const dec2conv = result.aggregateEdges.find(e => e.fromProject === 'decision' && e.toProject === 'convention');
    assert.ok(dec2conv, 'decision→convention edge should exist');
    assert.equal(dec2conv!.count, 2);
});

/* ── E. Large-graph bounded: cap boundary detected, truncated reported ── */

test('E1: a node scan at the cap boundary is reported truncated with the true row count', () => {
    const BIG = TOPOLOGY_OVERVIEW_NODE_CAP;
    const blobRows: GroupCountRow[] = Array.from({ length: BIG }, (_, i) => ({
        group: `type${i}`,
        count: 1,
    }));
    const result = foldTopologyOverview(blobRows, [], []);
    assert.equal(result.truncated, true, 'truncated must be true at cap boundary');
    assert.equal(result.totalNodes, BIG, 'totalNodes should equal row count');
});

/* ── runner ── */

console.log('\n=== SW-17 foldTopologyOverview cap regression ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
