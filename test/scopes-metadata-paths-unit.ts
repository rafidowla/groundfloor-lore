#!/usr/bin/env tsx
/**
 * test/scopes-metadata-paths-unit.ts — hidden-item metadata leaks that survived
 * the row-level security_scopes direct-read remediation (fa002b59).
 *
 * Contract (Rafi): for a BOUND actor (getCurrentActorScopes() !== undefined) a
 * node hidden by its per-row security_scopes is indistinguishable from a
 * missing one — on writes, on pointers that name it, and on aggregates that
 * emit per-node identity. UNBOUND actors are never filtered.
 *
 *   1. redact_evidence               hidden == node_not_found, no write
 *   2. record_outcome (MCP + REST)   hidden == node_not_found, no write, no aux row
 *   3. prune_nodes / restore_node    hidden nodes are ABSENT, including in counts (MCP + REST)
 *   4. supersededBy → hidden node    getNode, lineage, as-of, bulk-list, GET /api/nodes,
 *                                    snapshot (REST + export_snapshot); ONE getNodesByIds
 *   5. audited emitters              topology, freshness (REST + tool), corpus_health
 *                                    (REST + tool), get_hot_context, resolve_deferred
 *                                    (tool + REST), /api/report, /api/diagnose/consistency
 *
 * Every filesystem touch lives under a temp LORE_HOME.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-scopes-md-'));
process.env.LORE_HOME = TMP_HOME;
fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({
    active: 'ws', workspaces: [{ name: 'ws', path: path.join(TMP_HOME, 'ws'), createdAt: '2026-01-01T00:00:00Z', allowHardDelete: true }],
}));

const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { registerEvidenceTools } = await import('../packages/lore/src/mcp/tools/evidence.js');
const { registerOutcomeTools } = await import('../packages/lore/src/mcp/tools/outcomes.js');
const { registerLifecycleTools } = await import('../packages/lore/src/mcp/tools/lifecycle.js');
const { tryOutcomesRoutes } = await import('../packages/lore/src/mcp/http/routes/outcomes.js');
const { tryLifecycleRoutes } = await import('../packages/lore/src/mcp/http/routes/lifecycle.js');
const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
const { tryBulkListRoutes } = await import('../packages/lore/src/mcp/http/routes/bulkList.js');
const { trySearchRoutes } = await import('../packages/lore/src/mcp/http/routes/search.js');
const { tryVersioningRoutes } = await import('../packages/lore/src/mcp/http/routes/versioning.js');
const { registerVersioningTools } = await import('../packages/lore/src/mcp/tools/versioning.js');
const { tryTopologyRoutes } = await import('../packages/lore/src/mcp/http/routes/topology.js');
const { tryFreshnessRoutes } = await import('../packages/lore/src/mcp/http/routes/freshness.js');
const { tryCorpusRoutes } = await import('../packages/lore/src/mcp/http/routes/corpus.js');
const { tryPolicyRoutes } = await import('../packages/lore/src/mcp/http/routes/retention/policy.js');
const { registerCorpusHealthTools } = await import('../packages/lore/src/mcp/tools/corpusHealth.js');
const { registerGovernanceTools } = await import('../packages/lore/src/mcp/tools/governance.js');
const { handleReport } = await import('../packages/lore/src/mcp/http/routes/diagnostic/storage.js');
const { handleConsistency } = await import('../packages/lore/src/mcp/http/routes/diagnostic/health.js');

/* ── harness ─────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

type Who = 'unbound' | 'none' | 'sales' | 'finance';
/** unbound = no actor; none = bound actor holding zero scopes. */
function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    if (who === 'unbound') return fn();
    const scopes = who === 'none' ? [] : [who];
    return runWithActor({ portalUserId: `u-${who}`, scopes }, fn);
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
    let consumed = false;
    const payload = body === undefined ? '' : JSON.stringify(body);
    return {
        method, url,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed && payload) { consumed = true; cb(Buffer.from(payload, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

/* ── fake graph ──────────────────────────────────────────────────────── */

type N = Record<string, unknown> & { id: string };
function node(id: string, scopes: string[], extra: Record<string, unknown> = {}): N {
    return {
        id, type: 'decision', label: `Label ${id}`, content: `content of ${id}`, project: 'ws', ecosystem: '*',
        tags: [], security_scopes: scopes, metadata: '{}', createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z', supersededAt: null, supersededBy: null, ...extra,
    };
}

interface Edge { sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }

function makeGraph(nodes: N[], edges: Edge[] = []) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const g = {
        hydrateCalls: 0,
        upserts: [] as N[],
        deletes: [] as string[],
        initialize: async () => undefined,
        getNode: async (id: string) => byId.get(id) ?? null,
        getNodesByIds: async (ids: string[]) => {
            g.hydrateCalls++;
            const m = new Map<string, N>();
            for (const id of ids) if (byId.has(id)) m.set(id, byId.get(id)!);
            return m;
        },
        listNodes: async () => [...byId.values()],
        bulkList: async () => ({ nodes: [...byId.values()], hasMore: false, nextCursor: null }),
        bulkListProjected: async (_project: string, columns: readonly string[]) => ({
            rows: [...byId.values()].map((n) => Object.fromEntries([['id', n.id], ...columns.map((c) => [c, n[c]])])),
            nextCursor: null,
        }),
        queryEdges: async (q: { source?: string; target?: string; relation?: string; limit: number; offset: number }) =>
            edges.filter((e) => (!q.source || e.sourceId === q.source) && (!q.target || e.targetId === q.target)
                && (!q.relation || e.relation === q.relation)).slice(q.offset, q.offset + q.limit),
        // Mirrors the real projection: id/label/type/project/supersededBy only,
        // NO security_scopes (so a bare filterNodesByActorScope over it is a no-op).
        getTopology: async () => ({
            nodes: [...byId.values()].map((n) => ({ id: n.id, label: n.label, type: n.type, project: n.project,
                supersededBy: n.supersededBy, supersededReason: n.supersededReason ?? null })),
            edges: edges.map((e) => ({ from: e.sourceId, to: e.targetId, relation: e.relation })),
        }),
        getStats: async () => ({ nodeCount: byId.size, edgeCount: edges.length, typeBreakdown: { decision: byId.size } }),
        findSupersededByPredecessors: async (id: string) =>
            [...byId.values()].filter((n) => n.supersededBy === id).map((n) => n.id).sort(),
        upsertNode: async (n: N) => { g.upserts.push(n); byId.set(n.id, n); return n; },
        deleteNode: async (id: string) => { g.deletes.push(id); return byId.delete(id); },
        search: async () => [],
    };
    return g;
}
type FakeGraph = ReturnType<typeof makeGraph>;

/* ── MCP stub ────────────────────────────────────────────────────────── */

interface Tool { schema: Record<string, z.ZodTypeAny>; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
function mcpTools(register: (server: never) => void): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    register({ tool: (name: string, _d: string, schema: Tool['schema'], handler: Tool['handler']) => { tools.set(name, { schema, handler }); } } as never);
    return tools;
}
async function call(tool: Tool, args: Record<string, unknown>) {
    const parsed = z.object(tool.schema).parse(args);
    const r = await tool.handler(parsed as Record<string, unknown>);
    const text = r.content[0]!.text;
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { text, isError: r.isError === true, json };
}

function fakeAux() {
    const o = {
        rows: [] as unknown[],
        counters: [] as string[],
        pruneJobs: 0,
        recordOutcome: (row: unknown) => { o.rows.push(row); },
        getOutcomeCount: () => ({ success: o.rows.length, failure: 0, partial: 0 }),
        getOutcomes: () => o.rows,
        incrementCounter: (_ws: string, key: string) => { o.counters.push(key); },
        createPruneJob: () => { o.pruneJobs++; return `job-${o.pruneJobs}`; },
        updatePruneJob: () => undefined,
        getPruneJob: () => null,
        getWorkspaceOutcomeTotals: () => ({ success: 0, failure: 0, partial: 0 }),
        getCorpusCounters: () => ({}),
    };
    return o;
}
const stores = (graph: FakeGraph) => ({ loreGraph: graph, loreVerbatim: {}, storageClient: { verbatimDelete: async () => undefined } }) as never;

const pub = node('pub', []);
const sec = node('sec', ['finance']);

/* ── 1. redact_evidence ──────────────────────────────────────────────── */
console.log('1. redact_evidence');
{
    const mk = () => {
        const g = makeGraph([pub, node('sec', ['finance'], { evidence: 'secret evidence text' }), node('pubev', [], { evidence: 'pub ev' })]);
        const audit: unknown[] = [];
        const tools = mcpTools((s) => registerEvidenceTools(s, { store: stores(g), auditLog: { log: (e: unknown) => audit.push(e) } as never, detectedScope: { workspace: 'ws', ecosystem: '*' } }));
        return { g, audit, tool: tools.get('redact_evidence')! };
    }
    await test('hidden node gets the exact node_not_found body of a missing id, and nothing is written or audited', async () => {
        const { g, audit, tool } = mk();
        const missing = await as('sales', () => call(tool, { id: 'nope', workspace: 'ws' }));
        const hidden = await as('sales', () => call(tool, { id: 'sec', workspace: 'ws' }));
        assert.equal(hidden.isError, true);
        assert.equal(hidden.text.replace('"sec"', '"nope"'), missing.text);
        assert.equal(g.upserts.length, 0);
        assert.equal(audit.length, 0);
        assert.ok(!hidden.text.includes('secret') && !hidden.text.includes('previous_evidence_length'));
    });
    await test('bound zero-scope actor cannot redact a scoped node', async () => {
        const { g, tool } = mk();
        const r = await as('none', () => call(tool, { id: 'sec', workspace: 'ws' }));
        assert.equal(r.json.error, 'node_not_found');
        assert.equal(g.upserts.length, 0);
    });
    await test('actor holding the scope redacts it (previous length reported)', async () => {
        const { g, tool } = mk();
        const r = await as('finance', () => call(tool, { id: 'sec', workspace: 'ws' }));
        assert.equal(r.json.success, true);
        assert.equal(r.json.previous_evidence_length, 'secret evidence text'.length);
        assert.equal(g.upserts[0]!.evidence, null);
    });
    await test('unbound actor is unfiltered', async () => {
        const { g, tool } = mk();
        const r = await as('unbound', () => call(tool, { id: 'sec', workspace: 'ws' }));
        assert.equal(r.json.success, true);
        assert.equal(g.upserts.length, 1);
    });
    await test('public node is redactable by a zero-scope bound actor', async () => {
        const { g, tool } = mk();
        const r = await as('none', () => call(tool, { id: 'pubev', workspace: 'ws' }));
        assert.equal(r.json.success, true);
        assert.equal(g.upserts.length, 1);
    });
}

/* ── 2. record_outcome ───────────────────────────────────────────────── */
console.log('2. record_outcome (MCP + REST POST)');
{
    const mkTool = () => {
        const g = makeGraph([pub, sec]);
        const aux = fakeAux();
        const tools = mcpTools((s) => registerOutcomeTools(s, { store: stores(g), auxStore: aux as never, detectedScope: { workspace: 'ws', ecosystem: '*' } }));
        return { g, aux, tool: tools.get('record_outcome')! };
    };
    const postRoute = async (who: Who, g: FakeGraph, aux: ReturnType<typeof fakeAux>, id: string) => {
        const res = fakeRes();
        const deps = { deploymentMode: 'local' as const, dataplane: null, store: stores(g), auxStore: aux as never };
        const url = `/api/nodes/${id}/outcomes`;
        const handled = await as(who, () => tryOutcomesRoutes(fakeReq('POST', url, { workspace: 'ws', status: 'success' }), res, url, url, deps as never));
        assert.equal(handled, true);
        return { status: res._status, body: res._body, json: res._body ? JSON.parse(res._body) as Record<string, any> : {} };
    };
    await test('MCP: hidden node == missing node, no aux row, no graph write, no counter', async () => {
        const { g, aux, tool } = mkTool();
        const missing = await as('sales', () => call(tool, { node_id: 'nope', workspace: 'ws', status: 'success' }));
        const hidden = await as('sales', () => call(tool, { node_id: 'sec', workspace: 'ws', status: 'success' }));
        assert.equal(hidden.isError, true);
        assert.equal(hidden.text.replace('"sec"', '"nope"'), missing.text);
        assert.equal(aux.rows.length, 0); assert.equal(aux.counters.length, 0); assert.equal(g.upserts.length, 0);
    });
    await test('MCP: zero-scope bound actor is also refused', async () => {
        const { aux, tool } = mkTool();
        const r = await as('none', () => call(tool, { node_id: 'sec', workspace: 'ws', status: 'failure' }));
        assert.equal(r.json.error, 'node_not_found');
        assert.equal(aux.rows.length, 0);
    });
    await test('MCP: scope holder, unbound actor, and public node all record', async () => {
        for (const [who, id] of [['finance', 'sec'], ['unbound', 'sec'], ['none', 'pub']] as const) {
            const { g, aux, tool } = mkTool();
            const r = await as(who, () => call(tool, { node_id: id, workspace: 'ws', status: 'success' }));
            assert.equal(r.json.success, true, `${who}/${id}`);
            assert.equal(aux.rows.length, 1); assert.equal(g.upserts.length, 1);
        }
    });
    await test('REST: hidden node == missing node (404 node_not_found), nothing written', async () => {
        const g = makeGraph([pub, sec]); const aux = fakeAux();
        const missing = await postRoute('sales', g, aux, 'nope');
        const hidden = await postRoute('sales', g, aux, 'sec');
        assert.equal(hidden.status, 404);
        assert.equal(hidden.json.error?.code ?? hidden.json.error, missing.json.error?.code ?? missing.json.error);
        assert.equal(hidden.body.replaceAll('sec', 'nope'), missing.body);
        assert.equal(aux.rows.length, 0); assert.equal(aux.counters.length, 0); assert.equal(g.upserts.length, 0);
    });
    await test('REST: zero-scope refused; scope holder, unbound and public succeed', async () => {
        const g0 = makeGraph([pub, sec]); const a0 = fakeAux();
        assert.equal((await postRoute('none', g0, a0, 'sec')).status, 404);
        assert.equal(a0.rows.length, 0);
        for (const [who, id] of [['finance', 'sec'], ['unbound', 'sec'], ['none', 'pub']] as const) {
            const g = makeGraph([pub, sec]); const aux = fakeAux();
            const r = await postRoute(who, g, aux, id);
            assert.equal(r.status, 200, `${who}/${id}: ${r.body}`);
            assert.equal(aux.rows.length, 1);
        }
    });
}

/* ── 3. prune_nodes / restore_node ───────────────────────────────────── */
console.log('3. prune_nodes + restore_node (MCP + REST)');
{
    const rows = () => [
        node('pub-a', []), node('pub-b', [], { tags: ['x'] }), node('sec-a', ['finance']), node('sec-b', ['finance']),
        node('sec-arch', ['finance'], { status: 'archived' }), node('pub-arch', [], { status: 'archived' }),
    ];
    const mk = () => {
        const g = makeGraph(rows()); const aux = fakeAux();
        const tools = mcpTools((s) => registerLifecycleTools(s, { store: stores(g), auxStore: aux as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const deps = { deploymentMode: 'local' as const, dataplane: null, store: stores(g), auxStore: aux as never };
        return { g, aux, tools, deps };
    };
    const rest = async (who: Who, deps: unknown, route: string, body: unknown) => {
        const res = fakeRes();
        const handled = await as(who, () => tryLifecycleRoutes(fakeReq('POST', route, body), res, route, route, deps as never));
        assert.equal(handled, true);
        return { status: res._status, body: res._body, json: res._body ? JSON.parse(res._body) as Record<string, any> : {} };
    };
    const previewIds = (j: Record<string, any>) => (j.preview as Array<{ id: string }>).map((n) => n.id).sort();

    await test('MCP dry run: preview and every count exclude hidden nodes', async () => {
        const { tools } = mk();
        const r = await as('sales', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: true }));
        assert.deepEqual(previewIds(r.json), ['pub-a', 'pub-b']);
        assert.equal(r.json.matched, 2); assert.equal(r.json.would_archive, 2);
        assert.ok(!r.text.includes('sec-'));
    });
    await test('MCP dry run: protected_count excludes hidden protected nodes', async () => {
        const g = makeGraph([node('p1', [], { status: 'protected' }), node('p2', ['finance'], { status: 'protected' }), node('pub-a', [])]);
        const tools = mcpTools((s) => registerLifecycleTools(s, { store: stores(g), auxStore: fakeAux() as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const hid = await as('none', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: true }));
        assert.equal(hid.json.protected_count, 1);
        const all = await as('finance', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: true }));
        assert.equal(all.json.protected_count, 2);
    });
    await test('MCP dry run: scope holder and unbound see everything eligible', async () => {
        const { tools } = mk();
        for (const who of ['finance', 'unbound'] as const) {
            const r = await as(who, () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: true }));
            assert.deepEqual(previewIds(r.json), ['pub-a', 'pub-b', 'sec-a', 'sec-b']);
            assert.equal(r.json.matched, 4);
        }
    });
    await test('MCP apply (archive): hidden nodes are never written; counts cover visible only', async () => {
        const { g, tools } = mk();
        const r = await as('none', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: false }));
        assert.equal(r.json.archived, 2);
        assert.deepEqual(g.upserts.map((n) => n.id).sort(), ['pub-a', 'pub-b']);
    });
    await test('MCP apply (hard_delete): hidden nodes are never deleted', async () => {
        const { g, tools } = mk();
        const r = await as('none', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: false, hard_delete: true }));
        assert.ok(!r.isError, r.text);
        assert.ok(g.deletes.every((id) => id.startsWith('pub-')), `deleted ${g.deletes.join(',')}`);
        assert.ok(!(await g.getNode('sec-a') === null));
    });
    await test('MCP apply: a node relabelled out of view between snapshot and lock is skipped', async () => {
        const { g, tools } = mk();
        const realList = g.listNodes;
        g.listNodes = (async () => { const out = await realList(); g.getNode = async (id: string) => (id === 'pub-a' ? node('pub-a', ['finance']) : (out.find((n) => n.id === id) ?? null)) as never; return out; }) as never;
        const r = await as('sales', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: false }));
        assert.deepEqual(g.upserts.map((n) => n.id), ['pub-b']);
        assert.equal(r.json.archived, 1); assert.equal(r.json.skipped, 1);
    });
    await test('MCP apply: scope holder archives hidden ones too', async () => {
        const { g, tools } = mk();
        await as('finance', () => call(tools.get('prune_nodes')!, { workspace: 'ws', dry_run: false }));
        assert.deepEqual(g.upserts.map((n) => n.id).sort(), ['pub-a', 'pub-b', 'sec-a', 'sec-b']);
    });
    await test('REST dry run / apply: hidden nodes are absent from preview, counts and writes', async () => {
        const a = mk();
        const dry = await rest('sales', a.deps, '/api/nodes/prune', { workspace: 'ws', dry_run: true });
        assert.deepEqual(previewIds(dry.json), ['pub-a', 'pub-b']);
        assert.equal(dry.json.matched, 2);
        assert.ok(!dry.body.includes('sec-'));
        const app = await rest('sales', a.deps, '/api/nodes/prune', { workspace: 'ws', dry_run: false });
        assert.equal(app.status, 200, app.body);
        assert.deepEqual(a.g.upserts.map((n) => n.id).sort(), ['pub-a', 'pub-b']);
        const b = mk();
        const all = await rest('unbound', b.deps, '/api/nodes/prune', { workspace: 'ws', dry_run: true });
        assert.equal(all.json.matched, 4);
    });
    await test('REST apply (hard_delete): hidden nodes are never deleted', async () => {
        const { g, deps } = mk();
        const r = await rest('none', deps, '/api/nodes/prune', { workspace: 'ws', dry_run: false, hard_delete: true });
        assert.equal(r.status, 200, r.body);
        assert.ok(g.deletes.every((id) => id.startsWith('pub-')), `deleted ${g.deletes.join(',')}`);
    });
    await test('MCP restore_node: hidden archived node == missing; visible one restores', async () => {
        const { g, tools } = mk();
        const t = tools.get('restore_node')!;
        const missing = await as('sales', () => call(t, { id: 'nope', workspace: 'ws' }));
        const hidden = await as('sales', () => call(t, { id: 'sec-arch', workspace: 'ws' }));
        assert.equal(hidden.isError, missing.isError);
        assert.equal(hidden.text.replace('sec-arch', 'nope'), missing.text);
        assert.equal(g.upserts.length, 0);
        const ok = await as('sales', () => call(t, { id: 'pub-arch', workspace: 'ws' }));
        assert.equal(ok.isError, false);
        assert.equal(g.upserts.length, 1);
        const holder = await as('finance', () => call(t, { id: 'sec-arch', workspace: 'ws' }));
        assert.equal(holder.isError, false);
        const unb = mk();
        assert.equal((await as('unbound', () => call(unb.tools.get('restore_node')!, { id: 'sec-arch', workspace: 'ws' }))).isError, false);
    });
    await test('REST restore: hidden archived node == missing; visible one restores', async () => {
        const { g, deps } = mk();
        const rt = (id: string) => `/api/nodes/${id}/restore`;
        const missing = await rest('sales', deps, rt('nope'), { workspace: 'ws' });
        const hidden = await rest('sales', deps, rt('sec-arch'), { workspace: 'ws' });
        assert.equal(hidden.status, missing.status);
        assert.equal(hidden.body.replaceAll('sec-arch', 'nope'), missing.body);
        assert.equal(g.upserts.length, 0);
        assert.equal((await rest('sales', deps, rt('pub-arch'), { workspace: 'ws' })).status, 200);
        assert.equal((await rest('finance', deps, rt('sec-arch'), { workspace: 'ws' })).status, 200);
    });
}


/* ── shared HTTP plumbing for sections 4-5 ───────────────────────────── */

function httpDeps(graph: FakeGraph) {
    const registry = { getOrOpen: async () => graph, getGraphHandle: async () => graph, activeName: () => 'ws', homeDir: () => TMP_HOME };
    const storageClient = Object.assign({}, graph, { verbatimCount: async () => 0, verbatimSearch: async () => [] });
    const store = { loreGraph: graph, storageClient, loreVerbatim: { count: async () => 0, search: async () => [] } };
    return { deploymentMode: 'local' as const, dataplane: null, store, graphRegistry: registry, auditLog: {}, versionStore: {} };
}
type Handler = (req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: never) => Promise<boolean>;
async function http(who: Who, handler: Handler, method: string, url: string, deps: unknown, body?: unknown) {
    const res = fakeRes();
    const pathname = url.split('?')[0]!;
    const handled = await as(who, () => handler(fakeReq(method, url, body), res, url, pathname, deps as never));
    assert.equal(handled, true, `route ${method} ${pathname} must be handled`);
    return { status: res._status, body: res._body, json: (() => { try { return res._body ? JSON.parse(res._body) : {}; } catch { return {}; } })() as Record<string, any> };
}

/* ── 4. supersededBy → hidden successor ──────────────────────────────── */
console.log('4. pointers naming a hidden successor');
{
    // Distinctive ids so a body-level string search is unambiguous.
    const HID = 'zz-hidden-successor';
    const rows = () => [
        node('old-hid', [], { supersededBy: HID, supersededReason: `replaced by ${HID}`, supersededAt: '2026-02-01T00:00:00Z', validFrom: '2026-01-01T00:00:00Z' }),
        node('old-vis', [], { supersededBy: 'new-vis', supersededReason: 'replaced by new-vis', supersededAt: '2026-02-02T00:00:00Z', validFrom: '2026-01-01T00:00:00Z' }),
        node('old-gone', [], { supersededBy: 'zz-deleted-successor', supersededReason: 'was replaced', supersededAt: '2026-02-03T00:00:00Z', validFrom: '2026-01-01T00:00:00Z' }),
        node('new-vis', [], { validFrom: '2026-01-01T00:00:00Z' }),
        node(HID, ['finance'], { validFrom: '2026-01-01T00:00:00Z' }),
    ];
    type Row = { id: string; supersededBy: string | null; supersededReason: string | null; supersededAt: string | null };
    const byId = (list: Row[]) => Object.fromEntries(list.map((n) => [n.id, n]));
    /** The one rule: hidden OR deleted successor => null pointer + reason, supersededAt kept; visible successor untouched. */
    const assertRedacted = (m: Record<string, Row>, label: string) => {
        assert.equal(m['old-hid']!.supersededBy, null, `${label}: hidden successor id leaked`);
        assert.equal(m['old-hid']!.supersededReason, null, `${label}: reason naming hidden successor leaked`);
        assert.equal(m['old-hid']!.supersededAt, '2026-02-01T00:00:00Z', `${label}: supersededAt must survive`);
        assert.equal(m['old-gone']!.supersededBy, null, `${label}: deleted successor is treated identically`);
        assert.equal(m['old-gone']!.supersededReason, null);
        assert.equal(m['old-vis']!.supersededBy, 'new-vis', `${label}: visible successor must be untouched`);
        assert.equal(m['old-vis']!.supersededReason, 'replaced by new-vis');
    };
    const assertPristine = (m: Record<string, Row>, label: string) => {
        assert.equal(m['old-hid']!.supersededBy, HID, `${label}: must be unfiltered`);
        assert.equal(m['old-hid']!.supersededReason, `replaced by ${HID}`);
        // A DELETED successor is dangling for any bound actor (hidden == deleted, one rule);
        // an unbound actor keeps the raw pointer.
        assert.equal(m['old-gone']!.supersededBy, label.endsWith('/unbound') ? 'zz-deleted-successor' : null);
    };

    // Each surface returns a list of {id, supersededBy, ...} rows plus the raw body.
    interface Surface { name: string; run: (who: Who, g: FakeGraph) => Promise<{ rows: Row[]; body: string }> }
    const nodesDeps = (g: FakeGraph) => httpDeps(g);
    const surfaces: Surface[] = [
        { name: 'POST /api/nodes/bulk-list', run: async (who, g) => {
            const r = await http(who, tryBulkListRoutes as Handler, 'POST', '/api/nodes/bulk-list', nodesDeps(g), { workspace: 'ws' });
            return { rows: r.json.nodes, body: r.body };
        } },
        { name: 'GET /api/nodes', run: async (who, g) => {
            const r = await http(who, trySearchRoutes as Handler, 'GET', '/api/nodes?type=decision&workspace=ws', nodesDeps(g));
            return { rows: r.json.nodes, body: r.body };
        } },
        { name: 'GET /api/nodes/as-of', run: async (who, g) => {
            const r = await http(who, tryNodesRoutes as Handler, 'GET', '/api/nodes/as-of?workspace=ws&at=2026-06-01T00:00:00Z', nodesDeps(g));
            return { rows: r.json.nodes, body: r.body };
        } },
        { name: 'GET /api/workspaces/:name/snapshot', run: async (who, g) => {
            const r = await http(who, tryVersioningRoutes as Handler, 'GET', '/api/workspaces/ws/snapshot', nodesDeps(g));
            return { rows: r.json.snapshot.split('\n').filter(Boolean).map((l: string) => JSON.parse(l)), body: r.body };
        } },
        { name: 'MCP export_snapshot', run: async (who, g) => {
            const tools = mcpTools((s) => registerVersioningTools(s, { versionStore: {} as never, store: stores(g), detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
            const r = await as(who, () => call(tools.get('export_snapshot')!, { workspace: 'ws' }));
            assert.ok(!r.isError, r.text);
            return { rows: r.json.snapshot.split('\n').filter(Boolean).map((l: string) => JSON.parse(l)), body: r.text };
        } },
    ];
    for (const sf of surfaces) {
        await test(`${sf.name}: hidden/deleted successor presented as absent for a scope-less actor; ONE batched lookup`, async () => {
            for (const who of ['sales', 'none'] as const) {
                const g = makeGraph(rows());
                const r = await sf.run(who, g);
                assertRedacted(byId(r.rows), `${sf.name}/${who}`);
                assert.ok(!r.body.includes(HID) && !r.body.includes('content of ' + HID), `${sf.name}/${who}: body still names the hidden successor`);
                assert.equal(g.hydrateCalls, 1, `${sf.name}/${who}: expected exactly one getNodesByIds, got ${g.hydrateCalls}`);
            }
        });
        await test(`${sf.name}: scope holder and unbound actor keep every pointer, no lookup`, async () => {
            for (const who of ['finance', 'unbound'] as const) {
                const g = makeGraph(rows());
                const r = await sf.run(who, g);
                assertPristine(byId(r.rows), `${sf.name}/${who}`);
                if (who === 'unbound') assert.equal(g.hydrateCalls, 0, 'unbound actors never pay for a lookup');
            }
        });
    }

    await test('GET /api/node: single-node read redacts a hidden successor, rides the neighbour lookup (no extra batch)', async () => {
        const gBase = makeGraph(rows());
        await http('sales', tryNodesRoutes as Handler, 'GET', '/api/node?id=old-vis&workspace=ws', nodesDeps(gBase));
        const baseline = gBase.hydrateCalls;
        const g = makeGraph(rows());
        const r = await http('sales', tryNodesRoutes as Handler, 'GET', '/api/node?id=old-hid&workspace=ws', nodesDeps(g));
        assert.equal(r.status, 200);
        assert.equal(r.json.node.supersededBy, null);
        assert.equal(r.json.node.supersededReason, null);
        assert.equal(r.json.node.supersededAt, '2026-02-01T00:00:00Z');
        assert.ok(!r.body.includes(HID));
        assert.equal(g.hydrateCalls, baseline, 'successor lookup must share the neighbour batch');
        const del = await http('none', tryNodesRoutes as Handler, 'GET', '/api/node?id=old-gone&workspace=ws', nodesDeps(makeGraph(rows())));
        assert.equal(del.json.node.supersededBy, null);
        const vis = await http('sales', tryNodesRoutes as Handler, 'GET', '/api/node?id=old-vis&workspace=ws', nodesDeps(makeGraph(rows())));
        assert.equal(vis.json.node.supersededBy, 'new-vis');
        for (const who of ['finance', 'unbound'] as const) {
            const full = await http(who, tryNodesRoutes as Handler, 'GET', '/api/node?id=old-hid&workspace=ws', nodesDeps(makeGraph(rows())));
            assert.equal(full.json.node.supersededBy, HID, who);
        }
    });

    await test('GET /api/node/lineage: a hidden successor is dropped from the chain AND its id is nulled on the survivor', async () => {
        const chain = [
            node('l-old', [], { supersededBy: 'l-mid', supersededReason: 'to l-mid', supersededAt: '2026-02-01T00:00:00Z' }),
            node('l-mid', [], { supersededBy: 'zz-l-hidden', supersededReason: 'to zz-l-hidden', supersededAt: '2026-03-01T00:00:00Z' }),
            node('zz-l-hidden', ['finance']),
        ];
        const g = makeGraph(chain);
        const r = await http('sales', tryNodesRoutes as Handler, 'GET', '/api/node/lineage?id=l-old&workspace=ws', nodesDeps(g));
        const m = byId(r.json.chain);
        assert.deepEqual(Object.keys(m).sort(), ['l-mid', 'l-old']);
        assert.equal(m['l-old']!.supersededBy, 'l-mid');
        assert.equal(m['l-mid']!.supersededBy, null);
        assert.equal(m['l-mid']!.supersededReason, null);
        assert.equal(m['l-mid']!.supersededAt, '2026-03-01T00:00:00Z');
        assert.ok(!r.body.includes('zz-l-hidden'));
        for (const who of ['finance', 'unbound'] as const) {
            const f = await http(who, tryNodesRoutes as Handler, 'GET', '/api/node/lineage?id=l-old&workspace=ws', nodesDeps(makeGraph(chain)));
            assert.equal(byId(f.json.chain)['l-mid']!.supersededBy, 'zz-l-hidden', who);
        }
    });

    await test('a pointer to a successor that is itself in the visible response needs no lookup', async () => {
        const g = makeGraph([node('a', [], { supersededBy: 'b' }), node('b', [])]);
        const r = await http('sales', tryBulkListRoutes as Handler, 'POST', '/api/nodes/bulk-list', nodesDeps(g), { workspace: 'ws' });
        assert.equal(byId(r.json.nodes)['a']!.supersededBy, 'b');
        assert.equal(g.hydrateCalls, 0);
    });
    await test('a failing successor lookup fails CLOSED (pointer nulled, response still served)', async () => {
        const g = makeGraph(rows());
        g.getNodesByIds = async () => { throw new Error('boom'); };
        const r = await http('sales', tryBulkListRoutes as Handler, 'POST', '/api/nodes/bulk-list', nodesDeps(g), { workspace: 'ws' });
        assert.equal(r.status, 200);
        const m = byId(r.json.nodes);
        assert.equal(m['old-hid']!.supersededBy, null);
        assert.equal(m['old-vis']!.supersededBy, 'new-vis', 'present in the response, so no lookup needed');
        assert.equal(m['old-gone']!.supersededBy, null);
    });
}

/* ── 5. aggregate / per-node emitters ────────────────────────────────── */
console.log('5. topology, freshness, corpus_health, hot context, resolve_deferred, report, consistency');
{
    const OLD = '2020-01-01T00:00:00Z';
    const NEW = new Date().toISOString();
    // pa/pb/pc are public; hid-a/hid-b/hid-c need 'finance'. pc points at hid-a.
    const rows = () => [
        node('pa', [], { syncedAt: OLD, stale: true }),
        node('pb', [], { syncedAt: NEW }),
        node('pc', [], { syncedAt: NEW, supersededBy: 'hid-a', supersededReason: 'replaced by hid-a', supersededAt: '2026-02-01T00:00:00Z' }),
        node('hid-a', ['finance'], { syncedAt: OLD, stale: true }),
        node('hid-b', ['finance'], { syncedAt: OLD }),
        node('hid-c', ['finance'], { syncedAt: NEW }),
    ];
    const edges = (): Edge[] => [
        { sourceId: 'pa', targetId: 'pb', relation: 'relates_to' },
        { sourceId: 'pa', targetId: 'hid-a', relation: 'relates_to' },
        { sourceId: 'hid-a', targetId: 'hid-b', relation: 'relates_to' },
        { sourceId: 'pc', targetId: 'hid-a', relation: 'relates_to' },
    ];
    const mk = () => makeGraph(rows(), edges());
    const asList = (v: unknown): string[] => (v as string[]).slice().sort();

    // ── topology ─────────────────────────────────────────────────────────
    await test('topology: bound actor without the scope gets no hidden node, no edge touching one, and a nulled pointer', async () => {
        const g = mk();
        const r = await http('none', tryTopologyRoutes as never, 'GET', '/api/topology?workspace=ws', httpDeps(g));
        assert.equal(r.status, 200);
        assert.deepEqual(asList(r.json['nodes'].map((n: any) => n.id)), ['pa', 'pb', 'pc']);
        assert.deepEqual(r.json['edges'].map((e: any) => `${e.from}>${e.to}`), ['pa>pb']);
        assert.equal(r.json['nodes'].find((n: any) => n.id === 'pc').supersededBy, null);
        assert.equal(r.json['nodes'].find((n: any) => n.id === 'pc').supersededReason, null);
        assert.ok(!r.body.includes('hid-'), 'no hidden id anywhere in the body');
    });
    await test('topology: hydrates once, and the scope holder / unbound caller keep everything', async () => {
        const g = mk();
        await http('none', tryTopologyRoutes as never, 'GET', '/api/topology?workspace=ws', httpDeps(g));
        assert.equal(g.hydrateCalls, 1, 'one batched getNodesByIds');
        const f = await http('finance', tryTopologyRoutes as never, 'GET', '/api/topology?workspace=ws', httpDeps(mk()));
        assert.equal(f.json['nodes'].length, 6);
        assert.equal(f.json['edges'].length, 4);
        assert.equal(f.json['nodes'].find((n: any) => n.id === 'pc').supersededBy, 'hid-a');
        const g2 = mk();
        const u = await http('unbound', tryTopologyRoutes as never, 'GET', '/api/topology?workspace=ws', httpDeps(g2));
        assert.equal(u.json['nodes'].length, 6);
        assert.equal(u.json['nodes'].find((n: any) => n.id === 'pc').supersededBy, 'hid-a');
        assert.equal(g2.hydrateCalls, 0, 'unbound: no extra query');
    });

    // ── freshness ────────────────────────────────────────────────────────
    await test('freshness route: hidden rows are neither counted nor listed', async () => {
        const n = await http('none', tryFreshnessRoutes as never, 'GET', '/api/workspaces/ws/freshness', httpDeps(mk()));
        assert.equal(n.status, 200);
        assert.equal(n.json['totalNodes'], 3);
        assert.equal(n.json['staleNodes'], 1);
        assert.deepEqual(n.json['staleNodeIds'], ['pa']);
        assert.ok(!n.body.includes('hid-'));
        const f = await http('finance', tryFreshnessRoutes as never, 'GET', '/api/workspaces/ws/freshness', httpDeps(mk()));
        assert.equal(f.json['totalNodes'], 6);
        assert.deepEqual(asList(f.json['staleNodeIds']), ['hid-a', 'hid-b', 'pa']);
        const u = await http('unbound', tryFreshnessRoutes as never, 'GET', '/api/workspaces/ws/freshness', httpDeps(mk()));
        assert.equal(u.json['totalNodes'], 6);
    });
    await test('check_freshness tool: same filter', async () => {
        const tools = mcpTools((s) => registerCorpusHealthTools(s, { store: stores(mk()), auxStore: fakeAux() as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const n = await as('none', () => call(tools.get('check_freshness')!, { workspace: 'ws' }));
        assert.equal(n.json['totalNodes'], 3);
        assert.deepEqual(n.json['staleNodeIds'], ['pa']);
        assert.ok(!n.text.includes('hid-'));
        const f = await as('finance', () => call(tools.get('check_freshness')!, { workspace: 'ws' }));
        assert.equal(f.json['totalNodes'], 6);
        assert.deepEqual(asList(f.json['staleNodeIds']), ['hid-a', 'hid-b', 'pa']);
        const u = await as('unbound', () => call(tools.get('check_freshness')!, { workspace: 'ws' }));
        assert.equal(u.json['totalNodes'], 6);
    });

    // ── corpus_health ────────────────────────────────────────────────────
    await test('corpus_health tool: per-node counters skip hidden rows', async () => {
        const tools = mcpTools((s) => registerCorpusHealthTools(s, { store: stores(mk()), auxStore: fakeAux() as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const n = await as('none', () => call(tools.get('corpus_health')!, { workspace: 'ws' }));
        assert.equal(n.json['total_nodes'], 3);
        assert.equal(n.json['stale_nodes'], 1);
        const f = await as('finance', () => call(tools.get('corpus_health')!, { workspace: 'ws' }));
        assert.equal(f.json['total_nodes'], 6);
        assert.equal(f.json['stale_nodes'], 2);
        const u = await as('unbound', () => call(tools.get('corpus_health')!, { workspace: 'ws' }));
        assert.equal(u.json['total_nodes'], 6);
    });
    await test('corpus_health route: same filter', async () => {
        const d = { ...httpDeps(mk()), auxStore: fakeAux() };
        const n = await http('none', tryCorpusRoutes as never, 'GET', '/api/workspaces/ws/health', d);
        assert.equal(n.status, 200);
        assert.equal(n.json['total_nodes'], 3);
        assert.equal(n.json['stale_nodes'], 1);
        const f = await http('finance', tryCorpusRoutes as never, 'GET', '/api/workspaces/ws/health', { ...httpDeps(mk()), auxStore: fakeAux() });
        assert.equal(f.json['total_nodes'], 6);
        const u = await http('unbound', tryCorpusRoutes as never, 'GET', '/api/workspaces/ws/health', { ...httpDeps(mk()), auxStore: fakeAux() });
        assert.equal(u.json['total_nodes'], 6);
    });

    // ── get_hot_context ──────────────────────────────────────────────────
    const hotStore = (g: FakeGraph) => ({
        loreGraph: g, loreVerbatim: {}, storageClient: {},
        sessionCache: { getHotContext: () => ({ recent_nodes: ['pa', 'hid-a', 'ghost-deleted', 'pb'] }) },
    }) as never;
    await test('get_hot_context: hidden and deleted ids are dropped for a bound actor', async () => {
        const g = mk();
        const tools = mcpTools((s) => registerGovernanceTools(s, { store: hotStore(g), getSyncEngine: () => ({}) as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const n = await as('none', () => call(tools.get('get_hot_context')!, { workspace: 'ws' }));
        assert.deepEqual(n.json['recent_nodes'], ['pa', 'pb']);
        assert.equal(g.hydrateCalls, 1);
        assert.ok(!n.text.includes('hid-a'));
        const f = await as('finance', () => call(tools.get('get_hot_context')!, { workspace: 'ws' }));
        assert.deepEqual(f.json['recent_nodes'], ['pa', 'hid-a', 'pb']);
        const g2 = mk();
        const tools2 = mcpTools((s) => registerGovernanceTools(s, { store: hotStore(g2), getSyncEngine: () => ({}) as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const u = await as('unbound', () => call(tools2.get('get_hot_context')!, { workspace: 'ws' }));
        assert.deepEqual(u.json['recent_nodes'], ['pa', 'hid-a', 'ghost-deleted', 'pb'], 'unbound: verbatim');
        assert.equal(g2.hydrateCalls, 0);
    });

    // ── resolve_deferred ─────────────────────────────────────────────────
    const defRows = () => [node('deferred-vis', []), node('deferred-hid', ['finance'])];
    await test('resolve_deferred tool: hidden node = missing node, never stamped', async () => {
        const g = makeGraph(defRows());
        const tools = mcpTools((s) => registerGovernanceTools(s, { store: stores(g), getSyncEngine: () => ({}) as never, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        const hid = await as('none', () => call(tools.get('resolve_deferred')!, { id: 'deferred-hid', workspace: 'ws' }));
        const gone = await as('none', () => call(tools.get('resolve_deferred')!, { id: 'deferred-gone', workspace: 'ws' }));
        assert.equal(hid.isError, true);
        assert.equal(hid.text.replaceAll('deferred-hid', 'X'), gone.text.replaceAll('deferred-gone', 'X'), 'hidden response == missing response');
        assert.equal(g.upserts.length, 0, 'nothing written');
        const ok = await as('none', () => call(tools.get('resolve_deferred')!, { id: 'deferred-vis', workspace: 'ws' }));
        assert.equal(ok.isError, false);
        assert.equal(g.upserts.length, 1);
        const f = await as('finance', () => call(tools.get('resolve_deferred')!, { id: 'deferred-hid', workspace: 'ws' }));
        assert.equal(f.isError, false, 'scope holder can resolve');
        assert.equal(g.upserts.length, 2);
    });
    const policy = ((req, res, _u, pathname, deps) => tryPolicyRoutes(req, res, deps, pathname)) as Handler;
    await test('POST /api/resolve-deferred: hidden node = same 404 as missing, never stamped', async () => {
        const g = makeGraph(defRows());
        const d = { ...httpDeps(g), runRetentionSweep: async () => ({}), detectedScope: { workspace: 'ws', ecosystem: '*' } };
        const hid = await http('none', policy, 'POST', '/api/resolve-deferred', d, { id: 'deferred-hid' });
        const gone = await http('none', policy, 'POST', '/api/resolve-deferred', d, { id: 'deferred-gone' });
        assert.equal(hid.status, 404);
        assert.equal(hid.status, gone.status);
        assert.equal(hid.body.replaceAll('deferred-hid', 'X'), gone.body.replaceAll('deferred-gone', 'X'));
        assert.equal(g.upserts.length, 0);
        const ok = await http('none', policy, 'POST', '/api/resolve-deferred', d, { id: 'deferred-vis' });
        assert.equal(ok.status, 200);
        const f = await http('finance', policy, 'POST', '/api/resolve-deferred', d, { id: 'deferred-hid' });
        assert.equal(f.status, 200);
        assert.equal(g.upserts.length, 2);
    });

    // ── /api/report ──────────────────────────────────────────────────────
    const reportH = ((_req, res, url, _p, deps) => handleReport(res, url, deps).then(() => true)) as Handler;
    await test('GET /api/report: hubs / recent / orphans omit hidden nodes', async () => {
        const n = await http('none', reportH, 'GET', '/api/report?workspace=ws&topN=10', httpDeps(mk()));
        assert.equal(n.status, 200);
        assert.ok(!n.body.includes('hid-'), 'no hidden id or label in the markdown');
        assert.ok(n.body.includes('`pa`'), 'visible hub still listed');
        const f = await http('finance', reportH, 'GET', '/api/report?workspace=ws&topN=10', httpDeps(mk()));
        assert.ok(f.body.includes('`hid-a`'));
        assert.ok(f.body.includes('`hid-c`'), 'hidden orphan shows for the scope holder');
        const u = await http('unbound', reportH, 'GET', '/api/report?workspace=ws&topN=10', httpDeps(mk()));
        assert.ok(u.body.includes('`hid-a`'));
    });

    // ── /api/diagnose/consistency ────────────────────────────────────────
    const consH = ((_req, res, url, _p, deps) => handleConsistency(res, url, deps).then(() => true)) as Handler;
    const consDeps = (g: FakeGraph, vectorIds: string[]) => {
        const d = httpDeps(g);
        return { ...d, store: { ...d.store, loreVerbatim: { listIds: async () => vectorIds } }, configManager: {}, activeSessions: new Map(), getDataplaneState: () => ({}) };
    };
    await test('GET /api/diagnose/consistency: missingEmbeddings omits hidden ids', async () => {
        const vec = ['lore:pa', 'lore:pb'];
        const n = await http('none', consH, 'GET', '/api/diagnose/consistency?workspace=ws', consDeps(mk(), vec));
        assert.equal(n.status, 200);
        assert.deepEqual(n.json['missingEmbeddings'], ['pc']);
        assert.ok(!n.body.includes('hid-'));
        const all = ['lore:pa', 'lore:pb', 'lore:pc'];
        const clean = await http('none', consH, 'GET', '/api/diagnose/consistency?workspace=ws', consDeps(mk(), all));
        assert.deepEqual(clean.json['missingEmbeddings'], []);
        assert.equal(clean.json['hasIssues'], false, 'hidden-only gaps do not flag an issue for this actor');
        const f = await http('finance', consH, 'GET', '/api/diagnose/consistency?workspace=ws', consDeps(mk(), all));
        assert.deepEqual(asList(f.json['missingEmbeddings']), ['hid-a', 'hid-b', 'hid-c']);
        const u = await http('unbound', consH, 'GET', '/api/diagnose/consistency?workspace=ws', consDeps(mk(), all));
        assert.deepEqual(asList(u.json['missingEmbeddings']), ['hid-a', 'hid-b', 'hid-c']);
    });
}


console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(TMP_HOME, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
