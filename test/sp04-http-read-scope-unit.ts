#!/usr/bin/env tsx
/**
 * sp04-http-read-scope-unit.ts — SP-04: HTTP read routes enforce
 * workspace_required + principal read-scope (the REST sibling of SP-01,
 * which scoped the MCP tools).
 *
 * Before SP-04 several read endpoints skipped the workspace gate, fell
 * back to the active workspace, bypassed Bearer, or never consulted the
 * request principal. This test proves, per representative route, the
 * post-SP-04 behavior under `runWithPrincipal`:
 *
 *   - workspace-A principal requesting workspace=B → 403 workspace_forbidden
 *   - missing workspace → 400 workspace_required
 *   - correctly-scoped request (workspace=A, or cross-workspace-read for
 *     "*"/other) → succeeds (reaches the stubbed graph)
 *   - no principal bound → legacy/local happy path preserved (no 4xx)
 *
 * Plus the public-allowlist decisions:
 *   - unauth GET /api/node-full → 401 (removed from PUBLIC_API_PATHS).
 *   - GET /api/recall stays public, but workspace="*" / crossProject=true
 *     with NO principal → 403 cross_workspace_no_principal (fail-closed).
 *
 * No LORE_HOME / disk needed: every gate fires before substrate access,
 * so refused calls never touch the stubs and allowed calls hit in-memory
 * stubs only. A fake graphRegistry resolves any workspace name to the
 * same in-memory graph so allowed reads return 200.
 *
 * Run:
 *   npx tsx test/sp04-http-read-scope-unit.ts
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { tryTopologyRoutes } from '../packages/lore/src/mcp/http/routes/topology.js';
import { tryInspectRoutes } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';
import { tryCorpusRoutes } from '../packages/lore/src/mcp/http/routes/corpus.js';
import { tryFreshnessRoutes } from '../packages/lore/src/mcp/http/routes/freshness.js';
import { tryAnalyticsRoutes } from '../packages/lore/src/mcp/http/routes/analytics.js';
import { tryOutcomesRoutes } from '../packages/lore/src/mcp/http/routes/outcomes.js';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import { tryStreamRoutes } from '../packages/lore/src/mcp/http/routes/stream.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { validateRequest } from '../packages/lore/src/security/httpAuth.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

const PORT = 3847;

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}

function fakeReq(method: string, url?: string, body?: string): IncomingMessage {
    if (body !== undefined) {
        let consumed = false;
        return {
            method, url,
            on(event: string, cb: (chunk?: Buffer) => void) {
                if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
                if (event === 'end') setImmediate(() => cb());
                return this;
            },
        } as unknown as IncomingMessage;
    }
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

/** Minimal graph that satisfies every read path the handlers exercise. */
function makeFakeGraph() {
    return {
        initialize: async () => undefined,
        getNode: async (id: string) => ({
            id, type: 'note', label: `node-${id}`, project: 'p', tags: '',
            content: 'secret body', metadata: null, createdAt: '', updatedAt: '',
        }),
        search: async () => [],
        listNodes: async () => [],
        queryEdges: async () => [],
        // Part of GraphProvider, and now genuinely reached: the 1-hop neighbour
        // and subgraph routes are built from queryEdges + getNodesByIds rather
        // than raw Cypher, so a fake that omitted it was incomplete against the
        // interface it claims rather than merely minimal.
        getNodesByIds: async () => new Map(),
        bulkList: async () => ({ nodes: [], hasMore: false, nextCursor: null }),
        getTopology: async () => ({ nodes: [], edges: [] }),
        getTopologyOverview: async () => ({ projects: [], edges: [] }),
        getTopologyOverviewByType: async () => ({ types: [], edges: [] }),
        getStats: async () => ({ nodeCount: 0, edgeCount: 0 }),
        getGraphContext: () => ({ queryRows: async () => [] }),
        findSupersededByPredecessors: async () => [],
    };
}

/** A registry that resolves ANY workspace name to the one fake graph —
 *  so the test only exercises the gate, not real multi-workspace IO.
 *
 *  Both accessors return the same fake: routes now resolve graphs through
 *  `getGraphHandle` (the workspace's DECLARED engine), while `getOrOpen`
 *  stays the legacy-substrate accessor a few callers still use. The gate under
 *  test runs inside the resolution either way. */
function makeFakeRegistry(graph: ReturnType<typeof makeFakeGraph>) {
    return {
        getOrOpen: async (_ws: string) => graph,
        getGraphHandle: async (_ws: string) => graph,
        activeName: () => 'active-ws',
    };
}

function buildDeps(graph: ReturnType<typeof makeFakeGraph>) {
    const registry = makeFakeRegistry(graph);
    const storageClient = Object.assign({}, graph, {
        verbatimCount: async () => 0,
        verbatimSearch: async () => [],
    });
    const store = { loreGraph: graph, storageClient, loreVerbatim: { count: async () => 0, search: async () => [] } };
    const common = {
        deploymentMode: 'local' as const,
        dataplane: null,
        store: store as never,
        graphRegistry: registry as never,
    };
    // Re-sweep stub stores. Each is only reached on the ALLOW / legacy path;
    // the 403 gate fires before any store access, so empty results are fine.
    const versionStore = { getVersions: () => [], getDiff: () => [] };
    const auxStore = {
        getOutcomes: () => [],
        getOutcomeCount: () => ({ success: 0, failure: 0, partial: 0 }),
    };
    const loadJobsStore = { list: async () => [] };
    const streamRegistry = { listForWorkspace: () => [], getCap: () => 16 };
    return {
        nodes: { ...common, auditLog: {} as never } as Parameters<typeof tryNodesRoutes>[4],
        search: { ...common, detectedScope: { workspace: '*', ecosystem: '*' } } as Parameters<typeof trySearchRoutes>[4],
        edges: { ...common } as Parameters<typeof tryEdgesRoutes>[4],
        bulk: { ...common } as Parameters<typeof tryBulkListRoutes>[4],
        topology: { ...common } as Parameters<typeof tryTopologyRoutes>[4],
        inspect: { ...common, detectedScope: { workspace: 'active-ws', ecosystem: '*' } } as Parameters<typeof tryInspectRoutes>[4],
        versioning: { ...common, versionStore: versionStore as never } as Parameters<typeof tryVersioningRoutes>[4],
        outcomes: { ...common, auxStore: auxStore as never } as Parameters<typeof tryOutcomesRoutes>[4],
        load: { ...common, loadJobsStore: loadJobsStore as never } as Parameters<typeof tryLoadRoutes>[4],
        // Launch gate (2026-08-19): the stream family 501s at dispatch in
        // local mode, so the cross-workspace read gate below is exercised
        // under 'cloud' — the one mode where the route is reachable.
        stream: { ...common, deploymentMode: 'cloud' as const, streamRegistry: streamRegistry as never } as Parameters<typeof tryStreamRoutes>[4],
        corpus: { ...common, auxStore: auxStore as never } as Parameters<typeof tryCorpusRoutes>[4],
        freshness: { ...common } as Parameters<typeof tryFreshnessRoutes>[4],
        analytics: { analytical: null, resolveAnalytical: async (_ws: string) => null } as Parameters<typeof tryAnalyticsRoutes>[4],
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('sp04-http-read-scope-unit.ts');

    const A = appPrincipal('alpha', ['read', 'write']);
    const AcrossRead = appPrincipal('alpha', ['read', 'write', 'cross-workspace-read']);

    /* ── GET /api/node ─────────────────────────────────────────────── */

    await test('GET /api/node: principal alpha → workspace=beta → 403 workspace_forbidden', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/node?id=x&workspace=beta', '/api/node', d.nodes));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/node: missing workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/node?id=x', '/api/node', d.nodes));
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    await test('GET /api/node: principal alpha → workspace=alpha → 200 (scoped read succeeds)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/node?id=x&workspace=alpha', '/api/node', d.nodes));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/node: cross-workspace-read principal → workspace=beta → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(AcrossRead, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/node?id=x&workspace=beta', '/api/node', d.nodes));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/node: NO principal → workspace=anything → 200 (legacy/local happy path)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryNodesRoutes(fakeReq('GET'), res, '/api/node?id=x&workspace=whatever', '/api/node', d.nodes);
        assert.equal(res._status, 200, res._body);
    });

    /* ── GET /api/node-full (also: removed from public allowlist) ──── */

    await test('GET /api/node-full: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/node-full?id=x&workspace=beta', '/api/node-full', d.nodes));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('UNAUTH GET /api/node-full → 401 (no longer on the public Bearer-less allowlist)', async () => {
        const outcome = validateRequest(
            { url: '/api/node-full?id=x&workspace=alpha', method: 'GET', headers: { host: `127.0.0.1:${PORT}` } } as unknown as IncomingMessage,
            { port: PORT, token: 'a'.repeat(64) },
        );
        assert.equal(outcome.ok, false, 'node-full must require Bearer');
        assert.equal((outcome as { status: number }).status, 401);
    });

    await test('UNAUTH GET /api/recall → 401 (removed from public set 2026-06-19)', async () => {
        const outcome = validateRequest(
            { url: '/api/recall?topic=x&workspace=alpha', method: 'GET', headers: { host: `127.0.0.1:${PORT}` } } as unknown as IncomingMessage,
            { port: PORT, token: 'a'.repeat(64) },
        );
        assert.equal(outcome.ok, false, '/api/recall now requires Bearer');
        assert.equal((outcome as { status: number }).status, 401);
    });

    /* ── GET /api/subgraph + /api/node/lineage (same gate) ─────────── */

    await test('GET /api/subgraph: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/subgraph?id=x&workspace=beta', '/api/subgraph', d.nodes));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/node/lineage: missing workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryNodesRoutes(fakeReq('GET'), res, '/api/node/lineage?id=x', '/api/node/lineage', d.nodes));
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    /* ── GET /api/search ───────────────────────────────────────────── */

    await test('GET /api/search: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            trySearchRoutes(fakeReq('GET', '/api/search?q=x&workspace=beta'), res, '/api/search?q=x&workspace=beta', '/api/search', d.search));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/search: principal alpha → workspace=alpha → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            trySearchRoutes(fakeReq('GET', '/api/search?q=x&workspace=alpha'), res, '/api/search?q=x&workspace=alpha', '/api/search', d.search));
        assert.equal(res._status, 200, res._body);
    });

    /* ── GET /api/nodes ────────────────────────────────────────────── */

    await test('GET /api/nodes: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            trySearchRoutes(fakeReq('GET', '/api/nodes?type=note&workspace=beta'), res, '/api/nodes?type=note&workspace=beta', '/api/nodes', d.search));
        assert.equal(res._status, 403, res._body);
    });

    /* ── POST /api/query ───────────────────────────────────────────── */

    await test('POST /api/query: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            trySearchRoutes(fakeReq('POST', '/api/query', JSON.stringify({ query: 'x', workspace: 'beta' })), res, '/api/query', '/api/query', d.search));
        assert.equal(res._status, 403, res._body);
    });

    /* ── GET /api/recall — cross-workspace fail-closed for null principal ─ */

    await test('GET /api/recall: NO principal + workspace=* → 403 cross_workspace_no_principal', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=*', '/api/recall', d.search);
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /cross_workspace_no_principal/);
    });

    await test('GET /api/recall: NO principal + crossProject=true → 403 cross_workspace_no_principal', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=alpha&crossProject=true', '/api/recall', d.search);
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /cross_workspace_no_principal/);
    });

    await test('GET /api/recall: NO principal + single named workspace → handler allows (auth enforced upstream by middleware)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=alpha', '/api/recall', d.search);
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/recall: principal alpha + crossProject=true → 403 (crossProject bypass closed)', async () => {
        // Before SP-04 the scope check saw workspace=alpha (matching the
        // binding) and passed, then silently widened to "*". Now the gate
        // is checked against the widened scope.
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=alpha&crossProject=true', '/api/recall', d.search));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/recall: cross-workspace-read principal + crossProject=true → reaches handler', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(AcrossRead, () =>
            trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=alpha&crossProject=true', '/api/recall', d.search));
        assert.notEqual(res._status, 403, res._body);
    });

    /* ── GET /api/edges ────────────────────────────────────────────── */

    await test('GET /api/edges: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryEdgesRoutes(fakeReq('GET'), res, '/api/edges?workspace=beta', '/api/edges', d.edges));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/edges: NO principal + missing workspace → 400 workspace_required (no active fallback)', async () => {
        // The fallback-to-active footgun: pre-SP-04 this read silently
        // resolved graphRegistry.activeName(). Now, with neither a
        // principal binding nor an explicit param, it 400s.
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryEdgesRoutes(fakeReq('GET'), res, '/api/edges', '/api/edges', d.edges);
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    await test('GET /api/edges: principal alpha + missing workspace → defaults to bound ws → 200', async () => {
        // A bound token's workspace counts as explicit (mirrors the
        // DELETE /api/edge writer branch); it does NOT fall back to the
        // daemon's active workspace.
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryEdgesRoutes(fakeReq('GET'), res, '/api/edges', '/api/edges', d.edges));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/edges: principal alpha → workspace=alpha → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryEdgesRoutes(fakeReq('GET'), res, '/api/edges?workspace=alpha', '/api/edges', d.edges));
        assert.equal(res._status, 200, res._body);
    });

    /* ── POST /api/nodes/bulk-list ─────────────────────────────────── */

    await test('POST /api/nodes/bulk-list: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryBulkListRoutes(fakeReq('POST', '/api/nodes/bulk-list', JSON.stringify({ workspace: 'beta' })), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', d.bulk));
        assert.equal(res._status, 403, res._body);
    });

    await test('POST /api/nodes/bulk-list: principal alpha → workspace=alpha → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryBulkListRoutes(fakeReq('POST', '/api/nodes/bulk-list', JSON.stringify({ workspace: 'alpha' })), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', d.bulk));
        assert.equal(res._status, 200, res._body);
    });

    /* ── GET /api/topology (+overview) ─────────────────────────────── */

    await test('GET /api/topology: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryTopologyRoutes(fakeReq('GET', '/api/topology?workspace=beta'), res, '/api/topology?workspace=beta', '/api/topology', d.topology));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/topology: missing workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryTopologyRoutes(fakeReq('GET', '/api/topology'), res, '/api/topology', '/api/topology', d.topology));
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    await test('GET /api/topology: principal alpha → workspace=alpha → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryTopologyRoutes(fakeReq('GET', '/api/topology?workspace=alpha'), res, '/api/topology?workspace=alpha', '/api/topology', d.topology));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/topology/overview: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryTopologyRoutes(fakeReq('GET', '/api/topology/overview?workspace=beta'), res, '/api/topology/overview?workspace=beta', '/api/topology/overview', d.topology));
        assert.equal(res._status, 403, res._body);
    });

    /* ── GET /api/node-list (QA-found miss — the retry's primary fix) ─── */

    await test('EXPLOIT GET /api/node-list: principal alpha → workspace=beta → 403 (cross-workspace node enumeration blocked)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryInspectRoutes(fakeReq('GET'), res, '/api/node-list?workspace=beta', '/api/node-list', d.inspect));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/node-list: principal alpha → workspace=* → 403 (scoped token cannot aggregate)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryInspectRoutes(fakeReq('GET'), res, '/api/node-list?workspace=*', '/api/node-list', d.inspect));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/node-list: missing workspace → 400 (workspace query param required)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryInspectRoutes(fakeReq('GET'), res, '/api/node-list', '/api/node-list', d.inspect));
        assert.equal(res._status, 400, res._body);
    });

    await test('GET /api/node-list: principal alpha → workspace=alpha → 200 (scoped read succeeds)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryInspectRoutes(fakeReq('GET'), res, '/api/node-list?workspace=alpha', '/api/node-list', d.inspect));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/node-list: cross-workspace-read principal → workspace=beta → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(AcrossRead, () =>
            tryInspectRoutes(fakeReq('GET'), res, '/api/node-list?workspace=beta', '/api/node-list', d.inspect));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/node-list: NO principal → workspace=anything → 200 (legacy/local happy path preserved)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryInspectRoutes(fakeReq('GET'), res, '/api/node-list?workspace=whatever', '/api/node-list', d.inspect);
        assert.equal(res._status, 200, res._body);
    });

    /* ── Re-sweep: other GET reads that resolve a caller workspace ───── */

    await test('GET /api/nodes/:id/history: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryVersioningRoutes(fakeReq('GET'), res, '/api/nodes/x/history?workspace=beta', '/api/nodes/x/history', d.versioning));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/workspaces/:name/diff: principal alpha → name=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryVersioningRoutes(fakeReq('GET'), res, '/api/workspaces/beta/diff?since=2020-01-01', '/api/workspaces/beta/diff', d.versioning));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/workspaces/:name/snapshot: principal alpha → name=beta → 403 (full-workspace export blocked)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryVersioningRoutes(fakeReq('GET'), res, '/api/workspaces/beta/snapshot', '/api/workspaces/beta/snapshot', d.versioning));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/workspaces/:name/snapshot: principal alpha → name=alpha → 200', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryVersioningRoutes(fakeReq('GET'), res, '/api/workspaces/alpha/snapshot', '/api/workspaces/alpha/snapshot', d.versioning));
        assert.equal(res._status, 200, res._body);
    });

    await test('GET /api/nodes/:id/outcomes: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryOutcomesRoutes(fakeReq('GET'), res, '/api/nodes/x/outcomes?workspace=beta', '/api/nodes/x/outcomes', d.outcomes));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/load/jobs: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryLoadRoutes(fakeReq('GET', '/api/load/jobs?workspace=beta'), res, '/api/load/jobs?workspace=beta', '/api/load/jobs', d.load));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/stream/sessions: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryStreamRoutes(fakeReq('GET', '/api/stream/sessions?workspace=beta'), res, '/api/stream/sessions?workspace=beta', '/api/stream/sessions', d.stream));
        assert.equal(res._status, 403, res._body);
    });

    await test('GET /api/load/jobs: NO principal → workspace=anything → not 403 (legacy/local happy path)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryLoadRoutes(fakeReq('GET', '/api/load/jobs?workspace=whatever'), res, '/api/load/jobs?workspace=whatever', '/api/load/jobs', d.load);
        assert.notEqual(res._status, 403, res._body);
    });

    /* ─── SP-04 follow-up: corpus health / freshness / analytics read routes ───
     * These gated only on gateRoute({read}), which in local mode never checks
     * the requested workspace against the principal — a workspace-A token could
     * read workspace-B's corpus counts, staleNodeIds, and analytics. Now they
     * call requireReadFromWorkspace(principal, workspace) like the other reads. */

    await test('GET /api/workspaces/:name/health: principal alpha → name=beta → 403 (corpus counts blocked)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryCorpusRoutes(fakeReq('GET'), res, '/api/workspaces/beta/health', '/api/workspaces/beta/health', d.corpus));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/workspaces/:name/health: cross-workspace-read principal → name=beta → not 403 (allowed past the gate)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(AcrossRead, () =>
            tryCorpusRoutes(fakeReq('GET'), res, '/api/workspaces/beta/health', '/api/workspaces/beta/health', d.corpus));
        assert.notEqual(res._status, 403, res._body);
    });

    await test('GET /api/workspaces/:name/health: NO principal → not 403 (legacy/local bypass)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryCorpusRoutes(fakeReq('GET'), res, '/api/workspaces/beta/health', '/api/workspaces/beta/health', d.corpus);
        assert.notEqual(res._status, 403, res._body);
    });

    await test('GET /api/workspaces/:name/freshness: principal alpha → name=beta → 403 (staleNodeIds blocked)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryFreshnessRoutes(fakeReq('GET'), res, '/api/workspaces/beta/freshness', '/api/workspaces/beta/freshness', d.freshness));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('GET /api/workspaces/:name/freshness: NO principal → not 403 (legacy/local bypass)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryFreshnessRoutes(fakeReq('GET'), res, '/api/workspaces/beta/freshness', '/api/workspaces/beta/freshness', d.freshness);
        assert.notEqual(res._status, 403, res._body);
    });

    await test('POST /api/time-series: principal alpha → body.workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryAnalyticsRoutes(fakeReq('POST', '/api/time-series', JSON.stringify({ workspace: 'beta', collection: 'c', timeField: 't', bucket: 'day', aggregation: 'count' })),
                res, '/api/time-series', '/api/time-series', d.analytics));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('POST /api/aggregate: principal alpha → body.workspace=beta → 403', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryAnalyticsRoutes(fakeReq('POST', '/api/aggregate', JSON.stringify({ workspace: 'beta', collection: 'c', aggregation: 'count' })),
                res, '/api/aggregate', '/api/aggregate', d.analytics));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('POST /api/aggregate: principal alpha → body.workspace=alpha → not 403 (scoped read allowed past gate)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await runWithPrincipal(A, () =>
            tryAnalyticsRoutes(fakeReq('POST', '/api/aggregate', JSON.stringify({ workspace: 'alpha', collection: 'c', aggregation: 'count' })),
                res, '/api/aggregate', '/api/aggregate', d.analytics));
        assert.notEqual(res._status, 403, res._body);
    });

    await test('POST /api/time-series: NO principal → not 403 (legacy/local bypass)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeFakeGraph());
        await tryAnalyticsRoutes(fakeReq('POST', '/api/time-series', JSON.stringify({ workspace: 'beta', collection: 'c', timeField: 't', bucket: 'day', aggregation: 'count' })),
            res, '/api/time-series', '/api/time-series', d.analytics);
        assert.notEqual(res._status, 403, res._body);
    });

    console.log(`\nSP-04: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
