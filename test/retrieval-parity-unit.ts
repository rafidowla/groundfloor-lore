#!/usr/bin/env tsx
/**
 * retrieval-parity-unit.ts — Retrieval Unification P4: CROSS-SURFACE parity.
 *
 * The anti-drift guarantee. DIFFERENT from parity-graph-unit.ts (which proves
 * local-Kùzu vs cloud-Dataplane backend parity). This proves that for the SAME
 * query on the SAME workspace, the SURFACES agree — because every surface is a
 * thin adapter over the one retrieve() core (docs/RETRIEVAL_UNIFICATION.md):
 *
 *   - MCP `search` tool  ==  REST GET /api/search
 *        → identical id sequence + matchedBy + score.
 *   - MCP `recall` tool  ==  embedded inProcessRecall  ==  REST GET /api/recall
 *        → identical RecallResult (ids, order, _meta incl.
 *          vector_index_consulted + sources_consulted).
 *
 * A single fixtured workspace is built once (a deterministic in-memory mock
 * store + registry — no native Kùzu/LanceDB), then each surface's REAL entry
 * point runs against it. If any adapter ever re-parses params differently,
 * skips the core, or projects a different shape, one of these assertions fails
 * — which is the point: future drift fails CI.
 *
 * Run: npm run test:unit:retrieval-parity
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import { inProcessRecall } from '../packages/lore/src/recall/inProcessRecall.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'parity-ws';

/* ─── Fixture: one deterministic in-memory workspace ────────────────────────
 * Same object is returned by store.loreGraph AND registry.getOrOpen() so the
 * core treats it as the ACTIVE workspace (verbatimConsulted=true → the
 * semantic + BM25 path runs, exercising matchedBy/score/_meta fully). */

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
    status?: string; supersededAt?: string | null;
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id} about auth tokens`,
    tags: ['auth'], project: WORKSPACE, ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

const NODES: Record<string, FNode> = {
    alpha: fnode('alpha', { content: 'alpha: jwt auth token rotation policy', tags: ['auth', 'security'] }),
    beta: fnode('beta', { content: 'beta: oauth refresh token handling', tags: ['auth'] }),
    gamma: fnode('gamma', { content: 'gamma: a related neighbour reached via traversal', tags: ['auth'] }),
};
// Vector seeds (real ids are 'lore:'-prefixed in the verbatim store).
const SEMANTIC = [{ id: 'lore:alpha', score: 0.9 }, { id: 'lore:beta', score: 0.72 }];
const BM25 = [{ id: 'lore:beta', score: 5 }, { id: 'lore:alpha', score: 4 }];
const TRAVERSE: Record<string, Array<{ node: FNode; depth: number }>> = {
    alpha: [{ node: NODES.gamma!, depth: 1 }],
    beta: [],
};

function buildFixture(): { searchDeps: SearchDeps; toolDeps: SearchToolsDeps } {
    const graph = {
        async search(q: string, n: number, _ws?: string, _eco?: string, _hidden?: boolean, _signals?: { scanCapHit: boolean }) {
            // Keyword fallback path (used only when the vector index is empty).
            // Full signature mirrors RetrievalGraph.search (incl. the P16 signals out-param).
            void q; void n; return Object.values(NODES).map((x) => ({ ...x }));
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse(id: string) { return (TRAVERSE[id] ?? []).map((h) => ({ node: { ...h.node }, depth: h.depth })); },
        async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        async listNodes() { return []; },                       // deferred sidecar: none
        async getLanguageBreakdown() { return {}; },            // only used with queryLanguage
    };
    const store = {
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return 3; },
            async verbatimSearch(q: string, n: number) { void q; void n; return SEMANTIC.map((s) => ({ ...s })); },
            async verbatimBm25Search(q: string, n: number) { void q; void n; return { hits: BM25.map((s) => ({ ...s })), ranked: true }; },
        },
    };
    // getOrOpen MUST return the same object as loreGraph so the core sees the
    // active workspace (graph === bootGraph) and the semantic path engages.
    const graphRegistry = {
        // Both accessors return the SAME object as store.loreGraph — that
        // identity is what lets the core treat this as the active workspace.
        // Production resolves graphs via getGraphHandle now; getOrOpen stays
        // the Kùzu-substrate accessor.
        async getOrOpen(_ws: string) { void _ws; return graph; },
        async getGraphHandle(_ws: string) { void _ws; return graph; },
    };

    const detectedScope = { workspace: WORKSPACE, ecosystem: '*' };
    const searchDeps = {
        store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry,
    } as unknown as SearchDeps;
    const toolDeps = {
        store, detectedScope, graphRegistry,
    } as unknown as SearchToolsDeps;
    return { searchDeps, toolDeps };
}

/* ─── Surface drivers (exercise the REAL adapter entry points) ──────────────*/

/** Capture MCP tool handlers registered on a fake McpServer. */
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

/** Drive a GET route through trySearchRoutes with a mock req/res. */
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

/* ─── Tests ─────────────────────────────────────────────────────────────────*/

console.log('Retrieval Unification P4 — cross-surface parity\n');

await test('search: MCP `search` tool == REST /api/search (id sequence + matchedBy + score)', async () => {
    const { searchDeps, toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);

    const mcpOut = await callMcp(mcp, 'search', { query: 'auth token', workspace: WORKSPACE, search_mode: 'hybrid' });
    const rest = await callRest(searchDeps, `/api/search?q=${encodeURIComponent('auth token')}&workspace=${WORKSPACE}`, '/api/search');
    assert.equal(rest.status, 200, 'REST search must be 200');

    const slim = (results: any[]) => results.map((r) => ({ id: r.id, matchedBy: [...r.matchedBy].sort(), score: r.score }));
    const mcpSlim = slim(mcpOut.results);
    const restSlim = slim(rest.body.results);

    assert.ok(mcpSlim.length > 0, 'fixture must produce results');
    assert.equal(mcpOut.resultCount, rest.body.resultCount, 'resultCount must match');
    assert.deepEqual(mcpSlim, restSlim, 'MCP search and REST /api/search must return identical id/matchedBy/score');
    // Full projected item parity too (catches any field-level projection drift).
    assert.deepEqual(mcpOut.results, rest.body.results, 'projected result items must be byte-identical');
});

await test('recall: MCP `recall` == embedded inProcessRecall == REST /api/recall (RecallResult)', async () => {
    const { searchDeps, toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const topic = 'auth token';

    // MCP recall tool (strip the surface-only `tip` helper field).
    const mcpRaw = await callMcp(mcp, 'recall', { topic, workspace: WORKSPACE, mode: 'summary', search_mode: 'hybrid' });
    const { tip: _tip, ...mcpRecall } = mcpRaw;

    // Embedded recall — max=10 to match the MCP tool's fixed SEED_LIMIT.
    const embedded = await inProcessRecall(topic, { workspace: WORKSPACE, mode: 'summary', searchMode: 'hybrid', max: 10 }, { store: searchDeps.store, graphRegistry: (searchDeps as any).graphRegistry });

    // REST /api/recall — max=10 (its default is 8) so the limit matches.
    const rest = await callRest(searchDeps, `/api/recall?topic=${encodeURIComponent(topic)}&workspace=${WORKSPACE}&max=10`, '/api/recall');
    assert.equal(rest.status, 200, 'REST recall must be 200');

    // Sanity: the fixture must actually exercise the semantic path + traversal.
    assert.equal(mcpRecall.mode, 'summary');
    assert.equal(mcpRecall._meta.vector_index_consulted, true, 'vector index should be consulted (active workspace)');
    assert.equal(mcpRecall._meta.sources_consulted, 2, 'semantic + keyword = 2 sources');
    assert.ok(mcpRecall.hits.length > 0, 'recall must return hits');

    assert.deepEqual(embedded, mcpRecall, 'embedded recall must equal the MCP recall tool');
    assert.deepEqual(rest.body, mcpRecall, 'REST /api/recall must equal the MCP recall tool');
});

await test('recall _meta is consistent across surfaces (vector_index_consulted + sources_consulted)', async () => {
    const { searchDeps, toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const topic = 'auth token';

    const mcpRaw = await callMcp(mcp, 'recall', { topic, workspace: WORKSPACE, mode: 'summary' });
    const embedded = await inProcessRecall(topic, { workspace: WORKSPACE, max: 10 }, { store: searchDeps.store, graphRegistry: (searchDeps as any).graphRegistry });
    const rest = await callRest(searchDeps, `/api/recall?topic=${encodeURIComponent(topic)}&workspace=${WORKSPACE}&max=10`, '/api/recall');

    for (const meta of [mcpRaw._meta, embedded._meta, rest.body._meta]) {
        assert.equal(meta.vector_index_consulted, true);
        assert.equal(meta.sources_consulted, 2);
    }
    assert.deepEqual(embedded._meta, mcpRaw._meta);
    assert.deepEqual(rest.body._meta, mcpRaw._meta);
});

await test('REST /api/search honours search_mode + tags (P7/P8)', async () => {
    const { searchDeps } = buildFixture();
    // P8 — tags filter: only `alpha` carries the 'security' tag in the fixture.
    const tagged = await callRest(
        searchDeps,
        `/api/search?q=${encodeURIComponent('auth token')}&workspace=${WORKSPACE}&tags=security`,
        '/api/search',
    );
    assert.equal(tagged.status, 200, 'tagged REST search must be 200');
    assert.deepEqual(tagged.body.results.map((r: any) => r.id), ['alpha'], 'tags=security must filter to alpha only');
    assert.deepEqual(tagged.body.tag_filter, ['security'], 'tag_filter must be echoed');
    // P7 — an explicit, valid search_mode is accepted (keyword path returns hits).
    const kw = await callRest(
        searchDeps,
        `/api/search?q=${encodeURIComponent('auth token')}&workspace=${WORKSPACE}&search_mode=keyword`,
        '/api/search',
    );
    assert.equal(kw.status, 200, 'search_mode=keyword must be accepted (200)');
    assert.ok(kw.body.results.length > 0, 'keyword mode must still return results');
    // P7 — an unrecognised search_mode is rejected, not silently coerced.
    const bad = await callRest(
        searchDeps,
        `/api/search?q=x&workspace=${WORKSPACE}&search_mode=bogus`,
        '/api/search',
    );
    assert.equal(bad.status, 400, 'invalid search_mode must 400');
    assert.equal(bad.body.code, 'invalid_search_mode', 'error code must be invalid_search_mode');
});

await test('P16: scan_cap_hit surfaces on REST search + recall when the engine reports it', async () => {
    // Minimal fixture whose keyword search reports a cap hit and whose vector
    // index is empty (forcing retrieve()'s keyword branch, which is the only one
    // that scans under SEARCH_SCAN_CAP).
    const node = fnode('solo', { content: 'auth token doc', tags: ['auth'] });
    const graph = {
        async search(_q: string, _n: number, _ws?: string, _eco?: string, _hidden?: boolean, signals?: { scanCapHit: boolean }) {
            if (signals) signals.scanCapHit = true;            // engine hit the scan cap
            return [{ ...node }];
        },
        async getNodesByIds() { return new Map(); },
        async traverse() { return []; },
        async getNode(id: string) { return id === 'solo' ? { ...node } : null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        loreGraph: graph, loreVerbatim: {}, sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return 0; },               // empty vector index → keyword path runs
            async verbatimSearch() { return []; },
            async verbatimBm25Search() { return []; },
        },
    };
    const graphRegistry = {
        // Both accessors return the SAME object as store.loreGraph — that
        // identity is what lets the core treat this as the active workspace.
        // Production resolves graphs via getGraphHandle now; getOrOpen stays
        // the Kùzu-substrate accessor.
        async getOrOpen(_ws: string) { void _ws; return graph; },
        async getGraphHandle(_ws: string) { void _ws; return graph; },
    };
    const searchDeps = {
        store, detectedScope: { workspace: WORKSPACE, ecosystem: '*' },
        deploymentMode: 'local', dataplane: null, graphRegistry,
    } as unknown as SearchDeps;

    const search = await callRest(searchDeps, `/api/search?q=auth&workspace=${WORKSPACE}`, '/api/search');
    assert.equal(search.status, 200, 'REST search must be 200');
    assert.equal(search.body.scan_cap_hit, true, 'REST /api/search must surface scan_cap_hit when the scan was capped');

    const recall = await callRest(searchDeps, `/api/recall?topic=auth&workspace=${WORKSPACE}&max=10`, '/api/recall');
    assert.equal(recall.status, 200, 'REST recall must be 200');
    assert.equal(recall.body._meta.scan_cap_hit, true, 'REST /api/recall _meta must surface scan_cap_hit');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
