#!/usr/bin/env tsx
/**
 * test/rc321c-null-embedder-mcp-rest-unit.ts — Lore 3.21 step 3(c), MCP + REST.
 *
 * Pins that `vector_leg_skipped` — the "embeddings are disabled, the
 * semantic fetch was skipped" signal — surfaces through every client-facing
 * surface: the MCP `search` + `recall` tools, and REST GET /api/search +
 * GET /api/recall. Uses a mock storageClient whose semantic method throws
 * `EmbeddingDisabledError` (the exact contract NullEmbeddingProvider's
 * embedQuery() produces once VerbatimStore.search() calls it) against a
 * store that HAS rows (count()>0), so the semantic fetch is genuinely
 * attempted and caught — the scenario a previously-embedded workspace
 * whose provider gets disabled hits in production. Fixture pattern mirrors
 * retrieval-parity-unit.ts / rc321a-keyword-bm25-mcp-rest-unit.ts.
 *
 * Run: npm run test:unit:rc321c-null-embedder-mcp-rest
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';
import { EmbeddingDisabledError } from '../packages/lore/src/providers/nullEmbeddingProvider.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'rc321c-ws';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
};
const fnode = (id: string): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: WORKSPACE, ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
});
const NODES: Record<string, FNode> = { kw: fnode('kw') };

function buildFixture(): { searchDeps: SearchDeps; toolDeps: SearchToolsDeps } {
    const graph = {
        async search() { return [NODES.kw!]; },
        async getNodesByIds() { return new Map<string, FNode>(); },
        async traverse() { return []; },
        async getNode(id: string) { return NODES[id] ?? null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return 5; }, // rows exist from before embeddings were disabled
            async verbatimSearch() { throw new EmbeddingDisabledError('embedQuery'); },
            async verbatimBm25Search() { return { hits: [], ranked: true }; },
        },
    };
    const graphRegistry = {
        async getOrOpen(_ws: string) { void _ws; return graph; },
        async getGraphHandle(_ws: string) { void _ws; return graph; },
    };
    const detectedScope = { workspace: WORKSPACE, ecosystem: '*' };
    const searchDeps = { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps;
    const toolDeps = { store, detectedScope, graphRegistry } as unknown as SearchToolsDeps;
    return { searchDeps, toolDeps };
}

function captureMcpTools(toolDeps: SearchToolsDeps): Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = { tool(name: string, _d: string, _s: unknown, h: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) { handlers.set(name, h); } };
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

console.log('RC321c — vector_leg_skipped across MCP + REST\n');

await test('MCP `search` (default hybrid mode) — never throws, vector_leg_skipped:true in _meta', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'search', { query: 'q', workspace: WORKSPACE, search_mode: 'hybrid' });
    assert.equal(out._meta.vector_leg_skipped, true);
    assert.deepEqual(out.results.map((r: any) => r.id), ['kw']);
});

await test('MCP `recall` (default hybrid mode) — never throws, _meta.vector_leg_skipped:true', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const out = await callMcp(mcp, 'recall', { topic: 'q', workspace: WORKSPACE, mode: 'full' });
    assert.equal(out._meta.vector_leg_skipped, true);
    assert.equal(out.totalRecalled, 1);
});

await test('REST GET /api/search (default hybrid) — never throws, vector_leg_skipped:true', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(searchDeps, `/api/search?q=q&workspace=${WORKSPACE}`, '/api/search');
    assert.equal(rest.status, 200);
    assert.equal(rest.body.vector_leg_skipped, true);
});

await test('REST GET /api/recall (default hybrid) — never throws, _meta.vector_leg_skipped:true', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(searchDeps, `/api/recall?topic=q&workspace=${WORKSPACE}`, '/api/recall');
    assert.equal(rest.status, 200);
    assert.equal(rest.body._meta.vector_leg_skipped, true);
});

await test('keyword mode surfaces are unaffected: vector_leg_skipped absent (never attempted the semantic leg at all)', async () => {
    const { toolDeps, searchDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const mcpOut = await callMcp(mcp, 'recall', { topic: 'q', workspace: WORKSPACE, mode: 'full', search_mode: 'keyword' });
    assert.equal(mcpOut._meta.vector_leg_skipped, undefined);
    const rest = await callRest(searchDeps, `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword`, '/api/recall');
    assert.equal(rest.body._meta.vector_leg_skipped, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
