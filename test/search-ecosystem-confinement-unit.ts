#!/usr/bin/env tsx
/**
 * search-ecosystem-confinement-unit.ts — the ecosystem boundary must hold on
 * the READ surfaces, not only on `recall`.
 *
 * `retrieve.ts` is the ONE shared retrieval core, and its own header sells
 * ecosystem as the tenant boundary "for any embedding host that uses one Lore
 * workspace to serve multiple isolated tenants via ecosystem scoping". But the
 * boundary is a PARAMETER, and `ecosystemScope = ecosystem ?? '*'` — so a
 * caller that simply omits it gets search-EVERYTHING, with the seed filter AND
 * the per-hop filter both reduced to no-ops.
 *
 * Four read surfaces omitted it while three passed it:
 *
 *   E1 — MCP `search` tool (tools/search/searchTool.ts) called
 *        `retrieve(ctx, query, { workspace, mode, depth: 0, limit, tags })`.
 *        `deps.detectedScope.ecosystem` was right there — recallTool.ts on the
 *        same deps object passes it — and the response even REPORTED the scope
 *        it was not enforcing. Full node content is returned.
 *   E2 — GET /api/search (http/routes/search.ts) — same omission, same file as
 *        GET /api/recall, which passes it two hundred lines above.
 *   E3 — POST /api/query — no scoping at all: an unfiltered verbatim seed and
 *        a keyword search with a hardcoded '*'.
 *   E4 — GET /api/node/supersession-candidates — project-filtered only, so it
 *        proposed supersession pairs ACROSS ecosystems, each card carrying 240
 *        chars of both nodes' content.
 *
 * Nothing in either tool's description or the route comments said search was
 * deliberately unscoped; the asymmetry was an oversight, not a decision. These
 * tests drive the REAL entry points and pin that all four now confine, that the
 * confining surfaces agree with `recall` on the same fixture, and that '*' (the
 * default detected scope, and every install that never sets an ecosystem)
 * keeps search-everything exactly as before.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import { handleSupersessionCandidates } from '../packages/lore/src/mcp/http/routes/nodes/supersessionCandidates.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'shared-ws';
const MINE = 'tenant-alpha';
const THEIRS = 'tenant-beta';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; createdAt: string;
    supersededAt?: string | null;
};
const fnode = (id: string, ecosystem: string): FNode => ({
    id, type: 'decision', label: `Label ${id}`, content: `secret body for ${id} about auth tokens`,
    tags: ['auth'], project: WORKSPACE, ecosystem,
    updatedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z', supersededAt: null,
});

/** One shared workspace, two tenants separated ONLY by ecosystem. */
const NODES: Record<string, FNode> = {
    'mine-1': fnode('mine-1', MINE),
    'theirs-1': fnode('theirs-1', THEIRS),
};
const SEMANTIC = [{ id: 'lore:theirs-1', score: 0.98 }, { id: 'lore:mine-1', score: 0.91 }];

/**
 * `detectedEcosystem` is what the daemon detected for this caller. The whole
 * question is whether a surface passes it to the core.
 */
function buildFixture(detectedEcosystem: string): {
    searchDeps: SearchDeps;
    toolDeps: SearchToolsDeps;
    keywordScopes: Array<{ project: string; ecosystem: string }>;
} {
    const keywordScopes: Array<{ project: string; ecosystem: string }> = [];
    const graph = {
        async search(_q: string, _n: number, project: string, ecosystem: string, _hidden?: boolean, signals?: { scanCapHit: boolean }) {
            keywordScopes.push({ project, ecosystem });
            if (signals) signals.scanCapHit = false;
            // A store honouring the pushdown; '*' means everything.
            return Object.values(NODES)
                .filter((n) => ecosystem === '*' || n.ecosystem === ecosystem)
                .map((x) => ({ ...x }));
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse() { return []; },
        async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        async listNodes(_t?: unknown, _tag?: unknown, _p?: unknown, _e?: unknown, _l?: unknown) {
            return Object.values(NODES).map((x) => ({ ...x }));
        },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return Object.keys(NODES).length; },
            async verbatimSearch(_q: string, _n: number, filter?: { ecosystem?: string }) {
                // The vector store honours the pushdown against the row's own
                // (correct) metadata.
                return SEMANTIC
                    .filter((s) => !filter?.ecosystem || NODES[s.id.slice(5)]!.ecosystem === filter.ecosystem)
                    .map((s) => ({ ...s }));
            },
            async verbatimBm25Search() { return { hits: [], ranked: true }; },
        },
    };
    const graphRegistry = {
        async getOrOpen() { return graph; },
        async getGraphHandle() { return graph; },
    };
    const detectedScope = { workspace: WORKSPACE, ecosystem: detectedEcosystem };
    return {
        searchDeps: { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps,
        toolDeps: { store, detectedScope, graphRegistry } as unknown as SearchToolsDeps,
        keywordScopes,
    };
}

/* ─── Surface drivers (REAL entry points) ─────────────────────────────── */

type McpHandler = (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
function captureMcpTools(toolDeps: SearchToolsDeps): Map<string, McpHandler> {
    const handlers = new Map<string, McpHandler>();
    const fake = { tool(name: string, _d: string, _s: unknown, h: McpHandler) { handlers.set(name, h); } };
    registerSearchTool(fake as unknown as McpServer, toolDeps);
    registerRecallTool(fake as unknown as McpServer, toolDeps);
    return handlers;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

async function callGet(deps: SearchDeps, url: string, pathname: string): Promise<Record<string, unknown>> {
    const res = fakeRes();
    const handled = await trySearchRoutes({ method: 'GET', url } as unknown as IncomingMessage, res, url, pathname, deps);
    assert.ok(handled, `route not handled: ${pathname}`);
    assert.equal(res._status, 200, `${pathname} -> ${res._status}: ${res._body}`);
    return JSON.parse(res._body) as Record<string, unknown>;
}

async function callPostQuery(deps: SearchDeps, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let consumed = false;
    const req = {
        method: 'POST', url: '/api/query',
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(JSON.stringify(body), 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
    const res = fakeRes();
    await trySearchRoutes(req, res, '/api/query', '/api/query', deps);
    assert.equal(res._status, 200, `/api/query -> ${res._status}: ${res._body}`);
    return JSON.parse(res._body) as Record<string, unknown>;
}

const idsOf = (rows: unknown): string[] => (rows as Array<{ id: string }>).map((r) => r.id);

console.log('\nEcosystem confinement on the SEARCH surfaces\n');

/* ─── E1: MCP search tool ─────────────────────────────────────────────── */

await test('E1: the MCP `search` tool confines results to the detected ecosystem', async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must be returned');
    assert.ok(!ids.includes('theirs-1'), `another tenant's node returned by search (with full content): ${ids.join(', ')}`);
});

await test('E1: `search` and `recall` agree on the boundary for the same query', async () => {
    // They read the same core over the same substrates; disagreeing about who
    // may see what is the drift this pins.
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const search = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const recall = JSON.parse((await handlers.get('recall')!({ topic: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const recallIds = ((recall.results ?? recall.nodes ?? []) as Array<{ id: string }>).map((r) => r.id);
    assert.ok(!idsOf(search.results).includes('theirs-1'));
    assert.ok(!recallIds.includes('theirs-1'), 'recall was already confined — search must match it');
});

await test("E1: an unset ('*') detected ecosystem still searches everything", async () => {
    // The default from resolveWorkspaceScope, and every install that never sets
    // an ecosystem. Confinement must not switch search off for them.
    const { toolDeps } = buildFixture('*');
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `'*' must remain search-everything: ${ids.join(', ')}`);
});

/* ─── E2: GET /api/search ─────────────────────────────────────────────── */

await test('E2: GET /api/search confines results to the detected ecosystem', async () => {
    const { searchDeps } = buildFixture(MINE);
    const body = await callGet(searchDeps, `/api/search?q=auth&workspace=${WORKSPACE}`, '/api/search');
    const ids = idsOf(body.results);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must be returned');
    assert.ok(!ids.includes('theirs-1'), `REST search leaked another tenant's node: ${ids.join(', ')}`);
});

await test('E2: GET /api/search and GET /api/recall agree on the boundary', async () => {
    const { searchDeps } = buildFixture(MINE);
    const search = await callGet(searchDeps, `/api/search?q=auth&workspace=${WORKSPACE}`, '/api/search');
    const recall = await callGet(searchDeps, `/api/recall?topic=auth&workspace=${WORKSPACE}`, '/api/recall');
    assert.ok(!idsOf(search.results).includes('theirs-1'));
    const recallIds = JSON.stringify(recall);
    assert.ok(!recallIds.includes('theirs-1'), 'recall was already confined — search must match it');
});

await test("E2: GET /api/search with an unset ('*') scope is unchanged", async () => {
    const { searchDeps } = buildFixture('*');
    const body = await callGet(searchDeps, `/api/search?q=auth&workspace=${WORKSPACE}`, '/api/search');
    const ids = idsOf(body.results);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `'*' must remain search-everything: ${ids.join(', ')}`);
});

/* ─── E3: POST /api/query ─────────────────────────────────────────────── */

await test('E3: POST /api/query confines BOTH its vector seeds and its keyword scan', async () => {
    const { searchDeps, keywordScopes } = buildFixture(MINE);
    const body = await callPostQuery(searchDeps, { query: 'auth', workspace: WORKSPACE });
    const ids = idsOf(body.results);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must be returned');
    assert.ok(!ids.includes('theirs-1'), `/api/query leaked another tenant's node: ${ids.join(', ')}`);
    assert.ok(
        keywordScopes.every((s) => s.ecosystem === MINE),
        `the keyword scan must be pushed down with the ecosystem, not a hardcoded '*': ${JSON.stringify(keywordScopes)}`,
    );
});

await test("E3: POST /api/query with an unset ('*') scope is unchanged", async () => {
    const { searchDeps } = buildFixture('*');
    const body = await callPostQuery(searchDeps, { query: 'auth', workspace: WORKSPACE });
    const ids = idsOf(body.results);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `'*' must remain search-everything: ${ids.join(', ')}`);
});

/* ─── E4: GET /api/node/supersession-candidates ───────────────────────── */

/** The route reads `bulkListProjected` when present; this fixture returns the
 *  projected rows directly so the real pairing logic runs. */
function supersessionDeps(rows: FNode[]) {
    const graph = {
        async bulkListProjected(_project: string, _cols: readonly string[], _limit: number, cursor: unknown) {
            if (cursor) return { rows: [], nextCursor: null };
            return { rows: rows.map((r) => ({ ...r })), nextCursor: null };
        },
        async listNodes() { return rows.map((r) => ({ ...r })); },
    };
    return {
        deploymentMode: 'local' as const,
        dataplane: null,
        store: {
            loreGraph: graph,
            storageClient: {
                // Every node's nearest neighbour is the OTHER node — so without
                // confinement the route proposes a cross-tenant pair.
                async verbatimSearch(q: string) {
                    return rows
                        .filter((r) => !q.includes(r.id))
                        .map((r) => ({ id: `lore:${r.id}`, score: 0.95 }));
                },
            },
        },
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
    } as unknown as Parameters<typeof handleSupersessionCandidates>[2];
}

await test('E4: supersession candidates are NOT proposed across ecosystems', async () => {
    const res = fakeRes();
    await handleSupersessionCandidates(
        res,
        `/api/node/supersession-candidates?workspace=${WORKSPACE}&fresh=true&minScore=0.5`,
        supersessionDeps([fnode('mine-1', MINE), fnode('theirs-1', THEIRS)]),
    );
    assert.equal(res._status, 200, res._body);
    const body = JSON.parse(res._body) as { pairs: Array<{ oldId: string; newId: string }> };
    assert.deepEqual(
        body.pairs, [],
        `a supersession card was proposed across the tenant boundary, carrying both nodes' content: ${JSON.stringify(body.pairs)}`,
    );
});

await test('E4: same-ecosystem candidates ARE still proposed (not just switched off)', async () => {
    const res = fakeRes();
    await handleSupersessionCandidates(
        res,
        `/api/node/supersession-candidates?workspace=${WORKSPACE}&fresh=true&minScore=0.5`,
        supersessionDeps([fnode('mine-1', MINE), fnode('mine-2', MINE)]),
    );
    const body = JSON.parse(res._body) as { pairs: unknown[] };
    assert.equal(body.pairs.length, 1, 'a real same-ecosystem pair must still surface');
});

await test("E4: unscoped ('*') nodes still pair — wildcard, per reconnect.ts's documented decision", async () => {
    const res = fakeRes();
    await handleSupersessionCandidates(
        res,
        `/api/node/supersession-candidates?workspace=${WORKSPACE}&fresh=true&minScore=0.5`,
        supersessionDeps([fnode('any-1', '*'), fnode('mine-3', MINE)]),
    );
    const body = JSON.parse(res._body) as { pairs: unknown[] };
    assert.equal(body.pairs.length, 1, "'*' is the schema default — confining it would switch the route off for most installs");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
