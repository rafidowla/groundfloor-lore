#!/usr/bin/env tsx
/**
 * test/ready-probe-unit.ts - Lore 3.35.0 (e): /ready for every mode.
 *
 *   A  neutral machinery (readiness.ts): ttl cache, in-flight dedupe, timeout
 *      without stacking, recovery, classifier, env precedence
 *   B  local provider: a real SqliteGraph in a temp dir; an injected failing read
 *   C  the route on the local/cloud listener: 200/503, anonymous vs operator body,
 *      headers, `mode` is the real mode, /health unaffected
 *   D  security wiring: rate-limit exemption, public path, Host/Origin policy
 *      identical to /health, tenant-header exemption, env allowlist
 *   E  Dataplane provider against a tiny HTTP mock: 200 / 401 / refused / hang,
 *      and the probe touches nothing but GET /connectors
 *   F  arcade compatibility: the arcade /ready body + headers are identical to a
 *      verbatim copy of the 3.34 inline implementation
 *
 * Pure unit test: no daemon, no :3847, no real Dataplane, no ArcadeDB.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createReadiness, classifyReadinessError, readinessTimingsFromEnv } from '../packages/lore/src/mcp/readiness.js';
import { createModeReadiness, readinessForStore, READY_PROBE_NODE_ID } from '../packages/lore/src/mcp/readinessProviders.js';
import { createArcadeReadinessFromEnv, createArcadeReadiness } from '../packages/lore/src/mcp/arcadeReadiness.js';
import { arcadeDispatch, isOperatorBearer } from '../packages/lore/src/mcp/arcadeBoot.js';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { writeJson } from '../packages/lore/src/mcp/http/helpers.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { RateLimiter, RATE_LIMIT_EXEMPT_PATHS, classifyRequest, buildDefaultBuckets } from '../packages/lore/src/security/rateLimit.js';
import { validateRequest, requiresBearerAuth } from '../packages/lore/src/security/httpAuth.js';
import { buildArcadeHostPolicy } from '../packages/lore/src/security/arcadeHostPolicy.js';
import { arcadeBucketConfigs } from '../packages/lore/src/security/arcadeRateClassifier.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import { asLoreDataplaneSdk } from '../packages/lore/src/engines/dataplaneSdkCompat.js';
import { VERSION } from '../packages/lore/src/version.js';
import { testRegistry } from './helpers/workspace-registry.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).message}`); }
}
// The production timeout timer is unref'd (a server keeps the loop alive); a bare test has no server.
const keepAlive = setInterval(() => {}, 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ── fakes ────────────────────────────────────────────────────────────────── */

type FakeRes = ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
function fakeRes(): FakeRes {
    const r = {
        _status: 0, _body: '', _headers: {} as Record<string, string>, headersSent: false,
        setHeader(k: string, v: string) { this._headers[k.toLowerCase()] = String(v); },
        writeHead(status: number, h?: Record<string, string>) {
            this._status = status;
            for (const [k, v] of Object.entries(h ?? {})) this._headers[k.toLowerCase()] = v;
            return this;
        },
        end(b?: string) { this._body = b ?? ''; },
    };
    return r as unknown as FakeRes;
}
function reqOf(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
    return { method, url, headers, on() { return this; } } as unknown as IncomingMessage;
}
const principal = (kind: Principal['kind']): Principal => ({ kind, workspace: 'default', scopes: ['read'], label: kind });

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ═════════════ A - neutral machinery ═════════════ */
console.log('A neutral machinery');

await test('ttl cache: one probe for many checks inside the ttl', async () => {
    let calls = 0;
    const r = createReadiness({ probe: async () => { calls++; }, ttlMs: 60_000, timeoutMs: 500 });
    for (let i = 0; i < 5; i++) assert.equal((await r.check()).ready, true);
    assert.equal(calls, 1);
});

await test('in-flight dedupe: concurrent callers share one probe', async () => {
    let calls = 0;
    const r = createReadiness({ probe: async () => { calls++; await sleep(30); }, ttlMs: 60_000, timeoutMs: 500 });
    const all = await Promise.all(Array.from({ length: 25 }, () => r.check()));
    assert.equal(calls, 1);
    assert.ok(all.every((x) => x.ready));
});

await test('timeout is reported promptly, a hung probe never stacks a second one, recovery needs no restart', async () => {
    let calls = 0;
    let release!: () => void;
    const hung = new Promise<void>((res) => { release = res; });
    const r = createReadiness({ probe: () => { calls++; return hung; }, ttlMs: 5, timeoutMs: 20 });
    const t0 = Date.now();
    const first = await r.check();
    assert.equal(first.reason, 'timeout');
    assert.ok(Date.now() - t0 < 200);
    for (let i = 0; i < 5; i++) { await sleep(10); assert.equal((await r.check()).ready, false); }
    assert.equal(calls, 1, 'one hung probe, never a pile of them');
    release();
    await sleep(20);
    assert.equal((await r.check()).ready, true);
    assert.equal(calls, 2);
});

await test('failure then recovery after the ttl, with no restart', async () => {
    let up = false;
    const r = createReadiness({ probe: async () => { if (!up) throw new Error('boom'); }, ttlMs: 20, timeoutMs: 500 });
    assert.equal((await r.check()).ready, false);
    up = true;
    assert.equal((await r.check()).ready, false, 'cached failure inside the ttl');
    await sleep(40);
    assert.equal((await r.check()).ready, true);
});

await test('neutral classifier: status wins, then wording, else unreachable', () => {
    assert.equal(classifyReadinessError(Object.assign(new Error('x'), { statusCode: 401 })).reason, 'auth_failed');
    assert.equal(classifyReadinessError(Object.assign(new Error('x'), { status: 403 })).reason, 'auth_failed');
    assert.equal(classifyReadinessError(Object.assign(new Error('x'), { statusCode: 503 })).reason, 'unavailable');
    assert.equal(classifyReadinessError(new Error('request timed out')).reason, 'timeout');
    assert.equal(classifyReadinessError(new Error('connect ECONNREFUSED 127.0.0.1:1')).reason, 'unreachable');
    assert.equal(classifyReadinessError(new Error('x'.repeat(500))).detail.length, 200);
});

await test('env: generic LORE_READY_* applies; the arcade-specific names win; junk falls through', () => {
    assert.deepEqual(readinessTimingsFromEnv({}), { timeoutMs: 2000, ttlMs: 2000 });
    assert.deepEqual(readinessTimingsFromEnv({ LORE_READY_TIMEOUT_MS: '700', LORE_READY_CACHE_MS: '900' } as NodeJS.ProcessEnv), { timeoutMs: 700, ttlMs: 900 });
    const spec = { timeout: 'LORE_ARCADE_READY_TIMEOUT_MS', cache: 'LORE_ARCADE_READY_CACHE_MS' };
    assert.deepEqual(
        readinessTimingsFromEnv({ LORE_READY_TIMEOUT_MS: '700', LORE_ARCADE_READY_TIMEOUT_MS: '300', LORE_READY_CACHE_MS: '900', LORE_ARCADE_READY_CACHE_MS: '400' } as NodeJS.ProcessEnv, spec),
        { timeoutMs: 300, ttlMs: 400 },
    );
    assert.deepEqual(
        readinessTimingsFromEnv({ LORE_READY_TIMEOUT_MS: '700', LORE_ARCADE_READY_TIMEOUT_MS: 'abc', LORE_ARCADE_READY_CACHE_MS: '-5' } as NodeJS.ProcessEnv, spec),
        { timeoutMs: 700, ttlMs: 2000 },
    );
});

await test('arcade from-env factory still builds from the old names and from the generic ones (no probe is run here)', () => {
    for (const env of [
        { LORE_ARCADE_READY_CACHE_MS: '60000', LORE_ARCADE_READY_TIMEOUT_MS: '500' },
        { LORE_READY_CACHE_MS: '60000', LORE_READY_TIMEOUT_MS: '500' },
        {},
    ]) assert.equal(typeof createArcadeReadinessFromEnv(env as NodeJS.ProcessEnv).check, 'function');
});

/* ═════════════ B - local provider ═════════════ */
console.log('B local provider');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ready-unit-'));
fs.mkdirSync(path.join(tmp, 'g'), { recursive: true });
const sqlite = new SqliteGraph(path.join(tmp, 'g'), { workspaceId: 'ready-unit' });
await sqlite.initialize();

try {
    await test('ready on a healthy graph store; the probe is a point read of a reserved id and creates nothing', async () => {
        const r = createModeReadiness({ graph: () => sqlite as any, mode: 'local', env: {} as NodeJS.ProcessEnv });
        const res = await r.check();
        assert.equal(res.ready, true, JSON.stringify(res));
        assert.equal(await sqlite.getNode(READY_PROBE_NODE_ID), null, 'the probe wrote nothing');
    });

    await test('not_ready (unavailable) when the graph read throws; recovers when it stops throwing', async () => {
        let broken = true;
        const graph = {
            getNodesByIds: async (ids: string[]) => { if (broken) throw new Error('SQLITE_IOERR: disk I/O error'); return sqlite.getNodesByIds(ids); },
        };
        const r = createModeReadiness({ graph: () => graph, mode: 'local', env: { LORE_READY_CACHE_MS: '10', LORE_READY_TIMEOUT_MS: '500' } as NodeJS.ProcessEnv });
        const down = await r.check();
        assert.equal(down.ready, false);
        assert.equal(down.reason, 'unavailable');
        assert.match(down.detail ?? '', /disk I\/O/);
        broken = false;
        await sleep(30);
        assert.equal((await r.check()).ready, true);
    });

    await test('a graph read that hangs answers not_ready (timeout) promptly', async () => {
        const graph = { getNodesByIds: () => new Promise<never>(() => { /* never settles */ }) };
        const r = createModeReadiness({ graph: () => graph, mode: 'local', env: { LORE_READY_TIMEOUT_MS: '40' } as NodeJS.ProcessEnv });
        const t0 = Date.now();
        const res = await r.check();
        assert.equal(res.reason, 'timeout');
        assert.ok(Date.now() - t0 < 300);
    });

    await test('the probe sees a swapped graph (re-read on every probe, not captured at creation)', async () => {
        const store: { loreGraph: unknown } = { loreGraph: { getNodesByIds: async () => { throw new Error('old graph broken'); } } };
        const r = createModeReadiness({ graph: () => store.loreGraph as any, mode: 'local', env: { LORE_READY_CACHE_MS: '10' } as NodeJS.ProcessEnv });
        assert.equal((await r.check()).ready, false);
        store.loreGraph = sqlite;
        await sleep(30);
        assert.equal((await r.check()).ready, true);
    });

    await test('readinessForStore: one shared readiness per store bundle, separate across bundles', () => {
        const a: any = { loreGraph: sqlite };
        const b: any = { loreGraph: sqlite };
        assert.equal(readinessForStore(a, 'local'), readinessForStore(a, 'local'));
        assert.notEqual(readinessForStore(a, 'local'), readinessForStore(b, 'local'));
    });

    /* ═════════════ C - the route ═════════════ */
    console.log('C route on the local/cloud listener');

    const deps = (over: Record<string, unknown> = {}): any => ({
        store: { loreGraph: sqlite },
        configManager: {},
        activeSessions: new Map(),
        deploymentMode: 'local',
        getDataplaneState: () => 'offline',
        rateLimiter: new RateLimiter('local'),
        ...over,
    });
    const get = async (url: string, d: any, p?: Principal, method = 'GET'): Promise<FakeRes> => {
        const res = fakeRes();
        const run = () => tryDiagnosticRoutes(reqOf(method, url), res, url, url, d);
        assert.equal(await (p ? runWithPrincipal(p, run) : run()), true, `${url} must be claimed by the diagnostic routes`);
        return res;
    };
    const failing = (over: Record<string, unknown> = {}): any => deps({
        readiness: createReadiness({ probe: async () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); }, ttlMs: 10, timeoutMs: 100, classify: (e) => ({ reason: 'unavailable', detail: (e as Error).message }) }),
        ...over,
    });

    await test('/ready and /api/ready: 200 on a healthy store; anonymous body is exactly {status, version, mode}', async () => {
        for (const url of ['/ready', '/api/ready']) {
            const res = await get(url, deps());
            assert.equal(res._status, 200, url);
            assert.deepEqual(JSON.parse(res._body), { status: 'ready', version: VERSION, mode: 'local' });
            assert.equal(res._headers['cache-control'], 'no-store');
            assert.equal(res._headers['retry-after'], undefined);
            assert.equal(res._headers['content-type'], 'application/json');
        }
    });

    await test('503 + Retry-After: 2 when the graph read fails; anonymous learns no reason or detail', async () => {
        const res = await get('/ready', failing());
        assert.equal(res._status, 503);
        assert.deepEqual(JSON.parse(res._body), { status: 'not_ready', version: VERSION, mode: 'local' });
        assert.equal(res._headers['retry-after'], '2');
        assert.equal(res._headers['cache-control'], 'no-store');
        assert.ok(!res._body.includes('SQLITE_CORRUPT'));
    });

    await test('operator (bootstrap token or shared secret) also gets reason, detail, latencyMs, checkedAgeMs', async () => {
        for (const kind of ['bootstrap', 'shared-secret'] as const) {
            const res = await get('/api/ready', failing(), principal(kind));
            assert.equal(res._status, 503, kind);
            const body = JSON.parse(res._body);
            assert.equal(body.reason, 'unavailable');
            assert.match(body.detail, /SQLITE_CORRUPT/);
            assert.equal(typeof body.latencyMs, 'number');
            assert.equal(typeof body.checkedAgeMs, 'number');
        }
        const ok = await get('/ready', deps(), principal('bootstrap'));
        const okBody = JSON.parse(ok._body);
        assert.equal(okBody.status, 'ready');
        assert.equal('reason' in okBody, false, 'no reason on a ready answer');
        assert.equal(typeof okBody.latencyMs, 'number');
    });

    await test('a tenant/app token is NOT an operator: it sees the anonymous body', async () => {
        const res = await get('/ready', failing(), principal('app'));
        assert.deepEqual(Object.keys(JSON.parse(res._body)).sort(), ['mode', 'status', 'version']);
    });

    await test('`mode` is the real mode (cloud listener reports cloud)', async () => {
        const res = await get('/ready', deps({ deploymentMode: 'cloud', readiness: createReadiness({ probe: async () => {} }) }));
        assert.equal(JSON.parse(res._body).mode, 'cloud');
    });

    await test('/health is liveness: still 200 with a broken backend; /ready tracks recovery without a restart', async () => {
        let broken = true;
        const readiness = createReadiness({ probe: async () => { if (broken) throw new Error('down'); }, ttlMs: 10, timeoutMs: 100 });
        const d = deps({ readiness });
        assert.equal((await get('/ready', d))._status, 503);
        assert.equal((await get('/health', d))._status, 200);
        broken = false;
        await sleep(30);
        assert.equal((await get('/ready', d))._status, 200);
    });

    await test('a polling storm costs one probe per ttl through the route', async () => {
        let calls = 0;
        const d = deps({ readiness: createReadiness({ probe: async () => { calls++; }, ttlMs: 60_000 }) });
        await Promise.all(Array.from({ length: 100 }, () => get('/ready', d)));
        assert.equal(calls, 1);
    });

    await test('HEAD is answered too (same as the arcade listener)', async () => {
        const res = await get('/ready', deps(), undefined, 'HEAD');
        assert.equal(res._status, 200);
    });

    await test('the real wiring (no injected readiness): a store whose graph throws gives 503, a healthy one 200', async () => {
        const bad = deps({ store: { loreGraph: { getNodesByIds: async () => { throw new Error('graph closed'); } } } });
        assert.equal((await get('/ready', bad))._status, 503);
        assert.equal((await get('/ready', deps()))._status, 200);
    });

    /* ═════════════ D - security wiring ═════════════ */
    console.log('D security wiring');

    await test('rate limiter: /ready and /api/ready are exempt exactly like /health (never debited)', () => {
        for (const p of ['/health', '/api/health', '/ready', '/api/ready']) {
            assert.ok(RATE_LIMIT_EXEMPT_PATHS.includes(p), p);
            assert.equal(classifyRequest(p, 'GET'), null, p);
            assert.equal(classifyRequest(`${p}?x=1`, 'GET'), null, `${p}?x=1`);
        }
        assert.notEqual(classifyRequest('/api/recall', 'GET'), null);
    });

    await test('no Bearer needed for /ready or /api/ready (public, like /health)', () => {
        for (const p of ['/ready', '/api/ready', '/health', '/api/health']) assert.equal(requiresBearerAuth(p), false, p);
        assert.equal(requiresBearerAuth('/api/recall'), true);
    });

    await test('Host and Origin policy for /ready is the same as /health, over a matrix of headers', () => {
        const cfg = { token: 'a'.repeat(64), port: 3972 };
        const hosts = ['127.0.0.1:3972', 'localhost:3972', '[::1]:3972', 'evil.example:3972', '127.0.0.1:1', 'localhost', undefined];
        const origins = [undefined, 'http://localhost:3972', 'https://evil.example', 'file://x'];
        let denied = 0;
        for (const host of hosts) for (const origin of origins) {
            const headers: Record<string, string> = {};
            if (host) headers['host'] = host;
            if (origin) headers['origin'] = origin;
            const ref = validateRequest(reqOf('GET', '/health', headers), cfg);
            for (const p of ['/ready', '/api/ready']) {
                assert.deepEqual(validateRequest(reqOf('GET', p, headers), cfg), ref, `${p} host=${host} origin=${origin}`);
            }
            if (!ref.ok) denied++;
        }
        assert.ok(denied > 0, 'the matrix must include refused combinations');
        const evil: any = validateRequest(reqOf('GET', '/ready', { host: 'evil.example:3972' }), cfg);
        assert.equal(evil.ok, false);
        assert.equal(evil.status, 403);
    });

    await test('cloud tenant-header gate exempts /api/ready like /api/health (source pin: both lists)', () => {
        const src = fs.readFileSync(new URL('../packages/lore/src/mcp/http/middleware.ts', import.meta.url), 'utf-8');
        const exempt = src.match(/pathname === '\/api\/health' \|\|\s*\n\s*pathname === '\/api\/ready' \|\|/g) ?? [];
        assert.equal(exempt.length, 2, 'both the cloud and the local header-exempt lists must name /api/ready');
    });

    await test('LORE_READY_* are on the env allowlist (they would be scrubbed otherwise)', () => {
        const src = fs.readFileSync(new URL('../packages/lore/src/security/envScrub.ts', import.meta.url), 'utf-8');
        for (const k of ['LORE_READY_CACHE_MS', 'LORE_READY_TIMEOUT_MS', 'LORE_ARCADE_READY_CACHE_MS', 'LORE_ARCADE_READY_TIMEOUT_MS']) {
            assert.ok(src.includes(`'${k}'`), k);
        }
    });

    /* ═════════════ E - Dataplane provider ═════════════ */
    console.log('E Dataplane provider (mock server)');

    interface Seen { method: string; url: string; auth: string }
    async function startConnectorsMock(mode: '200' | '401' | 'hang'): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
        const seen: Seen[] = [];
        const sockets = new Set<net.Socket>();
        const srv = http.createServer((req, res) => {
            seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers['authorization'] ?? '') });
            if (mode === 'hang') return;
            if (mode === '401') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: { code: 'ERR_UNAUTHORIZED', message: 'Invalid API key' } }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: { connectors: [{ name: 'sqlite', version: '1', capabilities: [] }] } }));
        });
        srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
        const port = (srv.address() as net.AddressInfo).port;
        return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }) };
    }

    /** A raw client shaped like the real SDK for the one call under test: listConnectors. */
    const rawClient = (baseUrl: string, apiKey: string): any => ({
        listConnectors: async () => {
            const res = await fetch(`${baseUrl}/connectors`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) });
            const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
            if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `HTTP ${res.status}`), { name: 'GroundfloorError', statusCode: res.status });
            return json;
        },
    });
    const cloudGraph = (client: any) => new DataplaneGraph({
        client: asLoreDataplaneSdk(client) as any,
        dataplaneWorkspaceId: 'dp-ws', orgId: 'org', workspaceRegistry: testRegistry('w') as any,
    });
    const cloudReadiness = (g: DataplaneGraph, timeoutMs = 300) =>
        createModeReadiness({ graph: () => g as any, mode: 'cloud', env: { LORE_READY_TIMEOUT_MS: String(timeoutMs), LORE_READY_CACHE_MS: '10' } as NodeJS.ProcessEnv });

    await test('200: ready; the only request is an authenticated GET /connectors (no data write, no schema push)', async () => {
        const m = await startConnectorsMock('200');
        try {
            const res = await cloudReadiness(cloudGraph(rawClient(m.url, 'real-key'))).check();
            assert.equal(res.ready, true, JSON.stringify(res));
            assert.deepEqual(m.seen, [{ method: 'GET', url: '/connectors', auth: 'Bearer real-key' }]);
        } finally { await m.close(); }
    });

    await test('401 from the Dataplane -> not_ready, auth_failed', async () => {
        const m = await startConnectorsMock('401');
        try {
            const res = await cloudReadiness(cloudGraph(rawClient(m.url, 'bad-key'))).check();
            assert.equal(res.ready, false);
            assert.equal(res.reason, 'auth_failed');
            assert.match(res.detail ?? '', /Invalid API key/);
        } finally { await m.close(); }
    });

    await test('connection refused -> not_ready, unreachable', async () => {
        const m = await startConnectorsMock('200');
        const url = m.url;
        await m.close();
        const res = await cloudReadiness(cloudGraph(rawClient(url, 'k'))).check();
        assert.equal(res.ready, false);
        assert.equal(res.reason, 'unreachable');
    });

    await test('hang -> not_ready, timeout, within the deadline, and no second request is stacked', async () => {
        const m = await startConnectorsMock('hang');
        try {
            const r = cloudReadiness(cloudGraph(rawClient(m.url, 'k')), 80);
            const t0 = Date.now();
            const res = await r.check();
            assert.equal(res.reason, 'timeout');
            assert.ok(Date.now() - t0 < 400);
            for (let i = 0; i < 4; i++) { await sleep(20); await r.check(); }
            assert.equal(m.seen.length, 1, 'a hung Dataplane gets one request, not one per poll');
        } finally { await m.close(); }
    });

    await test('the SDK facade forwards listConnectors only when the build has it; otherwise the probe says so', async () => {
        assert.equal(typeof (asLoreDataplaneSdk({ listConnectors: async () => [] } as any) as any).listConnectors, 'function');
        assert.equal((asLoreDataplaneSdk({} as any) as any).listConnectors, undefined);
        const res = await cloudReadiness(cloudGraph({})).check();
        assert.equal(res.ready, false);
        assert.match(res.detail ?? '', /no listConnectors/);
    });

    await test('a credential rebuild (adoptConnectionFrom) is followed: the probe uses the NEW client', async () => {
        const bad = await startConnectorsMock('401');
        const good = await startConnectorsMock('200');
        try {
            const g = cloudGraph(rawClient(bad.url, 'old'));
            const r = cloudReadiness(g);
            assert.equal((await r.check()).reason, 'auth_failed');
            g.adoptConnectionFrom(cloudGraph(rawClient(good.url, 'new')));
            await sleep(30);
            assert.equal((await r.check()).ready, true);
        } finally { await bad.close(); await good.close(); }
    });
} finally {
    await sqlite.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
}

/* ═════════════ F - arcade compatibility ═════════════ */
console.log('F arcade compatibility');

/** Verbatim copy of the 3.34.0 inline /ready implementation in arcadeBoot.ts - the golden reference. */
function legacyArcadeReady(res: ServerResponse, r: { ready: boolean; reason?: string; detail?: string; latencyMs: number; checkedAt: number }, operator: boolean): void {
    const base = { status: r.ready ? 'ready' : 'not_ready', version: VERSION, mode: 'arcade' };
    const body = operator
        ? { ...base, ...(r.reason ? { reason: r.reason, detail: r.detail } : {}), latencyMs: r.latencyMs, checkedAgeMs: Math.max(0, Date.now() - r.checkedAt) }
        : base;
    if (!r.ready) res.setHeader('Retry-After', '2');
    res.setHeader('Cache-Control', 'no-store');
    writeJson(res, r.ready ? 200 : 503, body);
}

const OP = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);
function arcadeDeps(probe: () => Promise<void>): any {
    return {
        authToken: OP, sharedSecret: SECRET, auditLog: {},
        pool: new Proxy({}, { get() { throw new Error('POOL_TOUCHED'); } }),
        outboxStore: {}, outboxLagCache: {},
        limiter: new RateLimiter('cloud', { ...buildDefaultBuckets('cloud'), ...arcadeBucketConfigs() }),
        hostPolicy: buildArcadeHostPolicy({ port: 3847, env: {} as NodeJS.ProcessEnv }),
        readiness: createArcadeReadiness({ probe, ttlMs: 10_000, timeoutMs: 100 }),
    };
}

/** Timing fields vary run to run; everything else must match exactly. */
const stable = (body: string): string => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(body)).filter(([k]) => k !== 'latencyMs' && k !== 'checkedAgeMs')));

for (const [label, fail, auth] of [
    ['ready, anonymous', false, undefined],
    ['ready, operator bearer', false, OP],
    ['not ready (unreachable), anonymous', true, undefined],
    ['not ready (unreachable), operator bearer', true, OP],
    ['not ready, shared-secret bearer', true, SECRET],
] as Array<[string, boolean, string | undefined]>) {
    await test(`arcade /ready identical to the 3.34 implementation: ${label}`, async () => {
        const deps = arcadeDeps(async () => { if (fail) throw new Error('connect ECONNREFUSED 127.0.0.1:2480'); });
        const headers: Record<string, string> = { host: '127.0.0.1:3847' };
        if (auth) headers['authorization'] = `Bearer ${auth}`;
        const res = fakeRes();
        await arcadeDispatch(reqOf('GET', '/ready', headers), res, deps);
        const r = await deps.readiness.check();
        const golden = fakeRes();
        legacyArcadeReady(golden, r, isOperatorBearer(reqOf('GET', '/ready', headers), OP, SECRET));
        assert.equal(res._status, golden._status);
        assert.deepEqual(res._headers, golden._headers);
        assert.equal(stable(res._body), stable(golden._body));
        assert.deepEqual(Object.keys(JSON.parse(res._body)), Object.keys(JSON.parse(golden._body)), 'key order is part of the wire shape');
    });
}

await test('arcade /ready literal snapshot (3.34 wire shape)', async () => {
    const down = arcadeDeps(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:2480'); });
    const anon = fakeRes();
    await arcadeDispatch(reqOf('GET', '/ready', { host: '127.0.0.1:3847' }), anon, down);
    assert.equal(anon._status, 503);
    assert.equal(anon._body, JSON.stringify({ status: 'not_ready', version: VERSION, mode: 'arcade' }));
    assert.deepEqual(anon._headers, { 'retry-after': '2', 'cache-control': 'no-store', 'content-type': 'application/json' });

    const op = fakeRes();
    await arcadeDispatch(reqOf('GET', '/api/ready', { host: '127.0.0.1:3847', authorization: `Bearer ${OP}` }), op, down);
    const b = JSON.parse(op._body);
    assert.deepEqual(Object.keys(b), ['status', 'version', 'mode', 'reason', 'detail', 'latencyMs', 'checkedAgeMs']);
    assert.equal(b.reason, 'unreachable');

    const up = arcadeDeps(async () => {});
    const ok = fakeRes();
    await arcadeDispatch(reqOf('GET', '/ready', { host: '127.0.0.1:3847' }), ok, up);
    assert.equal(ok._status, 200);
    assert.equal(ok._body, JSON.stringify({ status: 'ready', version: VERSION, mode: 'arcade' }));
    assert.deepEqual(ok._headers, { 'cache-control': 'no-store', 'content-type': 'application/json' });
});

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
