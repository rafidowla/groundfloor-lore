#!/usr/bin/env tsx
/**
 * test/edges-route-unit.ts — W2 (Sprint W) edge REST routes.
 *
 * Drives `tryEdgesRoutes` directly with a recording fake graph handle + a
 * minimal getGraphContext to validate the POST/GET shapes
 * without needing a real embedded database.
 *
 * Spec pins (W2-rest-endpoint-edges.md):
 *   T1: POST /api/edge {sourceId, targetId, relation} → 200, edge
 *       queryable (addEdge called with the right payload).
 *   T2: GET /api/edges?source=A → returns the edge (queryRows hit
 *       with `a.id = $source` clause; rows mapped into JSON shape).
 *   T3: 4xx for invalid relation (when edgeRelations is wired into
 *       deps, the route pre-validates and rejects with 400 +
 *       allowed-relation list).
 *   T4: Unauthenticated → 401. NOT covered here — auth/middleware
 *       gates fire before the dispatcher hits a route. Pinned by the
 *       existing test/auth-middleware-* suite. We assert the gate is
 *       still wired by the cloud-mode-no-dataplane probe (503 path).
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('W2 edge REST routes');

/* ---------- recording fakes ---------- */

interface CapturedEdge {
    sourceId: string;
    targetId: string;
    relation: string;
    confidence?: string;
    confidenceScore?: number;
    bidirectional?: boolean;
}

interface CapturedEdgeQuery { source?: string; target?: string; relation?: string; limit: number; offset: number }

function makeFakeGraph(seedEdges: CapturedEdge[] = []) {
    const addEdgeCalls: CapturedEdge[] = [];
    const queryEdgesCalls: CapturedEdgeQuery[] = [];

    return {
        addEdgeCalls,
        queryEdgesCalls,
        graph: {
            async addEdge(e: CapturedEdge) {
                addEdgeCalls.push({ ...e });
            },
            async addBidirectionalEdge(e: CapturedEdge) {
                addEdgeCalls.push({ ...e, bidirectional: true });
                addEdgeCalls.push({
                    sourceId: e.targetId,
                    targetId: e.sourceId,
                    relation: e.relation,
                    confidence: e.confidence,
                    confidenceScore: e.confidenceScore,
                    bidirectional: true,
                });
            },
            // GET /api/edges routes through graph.queryEdges now (cloud
            // parity refactor — each local graph engine builds its own
            // native query, DataplaneGraph uses the SDK). The route only
            // parses params + formats the response, so we record the filter
            // args and apply them here.
            async queryEdges(q: CapturedEdgeQuery) {
                queryEdgesCalls.push(q);
                return seedEdges
                    .filter((e) => !q.source || e.sourceId === q.source)
                    .filter((e) => !q.target || e.targetId === q.target)
                    .filter((e) => !q.relation || e.relation === q.relation)
                    .slice(q.offset, q.offset + q.limit)
                    .map((e) => ({
                        sourceId: e.sourceId,
                        targetId: e.targetId,
                        relation: e.relation,
                        confidence: e.confidence ?? 'extracted',
                        confidenceScore: e.confidenceScore ?? 1.0,
                    }));
            },
        },
    };
}

function makeReqWithBody(method: string, body: string): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) {
                consumed = true;
                cb(Buffer.from(body, 'utf8'));
            }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function localDeps(
    graph: ReturnType<typeof makeFakeGraph>['graph'],
    edgeRelations?: ReadonlyArray<string>,
): Parameters<typeof tryEdgesRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never } as never,
        edgeRelations,
    };
}

/* ---------- T1 — POST /api/edge happy path ---------- */

test('T1 POST /api/edge — addEdge called with payload, 200 OK', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody('POST', JSON.stringify({
        sourceId: 'A', targetId: 'B', relation: 'depends_on', bidirectional: false,
        workspace: 'edges-fixture',
    }));
    const res = fakeRes();
    const handled = await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', localDeps(fake.graph));
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(handled, true);
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    assert.equal(fake.addEdgeCalls.length, 1);
    assert.equal(fake.addEdgeCalls[0]!.sourceId, 'A');
    assert.equal(fake.addEdgeCalls[0]!.targetId, 'B');
    assert.equal(fake.addEdgeCalls[0]!.relation, 'depends_on');
    assert.equal(fake.addEdgeCalls[0]!.confidence, 'extracted');
});

test('T1 POST /api/edge — bidirectional default writes 2 edges', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody('POST', JSON.stringify({
        sourceId: 'A', targetId: 'B', relation: 'related_to',
        workspace: 'edges-fixture',
    }));
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', localDeps(fake.graph));
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(res._status, 200);
    assert.equal(fake.addEdgeCalls.length, 2, 'bidirectional must write both A→B and B→A');
});

test('T1 POST /api/edge — missing required fields → 400', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody('POST', JSON.stringify({ sourceId: 'A', workspace: 'edges-fixture' }));
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', localDeps(fake.graph));
    assert.equal(res._status, 400);
    assert.match(res._body, /required/);
    assert.equal(fake.addEdgeCalls.length, 0);
});

/* ---------- T2 — GET /api/edges with filter ---------- */

test('T2 GET /api/edges?source=A — returns the edge with filter params', async () => {
    const fake = makeFakeGraph([
        { sourceId: 'A', targetId: 'B', relation: 'depends_on' },
        { sourceId: 'X', targetId: 'Y', relation: 'depends_on' },
    ]);
    const req = { method: 'GET', on: () => undefined } as unknown as IncomingMessage;
    const res = fakeRes();
    // SP-04 — GET /api/edges now requires an explicit workspace (no
    // silent active-workspace fallback). No principal bound here, so the
    // read-scope gate is a no-op; the workspace param is all that's needed.
    await tryEdgesRoutes(req, res, '/api/edges?source=A&workspace=edges-fixture', '/api/edges', localDeps(fake.graph));
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 1);
    assert.equal(body.edges[0].sourceId, 'A');
    assert.equal(body.edges[0].targetId, 'B');
    // Route forwarded the source filter to the adapter (the Cypher itself
    // is pinned in graph-query-helpers-unit.ts at the helper layer).
    assert.equal(fake.queryEdgesCalls.length, 1);
    assert.equal(fake.queryEdgesCalls[0]!.source, 'A');
    assert.equal(fake.queryEdgesCalls[0]!.target, undefined);
});

test('T2 GET /api/edges — no filter returns all (capped at limit)', async () => {
    const fake = makeFakeGraph([
        { sourceId: 'A', targetId: 'B', relation: 'r1' },
        { sourceId: 'C', targetId: 'D', relation: 'r2' },
    ]);
    const req = { method: 'GET', on: () => undefined } as unknown as IncomingMessage;
    const res = fakeRes();
    // SP-04 — explicit workspace required (see note above).
    await tryEdgesRoutes(req, res, '/api/edges?workspace=edges-fixture', '/api/edges', localDeps(fake.graph));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 2);
});

/* ---------- T3 — invalid relation rejected with 400 ---------- */

test('T3 POST /api/edge with invalid relation → 400 + allowed list', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody('POST', JSON.stringify({
        sourceId: 'A', targetId: 'B', relation: 'nonsense_relation',
        workspace: 'edges-fixture',
    }));
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge', '/api/edge',
        localDeps(fake.graph, ['depends_on', 'related_to', 'supersedes']));
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'unknown_relation');
    assert.match(body.message, /nonsense_relation/);
    assert.deepEqual(body.allowed, ['depends_on', 'related_to', 'supersedes']);
    assert.equal(fake.addEdgeCalls.length, 0);
});

test('T3 POST /api/edge with invalid confidence → 400', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody('POST', JSON.stringify({
        sourceId: 'A', targetId: 'B', relation: 'depends_on', confidence: 'totally_made_up',
        workspace: 'edges-fixture',
    }));
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', localDeps(fake.graph));
    assert.equal(res._status, 400);
    assert.match(res._body, /confidence must be one of/);
});

/* ---------- T4 — auth/ReBAC gate pinned via cloud-mode probe ---------- */

test('T4 cloud-mode + no dataplane → 503 (ReBAC gate wired)', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody('POST', JSON.stringify({
        sourceId: 'A', targetId: 'B', relation: 'depends_on',
    }));
    const res = fakeRes();
    const handled = await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', {
        deploymentMode: 'cloud',
        dataplane: null,
        store: { loreGraph: fake.graph as never } as never,
    });
    assert.equal(handled, true);
    assert.equal(res._status, 403, `expected 403 from ReBAC denial; got ${res._status}: ${res._body}`);
    assert.equal(fake.addEdgeCalls.length, 0, 'gate must fire before addEdge runs');
});

test('T4 GET cloud-mode + no dataplane → 503 (read gate also wired)', async () => {
    const fake = makeFakeGraph();
    const req = { method: 'GET', on: () => undefined } as unknown as IncomingMessage;
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edges', '/api/edges', {
        deploymentMode: 'cloud',
        dataplane: null,
        store: { loreGraph: fake.graph as never } as never,
    });
    assert.equal(res._status, 403);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
