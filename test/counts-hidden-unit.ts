#!/usr/bin/env tsx
/**
 * counts-hidden-unit.ts — Lore 3.31 slice S1. Numbers that cannot be counted per
 * item (cached/raw counters, pending-sync counts, disk sizes, metrics series,
 * calibration row counts, "X of Y" corpus-language hints) are HIDDEN from a
 * bound non-operator (app token / Clerk user); unbound and operator callers are
 * unchanged. Surfaces: GET /api/health, GET /metrics (renderMetrics), GET
 * /api/storage, GET /api/sync/status + MCP sync_status, _meta.calibration.rows,
 * buildLanguageHint.
 *
 * Three caller classes per surface:
 *   unbound  — no actor bound (embedded / local / stdio): unchanged
 *   operator — actor bound + bootstrap principal: unchanged
 *   app      — actor bound + app principal: counts absent (or 403)
 *
 * Run: npm run test:unit:counts-hidden
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';

// LORE_HOME must be set BEFORE the route modules read it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'counts-hidden-'));
process.env['LORE_HOME'] = HOME;
fs.mkdirSync(path.join(HOME, 'workspaces', 'x', '.lore'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'workspaces', 'y', '.lore'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'workspaces.json'), JSON.stringify({
    version: 1,
    active: 'x',
    workspaces: ['x', 'y'].map((name) => ({ name, path: path.join(HOME, 'workspaces', name), createdAt: new Date().toISOString() })),
}));

const { handleHealth } = await import('../packages/lore/src/mcp/http/routes/diagnostic/health.js');
const { handleStorage } = await import('../packages/lore/src/mcp/http/routes/diagnostic/storage.js');
const { renderMetrics } = await import('../packages/lore/src/mcp/http/routes/metrics.js');
const { trySyncRoutes } = await import('../packages/lore/src/mcp/http/routes/sync.js');
const { registerGovernanceTools } = await import('../packages/lore/src/mcp/tools/governance.js');
const { buildRelevanceMeta } = await import('../packages/lore/src/recall/abstention.js');
const { buildLanguageHint } = await import('../packages/lore/src/mcp/tools/search/helpers.js');
const { hideUncountableForCurrentActor } = await import('../packages/lore/src/security/exportGate.js');

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Caller = 'unbound' | 'operator' | 'app';
const PRINCIPALS: Record<Exclude<Caller, 'unbound'>, Principal> = {
    operator: { kind: 'bootstrap', workspace: 'x', scopes: ['read', 'write', 'cross-workspace-read'], label: 'bootstrap', allowedWorkspaces: ['x'] },
    app: { kind: 'app', workspace: 'x', scopes: ['read', 'write'], label: 'app', allowedWorkspaces: ['x'] },
};
function as<T>(caller: Caller, fn: () => T): T {
    if (caller === 'unbound') return fn();
    return runWithActor({ portalUserId: `u-${caller}`, scopes: ['x'] }, () => runWithPrincipal(PRINCIPALS[caller], fn));
}

function res(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
const json = (r: { _body: string }): Record<string, unknown> => JSON.parse(r._body) as Record<string, unknown>;
const reqGet = (): IncomingMessage => ({ method: 'GET', on(event: string, cb: (c?: Buffer) => void) { if (event === 'end') setImmediate(() => cb()); return this; } }) as unknown as IncomingMessage;

console.log('S1 — uncountable numbers are hidden from a bound non-operator');

await test('hideUncountableForCurrentActor: unbound false, operator false, app true', () => {
    assert.equal(as('unbound', hideUncountableForCurrentActor), false);
    assert.equal(as('operator', hideUncountableForCurrentActor), false);
    assert.equal(as('app', hideUncountableForCurrentActor), true);
});

/* ─────────────────────────── GET /api/health ─────────────────────────── */

interface Calls { handle: string[]; outbox: number; stats: number }
function healthDeps(calls: Calls) {
    const graph = { getStats: async () => { calls.stats++; return { nodeCount: 7, edgeCount: 4, typeBreakdown: {} }; } };
    return {
        store: { loreGraph: graph },
        configManager: { read: () => ({ llmProvider: 'none', telemetryOptOut: false }) },
        activeSessions: new Map(),
        deploymentMode: 'local',
        getDataplaneState: () => 'offline',
        graphRegistry: {
            openedNames: () => ['x', 'y'],
            getGraphHandle: async (n: string) => { calls.handle.push(n); return graph; },
        },
        getOutboxStats: async () => { calls.outbox++; return { depth: 5, lagSeconds: 2, dead: 1, perWorkspace: { x: { depth: 5, lagSeconds: 2, dead: 1 } } }; },
        outboxLagCache: {
            allSnapshots: () => ({ x: { depth: 5, lagSeconds: 2, refreshedAt: 1 } }),
            shouldBackpressure: () => ({ thresholdSeconds: 60, shouldBlock: false }),
        },
        workspaceVerbatimResolver: { openCount: () => 3 },
    } as never;
}
async function health(caller: Caller) {
    const calls: Calls = { handle: [], outbox: 0, stats: 0 };
    const r = res();
    await as(caller, () => runWithPrincipal(caller === 'unbound' ? PRINCIPALS.operator : PRINCIPALS[caller], () => handleHealth(r, '/api/health', healthDeps(calls))));
    return { r, calls, body: json(r) };
}
const COUNT_KEYS = ['outbox', 'perWorkspaceOutbox'];

await test('health: unbound and operator get the full counts block, identical to each other', async () => {
    const u = await health('unbound');
    const o = await health('operator');
    for (const h of [u, o]) {
        assert.equal(h.r._status, 200);
        const ws = h.body['workspaces'] as Record<string, unknown>;
        assert.deepEqual(Object.keys(ws), ['active', 'knownCount', 'scanned', 'measuredCount', 'globalTotalsComplete', 'perWorkspaceStats', 'globalTotals', 'verbatimResolverOpenCount']);
        assert.deepEqual(ws['globalTotals'], { nodeCount: 14, edgeCount: 8 });
        assert.equal(ws['knownCount'], 2);
        assert.equal(ws['verbatimResolverOpenCount'], 3);
        assert.equal((h.body['outbox'] as { depth: number }).depth, 5);
        assert.ok(h.body['perWorkspaceOutbox']);
        assert.ok(h.calls.outbox === 1 && h.calls.stats === 2);
    }
    assert.deepEqual(u.body, o.body);
    // key order of the pre-change body is preserved
    assert.deepEqual(Object.keys(u.body).slice(0, 5), ['status', 'version', 'outbox', 'perWorkspaceOutbox', 'llmProvider']);
});
await test('health: app token gets no counts block and NO count reader runs', async () => {
    const a = await health('app');
    assert.equal(a.r._status, 200);
    for (const k of COUNT_KEYS) assert.ok(!(k in a.body), `${k} must be absent`);
    assert.deepEqual(a.body['workspaces'], { active: 'x' });
    assert.equal(a.body['status'], 'ok');
    assert.ok('loreHome' in a.body && 'version' in a.body && 'sessions' in a.body, 'non-count fields kept');
    assert.deepEqual(a.calls, { handle: [], outbox: 0, stats: 0 });
    assert.ok(!/globalTotals|perWorkspaceStats|knownCount|nodeCount|edgeCount/.test(a.r._body));
});

/* ───────────────────────────── GET /metrics ───────────────────────────── */

function metricsDeps(spy: { reg: number; jobs: number; queue: number }) {
    return {
        getOutboxStats: async () => ({ depth: 5, lagSeconds: 2, dead: 1, perWorkspace: { x: { depth: 5, lagSeconds: 2, dead: 1 } } }),
        graphRegistry: {
            getOpenGraphHandle: () => { spy.reg++; return { getStats: async () => ({ nodeCount: 7, edgeCount: 4 }) }; },
        },
        loadJobsStore: { aggregateStats: async () => { spy.jobs++; return { done: 3 }; } },
        embedQueue: { depth: () => { spy.queue++; return 9; } },
        getReplicatorTicks: () => 11,
    } as never;
}
await test('metrics: unbound == operator, carries workspace + outbox + queue series; app token gets none of the count series', async () => {
    const spy = { reg: 0, jobs: 0, queue: 0 };
    // Operator first: it populates the process-wide counts cache.
    const o = await as('operator', () => renderMetrics(metricsDeps(spy)));
    assert.match(o, /lore_workspace_nodes\{workspace="x"\} 7/);
    assert.match(o, /lore_outbox_depth\{workspace="x"\} 5/);
    assert.match(o, /lore_outbox_depth_total 5/);
    assert.match(o, /lore_load_jobs_total\{state="done"\} 3/);
    assert.match(o, /lore_embed_queue_depth 9/);
    const spy2 = { reg: 0, jobs: 0, queue: 0 };
    const a = await as('app', () => renderMetrics(metricsDeps(spy2)));
    assert.ok(!/lore_workspace_nodes|lore_workspace_edges|lore_outbox_depth|lore_outbox_dead|lore_load_jobs_total|lore_embed_queue_depth/.test(a), a);
    assert.match(a, /lore_build_info/);
    assert.ok(!/lore_outbox_lag_seconds/.test(a), 'global outbox lag hidden for the app token');
    assert.match(o, /lore_outbox_lag_seconds_max 2/);
    assert.match(a, /lore_replicator_tick_total 11/);
    assert.deepEqual(spy2, { reg: 0, jobs: 0, queue: 0 }, 'no count reader ran for the app token');
    let outboxReads = 0;
    const deps3 = metricsDeps({ reg: 0, jobs: 0, queue: 0 }) as unknown as { getOutboxStats: () => Promise<unknown> };
    const inner = deps3.getOutboxStats;
    deps3.getOutboxStats = async () => { outboxReads++; return inner(); };
    await as('app', () => renderMetrics(deps3 as never));
    assert.equal(outboxReads, 0, 'outbox stats are not read for the app token');
    // The shared cache must not leak the hidden class into later callers.
    const u = await as('unbound', () => renderMetrics(metricsDeps({ reg: 0, jobs: 0, queue: 0 })));
    assert.equal(u, o, 'unbound output identical to operator output');
});

/* ── anonymous request under an operator.json identity (pinned, not endorsed) ── */

await test('anonymous request (bound actor, NO principal) is treated as non-operator: /api/health and /metrics counts hidden', async () => {
    const anon = <T>(fn: () => T): T => runWithActor({ portalUserId: 'anon', scopes: [] }, fn);
    assert.equal(anon(hideUncountableForCurrentActor), true);
    const calls: Calls = { handle: [], outbox: 0, stats: 0 };
    const r = res();
    await anon(() => handleHealth(r, '/api/health', healthDeps(calls)));
    assert.equal(r._status, 200);
    for (const k of COUNT_KEYS) assert.ok(!(k in json(r)), `${k} must be absent`);
    // No principal on the public route: the lite body, with no count reader run.
    assert.ok(!/globalTotals|perWorkspaceStats|knownCount|nodeCount|edgeCount/.test(r._body));
    assert.deepEqual(calls, { handle: [], outbox: 0, stats: 0 });
    const m = await anon(() => renderMetrics(metricsDeps({ reg: 0, jobs: 0, queue: 0 })));
    assert.ok(!/lore_workspace_nodes|lore_outbox_|lore_load_jobs_total|lore_embed_queue_depth/.test(m), m);
    assert.match(m, /lore_build_info/);
});

/* ───────────────────────────── GET /api/storage ───────────────────────── */

await test('storage: unbound and operator unchanged (200 with sizes); app token refused 403 maintenance_forbidden', () => {
    const u = res(); as('unbound', () => handleStorage(u));
    const o = res(); as('operator', () => handleStorage(o));
    assert.equal(u._status, 200); assert.equal(o._status, 200);
    assert.ok(Array.isArray(json(u)['workspaces']) && 'dataHome' in json(u));
    // Free-disk bytes drift between calls; everything else must match.
    const stable = (r: { _body: string }) => JSON.parse(r._body.replace(/"diskFreeBytes":\d+/g, '"diskFreeBytes":0'));
    assert.deepEqual(stable(u), stable(o));
    const a = res(); as('app', () => handleStorage(a));
    assert.equal(a._status, 403);
    assert.equal(json(a)['code'], 'maintenance_forbidden');
    assert.ok(!/breakdown|path/.test(a._body));
});

/* ───────────────────────── sync status (REST + MCP) ───────────────────── */

const fakeEngine = { getStatus: () => ({ walPending: 12, lastSync: '1970-01-01T00:00:00.000Z', hasAdapter: false, isAutoSyncing: false }) };
async function syncRest(caller: Caller) {
    const r = res();
    await as(caller, () => trySyncRoutes(reqGet(), r, '/api/sync/status?workspace=x', '/api/sync/status', { getSyncEngine: () => fakeEngine } as never));
    return r;
}
await test('REST /api/sync/status: unbound == operator (full status); app token omits walPending, keeps the rest', async () => {
    const u = await syncRest('unbound');
    const o = await syncRest('operator');
    assert.equal(u._status, 200);
    assert.equal(u._body, JSON.stringify(fakeEngine.getStatus()), 'byte-identical to the engine status');
    assert.equal(o._body, u._body);
    const a = await syncRest('app');
    assert.equal(a._status, 200);
    assert.deepEqual(json(a), { lastSync: '1970-01-01T00:00:00.000Z', hasAdapter: false, isAutoSyncing: false });
});

async function syncMcp(caller: Caller) {
    const tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
    registerGovernanceTools({ tool: (name: string, _d: string, _s: unknown, handler: never) => { tools.push({ name, handler }); } } as never, {
        store: {} as never,
        getSyncEngine: () => fakeEngine as never,
        detectedScope: { workspace: 'x', ecosystem: '*' },
    });
    const t = tools.find((x) => x.name === 'sync_status')!;
    const out = await as(caller, () => t.handler({ workspace: 'x' }));
    return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
}
await test('MCP sync_status: unbound == operator (walPending present); app token omits walPending', async () => {
    const u = await syncMcp('unbound');
    const o = await syncMcp('operator');
    assert.equal(u['walPending'], 12);
    assert.deepEqual(Object.keys(u).slice(0, 2), ['walPending', 'lastSync']);
    assert.deepEqual(o, u);
    const a = await syncMcp('app');
    assert.ok(!('walPending' in a));
    assert.deepEqual(Object.keys(a), ['lastSync', 'remoteConfigured', 'autoSyncing', 'engine']);
});

/* ───────────────────── calibration rows in _meta ──────────────────────── */

const calMeta = {
    topSimilarity: 0.5, topRelevance: 3.1, relevanceFloor: 2, belowFloor: false, abstained: false,
    calibration: { status: 'ok', version: 'v1', probes: 128, rows: 4321, nullMedian: 0.2, nullScale: 0.05, scope: 'x' },
} as never;
await test('calibration: unbound == operator (rows kept, key order kept); app token drops only rows', () => {
    const u = as('unbound', () => buildRelevanceMeta(calMeta));
    const o = as('operator', () => buildRelevanceMeta(calMeta));
    assert.equal(u.calibration.rows, 4321);
    assert.deepEqual(Object.keys(u.calibration), ['status', 'version', 'probes', 'rows', 'null_median', 'null_scale', 'scope']);
    assert.deepEqual(o, u);
    const a = as('app', () => buildRelevanceMeta(calMeta));
    assert.ok(!('rows' in a.calibration));
    // Everything else, including the calibration BEHAVIOUR fields, is identical.
    const { rows: _r, ...uRest } = u.calibration;
    assert.deepEqual(a.calibration, uRest);
    assert.equal(a.top_relevance, u.top_relevance);
    assert.equal(a.floor, u.floor);
    assert.equal(a.below_floor, u.below_floor);
    assert.equal(a.abstained, u.abstained);
    assert.ok(!/4321/.test(JSON.stringify(a)));
});

/* ─────────────────────── corpus-language hint ─────────────────────────── */

await test('language hint: unbound/operator build the "X of Y" hint; app token gets null and the breakdown is never read', async () => {
    let reads = 0;
    const graph = { getLanguageBreakdown: async () => { reads++; return { en: 100, fr: 1, null: 4 }; } };
    const u = await as('unbound', () => buildLanguageHint(graph as never, 'fr'));
    const o = await as('operator', () => buildLanguageHint(graph as never, 'fr'));
    assert.ok(u && /1 of 101 tagged/.test(u.suggestion), JSON.stringify(u));
    assert.deepEqual(u!.corpusLanguageBreakdown, { en: 100, fr: 1, null: 4 });
    assert.deepEqual(o, u);
    assert.equal(reads, 2);
    reads = 0;
    const a = await as('app', () => buildLanguageHint(graph as never, 'fr'));
    assert.equal(a, null);
    assert.equal(reads, 0, 'getLanguageBreakdown must not be called for an app token');
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
