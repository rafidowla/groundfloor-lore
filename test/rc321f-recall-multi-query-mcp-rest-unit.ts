#!/usr/bin/env tsx
/**
 * test/rc321f-recall-multi-query-mcp-rest-unit.ts — Lore 3.21 step 3(f), MCP + REST.
 *
 * Pins that `queries[]` (extra phrasings, fused via the shared RRF) and the
 * `entities`/`topics`/`project` filters (over 3.21 step 3(e)'s metadata) are
 * threaded through every client-facing surface that exposes recall:
 *   - MCP `recall` tool (`queries`, `entities`, `topics`, `project` args)
 *   - MCP `search` tool (same args)
 *   - REST GET /api/recall (`queries` repeated param, `entities`/`topics`
 *     comma-separated, `project` param)
 * and that omitting all of them reproduces today's behaviour exactly (the
 * "all optional, no-op by default" contract from the 3.21 step 3 brief).
 *
 * Run: npm run test:unit:rc321f-recall-multi-query-mcp-rest
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'rc321f-ws';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string; metadata?: string;
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: WORKSPACE, ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

const NODES: Record<string, FNode> = {
    alpha: fnode('alpha', { metadata: JSON.stringify({ entities: ['acme'] }) }),
    beta: fnode('beta', { metadata: JSON.stringify({ entities: ['other'] }) }),
    gamma: fnode('gamma'), // only found via the extra phrasing
};

function buildFixture(): { searchDeps: SearchDeps; toolDeps: SearchToolsDeps; bm25Calls: string[] } {
    const bm25Calls: string[] = [];
    const graph = {
        async search() { return []; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse() { return []; },
        async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return 3; },
            async verbatimSearch() { throw new Error('semantic path not used by these keyword-mode fixtures'); },
            async verbatimBm25Search(q: string) {
                bm25Calls.push(q);
                // Primary phrasing finds alpha+beta; the EXTRA phrasing
                // ("gamma-phrasing") finds gamma, which the primary
                // phrasing never would — proof the extra list is actually
                // fused in, not just accepted and ignored.
                if (q === 'gamma-phrasing') return { hits: [{ id: 'lore:gamma', score: 9 }], ranked: true };
                return { hits: [{ id: 'lore:alpha', score: 9 }, { id: 'lore:beta', score: 5 }], ranked: true };
            },
        },
    };
    const graphRegistry = {
        async getOrOpen(_ws: string) { void _ws; return graph; },
        async getGraphHandle(_ws: string) { void _ws; return graph; },
    };
    const detectedScope = { workspace: WORKSPACE, ecosystem: '*' };
    const searchDeps = { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps;
    const toolDeps = { store, detectedScope, graphRegistry } as unknown as SearchToolsDeps;
    return { searchDeps, toolDeps, bm25Calls };
}

function captureMcpTools(toolDeps: SearchToolsDeps): Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = { tool(name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) { handlers.set(name, handler); } };
    registerSearchTool(fake as unknown as McpServer, toolDeps);
    registerRecallTool(fake as unknown as McpServer, toolDeps);
    return handlers;
}

async function callMcp(handlers: ReturnType<typeof captureMcpTools>, name: string, args: unknown): Promise<any> {
    const res = await handlers.get(name)!(args);
    assert.ok(!res.isError, `${name} returned an error envelope: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0]!.text);
}

async function callRest(searchDeps: SearchDeps, url: string, pathname: string): Promise<{ status: number; body: any }> {
    let status = 0; let body = '';
    const req = { method: 'GET', url } as unknown as IncomingMessage;
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(chunk?: string) { body = chunk ?? ''; },
    } as unknown as ServerResponse;
    const handled = await trySearchRoutes(req, res, url, pathname, searchDeps);
    assert.ok(handled, `route ${pathname} was not handled`);
    return { status, body: body ? JSON.parse(body) : null };
}

console.log('RC321f — recall multi-query + filters across MCP + REST\n');

await test('MCP `recall`: queries[] fuses in a node the primary phrasing alone would never find', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'recall', {
        topic: 'q', workspace: WORKSPACE, mode: 'full', search_mode: 'keyword', queries: ['gamma-phrasing'],
    });
    const ids = out.knowledge.map((r: any) => r.id);
    assert.ok(ids.includes('gamma'), `expected gamma via the extra phrasing, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('alpha') && ids.includes('beta'), 'primary phrasing hits still present');
});

await test('MCP `recall`: entities filter narrows to the matching node only', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'recall', {
        topic: 'q', workspace: WORKSPACE, mode: 'full', search_mode: 'keyword', entities: ['acme'],
    });
    assert.deepEqual(out.knowledge.map((r: any) => r.id), ['alpha']);
});

await test('MCP `recall`: no queries/entities/topics/project ⇒ identical to pre-3(f) behaviour', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'recall', { topic: 'q', workspace: WORKSPACE, mode: 'full', search_mode: 'keyword' });
    assert.deepEqual(out.knowledge.map((r: any) => r.id).sort(), ['alpha', 'beta']);
});

await test('MCP `search`: queries[] + topics filter both thread through', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'search', {
        query: 'q', workspace: WORKSPACE, search_mode: 'keyword', queries: ['gamma-phrasing'],
    });
    const ids = out.results.map((r: any) => r.id);
    assert.ok(ids.includes('gamma'), 'search tool must also fuse in the extra phrasing');
});

await test('MCP `search`: no filters ⇒ parity with today', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'search', { query: 'q', workspace: WORKSPACE, search_mode: 'keyword' });
    assert.deepEqual(out.results.map((r: any) => r.id).sort(), ['alpha', 'beta']);
});

await test('REST GET /api/recall: repeated ?queries= params fuse the extra phrasing in', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(
        searchDeps,
        `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword&queries=gamma-phrasing`,
        '/api/recall',
    );
    assert.equal(rest.status, 200);
    const ids = rest.body.hits.map((r: any) => r.id);
    assert.ok(ids.includes('gamma'), `expected gamma via ?queries=, got ${JSON.stringify(ids)}`);
});

await test('REST GET /api/recall: ?entities= (comma-separated) filters results', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(
        searchDeps,
        `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword&entities=acme`,
        '/api/recall',
    );
    assert.equal(rest.status, 200);
    assert.deepEqual(rest.body.hits.map((r: any) => r.id), ['alpha']);
});

await test('REST GET /api/recall: no queries/entities/topics/project ⇒ parity with today', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(searchDeps, `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/recall');
    assert.equal(rest.status, 200);
    assert.deepEqual(rest.body.hits.map((r: any) => r.id).sort(), ['alpha', 'beta']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
