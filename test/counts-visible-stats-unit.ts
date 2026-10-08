#!/usr/bin/env tsx
/**
 * test/counts-visible-stats-unit.ts - visible-only totals on the six stats
 * surfaces (3.31 S2): GET /api/stats, MCP stats, GET /api/lore-status, MCP
 * lore_status, GET /api/topology (totalCoreNodes / truncated) and
 * GET /api/topology/overview.
 *
 * Real sqlite-backed graph in a temp dir. Items carry security_scopes ['x'],
 * ['y'] or none; the actor is bound to ['x']. Per surface: unbound (identical
 * to the raw response, no scan calls), operator (bound bootstrap principal:
 * raw totals, no new fields), app token (visible-only + countScope), and the
 * scan cap (countsLowerBound).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import {
    countVisibleEdges, countVisibleNodes, setVisibleScanCapForTests, type VisibleCountGraph,
} from '../packages/lore/src/security/visibleCounts.js';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { tryInspectRoutes } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { tryTopologyRoutes } from '../packages/lore/src/mcp/http/routes/topology.js';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).message}`); }
}

const WS = 'ws';
const APP: Principal = { kind: 'app', workspace: WS, scopes: ['read', 'write'], label: 'app-1' };
const BOOT: Principal = { kind: 'bootstrap', workspace: WS, scopes: ['read', 'write'], label: 'bootstrap' };
const asUnbound = <T>(fn: () => T): T => fn();
const asOperator = <T>(fn: () => T): T => runWithActor({ portalUserId: 'u', scopes: ['x'] }, () => runWithPrincipal(BOOT, fn));
const asApp = <T>(fn: () => T): T => runWithActor({ portalUserId: 'u', scopes: ['x'] }, () => runWithPrincipal(APP, fn));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-counts-stats-'));
const real = new SqliteGraph(dir, { workspaceId: 'cs', cacheDisabled: true });

/** Counts the scan verbs the visible-only path uses; the unbound path must make none. */
const scanCalls: string[] = [];
const SCAN_VERBS = new Set(['bulkList', 'bulkListProjected', 'queryEdges', 'getNodesByIds']);
let rawNodeCountOverride: number | undefined;
/** When set, getTopology answers this many extra raw nodes (a full raw page that confinement then trims). */
let topologyFillerNodes = 0;
const g = new Proxy(real, {
    get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
            if (typeof prop === 'string' && SCAN_VERBS.has(prop)) scanCalls.push(prop);
            if (prop === 'getTopology' && topologyFillerNodes > 0) {
                return (v as (...a: unknown[]) => Promise<{ nodes: Array<Record<string, unknown>> }>).apply(target, args)
                    .then((t) => ({ ...t, nodes: [...t.nodes, ...Array.from({ length: topologyFillerNodes }, (_, i) => ({ id: `gone-${i}`, label: `gone-${i}`, type: 'T' }))] }));
            }
            if (prop === 'getStats' && rawNodeCountOverride !== undefined) {
                return (v as (...a: unknown[]) => Promise<Record<string, unknown>>).apply(target, args)
                    .then((s) => ({ ...s, nodeCount: rawNodeCountOverride }));
            }
            return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
    },
}) as unknown as SqliteGraph;

async function seed(): Promise<void> {
    await real.initialize();
    const n = (id: string, type: string, scopes: string[], opts: { language?: string; project?: string } = {}) => real.upsertNode({
        id, type, label: id, content: id, tags: [], project: opts.project ?? WS, ecosystem: '*', metadata: '{}',
        ...(scopes.length ? { security_scopes: scopes } : {}),
        ...(opts.language ? { language: opts.language } : {}),
    });
    await n('t-x1', 'T', ['x'], { language: 'en' });
    await n('t-x2', 'T', ['x']);
    await n('t-y1', 'T', ['y'], { language: 'fr' });
    await n('t-p1', 'T', []);
    await n('u-x', 'U', ['x'], { language: 'en' });
    await n('u-y', 'U', ['y']);
    await n('o1', 'T', [], { project: 'other' });
    const e = (s: string, t: string, r: string) => real.addEdge({ sourceId: s, targetId: t, relation: r });
    await e('t-x1', 't-x2', 'R'); // both visible
    await e('t-x1', 't-y1', 'R'); // hidden target
    await e('t-p1', 'u-x', 'R');  // public + visible
    await e('u-y', 't-x2', 'R');  // hidden source
    await e('t-x2', 't-x1', 'S'); // both visible
    await e('o1', 't-x1', 'R');   // other project -> ws, both visible
    await e('o1', 't-y1', 'R');   // hidden target
}

/* ---- harness ---- */

interface Res { status: number; body: Record<string, unknown> }
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    return {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    } as unknown as ServerResponse & { _status: number; _body: string };
}
const fakeReq = (url: string): IncomingMessage =>
    ({ method: 'GET', url, on: () => { /* */ } } as unknown as IncomingMessage);

const registry = {
    getOrOpen: async () => g, getGraphHandle: async () => g, graphEngineFor: () => 'sqlite',
};
const VERBATIM = 7;
const store = {
    loreGraph: g,
    storageClient: { getStats: async () => g.getStats(), verbatimCount: async () => VERBATIM },
};

async function restStats(): Promise<Res> {
    const res = fakeRes();
    const url = `/api/stats?workspace=${WS}`;
    await tryDiagnosticRoutes(fakeReq(url), res, url, '/api/stats', {
        store, graphRegistry: registry, deploymentMode: 'local', getDataplaneState: () => 'offline',
        pluginRegistry: {}, configManager: {}, activeSessions: new Map(),
    } as never);
    return { status: res._status, body: JSON.parse(res._body) };
}

async function restStatus(): Promise<Res> {
    const res = fakeRes();
    const url = '/api/lore-status';
    const handled = await tryInspectRoutes(fakeReq(url), res, url, url, {
        store, detectedScope: { workspace: WS, ecosystem: '*' }, deploymentMode: 'local', dataplane: null, graphRegistry: registry,
    } as never);
    assert.ok(handled);
    return { status: res._status, body: JSON.parse(res._body) };
}

async function restTopology(pathname: string, query = ''): Promise<Res> {
    const res = fakeRes();
    const url = `${pathname}?workspace=${WS}${query}`;
    const handled = await tryTopologyRoutes(fakeReq(url), res, url, pathname, {
        store, deploymentMode: 'local', dataplane: null, graphRegistry: registry,
    } as never);
    assert.ok(handled);
    return { status: res._status, body: JSON.parse(res._body) };
}

type McpHandler = (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = new Map<string, McpHandler>();
registerDiagnosticTools({ tool(name: string, _d: string, _s: unknown, h: McpHandler) { tools.set(name, h); } } as unknown as McpServer, {
    store, detectedScope: { workspace: WS, ecosystem: '*' }, deploymentMode: 'local', graphRegistry: registry,
    graphBasePath: dir, nodeTypesEnum: { optional: () => ({ describe: () => ({}) }) }, dataplane: null,
} as never);
async function mcp(name: string, args: unknown): Promise<Record<string, unknown>> {
    const out = await tools.get(name)!(args);
    assert.ok(!out.isError, out.content[0]?.text);
    return JSON.parse(out.content[0]!.text);
}

const HIDDEN_FIELDS = ['verbatimDocuments_global', 'verbatimDocs'];
const LABELS = ['countScope', 'countsLowerBound'];
const noLabels = (o: Record<string, unknown>): void => {
    for (const k of LABELS) assert.ok(!(k in o), `unexpected ${k} in ${JSON.stringify(o)}`);
};

async function main(): Promise<void> {
    await seed();
    const rawProjStats = await real.getStats(WS);
    const rawStats = await real.getStats();

    /* ---------- 1. GET /api/stats ---------- */
    await test('REST stats: unbound = raw response, no scan calls, no labels', async () => {
        scanCalls.length = 0;
        const r = await asUnbound(restStats);
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, {
            workspace: WS, scope: 'workspace', ...rawProjStats,
            verbatimDocuments_global: VERBATIM, languageBreakdown: await real.getLanguageBreakdown(),
        });
        assert.equal(scanCalls.length, 0, `unbound must not scan: ${scanCalls}`);
    });
    await test('REST stats: operator = raw totals incl. hidden rows, no new fields', async () => {
        const r = await asOperator(restStats);
        assert.equal(r.body['nodeCount'], rawProjStats.nodeCount);
        assert.equal(r.body['verbatimDocuments_global'], VERBATIM);
        noLabels(r.body);
        assert.equal(r.body['nodeCount'], 6); // project 'ws' incl. the two 'y' rows
    });
    await test('REST stats: app token = visible-only totals/breakdowns, labelled, verbatim omitted', async () => {
        const r = await asApp(restStats);
        assert.equal(r.status, 200);
        assert.equal(r.body['nodeCount'], 4);   // t-x1 t-x2 t-p1 u-x (project ws)
        assert.equal(r.body['edgeCount'], 3);   // x1->x2, p1->u-x, x2->x1
        assert.deepEqual(r.body['typeBreakdown'], { T: 3, U: 1 });
        assert.deepEqual(r.body['languageBreakdown'], { en: 2, null: 2 });
        assert.equal(r.body['countScope'], 'visible');
        assert.ok(!('countsLowerBound' in r.body));
        for (const k of HIDDEN_FIELDS) assert.ok(!(k in r.body), `${k} must be omitted`);
        assert.ok(!JSON.stringify(r.body).includes('t-y1'));
    });
    await test('REST stats: scan cap -> countsLowerBound', async () => {
        setVisibleScanCapForTests(2);
        try {
            const r = await asApp(restStats);
            assert.equal(r.body['countScope'], 'visible');
            assert.equal(r.body['countsLowerBound'], true);
            assert.ok((r.body['nodeCount'] as number) <= 2);
        } finally { setVisibleScanCapForTests(undefined); }
    });

    /* ---------- 2. MCP stats ---------- */
    await test('MCP stats: unbound = raw, no scan calls', async () => {
        scanCalls.length = 0;
        const b = await asUnbound(() => mcp('stats', { workspace: WS }));
        assert.equal(b['nodeCount'], rawStats.nodeCount);
        assert.equal(b['verbatimDocuments_global'], VERBATIM);
        noLabels(b);
        assert.equal(scanCalls.length, 0);
    });
    await test('MCP stats: operator = raw, no new fields', async () => {
        const b = await asOperator(() => mcp('stats', { workspace: WS }));
        assert.equal(b['nodeCount'], 7);
        assert.equal(b['verbatimDocuments_global'], VERBATIM);
        noLabels(b);
    });
    await test('MCP stats: app token = visible-only (whole workspace), labelled', async () => {
        const b = await asApp(() => mcp('stats', { workspace: WS }));
        assert.equal(b['nodeCount'], 5);        // 4 + o1
        assert.equal(b['edgeCount'], 4);        // + o1->x1
        assert.deepEqual(b['typeBreakdown'], { T: 4, U: 1 });
        assert.deepEqual(b['languageBreakdown'], { en: 2, null: 3 });
        assert.equal(b['countScope'], 'visible');
        assert.ok(!('verbatimDocuments_global' in b));
    });
    await test('MCP stats: scan cap -> countsLowerBound', async () => {
        setVisibleScanCapForTests(2);
        try {
            const b = await asApp(() => mcp('stats', { workspace: WS }));
            assert.equal(b['countsLowerBound'], true);
        } finally { setVisibleScanCapForTests(undefined); }
    });

    /* ---------- 3. GET /api/lore-status ---------- */
    const graphOf = (b: Record<string, unknown>): Record<string, unknown> => b['graph'] as Record<string, unknown>;
    await test('REST lore-status: unbound = raw, no scan calls', async () => {
        scanCalls.length = 0;
        const r = await asUnbound(restStatus);
        assert.equal(graphOf(r.body)['nodes'], rawStats.nodeCount);
        assert.equal(graphOf(r.body)['edges'], rawStats.edgeCount);
        assert.equal(graphOf(r.body)['verbatimDocs'], VERBATIM);
        noLabels(r.body);
        assert.equal(scanCalls.length, 0);
    });
    await test('REST lore-status: operator = raw, no new fields', async () => {
        const r = await asOperator(restStatus);
        assert.equal(graphOf(r.body)['nodes'], 7);
        assert.equal(graphOf(r.body)['verbatimDocs'], VERBATIM);
        noLabels(r.body);
    });
    await test('REST lore-status: app token = visible-only, labelled, verbatimDocs omitted', async () => {
        const r = await asApp(restStatus);
        assert.equal(graphOf(r.body)['nodes'], 5);
        assert.equal(graphOf(r.body)['edges'], 4);
        assert.ok(!('verbatimDocs' in graphOf(r.body)));
        assert.equal(r.body['countScope'], 'visible');
        assert.ok('engine' in graphOf(r.body));
    });
    await test('REST lore-status: scan cap -> countsLowerBound', async () => {
        setVisibleScanCapForTests(2);
        try { assert.equal((await asApp(restStatus)).body['countsLowerBound'], true); }
        finally { setVisibleScanCapForTests(undefined); }
    });

    /* ---------- 4. MCP lore_status ---------- */
    await test('MCP lore_status: unbound = raw, no scan calls', async () => {
        scanCalls.length = 0;
        const b = await asUnbound(() => mcp('lore_status', {}));
        assert.equal(graphOf(b)['nodes'], rawStats.nodeCount);
        assert.equal(graphOf(b)['verbatimDocs'], VERBATIM);
        noLabels(b);
        assert.equal(scanCalls.length, 0);
    });
    await test('MCP lore_status: operator = raw, no new fields', async () => {
        const b = await asOperator(() => mcp('lore_status', {}));
        assert.equal(graphOf(b)['nodes'], 7);
        assert.equal(graphOf(b)['verbatimDocs'], VERBATIM);
        noLabels(b);
    });
    await test('MCP lore_status: app token = visible-only, labelled, verbatimDocs omitted', async () => {
        const b = await asApp(() => mcp('lore_status', {}));
        assert.equal(graphOf(b)['nodes'], 5);
        assert.equal(graphOf(b)['edges'], 4);
        assert.ok(!('verbatimDocs' in graphOf(b)));
        assert.equal(b['countScope'], 'visible');
    });
    await test('MCP lore_status: scan cap -> countsLowerBound', async () => {
        setVisibleScanCapForTests(2);
        try { assert.equal((await asApp(() => mcp('lore_status', {}))).countsLowerBound, true); }
        finally { setVisibleScanCapForTests(undefined); }
    });

    /* ---------- 5. GET /api/topology ---------- */
    const topo = () => restTopology('/api/topology');
    await test('REST topology: unbound = raw totalCoreNodes, no scan calls, no labels', async () => {
        scanCalls.length = 0;
        const r = await asUnbound(topo);
        assert.equal(r.body['totalCoreNodes'], 7);
        assert.equal(r.body['truncated'], false);
        noLabels(r.body);
        assert.equal(scanCalls.length, 0);
    });
    await test('REST topology: operator = raw totalCoreNodes, no new fields', async () => {
        const r = await asOperator(topo);
        assert.equal(r.body['totalCoreNodes'], 7);
        noLabels(r.body);
    });
    await test('REST topology: app token totalCoreNodes is visible-only + labelled; lists stay confined', async () => {
        const r = await asApp(topo);
        assert.equal(r.body['totalCoreNodes'], 5);
        assert.equal(r.body['countScope'], 'visible');
        const ids = (r.body['nodes'] as Array<{ id: string }>).map((n) => n.id).sort();
        assert.deepEqual(ids, ['o1', 't-p1', 't-x1', 't-x2', 'u-x']);
    });
    await test('REST topology: truncated is derived from the visible count, not the raw total', async () => {
        rawNodeCountOverride = 15000; // raw engine total pretends to exceed the render limit
        try {
            assert.equal((await asOperator(topo)).body['truncated'], true);
            const r = await asApp(topo);
            assert.equal(r.body['truncated'], false);
            assert.equal(r.body['totalCoreNodes'], 5);
        } finally { rawNodeCountOverride = undefined; }
    });
    await test('REST topology: truncated is true for an app token when the raw page filled (confinement trimmed it)', async () => {
        topologyFillerNodes = 1000; // raw page reaches the 1000 render minimum; hidden/missing rows are dropped after
        const topo1000 = () => restTopology('/api/topology', '&limit=1000');
        try {
            const r = await asApp(topo1000);
            assert.equal(r.body['truncated'], true, 'a cut raw page must not report truncated: false');
            assert.equal(r.body['totalCoreNodes'], 5);
            assert.equal((await asOperator(topo1000)).body['truncated'], false, 'operator unchanged');
            assert.equal((await asUnbound(topo1000)).body['truncated'], false, 'unbound unchanged');
        } finally { topologyFillerNodes = 0; }
    });
    await test('REST topology: scan cap -> countsLowerBound', async () => {
        setVisibleScanCapForTests(2);
        try {
            const r = await asApp(topo);
            assert.equal(r.body['countsLowerBound'], true);
            assert.ok((r.body['totalCoreNodes'] as number) <= 2);
        } finally { setVisibleScanCapForTests(undefined); }
    });

    /* ---------- 6. GET /api/topology/overview ---------- */
    const overview = (q = '') => restTopology('/api/topology/overview', q);
    const blob = (b: Record<string, unknown>, project: string): Record<string, unknown> =>
        (b['blobs'] as Array<Record<string, unknown>>).find((x) => x['project'] === project)!;
    await test('overview: unbound = engine aggregate, no scan calls, no labels', async () => {
        scanCalls.length = 0;
        const r = await asUnbound(() => overview());
        const raw = await real.getTopologyOverview();
        assert.deepEqual(r.body, { ...raw, groupBy: 'project', ecosystem: '*' });
        assert.equal(r.body['totalNodes'], 7);
        assert.equal(scanCalls.length, 0);
    });
    await test('overview: operator = engine aggregate, no new fields', async () => {
        const r = await asOperator(() => overview());
        assert.equal(r.body['totalNodes'], 7);
        noLabels(r.body);
    });
    await test('overview groupBy=project: app token folds only visible nodes / both-visible edges', async () => {
        const r = await asApp(() => overview());
        assert.equal(r.status, 200);
        assert.equal(r.body['totalNodes'], 5);
        assert.equal(blob(r.body, WS)['nodeCount'], 4);
        assert.equal(blob(r.body, 'other')['nodeCount'], 1);
        assert.deepEqual(blob(r.body, WS)['types'], [{ type: 'T', count: 3 }, { type: 'U', count: 1 }]);
        // o1->t-x1 counts; o1->t-y1 (hidden target) does not.
        assert.deepEqual(r.body['aggregateEdges'], [{ fromProject: 'other', toProject: WS, count: 1 }]);
        assert.equal(r.body['countScope'], 'visible');
        assert.ok(!('countsLowerBound' in r.body));
        // Raw would have said 2 for that bundle.
        const raw = await real.getTopologyOverview();
        assert.equal((raw.aggregateEdges.find((x) => x.fromProject === 'other')!).count, 2);
    });
    await test('overview groupBy=type: app token blobs / types / edges are visible-only', async () => {
        const r = await asApp(() => overview('&groupBy=type'));
        assert.equal(r.body['totalNodes'], 5);
        assert.equal(blob(r.body, 'T')['nodeCount'], 4);
        assert.equal(blob(r.body, 'U')['nodeCount'], 1);
        assert.deepEqual(r.body['aggregateEdges'], [{ fromProject: 'T', toProject: 'U', count: 1 }]);
        assert.equal(r.body['countScope'], 'visible');
    });
    await test('overview: scan cap -> countsLowerBound', async () => {
        setVisibleScanCapForTests(2);
        try {
            const r = await asApp(() => overview());
            assert.equal(r.body['countsLowerBound'], true);
            assert.ok((r.body['totalNodes'] as number) <= 2);
        } finally { setVisibleScanCapForTests(undefined); }
    });


    /* ---------- helper: byLanguage on bulkList-only engines (arcade / dataplane) ---------- */
    const listOnly = (rows: Array<Record<string, unknown>>): VisibleCountGraph => ({
        bulkList: async () => ({ nodes: rows, hasMore: false, nextCursor: null }),
    } as unknown as VisibleCountGraph);
    await test('helper: byLanguage reads language off bulkList rows (dataplane shape)', async () => {
        const gr = listOnly([
            { id: 'a', type: 'T', language: 'en', security_scopes: ['x'] },
            { id: 'b', type: 'T', language: 'fr', security_scopes: ['y'] },
            { id: 'c', type: 'T', language: 'en' },
        ]);
        const r = await asApp(() => countVisibleNodes(gr, { byLanguage: true, byType: true }));
        assert.equal(r.nodeCount, 2);
        assert.deepEqual(r.languageBreakdown, { en: 2 });
        assert.deepEqual(r.typeBreakdown, { T: 2 });
    });
    await test('helper: rows without a language property fall under "null" (arcade shape)', async () => {
        const gr = listOnly([{ id: 'a', type: 'T' }, { id: 'b', type: 'T', security_scopes: ['x'] }]);
        const r = await asApp(() => countVisibleNodes(gr, { byLanguage: true }));
        assert.deepEqual(r.languageBreakdown, { null: 2 });
    });
    await test('helper: edge endpoints are filtered by project when requested', async () => {
        const inWs = await asApp(() => countVisibleEdges(real, { project: WS }));
        const all = await asApp(() => countVisibleEdges(real));
        assert.equal(inWs.edgeCount, 3);
        assert.equal(all.edgeCount, 4);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
