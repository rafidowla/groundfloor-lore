#!/usr/bin/env tsx
/**
 * test/rc321a-keyword-bm25-mcp-rest-unit.ts — Lore 3.21 step 3(a), MCP + REST.
 *
 * Pins that the standalone BM25/keyword recall path (search_mode:'keyword')
 * is reachable — and never touches the embedding provider — through EVERY
 * client-facing surface: the MCP `search` + `recall` tools, and REST
 * GET /api/search + GET /api/recall. Fixture pattern mirrors
 * retrieval-parity-unit.ts (one deterministic mock workspace, real adapter
 * entry points).
 *
 * Run: npm run test:unit:rc321a-keyword-bm25-mcp-rest
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

const WORKSPACE = 'rc321a-ws';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: WORKSPACE, ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

const NODES: Record<string, FNode> = {
    alpha: fnode('alpha'),
    beta: fnode('beta'),
};
const BM25_RANKED = [{ id: 'lore:alpha', score: 5 }, { id: 'lore:beta', score: 3 }];

function buildFixture(opts: { bm25Ranked: boolean }): { searchDeps: SearchDeps; toolDeps: SearchToolsDeps; semanticCalls: number } {
    let semanticCalls = 0;
    const graph = {
        async search() { return []; }, // graph text leg: no supplementary hits in this fixture
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
            async verbatimCount() { return 2; },
            // The embedding-provider proxy: the REAL VerbatimStore.search()
            // calls embeddingProvider.embedQuery() internally. Keyword mode
            // must never reach this — asserted via semanticCalls === 0 below.
            async verbatimSearch() { semanticCalls++; throw new Error('embedding provider must never be touched in keyword mode'); },
            async verbatimBm25Search() { return { hits: BM25_RANKED.map((s) => ({ ...s })), ranked: opts.bm25Ranked }; },
        },
    };
    const graphRegistry = {
        async getOrOpen(_ws: string) { void _ws; return graph; },
        async getGraphHandle(_ws: string) { void _ws; return graph; },
    };
    const detectedScope = { workspace: WORKSPACE, ecosystem: '*' };
    const searchDeps = { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps;
    const toolDeps = { store, detectedScope, graphRegistry } as unknown as SearchToolsDeps;
    return { searchDeps, toolDeps, get semanticCalls() { return semanticCalls; } } as unknown as { searchDeps: SearchDeps; toolDeps: SearchToolsDeps; semanticCalls: number };
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

console.log('RC321a — standalone keyword/BM25 recall across MCP + REST\n');

await test('MCP `search` search_mode:keyword — bm25 hits returned, semantic never called', async () => {
    const { toolDeps } = buildFixture({ bm25Ranked: true });
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'search', { query: 'q', workspace: WORKSPACE, search_mode: 'keyword' });
    assert.equal(out.resultCount, 2);
    assert.deepEqual(out.results.map((r: any) => r.id).sort(), ['alpha', 'beta']);
});

await test('MCP `recall` search_mode:keyword — bm25 hits returned, bm25_ranked absent when ranked', async () => {
    const { toolDeps } = buildFixture({ bm25Ranked: true });
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'recall', { topic: 'q', workspace: WORKSPACE, mode: 'full', search_mode: 'keyword' });
    assert.equal(out.totalRecalled, 2);
    assert.equal(out._meta.bm25_ranked, undefined, 'bm25_ranked is omitted (not false) when genuinely ranked');
});

await test('MCP `recall` search_mode:keyword — unranked bm25 flags _meta.bm25_ranked:false', async () => {
    const { toolDeps } = buildFixture({ bm25Ranked: false });
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'recall', { topic: 'q', workspace: WORKSPACE, mode: 'full', search_mode: 'keyword' });
    assert.equal(out._meta.bm25_ranked, false, 'unranked bm25 must be labelled, not presented as ranked');
    assert.equal(out.totalRecalled, 0, 'the unranked bm25 hits are excluded; fixture graph.search() returns none either');
});

await test('REST GET /api/search?search_mode=keyword — bm25 hits returned', async () => {
    const { searchDeps } = buildFixture({ bm25Ranked: true });
    const rest = await callRest(searchDeps, `/api/search?q=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/search');
    assert.equal(rest.status, 200);
    assert.equal(rest.body.resultCount, 2);
    assert.equal(rest.body.bm25_ranked, undefined, 'ranked bm25 omits the flag');
});

await test('REST GET /api/search?search_mode=keyword — unranked bm25 sets bm25_ranked:false', async () => {
    const { searchDeps } = buildFixture({ bm25Ranked: false });
    const rest = await callRest(searchDeps, `/api/search?q=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/search');
    assert.equal(rest.status, 200);
    assert.equal(rest.body.bm25_ranked, false);
});

await test('REST GET /api/recall?search_mode=keyword — bm25 hits returned via buildRecallResult', async () => {
    const { searchDeps } = buildFixture({ bm25Ranked: true });
    const rest = await callRest(searchDeps, `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/recall');
    assert.equal(rest.status, 200);
    assert.equal(rest.body.totalRecalled, 2);
});

await test('end-to-end: the embedding-provider proxy (verbatimSearch) is never invoked by any keyword-mode surface', async () => {
    const fx = buildFixture({ bm25Ranked: true });
    const mcp = captureMcpTools(fx.toolDeps);
    await callMcp(mcp, 'search', { query: 'q', workspace: WORKSPACE, search_mode: 'keyword' });
    await callMcp(mcp, 'recall', { topic: 'q', workspace: WORKSPACE, search_mode: 'keyword' });
    await callRest(fx.searchDeps, `/api/search?q=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/search');
    await callRest(fx.searchDeps, `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/recall');
    assert.equal(fx.semanticCalls, 0, 'verbatimSearch (the embedding-provider proxy) must be called zero times across every keyword-mode surface');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
