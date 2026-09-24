#!/usr/bin/env tsx
/**
 * test/rc321h-recall-outcome-mcp-rest-unit.ts — Lore 3.21 step 3(h), MCP + REST.
 *
 * Pins that the `recall_outcome` MCP tool and POST /api/recall/outcome:
 *   - use record_outcome's OWN vocabulary — 'success'/'failure'/'partial'
 *     — with no translation layer (Opus review round 2: an earlier draft
 *     invented 'used'/'not_used'/'wrong' and mapped 'wrong' → 'failure',
 *     which collided with ranking.ts's deliberate failure-boost policy).
 *     The old vocabulary must now be REJECTED, not silently accepted.
 *   - thread nodeId/outcome/queryId into applyRecallOutcome() correctly
 *     (verified against a MOCK AuxStore here — applyRecallOutcome()'s own
 *     logic against a REAL AuxStore is covered by
 *     rc321h-recall-outcome-unit.ts; this file is about surface wiring).
 *   - are confined to the caller's workspace: a node in a DIFFERENT
 *     workspace's graph cannot have its outcome recorded via a call scoped
 *     to another workspace (mirrors recall_expand's confinement pattern).
 *   - refuse workspace="*".
 *   - `not_configured` when auxStore isn't wired at all.
 *
 * Run: npm run test:unit:rc321h-recall-outcome-mcp-rest
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerRecallOutcomeTool } from '../packages/lore/src/mcp/tools/search/recallOutcomeTool.js';
import { tryRecallOutcomeRoute, type RecallOutcomeRouteDeps } from '../packages/lore/src/mcp/http/routes/recallOutcome.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS_A = 'rc321h-ws-a';
const WS_B = 'rc321h-ws-b';

function node(id: string): LoreNode {
    return {
        id, type: 'note', label: `Label ${id}`, content: 'c', tags: [],
        project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z', syncedAt: null,
    } as unknown as LoreNode;
}

/** Mock AuxStore — records calls, computes counts in-memory. Matches the
 *  subset of AuxStore's public surface applyRecallOutcome() calls. */
function makeMockAuxStore() {
    const rows: Array<{ nodeId: string; workspace: string; status: string; notes?: string }> = [];
    const counters: Record<string, number> = {};
    return {
        rows,
        recordOutcome(o: { nodeId: string; workspace: string; status: string; notes?: string }) { rows.push(o); },
        getOutcomeCount(nodeId: string, workspace: string) {
            const matched = rows.filter((r) => r.nodeId === nodeId && r.workspace === workspace);
            return {
                success: matched.filter((r) => r.status === 'success').length,
                failure: matched.filter((r) => r.status === 'failure').length,
                partial: matched.filter((r) => r.status === 'partial').length,
            };
        },
        getOutcomes(nodeId: string, workspace: string) {
            return rows.filter((r) => r.nodeId === nodeId && r.workspace === workspace).map((r) => ({ ...r, id: 'x', recordedBy: null, recordedAt: '' }));
        },
        incrementCounter(_ws: string, _metric: string) { counters[_metric] = (counters[_metric] ?? 0) + 1; void _ws; },
    };
}

function makeGraph(nodes: Record<string, LoreNode>) {
    return {
        async initialize() { /* noop */ },
        async getNode(id: string) { return nodes[id] ?? null; },
        async upsertNode(n: LoreNode) { nodes[n.id] = n; return n; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, LoreNode>();
            for (const id of ids) { const x = nodes[id]; if (x) m.set(id, x); }
            return m;
        },
        async search() { return []; },
        async traverse() { return []; },
    };
}

function buildFixture() {
    const auxStore = makeMockAuxStore();
    const nodesA: Record<string, LoreNode> = { alpha: node('alpha') };
    const nodesB: Record<string, LoreNode> = { beta: node('beta') };
    const graphA = makeGraph(nodesA);
    const graphB = makeGraph(nodesB);
    const graphRegistry = {
        async getOrOpen(ws: string) { return ws === WS_A ? graphA : graphB; },
        async getGraphHandle(ws: string) { return ws === WS_A ? graphA : graphB; },
    };
    const store = { loreGraph: graphA };
    const detectedScope = { workspace: WS_A, ecosystem: '*' };
    const toolDeps = { store, detectedScope, graphRegistry, auxStore } as unknown as SearchToolsDeps;
    const routeDeps = {
        store, deploymentMode: 'local' as const, dataplane: null, graphRegistry, auxStore,
    } as unknown as RecallOutcomeRouteDeps;
    return { toolDeps, routeDeps, auxStore, graphA, graphB };
}

function captureMcpTools(toolDeps: SearchToolsDeps): Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = { tool(name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) { handlers.set(name, handler); } };
    registerRecallOutcomeTool(fake as unknown as McpServer, toolDeps);
    return handlers;
}

async function callMcp(handlers: ReturnType<typeof captureMcpTools>, name: string, args: unknown): Promise<any> {
    const res = await handlers.get(name)!(args);
    return { body: JSON.parse(res.content[0]!.text), isError: !!res.isError };
}

async function callRest(routeDeps: RecallOutcomeRouteDeps, body: unknown): Promise<{ status: number; body: any }> {
    let status = 0; let out = '';
    const bodyText = JSON.stringify(body);
    const req = {
        method: 'POST', url: '/api/recall/outcome',
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') cb(Buffer.from(bodyText));
            if (event === 'end') cb();
        },
        headers: { 'content-type': 'application/json' },
    } as unknown as IncomingMessage;
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(chunk?: string) { out = chunk ?? ''; },
    } as unknown as ServerResponse;
    const handled = await tryRecallOutcomeRoute(req, res, '/api/recall/outcome', '/api/recall/outcome', routeDeps);
    assert.ok(handled, 'route was not handled');
    return { status, body: out ? JSON.parse(out) : null };
}

console.log('RC321h — recall_outcome across MCP + REST\n');

await test('MCP `recall_outcome`: "success" records success and returns updated counts (identical vocabulary to record_outcome)', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, 'recall_outcome', { nodeId: 'alpha', workspace: WS_A, outcome: 'success' });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.status, 'success');
    assert.equal(body.counts.success, 1);
});

await test('MCP `recall_outcome`: queryId is echoed back on the response', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body } = await callMcp(mcp, 'recall_outcome', { nodeId: 'alpha', workspace: WS_A, outcome: 'failure', queryId: 'q-xyz' });
    assert.equal(body.query_id, 'q-xyz');
    assert.equal(body.status, 'failure');
});

await test('MCP `recall_outcome`: confinement — a node from a DIFFERENT workspace is node_not_found, not silently applied there', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    // 'beta' only exists in workspace B's graph; request scoped to A.
    const { body, isError } = await callMcp(mcp, 'recall_outcome', { nodeId: 'beta', workspace: WS_A, outcome: 'success' });
    assert.ok(isError);
    assert.equal(body.error, 'node_not_found');
});

await test('MCP `recall_outcome`: workspace="*" is refused', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, 'recall_outcome', { nodeId: 'alpha', workspace: '*', outcome: 'success' });
    assert.ok(isError);
    assert.equal(body.error, 'cross_workspace_not_supported');
});

await test('MCP `recall_outcome`: not_configured when auxStore is absent', async () => {
    const { toolDeps } = buildFixture();
    const noAux = { ...toolDeps, auxStore: undefined } as unknown as SearchToolsDeps;
    const mcp = captureMcpTools(noAux);
    const { body, isError } = await callMcp(mcp, 'recall_outcome', { nodeId: 'alpha', workspace: WS_A, outcome: 'success' });
    assert.ok(isError);
    assert.equal(body.error, 'not_configured');
});

await test('REST POST /api/recall/outcome: "partial" records partial', async () => {
    const { routeDeps } = buildFixture();
    const rest = await callRest(routeDeps, { node_id: 'alpha', workspace: WS_A, outcome: 'partial' });
    assert.equal(rest.status, 200);
    assert.equal(rest.body.status, 'partial');
    assert.equal(rest.body.counts.partial, 1);
});

await test('REST POST /api/recall/outcome: confinement — a different-workspace node is not_found (404)', async () => {
    const { routeDeps } = buildFixture();
    const rest = await callRest(routeDeps, { node_id: 'beta', workspace: WS_A, outcome: 'success' });
    assert.equal(rest.status, 404);
    assert.equal(rest.body.code, 'node_not_found');
});

await test('REST POST /api/recall/outcome: workspace="*" is refused (400)', async () => {
    const { routeDeps } = buildFixture();
    const rest = await callRest(routeDeps, { node_id: 'alpha', workspace: '*', outcome: 'success' });
    assert.equal(rest.status, 400);
    assert.equal(rest.body.code, 'cross_workspace_not_supported');
});

await test('REST POST /api/recall/outcome: invalid outcome value is a 400, not silently coerced', async () => {
    const { routeDeps } = buildFixture();
    const rest = await callRest(routeDeps, { node_id: 'alpha', workspace: WS_A, outcome: 'maybe' });
    assert.equal(rest.status, 400);
    assert.equal(rest.body.code, 'invalid_request');
});

await test('REST POST /api/recall/outcome: the REJECTED relevance vocabulary (used/not_used/wrong) is a 400, not accepted', async () => {
    const { routeDeps } = buildFixture();
    for (const rejected of ['used', 'not_used', 'wrong']) {
        const rest = await callRest(routeDeps, { node_id: 'alpha', workspace: WS_A, outcome: rejected });
        assert.equal(rest.status, 400, `"${rejected}" must be rejected, not silently mapped`);
        assert.equal(rest.body.code, 'invalid_request');
    }
});

await test('MCP `recall_outcome`: the zod schema itself only accepts success/failure/partial', async () => {
    const capturedShapes: Record<string, unknown>[] = [];
    const fake = { tool(_name: string, _desc: string, schema: Record<string, unknown>) { capturedShapes.push(schema); } };
    registerRecallOutcomeTool(fake as unknown as McpServer, buildFixture().toolDeps);
    const shape = capturedShapes[0]!;
    const outcomeSchema = shape['outcome'] as { safeParse: (v: unknown) => { success: boolean } };
    assert.equal(outcomeSchema.safeParse('success').success, true);
    assert.equal(outcomeSchema.safeParse('failure').success, true);
    assert.equal(outcomeSchema.safeParse('partial').success, true);
    assert.equal(outcomeSchema.safeParse('used').success, false, 'the REJECTED relevance vocabulary must fail zod validation');
    assert.equal(outcomeSchema.safeParse('not_used').success, false);
    assert.equal(outcomeSchema.safeParse('wrong').success, false);
});

await test('REST POST /api/recall/outcome: 501 not_configured when auxStore is absent from deps', async () => {
    const { routeDeps } = buildFixture();
    const noAux = { ...routeDeps, auxStore: undefined };
    const rest = await callRest(noAux, { node_id: 'alpha', workspace: WS_A, outcome: 'success' });
    assert.equal(rest.status, 501);
    assert.equal(rest.body.code, 'not_configured');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
