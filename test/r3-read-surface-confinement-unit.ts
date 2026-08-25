#!/usr/bin/env tsx
/**
 * r3-read-surface-confinement-unit.ts — the read surfaces round 2 left behind,
 * and the scope value they read it from.
 *
 *   C1 — `structured_query`. Registered by the SAME
 *        `registerSearchTools(mcpServer, deps)` call as `search`, off the SAME
 *        `SearchToolsDeps` (which carries `detectedScope`), returning FULL node
 *        `content` — and completely unscoped: an unfiltered
 *        `deps.store.storageClient.verbatimSearch(query, limit)` seed plus
 *        `graphForQuery.search(query, ..., '*', '*')`. Those are the exact two
 *        lines the /api/query fix changed. It does not go through `retrieve()`,
 *        so "all five retrieve() call sites now pass ecosystem" never touched
 *        it: on one workspace with two tenants, `search` returned ['mine-1']
 *        while `structured_query` returned ['theirs-1','mine-1'].
 *
 *   C2 — `structured_query` also seeded from the BOOT `storageClient`, which
 *        only ever sees the ACTIVE workspace's LanceDB.
 *        `recall/retrieve.ts:243-248` names that "the exact confinement bug";
 *        /api/query was fixed for it and this sibling was not.
 *
 *   C3 — POST /api/query's keyword fallback passed the WORKSPACE NAME as the
 *        PROJECT scope. `localGraphReads.ts` turns that into a strict
 *        `n.project = $project`, and `project` is a caller-owned field that is
 *        not guaranteed to equal the workspace (Atlas stores project='v3'
 *        inside workspace='default'). retrieve.ts:314-321 documents this exact
 *        mistake as the one that "silently makes keyword fallback empty while
 *        the vector path still appears healthy" — and round 2 edited that very
 *        call to add the ecosystem argument beside the wrong project argument.
 *
 *   C4 — the `traverse` MCP tool walks `targetGraph.traverse(nodeId, depth)`
 *        with NO per-hop filter and returns `content` for every neighbour.
 *        retrieve.ts:551-559 added its per-hop filter precisely because
 *        "graph.traverse() walks LoreEdge with no ecosystem predicate, so a
 *        correctly-scoped seed could still pull a DIFFERENT ecosystem's node
 *        into the result set across an edge". This tool is that same walk.
 *
 *   C5 — the value threaded in as "the tenant boundary" was
 *        `deps.detectedScope.ecosystem`, which `resolveWorkspaceScope`
 *        (bootSteps.ts) derives ONCE at boot by substring-matching
 *        `process.cwd()` against workspace-paths.json. It is process-global:
 *        not per-request, not per-token, and it does not vary with the
 *        requested workspace — the codebase already outlawed exactly this
 *        pattern for the workspace axis (security/routeWorkspaceBinding.ts:
 *        "NEVER consults detectedScope / getActiveWorkspaceName / any boot
 *        value"). So the surfaces now take a CALLER-SUPPLIED `ecosystem`, with
 *        the detected value demoted to a default.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerStructuredQueryTool } from '../packages/lore/src/mcp/tools/search/structuredQueryTool.js';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { registerTraverseTool } from '../packages/lore/src/mcp/tools/traverse.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
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
const fnode = (id: string, ecosystem: string, project = 'a-project-that-is-not-the-workspace'): FNode => ({
    id, type: 'decision', label: `Label ${id}`, content: `secret body for ${id} about auth tokens`,
    tags: ['auth'], project, ecosystem,
    updatedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z', supersededAt: null,
});

const NODES: Record<string, FNode> = {
    'mine-1': fnode('mine-1', MINE),
    'theirs-1': fnode('theirs-1', THEIRS),
};
const SEMANTIC = [{ id: 'lore:theirs-1', score: 0.98 }, { id: 'lore:mine-1', score: 0.91 }];

type Scope = { project: string; ecosystem: string };

function buildFixture(detectedEcosystem: string) {
    const keywordScopes: Scope[] = [];
    const bootVerbatimCalls: string[] = [];
    const wsVerbatimCalls: string[] = [];
    const graph = {
        async search(_q: string, _n: number, project: string, ecosystem: string, _hidden?: boolean, signals?: { scanCapHit: boolean }) {
            keywordScopes.push({ project, ecosystem });
            if (signals) signals.scanCapHit = false;
            return Object.values(NODES)
                .filter((n) => project === '*' || n.project === project)
                .filter((n) => ecosystem === '*' || n.ecosystem === ecosystem || n.ecosystem === '*')
                .map((x) => ({ ...x }));
        },
        async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse() { return []; },
        async listNodes() { return Object.values(NODES).map((x) => ({ ...x })); },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        // NOT the workspace graph: the boot handle. Resolving the requested
        // workspace must produce `graph` (below) via the registry, so any code
        // that seeds off `store.storageClient` is seeding off the WRONG store.
        loreGraph: { ...graph, __boot: true },
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { bootVerbatimCalls.push('count'); return Object.keys(NODES).length; },
            async verbatimSearch(_q: string, _n: number, filter?: { ecosystem?: string }) {
                bootVerbatimCalls.push('search');
                return SEMANTIC
                    .filter((s) => !filter?.ecosystem || NODES[s.id.slice(5)]!.ecosystem === filter.ecosystem)
                    .map((s) => ({ ...s }));
            },
            async verbatimBm25Search() { return { hits: [], ranked: true }; },
        },
    };
    const workspaceVerbatimResolver = {
        async getOrOpen(_ws: string) {
            return {
                async count() { wsVerbatimCalls.push('count'); return SEMANTIC.length; },
                async search(_q: string, _n: number) { wsVerbatimCalls.push('search'); return SEMANTIC.map((s) => ({ ...s })); },
                async bm25Search() { return { hits: [], ranked: true }; },
            };
        },
    };
    const graphRegistry = {
        async getOrOpen() { return graph; },
        async getGraphHandle() { return graph; },
    };
    const detectedScope = { workspace: WORKSPACE, ecosystem: detectedEcosystem };
    return {
        keywordScopes, bootVerbatimCalls, wsVerbatimCalls,
        searchDeps: { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry, workspaceVerbatimResolver } as unknown as SearchDeps,
        toolDeps: { store, detectedScope, graphRegistry, workspaceVerbatimResolver } as unknown as SearchToolsDeps,
    };
}

type McpHandler = (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
function captureTools(toolDeps: SearchToolsDeps): Map<string, McpHandler> {
    const handlers = new Map<string, McpHandler>();
    const fake = { tool(name: string, _d: string, _s: unknown, h: McpHandler) { handlers.set(name, h); } };
    registerStructuredQueryTool(fake as unknown as McpServer, toolDeps);
    registerSearchTool(fake as unknown as McpServer, toolDeps);
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

console.log('\nThe read surfaces round 2 left behind\n');

/* ─── C1: structured_query confinement ────────────────────────────────── */

await test('C1: `structured_query` confines results to the ecosystem, like its sibling `search`', async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureTools(toolDeps);
    const out = JSON.parse((await handlers.get('structured_query')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must still be returned');
    assert.ok(!ids.includes('theirs-1'), `structured_query returned another tenant's node WITH full content: ${ids.join(', ')}`);
});

await test('C1: `structured_query` and `search` agree on the boundary for the same query', async () => {
    // They are registered side by side off one deps object over one substrate.
    // Disagreeing about who may see what is the drift this pins.
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureTools(toolDeps);
    const sq = JSON.parse((await handlers.get('structured_query')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const se = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    assert.deepEqual(
        idsOf(sq.results).sort(), idsOf(se.results).sort(),
        'search was fixed and structured_query was not — the two disagree about the tenant boundary',
    );
});

await test("C1: an unset ('*') scope leaves `structured_query` searching everything", async () => {
    const { toolDeps } = buildFixture('*');
    const handlers = captureTools(toolDeps);
    const out = JSON.parse((await handlers.get('structured_query')!({ query: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `'*' must remain search-everything: ${ids.join(', ')}`);
});

/* ─── C2: structured_query seeds from the REQUESTED workspace ──────────── */

await test('C2: `structured_query` seeds from the REQUESTED workspace\'s verbatim store, not the boot handle', async () => {
    const { toolDeps, bootVerbatimCalls, wsVerbatimCalls } = buildFixture('*');
    const handlers = captureTools(toolDeps);
    await handlers.get('structured_query')!({ query: 'auth', workspace: WORKSPACE });
    assert.ok(wsVerbatimCalls.length > 0, 'the requested workspace\'s own verbatim store must be consulted');
    assert.deepEqual(
        bootVerbatimCalls, [],
        `seeded from the BOOT storageClient (${bootVerbatimCalls.join(',')}) — retrieve.ts:243-248 calls that "the exact confinement bug"`,
    );
});

/* ─── C3: POST /api/query keyword project scope ───────────────────────── */

await test("C3: POST /api/query's keyword fallback scopes project='*', not the workspace name", async () => {
    // Every fixture node carries a project that is NOT the workspace name —
    // the ordinary Atlas shape. Passing the workspace as the project makes the
    // fallback return nothing while the vector path still looks healthy.
    const { searchDeps, keywordScopes } = buildFixture('*');
    const body = await callPostQuery(searchDeps, { query: 'auth', workspace: WORKSPACE, mode: 'search' });
    assert.ok(keywordScopes.length > 0, 'the keyword fallback must have run');
    assert.ok(
        keywordScopes.every((s) => s.project === '*'),
        `project scope must be '*' (retrieve.ts:314-321): ${JSON.stringify(keywordScopes)}`,
    );
    assert.ok(idsOf(body.results).length > 0, 'the keyword fallback returned nothing — doubly-constrained by the wrong project');
});

/* ─── C4: traverse per-hop confinement ────────────────────────────────── */

function traverseDeps(neighbourEcosystems: string[], detectedEcosystem: string) {
    const start = fnode('start-1', MINE);
    const hops = neighbourEcosystems.map((eco, i) => fnode(`hop-${i}-${eco}`, eco));
    // R6 #2 — a SCOPED traverse no longer post-filters `graph.traverse()`; it
    // runs the shared frontier-pruning BFS over `queryEdges` + `getNodesByIds`
    // (the same walk GET /api/subgraph uses), so the fake has to speak those
    // two verbs. Both are on LoreGraphHandle, so every real engine does.
    // `traverse()` stays for the unscoped ('*') path, which is unchanged.
    const graph = {
        async getNode(id: string) {
            if (id === 'start-1') return { ...start };
            const h = hops.find((n) => n.id === id);
            return h ? { ...h } : null;
        },
        async traverse() {
            return hops.map((node) => ({ depth: 1, relation: 'semantic_neighbor', node: { ...node } }));
        },
        async queryEdges(q: { source?: string; target?: string }) {
            if (q.source !== 'start-1') return [];
            return hops.map((h) => ({
                sourceId: 'start-1', targetId: h.id,
                relation: 'semantic_neighbor', confidence: 'inferred',
            }));
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, ReturnType<typeof fnode>>();
            for (const id of ids) {
                const h = hops.find((n) => n.id === id);
                if (h) m.set(id, { ...h });
            }
            return m;
        },
    };
    return {
        store: { loreGraph: graph },
        graphRegistry: { async getOrOpen() { return graph; }, async getGraphHandle() { return graph; } },
        detectedScope: { workspace: WORKSPACE, ecosystem: detectedEcosystem },
    } as unknown as Parameters<typeof registerTraverseTool>[1];
}

function captureTraverse(deps: Parameters<typeof registerTraverseTool>[1]): McpHandler {
    let handler: McpHandler | undefined;
    registerTraverseTool({ tool(_n: string, _d: string, _s: unknown, h: McpHandler) { handler = h; } } as unknown as McpServer, deps);
    return handler!;
}

// R4 #5: the scope is the CALLER's, not the daemon's boot cwd. These three
// used to omit `ecosystem` and lean on `detectedScope`; that default is gone
// (see the traverse regression test below and traverse.ts's own note), so the
// per-hop confinement they pin is now driven by the request, which is the only
// value that can actually distinguish two tenants.
await test('C4: `traverse` drops hops into a DIFFERENT ecosystem', async () => {
    const handler = captureTraverse(traverseDeps([MINE, THEIRS], MINE));
    const out = JSON.parse((await handler({ nodeId: 'start-1', workspace: WORKSPACE, ecosystem: MINE })).content[0]!.text);
    const ids = (out.results as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.some((i) => i.includes(MINE)), 'same-ecosystem neighbours must still be returned');
    assert.ok(
        !ids.some((i) => i.includes(THEIRS)),
        `traverse walked an edge into another tenant and returned its content: ${ids.join(', ')}`,
    );
});

await test("C4: `traverse` keeps unscoped ('*') hops — wildcard, per the settled meaning", async () => {
    const handler = captureTraverse(traverseDeps(['*'], MINE));
    const out = JSON.parse((await handler({ nodeId: 'start-1', workspace: WORKSPACE, ecosystem: MINE })).content[0]!.text);
    assert.equal((out.results as unknown[]).length, 1, "'*' is the schema default — confining it would switch traverse off for most installs");
});

await test("C4: an unset ('*') scope leaves `traverse` walking everything", async () => {
    const handler = captureTraverse(traverseDeps([MINE, THEIRS], '*'));
    const out = JSON.parse((await handler({ nodeId: 'start-1', workspace: WORKSPACE })).content[0]!.text);
    assert.equal((out.results as unknown[]).length, 2, "'*' must remain walk-everything");
});

/* ─── C5: a caller-supplied ecosystem, not just the boot-global one ────── */

await test('C5: `search` honours a CALLER-SUPPLIED ecosystem over the boot-detected default', async () => {
    // detectedScope says tenant-alpha; the caller is tenant-beta. One daemon,
    // one workspace, two principals — the case detectedScope cannot express.
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureTools(toolDeps);
    const out = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: WORKSPACE, ecosystem: THEIRS })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('theirs-1'), 'the caller\'s own ecosystem must be returned');
    assert.ok(!ids.includes('mine-1'), `the boot-detected scope overrode the caller's: ${ids.join(', ')}`);
    assert.equal((out.scope as { ecosystem: string }).ecosystem, THEIRS, 'the reported scope must be the one enforced');
});

await test('C5: `structured_query` honours a caller-supplied ecosystem too', async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureTools(toolDeps);
    const out = JSON.parse((await handlers.get('structured_query')!({ query: 'auth', workspace: WORKSPACE, ecosystem: THEIRS })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('theirs-1') && !ids.includes('mine-1'), `caller scope not honoured: ${ids.join(', ')}`);
});

await test('C5: POST /api/query honours a caller-supplied ecosystem too', async () => {
    const { searchDeps } = buildFixture(MINE);
    const body = await callPostQuery(searchDeps, { query: 'auth', workspace: WORKSPACE, ecosystem: THEIRS });
    const ids = idsOf(body.results);
    assert.ok(ids.includes('theirs-1') && !ids.includes('mine-1'), `caller scope not honoured: ${ids.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
