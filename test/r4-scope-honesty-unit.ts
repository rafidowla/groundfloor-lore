#!/usr/bin/env tsx
/**
 * r4-scope-honesty-unit.ts — round 4: the scope a surface REPORTS must be the
 * scope it ENFORCES, and the scope must come from the request rather than from
 * where the daemon process happened to start.
 *
 * Round 3 threaded a caller-supplied `ecosystem` through the read surfaces. It
 * missed the branches, and one of the misses was in the file it had just
 * edited:
 *
 *   A — MCP `search` has TWO branches. The named-workspace branch was scoped;
 *       the `workspace:'*'` legacy branch still called
 *       `graph.search(q, n, '*', '*', …)` plus an UNFILTERED
 *       `verbatimSearch(q, n)`, and nothing post-filtered the merged set —
 *       while the response reported `scope.ecosystem` as the value the caller
 *       had just supplied. `workspace:'*'` clears `assertMcpScope` freely on
 *       the null-principal local/embedded path, which is exactly the embedded
 *       multi-tenant host the scope exists for.
 *
 *   B — GET /api/search PARSED `?ecosystem=` for every request and then
 *       dropped it on the `workspace=*` branch, which returns full `content`
 *       via projectKeywordNodes.
 *
 *   C — the two PRIMARY recall surfaces were skipped entirely: the MCP
 *       `recall` tool had no `ecosystem` field at all and hard-wired
 *       `detectedScope.ecosystem` into retrieve() and into the reported scope;
 *       GET /api/recall did the same. So a host could scope `search`
 *       per-request but not `recall` — the same nodes through the same
 *       retrieve() core.
 *
 *   D — the `'*'`-is-a-wildcard settlement (DEC-ECOSYSTEM-WILDCARD) widened 8
 *       pushdowns and missed the 3 `bulkList` ones, while ecosystemMatch.ts
 *       claimed "every database-level pushdown widens its predicate the same
 *       way". MCP `list_nodes` passes `detectedScope.ecosystem` into
 *       `bulkList`, so on any install where register_project set a concrete
 *       ecosystem it silently omitted EVERY node stored with the `'*'` schema
 *       default — the fail-closed "hiding a user's own data" the settlement
 *       was adopted to eliminate.
 *
 *   E — `traverse` gained a filter defaulted to `detectedScope.ecosystem`,
 *       which bootSteps.ts derives ONCE at boot by substring-matching
 *       process.cwd(). That made traverse hard-fail `"Node 'X' not found."` on
 *       a node that EXISTS in the requested workspace, purely because of the
 *       directory the daemon started in — a regression on previously-working
 *       input in the documented `local` mode, and untrue next to `get_node`,
 *       which returns that same node's full content.
 *
 *   F — POST /api/nodes/bulk-list built its BulkListQuery with no `ecosystem`
 *       at all and answered with the RAW rows (`content` included).
 *
 *   G — `project` is not the workspace. GET /api/nodes and five siblings
 *       passed the WORKSPACE NAME as the `project` filter — the substitution
 *       retrieve.ts:314-321 documents as the one that "silently makes keyword
 *       fallback empty while the vector path still appears healthy" — so they
 *       dropped their own workspace's rows whenever a node carried an explicit
 *       `project` (Atlas stores project='v3' inside workspace='default').
 *
 * Every case drives the REAL entry point (registered MCP handler / route
 * dispatcher / engine query builder). Each assertion fails on the pre-fix
 * source.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import { registerTraverseTool } from '../packages/lore/src/mcp/tools/traverse.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import { tryBulkListRoutes, type BulkListDeps } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { bulkList as surrealBulkList } from '../packages/lore/src/engines/surreal/surrealGraphAggregates.js';
import { bulkListArcadeNodes } from '../packages/lore/src/engines/arcade/arcadeGraphReads.js';
import { ecosystemMatches } from '../packages/lore/src/core/ecosystemMatch.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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
const fnode = (id: string, ecosystem: string, project = WORKSPACE): FNode => ({
    id, type: 'decision', label: `Label ${id}`, content: `SECRET body for ${id} about auth tokens`,
    tags: ['auth'], project, ecosystem,
    updatedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z', supersededAt: null,
});

/** One shared workspace, two tenants separated ONLY by ecosystem. */
const NODES: Record<string, FNode> = {
    'mine-1': fnode('mine-1', MINE),
    'theirs-1': fnode('theirs-1', THEIRS),
};
const SEMANTIC = [{ id: 'lore:theirs-1', score: 0.98 }, { id: 'lore:mine-1', score: 0.91 }];

function buildFixture(detectedEcosystem: string): {
    searchDeps: SearchDeps;
    toolDeps: SearchToolsDeps;
} {
    const graph = {
        async search(_q: string, _n: number, project: string, ecosystem: string, _hidden?: boolean, signals?: { scanCapHit: boolean }) {
            if (signals) signals.scanCapHit = false;
            // A store honouring the pushdown, with the WIDENED semantics every
            // engine now emits ('*'/'' rows are unconfined).
            return Object.values(NODES)
                .filter((n) => project === '*' || n.project === project)
                .filter((n) => ecosystemMatches(n.ecosystem, ecosystem))
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
    };
}

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

function postReq(path: string, body: Record<string, unknown>): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST', url: path,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(JSON.stringify(body), 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

const idsOf = (rows: unknown): string[] => (rows as Array<{ id: string }>).map((r) => r.id);

console.log('\nR4 — the reported scope must be the enforced scope\n');

/* ─── A: MCP `search`, the workspace:'*' branch ───────────────────────── */

await test("A1: `search` with workspace:'*' confines to the CALLER's ecosystem", async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: '*', ecosystem: MINE })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must still be returned');
    assert.ok(
        !ids.includes('theirs-1'),
        `the legacy "*" branch returned another tenant's node WITH full content: ${ids.join(', ')}`,
    );
});

await test("A2: `search` on workspace:'*' does not REPORT a scope it ignored", async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: '*', ecosystem: MINE })).content[0]!.text);
    const reported = (out.scope as { ecosystem: string }).ecosystem;
    assert.equal(reported, MINE, 'reported scope');
    // The honesty assertion: every row in the response must actually satisfy
    // the scope the response claims.
    const rows = out.results as Array<{ id: string }>;
    for (const r of rows) {
        assert.ok(
            ecosystemMatches(NODES[r.id]?.ecosystem, reported),
            `row ${r.id} (ecosystem=${NODES[r.id]?.ecosystem}) violates the reported scope ${reported}`,
        );
    }
});

await test("A3: `search` on workspace:'*' with ecosystem:'*' still searches everything", async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('search')!({ query: 'auth', workspace: '*', ecosystem: '*' })).content[0]!.text);
    const ids = idsOf(out.results);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `'*' must remain search-everything: ${ids.join(', ')}`);
});

/* ─── B: GET /api/search, the workspace=* branch ──────────────────────── */

await test('B1: GET /api/search?workspace=*&ecosystem=… honours the parameter it parses', async () => {
    const { searchDeps } = buildFixture(MINE);
    const body = await callGet(searchDeps, `/api/search?q=auth&workspace=*&ecosystem=${MINE}`, '/api/search');
    const ids = idsOf(body.results);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must still be returned');
    assert.ok(
        !ids.includes('theirs-1'),
        `?ecosystem= was parsed and dropped on the legacy branch — full content leaked: ${JSON.stringify(body.results)}`,
    );
});

await test('B2: GET /api/search?workspace=* without ?ecosystem= is unchanged for a wildcard install', async () => {
    const { searchDeps } = buildFixture('*');
    const body = await callGet(searchDeps, `/api/search?q=auth&workspace=*`, '/api/search');
    const ids = idsOf(body.results);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `'*' must remain search-everything: ${ids.join(', ')}`);
});

/* ─── C: the two primary RECALL surfaces ──────────────────────────────── */

await test('C1: the MCP `recall` tool accepts a caller-supplied ecosystem', async () => {
    // detectedScope says tenant-alpha; the caller is tenant-beta. One daemon,
    // one workspace, two principals — what a boot-global value cannot express.
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('recall')!({ topic: 'auth', workspace: WORKSPACE, ecosystem: THEIRS })).content[0]!.text);
    const blob = JSON.stringify(out);
    assert.ok(blob.includes('theirs-1'), `the caller's own ecosystem must be recalled: ${blob}`);
    assert.ok(!blob.includes('mine-1'), `the boot-detected scope overrode the caller's: ${blob}`);
});

await test('C2: `recall` reports the ecosystem it enforced, not the detected one', async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('recall')!({ topic: 'auth', workspace: WORKSPACE, ecosystem: THEIRS, mode: 'full' })).content[0]!.text);
    const scope = (out as { scope?: { ecosystem?: string } }).scope;
    assert.ok(scope, `recall(mode:"full") must report a scope: ${JSON.stringify(out).slice(0, 400)}`);
    assert.equal(scope.ecosystem, THEIRS, 'the reported scope must be the one enforced');
});

await test('C3: `recall` with no ecosystem still defaults to the detected scope (unchanged)', async () => {
    const { toolDeps } = buildFixture(MINE);
    const handlers = captureMcpTools(toolDeps);
    const out = JSON.parse((await handlers.get('recall')!({ topic: 'auth', workspace: WORKSPACE })).content[0]!.text);
    const blob = JSON.stringify(out);
    assert.ok(blob.includes('mine-1') && !blob.includes('theirs-1'), `default behaviour changed: ${blob}`);
});

await test('C4: GET /api/recall?ecosystem= honours the caller, like its /api/search sibling', async () => {
    const { searchDeps } = buildFixture(MINE);
    const body = await callGet(searchDeps, `/api/recall?topic=auth&workspace=${WORKSPACE}&ecosystem=${THEIRS}`, '/api/recall');
    const blob = JSON.stringify(body);
    assert.ok(blob.includes('theirs-1'), `the caller's own ecosystem must be recalled: ${blob}`);
    assert.ok(!blob.includes('mine-1'), `?ecosystem= ignored — the boot-global default won: ${blob}`);
});

/* ─── D: the three missed bulkList pushdowns ──────────────────────────── */

function recordingRows(): { fn: (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>; calls: Array<{ sql: string; params: Record<string, unknown> }> } {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    return {
        calls,
        fn: async (sql: string, params?: Record<string, unknown>) => { calls.push({ sql, params: params ?? {} }); return []; },
    };
}

/** The one shape every widened pushdown must produce: the scope OR the two
 *  unscoped spellings. A strict `=` is exactly the fail-closed bug. */
function assertWidened(sql: string, column: string): void {
    assert.match(
        sql,
        new RegExp(`${column}\\s*=\\s*[$:]ecosystem\\s+OR\\s+${column}\\s*=\\s*'\\*'\\s+OR\\s+${column}\\s*=\\s*''`),
        `pushdown is not widened — a '*'-defaulted row would be dropped:\n${sql}`,
    );
}

await test('D1: Surreal bulkList treats ecosystem:\'*\' as no filter at all', async () => {
    const rec = recordingRows();
    await surrealBulkList(rec.fn as never, { limit: 10, ecosystem: '*' });
    // The projection legitimately names ecosystem; only the WHERE clause and
    // the bound param are the question. (This assertion was born against
    // the legacy engine's bulkListNodes and re-pointed to the surviving Surreal path when
    // the engine was deleted — Phase 3d, 2026-08-21.)
    assert.doesNotMatch(rec.calls[0]!.sql, /\$ecosystem/, `'*' must not become a predicate:\n${rec.calls[0]!.sql}`);
    assert.equal(rec.calls[0]!.params['ecosystem'], undefined, "'*' must bind no param");
});

await test('D3: Surreal bulkList widens the ecosystem predicate', async () => {
    const rec = recordingRows();
    await surrealBulkList(rec.fn as never, { limit: 10, ecosystem: MINE });
    assertWidened(rec.calls[0]!.sql, 'ecosystem');
    assert.equal(rec.calls[0]!.params['ecosystem'], MINE);
});

await test('D4: Arcade bulkList widens the ecosystem predicate', async () => {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const http = {
        async query(_db: string, sql: string, params?: Record<string, unknown>) {
            calls.push({ sql, params: params ?? {} });
            return { result: [] };
        },
    };
    await bulkListArcadeNodes('db', http as never, 'LoreNode', { limit: 10, ecosystem: MINE });
    assertWidened(calls[0]!.sql, 'ecosystem');
    assert.equal(calls[0]!.params['ecosystem'], MINE);
});

/* ─── E: the traverse regression ──────────────────────────────────────── */

function traverseDeps(startEcosystem: string, detectedEcosystem: string) {
    const start = fnode('b-1', startEcosystem);
    const neighbour = fnode('b-2', startEcosystem);
    const graph = {
        async getNode(id: string) { return id === 'b-1' ? { ...start } : null; },
        async traverse() { return [{ depth: 1, relation: 'semantic_neighbor', node: { ...neighbour } }]; },
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

await test("E1: `traverse` does NOT hide an existing node because of the daemon's boot cwd", async () => {
    // The documented `local` mode: one daemon, several apps. detectedScope is
    // resolved once at boot from process.cwd(); node b-1 was stored by a
    // DIFFERENT app's session and carries that session's ecosystem.
    const handler = captureTraverse(traverseDeps('eco-b', 'eco-a'));
    const out = await handler({ nodeId: 'b-1', workspace: WORKSPACE });
    const parsed = JSON.parse(out.content[0]!.text);
    assert.ok(
        !out.isError,
        `traverse hard-failed on an EXISTING node because of where the process started: ${JSON.stringify(parsed)}`,
    );
    assert.equal((parsed.results as unknown[]).length, 1, 'the neighbour must still be walked');
});

await test('E2: an EXPLICIT ecosystem still confines the walk', async () => {
    const handler = captureTraverse(traverseDeps('eco-b', 'eco-a'));
    const out = await handler({ nodeId: 'b-1', workspace: WORKSPACE, ecosystem: 'eco-a' });
    assert.equal(out.isError, true, 'a caller-stated scope must be enforced');
});

await test('E3: the out-of-scope message does not claim the node is missing', async () => {
    // `get_node` returns this node's full content unscoped, so "not found" was
    // untrue on the neighbouring tool and sent agents hunting for id variants.
    const handler = captureTraverse(traverseDeps('eco-b', 'eco-a'));
    const parsed = JSON.parse((await handler({ nodeId: 'b-1', workspace: WORKSPACE, ecosystem: 'eco-a' })).content[0]!.text);
    assert.doesNotMatch(
        String(parsed.error),
        /not found/i,
        `the node exists — saying "not found" contradicts get_node: ${parsed.error}`,
    );
    assert.match(String(parsed.error), /ecosystem/i, 'the error must name the real reason (scope)');
});

await test('E4: a genuinely missing node still reports not-found', async () => {
    const handler = captureTraverse(traverseDeps('eco-b', 'eco-a'));
    const out = await handler({ nodeId: 'nope-1', workspace: WORKSPACE });
    const parsed = JSON.parse(out.content[0]!.text);
    assert.equal(out.isError, true);
    assert.match(String(parsed.error), /not found/i);
});

/* ─── F: POST /api/nodes/bulk-list ────────────────────────────────────── */

function bulkListDeps(): BulkListDeps {
    const rows = [fnode('mine-1', MINE), fnode('theirs-1', THEIRS), fnode('atlas-1', MINE, 'v3')];
    const graph = {
        async bulkList(q: { project?: string; ecosystem?: string; limit: number }) {
            const nodes = rows
                .filter((n) => !q.project || n.project === q.project)
                .filter((n) => ecosystemMatches(n.ecosystem, q.ecosystem ?? '*'))
                .map((n) => ({ ...n }));
            return { nodes, hasMore: false, nextCursor: null };
        },
    };
    return {
        store: { loreGraph: graph },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: { activeName: () => WORKSPACE, async getGraphHandle() { return graph; } },
    } as unknown as BulkListDeps;
}

async function callBulkList(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = fakeRes();
    const handled = await tryBulkListRoutes(
        postReq('/api/nodes/bulk-list', body), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', bulkListDeps(),
    );
    assert.ok(handled, 'bulk-list route not handled');
    assert.equal(res._status, 200, `bulk-list -> ${res._status}: ${res._body}`);
    return JSON.parse(res._body) as Record<string, unknown>;
}

await test('F1: POST /api/nodes/bulk-list confines full node bodies to the requested ecosystem', async () => {
    const body = await callBulkList({ workspace: WORKSPACE, ecosystem: MINE });
    const ids = idsOf(body.nodes);
    assert.ok(ids.includes('mine-1'), 'own-ecosystem node must be returned');
    assert.ok(
        !ids.includes('theirs-1'),
        `bulk-list returned another ecosystem's full node body: ${JSON.stringify(body.nodes)}`,
    );
    assert.equal(body.ecosystem, MINE, 'the response must state the scope it enforced');
});

await test('F2: bulk-list without an ecosystem still returns everything (unchanged)', async () => {
    const body = await callBulkList({ workspace: WORKSPACE });
    const ids = idsOf(body.nodes);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `default must stay unconfined: ${ids.join(', ')}`);
});

await test('F3: bulk-list no longer filters by the WORKSPACE NAME as `project`', async () => {
    // atlas-1 lives in this workspace but carries project='v3' — the Atlas
    // shape retrieve.ts:314-321 names. It was invisible here.
    const body = await callBulkList({ workspace: WORKSPACE });
    assert.ok(
        idsOf(body.nodes).includes('atlas-1'),
        `a node in this workspace was dropped because project !== workspace: ${idsOf(body.nodes).join(', ')}`,
    );
});

/* ─── G: `project` is not the workspace, on the remaining call sites ──── */

await test('G1: GET /api/nodes returns a node whose `project` differs from the workspace', async () => {
    const rows = [fnode('mine-1', MINE), fnode('atlas-1', MINE, 'v3')];
    const graph = {
        async listNodes(_type?: string, _tag?: string, project?: string, ecosystem?: string) {
            return rows
                .filter((n) => !project || project === '*' || n.project === project)
                .filter((n) => ecosystemMatches(n.ecosystem, ecosystem ?? '*'))
                .map((n) => ({ ...n }));
        },
    };
    const deps = {
        store: { loreGraph: graph }, detectedScope: { workspace: WORKSPACE, ecosystem: '*' },
        deploymentMode: 'local', dataplane: null,
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
    } as unknown as SearchDeps;
    const body = await callGet(deps, `/api/nodes?type=decision&workspace=${WORKSPACE}`, '/api/nodes');
    assert.ok(
        idsOf(body.nodes).includes('atlas-1'),
        `the workspace name was used as the \`project\` filter and dropped this workspace's own row: ${idsOf(body.nodes).join(', ')}`,
    );
});

await test('G2: GET /api/nodes accepts an ecosystem scope and states it', async () => {
    const rows = [fnode('mine-1', MINE), fnode('theirs-1', THEIRS)];
    const graph = {
        async listNodes(_type?: string, _tag?: string, _project?: string, ecosystem?: string) {
            return rows.filter((n) => ecosystemMatches(n.ecosystem, ecosystem ?? '*')).map((n) => ({ ...n }));
        },
    };
    const deps = {
        store: { loreGraph: graph }, detectedScope: { workspace: WORKSPACE, ecosystem: '*' },
        deploymentMode: 'local', dataplane: null,
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
    } as unknown as SearchDeps;
    const body = await callGet(deps, `/api/nodes?type=decision&workspace=${WORKSPACE}&ecosystem=${MINE}`, '/api/nodes');
    assert.deepEqual(idsOf(body.nodes), ['mine-1'], `raw rows (with content) leaked across ecosystems: ${JSON.stringify(body.nodes)}`);
    assert.equal(body.ecosystem, MINE);
});

await test('G3: no `listNodes(…, workspace, …)` survives on the sibling call sites', async () => {
    // The fix landed on exactly one of six last round. This is the ratchet:
    // `project` is the 3rd/4th positional argument on listNodes, and the
    // workspace name is never a valid value for it.
    const files = [
        'packages/lore/src/mcp/corpusHealthCompute.ts',
        'packages/lore/src/mcp/tools/lifecycle.ts',
        'packages/lore/src/mcp/tools/versioning.ts',
        'packages/lore/src/mcp/http/routes/lifecycle.ts',
        'packages/lore/src/mcp/http/routes/versioning.ts',
        'packages/lore/src/mcp/http/routes/search.ts',
    ];
    const offenders: string[] = [];
    for (const f of files) {
        const src = readFileSync(join(process.cwd(), f), 'utf8');
        // `listNodes(a, b, workspace` / `listNodes(type, tag, workspace`
        if (/listNodes\(\s*[^)]*?,\s*[^,)]*,\s*workspace\s*,/.test(src)) offenders.push(f);
        // corpusHealth's paged twin takes `project` as its 2nd argument.
        if (/forEachNodePage\(\s*\w+\s*,\s*workspace\s*,/.test(src)) offenders.push(`${f} (forEachNodePage)`);
    }
    assert.deepEqual(offenders, [], `workspace name still passed as the \`project\` filter:\n  ${offenders.join('\n  ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
