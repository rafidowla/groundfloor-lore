#!/usr/bin/env tsx
/**
 * test/rest-delete-node-edge-unit.ts — W8 (Sprint W) DELETE REST routes.
 *
 * Drives `tryNodeDeleteRoute` and `tryEdgesRoutes` directly with
 * recording fakes so the route shape is validated without needing a
 * real graph engine/lancedb pair.
 *
 * Spec pins (W8-rest-delete-node-edge.md):
 *   T1: POST /api/node + DELETE /api/node/:id → DELETE returns 200,
 *       graph.deleteNode called with the right id; a follow-up
 *       getNode would 404 (validated by the fake returning null).
 *   T2: DELETE /api/node/<nonexistent> → 404 with clear error.
 *   T3: After DELETE, verbatim tombstone is created (tombstone() called
 *       with `lore:<id>`).
 *   T4: DELETE /api/edge?sourceId=A&targetId=B&relation=r deletes the
 *       matching edge; a follow-up GET /api/edges?source=A excludes it.
 *   T5: Unauthenticated DELETE → 401 — validated via validateRequest
 *       (the auth middleware that fires before any route handler).
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { validateRequest } from '../packages/lore/src/security/httpAuth.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('W8 DELETE REST routes');

/* ---------- recording fakes ---------- */

interface FakeNode { id: string; type: string; label: string }
interface FakeEdge { sourceId: string; targetId: string; relation: string }

function makeFakeGraph(opts: {
    seedNodes?: FakeNode[];
    seedEdges?: FakeEdge[];
} = {}) {
    const nodes = new Map<string, FakeNode>((opts.seedNodes ?? []).map((n) => [n.id, n]));
    const edges: FakeEdge[] = [...(opts.seedEdges ?? [])];
    const deleteNodeCalls: string[] = [];
    const deleteEdgeCalls: FakeEdge[] = [];
    const queryRowsCalls: Array<{ cypher: string; params: Record<string, unknown> }> = [];

    return {
        nodes, edges, deleteNodeCalls, deleteEdgeCalls, queryRowsCalls,
        graph: {
            async getNode(id: string) { return nodes.get(id) ?? null; },
            async deleteNode(id: string) {
                deleteNodeCalls.push(id);
                if (!nodes.has(id)) return false;
                nodes.delete(id);
                // edges referencing this node also drop (matches the
                // real engines' deleteNode behavior).
                for (let i = edges.length - 1; i >= 0; i--) {
                    if (edges[i]!.sourceId === id || edges[i]!.targetId === id) edges.splice(i, 1);
                }
                return true;
            },
            async deleteEdge(sourceId: string, targetId: string, relation: string) {
                const before = edges.length;
                for (let i = edges.length - 1; i >= 0; i--) {
                    const e = edges[i]!;
                    if (e.sourceId === sourceId && e.targetId === targetId && e.relation === relation) {
                        edges.splice(i, 1);
                    }
                }
                const removed = before - edges.length;
                deleteEdgeCalls.push({ sourceId, targetId, relation });
                return removed;
            },
            // GET /api/edges now routes through graph.queryEdges (cloud
            // parity refactor) instead of getGraphContext Cypher.
            async queryEdges(q: { source?: string; target?: string; relation?: string }) {
                return edges
                    .filter((e) => !q.source || e.sourceId === q.source)
                    .filter((e) => !q.target || e.targetId === q.target)
                    .filter((e) => !q.relation || e.relation === q.relation)
                    .map((e) => ({
                        sourceId: e.sourceId,
                        targetId: e.targetId,
                        relation: e.relation,
                        confidence: 'extracted' as const,
                        confidenceScore: 1.0,
                    }));
            },
            getGraphContext() {
                return {
                    queryRows: async (cypher: string, params: Record<string, unknown>) => {
                        queryRowsCalls.push({ cypher, params });
                        return edges
                            .filter((e) => !params['source'] || e.sourceId === params['source'])
                            .filter((e) => !params['target'] || e.targetId === params['target'])
                            .filter((e) => !params['relation'] || e.relation === params['relation'])
                            .map((e) => ({
                                sourceId: e.sourceId,
                                targetId: e.targetId,
                                relation: e.relation,
                                confidence: 'extracted',
                                confidenceScore: 1.0,
                            }));
                    },
                    executeQuery: async () => undefined,
                    bumpEpoch: () => undefined,
                    storage: {},
                    detectLanguage: () => ({ language: null, confidence: 0 }),
                };
            },
        },
    };
}

function makeFakeVerbatim() {
    const tombstoneCalls: Array<{ id: string; reason: string }> = [];
    const deleteCalls: string[] = [];
    return {
        tombstoneCalls,
        deleteCalls,
        store: {
            async tombstone(id: string, reason: string) { tombstoneCalls.push({ id, reason }); },
            async delete(id: string) { deleteCalls.push(id); },
        },
    };
}

function makeFakeAudit() {
    const logs: Array<Record<string, unknown>> = [];
    return {
        logs,
        log: { log: (entry: Record<string, unknown>) => { logs.push(entry); } },
    };
}

function makeReq(method: string): IncomingMessage {
    return { method, on: () => undefined } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function makeNodeDeleteDeps(
    graph: ReturnType<typeof makeFakeGraph>['graph'],
    verbatim: ReturnType<typeof makeFakeVerbatim>['store'],
    audit: ReturnType<typeof makeFakeAudit>['log'],
): Parameters<typeof tryNodeDeleteRoute>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never, loreVerbatim: verbatim as never } as never,
        auditLog: audit as never,
    };
}

function makeEdgesDeps(
    graph: ReturnType<typeof makeFakeGraph>['graph'],
): Parameters<typeof tryEdgesRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never } as never,
    };
}

/* ---------- T1 — DELETE /api/node/:id happy path ---------- */

test('T1 DELETE /api/node/:id — 200, deleteNode called, node gone', async () => {
    const fake = makeFakeGraph({ seedNodes: [{ id: 'foo', type: 'decision', label: 'Foo' }] });
    const verbatim = makeFakeVerbatim();
    const audit = makeFakeAudit();
    const res = fakeRes();
    const handled = await tryNodeDeleteRoute(
        makeReq('DELETE'),
        res,
        '/api/node/foo?workspace=del-fixture',
        '/api/node/foo',
        makeNodeDeleteDeps(fake.graph, verbatim.store, audit.log),
    );
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(handled, true);
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.id, 'foo');
    assert.equal(body.tombstoned, true);
    assert.deepEqual(fake.deleteNodeCalls, ['foo']);
    // Confirm a subsequent getNode returns null (T1 spec: GET → 404)
    const after = await fake.graph.getNode('foo');
    assert.equal(after, null, 'node must be gone from the graph after DELETE');
});

test('T1 DELETE accepts lore: prefix and strips it for graph delete', async () => {
    const fake = makeFakeGraph({ seedNodes: [{ id: 'bar', type: 'decision', label: 'Bar' }] });
    const verbatim = makeFakeVerbatim();
    const audit = makeFakeAudit();
    const res = fakeRes();
    await tryNodeDeleteRoute(
        makeReq('DELETE'),
        res,
        '/api/node/lore%3Abar?workspace=del-fixture',
        '/api/node/lore%3Abar',
        makeNodeDeleteDeps(fake.graph, verbatim.store, audit.log),
    );
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(res._status, 200, `body: ${res._body}`);
    // Graph sees the bare id ('bar'), verbatim tombstone uses 'lore:bar'.
    assert.deepEqual(fake.deleteNodeCalls, ['bar']);
    assert.equal(verbatim.tombstoneCalls[0]?.id, 'lore:bar');
});

/* ---------- T2 — DELETE nonexistent → 404 ---------- */

test('T2 DELETE /api/node/<nonexistent> — 404 with clear error', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const audit = makeFakeAudit();
    const res = fakeRes();
    await tryNodeDeleteRoute(
        makeReq('DELETE'),
        res,
        '/api/node/ghost?workspace=del-fixture',
        '/api/node/ghost',
        makeNodeDeleteDeps(fake.graph, verbatim.store, audit.log),
    );
    assert.equal(res._status, 404, `expected 404; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.match(body.message, /not found/i);
    assert.equal(body.id, 'ghost');
    // No tombstone for a never-existed node — that would create phantom history.
    assert.equal(verbatim.tombstoneCalls.length, 0);
    assert.equal(verbatim.deleteCalls.length, 0);
});

test('T2 reserved sub-path /api/node/supersede is NOT interpreted as id', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const audit = makeFakeAudit();
    const res = fakeRes();
    const handled = await tryNodeDeleteRoute(
        makeReq('DELETE'),
        res,
        '/api/node/supersede',
        '/api/node/supersede',
        makeNodeDeleteDeps(fake.graph, verbatim.store, audit.log),
    );
    // Handler returns false so the dispatcher's 404 fallback runs.
    assert.equal(handled, false);
    assert.equal(fake.deleteNodeCalls.length, 0);
});

/* ---------- T3 — verbatim tombstone created on success ---------- */

test('T3 after DELETE, verbatim.tombstone(lore:<id>, reason) is called', async () => {
    const fake = makeFakeGraph({ seedNodes: [{ id: 'doomed', type: 'decision', label: 'Doomed' }] });
    const verbatim = makeFakeVerbatim();
    const audit = makeFakeAudit();
    const res = fakeRes();
    await tryNodeDeleteRoute(
        makeReq('DELETE'),
        res,
        '/api/node/doomed?workspace=del-fixture',
        '/api/node/doomed',
        makeNodeDeleteDeps(fake.graph, verbatim.store, audit.log),
    );
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(res._status, 200);
    assert.equal(verbatim.tombstoneCalls.length, 1, 'tombstone must be called exactly once');
    assert.equal(verbatim.tombstoneCalls[0]!.id, 'lore:doomed');
    assert.match(verbatim.tombstoneCalls[0]!.reason, /graph node deleted/);
    // delete() path is only used as the cloud-mode fallback.
    assert.equal(verbatim.deleteCalls.length, 0);
});

test('T3 cloud-mode fallback: when store lacks tombstone(), uses delete()', async () => {
    const fake = makeFakeGraph({ seedNodes: [{ id: 'cloudy', type: 'decision', label: 'Cloudy' }] });
    const verbatim = makeFakeVerbatim();
    const audit = makeFakeAudit();
    // Strip the tombstone fn to simulate DataplaneVectorStore (no tombstone yet).
    const storeNoTombstone: { delete: (id: string) => Promise<void> } = {
        delete: verbatim.store.delete,
    };
    const res = fakeRes();
    await tryNodeDeleteRoute(
        makeReq('DELETE'),
        res,
        '/api/node/cloudy?workspace=del-fixture',
        '/api/node/cloudy',
        makeNodeDeleteDeps(fake.graph, storeNoTombstone as never, audit.log),
    );
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.tombstoned, false);
    assert.deepEqual(verbatim.deleteCalls, ['lore:cloudy']);
});

/* ---------- T4 — DELETE /api/edge by triple ---------- */

test('T4 DELETE /api/edge — deletes by triple, follow-up GET excludes it', async () => {
    const fake = makeFakeGraph({
        seedEdges: [
            { sourceId: 'A', targetId: 'B', relation: 'depends_on' },
            { sourceId: 'A', targetId: 'C', relation: 'related_to' },
        ],
    });
    const res1 = fakeRes();
    await tryEdgesRoutes(
        makeReq('DELETE'),
        res1,
        '/api/edge?sourceId=A&targetId=B&relation=depends_on&workspace=del-fixture',
        '/api/edge',
        makeEdgesDeps(fake.graph),
    );
    assert.equal(res1._status, 200, `expected 200; got ${res1._status}: ${res1._body}`);
    const body1 = JSON.parse(res1._body);
    assert.equal(body1.ok, true);
    assert.equal(body1.deleted, 1);
    assert.equal(fake.deleteEdgeCalls.length, 1);
    // Follow-up GET /api/edges?source=A must no longer include A-depends_on-B.
    // SP-04 — GET /api/edges now requires an explicit workspace.
    const res2 = fakeRes();
    await tryEdgesRoutes(
        makeReq('GET'),
        res2,
        '/api/edges?source=A&workspace=del-fixture',
        '/api/edges',
        makeEdgesDeps(fake.graph),
    );
    assert.equal(res2._status, 200);
    const body2 = JSON.parse(res2._body);
    const remaining = body2.edges as Array<{ sourceId: string; targetId: string; relation: string }>;
    assert.equal(remaining.length, 1, 'one edge from A should remain');
    assert.equal(remaining[0]!.targetId, 'C', 'only the C edge survives');
});

test('T4 DELETE /api/edge with no match → 404 edge_not_found', async () => {
    const fake = makeFakeGraph({
        seedEdges: [{ sourceId: 'A', targetId: 'B', relation: 'depends_on' }],
    });
    const res = fakeRes();
    await tryEdgesRoutes(
        makeReq('DELETE'),
        res,
        '/api/edge?sourceId=X&targetId=Y&relation=nope&workspace=del-fixture',
        '/api/edge',
        makeEdgesDeps(fake.graph),
    );
    assert.equal(res._status, 404);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'edge_not_found');
});

test('T4 DELETE /api/edge with missing query params → 400', async () => {
    const fake = makeFakeGraph();
    const res = fakeRes();
    await tryEdgesRoutes(
        makeReq('DELETE'),
        res,
        '/api/edge?sourceId=A&workspace=del-fixture',
        '/api/edge',
        makeEdgesDeps(fake.graph),
    );
    assert.equal(res._status, 400);
    assert.match(res._body, /required/);
});

/* ---------- T5 — Unauthenticated DELETE → 401 ---------- */

// Auth gating fires upstream of any route handler (in validateRequest).
// We pin it directly so the contract for both DELETE surfaces is
// covered without spinning up a real HTTP server.
test('T5 DELETE /api/node/:id without Bearer → validateRequest 401', () => {
    const r = validateRequest(
        {
            url: '/api/node/foo',
            method: 'DELETE',
            headers: { host: 'localhost:3847' },
        } as never,
        { port: 3847, token: 'a'.repeat(64) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
});

test('T5 DELETE /api/edge without Bearer → validateRequest 401', () => {
    const r = validateRequest(
        {
            url: '/api/edge?sourceId=A&targetId=B&relation=depends_on',
            method: 'DELETE',
            headers: { host: 'localhost:3847' },
        } as never,
        { port: 3847, token: 'a'.repeat(64) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
