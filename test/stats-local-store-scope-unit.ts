#!/usr/bin/env tsx
/**
 * stats-local-store-scope-unit.ts — Lore 3.35.2: per-workspace counts on the
 * LOCAL listener are whole-store unless the workspace shares its store.
 *
 * Before 3.35.2 every local count surface filtered by `project = <workspace>`.
 * A workspace that owns its own graph store but holds rows written with an
 * explicit, different project (Atlas's `v3` inside `default`, any
 * `project:"p1"` write) was undercounted on GET /api/stats, GET /api/health
 * perWorkspaceStats and POST /api/admin/stats byWorkspace; /metrics read 0 for
 * every workspace (detached `getStats` lost its `this`).
 *
 * Rule under test (readWorkspaceStats / workspaceStatsProjectFilter +
 * LocalGraphRegistry.sharesGraphStore):
 *   own store                       → whole-store nodes, typeBreakdown, edges
 *   store shared via an alias entry → only rows tagged project = workspace,
 *                                     edges only when both endpoints are tagged
 *   empty store                     → 0 / 0 / {}
 * Real SqliteGraph stores under a real LocalGraphRegistry in a temp LORE_HOME.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = fs.mkdtempSync(path.join(process.env['STATS_SCOPE_TMP'] ?? os.tmpdir(), 'stats-local-scope-'));
process.env['LORE_HOME'] = HOME;

const { createWorkspace, setWorkspaceGraphEngine, setWorkspaceVectorEngine, getWorkspacePath, registerWorkspaceAlias } =
    await import('../packages/lore/src/config/workspaces.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { tryDiagnosticRoutes } = await import('../packages/lore/src/mcp/http/routes/diagnostic.js');
const { renderMetrics } = await import('../packages/lore/src/mcp/http/routes/metrics.js');
const { readWorkspaceStats, workspaceStatsProjectFilter } = await import('../packages/lore/src/mcp/http/routes/diagnostic/shared.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
type Res = ServerResponse & { _status: number; _body: string };
function mkRes(): Res {
    const r = { _status: 0, _body: '', writableEnded: false, writeHead(s: number) { this._status = s; return this; }, end(b?: string) { this._body = b ?? ''; this.writableEnded = true; }, once() { return this; }, setHeader() { return this; } };
    return r as unknown as Res;
}
const mkReq = (method: 'GET' | 'POST', body = ''): IncomingMessage => ({
    method, headers: { 'content-type': 'application/json' },
    on(e: string, cb: (chunk?: Buffer) => void) {
        if (e === 'data' && body) setImmediate(() => cb(Buffer.from(body)));
        if (e === 'end') setImmediate(() => setImmediate(() => cb()));
        return this;
    },
}) as unknown as IncomingMessage;

const mk = (name: string) => {
    createWorkspace(name, undefined, HOME);
    setWorkspaceGraphEngine(name, 'sqlite', HOME);
    setWorkspaceVectorEngine(name, 'sqlite', HOME);
};
mk('solo');   // own store, rows under several projects
mk('base');   // store shared with 'base-alias'
mk('empty');  // own store, no rows
registerWorkspaceAlias('base-alias', getWorkspacePath('base', HOME), undefined, HOME);
setWorkspaceGraphEngine('base-alias', 'sqlite', HOME);

const registry = new LocalGraphRegistry({ home: HOME });
type G = { upsertNode: (n: Record<string, unknown>) => Promise<unknown>; addEdge: (e: Record<string, unknown>) => Promise<unknown>; getStats: (p?: string) => Promise<{ nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number> }> };
const handle = async (ws: string) => (await registry.getGraphHandle(ws)) as unknown as G;
const node = (id: string, type: string, project: string) => ({ id, type, label: id, content: id, tags: [], project, ecosystem: '*', metadata: '{}' });

// solo: 10 x project 'solo', 6 x 'p1', 4 x 'p2' (Atlas-style explicit projects).
// Types: concept 7, decision 8, note 5. Edges: 5 solo-solo, 3 p1-p1, 2 solo-p1 = 10.
{
    const g = await handle('solo');
    const types = ['concept', 'decision', 'note', 'concept', 'decision'];
    for (let i = 0; i < 10; i++) await g.upsertNode(node(`s-${i}`, types[i % 5]!, 'solo'));
    for (let i = 0; i < 6; i++) await g.upsertNode(node(`p1-${i}`, i < 3 ? 'concept' : 'decision', 'p1'));
    for (let i = 0; i < 4; i++) await g.upsertNode(node(`p2-${i}`, i < 1 ? 'decision' : 'note', 'p2'));
    for (let i = 0; i < 5; i++) await g.addEdge({ sourceId: `s-${i}`, targetId: `s-${i + 5}`, relation: 'r' });
    for (let i = 0; i < 3; i++) await g.addEdge({ sourceId: `p1-${i}`, targetId: `p1-${i + 3}`, relation: 'r' });
    for (let i = 0; i < 2; i++) await g.addEdge({ sourceId: `s-${i}`, targetId: `p1-${i}`, relation: 'r' });
}
// base store: 5 x 'base', 3 x 'base-alias', 2 x 'p1'.
// Edges: base-base 2, alias-alias 1, base-alias 1, alias-p1 1 = 5.
{
    const g = await handle('base');
    for (let i = 0; i < 5; i++) await g.upsertNode(node(`b-${i}`, 'note', 'base'));
    for (let i = 0; i < 3; i++) await g.upsertNode(node(`a-${i}`, 'concept', 'base-alias'));
    for (let i = 0; i < 2; i++) await g.upsertNode(node(`bp-${i}`, 'decision', 'p1'));
    await g.addEdge({ sourceId: 'b-0', targetId: 'b-1', relation: 'r' });
    await g.addEdge({ sourceId: 'b-2', targetId: 'b-3', relation: 'r' });
    await g.addEdge({ sourceId: 'a-0', targetId: 'a-1', relation: 'r' });
    await g.addEdge({ sourceId: 'a-2', targetId: 'b-4', relation: 'r' });
    await g.addEdge({ sourceId: 'a-1', targetId: 'bp-0', relation: 'r' });
}
await handle('empty');
await handle('base-alias'); // dedups onto base's open handle

const fakeStore = { loreGraph: { getStats: async () => ({ nodeCount: 0, edgeCount: 0, typeBreakdown: {} }), getLanguageBreakdown: async () => ({}) },
    storageClient: { verbatimCount: async () => 0, getStats: async () => ({ nodeCount: 0, edgeCount: 0, typeBreakdown: {} }) } };
const deps = () => ({
    store: fakeStore, configManager: { read: () => ({}) }, activeSessions: new Map(), deploymentMode: 'local',
    getDataplaneState: () => 'offline', graphRegistry: registry,
    outboxStore: { deadLetterSummary: async () => ({ deadLettered: 0, deadSuperseded: 0, deadByReason: {} }) },
}) as never;

async function route(method: 'GET' | 'POST', url: string, body = ''): Promise<Record<string, any>> {
    const res = mkRes();
    const pathname = url.split('?')[0]!;
    const handled = await tryDiagnosticRoutes(mkReq(method, body), res, url, pathname, deps());
    assert.ok(handled, `${method} ${url} not handled`);
    assert.equal(res._status, 200, `${method} ${url}: ${res._body}`);
    return JSON.parse(res._body);
}
const stats = (ws: string) => route('GET', `/api/stats?workspace=${ws}`);
const APP = (ws: string) => ({ kind: 'app', workspace: ws, scopes: ['read'], label: 't', allowedWorkspaces: [ws] }) as never;
const asApp = <T>(ws: string, fn: () => Promise<T>) => runWithPrincipal(APP(ws), () => runWithActor({ portalUserId: 'u', scopes: [] }, fn));

console.log('local-listener stats: whole store unless shared (3.35.2)');

await test('S1 sharesGraphStore: alias pair true, own stores false, unknown false', () => {
    assert.equal(registry.sharesGraphStore('base'), true);
    assert.equal(registry.sharesGraphStore('base-alias'), true);
    assert.equal(registry.sharesGraphStore('solo'), false);
    assert.equal(registry.sharesGraphStore('empty'), false);
    assert.equal(registry.sharesGraphStore('nope'), false);
    assert.equal(workspaceStatsProjectFilter(registry, 'solo'), undefined);
    assert.equal(workspaceStatsProjectFilter(registry, 'base'), 'base');
    assert.equal(workspaceStatsProjectFilter(undefined, 'solo'), 'solo', 'no registry (arcade/cloud shims): unchanged');
});

await test('S2 GET /api/stats, own store with mixed projects: whole-store nodes, typeBreakdown and edges', async () => {
    const b = await stats('solo');
    assert.equal(b.nodeCount, 20);
    assert.equal(b.edgeCount, 10);
    assert.deepEqual(b.typeBreakdown, { concept: 7, decision: 8, note: 5 });
});

await test('S3 GET /api/stats, alias sharing a store: only its tagged rows; edges need both endpoints tagged', async () => {
    const base = await stats('base');
    assert.equal(base.nodeCount, 5);
    assert.equal(base.edgeCount, 2);
    assert.deepEqual(base.typeBreakdown, { note: 5 });
    const alias = await stats('base-alias');
    assert.equal(alias.nodeCount, 3);
    assert.equal(alias.edgeCount, 1);
    assert.deepEqual(alias.typeBreakdown, { concept: 3 });
});

await test('S4 GET /api/stats, empty own store: zeros', async () => {
    const b = await stats('empty');
    assert.equal(b.nodeCount, 0);
    assert.equal(b.edgeCount, 0);
    assert.deepEqual(b.typeBreakdown ?? {}, {});
});

await test('S5 bound app token (visibleGraphStats branch) follows the same rule', async () => {
    const solo = await asApp('solo', () => stats('solo'));
    assert.equal(solo.nodeCount, 20);
    assert.equal(solo.edgeCount, 10);
    const base = await asApp('base', () => stats('base'));
    assert.equal(base.nodeCount, 5);
    assert.equal(base.edgeCount, 2);
});

await test('S6 POST /api/admin/stats byWorkspace + totals use the rule', async () => {
    const b = await route('POST', '/api/admin/stats', '{}');
    const bw = b.byWorkspace ?? b.workspaces ?? {};
    assert.deepEqual({ n: bw.solo?.nodeCount, e: bw.solo?.edgeCount }, { n: 20, e: 10 });
    assert.deepEqual({ n: bw.base?.nodeCount, e: bw.base?.edgeCount }, { n: 5, e: 2 });
    assert.deepEqual({ n: bw['base-alias']?.nodeCount, e: bw['base-alias']?.edgeCount }, { n: 3, e: 1 });
    assert.deepEqual({ n: bw.empty?.nodeCount, e: bw.empty?.edgeCount }, { n: 0, e: 0 });
});

await test('S7 GET /api/health perWorkspaceStats (operator, ?workspaces=all) uses the rule', async () => {
    // Unauthenticated health is the liveness-only body; the counts block is for a principal.
    const boot = { kind: 'bootstrap', workspace: 'solo', scopes: ['read', 'write'], label: 'bootstrap' } as never;
    const b = await runWithPrincipal(boot, () => route('GET', '/api/health?workspaces=all'));
    const per = b.workspaces?.perWorkspaceStats ?? {};
    assert.deepEqual({ n: per.solo?.nodeCount, e: per.solo?.edgeCount }, { n: 20, e: 10 });
    assert.deepEqual({ n: per.base?.nodeCount, e: per.base?.edgeCount }, { n: 5, e: 2 });
    assert.deepEqual({ n: per['base-alias']?.nodeCount, e: per['base-alias']?.edgeCount }, { n: 3, e: 1 });
    assert.deepEqual({ n: per.empty?.nodeCount, e: per.empty?.edgeCount }, { n: 0, e: 0 });
});

await test('S8 /metrics lore_workspace_nodes/edges: real counts (were 0: detached getStats lost `this`)', async () => {
    const body = await renderMetrics({ graphRegistry: registry } as never);
    const v = (metric: string, ws: string) => {
        const m = body.match(new RegExp(`^${metric}\\{workspace="${ws}"\\} (\\d+)$`, 'm'));
        return m ? Number(m[1]) : undefined;
    };
    assert.deepEqual([v('lore_workspace_nodes', 'solo'), v('lore_workspace_edges', 'solo')], [20, 10]);
    assert.deepEqual([v('lore_workspace_nodes', 'base'), v('lore_workspace_edges', 'base')], [5, 2]);
    assert.deepEqual([v('lore_workspace_nodes', 'base-alias'), v('lore_workspace_edges', 'base-alias')], [3, 1]);
    assert.deepEqual([v('lore_workspace_nodes', 'empty'), v('lore_workspace_edges', 'empty')], [0, 0]);
});

await test('S9 readWorkspaceStats without a registry keeps the old project filter (arcade/cloud callers)', async () => {
    const g = await handle('solo');
    const s = await readWorkspaceStats(g as never, 'solo');
    assert.equal(s.nodeCount, 10);
    assert.equal(s.edgeCount, 5);
});

await registry.disposeAll();
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
