#!/usr/bin/env tsx
/**
 * test/direct-read-scopes-graph-unit.ts — row-level security_scopes on the
 * direct graph reads the 2026-08-17 remediation missed (finding #20,
 * docs/audit/FINDINGS-2026-08-17-opus-reaudit.md).
 *
 * Paths covered (each: hidden row vs scope-less actor, matching actor,
 * unbound actor, public row visible to a scope-less bound actor):
 *   1. MCP get_full                     (HTTP twin: nodeFull.ts)
 *   2. MCP list_nodes                   (HTTP twin: inspect.ts)
 *   3. GET /api/node/lineage            (hidden middle/start node == deleted)
 *   4. GET /api/nodes/as-of
 *   5. GET /api/edges                   (either endpoint hidden)
 *   6. MCP check_anchors + GET /api/nodes/:id/anchors
 *   7. GET /api/node/supersession-candidates (+ its result cache)
 *
 * Contract (Rafi): unbound actor (getCurrentActorScopes() undefined) = no
 * filtering; hidden single item = byte-identical to a missing id; lists drop
 * hidden rows silently.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { tryAnchorsRoutes } from '../packages/lore/src/mcp/http/routes/anchors.js';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import { registerAnchorTools } from '../packages/lore/src/mcp/tools/anchors.js';

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

function fakeReq(method: string, url: string): IncomingMessage {
    return { method, url, on: () => { /* no-op */ } } as unknown as IncomingMessage;
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
        initialize: async () => undefined,
        getNode: async (id: string) => byId.get(id) ?? null,
        getNodesByIds: async (ids: string[]) => {
            g.hydrateCalls++;
            const m = new Map<string, N>();
            for (const id of ids) if (byId.has(id)) m.set(id, byId.get(id)!);
            return m;
        },
        listNodes: async () => nodes,
        bulkList: async () => ({ nodes, hasMore: false, nextCursor: null }),
        bulkListProjected: async (_project: string, columns: readonly string[]) => ({
            rows: nodes.map((n) => Object.fromEntries([['id', n.id], ...columns.map((c) => [c, n[c]])])),
            nextCursor: null,
        }),
        queryEdges: async (q: { source?: string; target?: string; relation?: string; limit: number; offset: number }) =>
            edges.filter((e) => (!q.source || e.sourceId === q.source) && (!q.target || e.targetId === q.target)
                && (!q.relation || e.relation === q.relation)).slice(q.offset, q.offset + q.limit),
        findSupersededByPredecessors: async (id: string) =>
            nodes.filter((n) => n.supersededBy === id).map((n) => n.id).sort(),
        upsertNode: async (n: N) => { byId.set(n.id, n); },
        search: async () => [],
    };
    return g;
}
type FakeGraph = ReturnType<typeof makeGraph>;

function httpDeps(graph: FakeGraph, verbatimHits: Array<{ id: string; score: number }> = []) {
    const registry = { getOrOpen: async () => graph, getGraphHandle: async () => graph, activeName: () => 'ws' };
    const storageClient = Object.assign({}, graph, { verbatimCount: async () => 0, verbatimSearch: async () => verbatimHits });
    const store = { loreGraph: graph, storageClient, loreVerbatim: { count: async () => 0, search: async () => [] } };
    return { deploymentMode: 'local' as const, dataplane: null, store, graphRegistry: registry, auditLog: {} };
}

async function get(url: string, deps: ReturnType<typeof httpDeps>): Promise<{ status: number; body: string; json: Record<string, any> }> {
    const res = fakeRes();
    const pathname = url.split('?')[0]!;
    let handled: boolean;
    if (pathname === '/api/edges') {
        handled = await tryEdgesRoutes(fakeReq('GET', url), res, url, pathname, deps as never);
    } else if (/^\/api\/nodes\/[^/]+\/anchors$/.test(pathname)) {
        handled = await tryAnchorsRoutes(fakeReq('GET', url), res, url, pathname, deps as never);
    } else {
        handled = await tryNodesRoutes(fakeReq('GET', url), res, url, pathname, deps as never);
    }
    assert.equal(handled, true, `route ${pathname} must be handled`);
    return { status: res._status, body: res._body, json: res._body ? JSON.parse(res._body) : {} };
}

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
    return { text: r.content[0]!.text, isError: r.isError === true, json: JSON.parse(r.content[0]!.text) as Record<string, any> };
}
function diagTools(graph: FakeGraph): Map<string, Tool> {
    return mcpTools((server) => registerDiagnosticTools(server, {
        store: { loreGraph: graph, loreVerbatim: {} } as never,
        pluginRegistry: { collectPluginStats: async () => ({}) } as never,
        detectedScope: { workspace: 'ws', ecosystem: '*' },
        deploymentMode: 'local',
        graphBasePath: '/tmp/lore-direct-read-scopes-fixture',
        nodeTypesEnum: z.enum(['decision', 'note'] as [string, ...string[]]),
    } as never));
}

/* ── scenarios ───────────────────────────────────────────────────────── */

(async () => {
    const pub = node('pub', []);
    const sec = node('sec', ['finance']);

    console.log('1. MCP get_full');
    {
        const tools = diagTools(makeGraph([pub, sec]));
        const getFull = tools.get('get_full')!;
        const missing = await as('sales', () => call(getFull, { id: 'nope', workspace: 'ws' }));
        await test('hidden node is the byte-identical not-found envelope of a missing id (modulo the id)', async () => {
            const hidden = await as('sales', () => call(getFull, { id: 'sec', workspace: 'ws' }));
            assert.equal(hidden.isError, true);
            assert.equal(hidden.text.replace('sec', 'nope').replace("'sec'", "'nope'"), missing.text);
            assert.ok(!hidden.text.includes('content of sec'));
        });
        await test('bound actor with zero scopes cannot read a scoped node', async () => {
            const r = await as('none', () => call(getFull, { id: 'sec', workspace: 'ws' }));
            assert.equal(r.json.found, false);
        });
        await test('actor holding the scope gets the full node', async () => {
            const r = await as('finance', () => call(getFull, { id: 'sec', workspace: 'ws' }));
            assert.equal(r.json.found, true);
            assert.equal(r.json.content, 'content of sec');
        });
        await test('unbound actor is unfiltered', async () => {
            const r = await as('unbound', () => call(getFull, { id: 'sec', workspace: 'ws' }));
            assert.equal(r.json.found, true);
        });
        await test('public node is visible to a scope-less bound actor', async () => {
            const r = await as('none', () => call(getFull, { id: 'pub', workspace: 'ws' }));
            assert.equal(r.json.found, true);
        });
    }

    console.log('2. MCP list_nodes');
    {
        const ids = async (who: Who, graph: FakeGraph) => {
            const r = await as(who, () => call(diagTools(graph).get('list_nodes')!, { workspace: 'ws' }));
            return r.json as { count: number; nodes: Array<{ id: string }>; nextCursor?: string };
        };
        const rows = [pub, sec, node('pub2', [])];
        const g = makeGraph(rows);
        g.bulkList = (async () => ({ nodes: rows, hasMore: false, nextCursor: null })) as never;
        await test('hidden rows are dropped silently; count reflects the visible set', async () => {
            const r = await ids('sales', g);
            assert.deepEqual(r.nodes.map((n) => n.id), ['pub', 'pub2']);
            assert.equal(r.count, 2);
        });
        await test('zero-scope bound actor sees only public rows', async () => {
            assert.deepEqual((await ids('none', g)).nodes.map((n) => n.id), ['pub', 'pub2']);
        });
        await test('actor holding the scope sees everything', async () => {
            assert.deepEqual((await ids('finance', g)).nodes.map((n) => n.id), ['pub', 'sec', 'pub2']);
        });
        await test('unbound actor is unfiltered', async () => {
            assert.deepEqual((await ids('unbound', g)).nodes.map((n) => n.id), ['pub', 'sec', 'pub2']);
        });
        // SUPERSEDES the earlier "cursor from the last RAW row" assertion (Rafi,
        // "fill pages"): a hidden tail row must never reach the cursor or flip
        // hasMore. Full coverage: test/scopes-page-fill-unit.ts.
        await test('a hidden tail row never reaches the cursor: hasMore:false, no cursor (== world without it)', async () => {
            const tail = [pub, node('pub2', []), sec];   // same updatedAt → ordered by id ASC
            const g2 = makeGraph(tail);
            g2.bulkList = (async (q: { limit: number; cursor?: { updatedAt: string; id: string } | null }) => {
                const rest = q.cursor ? tail.filter((n) => n.id > q.cursor!.id) : tail;
                const nodes = rest.slice(0, q.limit);
                const hasMore = rest.length > q.limit;
                const last = nodes[nodes.length - 1];
                return { nodes, hasMore, nextCursor: hasMore && last ? { updatedAt: String(last.updatedAt), id: last.id } : null };
            }) as never;
            const r = await ids('sales', g2);
            assert.deepEqual(r.nodes.map((n) => n.id), ['pub', 'pub2']);
            assert.equal((r as { hasMore?: boolean }).hasMore, false);
            assert.equal(r.nextCursor, undefined, 'no cursor: the only thing after the page is a hidden row');
            // Page size 1: the cursor names the last VISIBLE row ('pub'), not a hidden one.
            const one = await as('sales', () => call(diagTools(g2).get('list_nodes')!, { workspace: 'ws', limit: 1 }));
            assert.equal(one.json.hasMore, true);
            const decoded = JSON.parse(Buffer.from(one.json.nextCursor as string, 'base64url').toString('utf8')) as { id: string };
            assert.equal(decoded.id, 'pub');
        });
    }

    console.log('3. GET /api/node/lineage');
    {
        // v1 (public) → v2 (finance) → v3 (public); plus a lone finance node.
        const chain = [
            node('v1', [], { supersededBy: 'v2', supersededAt: '2026-02-01T00:00:00Z' }),
            node('v2', ['finance'], { supersededBy: 'v3', supersededAt: '2026-03-01T00:00:00Z' }),
            node('v3', []),
            node('solo', ['finance']),
        ];
        const d = httpDeps(makeGraph(chain));
        const lineage = async (who: Who, id: string) => as(who, () => get(`/api/node/lineage?id=${id}&workspace=ws`, d));
        const ids = (r: { json: Record<string, any> }) => (r.json.chain as Array<{ id: string }>).map((n) => n.id);

        // Rafi 2026-10-06: stop at the gap. A hidden middle node ends the walk
        // exactly like a deleted one, so the chain never proves a hidden node
        // sits between two visible ones.
        const dMidDeleted = httpDeps(makeGraph(chain.filter((n) => n.id !== 'v2')));
        await test('hidden MIDDLE node ends the walk like a deleted one (start at newest)', async () => {
            const r = await lineage('sales', 'v3');
            assert.equal(r.status, 200);
            assert.deepEqual(ids(r), ['v3']);
            assert.ok(!r.body.includes('content of v2') && !r.body.includes('Label v2'));
            const deleted = await as('sales', () => get(`/api/node/lineage?id=v3&workspace=ws`, dMidDeleted));
            assert.equal(r.body, deleted.body);
        });
        await test('hidden middle node ends the walk when starting at the oldest; pointer nulled', async () => {
            const r = await lineage('none', 'v1');
            assert.deepEqual(ids(r), ['v1']);
            assert.equal(r.json.chain[0].supersededBy, null);
            const deleted = await as('none', () => get(`/api/node/lineage?id=v1&workspace=ws`, dMidDeleted));
            assert.equal(r.body, deleted.body);
        });
        await test('actor with the scope sees the whole chain', async () => {
            assert.deepEqual(ids(await lineage('finance', 'v3')), ['v1', 'v2', 'v3']);
        });
        await test('unbound actor sees the whole chain', async () => {
            assert.deepEqual(ids(await lineage('unbound', 'v1')), ['v1', 'v2', 'v3']);
        });
        await test('hidden START node answers exactly like the same node deleted (no existence oracle)', async () => {
            const hidden = await lineage('sales', 'v2');
            // Same chain with v2 deleted: v1 still names it in supersededBy.
            const dDeleted = httpDeps(makeGraph(chain.filter((n) => n.id !== 'v2')));
            const deleted = await as('sales', () => get(`/api/node/lineage?id=v2&workspace=ws`, dDeleted));
            assert.equal(hidden.status, deleted.status);
            assert.equal(hidden.body, deleted.body);
            assert.deepEqual(ids(hidden), ['v1']);
            // A hidden node with no visible predecessors answers like a missing id.
            const solo = await lineage('sales', 'solo');
            const missing = await lineage('sales', 'does-not-exist');
            assert.equal(solo.status, missing.status);
            assert.equal(solo.body.replace('"solo"', '"X"'), missing.body.replace('"does-not-exist"', '"X"'));
            assert.deepEqual(ids(solo), []);
        });
        await test('response shape of a visible entry is unchanged', async () => {
            const r = await lineage('sales', 'v3');
            assert.deepEqual(Object.keys(r.json.chain[0]).sort(), [
                'content', 'createdAt', 'id', 'label', 'project', 'supersededAt', 'supersededBy', 'supersededReason', 'type', 'updatedAt',
            ]);
        });
    }

    console.log('4. GET /api/nodes/as-of');
    {
        // Scopes are a property of the node's CURRENT row; the valid-time window
        // is separate. "tightened" = once public, now finance-only; "widened" =
        // once finance-only, now public. Only the current row exists to check.
        const rows = [
            node('widened', [], { validFrom: '2026-01-01T00:00:00Z', validUntil: null }),
            node('tightened', ['finance'], { validFrom: '2026-01-01T00:00:00Z', validUntil: null }),
            node('expired-secret', ['finance'], { validFrom: '2025-01-01T00:00:00Z', validUntil: '2025-06-01T00:00:00Z' }),
            node('future-public', [], { validFrom: '2027-01-01T00:00:00Z' }),
        ];
        const d = httpDeps(makeGraph(rows));
        const asOf = async (who: Who) => as(who, () => get('/api/nodes/as-of?workspace=ws&at=2026-06-01T00:00:00Z', d));
        const ids = (r: { json: Record<string, any> }) => (r.json.nodes as Array<{ id: string }>).map((n) => n.id).sort();
        await test('scope-less actor: window still applies AND tightened row is hidden; count matches', async () => {
            const r = await asOf('sales');
            assert.deepEqual(ids(r), ['widened']);
            assert.equal(r.json.count, 1);
        });
        await test('bound zero-scope actor sees only the public in-window row', async () => {
            assert.deepEqual(ids(await asOf('none')), ['widened']);
        });
        await test('actor with the scope sees the in-window finance row (and never widens past the window)', async () => {
            assert.deepEqual(ids(await asOf('finance')), ['tightened', 'widened']);
        });
        await test('unbound actor unchanged', async () => {
            assert.deepEqual(ids(await asOf('unbound')), ['tightened', 'widened']);
        });
    }

    console.log('5. GET /api/edges');
    {
        const rows = [node('a', []), node('b', []), node('s', ['finance'])];
        const edges: Edge[] = [
            { sourceId: 'a', targetId: 'b', relation: 'related_to' },
            { sourceId: 'a', targetId: 's', relation: 'related_to' },   // hidden target
            { sourceId: 's', targetId: 'b', relation: 'related_to' },   // hidden source
            { sourceId: 'a', targetId: 'ghost', relation: 'related_to' }, // dangling
        ];
        const graph = makeGraph(rows, edges);
        const d = httpDeps(graph);
        const list = async (who: Who, qs = '') => as(who, () => get(`/api/edges?workspace=ws${qs}`, d));
        const pairs = (r: { json: Record<string, any> }) =>
            (r.json.edges as Edge[]).map((e) => `${e.sourceId}>${e.targetId}`);
        await test('edge with a hidden target OR hidden source is dropped; count reflects it', async () => {
            const r = await list('sales');
            assert.deepEqual(pairs(r), ['a>b']);
            assert.equal(r.json.count, 1);
            assert.ok(!r.body.includes('"s"'), 'hidden id must not appear anywhere in the body');
        });
        await test('filtering by the hidden node as source/target returns nothing', async () => {
            assert.deepEqual(pairs(await list('sales', '&source=s')), []);
            assert.deepEqual(pairs(await list('sales', '&target=s')), []);
        });
        await test('actor with the scope sees the edges to the hidden-for-others node', async () => {
            assert.deepEqual(pairs(await list('finance')).sort(), ['a>b', 'a>s', 's>b']);
        });
        await test('unbound actor: unchanged, no hydration query issued', async () => {
            graph.hydrateCalls = 0;
            const r = await list('unbound');
            assert.deepEqual(pairs(r), ['a>b', 'a>s', 's>b', 'a>ghost']);
            assert.equal(graph.hydrateCalls, 0);
        });
        await test('endpoints hydrated in ONE batch for a bound actor (no N+1)', async () => {
            graph.hydrateCalls = 0;
            await list('sales');
            assert.equal(graph.hydrateCalls, 1);
        });
        await test('ecosystem scope and actor scope compose', async () => {
            const eco = makeGraph([node('a', [], { ecosystem: 'e1' }), node('b', [], { ecosystem: 'e1' }), node('s', ['finance'], { ecosystem: 'e1' })],
                [{ sourceId: 'a', targetId: 'b', relation: 'r' }, { sourceId: 'a', targetId: 's', relation: 'r' }]);
            const r = await as('sales', () => get('/api/edges?workspace=ws&ecosystem=e1', httpDeps(eco)));
            assert.deepEqual(pairs(r), ['a>b']);
        });
    }

    console.log('6. check_anchors (MCP) + GET /api/nodes/:id/anchors');
    {
        const anchors = JSON.stringify([{ type: 'url', ref: 'https://secret.example/doc' }]);
        const rows = [node('pub', [], { anchors }), node('sec', ['finance'], { anchors })];
        const graph = makeGraph(rows);
        const d = httpDeps(graph);
        const tools = mcpTools((server) => registerAnchorTools(server, { store: { loreGraph: graph } as never }));
        const check = tools.get('check_anchors')!;
        await test('MCP: hidden node == missing id, and mark_stale does NOT mutate it', async () => {
            const hidden = await as('sales', () => call(check, { id: 'sec', workspace: 'ws', mark_stale: true }));
            const missing = await as('sales', () => call(check, { id: 'nope', workspace: 'ws', mark_stale: true }));
            assert.equal(hidden.isError, true);
            assert.equal(hidden.text.replace('sec', 'nope'), missing.text);
            assert.ok(!hidden.text.includes('secret.example'));
            assert.equal((await graph.getNode('sec'))!.anchor_stale, undefined, 'hidden node must not be mutated');
        });
        await test('MCP: matching actor, unbound actor and public node work', async () => {
            assert.equal((await as('finance', () => call(check, { id: 'sec', workspace: 'ws' }))).json.anchor_count, 1);
            assert.equal((await as('unbound', () => call(check, { id: 'sec', workspace: 'ws' }))).json.anchor_count, 1);
            assert.equal((await as('none', () => call(check, { id: 'pub', workspace: 'ws' }))).json.anchor_count, 1);
        });
        await test('HTTP: hidden node is the same 404 as a missing id; others unchanged', async () => {
            const hidden = await as('sales', () => get('/api/nodes/sec/anchors?workspace=ws', d));
            const missing = await as('sales', () => get('/api/nodes/nope/anchors?workspace=ws', d));
            assert.equal(hidden.status, 404);
            assert.equal(hidden.body.split('sec').join('nope'), missing.body);
            assert.equal((await as('finance', () => get('/api/nodes/sec/anchors?workspace=ws', d))).status, 200);
            assert.equal((await as('unbound', () => get('/api/nodes/sec/anchors?workspace=ws', d))).status, 200);
            assert.equal((await as('none', () => get('/api/nodes/pub/anchors?workspace=ws', d))).status, 200);
        });
    }

    console.log('7. GET /api/node/supersession-candidates');
    {
        const rows = [node('d-pub-1', []), node('d-pub-2', [], { createdAt: '2026-01-05T00:00:00Z' }), node('d-sec', ['finance'], { createdAt: '2026-01-06T00:00:00Z' })];
        const hits = [{ id: 'd-pub-1', score: 0.9 }, { id: 'd-pub-2', score: 0.9 }, { id: 'd-sec', score: 0.9 }];
        const d = httpDeps(makeGraph(rows), hits);
        // Distinct project per call group is not possible (project is part of the
        // cache key), so every call below runs WITHOUT ?fresh=true on purpose when
        // testing the cache, and with it otherwise.
        const run = async (who: Who, fresh: boolean) =>
            as(who, () => get(`/api/node/supersession-candidates?workspace=ws&types=decision&minScore=0.5${fresh ? '&fresh=true' : ''}`, d));
        const touches = (r: { body: string }) => r.body.includes('d-sec') || r.body.includes('content of d-sec');
        await test('unbound actor: pairs involve the scoped node (unchanged)', async () => {
            const r = await run('unbound', true);
            assert.equal(r.status, 200);
            assert.ok(touches(r), 'baseline: unbound actor sees the scoped candidate');
        });
        await test('scope-less actor: no pair, id, label or content of the hidden node; cache from the unbound call is NOT replayed', async () => {
            const r = await run('sales', false); // cache holds the unbound payload
            assert.equal(r.status, 200);
            assert.ok(!touches(r), `hidden candidate leaked: ${r.body}`);
            assert.equal(r.json.cached, undefined, 'must not hit the unbound caller\'s cache entry');
            assert.equal(r.json.candidatesScanned, 2);
            assert.ok((r.json.pairs as unknown[]).length >= 1, 'the two public nodes still pair');
        });
        await test('actor holding the scope sees the pair again', async () => {
            assert.ok(touches(await run('finance', true)));
        });
        await test('scope-less actor then unbound: cache entries stay separate per actor', async () => {
            await run('sales', true);
            assert.ok(touches(await run('unbound', false)));
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
