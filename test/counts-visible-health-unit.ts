#!/usr/bin/env tsx
/**
 * test/counts-visible-health-unit.ts - visible-only counts on the health
 * surfaces for a BOUND non-operator (3.31 S3): corpus_health (MCP + REST),
 * GET /api/report (summary) and GET /api/diagnose/consistency.
 *
 * Real sqlite graph + real AuxStore in a temp LORE_HOME. Nodes carry
 * security_scopes ['x'], ['y'] or none; the app token is bound to ['x'].
 *
 *   visible to ['x']: vx1, vx2, pub          hidden: hy1, hy2
 *   edges (5): vx1>vx2, vx1>pub, pub>vx1 are visible-ish, see EDGES below
 *   outcomes: vx1 success x1;  hy1 success x2 + failure x1
 *
 * Per surface: (1) unbound = unchanged + no new lookups, (2) operator = true
 * totals and no new fields, (3) app token = visible-only + countScope,
 * (4) cap -> countsLowerBound / `<n>+`.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-counts-health-'));
process.env.LORE_HOME = TMP_HOME;
fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({
    active: 'ws', workspaces: [{ name: 'ws', path: path.join(TMP_HOME, 'ws'), createdAt: '2026-01-01T00:00:00Z', allowHardDelete: true }],
}));

const { SqliteGraph } = await import('../packages/lore/src/engines/sqliteGraph.js');
const { AuxStore } = await import('../packages/lore/src/outbox/auxStore.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { computeCorpusHealth } = await import('../packages/lore/src/mcp/corpusHealthCompute.js');
const { registerCorpusHealthTools } = await import('../packages/lore/src/mcp/tools/corpusHealth.js');
const { tryCorpusRoutes } = await import('../packages/lore/src/mcp/http/routes/corpus.js');
const { handleReport } = await import('../packages/lore/src/mcp/http/routes/diagnostic/storage.js');
const { handleConsistency } = await import('../packages/lore/src/mcp/http/routes/diagnostic/health.js');
const { writeGraphReport } = await import('../packages/lore/src/engines/graphReport.js');
const { diagnoseVisibleConsistency } = await import('../packages/lore/src/diagnostics/consistency.js');

type Principal = import('../packages/lore/src/auth/principal.js').Principal;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); }
}

const APP: Principal = { kind: 'app', workspace: 'ws', scopes: ['read', 'write'], label: 'app-1' };
const BOOT: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };
const X = { portalUserId: 'u', scopes: ['x'] };
type Who = 'unbound' | 'operator' | 'app';
function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    if (who === 'unbound') return fn();
    return runWithActor(X, () => runWithPrincipal(who === 'operator' ? BOOT : APP, fn));
}

/* ── seed ────────────────────────────────────────────────────────────── */
const graph = new SqliteGraph(path.join(TMP_HOME, 'ws'), { workspaceId: 'ws', cacheDisabled: true });
const aux = AuxStore.open(TMP_HOME);

async function seed(): Promise<void> {
    await graph.initialize();
    const n = (id: string, scopes: string[], extra: Record<string, unknown> = {}) => graph.upsertNode({
        id, type: 'T', label: id, content: id, tags: [], project: 'ws', ecosystem: '*', metadata: '{}',
        ...(scopes.length ? { security_scopes: scopes } : {}), ...extra,
    });
    await n('vx1', ['x'], { stale: true });
    await n('vx2', ['x']);
    await n('pub', []);
    await n('hy1', ['y'], { stale: true });
    await n('hy2', ['y']);
    const e = (s: string, t: string) => graph.addEdge({ sourceId: s, targetId: t, relation: 'R' });
    await e('vx1', 'vx2');  // visible
    await e('vx1', 'pub');  // visible
    await e('vx1', 'hy1');  // hidden endpoint
    await e('hy1', 'hy2');  // both hidden
    await e('pub', 'hy2');  // hidden endpoint
    const o = (id: string, nodeId: string, status: 'success' | 'failure') =>
        aux.recordOutcome({ id, nodeId, workspace: 'ws', status });
    o('o1', 'vx1', 'success');
    o('o2', 'hy1', 'success');
    o('o3', 'hy1', 'success');
    o('o4', 'hy1', 'failure');
    aux.incrementCounter('ws', 'recalls', 7);
}

/** Wrap an object so every method call is counted by name. */
function spy<T extends object>(target: T, calls: string[]): T {
    return new Proxy(target, {
        get(t, p, r) {
            const v = Reflect.get(t, p, r);
            if (typeof v !== 'function') return v;
            return (...args: unknown[]) => { calls.push(String(p)); return (v as (...a: unknown[]) => unknown).apply(t, args); };
        },
    });
}

/* ── harness (MCP + REST) ────────────────────────────────────────────── */
interface Tool { schema: z.ZodRawShape; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
function mcpTools(register: (server: never) => void): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    register({ tool: (name: string, _d: string, schema: Tool['schema'], handler: Tool['handler']) => { tools.set(name, { schema, handler }); } } as never);
    return tools;
}
async function callTool(tool: Tool, args: Record<string, unknown>): Promise<Record<string, any>> {
    const r = await tool.handler(z.object(tool.schema).parse(args) as Record<string, unknown>);
    return JSON.parse(r.content[0]!.text);
}
function fakeReq(method: string, url: string): IncomingMessage {
    return { method, url, on(event: string, cb: () => void) { if (event === 'end') setImmediate(cb); return this; } } as unknown as IncomingMessage;
}
function fakeRes() {
    return {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    } as unknown as ServerResponse & { _status: number; _body: string };
}

async function main(): Promise<void> {
    await seed();
    const mkStore = (g: object, vectorIds: string[] = []) => ({
        loreGraph: g, loreVerbatim: { listIds: async () => vectorIds }, storageClient: {},
    });

    /* ── corpus_health ───────────────────────────────────────────────── */
    const healthMcp = (who: Who, g: object = graph, a: object = aux) => {
        const tools = mcpTools((s) => registerCorpusHealthTools(s, { store: mkStore(g), auxStore: a, detectedScope: { workspace: 'ws', ecosystem: '*' } } as never));
        return as(who, () => callTool(tools.get('corpus_health')!, { workspace: 'ws' }));
    };
    const healthRest = async (who: Who) => {
        const res = fakeRes();
        const deps = { store: mkStore(graph), auxStore: aux, deploymentMode: 'local' as const, dataplane: null };
        await as(who, () => tryCorpusRoutes(fakeReq('GET', '/api/workspaces/ws/health'), res, '/api/workspaces/ws/health', '/api/workspaces/ws/health', deps as never));
        assert.equal(res._status, 200);
        return JSON.parse(res._body) as Record<string, any>;
    };

    await test('corpus_health unbound: unchanged shape and totals, no visible-count lookups', async () => {
        const gc: string[] = []; const ac: string[] = [];
        const r = await healthMcp('unbound', spy(graph, gc), spy(aux, ac));
        assert.equal(r['total_nodes'], 5);
        assert.equal(r['stale_nodes'], 2);
        assert.equal(r['edge_count'], 5);
        assert.deepEqual(r['outcome_totals'], { success: 3, failure: 1, partial: 0 });
        assert.deepEqual(r['corpus_counters'], { recalls: 7 });
        assert.ok(!('countScope' in r) && !('countsLowerBound' in r));
        for (const banned of ['bulkList', 'queryEdges', 'getNodesByIds']) assert.ok(!gc.includes(banned), `unbound must not call ${banned}`);
        assert.ok(!ac.includes('getOutcomeTotalsForNodes'));
        assert.deepEqual(await healthRest('unbound'), r, 'REST mirrors the tool');
    });

    await test('corpus_health operator: true totals, no new fields (node counters keep today\'s actor filter)', async () => {
        const r = await healthMcp('operator');
        assert.equal(r['edge_count'], 5);
        assert.deepEqual(r['outcome_totals'], { success: 3, failure: 1, partial: 0 });
        assert.deepEqual(r['corpus_counters'], { recalls: 7 });
        assert.ok(!('countScope' in r) && !('countsLowerBound' in r));
        assert.deepEqual(await healthRest('operator'), r);
    });

    await test('corpus_health app token: visible nodes / edges / outcomes only, counters omitted, labelled', async () => {
        for (const r of [await healthMcp('app'), await healthRest('app')]) {
            assert.equal(r['total_nodes'], 3);
            assert.equal(r['stale_nodes'], 1);
            assert.equal(r['edge_count'], 2, 'only edges with both endpoints visible');
            assert.deepEqual(r['outcome_totals'], { success: 1, failure: 0, partial: 0 }, 'hy1 outcomes not summed');
            assert.ok(!('corpus_counters' in r));
            assert.equal(r['countScope'], 'visible');
            assert.ok(!('countsLowerBound' in r));
        }
    });

    await test('corpus_health app token: cap -> countsLowerBound (nodes and edges walks bounded)', async () => {
        const nodes = await as('app', () => computeCorpusHealth(graph, aux, 'ws', undefined, { cap: 2 }));
        assert.equal(nodes.countsLowerBound, true);
        assert.ok(nodes.total_nodes <= 2);
        const exact = await as('app', () => computeCorpusHealth(graph, aux, 'ws', undefined, { cap: 5 }));
        assert.equal(exact.countsLowerBound, undefined, 'cap == row count is exact');
        assert.equal(exact.total_nodes, 3);
        assert.equal(exact.edge_count, 2);
        const edgeCap = await as('app', () => computeCorpusHealth(graph, aux, 'ws', undefined, { cap: 4 }));
        assert.equal(edgeCap.countsLowerBound, true, 'edge walk hit the cap (5 raw edges)');
        const gc: string[] = [];
        await as('app', () => computeCorpusHealth(spy(graph, gc), aux, 'ws', undefined, { cap: 2 }));
        assert.ok(!gc.includes('listNodes') && !gc.includes('getStats'), 'no unbounded fallback, no raw getStats');
    });

    /* ── GET /api/report ─────────────────────────────────────────────── */
    const reportRest = async (who: Who, g: object = graph) => {
        const res = fakeRes();
        const deps = { store: { loreGraph: g } };
        await as(who, () => handleReport(res, '/api/report?workspace=ws&topN=10', deps as never));
        assert.equal(res._status, 200);
        return res._body;
    };
    const line = (md: string, label: string): string => md.split('\n').find((l) => l.startsWith(`- **${label}**`)) ?? '';

    await test('report unbound: raw summary, no caller note, no scan helpers', async () => {
        const gc: string[] = [];
        const md = await reportRest('unbound', spy(graph, gc));
        assert.equal(line(md, 'Nodes'), '- **Nodes**: 5');
        assert.equal(line(md, 'Edges'), '- **Edges**: 5');
        assert.ok(!md.includes('visible to this caller'));
        assert.ok(gc.includes('getStats'), 'unbound keeps the raw getStats summary');
        assert.ok(md.includes('| T | 5 |'));
        assert.ok(md.includes('| extracted | 5 |'));
    });

    await test('report operator: true summary, no caller note', async () => {
        const md = await reportRest('operator');
        assert.equal(line(md, 'Nodes'), '- **Nodes**: 5');
        assert.equal(line(md, 'Edges'), '- **Edges**: 5');
        assert.ok(!md.includes('visible to this caller'));
    });

    await test('report app token: visible nodes / edges / type + tier tables / hub degrees, one neutral line', async () => {
        const md = await reportRest('app');
        assert.equal(line(md, 'Nodes'), '- **Nodes**: 3');
        assert.equal(line(md, 'Edges'), '- **Edges**: 2');
        assert.ok(md.includes('Counts cover items visible to this caller.'));
        assert.ok(md.includes('| T | 3 |'));
        assert.ok(md.includes('| extracted | 2 |'));
        assert.ok(!md.includes('hy1') && !md.includes('hy2'));
        const hub = md.split('\n').find((l) => l.includes('`vx1`') && l.startsWith('| 2 |'));
        assert.ok(hub, 'vx1 degree counts its 2 visible edges, not 3');
        assert.ok(!/scope|permission|hidden/i.test(md), 'no mention of scopes, permissions or hidden-ness');
    });

    await test('report app token: cap renders <n>+', async () => {
        // 5 raw nodes / 5 raw edges, cap 4: both walks are cut short (at most 2 of the 4 scanned nodes are hidden)
        const md = await as('app', () => writeGraphReport(graph as never, { visibleCounts: { cap: 4 } }));
        assert.match(line(md, 'Nodes'), /^- \*\*Nodes\*\*: \d+\+$/);
        assert.match(line(md, 'Edges'), /^- \*\*Edges\*\*: \d+\+$/);
        assert.match(md, /\| T \| \d+\+ \|/);
        const exact = await as('app', () => writeGraphReport(graph as never, { visibleCounts: { cap: 5 } }));
        assert.equal(line(exact, 'Nodes'), '- **Nodes**: 3');
        assert.equal(line(exact, 'Edges'), '- **Edges**: 2');
    });

    /* ── GET /api/diagnose/consistency ───────────────────────────────── */
    const consRest = async (who: Who, g: object = graph) => {
        const res = fakeRes();
        const deps = { store: mkStore(g, ['lore:vx1', 'lore:hy1', 'lore:orphan']), configManager: {}, activeSessions: new Map(), getDataplaneState: () => ({}) };
        await as(who, () => handleConsistency(res, '/api/diagnose/consistency?workspace=ws', deps as never));
        assert.equal(res._status, 200);
        return JSON.parse(res._body) as Record<string, any>;
    };

    await test('consistency unbound: raw counts, orphans and vector count present, no new fields', async () => {
        const gc: string[] = [];
        const r = await consRest('unbound', spy(graph, gc));
        assert.equal(r['graphNodeCount'], 5);
        assert.equal(r['vectorEmbeddingCount'], 3);
        assert.deepEqual(r['orphanEmbeddings'], ['orphan']);
        assert.deepEqual([...r['missingEmbeddings']].sort(), ['hy2', 'pub', 'vx2']);
        assert.ok(!('countScope' in r) && !('countsLowerBound' in r));
        assert.ok(!gc.includes('bulkList'), 'unbound runs no visible-count scan');
    });

    await test('consistency operator: true counts, no new fields', async () => {
        const r = await consRest('operator');
        assert.equal(r['graphNodeCount'], 5);
        assert.equal(r['vectorEmbeddingCount'], 3);
        assert.deepEqual(r['orphanEmbeddings'], ['orphan']);
        assert.ok(!('countScope' in r) && !('countsLowerBound' in r));
    });

    await test('consistency app token: visible node count + missing, vector fields omitted', async () => {
        const r = await consRest('app');
        assert.equal(r['graphNodeCount'], 3);
        assert.deepEqual([...r['missingEmbeddings']].sort(), ['pub', 'vx2'], 'hy2 hidden; hy1 hidden and embedded');
        assert.ok(!('vectorEmbeddingCount' in r) && !('orphanEmbeddings' in r) && !('sqliteOrphans' in r));
        assert.equal(r['countScope'], 'visible');
        assert.ok(!('countsLowerBound' in r));
        assert.equal(r['hasIssues'], true);
        assert.equal(r['graphScanFailed'], false);
        assert.ok(!JSON.stringify(r).includes('orphan'));
    });

    await test('consistency app token: cap -> countsLowerBound, bounded scan', async () => {
        const capped = await as('app', () => diagnoseVisibleConsistency(graph as never, null, { workspace: 'ws', visibleScanCap: 2 }));
        assert.equal(capped.countsLowerBound, true);
        assert.ok(capped.graphNodeCount <= 2);
        const exact = await as('app', () => diagnoseVisibleConsistency(graph as never, null, { workspace: 'ws', visibleScanCap: 5 }));
        assert.equal(exact.countsLowerBound, undefined);
        assert.equal(exact.graphNodeCount, 3);
        const none = await as('app', () => diagnoseVisibleConsistency({ listNodes: async () => [] } as never, null, { workspace: 'ws' }));
        assert.equal(none.graphScanFailed, true, 'no bounded scan available: fail closed, never listNodes');
    });

    aux.close();
    await (graph as { close?: () => Promise<void> }).close?.();
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
