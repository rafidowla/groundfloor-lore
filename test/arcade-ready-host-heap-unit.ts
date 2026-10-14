#!/usr/bin/env tsx
/**
 * test/arcade-ready-host-heap-unit.ts — Lore 3.34.0 slice 3 (Nokshi M5, M6, M4).
 *
 *   M5  GET /ready (readiness) vs /health (liveness): cached, deduplicated,
 *       timeout-bounded probe; exempt from the rate limiter; never 501.
 *   M6  Host-header allowlist on the arcade listener, applied to every route.
 *   M4  arcade recall projection (default on, with fallback) and the paged
 *       dumpAll (no unbounded embedding SELECT).
 *
 * Pure unit test: fake probe / fake ArcadeHttp transport. No live ArcadeDB, no
 * network, no daemon port.
 */

import { strict as assert } from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arcadeDispatch } from '../packages/lore/src/mcp/arcadeBoot.js';
import { buildArcadeHostPolicy, parseHostHeader } from '../packages/lore/src/security/arcadeHostPolicy.js';
import {
  classifyProbeError,
  createArcadeReadiness,
} from '../packages/lore/src/mcp/arcadeReadiness.js';
import { classifyArcadeRequest } from '../packages/lore/src/security/arcadeRateClassifier.js';
import { RateLimiter, buildDefaultBuckets } from '../packages/lore/src/security/rateLimit.js';
import { arcadeBucketConfigs } from '../packages/lore/src/security/arcadeRateClassifier.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ArcadeVectorStore } from '../packages/lore/src/engines/arcade/arcadeVectorStore.js';
import {
  buildProjectedNeighborsSql,
  parseProjectedNeighbors,
  recallProjectionEnabled,
} from '../packages/lore/src/engines/arcade/arcadeRecallProjection.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// M6 — Host policy
// ════════════════════════════════════════════════════════════════════════════
console.log('M6 host allowlist');

const PORT = 3847;
const policy = (env: Record<string, string> = {}) => buildArcadeHostPolicy({ port: PORT, env: env as NodeJS.ProcessEnv });

await test('parseHostHeader: port, IPv6 literal, trailing dot, junk', () => {
  assert.deepEqual(parseHostHeader('Lore.Example.com:8443'), { hostname: 'lore.example.com', port: '8443' });
  assert.deepEqual(parseHostHeader('[::1]:3847'), { hostname: '[::1]', port: '3847' });
  assert.deepEqual(parseHostHeader('[::1]'), { hostname: '[::1]', port: undefined });
  assert.deepEqual(parseHostHeader('example.com.'), { hostname: 'example.com', port: undefined });
  assert.equal(parseHostHeader('a b'), null);
  assert.equal(parseHostHeader('evil.example/x'), null);
  assert.equal(parseHostHeader('user@evil.example'), null);
});

await test('default: loopback names with the listener port are allowed (shared isAllowedHost rule)', () => {
  const p = policy();
  for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) assert.equal(p.isAllowed(h), true, h);
});

await test('default: loopback on another port (relay port-map), IP literals, dotless service names are allowed', () => {
  const p = policy();
  for (const h of ['127.0.0.1:9999', 'localhost', '[::1]:1', '10.0.0.7:3847', '[fd00::5]:3847', 'lore:3847', 'lore-daemon', 'foo.localhost:3847']) {
    assert.equal(p.isAllowed(h), true, h);
  }
});

await test('default: an arbitrary dotted DNS name is refused (the rebinding case)', () => {
  const p = policy();
  for (const h of ['evil.example', 'evil.example:3847', 'localhost.evil.example', '127.0.0.1.evil.example', 'EVIL.EXAMPLE.', 'lore.example.com:443']) {
    assert.equal(p.isAllowed(h), false, h);
  }
});

await test('default: malformed Host refused; missing Host (HTTP/1.0) allowed', () => {
  const p = policy();
  assert.equal(p.isAllowed('bad host'), false);
  assert.equal(p.isAllowed('evil.example/path'), false);
  assert.equal(p.isAllowed(undefined), true);
  assert.equal(p.isAllowed(''), true);
});

await test('LORE_ARCADE_ALLOWED_HOSTS: public name (any port / exact port / wildcard) is added', () => {
  const p = policy({ LORE_ARCADE_ALLOWED_HOSTS: 'lore.example.com, api.example.com:8443 ,*.corp.example' });
  assert.equal(p.isAllowed('lore.example.com'), true);
  assert.equal(p.isAllowed('LORE.example.com:443'), true);
  assert.equal(p.isAllowed('api.example.com:8443'), true);
  assert.equal(p.isAllowed('api.example.com:9'), false);
  assert.equal(p.isAllowed('x.corp.example'), true);
  assert.equal(p.isAllowed('corp.example'), false, 'wildcard is subdomains only');
  assert.equal(p.isAllowed('evil.example'), false);
  assert.equal(p.isAllowed('evillore.example.com'), false, 'no suffix confusion');
});

await test('LORE_ARCADE_ALLOWED_HOSTS=* disables the check; a malformed entry never widens it', () => {
  assert.equal(policy({ LORE_ARCADE_ALLOWED_HOSTS: '*' }).isAllowed('evil.example'), true);
  const p = policy({ LORE_ARCADE_ALLOWED_HOSTS: 'bad host,,/x' });
  assert.equal(p.isAllowed('evil.example'), false);
});

await test('LORE_ARCADE_HOST_CHECK=strict: only exact loopback + the list; missing Host refused', () => {
  const p = policy({ LORE_ARCADE_HOST_CHECK: 'strict', LORE_ARCADE_ALLOWED_HOSTS: 'lore.example.com' });
  assert.equal(p.isAllowed(`localhost:${PORT}`), true);
  assert.equal(p.isAllowed('lore.example.com'), true);
  assert.equal(p.isAllowed('lore:3847'), false);
  assert.equal(p.isAllowed('10.0.0.7:3847'), false);
  assert.equal(p.isAllowed('localhost:9999'), false);
  assert.equal(p.isAllowed(undefined), false);
});

// ════════════════════════════════════════════════════════════════════════════
// M5 — readiness check
// ════════════════════════════════════════════════════════════════════════════
console.log('M5 readiness');

await test('ready when the probe succeeds; result cached for the ttl (one probe)', async () => {
  let calls = 0;
  const r = createArcadeReadiness({ probe: async () => { calls++; }, ttlMs: 60_000, timeoutMs: 500 });
  assert.equal((await r.check()).ready, true);
  assert.equal((await r.check()).ready, true);
  assert.equal((await r.check()).ready, true);
  assert.equal(calls, 1);
});

await test('concurrent callers share one in-flight probe', async () => {
  let calls = 0;
  const r = createArcadeReadiness({ probe: async () => { calls++; await sleep(30); }, ttlMs: 60_000, timeoutMs: 500 });
  const all = await Promise.all(Array.from({ length: 25 }, () => r.check()));
  assert.equal(calls, 1);
  assert.ok(all.every((x) => x.ready));
});

await test('ArcadeDB down: not ready (unreachable); recovery without restart after the ttl', async () => {
  let up = false;
  let calls = 0;
  const r = createArcadeReadiness({
    probe: async () => { calls++; if (!up) throw new Error('connect ECONNREFUSED 127.0.0.1:2480'); },
    ttlMs: 20, timeoutMs: 500,
  });
  const down = await r.check();
  assert.equal(down.ready, false);
  assert.equal(down.reason, 'unreachable');
  up = true;
  assert.equal((await r.check()).ready, false, 'still inside the ttl: cached failure, no new probe');
  assert.equal(calls, 1);
  await sleep(40);
  assert.equal((await r.check()).ready, true, 'ready again with no restart');
});

await test('slow ArcadeDB: probe past the timeout answers not ready (timeout) promptly', async () => {
  const r = createArcadeReadiness({ probe: () => sleep(300), ttlMs: 10, timeoutMs: 40 });
  const t0 = Date.now();
  const res = await r.check();
  assert.equal(res.ready, false);
  assert.equal(res.reason, 'timeout');
  assert.ok(Date.now() - t0 < 200, `answered in ${Date.now() - t0}ms`);
});

await test('a hung probe does not stack: no second probe starts while the first is unsettled', async () => {
  let calls = 0;
  let release!: () => void;
  const hung = new Promise<void>((res) => { release = res; });
  const r = createArcadeReadiness({ probe: () => { calls++; return hung; }, ttlMs: 5, timeoutMs: 20 });
  assert.equal((await r.check()).reason, 'timeout');
  for (let i = 0; i < 5; i++) { await sleep(10); assert.equal((await r.check()).ready, false); }
  assert.equal(calls, 1, 'one hung probe, never a pile of them');
  release();
  await sleep(10);
  await sleep(10);
  assert.equal((await r.check()).ready, true, 'recovers after the hung probe settles');
  assert.equal(calls, 2);
});

await test('credentials wrong / DB error classification', () => {
  assert.equal(classifyProbeError(new ArcadeHttpError(401, 'Unauthorized')).reason, 'auth_failed');
  assert.equal(classifyProbeError(new ArcadeHttpError(403, 'Forbidden')).reason, 'auth_failed');
  assert.equal(classifyProbeError(new ArcadeHttpError(503, 'busy')).reason, 'unavailable');
  assert.equal(classifyProbeError(new ArcadeHttpError(500, 'boom')).reason, 'unavailable');
  assert.equal(classifyProbeError(new Error('[ArcadeHttp] request timeout after 2000ms')).reason, 'timeout');
  assert.equal(classifyProbeError(new Error('socket hang up')).reason, 'unreachable');
  assert.equal(classifyProbeError(new Error('no root password configured (fail-closed)')).reason, 'auth_failed');
});

await test('rate classifier exempts /ready and /api/ready like /health', () => {
  for (const p of ['/ready', '/api/ready', '/health', '/api/health']) assert.equal(classifyArcadeRequest(p, 'GET'), null, p);
  assert.equal(classifyArcadeRequest('/api/recall', 'GET'), 'generic');
});

// ── dispatcher: /ready, /health, Host check on every route ───────────────────

const OP_TOKEN = 'a'.repeat(64);

function fakeReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers: { host: `127.0.0.1:${PORT}`, ...headers }, on() { return this; } } as unknown as IncomingMessage;
}
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

function makeDeps(opts: { probe: () => Promise<void>; env?: Record<string, string>; poolTouched?: string[] }) {
  const limiter = new RateLimiter('cloud', { ...buildDefaultBuckets('cloud'), ...arcadeBucketConfigs() });
  let consumed = 0;
  const realConsume = limiter.tryConsume.bind(limiter);
  limiter.tryConsume = ((...a: Parameters<typeof realConsume>) => { consumed++; return realConsume(...a); }) as typeof limiter.tryConsume;
  const touched = opts.poolTouched ?? [];
  const pool = new Proxy({}, { get(_t, prop) { touched.push(String(prop)); throw new Error('POOL_TOUCHED'); } });
  return {
    deps: {
      authToken: OP_TOKEN,
      sharedSecret: undefined,
      auditLog: {} as never,
      pool: pool as never,
      outboxStore: {} as never,
      outboxLagCache: {} as never,
      limiter,
      hostPolicy: policy(opts.env),
      readiness: createArcadeReadiness({ probe: opts.probe, ttlMs: 10, timeoutMs: 100 }),
    },
    consumed: () => consumed,
    touched,
  };
}
const dispatch = async (deps: ReturnType<typeof makeDeps>['deps'], req: IncomingMessage): Promise<FakeRes> => {
  const res = fakeRes();
  await arcadeDispatch(req, res, deps);
  return res;
};

console.log('M5/M6 dispatcher');

await test('/ready: 200 when ArcadeDB is up; anonymous body is status only', async () => {
  const { deps } = makeDeps({ probe: async () => {} });
  for (const url of ['/ready', '/api/ready']) {
    const res = await dispatch(deps, fakeReq('GET', url));
    assert.equal(res._status, 200, url);
    const body = JSON.parse(res._body);
    assert.equal(body.status, 'ready');
    assert.equal(body.mode, 'arcade');
    assert.equal('reason' in body, false);
    assert.equal(res._headers['cache-control'], 'no-store');
  }
});

await test('/ready: 503 when ArcadeDB is down while /health stays 200 (liveness unaffected)', async () => {
  const { deps } = makeDeps({ probe: async () => { throw new Error('connect ECONNREFUSED'); } });
  const ready = await dispatch(deps, fakeReq('GET', '/ready'));
  assert.equal(ready._status, 503);
  const body = JSON.parse(ready._body);
  assert.equal(body.status, 'not_ready');
  assert.equal('reason' in body, false, 'anonymous callers get no failure detail');
  assert.equal(ready._headers['retry-after'], '2');
  const health = await dispatch(deps, fakeReq('GET', '/health'));
  assert.equal(health._status, 200);
  assert.equal(JSON.parse(health._body).status, 'ok');
});

await test('/ready: operator bearer sees reason + detail + timings', async () => {
  const { deps } = makeDeps({ probe: async () => { throw new ArcadeHttpError(401, 'bad creds'); } });
  const res = await dispatch(deps, fakeReq('GET', '/ready', { authorization: `Bearer ${OP_TOKEN}` }));
  assert.equal(res._status, 503);
  const body = JSON.parse(res._body);
  assert.equal(body.reason, 'auth_failed');
  assert.match(body.detail, /401/);
  assert.equal(typeof body.latencyMs, 'number');
});

await test('/ready: recovers to 200 without a restart', async () => {
  let up = false;
  const { deps } = makeDeps({ probe: async () => { if (!up) throw new Error('ECONNREFUSED'); } });
  assert.equal((await dispatch(deps, fakeReq('GET', '/ready')))._status, 503);
  up = true;
  await sleep(30);
  assert.equal((await dispatch(deps, fakeReq('GET', '/ready')))._status, 200);
});

await test('/ready is exempt from the rate limiter and never reaches the 501 fall-through', async () => {
  const m = makeDeps({ probe: async () => {} });
  for (let i = 0; i < 300; i++) {
    const res = await dispatch(m.deps, fakeReq('GET', i % 2 ? '/ready' : '/api/ready'));
    assert.equal(res._status, 200, `request ${i}`);
  }
  assert.equal(m.consumed(), 0, 'limiter never debited for /ready');
  // Control: an unknown non-/api path still 501s, and a data path does debit the limiter.
  const unknown = await dispatch(m.deps, fakeReq('GET', '/nope'));
  assert.equal(unknown._status, 501);
});

await test('/ready under a polling storm costs one probe per ttl, not one per request', async () => {
  let calls = 0;
  const { deps } = makeDeps({ probe: async () => { calls++; } });
  await Promise.all(Array.from({ length: 200 }, () => dispatch(deps, fakeReq('GET', '/ready'))));
  assert.equal(calls, 1);
});

await test('M6: evil Host is refused 403 host_not_allowed on health, ready, data and operator routes', async () => {
  const m = makeDeps({ probe: async () => {} });
  const evil = { host: 'evil.example:3847' };
  const cases: Array<[string, string, Record<string, string>]> = [
    ['GET', '/health', evil],
    ['GET', '/ready', evil],
    ['GET', '/api/recall?q=x', { ...evil, authorization: 'Bearer lore_at_' + 'x'.repeat(40) }],
    ['POST', '/api/nodes/bulk', { ...evil, authorization: 'Bearer lore_at_' + 'x'.repeat(40) }],
    ['GET', '/api/arcade/apps', { ...evil, authorization: `Bearer ${OP_TOKEN}` }],
    ['GET', '/anything-else', evil],
  ];
  for (const [method, url, headers] of cases) {
    const res = await dispatch(m.deps, fakeReq(method, url, headers));
    assert.equal(res._status, 403, `${method} ${url}`);
    assert.equal(JSON.parse(res._body).code, 'host_not_allowed');
  }
  assert.deepEqual(m.touched, [], 'refused before any pool / token resolution');
  assert.equal(m.consumed(), 0, 'refused before the rate limiter');
});

await test('M6: the same data request with an allowed Host reaches the data plane', async () => {
  const m = makeDeps({ probe: async () => {} });
  const tok = 'Bearer lore_at_' + 'x'.repeat(40);
  for (const host of [`127.0.0.1:${PORT}`, 'lore:3847', '10.1.2.3:3847']) {
    m.touched.length = 0;
    await assert.rejects(() => dispatch(m.deps, fakeReq('GET', '/api/recall?q=x', { host, authorization: tok })), /POOL_TOUCHED/, host);
    assert.ok(m.touched.length > 0, `data plane reached with Host ${host}`);
  }
});

await test('M6: a configured public name is accepted; unconfigured it is refused', async () => {
  const tok = 'Bearer lore_at_' + 'x'.repeat(40);
  const refused = makeDeps({ probe: async () => {} });
  assert.equal((await dispatch(refused.deps, fakeReq('GET', '/api/recall', { host: 'lore.example.com', authorization: tok })))._status, 403);
  const allowed = makeDeps({ probe: async () => {}, env: { LORE_ARCADE_ALLOWED_HOSTS: 'lore.example.com' } });
  await assert.rejects(() => dispatch(allowed.deps, fakeReq('GET', '/api/recall', { host: 'lore.example.com', authorization: tok })), /POOL_TOUCHED/);
});

await test('M6: missing Host (HTTP/1.0) reaches /health under the default policy', async () => {
  const { deps } = makeDeps({ probe: async () => {} });
  const req = fakeReq('GET', '/health');
  delete (req.headers as Record<string, unknown>)['host'];
  assert.equal((await dispatch(deps, req))._status, 200);
});

// ════════════════════════════════════════════════════════════════════════════
// M4 — recall projection + paged dumpAll (fake ArcadeHttp transport)
// ════════════════════════════════════════════════════════════════════════════
console.log('M4 recall projection + dumpAll paging');

class StubEmbedder implements EmbeddingProvider {
  readonly dimension = 4;
  readonly modelId = 'stub';
  readonly dtype = 'fp32';
  async initialize(): Promise<void> {}
  async embed(): Promise<number[]> { return [1, 0, 0, 0]; }
  async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
  async embedDocument(): Promise<number[]> { return [1, 0, 0, 0]; }
}

type Q = { sql: string; params: Record<string, unknown> };
const queries: Q[] = [];
let queryImpl: (q: Q) => unknown[] | Promise<unknown[]> = () => [];
ArcadeHttp.prototype.query = async function (_db: string, sql: string, params: Record<string, unknown> = {}) {
  const q = { sql, params };
  queries.push(q);
  return { result: await queryImpl(q) };
};
ArcadeHttp.prototype.command = async function () { return { result: [] }; };

const EMB = Array.from({ length: 1024 }, (_, i) => i / 1024);
const fullVertex = (id: string) => ({
  '@rid': '#1:0', id, text: `text ${id}`, type: 'note', label: id, tags: '', project: 'p', ecosystem: '*',
  updatedAt: '2026-10-13T00:00:00.000Z', security_scopes: '', contentHash: 'h', embedding: EMB,
});
const newStore = (): ArcadeVectorStore =>
  new ArcadeVectorStore({ tenantDb: 'db_t', http: new ArcadeHttp({ user: 'u', pass: 'p' }), embedder: new StubEmbedder() });

await test('FINDING: with projection OFF, recall ships each hit as a whole record (embedding included) back over the wire', async () => {
  queries.length = 0;
  for (const off of ['off', '0', 'false', 'OFF']) {
    assert.equal(recallProjectionEnabled({ LORE_ARCADE_RECALL_PROJECTION: off } as NodeJS.ProcessEnv), false, `explicit ${off}`);
  }
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'off';
  ArcadeVectorStore.resetProjectionLatchForTests();
  let wireBytes = 0;
  queryImpl = () => {
    const neighbors = Array.from({ length: 40 }, (_, i) => ({ vertex: fullVertex(`n${i}`), distance: i / 100 }));
    wireBytes = JSON.stringify([{ neighbors }]).length;
    return [{ neighbors }];
  };
  const hits = await newStore().search('q', 10);
  assert.equal(hits.length, 10);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /^SELECT vector\.neighbors\(/);
  assert.equal(queries[0]!.params['k'], 40);
  // Documented as a model of what the unprojected statement transfers when the
  // server returns whole vertices: 40 hits x 1024 floats is already hundreds of KB.
  assert.ok(wireBytes > 300_000, `modelled payload ${wireBytes}B`);
});

await test('k is bounded by the RECALL_MAX_CAP model: limit 100 -> k = 400', async () => {
  queries.length = 0;
  queryImpl = () => [{ neighbors: [] }];
  await newStore().search('q', 100);
  assert.equal(queries[0]!.params['k'], 400);
});

await test('projection is ON by default (unset / empty / on / 1 / true)', async () => {
  for (const v of [undefined, '', 'on', '1', 'true', 'ON']) {
    const env = (v === undefined ? {} : { LORE_ARCADE_RECALL_PROJECTION: v }) as NodeJS.ProcessEnv;
    assert.equal(recallProjectionEnabled(env), true, `value ${String(v)}`);
  }
  // end-to-end with the variable UNSET: the projected statement is what runs
  delete process.env['LORE_ARCADE_RECALL_PROJECTION'];
  ArcadeVectorStore.resetProjectionLatchForTests();
  queries.length = 0;
  queryImpl = () => [{ id: 'd', text: 't', type: '', label: '', tags: '', project: '', ecosystem: '', updatedAt: '', security_scopes: '', distance: 0 }];
  const hits = await newStore().search('q', 3);
  assert.deepEqual(hits.map((h) => h.id), ['d']);
  assert.equal(queries[0]!.sql, buildProjectedNeighborsSql('LoreVerbatim'));
});

await test('projection OFF (explicit): runs the original whole-record statement, never the projected one', async () => {
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'off';
  ArcadeVectorStore.resetProjectionLatchForTests();
  queries.length = 0;
  queryImpl = () => [{ neighbors: [{ vertex: fullVertex('o'), distance: 0.1 }] }];
  const hits = await newStore().search('q', 3);
  assert.deepEqual(hits.map((h) => h.id), ['o']);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0]!.sql, /expand/);
});

await test('projected statement reads flat columns (not vertex.<col>, which is null on ArcadeDB 26.7.1)', () => {
  const sql = buildProjectedNeighborsSql('LoreVerbatim');
  assert.doesNotMatch(sql, /vertex\./);
  assert.match(sql, /^SELECT id, `text`, type, label, tags, project, ecosystem, updatedAt, security_scopes, distance FROM \(SELECT expand\(/);
});

await test('projection ON: projected statement selects scalar columns only (no embedding) and results are identical', async () => {
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'on';
  ArcadeVectorStore.resetProjectionLatchForTests();
  queries.length = 0;
  queryImpl = () => Array.from({ length: 5 }, (_, i) => ({
    id: `n${i}`, text: `text n${i}`, type: 'note', label: `n${i}`, tags: '', project: 'p', ecosystem: '*',
    updatedAt: '2026-10-13T00:00:00.000Z', security_scopes: '', distance: i / 10,
  }));
  const hits = await newStore().search('q', 3);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]!.sql, buildProjectedNeighborsSql('LoreVerbatim'));
  assert.ok(!/embedding\s+AS|vertex\.embedding/.test(queries[0]!.sql), 'embedding column is not selected');
  assert.deepEqual(hits.map((h) => h.id), ['n0', 'n1', 'n2']);
  assert.equal(hits[0]!.text, 'text n0');
  assert.equal(hits[0]!.metadata.project, 'p');
  assert.ok(Math.abs(hits[1]!.score - 0.9) < 1e-9);
});

await test('projection ON: metadata filter still applies to projected rows', async () => {
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'on';
  ArcadeVectorStore.resetProjectionLatchForTests();
  queryImpl = () => [
    { id: 'a', text: 'A', type: 'note', label: '', tags: '', project: 'x', ecosystem: '', updatedAt: '', security_scopes: '', distance: 0.1 },
    { id: 'b', text: 'B', type: 'note', label: '', tags: '', project: 'y', ecosystem: '', updatedAt: '', security_scopes: '', distance: 0.2 },
  ];
  const hits = await newStore().search('q', 5, { project: 'y' } as never);
  assert.deepEqual(hits.map((h) => h.id), ['b']);
});

await test('projection ON, statement rejected (HTTP 400): falls back to the original statement and latches off', async () => {
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'on';
  ArcadeVectorStore.resetProjectionLatchForTests();
  queries.length = 0;
  queryImpl = (q) => {
    if (/expand\(/.test(q.sql)) throw new ArcadeHttpError(400, 'Syntax error');
    return [{ neighbors: [{ vertex: fullVertex('z'), distance: 0.05 }] }];
  };
  const store = newStore();
  const first = await store.search('q', 3);
  assert.deepEqual(first.map((h) => h.id), ['z']);
  assert.equal(queries.length, 2, 'one rejected projected try, then the fallback');
  queries.length = 0;
  await store.search('q', 3);
  assert.equal(queries.length, 1, 'latched off: no more projected tries');
  assert.doesNotMatch(queries[0]!.sql, /expand/);
});

await test('projection ON, unexpected row shape: falls back and latches off', async () => {
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'on';
  ArcadeVectorStore.resetProjectionLatchForTests();
  queries.length = 0;
  queryImpl = (q) => (/expand\(/.test(q.sql) ? [{ weird: true }] : [{ neighbors: [{ vertex: fullVertex('w'), distance: 0.01 }] }]);
  const hits = await newStore().search('q', 3);
  assert.deepEqual(hits.map((h) => h.id), ['w']);
  assert.equal(queries.length, 2);
});

await test('projection ON, transient 503: surfaces the error, does NOT latch off', async () => {
  process.env['LORE_ARCADE_RECALL_PROJECTION'] = 'on';
  ArcadeVectorStore.resetProjectionLatchForTests();
  let fail = true;
  queryImpl = () => {
    if (fail) throw new ArcadeHttpError(503, 'busy');
    return [{ id: 'ok', text: 't', type: '', label: '', tags: '', project: '', ecosystem: '', updatedAt: '', security_scopes: '', distance: 0 }];
  };
  await assert.rejects(() => newStore().search('q', 3), /503/);
  fail = false;
  queries.length = 0;
  const hits = await newStore().search('q', 3);
  assert.equal(hits[0]!.id, 'ok');
  assert.match(queries[0]!.sql, /expand/, 'projection still on');
});

await test('parseProjectedNeighbors: empty is a valid empty neighbourhood; non-projected rows are null', () => {
  assert.deepEqual(parseProjectedNeighbors([]), []);
  assert.equal(parseProjectedNeighbors([{ neighbors: [] }]), null);
  assert.equal(parseProjectedNeighbors([null]), null);
  // the 26.7.1 `vertex.id` trap: the row has the keys but every value is null
  assert.equal(parseProjectedNeighbors([{ id: null, text: null, distance: 0.5, '@props': 'distance:4' }]), null);
  assert.equal(parseProjectedNeighbors([{ id: '', distance: 0.5 }]), null);
  const ok = parseProjectedNeighbors([{ id: 'a', text: 't', distance: 0.5, '@props': 'distance:4' }]);
  assert.deepEqual(ok, [{ vertex: { id: 'a', text: 't' }, distance: 0.5 }]);
});

delete process.env['LORE_ARCADE_RECALL_PROJECTION'];
ArcadeVectorStore.resetProjectionLatchForTests();

await test('dumpAll pages by keyset: every query has a LIMIT, no unbounded embedding SELECT, all rows returned in order', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => `id${String(i).padStart(4, '0')}`);
  queries.length = 0;
  queryImpl = (q) => {
    assert.match(q.sql, /LIMIT 200/);
    assert.match(q.sql, /ORDER BY id/);
    assert.match(q.sql, /WHERE id > :lastId/);
    const after = String(q.params['lastId']);
    return ids.filter((id) => id > after).slice(0, 200).map((id) => ({ ...fullVertex(id), security_scopes: 'a,b' }));
  };
  const rows = await newStore().dumpAll();
  assert.equal(rows.length, 450);
  assert.deepEqual(rows.map((r) => r.id), ids);
  assert.equal(queries.length, 3, '200 + 200 + 50');
  assert.deepEqual(queries.map((q) => q.params['lastId']), ['', 'id0199', 'id0399']);
  assert.ok(queries.every((q) => /LIMIT \d+/.test(q.sql)));
  assert.deepEqual(rows[0]!.metadata!['security_scopes'], ['a', 'b']);
  assert.equal(rows[0]!.embedding!.length, 1024);
  assert.equal(rows[0]!.contentHash, 'h');
});

await test('dumpAll: exact multiple of the page size ends on an empty page; empty table returns []', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `k${String(i).padStart(3, '0')}`);
  queries.length = 0;
  queryImpl = (q) => ids.filter((id) => id > String(q.params['lastId'])).slice(0, 200).map((id) => fullVertex(id));
  assert.equal((await newStore().dumpAll()).length, 200);
  assert.equal(queries.length, 2);
  queryImpl = () => [];
  assert.deepEqual(await newStore().dumpAll(), []);
});

await test('dumpAll: a cursor that fails to advance stops instead of looping', async () => {
  queryImpl = () => Array.from({ length: 200 }, () => fullVertex('same'));
  const rows = await newStore().dumpAll();
  assert.equal(rows.length, 400, 'second page repeats the id once, then the guard stops the walk');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
