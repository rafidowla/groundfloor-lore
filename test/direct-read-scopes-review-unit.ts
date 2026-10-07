#!/usr/bin/env tsx
/**
 * test/direct-read-scopes-review-unit.ts
 *
 * Regression tests for the security-review findings against the direct-read
 * row-level `security_scopes` work (direct-read-scopes-graph / -history):
 *
 *   1. workspace snapshot (MCP export_snapshot + REST /api/workspaces/:n/snapshot)
 *   2. GET /api/edges existence oracle (hidden source/target id)
 *   3. version-gate id collision (`lore:S`, `S#rev…` literal ids vs node `S`)
 *   4. GET /api/node/lineage hidden start == missing/deleted start
 *   5. resolveItemScopes: a version state WITHOUT a security_scopes key is not public
 *   6. supersession-candidates: cache key encoding + string-form scopes
 *   7. outcomes reads (MCP get_node_outcomes + REST GET /api/nodes/:id/outcomes)
 *
 * Contract: a bound actor lacking an item's scopes gets exactly the response
 * it would get if the item did not exist. Unbound actors are unchanged.
 *
 * Run: npx tsx test/direct-read-scopes-review-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-drsr-home-'));
process.env['LORE_HOME'] = HOME;
process.env['LORE_MODEL_SERVER'] = '0';
delete process.env['LORE_SEARCH_WORKER'];

const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
const { tryEdgesRoutes } = await import('../packages/lore/src/mcp/http/routes/edges.js');
const { tryVersioningRoutes } = await import('../packages/lore/src/mcp/http/routes/versioning.js');
const { tryOutcomesRoutes } = await import('../packages/lore/src/mcp/http/routes/outcomes.js');
const { registerVersioningTools } = await import('../packages/lore/src/mcp/tools/versioning.js');
const { registerOutcomeTools } = await import('../packages/lore/src/mcp/tools/outcomes.js');
const { VersionStore } = await import('../packages/lore/src/outbox/versionStore.js');
const { resolveItemScopes } = await import('../packages/lore/src/security/itemScopes.js');
type Principal = import('../packages/lore/src/auth/principal.js').Principal;

/* ── harness ─────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

const WS = 'ws';
const PRINCIPAL: Principal = { kind: 'app', workspace: WS, scopes: ['read'], label: 'app-read' };

type Actor = 'unbound' | string[];
function asActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
    return runWithPrincipal(PRINCIPAL, () =>
        actor === 'unbound' ? fn() : runWithActor({ portalUserId: 'u', scopes: actor }, fn));
}
const sales = ['sales'], finance = ['finance'], none: string[] = [];

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
interface Out { status: number; body: string; json: Record<string, any> }

type N = Record<string, unknown> & { id: string };
function node(id: string, scopes: unknown, extra: Record<string, unknown> = {}): N {
    return {
        id, type: 'decision', label: `Label ${id}`, content: `content of ${id}`, project: 'ws', ecosystem: '*',
        tags: [], security_scopes: scopes, metadata: '{}', createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z', supersededAt: null, supersededBy: null, ...extra,
    };
}
interface Edge { sourceId: string; targetId: string; relation: string }

function makeGraph(nodes: N[], edges: Edge[] = []) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
        initialize: async () => undefined,
        getNode: async (id: string) => byId.get(id) ?? null,
        getNodesByIds: async (ids: string[]) => {
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
        findSupersededByPredecessors: async (id: string) => nodes.filter((n) => n.supersededBy === id).map((n) => n.id).sort(),
        upsertNode: async (n: N) => { byId.set(n.id, n); },
        search: async () => [],
    };
}
type FakeGraph = ReturnType<typeof makeGraph>;

function httpDeps(graph: FakeGraph, extra: Record<string, unknown> = {}) {
    const registry = { getOrOpen: async () => graph, getGraphHandle: async () => graph, activeName: () => WS };
    const storageClient = Object.assign({}, graph, { verbatimCount: async () => 0, verbatimSearch: async () => [{ id: 'd-pub-1', score: 0.9 }, { id: 'd-pub-2', score: 0.9 }, { id: 'd-sec', score: 0.9 }] });
    const store = { loreGraph: graph, storageClient, loreVerbatim: { count: async () => 0, search: async () => [] } };
    return { deploymentMode: 'local' as const, dataplane: null, store, graphRegistry: registry, auditLog: {}, ...extra };
}

async function rest(actor: Actor, url: string, handler: (req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: never) => Promise<boolean>, deps: unknown): Promise<Out> {
    const res = fakeRes();
    const pathname = url.split('?')[0]!;
    const handled = await asActor(actor, () => handler(fakeReq('GET', url), res, url, pathname, deps as never));
    assert.equal(handled, true, `route ${pathname} must be handled`);
    return { status: res._status, body: res._body, json: res._body ? JSON.parse(res._body) : {} };
}

interface Tool { schema: Record<string, z.ZodTypeAny>; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
function mcpTools(register: (server: never) => void): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    register({ tool: (name: string, _d: string, schema: Tool['schema'], handler: Tool['handler']) => { tools.set(name, { schema, handler }); } } as never);
    return tools;
}
async function call(actor: Actor, tool: Tool, args: Record<string, unknown>): Promise<Out> {
    const parsed = z.object(tool.schema).parse(args);
    const r = await asActor(actor, () => tool.handler(parsed as Record<string, unknown>));
    const text = r.content[0]!.text;
    return { status: r.isError ? 500 : 200, body: text, json: JSON.parse(text) };
}

(async () => {
    /* ── 1. workspace snapshot ─────────────────────────────────────────── */
    console.log('1. workspace snapshot (MCP + REST)');
    {
        const rows = [node('pub', []), node('sec', ['finance']), node('both', ['sales', 'finance']), node('arch', [], { status: 'archived' })];
        const graph = makeGraph(rows);
        const d = httpDeps(graph);
        const tools = mcpTools((server) => registerVersioningTools(server, { store: d.store as never, graphRegistry: d.graphRegistry as never, versionStore: {} as never, detectedScope: { workspace: WS, ecosystem: '*' } } as never));
        const exportSnapshot = tools.get('export_snapshot')!;
        const ids = (o: Out): string[] => (o.json.snapshot as string).split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id).sort();
        const snapRest = (a: Actor) => rest(a, `/api/workspaces/${WS}/snapshot`, tryVersioningRoutes as never, d);
        const snapMcp = (a: Actor) => call(a, exportSnapshot, { workspace: WS });

        await test('REST: bound actor lacking a scope gets only visible nodes; node_count matches', async () => {
            const r = await snapRest(sales);
            assert.equal(r.status, 200);
            assert.deepEqual(ids(r), ['both', 'pub']);
            assert.equal(r.json.node_count, 2);
            assert.ok(!r.body.includes('content of sec'), 'hidden node content must not appear');
            assert.deepEqual(ids(await snapRest(none)), ['pub']);
        });
        await test('REST: allowed actor and unbound actor see everything non-archived', async () => {
            assert.deepEqual(ids(await snapRest(finance)), ['both', 'pub', 'sec']);
            const u = await snapRest('unbound');
            assert.deepEqual(ids(u), ['both', 'pub', 'sec']);
            assert.equal(u.json.node_count, 3);
        });
        await test('MCP: bound actor lacking a scope gets only visible nodes; node_count matches', async () => {
            const r = await snapMcp(sales);
            assert.deepEqual(ids(r), ['both', 'pub']);
            assert.equal(r.json.node_count, 2);
            assert.ok(!r.body.includes('content of sec'));
            assert.deepEqual(ids(await snapMcp(none)), ['pub']);
            assert.deepEqual(ids(await snapMcp(finance)), ['both', 'pub', 'sec']);
            assert.deepEqual(ids(await snapMcp('unbound')), ['both', 'pub', 'sec']);
        });
        await test('MCP export_snapshot failures are labelled export_snapshot', async () => {
            const bad = mcpTools((server) => registerVersioningTools(server, { store: { loreGraph: {} } as never, versionStore: {} as never } as never));
            const captured: string[] = [];
            const origErr = process.stderr.write.bind(process.stderr);
            const origOut = process.stdout.write.bind(process.stdout);
            const grab = (chunk: unknown): boolean => { captured.push(String(chunk)); return true; };
            process.stderr.write = grab as never;
            process.stdout.write = grab as never;
            try {
                const r = await bad.get('export_snapshot')!.handler({ workspace: WS, include_archived: false });
                assert.equal(r.isError, true);
            } finally {
                process.stderr.write = origErr as never;
                process.stdout.write = origOut as never;
            }
            const logged = captured.join('');
            assert.match(logged, /export_snapshot failed/);
            assert.doesNotMatch(logged, /node_history failed/);
        });
    }

    /* ── 2. edges existence oracle ─────────────────────────────────────── */
    console.log('2. GET /api/edges hidden source/target');
    {
        const rows = [node('pub', []), node('pub2', []), node('sec', ['finance'])];
        const edges: Edge[] = [
            { sourceId: 'sec', targetId: 'pub', relation: 'r' }, { sourceId: 'sec', targetId: 'pub2', relation: 'r' },
            { sourceId: 'pub', targetId: 'sec', relation: 'r' }, { sourceId: 'pub2', targetId: 'sec', relation: 'r' },
            { sourceId: 'pub', targetId: 'pub2', relation: 'r' },
        ];
        const d = httpDeps(makeGraph(rows, edges));
        const list = (a: Actor, qs: string) => rest(a, `/api/edges?workspace=${WS}&${qs}`, tryEdgesRoutes as never, d);

        await test('hidden `source` answers exactly like a missing id (count/hasMore/edges), even when the page is full', async () => {
            const hidden = await list(sales, 'source=sec&limit=1');
            const missing = await list(sales, 'source=nope&limit=1');
            assert.deepEqual(hidden.status, missing.status);
            assert.equal(hidden.body, missing.body, 'byte-identical body (no id is echoed)');
            assert.equal(hidden.json.hasMore, false);
            assert.equal(hidden.json.count, 0);
            assert.deepEqual(hidden.json.edges, []);
            assert.deepEqual(hidden.json, missing.json);
        });
        await test('hidden `target` answers exactly like a missing id', async () => {
            const hidden = await list(sales, 'target=sec&limit=1');
            const missing = await list(sales, 'target=nope&limit=1');
            assert.deepEqual(hidden.json, missing.json);
            assert.equal(hidden.json.hasMore, false);
            const both = await list(sales, 'source=pub&target=sec&limit=1');
            assert.deepEqual(both.json, (await list(sales, 'source=pub&target=nope&limit=1')).json);
        });
        await test('hidden `source` with a bad cursor answers exactly like a missing id with a bad cursor (400)', async () => {
            const hidden = await list(sales, 'source=sec&cursor=garbage');
            const missing = await list(sales, 'source=nope&cursor=garbage');
            assert.equal(hidden.status, 400);
            assert.equal(hidden.status, missing.status);
            assert.equal(hidden.body, missing.body);
        });
        await test('allowed actor, unbound actor and fully-visible queries are unchanged', async () => {
            assert.equal((await list(finance, 'source=sec&limit=1')).json.hasMore, true);
            assert.equal((await list(finance, 'source=sec')).json.count, 2);
            assert.equal((await list('unbound', 'source=sec')).json.count, 2);
            assert.equal((await list(sales, 'source=pub')).json.count, 1, 'edge pub->pub2 visible; pub->sec dropped');
            assert.ok(!(await list(none, 'source=pub')).body.includes('"sec"'));
        });
    }

    /* ── 4. lineage hidden start ───────────────────────────────────────── */
    console.log('4. GET /api/node/lineage hidden start');
    {
        const rows = [
            node('old2', [], { supersededBy: 'hid', supersededAt: '2026-02-01T00:00:00Z' }),
            node('hid', ['finance']),
            node('old3', [], { supersededBy: 'gone', supersededAt: '2026-02-01T00:00:00Z' }), // 'gone' is deleted
        ];
        const d = httpDeps(makeGraph(rows));
        const lineage = (a: Actor, id: string) => rest(a, `/api/node/lineage?id=${id}&workspace=${WS}`, tryNodesRoutes as never, d);
        const ids = (o: Out): string[] => (o.json.chain as Array<{ id: string }>).map((n) => n.id);

        await test('hidden start with a public predecessor == deleted start with a public predecessor (same shape)', async () => {
            const hidden = await lineage(sales, 'hid');
            const gone = await lineage(sales, 'gone');
            assert.equal(hidden.status, gone.status);
            assert.deepEqual(ids(hidden), ['old2']);
            assert.deepEqual(ids(gone), ['old3']);
            assert.deepEqual(Object.keys(hidden.json), Object.keys(gone.json));
            assert.deepEqual(Object.keys(hidden.json.chain[0]).sort(), Object.keys(gone.json.chain[0]).sort());
            assert.ok(!hidden.body.includes('content of hid') && !hidden.body.includes('Label hid'));
        });
        await test('allowed and unbound actors still see the whole chain', async () => {
            assert.deepEqual(ids(await lineage(finance, 'hid')), ['old2', 'hid']);
            assert.deepEqual(ids(await lineage('unbound', 'hid')), ['old2', 'hid']);
        });
    }

    /* ── 5. resolveItemScopes: state without the key ───────────────────── */
    console.log('5. resolveItemScopes — absent security_scopes key');
    {
        const vs = (rows: unknown[]) => ({ getVersions: async () => rows });
        const none_ = async () => null;
        await test('newest newState lacks the key -> falls through to previousState (finance), not public', async () => {
            const r = await resolveItemScopes({ nodeId: 'x' }, {
                workspace: WS, getGraphNode: none_,
                versionStore: vs([{ newState: { id: 'x', content: 'c' }, previousState: { id: 'x', security_scopes: ['finance'] } }]),
            });
            assert.deepEqual(r, { scopes: ['finance'] });
        });
        await test('key absent in both states and no later source -> unknown (hidden from bound), not public', async () => {
            const r = await resolveItemScopes({ nodeId: 'x' }, {
                workspace: WS, getGraphNode: none_,
                versionStore: vs([{ newState: { id: 'x' }, previousState: { id: 'x' } }]),
            });
            assert.deepEqual(r, { unknown: true });
        });
        await test('absent key falls through to the verbatim row source', async () => {
            const r = await resolveItemScopes({ nodeId: 'x', verbatimId: 'lore:x' }, {
                workspace: WS, getGraphNode: none_,
                versionStore: vs([{ newState: { id: 'x' }, previousState: null }]),
                getVerbatimRow: async (id) => (id === 'lore:x' ? { security_scopes: ['hr'] } : null),
            });
            assert.deepEqual(r, { scopes: ['hr'] });
        });
        await test('present-but-empty array is still public', async () => {
            const r = await resolveItemScopes({ nodeId: 'x' }, {
                workspace: WS, getGraphNode: none_,
                versionStore: vs([{ newState: { id: 'x', security_scopes: [] }, previousState: { id: 'x', security_scopes: ['finance'] } }]),
            });
            assert.deepEqual(r, { scopes: [] });
        });
        await test('deleted node: newest row (delete, newState null) uses previousState; newState lacking the key does not mask it', async () => {
            const store = VersionStore.open(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-drsr-ver-')));
            await store.recordVersion({ versionId: 'a', nodeId: 'dk', workspace: WS, timestamp: '2026-10-01T00:00:00.000Z', principal: 'mcp', operation: 'upsert', previousState: null, newState: { id: 'dk', security_scopes: ['finance'] }, changesetId: null });
            await store.recordVersion({ versionId: 'b', nodeId: 'dk', workspace: WS, timestamp: '2026-10-02T00:00:00.000Z', principal: 'mcp', operation: 'upsert', previousState: { id: 'dk', security_scopes: ['finance'] }, newState: { id: 'dk', content: 'no key' }, changesetId: null });
            const deps = { store: { loreGraph: makeGraph([]) } as never, versionStore: store, deploymentMode: 'local', dataplane: null } as never;
            const hist = async (a: Actor) => (await rest(a, `/api/nodes/dk/history?workspace=${WS}`, tryVersioningRoutes as never, deps)).json.count as number;
            assert.equal(await hist(sales), 0, 'hidden, not public');
            assert.equal(await hist(finance), 2);
            assert.equal(await hist('unbound'), 2);
        });
    }

    /* ── 3. version-gate id collision ──────────────────────────────────── */
    console.log('3. version gate — exact node id');
    {
        const store = VersionStore.open(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-drsr-ver2-')));
        const REV = 'S#rev2026-01-01T00:00:00.000Z';
        let t = 0;
        const rec = async (id: string, scopes: string[]): Promise<void> => {
            const state = { id, type: 'note', label: id, security_scopes: scopes, content: `body of ${id}` };
            t++;
            await store.recordVersion({ versionId: `v-${t}`, nodeId: id, workspace: WS, timestamp: `2026-10-0${t}T00:00:00.000Z`, principal: 'mcp', operation: 'upsert', previousState: null, newState: state, changesetId: null });
        };
        // Case A: public node S; finance-scoped nodes with literal ids `lore:S` and `S#rev…` (version rows only).
        // Case B: public node `lore:T`; finance node T.
        const graph = makeGraph([node('S', []), node('T', ['finance']), node('lore:T', [])]);
        await rec('S', []); await rec('lore:S', ['finance']); await rec(REV, ['finance']);
        await rec('T', ['finance']); await rec('lore:T', []);
        const deps = { store: { loreGraph: graph }, versionStore: store, deploymentMode: 'local', dataplane: null } as never;
        const tools = mcpTools((server) => registerVersioningTools(server, { versionStore: store, store: { loreGraph: graph } as never, detectedScope: { workspace: WS, ecosystem: '*' } } as never));
        const histRest = (a: Actor, id: string) => rest(a, `/api/nodes/${id}/history?workspace=${WS}`, tryVersioningRoutes as never, deps);
        const histMcp = (a: Actor, id: string) => call(a, tools.get('node_history')!, { node_id: id, workspace: WS });
        const diffRest = (a: Actor) => rest(a, `/api/workspaces/${WS}/diff?since=2000-01-01T00:00:00.000Z`, tryVersioningRoutes as never, deps);
        const diffMcp = (a: Actor) => call(a, tools.get('diff_workspace')!, { workspace: WS, since: '2000-01-01T00:00:00.000Z' });
        const diffIds = (o: Out): string[] => [...new Set((o.json.changes as Array<{ nodeId: string }>).map((c) => c.nodeId))].sort();

        await test('literal ids `lore:S` / `S#rev…` (finance) do not leak to a sales actor through node history (REST + MCP)', async () => {
            // REST path ids are used raw (a literal '#' cannot ride in a URL path), so
            // the `S#rev…` id is exercised through MCP and the workspace diff only.
            for (const id of ['lore:S', REV]) {
                if (id === 'lore:S') {
                    const r = await histRest(sales, id);
                    assert.equal(r.json.count, 0, `REST ${id}`);
                    assert.ok(!r.body.includes(`body of ${id}`));
                    assert.equal((await histRest(finance, id)).json.count, 1, `finance sees ${id}`);
                    assert.equal((await histRest('unbound', id)).json.count, 1);
                }
                const m = await histMcp(sales, id);
                assert.equal(m.json.count, 0, `MCP ${id}`);
                assert.ok(!m.body.includes('finance'));
                assert.equal((await histMcp(finance, id)).json.count, 1);
            }
            assert.equal((await histRest(sales, 'S')).json.count, 1, 'public S still visible');
        });
        await test('literal finance ids do not leak through workspace diff (REST + MCP)', async () => {
            for (const o of [await diffRest(sales), await diffMcp(sales)]) {
                assert.ok(diffIds(o).includes('S') && !diffIds(o).includes('lore:S') && !diffIds(o).includes(REV), `sales diff: ${diffIds(o)}`);
                assert.ok(!o.body.includes('body of lore:S') && !o.body.includes(`body of ${REV}`));
            }
            assert.deepEqual(diffIds(await diffRest(finance)), [REV, 'S', 'T', 'lore:S', 'lore:T'].sort());
            assert.deepEqual(diffIds(await diffRest('unbound')), [REV, 'S', 'T', 'lore:S', 'lore:T'].sort());
        });
        await test('public node `lore:T` is not hidden because node `T` is scoped (history + diff)', async () => {
            assert.equal((await histRest(sales, 'lore:T')).json.count, 1);
            assert.equal((await histMcp(sales, 'lore:T')).json.count, 1);
            assert.equal((await histRest(sales, 'T')).json.count, 0, 'scoped T stays hidden');
            assert.ok(diffIds(await diffRest(sales)).includes('lore:T'));
            assert.ok(!diffIds(await diffRest(sales)).includes('T'));
            assert.ok(diffIds(await diffMcp(sales)).includes('lore:T'));
        });
    }

    /* ── 6. supersession candidates ────────────────────────────────────── */
    console.log('6. supersession-candidates cache key + string-form scopes');
    {
        const run = (d: ReturnType<typeof httpDeps>, a: Actor, qs: string) =>
            rest(a, `/api/node/supersession-candidates?workspace=${WS}&types=decision&minScore=0.5${qs}`, tryNodesRoutes as never, d);
        const touches = (o: Out): boolean => o.body.includes('d-sec');

        await test('actor scopes [a,b] and the single scope "a,b" do not share a cache entry', async () => {
            const rows = [node('d-pub-1', []), node('d-pub-2', [], { createdAt: '2026-01-05T00:00:00Z' }), node('d-sec', ['a'], { createdAt: '2026-01-06T00:00:00Z' })];
            const d = httpDeps(makeGraph(rows));
            const two = await run(d, ['a', 'b'], '&project=*');
            assert.ok(touches(two), 'baseline: actor holding scope a sees d-sec');
            const comma = await run(d, ['a,b'], '&project=*');
            assert.equal(comma.json.cached, undefined, 'must not replay the [a,b] actor\'s cache entry');
            assert.ok(!touches(comma), `actor holding only "a,b" must not see d-sec: ${comma.body}`);
        });
        await test('string-form security_scopes on projected rows fail closed (not treated as public)', async () => {
            const rows = [node('d-pub-1', []), node('d-pub-2', [], { createdAt: '2026-01-05T00:00:00Z' }), node('d-sec', 'finance', { createdAt: '2026-01-06T00:00:00Z' })];
            const d = httpDeps(makeGraph(rows));
            const forSales = await run(d, sales, '&fresh=true');
            assert.equal(forSales.status, 200);
            assert.ok(!touches(forSales), `string-scoped candidate leaked to sales: ${forSales.body}`);
            assert.equal(forSales.json.candidatesScanned, 3 - 1, 'hidden candidate not counted');
            assert.ok(touches(await run(d, finance, '&fresh=true')), 'actor holding the scope still sees it');
            assert.ok(touches(await run(d, 'unbound', '&fresh=true')), 'unbound unchanged');
        });
    }

    /* ── 7. outcomes reads ─────────────────────────────────────────────── */
    console.log('7. outcomes reads (MCP + REST)');
    {
        const outcomeRows: Record<string, Array<Record<string, unknown>>> = {
            pub: [{ id: 'o1', nodeId: 'pub', workspace: WS, status: 'success', notes: 'pub note', recordedBy: 'a', recordedAt: '2026-10-01' }],
            sec: [
                { id: 'o2', nodeId: 'sec', workspace: WS, status: 'failure', notes: 'SECRET NOTE', recordedBy: 'b', recordedAt: '2026-10-01' },
                { id: 'o3', nodeId: 'sec', workspace: WS, status: 'success', notes: 'SECRET NOTE 2', recordedBy: 'b', recordedAt: '2026-10-02' },
            ],
        };
        const auxStore = {
            getOutcomes: (nodeId: string) => outcomeRows[nodeId] ?? [],
            getOutcomeCount: (nodeId: string) => {
                const r = outcomeRows[nodeId] ?? [];
                const c = (s: string) => r.filter((x) => x['status'] === s).length;
                return { success: c('success'), failure: c('failure'), partial: c('partial') };
            },
        };
        const graph = makeGraph([node('pub', []), node('sec', ['finance'])]);
        const d = httpDeps(graph, { auxStore });
        const getRest = (a: Actor, id: string) => rest(a, `/api/nodes/${id}/outcomes?workspace=${WS}`, tryOutcomesRoutes as never, d);
        const tools = mcpTools((server) => registerOutcomeTools(server, { store: d.store as never, auxStore: auxStore as never, graphRegistry: d.graphRegistry as never, detectedScope: { workspace: WS, ecosystem: '*' } } as never));
        const getMcp = (a: Actor, id: string) => call(a, tools.get('get_node_outcomes')!, { node_id: id, workspace: WS });

        await test('REST: hidden node == missing node (modulo id); allowed/unbound/public unchanged', async () => {
            const hidden = await getRest(sales, 'sec');
            const missing = await getRest(sales, 'nope');
            assert.equal(hidden.status, missing.status);
            assert.equal(hidden.body.split('sec').join('nope'), missing.body);
            assert.ok(!hidden.body.includes('SECRET'));
            assert.equal((await getRest(finance, 'sec')).json.total_count, 2);
            assert.equal((await getRest('unbound', 'sec')).json.total_count, 2);
            assert.equal((await getRest(none, 'pub')).json.total_count, 1);
        });
        await test('MCP: hidden node == missing node (modulo id); allowed/unbound/public unchanged', async () => {
            const hidden = await getMcp(sales, 'sec');
            const missing = await getMcp(sales, 'nope');
            assert.equal(hidden.status, missing.status);
            assert.equal(hidden.body.split('sec').join('nope'), missing.body);
            assert.ok(!hidden.body.includes('SECRET'));
            assert.equal((await getMcp(finance, 'sec')).json.total_count, 2);
            assert.equal((await getMcp('unbound', 'sec')).json.total_count, 2);
            assert.equal((await getMcp(none, 'pub')).json.total_count, 1);
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
