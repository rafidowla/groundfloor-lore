#!/usr/bin/env tsx
/**
 * test/L2-stats-workspace-unit.ts — Sprint L Chain B unit tests
 *
 * Asserts the L2 workspace-scoped contract for the stats + health
 * surfaces:
 *   - /api/stats without workspace → 400 workspace_required
 *   - /api/stats?workspace=X → 200 with workspace-narrowed counts
 *   - /api/stats?workspace=NOPE → 404 workspace_not_found w/ known list
 *   - POST /api/admin/stats → returns scope:'all-workspaces' + byWorkspace
 *     breakdown + globalTotals; sum(byWorkspace) === globalTotals
 *   - /api/admin/stats with denied gate → 403 (cloud-mode shape; local
 *     mode always allows, so we drive a synthetic deny via a fake gate)
 *   - /api/health → body includes workspaces.perWorkspaceStats with one
 *     key per known workspace
 *   - Workspace divergence: writing one extra node to "default" bumps
 *     default's count by 1; globalTotals increases by 1
 *
 * Companion to test/L-database-property-unit.ts (gate test); L2 flips
 * D1 there in lockstep.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { WorkspaceNotFoundError } from '../packages/lore/src/engines/localGraphRegistry.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';

// Audit #6 — the force-open-all scan now requires an authenticated principal.
const AUTHED: Principal = { kind: 'app', workspace: 'default', scopes: ['read'], label: 't', allowedWorkspaces: ['default'] };

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        failed++;
    }
}

/* ---- Shared fakes ---- */

function makeFakeGraph(nodeCount: number, edgeCount: number, typeBreakdown: Record<string, number> = {}): unknown {
    return {
        getGraphContext: () => ({
            queryRows: async () => [],
            executeQuery: async () => undefined,
            bumpEpoch: () => undefined,
            storage: {},
            detectLanguage: () => ({ language: null, confidence: 0 }),
        }),
        getStats: async () => ({ nodeCount, edgeCount, typeBreakdown }),
        getLanguageBreakdown: async () => ({}),
    };
}

// Fake StorageBundle.store. Production handlers read corpus counts through
// the LoreStorageClient facade (store.storageClient.getStats() /
// .verbatimCount()) — not directly off loreGraph/loreVerbatim — so the fake
// store must expose a storageClient. getStats() mirrors the boot-bound
// graph's counts (used by the /api/admin/stats no-registry fallback);
// verbatimCount() mirrors the requested verbatim total.
function makeFakeStore(
    graph: unknown,
    nodeCount: number,
    edgeCount: number,
    verbatimDocs: number,
    typeBreakdown: Record<string, number> = {},
): unknown {
    return {
        loreGraph: graph,
        loreVerbatim: { count: async () => verbatimDocs },
        storageClient: {
            getStats: async () => ({ nodeCount, edgeCount, typeBreakdown }),
            verbatimCount: async () => verbatimDocs,
        },
    };
}

function reqGet(): IncomingMessage {
    return {
        method: 'GET',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function reqPost(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
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

// In-memory multi-workspace registry stub. Mirrors the LocalGraphRegistry
// surface that diagnostic.ts uses: getOrOpen(name) → graph; unknown name
// → WorkspaceNotFoundError(known: [...]). stats.ts resolves graphs through
// getGraphHandle (the workspace's declared engine) since Kùzu-removal step2
// commit 8 (40d0d90); getOrOpen stays wired too since it's still the Kùzu
// substrate accessor other callers use.
function makeRegistry(graphsByName: Record<string, unknown>): any {
    const open = async (name: string) => {
        if (!(name in graphsByName)) {
            throw new WorkspaceNotFoundError(name, Object.keys(graphsByName));
        }
        return graphsByName[name];
    };
    return { getOrOpen: open, getGraphHandle: open };
}

function baseDeps(overrides: Partial<Parameters<typeof tryDiagnosticRoutes>[4]>): Parameters<typeof tryDiagnosticRoutes>[4] {
    return {
        store: makeFakeStore(makeFakeGraph(0, 0), 0, 0, 0) as never,
        pluginRegistry: {
            collectPluginStats: async () => ({}),
            getOrphanState: () => ({ blocking: false, orphans: [] }),
        } as never,
        configManager: { read: () => ({ plugins: [], llmProvider: 'none' }) } as never,
        activeSessions: new Map(),
        deploymentMode: 'local',
        getDataplaneState: () => 'offline',
        ...overrides,
    } as never;
}

console.log('Sprint L2 — workspace-scoped /api/stats + /api/admin/stats + /api/health unit tests');

/* ---- T2: /api/stats without workspace → 400 ---- */
await test('T2 /api/stats without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/stats', '/api/stats', baseDeps({}));
    assert.equal(res._status, 400, `got ${res._status}: ${res._body}`);
    assert.match(res._body, /workspace_required/);
});

/* ---- T3: /api/stats?workspace=default returns workspace-narrowed counts ---- */
await test('T3 /api/stats?workspace=default → 200 with narrowed counts', async () => {
    const defaultGraph = makeFakeGraph(146, 412, { decision: 50, convention: 30 });
    const atlasGraph = makeFakeGraph(54114, 159066, { code_symbol: 50000 });
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/stats?workspace=default', '/api/stats', baseDeps({
        store: makeFakeStore(defaultGraph, 146, 412, 99) as never,
        graphRegistry: makeRegistry({ default: defaultGraph, atlas: atlasGraph }),
    }));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    assert.equal(body.workspace, 'default');
    assert.equal(body.scope, 'workspace');
    assert.equal(body.nodeCount, 146);
    assert.equal(body.edgeCount, 412);
});

/* ---- workspace=atlas narrowing ---- */
await test('T3b /api/stats?workspace=atlas → narrows to atlas graph', async () => {
    const defaultGraph = makeFakeGraph(146, 412);
    const atlasGraph = makeFakeGraph(54114, 159066);
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/stats?workspace=atlas', '/api/stats', baseDeps({
        graphRegistry: makeRegistry({ default: defaultGraph, atlas: atlasGraph }),
    }));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    assert.equal(body.workspace, 'atlas');
    assert.equal(body.nodeCount, 54114);
});

/* ---- unknown workspace → 404 workspace_not_found ---- */
await test('T3c /api/stats?workspace=NOPE → 404 workspace_not_found with known list', async () => {
    const defaultGraph = makeFakeGraph(1, 0);
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/stats?workspace=NOPE', '/api/stats', baseDeps({
        graphRegistry: makeRegistry({ default: defaultGraph, atlas: makeFakeGraph(2, 0) }),
    }));
    assert.equal(res._status, 404, `got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    // Wave 5: canonical {code, message} envelope (was {error}).
    assert.equal(body.code, 'workspace_not_found');
    assert.ok(Array.isArray(body.known));
});

/* ---- T4: /api/admin/stats sum(byWorkspace) === globalTotals ---- */
// We can't drive listWorkspaceNames() from inside the test (it reads
// workspaces.json off disk). Instead we drive the fallback path
// (graphRegistry absent), which exercises the byWorkspace assembly via
// the active-workspace branch — sum still equals globalTotals.
await test('T4 /api/admin/stats fallback path: sum(byWorkspace) = globalTotals', async () => {
    const activeGraph = makeFakeGraph(146, 412);
    const res = fakeRes();
    await tryDiagnosticRoutes(reqPost('{}'), res, '/api/admin/stats', '/api/admin/stats', baseDeps({
        store: makeFakeStore(activeGraph, 146, 412, 0) as never,
    }));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    assert.equal(body.scope, 'all-workspaces');
    const byWs = body.byWorkspace as Record<string, { nodeCount: number; edgeCount: number }>;
    const totals = body.globalTotals as { nodeCount: number; edgeCount: number };
    const sumN = Object.values(byWs).reduce((acc, v) => acc + v.nodeCount, 0);
    const sumE = Object.values(byWs).reduce((acc, v) => acc + v.edgeCount, 0);
    assert.equal(sumN, totals.nodeCount, `node sum ${sumN} !== totals ${totals.nodeCount}`);
    assert.equal(sumE, totals.edgeCount);
});

/* ---- T5: /api/admin/stats without admin perm (cloud-mode deny) → 403 ----
 *
 * In local mode gateRoute short-circuits to allowed=true. To exercise
 * the deny path we flip deploymentMode='cloud' with no dataplane wired
 * — gateRoute returns reason='no_dataplane' and writePermissionDenied
 * maps it to the canonical envelope. The body shape (status 401/403/503)
 * is set by writePermissionDenied; we just assert it isn't 200.
 */
await test('T5 /api/admin/stats in cloud mode with no dataplane → non-2xx (gate denied)', async () => {
    const res = fakeRes();
    await tryDiagnosticRoutes(reqPost('{}'), res, '/api/admin/stats', '/api/admin/stats', baseDeps({
        deploymentMode: 'cloud',
        dataplane: null,
    }));
    assert.ok(res._status >= 400 && res._status < 600 && res._status !== 200, `expected non-2xx; got ${res._status}: ${res._body}`);
});

/* ---- T6: /api/health body includes workspaces.perWorkspaceStats ---- */
await test('T6 /api/health body includes workspaces.perWorkspaceStats per known workspace', async () => {
    const defaultGraph = makeFakeGraph(146, 412);
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/health', '/api/health', baseDeps({
        store: makeFakeStore(defaultGraph, 146, 412, 0) as never,
    }));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    const ws = body.workspaces as Record<string, unknown>;
    assert.ok(ws, 'expected workspaces block in /api/health');
    assert.ok(typeof ws.active === 'string');
    assert.ok(typeof ws.knownCount === 'number');
    assert.ok(ws.perWorkspaceStats && typeof ws.perWorkspaceStats === 'object');
    const gt = ws.globalTotals as { nodeCount: number; edgeCount: number };
    assert.equal(typeof gt.nodeCount, 'number');
    assert.equal(typeof gt.edgeCount, 'number');
});

/* ---- T7: workspace divergence visible in /api/health ----
 *
 * Bump nodeCount of the active graph by 1; /api/health globalTotals
 * (in the fallback / no-registry path) reflects the same delta. This
 * proves the body is not a frozen snapshot — counts come from the live
 * graph each call, so an operator who writes one node sees the delta in
 * the very next /api/health.
 */
await test('T7 /api/health surfaces workspace-vs-global divergence', async () => {
    let n = 146;
    const liveGraph = {
        getGraphContext: () => ({}),
        getStats: async () => ({ nodeCount: n, edgeCount: 0, typeBreakdown: {} }),
        getLanguageBreakdown: async () => ({}),
    };
    const before = fakeRes();
    await tryDiagnosticRoutes(reqGet(), before, '/api/health', '/api/health', baseDeps({
        store: { loreGraph: liveGraph as never, loreVerbatim: { count: async () => 0 } } as never,
    }));
    const beforeBody = JSON.parse(before._body);
    const beforeTotal = (beforeBody.workspaces.globalTotals as { nodeCount: number }).nodeCount;
    n += 1; // operator wrote one node
    const after = fakeRes();
    await tryDiagnosticRoutes(reqGet(), after, '/api/health', '/api/health', baseDeps({
        store: { loreGraph: liveGraph as never, loreVerbatim: { count: async () => 0 } } as never,
    }));
    const afterBody = JSON.parse(after._body);
    const afterTotal = (afterBody.workspaces.globalTotals as { nodeCount: number }).nodeCount;
    assert.equal(afterTotal - beforeTotal, 1, `expected +1; got ${afterTotal} - ${beforeTotal}`);
});

/* ---- T8–T10: SP-stampede — /api/health workspace-scan gating ---- *
 *
 * Default /api/health measures only workspaces already cached in the
 * registry (cache hits, zero LRU churn) so an unauthenticated GET storm
 * can't force-open every cold workspace. ?workspaces=all opts into the
 * full force-open scan. A registry without openedNames() (older stub)
 * falls back to the full scan for back-compat.
 */

// Registry stub that reports which names are "hot" via openedNames().
function makeRegistryWithOpen(graphsByName: Record<string, unknown>, openNames: string[]): any {
    return {
        openedNames: () => [...openNames],
        async getOrOpen(name: string) {
            if (!(name in graphsByName)) {
                throw new WorkspaceNotFoundError(name, Object.keys(graphsByName));
            }
            return graphsByName[name];
        },
    };
}

await test('T8 /api/health default scan reports scanned:open + honesty flags', async () => {
    const active = makeFakeGraph(10, 5);
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/health', '/api/health', baseDeps({
        graphRegistry: makeRegistryWithOpen({ default: active }, ['default']) as never,
    }));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const ws = JSON.parse(res._body).workspaces as Record<string, unknown>;
    assert.equal(ws.scanned, 'open', 'default scan must be hot-only');
    assert.equal(typeof ws.measuredCount, 'number');
    assert.equal(typeof ws.globalTotalsComplete, 'boolean');
});

await test('T9 AUTHENTICATED /api/health?workspaces=all forces a full scan (scanned:all)', async () => {
    const active = makeFakeGraph(10, 5);
    const res = fakeRes();
    // Audit #6 — full force-open scan requires an authenticated principal.
    await runWithPrincipal(AUTHED, () => tryDiagnosticRoutes(reqGet(), res, '/api/health?workspaces=all', '/api/health', baseDeps({
        graphRegistry: makeRegistryWithOpen({ default: active }, ['default']) as never,
    })));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const ws = JSON.parse(res._body).workspaces as Record<string, unknown>;
    assert.equal(ws.scanned, 'all', 'authenticated ?workspaces=all must force the full scan');
    assert.equal(ws.globalTotalsComplete, true, 'full scan is always complete');
});

await test('T9b ANONYMOUS /api/health?workspaces=all downgrades to hot-only (no stampede)', async () => {
    const active = makeFakeGraph(10, 5);
    const res = fakeRes();
    // No principal bound (unauthenticated GET storm). The expensive force-open
    // path must NOT be reachable: it silently downgrades to the cheap hot-only
    // scan, still returning 200 so liveness monitors are unaffected.
    await tryDiagnosticRoutes(reqGet(), res, '/api/health?workspaces=all', '/api/health', baseDeps({
        graphRegistry: makeRegistryWithOpen({ default: active }, ['default']) as never,
    }));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const ws = JSON.parse(res._body).workspaces as Record<string, unknown>;
    assert.equal(ws.scanned, 'open', 'anonymous ?workspaces=all must downgrade to hot-only');
});

await test('T10 registry without openedNames() falls back to full scan', async () => {
    const active = makeFakeGraph(10, 5);
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/health', '/api/health', baseDeps({
        // makeRegistry has no openedNames → back-compat full scan.
        graphRegistry: makeRegistry({ default: active }) as never,
    }));
    assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
    const ws = JSON.parse(res._body).workspaces as Record<string, unknown>;
    assert.equal(ws.scanned, 'all', 'no openedNames → preserve old full-scan behavior');
});

/* ---- R4 #5/#6 — cross-workspace read gate on /api/stats + /api/report ---- *
 * AUTHED is bound to 'default' (no cross-workspace-read); requesting another
 * workspace's stats/report must 403. Null principal = legacy bypass. */

await test('R4#5 alpha token → GET /api/stats?workspace=atlas → 403 (no cross-ws corpus counts)', async () => {
    const res = fakeRes();
    await runWithPrincipal(AUTHED, () => tryDiagnosticRoutes(reqGet(), res, '/api/stats?workspace=atlas', '/api/stats', baseDeps({
        graphRegistry: makeRegistry({ default: makeFakeGraph(5, 2), atlas: makeFakeGraph(9, 4) }) as never,
    })));
    assert.equal(res._status, 403, `got ${res._status}: ${res._body}`);
    assert.match(res._body, /workspace_forbidden/);
});

await test('R4#5 alpha token → GET /api/stats?workspace=default (own) → not 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(AUTHED, () => tryDiagnosticRoutes(reqGet(), res, '/api/stats?workspace=default', '/api/stats', baseDeps({
        graphRegistry: makeRegistry({ default: makeFakeGraph(5, 2) }) as never,
    })));
    assert.notEqual(res._status, 403, `got ${res._status}: ${res._body}`);
});

await test('R4#6 alpha token → GET /api/report?workspace=atlas → 403 (no cross-ws node dump)', async () => {
    const res = fakeRes();
    await runWithPrincipal(AUTHED, () => tryDiagnosticRoutes(reqGet(), res, '/api/report?workspace=atlas', '/api/report', baseDeps({
        graphRegistry: makeRegistry({ default: makeFakeGraph(5, 2), atlas: makeFakeGraph(9, 4) }) as never,
    })));
    assert.equal(res._status, 403, `got ${res._status}: ${res._body}`);
    assert.match(res._body, /workspace_forbidden/);
});

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('OK');
