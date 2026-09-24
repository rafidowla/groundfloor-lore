#!/usr/bin/env tsx
/**
 * test/rc321g-recall-candidates-mcp-rest-unit.ts — Lore 3.21 step 3(g), MCP + REST.
 *
 * Pins that `recall`'s `compact:true` and the paired expand call are wired
 * through both client-facing surfaces:
 *   - MCP `recall` tool (`compact` arg) + new MCP `recall_expand` tool
 *   - REST GET /api/recall?compact=true + new REST POST /api/recall/expand
 * and — the core confinement promise — that a caller CANNOT expand an id
 * outside the scope recall itself would have surfaced it in (two workspaces
 * here are two entirely separate fixture graphs, mirroring how
 * graphRegistry.getGraphHandle(workspace) physically separates them).
 *
 * Run: npm run test:unit:rc321g-recall-candidates-mcp-rest
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import { registerRecallExpandTool } from '../packages/lore/src/mcp/tools/search/recallExpandTool.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS_A = 'rc321g-ws-a';
const WS_B = 'rc321g-ws-b';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
};
const fnode = (id: string, ws: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`.repeat(20),
    tags: [], project: ws, ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

// Two ENTIRELY SEPARATE fixture graphs, one per workspace — mirrors how
// graphRegistry.getGraphHandle(workspace) physically separates real
// workspaces. id 'shared-id' exists in BOTH graphs' id-space but as a
// DIFFERENT node, so a caller confusing workspaces gets workspace B's node,
// never workspace A's — and an id that only exists in A must never surface
// via a call scoped to B.
const NODES_A: Record<string, FNode> = { alpha: fnode('alpha', WS_A), 'only-in-a': fnode('only-in-a', WS_A) };
const NODES_B: Record<string, FNode> = { beta: fnode('beta', WS_B) };

function makeGraph(nodes: Record<string, FNode>) {
    return {
        async search() { return []; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = nodes[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse() { return []; },
        async getNode(id: string) { const x = nodes[id]; return x ? { ...x } : null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
}

function buildFixture(): { searchDeps: SearchDeps; toolDeps: SearchToolsDeps } {
    const graphA = makeGraph(NODES_A);
    const graphB = makeGraph(NODES_B);
    const storeFor = (graph: ReturnType<typeof makeGraph>) => ({
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return 1; },
            async verbatimSearch() { throw new Error('semantic path not used by these keyword-mode fixtures'); },
            async verbatimBm25Search(_q: string, _n: number) {
                void _q; void _n;
                // Every workspace's bm25 returns ALL of its own nodes — used
                // only to build the compact-candidates test's fixture.
                const hits = Object.keys(graph === graphA ? NODES_A : NODES_B).map((id) => ({ id: `lore:${id}`, score: 5 }));
                return { hits, ranked: true };
            },
        },
    });
    const graphRegistry = {
        async getOrOpen(ws: string) { return ws === WS_A ? graphA : graphB; },
        async getGraphHandle(ws: string) { return ws === WS_A ? graphA : graphB; },
    };
    // A single StorageBundle can't natively hold two workspaces' verbatim
    // stores at once in this simplified fixture; the recall/expand paths
    // under test route entirely through graphRegistry.getGraphHandle(ws),
    // so the boot-bound store only needs to be A's (never consulted by the
    // expand path, and only reached by `recall` compact for workspace A's
    // own bm25 test).
    const store = storeFor(graphA);
    const detectedScope = { workspace: WS_A, ecosystem: '*' };
    const searchDeps = { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps;
    const toolDeps = { store, detectedScope, graphRegistry } as unknown as SearchToolsDeps;
    return { searchDeps, toolDeps };
}

function captureMcpTools(toolDeps: SearchToolsDeps): Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = { tool(name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) { handlers.set(name, handler); } };
    registerRecallTool(fake as unknown as McpServer, toolDeps);
    registerRecallExpandTool(fake as unknown as McpServer, toolDeps);
    return handlers;
}

async function callMcp(handlers: ReturnType<typeof captureMcpTools>, name: string, args: unknown): Promise<any> {
    const res = await handlers.get(name)!(args);
    return { body: JSON.parse(res.content[0]!.text), isError: !!res.isError };
}

async function callRest(searchDeps: SearchDeps, url: string, pathname: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    let status = 0; let out = '';
    const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = {
        method: opts.method ?? 'GET', url,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && bodyText) cb(Buffer.from(bodyText));
            if (event === 'end') cb();
        },
        headers: { 'content-type': 'application/json' },
    } as unknown as IncomingMessage;
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(chunk?: string) { out = chunk ?? ''; },
    } as unknown as ServerResponse;
    const handled = await trySearchRoutes(req, res, url, pathname, searchDeps);
    assert.ok(handled, `route ${pathname} was not handled`);
    return { status, body: out ? JSON.parse(out) : null };
}

console.log('RC321g — compact candidates + recall_expand across MCP + REST\n');

await test('MCP `recall` compact:true returns thin candidates, not full nodes', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, 'recall', { topic: 'q', workspace: WS_A, search_mode: 'keyword', compact: true });
    assert.ok(!isError, JSON.stringify(body));
    assert.ok(Array.isArray(body.candidates), 'compact response must carry a `candidates` array');
    const ids = body.candidates.map((c: any) => c.id).sort();
    assert.deepEqual(ids, ['alpha', 'only-in-a']);
    for (const c of body.candidates) {
        assert.ok('snippet' in c && 'score' in c && 'matchedBy' in c && 'updatedAt' in c, 'compact candidate must carry the thin shape');
        assert.ok(!('content' in c), 'compact candidate must NOT carry the full body');
    }
});

await test('MCP `recall_expand`: expands ids the caller could have recalled in its OWN workspace', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, 'recall_expand', { ids: ['alpha'], workspace: WS_A });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.expanded, 1);
    assert.equal(body.nodes[0].id, 'alpha');
    assert.ok(body.nodes[0].content.length > 0, 'expand must return the FULL body, unlike compact');
});

await test('MCP `recall_expand`: an id that only exists in a DIFFERENT workspace is NOT expandable', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    // Request workspace A, but ask for an id that only exists in workspace B.
    const { body, isError } = await callMcp(mcp, 'recall_expand', { ids: ['beta'], workspace: WS_A });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.expanded, 0, 'a foreign-workspace id must be silently dropped, never returned');
    assert.deepEqual(body.nodes, []);
});

await test('MCP `recall_expand`: workspace="*" is refused (must be a single named workspace)', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, 'recall_expand', { ids: ['alpha'], workspace: '*' });
    assert.ok(isError);
    assert.equal(body.error, 'cross_workspace_not_supported');
});

await test('REST GET /api/recall?compact=true returns candidates, not full nodes', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(searchDeps, `/api/recall?topic=q&workspace=${WS_A}&search_mode=keyword&compact=true`, '/api/recall');
    assert.equal(rest.status, 200);
    assert.ok(Array.isArray(rest.body.candidates));
    const ids = rest.body.candidates.map((c: any) => c.id).sort();
    assert.deepEqual(ids, ['alpha', 'only-in-a']);
});

await test('REST POST /api/recall/expand: expands an id within the requested workspace', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(searchDeps, '/api/recall/expand', '/api/recall/expand', {
        method: 'POST', body: { ids: ['alpha'], workspace: WS_A },
    });
    assert.equal(rest.status, 200);
    assert.equal(rest.body.expanded, 1);
    assert.equal(rest.body.nodes[0].id, 'alpha');
});

await test('REST POST /api/recall/expand: an id from a DIFFERENT workspace is NOT expandable (the confinement guarantee)', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(searchDeps, '/api/recall/expand', '/api/recall/expand', {
        method: 'POST', body: { ids: ['beta', 'alpha'], workspace: WS_A },
    });
    assert.equal(rest.status, 200);
    assert.deepEqual(rest.body.nodes.map((n: any) => n.id), ['alpha'], 'beta (workspace B only) must be dropped; alpha (workspace A) survives');
    assert.equal(rest.body.expanded, 1);
});

await test('REST POST /api/recall/expand: >50 ids is rejected with 400', async () => {
    const { searchDeps } = buildFixture();
    const many = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const rest = await callRest(searchDeps, '/api/recall/expand', '/api/recall/expand', {
        method: 'POST', body: { ids: many, workspace: WS_A },
    });
    assert.equal(rest.status, 400);
    assert.equal(rest.body.code, 'too_many_ids');
});

await test('REST POST /api/recall/expand: workspace required, "*" refused', async () => {
    const { searchDeps } = buildFixture();
    const missing = await callRest(searchDeps, '/api/recall/expand', '/api/recall/expand', { method: 'POST', body: { ids: ['alpha'] } });
    assert.equal(missing.status, 400);
    const star = await callRest(searchDeps, '/api/recall/expand', '/api/recall/expand', { method: 'POST', body: { ids: ['alpha'], workspace: '*' } });
    assert.equal(star.status, 400);
    assert.equal(star.body.code, 'cross_workspace_not_supported');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
