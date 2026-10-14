#!/usr/bin/env tsx
/**
 * test/recallable-route-unit.ts - 3.34.0 slice 3b (N5): POST /api/nodes/recallable, the HTTP surface.
 *
 * Drives tryRecallableRoutes directly (local-mode deps, real SQLite outbox, fake vector/graph) and
 * tryArcadeDataRoutes for the allowlist + auth door. The engine-neutral waiter is covered by
 * recallable-engine-contract-unit.ts; this file pins the route contract:
 *
 *   - arcade allowlist: the path is on it (and only POST), auth runs first (401 before any work)
 *   - own rate bucket: `recallable` (local) / `arcade_recallable` (arcade), never the generic bucket
 *   - request validation: exactly one of ids / allBeforeNow, over-cap 400 recallable_too_many_ids,
 *     bad timeout, workspace required, workspace "*" refused, cloud mode with no dataplane => 403
 *   - workspace binding: ids resolve ONLY against the requested workspace's graph/vector/outbox lane;
 *     a token bound to another workspace is refused; ids elsewhere => not_found
 *   - timeout is a 200 status, clamped to LORE_RECALLABLE_MAX_TIMEOUT_MS; 501 when the engine cannot answer
 *
 * Run: npx tsx test/recallable-route-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryRecallableRoutes, recallableDefaultTimeoutMs, recallableMaxTimeoutMs, recallableMaxIds } from '../packages/lore/src/mcp/http/routes/recallable.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { ArcadeAuthError } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { classifyRequest, buildDefaultBuckets } from '../packages/lore/src/security/rateLimit.js';
import { classifyArcadeRequest, arcadeBucketConfigs } from '../packages/lore/src/security/arcadeRateClassifier.js';
import { WorkspaceNotFoundError } from '../packages/lore/src/engines/localGraphRegistry.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? String(e)}`); failed++; }
}

const dirs: string[] = [];
const keepAlive = setInterval(() => undefined, 1000); // waitForRefresh timers are unref'd
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-route-')); dirs.push(d); return d; }

function mkReq(method: string, body?: string): IncomingMessage {
    let consumed = false;
    return {
        method,
        headers: {},
        on(event: string, cb: (c?: Buffer) => void) {
            if (event === 'data' && !consumed && body !== undefined) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type Res = ServerResponse & { _status: number; _body: string };
function mkRes(): Res {
    const r = {
        _status: 0, _body: '', writableEnded: false,
        writeHead(status: number) { this._status = status; return this; },
        end(b?: string) { this._body = b ?? ''; this.writableEnded = true; },
        once() { return this; },
    };
    return r as unknown as Res;
}
const json = (r: Res): Record<string, any> => JSON.parse(r._body);

const WS = 'wsA';
const PATH = '/api/nodes/recallable';

function graphWith(ids: string[]) {
    const set = new Set(ids);
    return { async getNodesByIds(q: string[]) { return new Map(q.filter((i) => set.has(i)).map((i) => [i, { id: i }])); } };
}

interface Rig {
    deps: Parameters<typeof tryRecallableRoutes>[4];
    outbox: SqliteOutboxStore;
    indexed: Set<string>;
    calls: Array<{ ws: string; ids: string[] }>;
}
function rig(opts: { vector?: unknown; lag?: { waitForRefresh: (ms: number, s?: AbortSignal) => Promise<void> } } = {}): Rig {
    const outbox = new SqliteOutboxStore(tmp());
    const indexed = new Set<string>();
    const calls: Rig['calls'] = [];
    const graphs: Record<string, ReturnType<typeof graphWith>> = { [WS]: graphWith(['a', 'b']), wsB: graphWith(['foreign']) };
    const vectors: Record<string, unknown> = {
        [WS]: { indexedIds: async (ids: string[]) => { calls.push({ ws: WS, ids }); return new Set(ids.filter((i) => indexed.has(i))); } },
        wsB: { indexedIds: async (ids: string[]) => { calls.push({ ws: 'wsB', ids }); return new Set(ids); } },
    };
    return {
        outbox, indexed, calls,
        deps: {
            deploymentMode: 'local',
            dataplane: null,
            store: { loreGraph: graphs[WS], loreVerbatim: vectors[WS] } as never,
            graphRegistry: {
                async getGraphHandle(ws: string) {
                    if (!graphs[ws]) throw new WorkspaceNotFoundError(ws, Object.keys(graphs));
                    return graphs[ws];
                },
            } as never,
            workspaceVerbatimResolver: { async getOrOpen(ws: string) { if (opts.vector !== undefined) return opts.vector; return vectors[ws]; } } as never,
            outboxStore: outbox,
            outboxLagCache: opts.lag,
        },
    };
}
async function post(deps: Rig['deps'], body: unknown, pathname = PATH): Promise<Res> {
    const res = mkRes();
    const handled = await tryRecallableRoutes(mkReq('POST', typeof body === 'string' ? body : JSON.stringify(body)), res, pathname, pathname, deps);
    assert.equal(handled, true);
    return res;
}

console.log('rate buckets');
await test('local: POST /api/nodes/recallable has its own `recallable` bucket (not generic, not exempt)', () => {
    assert.equal(classifyRequest(PATH, 'POST'), 'recallable');
    assert.equal(classifyRequest(`${PATH}?x=1`, 'POST'), 'recallable');
    assert.notEqual(classifyRequest('/api/nodes/bulk-list', 'POST'), 'recallable');
    assert.ok(buildDefaultBuckets('local')['recallable'], 'bucket config exists');
    assert.ok(buildDefaultBuckets('cloud')['recallable'], 'bucket config exists in cloud mode too');
});
await test('arcade: classified `arcade_recallable` with a config, on POST only', () => {
    assert.equal(classifyArcadeRequest(PATH, 'POST'), 'arcade_recallable');
    assert.equal(classifyArcadeRequest(PATH, 'GET'), 'generic');
    assert.ok(arcadeBucketConfigs()['arcade_recallable']);
});

console.log('\narcade allowlist + auth');
function authFailingPool() {
    return { resolve() { throw new ArcadeAuthError('unknown_token', 'nope'); }, evictToken() { /* noop */ } };
}
async function arcadeDrive(method: string, pathname: string): Promise<{ handled: boolean; res: Res }> {
    const res = mkRes();
    const handled = await tryArcadeDataRoutes(mkReq(method, '{}'), res, pathname, pathname, 'lore_at_bad', { pool: authFailingPool() as never, auditLog: {} as never });
    return { handled, res };
}
await test('POST /api/nodes/recallable is on the arcade allowlist and authenticates BEFORE any work (401)', async () => {
    const { handled, res } = await arcadeDrive('POST', PATH);
    assert.equal(handled, true, 'allowlisted: handled here, not 501 by the dispatcher');
    assert.equal(res._status, 401);
    assert.equal(json(res).code, 'auth_required');
});
await test('only POST is allowlisted; look-alike paths are not', async () => {
    assert.equal((await arcadeDrive('GET', PATH)).handled, false);
    assert.equal((await arcadeDrive('POST', `${PATH}/x`)).handled, false);
    assert.equal((await arcadeDrive('POST', '/api/nodes/recallable2')).handled, false);
});

console.log('\nrequest validation');
await test('other paths / methods are not handled', async () => {
    const r = rig();
    const res = mkRes();
    assert.equal(await tryRecallableRoutes(mkReq('GET'), res, PATH, PATH, r.deps), false);
    assert.equal(await tryRecallableRoutes(mkReq('POST', '{}'), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', r.deps), false);
});
await test('workspace is required (400 workspace_required); "*" is refused (400)', async () => {
    const r = rig();
    const a = await post(r.deps, { ids: ['a'] });
    assert.equal(a._status, 400);
    assert.equal(json(a).code, 'workspace_required');
    const b = await post(r.deps, { workspace: '*', ids: ['a'] });
    assert.equal(b._status, 400);
    assert.equal(json(b).code, 'recallable_invalid_request');
});
await test('exactly one of ids / allBeforeNow', async () => {
    const r = rig();
    for (const body of [
        { workspace: WS },
        { workspace: WS, ids: ['a'], allBeforeNow: true },
        { workspace: WS, allBeforeNow: 'yes' },
        { workspace: WS, ids: [] },
        { workspace: WS, ids: 'a' },
        { workspace: WS, ids: ['a', ''] },
        { workspace: WS, ids: ['a', 5] },
        { workspace: WS, ids: ['a'], timeoutMs: -1 },
        { workspace: WS, ids: ['a'], timeoutMs: 'soon' },
    ]) {
        const res = await post(r.deps, body);
        assert.equal(res._status, 400, JSON.stringify(body));
        assert.equal(json(res).code, 'recallable_invalid_request', JSON.stringify(body));
    }
    const bad = await post(r.deps, '{not json');
    assert.equal(bad._status, 400);
});
await test('over the id cap => 400 recallable_too_many_ids carrying max + received; at the cap is accepted', async () => {
    const r = rig();
    process.env['LORE_RECALLABLE_MAX_IDS'] = '3';
    try {
        const over = await post(r.deps, { workspace: WS, ids: ['a', 'b', 'c', 'd'] });
        assert.equal(over._status, 400);
        const b = json(over);
        assert.equal(b.code, 'recallable_too_many_ids');
        assert.equal(b.max, 3);
        assert.equal(b.received, 4);
        assert.equal(r.calls.length, 0, 'rejected before any index work');
        const atCap = await post(r.deps, { workspace: WS, ids: ['a', 'b', 'x'], timeoutMs: 0 });
        assert.equal(atCap._status, 200);
    } finally { delete process.env['LORE_RECALLABLE_MAX_IDS']; }
});
await test('env knobs: defaults, overrides, hard max on ids', () => {
    for (const k of ['LORE_RECALLABLE_TIMEOUT_MS', 'LORE_RECALLABLE_MAX_TIMEOUT_MS', 'LORE_RECALLABLE_MAX_IDS']) delete process.env[k];
    assert.equal(recallableDefaultTimeoutMs(), 10_000);
    assert.equal(recallableMaxTimeoutMs(), 60_000);
    assert.equal(recallableMaxIds(), 500);
    process.env['LORE_RECALLABLE_TIMEOUT_MS'] = '2500';
    process.env['LORE_RECALLABLE_MAX_TIMEOUT_MS'] = '9000';
    process.env['LORE_RECALLABLE_MAX_IDS'] = '99999';
    assert.equal(recallableDefaultTimeoutMs(), 2500);
    assert.equal(recallableMaxTimeoutMs(), 9000);
    assert.equal(recallableMaxIds(), 1000, 'hard maximum');
    process.env['LORE_RECALLABLE_MAX_IDS'] = 'banana';
    assert.equal(recallableMaxIds(), 500, 'garbage falls back to the default');
    for (const k of ['LORE_RECALLABLE_TIMEOUT_MS', 'LORE_RECALLABLE_MAX_TIMEOUT_MS', 'LORE_RECALLABLE_MAX_IDS']) delete process.env[k];
});
await test('cloud mode with no dataplane is refused before any work (auth gate wired)', async () => {
    const r = rig();
    const res = mkRes();
    await tryRecallableRoutes(mkReq('POST', JSON.stringify({ workspace: WS, ids: ['a'] })), res, PATH, PATH, { ...r.deps, deploymentMode: 'cloud', dataplane: null });
    assert.equal(res._status, 403);
    assert.equal(r.calls.length, 0);
});

console.log('\nbehaviour');
await test('pending then recallable: the same request returns as soon as the index answers', async () => {
    const r = rig();
    const entry = await recordHotWrite(r.outbox, { workspace: WS, operationKind: 'verbatim.upsert', payload: { id: 'lore:a' }, operation: 'verbatim.upsert' });
    const early = await post(r.deps, { workspace: WS, ids: ['a'], timeoutMs: 0 });
    assert.equal(early._status, 200);
    assert.equal(json(early).ready, false);
    assert.deepEqual(json(early).ids, [{ id: 'a', status: 'pending', reason: 'queued' }]);
    // Replicated first, then the index catches up (the 0.15-1 s lag the live check measured).
    setTimeout(() => { void r.outbox.markEntryStatus!(entry.id, 'replicated'); }, 40);
    setTimeout(() => r.indexed.add('lore:a'), 200);
    const late = await post(r.deps, { workspace: WS, ids: ['a'], timeoutMs: 5000 });
    const b = json(late);
    assert.equal(late._status, 200);
    assert.equal(b.ready, true);
    assert.equal(b.workspace, WS);
    assert.deepEqual(b.ids, [{ id: 'a', status: 'recallable' }]);
});
await test('timeout is a 200 status, never an error; timeoutMs is clamped to LORE_RECALLABLE_MAX_TIMEOUT_MS', async () => {
    const r = rig();
    await recordHotWrite(r.outbox, { workspace: WS, operationKind: 'verbatim.upsert', payload: { id: 'lore:b' }, operation: 'verbatim.upsert' });
    process.env['LORE_RECALLABLE_MAX_TIMEOUT_MS'] = '300';
    try {
        const t0 = Date.now();
        const res = await post(r.deps, { workspace: WS, ids: ['b'], timeoutMs: 3_600_000 });
        const waited = Date.now() - t0;
        assert.equal(res._status, 200);
        const b = json(res);
        assert.equal(b.ready, false);
        assert.equal(b.timedOut, true);
        assert.equal(b.ids[0].status, 'pending');
        assert.ok(waited < 3000, `clamped (waited ${waited}ms)`);
    } finally { delete process.env['LORE_RECALLABLE_MAX_TIMEOUT_MS']; }
});
await test('workspace binding: ids resolve only in the requested workspace; another workspace\'s id is not_found', async () => {
    const r = rig();
    r.indexed.add('lore:a');
    const res = await post(r.deps, { workspace: WS, ids: ['a', 'foreign'], timeoutMs: 100 });
    const by = new Map<string, string>(json(res).ids.map((s: { id: string; status: string }) => [s.id, s.status]));
    assert.equal(by.get('a'), 'recallable');
    assert.equal(by.get('foreign'), 'not_found', 'exists in wsB, indistinguishable from missing in wsA');
    assert.ok(r.calls.every((c) => c.ws === WS), 'wsB\'s index was never consulted');
    // Asking wsB for its own id works - the binding follows the request.
    const own = await post(r.deps, { workspace: 'wsB', ids: ['foreign'], timeoutMs: 100 });
    assert.equal(json(own).ids[0].status, 'recallable');
});
await test('unknown workspace => 404 workspace_not_found', async () => {
    const r = rig();
    const res = await post(r.deps, { workspace: 'nope', ids: ['a'] });
    assert.equal(res._status, 404);
    assert.equal(json(res).code, 'workspace_not_found');
});
await test('a token bound to another workspace is refused (403) and nothing is read', async () => {
    const r = rig();
    const P: Principal = { kind: 'app', workspace: 'wsB', scopes: ['read'], label: 't', allowedWorkspaces: ['wsB'] };
    const res = mkRes();
    await runWithPrincipal(P, () => tryRecallableRoutes(mkReq('POST', JSON.stringify({ workspace: WS, ids: ['a'] })), res, PATH, PATH, r.deps));
    assert.equal(res._status, 403);
    assert.equal(r.calls.length, 0);
});
await test('all-before-now form over HTTP: ready once the snapshot backlog is drained', async () => {
    const r = rig();
    const e = await recordHotWrite(r.outbox, { workspace: WS, operationKind: 'verbatim.upsert', payload: { id: 'lore:a' }, operation: 'verbatim.upsert' });
    setTimeout(() => { void r.outbox.markEntryStatus!(e.id, 'replicated'); r.indexed.add('lore:a'); }, 80);
    const res = await post(r.deps, { workspace: WS, allBeforeNow: true, timeoutMs: 5000 });
    const b = json(res);
    assert.equal(res._status, 200);
    assert.equal(b.mode, 'all_before_now');
    assert.equal(b.ready, true);
    assert.equal(b.queuedRemaining, 0);
});
await test('waits on the replicator tick (outboxLagCache.waitForRefresh) when one is wired', async () => {
    let waits = 0;
    const r = rig({ lag: { waitForRefresh: async (ms) => { waits++; await new Promise((x) => setTimeout(x, Math.min(ms, 20))); } } });
    await recordHotWrite(r.outbox, { workspace: WS, operationKind: 'verbatim.upsert', payload: { id: 'lore:a' }, operation: 'verbatim.upsert' });
    const res = await post(r.deps, { workspace: WS, ids: ['a'], timeoutMs: 400 });
    assert.equal(json(res).timedOut, true);
    assert.ok(waits >= 1, 'parked on the tick instead of its own timer');
});
await test('engine with no embedding-presence read => 501 recallable_not_supported (explicit, immediate)', async () => {
    const r = rig({ vector: {} });
    const t0 = Date.now();
    const res = await post(r.deps, { workspace: WS, ids: ['a'], timeoutMs: 60_000 });
    assert.equal(res._status, 501);
    assert.equal(json(res).code, 'recallable_not_supported');
    assert.ok(Date.now() - t0 < 1000);
});

clearInterval(keepAlive);
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
