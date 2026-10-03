#!/usr/bin/env tsx
/**
 * cloud-traverse-scope-unit.ts — cloud parity A2 item 9.
 *
 * The engine's graph traverse accepts NO filter (design F6) and returns whatever
 * vertices the BFS reaches, so scope is enforced client-side on EVERY returned vertex.
 * Two Lore workspaces share one Dataplane workspace; a buggy writer (or a hand-made
 * edge) could link a W1 vertex to a W2 vertex. The adapter must never return the W2
 * vertex, must not surface anything reachable only THROUGH it, and a W1 start id used
 * from W2 must return nothing. Also confirms the vector-search push-down.
 */

import assert from 'node:assert/strict';
import { startCloudFixture, DP_KEY, DP_WORKSPACE, ORG_ID, type CloudFixture, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { dataplaneRowKey } from '../packages/lore/src/engines/dataplaneScopeFilter.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'lore-ws-one';
const W2 = 'lore-ws-two';
const scope = (ws: string) => ({ orgId: ORG_ID, loreWorkspace: ws, dataplaneWorkspaceId: DP_WORKSPACE });
const node = (id: string, label = id) => ({ id, type: 'note', label, content: `content ${id}`, tags: [], project: 'p', ecosystem: 'e', metadata: '{}' });

async function injectForeignEdge(fx: CloudFixture, fromWs: string, from: string, toWs: string, to: string, relation: string): Promise<void> {
    // Simulates a buggy writer: a graph edge whose endpoints live in different Lore workspaces.
    const raw = connectedClient(fx.mock.url, DP_KEY);
    await raw.graph.createEdge(DP_WORKSPACE, 'knowledge_graph', {
        fromId: `lore_node/${dataplaneRowKey(scope(fromWs), from)}`,
        toId: `lore_node/${dataplaneRowKey(scope(toWs), to)}`,
        edgeCollection: 'lore_edge',
        properties: { relation },
    });
}

const ids = (rs: Array<{ node: { id: string } }>): string[] => rs.map((r) => r.node.id).sort();

console.log('cloud traverse scope');
const fx = await startCloudFixture();
try {
    await fx.as(W1, async () => {
        for (const id of ['A', 'B', 'C', 'D', 'w1-only']) await fx.graph.upsertNode(node(id) as never);
        await fx.graph.addEdge({ sourceId: 'A', targetId: 'B', relation: 'links' });
        await fx.graph.addEdge({ sourceId: 'B', targetId: 'C', relation: 'links' });
        await fx.graph.addEdge({ sourceId: 'B', targetId: 'D', relation: 'blocks' });
    });
    await fx.as(W2, async () => {
        for (const id of ['A', 'B', 'X', 'Y']) await fx.graph.upsertNode(node(id, `w2-${id}`) as never);
        await fx.graph.addEdge({ sourceId: 'X', targetId: 'Y', relation: 'links' });
    });

    await test('baseline: W1 traverse follows W1 edges only, with depth', async () => {
        const r = await fx.as(W1, () => fx.graph.traverse('A', 3));
        assert.deepEqual(ids(r), ['B', 'C', 'D']);
        assert.equal(r.find((x) => x.node.id === 'B')!.depth, 1);
        assert.equal(r.find((x) => x.node.id === 'C')!.depth, 2);
        assert.ok(r.every((x) => x.node.label.startsWith('w2-') === false));
    });

    await test('same logical start id in W2 traverses W2 (which has no such edges) -> nothing from W1', async () => {
        const r = await fx.as(W2, () => fx.graph.traverse('A', 3));
        assert.deepEqual(r, []);
        const r2 = await fx.as(W2, () => fx.graph.traverse('B', 3));
        assert.deepEqual(r2, []);
    });

    await test('a W1 start id that only exists in W1, queried from W2, returns nothing', async () => {
        assert.deepEqual(await fx.as(W2, () => fx.graph.traverse('w1-only', 3)), []);
        assert.deepEqual(await fx.as(W2, () => fx.graph.traverse('C', 3)), []);
    });

    await test('relation filter still works and stays scoped', async () => {
        const r = await fx.as(W1, () => fx.graph.traverse('B', 2, 'blocks'));
        assert.deepEqual(ids(r), ['D']);
    });

    await test('injected cross-workspace edge W1.B -> W2.X: the W2 vertex is never returned to W1', async () => {
        await injectForeignEdge(fx, W1, 'B', W2, 'X', 'links');
        const r = await fx.as(W1, () => fx.graph.traverse('A', 4));
        assert.ok(!ids(r).includes('X'), 'W2 vertex X leaked');
        assert.ok(!ids(r).includes('Y'), 'W2 vertex Y (behind X) leaked');
        assert.ok(r.every((x) => x.node.label.indexOf('w2-') !== 0));
        // In-scope siblings at or above the rejected vertex depth survive.
        assert.deepEqual(ids(r), ['B', 'C', 'D']);
    });

    await test('injected edge from W2 into W1: W2 traversal never returns W1 vertices', async () => {
        await injectForeignEdge(fx, W2, 'Y', W1, 'w1-only', 'links');
        const r = await fx.as(W2, () => fx.graph.traverse('X', 4));
        assert.ok(!ids(r).includes('w1-only'), 'W1 vertex leaked into W2');
        assert.deepEqual(ids(r), ['Y']);
    });

    await test('a W1 vertex reachable only THROUGH a foreign vertex is cut (path dropped, fail closed)', async () => {
        // A -> B -> [W2.X] -> W1.tail : tail is W1's own data but the only route is via W2's vertex.
        await fx.as(W1, () => fx.graph.upsertNode(node('tail') as never));
        await injectForeignEdge(fx, W2, 'X', W1, 'tail', 'links');
        const r = await fx.as(W1, () => fx.graph.traverse('A', 5));
        // B->X is at depth 2; tail sits at depth 3 (> cut depth 2) -> dropped.
        assert.ok(!ids(r).includes('tail'), 'vertex beyond a foreign vertex must be dropped');
        assert.ok(!ids(r).includes('X'));
    });

    await test('missing Lore workspace fails closed', async () => {
        await assert.rejects(() => fx.graph.traverse('A', 2), /workspace/i);
    });

    await test('vector search pushes org + lore_workspace + single-valued type/project down, and still filters client-side', async () => {
        await fx.as(W1, () => fx.vector.store({ id: 'v1', text: 'hello apples', metadata: { type: 'note', project: 'p' } }));
        const before = fx.mock.requests.length;
        await fx.as(W1, () => fx.vector.search('apples', 5, { type: 'note', project: 'p' } as never));
        const req = fx.mock.requests.slice(before).find((r) => r.path.includes('vector/search'))!;
        const f = JSON.stringify(req.body['metadata_filter']);
        for (const needle of ['"org_id"', ORG_ID, '"lore_workspace"', W1, '"type"', '"note"', '"project"']) {
            assert.ok(f.includes(needle), `push-down filter missing ${needle}: ${f}`);
        }
        // Client predicate is unconditional: a store that IGNORES the filter must still not leak (covered
        // with vectorFilterMode:'ignore' in cloud-verbatim-scope-unit and cloud-isolation-e2e).
    });
} finally { await fx.close(); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
