#!/usr/bin/env tsx
/**
 * cloud-edge-dedup-unit.ts — cloud parity Slice B item 10: edge endpoint check, per-triple dedup,
 * stored confidence. Mirrors local sqliteGraphWrites.addEdge: both endpoints must exist IN THE
 * CALLER'S Lore workspace (edge_endpoint_missing), a repeated (source, relation, target) is one
 * row whose confidence is refreshed, defaults are extracted / 1.0, and queryEdges returns the
 * stored confidence instead of a hardcoded default.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { dataplaneRowKey } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { readEdge } from '../packages/lore/src/mcp/http/routes/bulkEdgeRollback.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'edge-ws-one';
const W2 = 'edge-ws-two';
const DP = 'dp-ws-fixture';

console.log('cloud parity B item 10: edge dedup + confidence');

const fx = await startCloudFixture();
const node = (id: string) => ({ id, type: 'note', label: id, content: id });
const edgeRows = () => fx.mock.rows(DP, 'lore_edge');
const graphEdgeCalls = () => fx.mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/graph/edge')).length;

try {
    await fx.as(W1, async () => { await fx.graph.upsertNode(node('a') as never); await fx.graph.upsertNode(node('b') as never); });
    await fx.as(W2, async () => { await fx.graph.upsertNode(node('x') as never); });

    await test('a missing source or target throws edge_endpoint_missing and writes nothing', async () => {
        const before = graphEdgeCalls();
        await assert.rejects(() => fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'ghost', relation: 'rel' })), /edge_endpoint_missing.*target 'ghost'/);
        await assert.rejects(() => fx.as(W1, () => fx.graph.addEdge({ sourceId: 'ghost', targetId: 'b', relation: 'rel' })), /edge_endpoint_missing.*source 'ghost'/);
        assert.equal(edgeRows().length, 0);
        assert.equal(graphEdgeCalls(), before);
    });

    await test('an endpoint that only exists in another Lore workspace does not count', async () => {
        await assert.rejects(() => fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'x', relation: 'rel' })), /edge_endpoint_missing/);
        assert.equal(edgeRows().length, 0);
    });

    await test('defaults are extracted / 1.0 and stored on the row', async () => {
        await fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel' }));
        const rows = edgeRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!['confidence'], 'extracted');
        assert.equal(rows[0]!['confidence_score'], 1.0);
        const q = await fx.as(W1, () => fx.graph.queryEdges({ limit: 10, offset: 0 } as never));
        assert.deepEqual(q, [{ sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'extracted', confidenceScore: 1 }]);
    });

    await test('a repeated triple is one row and creates the graph edge once', async () => {
        const before = graphEdgeCalls();
        await fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel' }));
        await fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel' }));
        assert.equal(edgeRows().length, 1);
        assert.equal(graphEdgeCalls(), before);
    });

    await test('a repeat with a different confidence refreshes it (local ON CONFLICT DO UPDATE)', async () => {
        await fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'inferred', confidenceScore: 0.4 }));
        assert.equal(edgeRows().length, 1);
        const q = await fx.as(W1, () => fx.graph.queryEdges({ limit: 10, offset: 0 } as never));
        assert.equal(q[0]!.confidence, 'inferred');
        assert.equal(q[0]!.confidenceScore, 0.4);
    });

    await test('the same triple in another Lore workspace is a separate row', async () => {
        await fx.as(W2, () => fx.graph.upsertNode(node('a') as never));
        await fx.as(W2, () => fx.graph.upsertNode(node('b') as never));
        await fx.as(W2, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'ambiguous', confidenceScore: 0.1 }));
        assert.equal(edgeRows().length, 2);
        const q1 = await fx.as(W1, () => fx.graph.queryEdges({ limit: 10, offset: 0 } as never));
        assert.equal(q1.length, 1);
        assert.equal(q1[0]!.confidence, 'inferred');
        const q2 = await fx.as(W2, () => fx.graph.queryEdges({ limit: 10, offset: 0 } as never));
        assert.equal(q2[0]!.confidence, 'ambiguous');
    });

    await test('addBidirectionalEdge carries the confidence onto both directions', async () => {
        await fx.as(W1, () => fx.graph.addBidirectionalEdge({ sourceId: 'a', targetId: 'b', relation: 'sibling', confidence: 'inferred', confidenceScore: 0.6 }));
        const q = await fx.as(W1, () => fx.graph.queryEdges({ relation: 'sibling', limit: 10, offset: 0 } as never));
        assert.equal(q.length, 2);
        for (const e of q) { assert.equal(e.confidence, 'inferred'); assert.equal(e.confidenceScore, 0.6); }
    });

    await test('legacy rows without a confidence column read back as extracted / 1.0', async () => {
        const res = await fetch(`${fx.mock.url}/v1/lore_edge`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-key', 'x-api-key': 'fixture-key' },
            body: JSON.stringify({ id: dataplaneRowKey({ orgId: 'org-fixture', loreWorkspace: W1 } as never, 'a__old__b'), org_id: 'org-fixture', lore_workspace: W1, lore_id: 'a__old__b', source_id: 'a', target_id: 'b', relation: 'old', connection: FIXTURE_CONNECTION }),
        });
        assert.ok(res.ok, `seed failed: ${res.status}`);
        const q = await fx.as(W1, () => fx.graph.queryEdges({ relation: 'old', limit: 10, offset: 0 } as never));
        assert.equal(q.length, 1);
        assert.equal(q[0]!.confidence, 'extracted');
        assert.equal(q[0]!.confidenceScore, 1);
    });

    await test('getEdge reads one triple by row key: exact direction, own Lore workspace, null when absent (3.26.0)', async () => {
        const g = fx.graph as unknown as { getEdge(s: string, t: string, r: string): Promise<unknown> };
        assert.deepEqual(await fx.as(W1, () => g.getEdge('a', 'b', 'rel')), { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'inferred', confidenceScore: 0.4 });
        assert.deepEqual(await fx.as(W2, () => g.getEdge('a', 'b', 'rel')), { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'ambiguous', confidenceScore: 0.1 });
        assert.equal(await fx.as(W1, () => g.getEdge('b', 'a', 'rel')), null, 'the reverse direction is a different row');
        assert.equal(await fx.as(W1, () => g.getEdge('a', 'b', 'nope')), null);
        assert.equal(await fx.as(W2, () => g.getEdge('a', 'b', 'sibling')), null, 'another workspace\'s edge is not visible');
    });

    await test('getEdge is a GET by row key, not a filtered query (a connector that ignores filters cannot hide the edge)', async () => {
        const g = fx.graph as unknown as { getEdge(s: string, t: string, r: string): Promise<unknown> };
        const before = fx.mock.requests.length;
        await fx.as(W1, () => g.getEdge('a', 'b', 'rel'));
        const made = fx.mock.requests.slice(before);
        assert.equal(made.length, 1, JSON.stringify(made.map((r) => `${r.method} ${r.path}`)));
        assert.equal(made[0]!.method, 'GET');
        assert.ok(made[0]!.path.includes(dataplaneRowKey({ orgId: 'org-fixture', loreWorkspace: W1 } as never, 'a__rel__b')), made[0]!.path);
    });

    await test('the bulk edge rollback reads a cloud prior through getEdge', async () => {
        const got = await fx.as(W1, () => readEdge(fx.graph as never, 'a', 'b', 'sibling'));
        assert.deepEqual(got, { sourceId: 'a', targetId: 'b', relation: 'sibling', confidence: 'inferred', confidenceScore: 0.6 });
        assert.equal(await fx.as(W1, () => readEdge(fx.graph as never, 'a', 'b', 'nope')), null);
    });
} finally {
    await fx.close();
}

console.log(`\n${failed === 0 ? 'all' : `${passed}/${passed + failed}`} ${passed + failed} unit tests ${failed === 0 ? 'passed ✓' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
