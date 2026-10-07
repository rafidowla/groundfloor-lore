#!/usr/bin/env tsx
/**
 * test/scopes-page-fill-unit.ts — pagination must not be an existence oracle
 * for row-level security_scopes (the "fill pages" decision, Rafi).
 *
 * Contract: a BOUND actor that lacks an item's scopes gets exactly what it
 * would get if the item did not exist — page sizes, hasMore, and cursors
 * included. Proven by the strongest possible check: paginate the full world
 * (hidden rows present) and a REFERENCE world (hidden rows physically absent)
 * as the same bound actor and require the two transcripts to be IDENTICAL
 * page by page. Unbound actors are unchanged (raw page, raw cursor).
 *
 * Surfaces: MCP list_nodes, GET /api/node-list, POST /api/nodes/bulk-list,
 * GET /api/nodes (top-N, no cursor), GET /api/edges (offset), plus the helper
 * (scan cap, sealed continuation).
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { tryInspectRoutes } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import {
    fillVisibleKeysetPage, sealContinuation, openContinuation, SCOPE_PAGE_FILL_MAX_SCAN,
} from '../packages/lore/src/security/scopePageFill.js';

/* ── harness ─────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

type Who = 'unbound' | 'none' | 'sales' | 'finance';
function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    if (who === 'unbound') return fn();
    const scopes = who === 'none' ? [] : [who];
    return runWithActor({ portalUserId: `u-${who}`, scopes }, fn);
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function getReq(url: string): IncomingMessage {
    return { method: 'GET', url, on: () => { /* no-op */ } } as unknown as IncomingMessage;
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

/* ── fake graph: engine-faithful bulkList (updatedAt DESC, id ASC, keyset) ── */

type N = Record<string, unknown> & { id: string; updatedAt: string };
const pad = (n: number, w = 3): string => String(n).padStart(w, '0');
function node(i: number, scopes: string[], tieGroup = 4): N {
    const id = `n${pad(i, 5)}`;
    return {
        id, type: 'decision', label: `Label ${id}`, content: `content of ${id}`, project: 'ws', ecosystem: '*',
        tags: [], security_scopes: scopes, metadata: '{}', createdAt: '2026-01-01T00:00:00Z',
        // Ties: `tieGroup` consecutive rows share an updatedAt (id breaks the tie); higher i = older.
        updatedAt: new Date(Date.UTC(2026, 1, 1) - Math.floor(i / tieGroup) * 1000).toISOString(),
        supersededAt: null, supersededBy: null,
    };
}
const order = (a: N, b: N): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Edge { sourceId: string; targetId: string; relation: string }

function makeGraph(nodesIn: N[], edges: Edge[] = []) {
    const nodes = [...nodesIn].sort(order);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const g = {
        bulkCalls: 0, queryCalls: 0,
        initialize: async () => undefined,
        getNode: async (id: string) => byId.get(id) ?? null,
        getNodesByIds: async (ids: string[]) => {
            const m = new Map<string, N>();
            for (const id of ids) if (byId.has(id)) m.set(id, byId.get(id)!);
            return m;
        },
        listNodes: async (_t?: string, _tag?: string, _p?: string, _e?: string, limit?: number) =>
            (limit === undefined ? nodes : nodes.slice(0, limit)),
        bulkList: async (q: { limit: number; cursor?: { updatedAt: string; id: string } | null }) => {
            g.bulkCalls++;
            let rows = nodes;
            if (q.cursor) {
                const c = q.cursor;
                rows = nodes.filter((n) => n.updatedAt < c.updatedAt || (n.updatedAt === c.updatedAt && n.id > c.id));
            }
            const page = rows.slice(0, q.limit);
            const hasMore = rows.length > q.limit;
            const last = page[page.length - 1];
            return { nodes: page, hasMore, nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null };
        },
        queryEdges: async (q: { source?: string; target?: string; relation?: string; limit: number; offset: number }) => {
            g.queryCalls++;
            return edges.filter((e) => (!q.source || e.sourceId === q.source) && (!q.target || e.targetId === q.target)
                && (!q.relation || e.relation === q.relation)).slice(q.offset, q.offset + q.limit);
        },
    };
    return g;
}
type FakeGraph = ReturnType<typeof makeGraph>;

function httpDeps(graph: FakeGraph) {
    const registry = { getOrOpen: async () => graph, getGraphHandle: async () => graph, activeName: () => 'ws' };
    const store = { loreGraph: graph, storageClient: graph, loreVerbatim: { count: async () => 0, search: async () => [] } };
    return { deploymentMode: 'local' as const, dataplane: null, store, graphRegistry: registry, auditLog: {},
        detectedScope: { workspace: 'ws', ecosystem: '*' } };
}

interface Tool { schema: Record<string, z.ZodTypeAny>; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
function listNodesTool(graph: FakeGraph): Tool {
    const tools = new Map<string, Tool>();
    registerDiagnosticTools({ tool: (name: string, _d: string, schema: Tool['schema'], handler: Tool['handler']) => { tools.set(name, { schema, handler }); } } as never, {
        store: { loreGraph: graph, loreVerbatim: {} } as never,
        pluginRegistry: { collectPluginStats: async () => ({}) } as never,
        detectedScope: { workspace: 'ws', ecosystem: '*' },
        deploymentMode: 'local',
        graphBasePath: '/tmp/lore-scopes-page-fill-fixture',
        nodeTypesEnum: z.enum(['decision', 'note'] as [string, ...string[]]),
    } as never);
    return tools.get('list_nodes')!;
}

/* ── one-page callers, normalised to a comparable shape ──────────────── */

interface PageView { ids: string[]; count: number; hasMore: boolean; nextCursor: string | null; raw: string; isError?: boolean; err?: string }

type Surface = 'mcp' | 'node-list' | 'bulk-list';
async function page(surface: Surface, graph: FakeGraph, who: Who, limit: number, cursor: string | null): Promise<PageView> {
    return as(who, async () => {
        if (surface === 'mcp') {
            const tool = listNodesTool(graph);
            const args: Record<string, unknown> = { workspace: 'ws', limit };
            if (cursor) args.cursor = cursor;
            const r = await tool.handler(z.object(tool.schema).parse(args) as Record<string, unknown>);
            const text = r.content[0]!.text;
            const j = JSON.parse(text) as Record<string, any>;
            if (r.isError) return { ids: [], count: 0, hasMore: false, nextCursor: null, raw: text, isError: true, err: String(j.error) };
            return { ids: (j.nodes as Array<{ id: string }>).map((n) => n.id), count: j.count, hasMore: j.hasMore, nextCursor: j.nextCursor ?? null, raw: text };
        }
        const res = fakeRes();
        if (surface === 'node-list') {
            const url = `/api/node-list?workspace=ws&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
            await tryInspectRoutes(getReq(url), res, url, '/api/node-list', httpDeps(graph) as never);
        } else {
            await tryBulkListRoutes(postReq('/api/nodes/bulk-list', { workspace: 'ws', limit, ...(cursor ? { cursor } : {}) }), res,
                '/api/nodes/bulk-list', '/api/nodes/bulk-list', httpDeps(graph) as never);
        }
        const j = JSON.parse(res._body) as Record<string, any>;
        if (res._status !== 200) return { ids: [], count: 0, hasMore: false, nextCursor: null, raw: res._body, isError: true, err: String(j.code ?? j.error) };
        return { ids: (j.nodes as Array<{ id: string }>).map((n) => n.id), count: j.count, hasMore: j.hasMore, nextCursor: j.nextCursor ?? null, raw: res._body };
    });
}

async function walk(surface: Surface, graph: FakeGraph, who: Who, limit: number): Promise<PageView[]> {
    const pages: PageView[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 500; guard++) {
        const p = await page(surface, graph, who, limit, cursor);
        assert.ok(!p.isError, `page failed: ${p.raw}`);
        pages.push(p);
        if (!p.hasMore) return pages;
        assert.ok(p.nextCursor, 'hasMore:true must carry a cursor');
        cursor = p.nextCursor;
    }
    throw new Error('pagination did not terminate');
}
const decodeCursor = (c: string): Record<string, unknown> => JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;

/* ── dataset: hidden rows scattered, a 150-row hidden block, ties ────── */

const N_ROWS = 330;
function scopesFor(i: number): string[] {
    if (i >= 20 && i < 170) return ['finance'];           // 150 hidden in a row: spans >1 engine batch
    if (i % 7 === 1 || i % 7 === 2) return ['finance'];   // scattered hidden
    if (i % 11 === 0) return ['sales'];                   // visible only with the sales scope
    return [];                                            // public
}
const allRows = Array.from({ length: N_ROWS }, (_, i) => node(i, scopesFor(i)));
const hiddenFromSales = (n: N): boolean => (n.security_scopes as string[]).includes('finance');
const worldFull = (): FakeGraph => makeGraph(allRows);
const worldRef = (): FakeGraph => makeGraph(allRows.filter((n) => !hiddenFromSales(n)));
const visibleIds = allRows.filter((n) => !hiddenFromSales(n)).sort(order).map((n) => n.id);
const hiddenIds = allRows.filter(hiddenFromSales).map((n) => n.id);

(async () => {
    for (const surface of ['mcp', 'node-list', 'bulk-list'] as const) {
        for (const limit of [1, 7, 25, 100]) {
            console.log(`${surface} limit=${limit}`);
            await test('bound actor: transcript is IDENTICAL to a world where the hidden rows do not exist', async () => {
                const full = await walk(surface, worldFull(), 'sales', limit);
                const ref = await walk(surface, worldRef(), 'sales', limit);
                assert.deepEqual(
                    full.map((p) => [p.ids, p.count, p.hasMore, p.nextCursor]),
                    ref.map((p) => [p.ids, p.count, p.hasMore, p.nextCursor]),
                );
                // Belt and braces: no hidden id leaks in any body or decoded cursor.
                for (const p of full) {
                    const blob = p.raw + (p.nextCursor ? Buffer.from(p.nextCursor, 'base64url').toString('utf8') : '');
                    for (const h of hiddenIds) assert.ok(!blob.includes(h), `hidden id ${h} leaked`);
                }
            });
            await test('no skipped or duplicated visible rows; every non-final page is full', async () => {
                const pages = await walk(surface, worldFull(), 'sales', limit);
                const got = pages.flatMap((p) => p.ids);
                assert.equal(new Set(got).size, got.length, 'duplicates across pages');
                assert.deepEqual(got, visibleIds);
                for (const p of pages.slice(0, -1)) assert.equal(p.count, limit);
                assert.equal(pages[pages.length - 1]!.hasMore, false);
                assert.equal(pages[pages.length - 1]!.nextCursor, null);
            });
        }
    }

    console.log('allowed actors and unbound actors');
    for (const surface of ['mcp', 'node-list', 'bulk-list'] as const) {
        await test(`${surface}: actor holding finance sees finance rows, still dup/skip-free`, async () => {
            const pages = await walk(surface, worldFull(), 'finance', 20);
            const got = pages.flatMap((p) => p.ids);
            const expect = allRows.filter((n) => !(n.security_scopes as string[]).includes('sales')).sort(order).map((n) => n.id);
            assert.deepEqual(got, expect);
            assert.equal(new Set(got).size, got.length);
        });
        await test(`${surface}: zero-scope bound actor sees only public rows`, async () => {
            const pages = await walk(surface, worldFull(), 'none', 16);
            const expect = allRows.filter((n) => (n.security_scopes as string[]).length === 0).sort(order).map((n) => n.id);
            assert.deepEqual(pages.flatMap((p) => p.ids), expect);
        });
        await test(`${surface}: UNBOUND actor unchanged — raw pages, cursor from the last raw row`, async () => {
            const g = worldFull();
            const first = await page(surface, g, 'unbound', 10, null);
            assert.equal(first.count, 10);
            assert.equal(first.hasMore, true);
            const sorted = [...allRows].sort(order);
            assert.deepEqual(first.ids, sorted.slice(0, 10).map((n) => n.id));
            assert.deepEqual(decodeCursor(first.nextCursor!), { updatedAt: sorted[9]!.updatedAt, id: sorted[9]!.id });
            assert.equal(g.bulkCalls, 1, 'unbound must be a single engine call');
            const all = (await walk(surface, worldFull(), 'unbound', 10)).flatMap((p) => p.ids);
            assert.deepEqual(all, sorted.map((n) => n.id));
        });
    }

    console.log('cursor shape');
    await test('bound cursor is the LAST VISIBLE row returned (updatedAt + id), never a hidden row', async () => {
        const p = await page('mcp', worldFull(), 'sales', 5, null);
        const last = allRows.find((n) => n.id === p.ids[4])!;
        assert.deepEqual(decodeCursor(p.nextCursor!), { updatedAt: last.updatedAt, id: last.id });
    });
    await test('look-ahead: a page that exactly drains the visible rows reports hasMore:false and no cursor', async () => {
        const p = await page('mcp', worldFull(), 'sales', visibleIds.length, null);
        assert.equal(p.count, visibleIds.length);
        assert.equal(p.hasMore, false);
        assert.equal(p.nextCursor, null);
        // …even when hidden rows trail the last visible one.
        const tailHidden = makeGraph([...allRows.filter((n) => !hiddenFromSales(n)), node(900, ['finance']), node(901, ['finance'])]);
        const q = await page('mcp', tailHidden, 'sales', visibleIds.length, null);
        assert.equal(q.hasMore, false);
        assert.equal(q.nextCursor, null);
    });
    await test('actor who can see nothing: empty page, hasMore:false, no cursor (== empty world)', async () => {
        const g = makeGraph(Array.from({ length: 250 }, (_, i) => node(i, ['finance'])));
        const a = await page('node-list', g, 'sales', 10, null);
        const b = await page('node-list', makeGraph([]), 'sales', 10, null);
        assert.deepEqual([a.ids, a.count, a.hasMore, a.nextCursor], [b.ids, b.count, b.hasMore, b.nextCursor]);
    });

    console.log('scan cap + sealed continuation');
    {
        const CAP = SCOPE_PAGE_FILL_MAX_SCAN;
        const big = [...Array.from({ length: CAP + 500 }, (_, i) => node(i, ['finance'])),
            ...Array.from({ length: 100 }, (_, i) => node(CAP + 500 + i, []))];
        const bigHidden = new Set(big.slice(0, CAP + 500).map((n) => n.id));
        await test('MCP: cap hit with nothing visible → hasMore:true + sealed cursor naming no row; resuming makes progress', async () => {
            const g = makeGraph(big);
            const p1 = await page('mcp', g, 'sales', 50, null);
            assert.equal(p1.count, 0);
            assert.equal(p1.hasMore, true);
            assert.ok(p1.nextCursor);
            const decoded = decodeCursor(p1.nextCursor!);
            assert.deepEqual(Object.keys(decoded), ['sealed']);
            for (const h of bigHidden) { if (p1.raw.includes(h) || JSON.stringify(decoded).includes(h)) assert.fail(`hidden id ${h} leaked`); }
            assert.ok(g.bulkCalls <= CAP / 100 + 1, `bounded work, got ${g.bulkCalls} engine calls`);
            const p2 = await page('mcp', g, 'sales', 50, p1.nextCursor);
            assert.equal(p2.count, 50);
            assert.equal(p2.hasMore, true);
            assert.deepEqual(Object.keys(decodeCursor(p2.nextCursor!)).sort(), ['id', 'updatedAt']);
            const p3 = await page('mcp', g, 'sales', 50, p2.nextCursor);
            assert.equal(p3.count, 50);
            assert.equal(p3.hasMore, false);
            assert.equal(p3.nextCursor, null);
            assert.equal(new Set([...p2.ids, ...p3.ids]).size, 100);
        });
        await test('REST node-list + bulk-list: same cap behaviour', async () => {
            for (const surface of ['node-list', 'bulk-list'] as const) {
                const g = makeGraph(big);
                const p1 = await page(surface, g, 'sales', 50, null);
                assert.deepEqual([p1.count, p1.hasMore], [0, true]);
                assert.deepEqual(Object.keys(decodeCursor(p1.nextCursor!)), ['sealed']);
                const rest = await walk(surface, g, 'sales', 50);
                void rest;
                const p2 = await page(surface, g, 'sales', 50, p1.nextCursor);
                assert.equal(p2.count, 50);
            }
        });
        await test('forged / foreign sealed cursor is rejected as invalid_cursor', async () => {
            const forged = Buffer.from(JSON.stringify({ sealed: 'AAAA' }), 'utf8').toString('base64url');
            const p = await page('mcp', makeGraph(big), 'sales', 10, forged);
            assert.equal(p.isError, true);
            assert.equal(p.err, 'invalid_cursor');
            const q = await page('node-list', makeGraph(big), 'sales', 10, forged);
            assert.equal(q.err, 'invalid_cursor');
            // A real token with one byte flipped fails authentication.
            const tok = sealContinuation({ updatedAt: 'x', id: 'y' });
            const flipped = Buffer.from(tok, 'base64url'); flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
            assert.equal(openContinuation(flipped.toString('base64url')), undefined);
            assert.deepEqual(openContinuation(tok), { updatedAt: 'x', id: 'y' });
        });
        await test('helper: tiny cap/batch — page fills across batches; capped result is consistent', async () => {
            const rows = Array.from({ length: 40 }, (_, i) => node(i, i % 5 === 0 ? [] : ['finance']));
            const g = makeGraph(rows);
            const run = (maxScan: number) => as('sales', () => fillVisibleKeysetPage({
                limit: 3, cursor: null, maxScan, batchSize: 4,
                fetch: (c, n) => g.bulkList({ limit: n, cursor: c }),
            }));
            const full = await run(1000);
            assert.deepEqual(full.nodes.map((n) => n.id), ['n00000', 'n00005', 'n00010']);
            assert.equal(full.hasMore, true);
            assert.deepEqual(full.nextCursor, { updatedAt: full.nodes[2]!.updatedAt, id: 'n00010' });
            const capped = await run(8);
            assert.equal(capped.capped, true);
            assert.equal(capped.hasMore, true);
            assert.deepEqual(capped.nodes.map((n) => n.id), ['n00000', 'n00005']);
            assert.deepEqual(Object.keys(capped.nextCursor as object), ['sealed']);
        });
    }

    console.log('GET /api/nodes (top-N, no cursor)');
    {
        const run = async (graph: FakeGraph, who: Who, limit: number) => as(who, async () => {
            const res = fakeRes();
            const url = `/api/nodes?type=decision&workspace=ws&limit=${limit}`;
            const handled = await trySearchRoutes(getReq(url), res, url, '/api/nodes', httpDeps(graph) as never);
            assert.ok(handled);
            assert.equal(res._status, 200, res._body);
            return JSON.parse(res._body) as { count: number; hasMore: boolean; nodes: Array<{ id: string }> };
        });
        for (const limit of [1, 5, 40, 500]) {
            await test(`limit=${limit}: bound response == the world without hidden rows (count, hasMore, rows)`, async () => {
                const full = await run(worldFull(), 'sales', limit);
                const ref = await run(worldRef(), 'sales', limit);
                assert.deepEqual(full, ref);
                assert.equal(full.count, Math.min(limit, visibleIds.length));
            });
        }
        await test('unbound actor unchanged (raw limit+1 detection)', async () => {
            const r = await run(worldFull(), 'unbound', 10);
            assert.equal(r.count, 10);
            assert.equal(r.hasMore, true);
        });
    }

    console.log('GET /api/edges');
    {
        // 20 public sources; targets: public except a 130-edge block + scattered hidden ones.
        const pubNodes = Array.from({ length: 40 }, (_, i) => node(i, []));
        const hidNodes = Array.from({ length: 40 }, (_, i) => node(1000 + i, ['finance']));
        const edges: Edge[] = Array.from({ length: 400 }, (_, i) => {
            const hiddenEdge = (i >= 30 && i < 160) || i % 6 === 2;
            return { sourceId: pubNodes[i % 20]!.id, targetId: (hiddenEdge ? hidNodes : pubNodes)[20 + (i % 20)]!.id, relation: 'RELATES' };
        });
        const visibleEdgeCount = edges.filter((e) => !hidNodes.some((h) => h.id === e.targetId)).length;
        const full = (): FakeGraph => makeGraph([...pubNodes, ...hidNodes], edges);
        const ref = (): FakeGraph => makeGraph(pubNodes, edges);   // hidden nodes DELETED; raw edges remain
        const edgePage = (g: FakeGraph, who: Who, limit: number, offset: number, cursor?: string) => as(who, async () => {
            const res = fakeRes();
            const url = `/api/edges?workspace=ws&limit=${limit}&offset=${offset}${cursor ? `&cursor=${cursor}` : ''}`;
            await tryEdgesRoutes(getReq(url), res, url, '/api/edges', httpDeps(g) as never);
            return { status: res._status, body: res._body, json: JSON.parse(res._body) as Record<string, any> };
        });
        const walkEdges = async (g: FakeGraph, who: Who, limit: number) => {
            const pages: Array<Record<string, any>> = [];
            let offset = 0;
            for (let guard = 0; guard < 500; guard++) {
                const r = await edgePage(g, who, limit, offset);
                assert.equal(r.status, 200, r.body);
                pages.push(r.json);
                offset += r.json.count;
                if (!r.json.hasMore) return pages;
            }
            throw new Error('no termination');
        };
        for (const limit of [1, 9, 50, 120]) {
            await test(`limit=${limit}: bound transcript identical to the world without the hidden nodes; offset=visible count`, async () => {
                const a = await walkEdges(full(), 'sales', limit);
                const b = await walkEdges(ref(), 'sales', limit);
                assert.deepEqual(a, b);
                const all = a.flatMap((p) => p.edges as Edge[]);
                assert.equal(all.length, visibleEdgeCount);
                assert.equal(new Set(all.map((e) => `${e.sourceId}>${e.targetId}`)).size > 0, true);
                for (const p of a.slice(0, -1)) assert.equal(p.count, limit);
                assert.equal(a[a.length - 1]!.hasMore, false);
                for (const p of a) assert.ok(!('nextCursor' in p), 'no cursor unless the scan cap ended the request');
            });
        }
        await test('allowed actor sees every edge; page boundaries exact', async () => {
            const a = await walkEdges(full(), 'finance', 60);
            assert.equal(a.flatMap((p) => p.edges).length, edges.length);
        });
        await test('UNBOUND actor unchanged: raw page, hasMore keyed on raw page size, exact key set', async () => {
            const r = await edgePage(full(), 'unbound', 100, 0);
            assert.deepEqual(Object.keys(r.json), ['count', 'hasMore', 'workspace', 'ecosystem', 'edges']);
            assert.equal(r.json.count, 100);
            assert.equal(r.json.hasMore, true);
        });
        await test('edge scan cap: sealed cursor continues, offset skipping works across caps', async () => {
            const CAP = SCOPE_PAGE_FILL_MAX_SCAN;
            const hid = Array.from({ length: 5 }, (_, i) => node(2000 + i, ['finance']));
            const pubs = Array.from({ length: 30 }, (_, i) => node(i, []));
            const bigEdges: Edge[] = [
                ...Array.from({ length: CAP + 500 }, (_, i) => ({ sourceId: pubs[i % 30]!.id, targetId: hid[i % 5]!.id, relation: 'R' })),
                ...Array.from({ length: 20 }, (_, i) => ({ sourceId: pubs[i]!.id, targetId: pubs[i + 1]!.id, relation: 'R' })),
            ];
            const g = makeGraph([...pubs, ...hid], bigEdges);
            const r1 = await edgePage(g, 'sales', 10, 0);
            assert.deepEqual([r1.json.count, r1.json.hasMore], [0, true]);
            assert.ok(typeof r1.json.nextCursor === 'string');
            assert.ok(!r1.body.includes('n02000'), 'no hidden id in the response');
            const r2 = await edgePage(g, 'sales', 10, 0, r1.json.nextCursor);
            assert.equal(r2.json.count, 10);
            assert.equal(r2.json.hasMore, true);
            // offset=10 (visible space) needs a 10k+ skip before the visible block: capped → cursor → finish.
            const r3 = await edgePage(g, 'sales', 10, 10);
            assert.deepEqual([r3.json.count, r3.json.hasMore], [0, true]);
            const r4 = await edgePage(g, 'sales', 10, 0, r3.json.nextCursor);
            assert.equal(r4.json.count, 10);
            assert.equal(r4.json.hasMore, false);
            const bad = await edgePage(g, 'sales', 10, 0, 'not-a-real-token');
            assert.equal(bad.status, 400);
            assert.equal(bad.json.code, 'invalid_cursor');
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
