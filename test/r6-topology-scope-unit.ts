#!/usr/bin/env tsx
/**
 * r6-topology-scope-unit.ts — round 6: the TOPOLOGY surfaces the round-5 fix
 * missed, the reachability semantic its two twins disagreed on, and the scope
 * key that named a filter nothing enforces.
 *
 * Round 5 added `ecosystem` confinement to `subgraphFetch` and wrote a
 * paragraph explaining that `queryEdges` walks LoreEdge with NO ecosystem
 * predicate, so "a correctly-scoped start node can pull a DIFFERENT
 * ecosystem's node into the result set across a single edge". `neighbors1Hop`
 * — the same walk at depth 1, 90 lines ABOVE it in the SAME FILE — got
 * nothing. That is the fourth consecutive round whose "remaining surfaces"
 * enumeration was proved incomplete by the next reviewer rather than by the
 * enumeration, and the first where the missed sibling shared a file with the
 * fix.
 *
 *   S1..S3  — GET /api/node (`neighbors1Hop`). A scoped request returned a
 *       foreign tenant's id, label and type across one autolink edge, and the
 *       `?ecosystem=` parameter did not exist, so it was silently ignored
 *       rather than refused.
 *
 *   S4/S5   — REACHABILITY. `subgraphFetch` prunes the FRONTIER (a walk cannot
 *       pass THROUGH an out-of-scope node); MCP `traverse` filtered only its
 *       OUTPUT, so on center(alpha) → mid(beta) → far(alpha) the REST route
 *       returned only the centre while the MCP tool returned `far`. Two
 *       answers to one reachability question, both in DEC-SCOPE-SURFACE-CLASS's
 *       "TOPOLOGY surfaces" class, with nothing stating which was right.
 *       Settled as frontier-pruning (DEC-SCOPE-REACHABILITY) and made
 *       structural: both run `confinedBfs`.
 *
 *   S6..S8  — `scope: { project: <a workspace name> }`. The round that deleted
 *       the `project` filter from `list_nodes` (now `project: undefined`) and
 *       left `search` running with `workspaceScope = '*'` kept both responses
 *       advertising a project scope neither enforces — DEC-SCOPE-HONESTY rule
 *       1, on the axis that round changed. S8 is the ratchet.
 *
 *   S9..S13 — GET /api/topology, GET /api/topology/overview and GET /api/edges:
 *       three more ENUMERATION/TOPOLOGY surfaces with no ecosystem scope and no
 *       override, absent from the class list that says every read surface has
 *       one. Two now enforce; the overview REFUSES, because its counts are
 *       folded engine-side and it cannot.
 *
 *   S14/S15 — the stale rationale in `reconnect.ts` (the class R15 pinned in
 *       nodeService.ts, surviving in the same uncommitted batch) and the
 *       decision entry that has to state the reachability rule.
 *
 * Every case drives the REAL registered handler / route function or greps the
 * REAL source. Each assertion fails on the pre-fix source.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleGetNode } from '../packages/lore/src/mcp/http/routes/nodes/getNode.js';
import { handleSubgraph } from '../packages/lore/src/mcp/http/routes/nodes/subgraph.js';
import type { NodesDeps } from '../packages/lore/src/mcp/http/routes/nodes/types.js';
import { registerTraverseTool } from '../packages/lore/src/mcp/tools/traverse.js';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';
import { tryTopologyRoutes } from '../packages/lore/src/mcp/http/routes/topology.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'shared-ws';
const MINE = 'tenant-alpha';
const THEIRS = 'tenant-beta';

interface FNode {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; createdAt: string;
}
const fnode = (id: string, ecosystem: string, project = WORKSPACE): FNode => ({
    id, type: 'decision', label: `L-${id}`, content: `SECRET body for ${id}`,
    tags: ['auth'], project, ecosystem,
    updatedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z',
});

interface FEdge { sourceId: string; targetId: string; relation: string; confidence: string }

/** A graph speaking the portable verbs every LoreGraphHandle implements. */
function fakeGraph(nodes: FNode[], edges: FEdge[]) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
        async getNode(id: string): Promise<FNode | null> {
            const n = byId.get(id); return n ? { ...n } : null;
        },
        async getNodesByIds(ids: string[]): Promise<Map<string, FNode>> {
            const m = new Map<string, FNode>();
            for (const id of ids) { const n = byId.get(id); if (n) m.set(id, { ...n }); }
            return m;
        },
        async queryEdges(q: { source?: string; target?: string; relation?: string }): Promise<FEdge[]> {
            return edges
                .filter((e) => (q.source ? e.sourceId === q.source : true))
                .filter((e) => (q.target ? e.targetId === q.target : true))
                .filter((e) => (q.relation ? e.relation === q.relation : true))
                .map((e) => ({ ...e }));
        },
        /** The UNCONFINED engine walk — what `traverse` used to post-filter. */
        async traverse(startId: string, maxDepth = 2): Promise<Array<{ node: FNode; depth: number; relation: string }>> {
            const seen = new Set([startId]);
            const out: Array<{ node: FNode; depth: number; relation: string }> = [];
            let frontier = [startId];
            for (let d = 1; d <= maxDepth; d++) {
                const next: string[] = [];
                for (const fid of frontier) {
                    for (const e of edges) {
                        const other = e.sourceId === fid ? e.targetId : (e.targetId === fid ? e.sourceId : null);
                        if (!other || seen.has(other)) continue;
                        const n = byId.get(other);
                        if (!n) continue;
                        seen.add(other); next.push(other);
                        out.push({ node: { ...n }, depth: d, relation: e.relation });
                    }
                }
                if (next.length === 0) break;
                frontier = next;
            }
            return out;
        },
        async getStats(): Promise<{ nodeCount: number; edgeCount: number }> {
            return { nodeCount: nodes.length, edgeCount: edges.length };
        },
        async getTopology(): Promise<{ nodes: unknown[]; edges: unknown[] }> {
            return {
                nodes: nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, project: n.project, group: n.type })),
                edges: edges.map((e) => ({ from: e.sourceId, to: e.targetId, label: e.relation, confidence: e.confidence })),
            };
        },
        async getTopologyOverview(): Promise<Record<string, unknown>> {
            return { blobs: [{ project: WORKSPACE, nodeCount: nodes.length, types: [] }], aggregateEdges: [], totalNodes: nodes.length };
        },
        async getTopologyOverviewByType(): Promise<Record<string, unknown>> {
            return { blobs: [], aggregateEdges: [], totalNodes: nodes.length };
        },
    };
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
const fakeReq = (url: string): IncomingMessage =>
    ({ method: 'GET', url, on: () => { /* */ } } as unknown as IncomingMessage);

type McpHandler = (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
function captureTools(register: (s: McpServer, d: never) => void, deps: unknown): Map<string, McpHandler> {
    const handlers = new Map<string, McpHandler>();
    const fake = { tool(name: string, _d: string, _s: unknown, h: McpHandler) { handlers.set(name, h); } };
    register(fake as unknown as McpServer, deps as never);
    return handlers;
}

const idsOf = (rows: unknown): string[] => (rows as Array<{ id: string }>).map((r) => r.id);

const SRC_ROOT = join(process.cwd(), 'packages/lore/src');
function walkTs(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walkTs(p, out);
        else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
}
const SRC_FILES = walkTs(SRC_ROOT);
const rel = (p: string): string => p.slice(process.cwd().length + 1);

console.log('\nR6 — the sibling in the same file, and the reachability nobody chose\n');

/* ─── S1..S3: GET /api/node — neighbors1Hop, the unfixed sibling ───────── */

/** center(alpha) —> beta-1(beta), beta-2(beta) —> center. Both directions,
 *  because the route renders out-neighbours AND in-neighbours. */
function getNodeDeps(): NodesDeps {
    const graph = fakeGraph(
        [fnode('center', MINE), fnode('beta-1', THEIRS), fnode('beta-2', THEIRS), fnode('alpha-2', MINE)],
        [
            { sourceId: 'center', targetId: 'beta-1', relation: 'relates_to', confidence: 'extracted' },
            { sourceId: 'beta-2', targetId: 'center', relation: 'relates_to', confidence: 'extracted' },
            { sourceId: 'center', targetId: 'alpha-2', relation: 'relates_to', confidence: 'extracted' },
        ],
    );
    return {
        store: { loreGraph: graph },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
    } as unknown as NodesDeps;
}
async function callGetNode(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = fakeRes();
    await handleGetNode(res, url, getNodeDeps());
    return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
}

await test('S1: GET /api/node?ecosystem= confines the 1-hop neighbours', async () => {
    const { status, body } = await callGetNode(`/api/node?id=center&workspace=${WORKSPACE}&ecosystem=${MINE}`);
    assert.equal(status, 200, JSON.stringify(body));
    const ids = idsOf(body.neighbors);
    assert.ok(ids.includes('alpha-2'), `own-ecosystem neighbour must still be rendered: ${ids.join(', ')}`);
    assert.ok(
        !ids.includes('beta-1'),
        `a foreign tenant's id/label/type crossed the boundary on the OUT edge: ${ids.join(', ')}`,
    );
    assert.ok(
        !ids.includes('beta-2'),
        `…and on the IN edge: ${ids.join(', ')}`,
    );
    assert.equal(body.ecosystem, MINE, 'the response must state the scope it ENFORCED, not ignore the param');
});

await test('S2: a centre outside the scope is a SCOPE result, not "not found"', async () => {
    const { status, body } = await callGetNode(`/api/node?id=beta-1&workspace=${WORKSPACE}&ecosystem=${MINE}`);
    assert.equal(status, 404);
    assert.equal(body.code, 'node_outside_ecosystem',
        `same distinction GET /api/subgraph and MCP traverse draw: ${JSON.stringify(body)}`);
    assert.doesNotMatch(String(body.message), /not found/i,
        'the row exists — an unscoped GET /api/node returns it');
});

await test('S3: GET /api/node without ?ecosystem= is unchanged', async () => {
    const { status, body } = await callGetNode(`/api/node?id=center&workspace=${WORKSPACE}`);
    assert.equal(status, 200);
    const ids = idsOf(body.neighbors);
    assert.ok(ids.includes('alpha-2') && ids.includes('beta-1') && ids.includes('beta-2'),
        `the default must stay unconfined: ${ids.join(', ')}`);
    assert.equal(body.ecosystem, '*');
});

/* ─── S4/S5: one reachability semantic for both TOPOLOGY twins ─────────── */

// center(alpha) --> mid(beta) --> far(alpha).  `far` is IN scope but its ONLY
// path runs THROUGH a node the scope excludes.
const BRIDGE_NODES = [fnode('center', MINE), fnode('mid', THEIRS), fnode('far', MINE)];
const BRIDGE_EDGES: FEdge[] = [
    { sourceId: 'center', targetId: 'mid', relation: 'relates_to', confidence: 'extracted' },
    { sourceId: 'mid', targetId: 'far', relation: 'relates_to', confidence: 'extracted' },
];

function bridgeNodesDeps(): NodesDeps {
    const graph = fakeGraph(BRIDGE_NODES, BRIDGE_EDGES);
    return {
        store: { loreGraph: graph },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
    } as unknown as NodesDeps;
}
function bridgeTraverseDeps(): Parameters<typeof registerTraverseTool>[1] {
    const graph = fakeGraph(BRIDGE_NODES, BRIDGE_EDGES);
    return {
        store: { loreGraph: graph },
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
        detectedScope: { workspace: WORKSPACE, ecosystem: '*' },
    } as unknown as Parameters<typeof registerTraverseTool>[1];
}
function traverseHandler(deps: Parameters<typeof registerTraverseTool>[1]): McpHandler {
    return captureTools(registerTraverseTool as never, deps).get('traverse')!;
}

await test('S4: `traverse` and GET /api/subgraph give the SAME answer through a foreign hop', async () => {
    const res = fakeRes();
    await handleSubgraph(res, `/api/subgraph?id=center&workspace=${WORKSPACE}&depth=3&ecosystem=${MINE}`, bridgeNodesDeps());
    const restIds = idsOf((JSON.parse(res._body) as { nodes: unknown[] }).nodes);

    const out = JSON.parse((await traverseHandler(bridgeTraverseDeps())({
        nodeId: 'center', depth: 3, workspace: WORKSPACE, ecosystem: MINE,
    })).content[0]!.text);
    const mcpIds = (out.results as Array<{ id: string }>).map((r) => r.id);

    assert.deepEqual(
        [...mcpIds].sort(), [...restIds.filter((i) => i !== 'center')].sort(),
        `the REST twin and the MCP tool answered one reachability question differently — REST ${JSON.stringify(restIds)} vs MCP ${JSON.stringify(mcpIds)}`,
    );
    assert.ok(
        !mcpIds.includes('far'),
        `frontier-pruning is the settled semantic: a scoped walk may not ROUTE THROUGH a node the caller cannot see (got ${mcpIds.join(', ')})`,
    );
    assert.ok(!mcpIds.includes('mid'), `the foreign hop itself must never be returned: ${mcpIds.join(', ')}`);
});

await test("S5: an unscoped `traverse` still reaches everything (unchanged)", async () => {
    const out = JSON.parse((await traverseHandler(bridgeTraverseDeps())({
        nodeId: 'center', depth: 3, workspace: WORKSPACE,
    })).content[0]!.text);
    const ids = (out.results as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.includes('mid') && ids.includes('far'),
        `'*' must remain walk-everything — the engine path, unchanged: ${ids.join(', ')}`);
});

/* ─── S6..S8: the reported scope key names what is enforced ────────────── */

function listNodesHandler(): McpHandler {
    const graph = {
        async bulkList() {
            return { nodes: [fnode('mine-1', MINE), fnode('atlas-1', MINE, 'v3')], hasMore: false, nextCursor: null };
        },
    };
    const deps = {
        store: { loreGraph: graph },
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
        detectedScope: { workspace: 'boot-ws', ecosystem: MINE },
        nodeTypesEnum: { optional: () => ({ describe: () => ({}) }) },
        deploymentMode: 'local',
        dataplane: null,
    };
    return captureTools(registerDiagnosticTools as never, deps).get('list_nodes')!;
}

await test('S6: `list_nodes` reports `scope.workspace`, not a `project` filter it does not apply', async () => {
    const out = JSON.parse((await listNodesHandler()({ workspace: WORKSPACE, limit: 100 })).content[0]!.text);
    const scope = out.scope as Record<string, unknown>;
    assert.equal(scope['workspace'], WORKSPACE);
    assert.ok(!('project' in scope),
        `the bulkList call passes project: undefined — reporting a project scope is DEC-SCOPE-HONESTY rule 1: ${JSON.stringify(scope)}`);
    // …and the response really does carry a row whose project differs, so the
    // reported scope would have been false, not merely redundant.
    const projects = (out.nodes as Array<{ project: string }>).map((n) => n.project);
    assert.ok(projects.includes('v3'), `fixture must include a row whose project !== workspace: ${projects.join(', ')}`);
});

function searchHandler(): McpHandler {
    const graph = {
        async search() { return []; },
        async getNodesByIds() { return new Map(); },
        async traverse() { return []; },
        async getNode() { return null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const deps = {
        store: {
            loreGraph: graph,
            loreVerbatim: {},
            sessionCache: { pushNode() { /* noop */ } },
            storageClient: {
                async verbatimCount() { return 0; },
                async verbatimSearch() { return []; },
                async verbatimBm25Search() { return { hits: [], ranked: true }; },
            },
        },
        detectedScope: { workspace: 'boot-ws', ecosystem: '*' },
        graphRegistry: { async getOrOpen() { return graph; }, async getGraphHandle() { return graph; } },
    } as unknown as SearchToolsDeps;
    return captureTools(registerSearchTool as never, deps).get('search')!;
}

await test('S7: `search` reports `scope.workspace` — it runs with workspaceScope = \'*\'', async () => {
    const out = JSON.parse((await searchHandler()({ query: 'auth', workspace: 'other-ws' })).content[0]!.text);
    const scope = out.scope as Record<string, unknown>;
    assert.equal(scope['workspace'], 'other-ws');
    assert.ok(!('project' in scope),
        `retrieve.ts sets workspaceScope='*' ("search all projects inside that graph") — a project key here names a filter nothing applies: ${JSON.stringify(scope)}`);
});

await test('S8 (ratchet): no reported `scope` pairs a `project:` key with a workspace value', () => {
    // Shape-based across every file, like R2/R14 — not a list of the two files
    // this round happened to fix. A `project:` key inside a `scope:` literal is
    // legitimate ONLY when it holds a real project filter
    // (supersessionCandidates.ts: `project: projectFilter ?? null`); it is a
    // defect when it holds a workspace name.
    const offenders: string[] = [];
    for (const f of SRC_FILES) {
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(/scope:\s*\{([^}]*)\}/g)) {
            const body = m[1]!;
            const p = /(?:^|[\s,{])project:\s*([^,}\n]+)/.exec(body);
            if (!p) continue;
            const value = p[1]!.trim();
            if (/workspace|Ws\b/i.test(value)) offenders.push(`${rel(f)} → scope.project: ${value}`);
        }
    }
    assert.deepEqual(offenders, [],
        `a workspace name reported under a \`project\` key is a scope the surface does not enforce:\n  ${offenders.join('\n  ')}`);
});

/* ─── S9..S13: the three enumeration/topology surfaces with no override ── */

function topologyDeps(): Parameters<typeof tryTopologyRoutes>[4] {
    const graph = fakeGraph(BRIDGE_NODES, BRIDGE_EDGES);
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph },
        graphRegistry: { async getGraphHandle() { return graph; } },
    } as unknown as Parameters<typeof tryTopologyRoutes>[4];
}
async function callTopology(url: string, pathname = '/api/topology'): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = fakeRes();
    const handled = await tryTopologyRoutes(fakeReq(url), res, url, pathname, topologyDeps());
    assert.ok(handled, `${pathname} not handled`);
    return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
}

await test('S9: GET /api/topology?ecosystem= confines the rows AND the edge topology', async () => {
    const { status, body } = await callTopology(`/api/topology?workspace=${WORKSPACE}&ecosystem=${MINE}`);
    assert.equal(status, 200, JSON.stringify(body));
    const ids = idsOf(body.nodes);
    assert.deepEqual(ids.sort(), ['center', 'far'],
        `up to 20,000 rows of every other tenant's ids/labels/types: ${ids.join(', ')}`);
    const edges = body.edges as Array<{ from: string; to: string }>;
    assert.deepEqual(edges, [],
        `both surviving edges touch the excluded node — an edge with one foreign endpoint still discloses it: ${JSON.stringify(edges)}`);
    assert.equal(body.ecosystem, MINE, 'the response must state the scope it enforced');
});

await test('S10: GET /api/topology without ?ecosystem= is unchanged', async () => {
    const { status, body } = await callTopology(`/api/topology?workspace=${WORKSPACE}`);
    assert.equal(status, 200);
    assert.equal(idsOf(body.nodes).length, 3);
    assert.equal((body.edges as unknown[]).length, 2);
    assert.equal(body.ecosystem, '*');
});

await test('S11: GET /api/topology/overview REFUSES a scope it cannot enforce', async () => {
    const { status, body } = await callTopology(
        `/api/topology/overview?workspace=${WORKSPACE}&ecosystem=${MINE}`, '/api/topology/overview');
    assert.equal(status, 501,
        `silently ignoring a parsed scope parameter is DEC-SCOPE-HONESTY rule 2: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'ecosystem_scope_unsupported');
    const ok = await callTopology(`/api/topology/overview?workspace=${WORKSPACE}`, '/api/topology/overview');
    assert.equal(ok.status, 200, 'the unscoped overview must still work');
    assert.equal(ok.body.ecosystem, '*', 'and must state the only scope it can claim');
});

function edgesDeps(): Parameters<typeof tryEdgesRoutes>[4] {
    const graph = fakeGraph(BRIDGE_NODES, BRIDGE_EDGES);
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph },
    } as unknown as Parameters<typeof tryEdgesRoutes>[4];
}
async function callEdges(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = fakeRes();
    const handled = await tryEdgesRoutes(fakeReq(url), res, url, '/api/edges', edgesDeps());
    assert.ok(handled, '/api/edges not handled');
    return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
}

await test('S12: GET /api/edges?ecosystem= drops every edge with an endpoint out of scope', async () => {
    const { status, body } = await callEdges(`/api/edges?workspace=${WORKSPACE}&ecosystem=${MINE}`);
    assert.equal(status, 200, JSON.stringify(body));
    const edges = body.edges as Array<{ sourceId: string; targetId: string }>;
    assert.deepEqual(edges, [],
        `raw source/target/relation rows for another tenant: ${JSON.stringify(edges)}`);
    assert.equal(body.ecosystem, MINE, 'the response must state the scope it enforced');
});

await test('S13: GET /api/edges without ?ecosystem= is unchanged', async () => {
    const { status, body } = await callEdges(`/api/edges?workspace=${WORKSPACE}`);
    assert.equal(status, 200);
    assert.equal((body.edges as unknown[]).length, 2);
    assert.equal(body.ecosystem, '*');
});

/* ─── S14/S15: the rationale and the decision that has to state the rule ─ */

await test('S14: reconnect.ts no longer defends its residual with a filter that was replaced', () => {
    // The R15 class, one file over, in the same uncommitted batch: the
    // paragraph argued containment from `retrieve.ts` filtering "with strict
    // equality", which DEC-ECOSYSTEM-WILDCARD replaced with `ecosystemMatches`
    // — whose entire point is that an unscoped node IS kept by a scoped read.
    // reconnect.ts is the file core/ecosystemMatch.ts names as the ORIGIN of
    // the wildcard reading, so it is exactly the comment a later round cites
    // as authority.
    const src = readFileSync(join(SRC_ROOT, 'engines/reconnect.ts'), 'utf8');
    assert.ok(
        !/traversal HOPs? with strict equality/i.test(src) && !/HOP with strict equality/i.test(src),
        'reconnect.ts still cites a strict-equality hop filter that DEC-ECOSYSTEM-WILDCARD deleted',
    );
    assert.match(src, /ecosystemMatches/,
        'the rewritten paragraph must name the predicate that actually ships');
});

await test('S15: DECISIONS.md states which reachability semantic the TOPOLOGY class takes', () => {
    const src = readFileSync(join(process.cwd(), 'DECISIONS.md'), 'utf8');
    assert.match(src, /DEC-SCOPE-REACHABILITY/,
        'two surfaces in one class answered differently under one concrete scope, with no stated rule');
    assert.match(src, /frontier/i, 'the entry must say WHICH semantic won, not merely that one was picked');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
