#!/usr/bin/env tsx
/**
 * stats-http-graph-location-unit.ts — Lore 3.35.1: HTTP `GET /api/stats` on the
 * LOCAL listener reports where the workspace's graph lives, from the same
 * helpers as the MCP `stats` tool (engineReport / workspaceGraphPath).
 *
 * New fields (additive):
 *   engine, graphEngine, verbatimEngine — every local caller.
 *   graphPath                           — unbound / operator callers only
 *                                         (the raw branch, gated like deadByReason).
 * Never on the arcade listener (see stats-arcade-cell-counts-unit.ts A5) and
 * never in cloud mode. On SurrealDB, graphPath is the resolved, URL-escaped
 * path `openSurreal` opens; the home here deliberately contains a space.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stats graph loc '));
process.env['LORE_HOME'] = HOME;

const { createWorkspace, setWorkspaceGraphEngine, setWorkspaceVectorEngine, getWorkspacePath } = await import('../packages/lore/src/config/workspaces.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { tryDiagnosticRoutes } = await import('../packages/lore/src/mcp/http/routes/diagnostic.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { workspaceGraphPath } = await import('../packages/lore/src/mcp/tools/engineLabels.js');
const { sqliteGraphDataPath } = await import('../packages/lore/src/engines/sqlite/sqliteGraphSchema.js');
const { surrealDataPath } = await import('../packages/lore/src/engines/surreal/surrealConnection.js');

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
const getReq = (): IncomingMessage => ({ method: 'GET', headers: {}, on(e: string, cb: () => void) { if (e === 'end') setImmediate(cb); return this; } }) as unknown as IncomingMessage;

const mk = (name: string, graph: 'surreal' | 'sqlite', vector: 'lance' | 'sqlite') => {
    createWorkspace(name, undefined, HOME);
    setWorkspaceGraphEngine(name, graph, HOME);
    setWorkspaceVectorEngine(name, vector, HOME);
};
mk('sq', 'sqlite', 'sqlite');
mk('sr', 'surreal', 'lance');
const real = new LocalGraphRegistry({ home: HOME });

// Opening a SurrealDB store is not what is under test: hand the surreal
// workspace a counts-only fake graph; the sqlite workspace opens for real.
const fakeGraph = {
    getStats: async () => ({ nodeCount: 0, edgeCount: 0, typeBreakdown: {} }),
    getLanguageBreakdown: async () => ({}),
};
const registry = {
    getGraphHandle: async (n: string) => (n === 'sr' ? fakeGraph : real.getGraphHandle(n)),
    getOrOpen: async (n: string) => (n === 'sr' ? fakeGraph : real.getGraphHandle(n)),
    graphEngineFor: (n: string) => real.graphEngineFor(n),
    homeDir: () => real.homeDir(),
    activeName: () => 'sq',
};
const store = { loreGraph: fakeGraph, storageClient: { verbatimCount: async () => 0, getStats: async () => ({ nodeCount: 0, edgeCount: 0, typeBreakdown: {} }) } };
const outboxStore = { deadLetterSummary: async () => ({ deadLettered: 1, deadSuperseded: 0, deadByReason: { permanent: 1 } }) };

function deps(mode: 'local' | 'cloud' = 'local') {
    return {
        store, configManager: { read: () => ({}) }, activeSessions: new Map(), deploymentMode: mode,
        getDataplaneState: () => 'offline', graphRegistry: mode === 'local' ? registry : undefined, outboxStore,
    } as never;
}
async function stats(ws: string, mode: 'local' | 'cloud' = 'local'): Promise<Record<string, any>> {
    const res = mkRes();
    await tryDiagnosticRoutes(getReq(), res, `/api/stats?workspace=${ws}`, '/api/stats', deps(mode));
    assert.equal(res._status, 200, res._body);
    return JSON.parse(res._body);
}

const sqBase = getWorkspacePath('sq', HOME);
const srBase = getWorkspacePath('sr', HOME);

console.log('HTTP /api/stats graph location (3.35.1)');

await test('B1 unbound caller, SQLite workspace: engine labels + the real graph.sqlite path (space kept literal)', async () => {
    const b = await stats('sq');
    assert.equal(b.engine, 'sqlite (local)');
    assert.equal(b.graphEngine, 'sqlite');
    assert.equal(b.verbatimEngine, 'sqlite');
    assert.equal(b.graphPath, sqliteGraphDataPath(sqBase));
    assert.ok(b.graphPath.includes(' ') && b.graphPath.endsWith(path.join('.lore', 'graph.sqlite')), b.graphPath);
    assert.equal(b.deadByReason?.permanent, 1, 'existing raw-branch fields unchanged');
});

await test('B2 unbound caller, SurrealDB workspace: graphPath is the resolved, URL-escaped surreal path', async () => {
    const b = await stats('sr');
    assert.equal(b.engine, 'surrealdb (local)');
    assert.equal(b.graphEngine, 'surreal');
    assert.equal(b.verbatimEngine, 'lancedb');
    assert.equal(b.graphPath, surrealDataPath(srBase));
    assert.ok(b.graphPath.includes('%20') && !b.graphPath.includes(' '), `space must be URL-escaped: ${b.graphPath}`);
});

await test('B3 operator (bootstrap) principal still gets graphPath', async () => {
    const b = await runWithPrincipal({ kind: 'bootstrap', workspace: 'sq', scopes: ['read', 'write'], label: 'bootstrap' } as never,
        () => runWithActor({ portalUserId: 'op', scopes: [] }, () => stats('sq')));
    assert.equal(b.graphPath, sqliteGraphDataPath(sqBase));
});

await test('B4 bound app token: engine labels yes, graphPath and deadByReason no', async () => {
    const b = await runWithPrincipal({ kind: 'app', workspace: 'sq', scopes: ['read'], label: 't', allowedWorkspaces: ['sq'] } as never,
        () => runWithActor({ portalUserId: 'u', scopes: [] }, () => stats('sq')));
    assert.equal(b.engine, 'sqlite (local)');
    assert.equal(b.graphEngine, 'sqlite');
    assert.ok(!('graphPath' in b), 'graphPath is operator/unbound only');
    assert.ok(!('deadByReason' in b));
    assert.equal(b.deadLettered, 1);
});

await test('B5 cloud mode: no location fields', async () => {
    const b = await stats('sq', 'cloud');
    for (const k of ['graphPath', 'engine', 'graphEngine', 'verbatimEngine']) assert.ok(!(k in b), k);
});

await test('B6 workspaceGraphPath (the helper shared with the MCP stats tool) resolves sqlite + surreal store paths', () => {
    assert.equal(workspaceGraphPath(real, 'sq', HOME), sqliteGraphDataPath(sqBase));
    assert.equal(workspaceGraphPath(real, 'sr', HOME), surrealDataPath(srBase));
});

await real.disposeAll();
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
