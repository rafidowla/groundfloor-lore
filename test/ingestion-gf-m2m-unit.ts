#!/usr/bin/env tsx
/**
 * test/ingestion-gf-m2m-unit.ts - machine login for the Groundfloor Files API blob store (lane e4).
 * Everything runs against local fakes on ephemeral 127.0.0.1 ports (token endpoint + Files API in one fake); the real
 * Groundfloor platform is never called. Sections: 1 token provider (expiry, single flight, 401 refresh, backoff,
 * cooldown, URL rules), 2 config + factory (fail closed, secret file), 3 store 401 retry once, 4 redaction,
 * 5 real wire-up through IngestionHost.start with env config (upload, read back, token expiring mid-run).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-gf-m2m-'));
process.env['LORE_HOME'] = path.join(tmp, 'home');
fs.mkdirSync(process.env['LORE_HOME'], { recursive: true });

const { M2mTokenProvider, m2mTokenUrlFor, M2M_FAILURE_COOLDOWN_MS, M2M_FALLBACK_LIFETIME_SEC } = await import('../packages/lore/src/ingestion/groundfloorM2mToken.js');
const { GroundfloorBlobStore, GroundfloorBlobError } = await import('../packages/lore/src/ingestion/groundfloorBlobStore.js');
const { makeBlobStoreFactory } = await import('../packages/lore/src/ingestion/blobStoreFactory.js');
const { loadIngestHostConfig } = await import('../packages/lore/src/ingestion/hostConfig.js');
const { IngestionHost } = await import('../packages/lore/src/ingestion/ingestionHost.js');
const { sha256Hex } = await import('../packages/lore/src/ingestion/blobStore.js');
const { SqliteTableStorage } = await import('../packages/lore/src/engines/sqliteTableStorage.js');
const { startFakeGroundfloor, FAKE_WS } = await import('./helpers/fakeGroundfloorFiles.js');

let passed = 0; let failed = 0;
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    queue.push(async () => {
        try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    });
}
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<void> { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleepReal(20); } }

// Generated per run, never copied from anywhere.
const rnd = () => Math.random().toString(36).slice(2, 10);
const CLIENT_ID = `lore-test-client-${rnd()}`;
const CLIENT_SECRET = `sec-${rnd()}${rnd()}-SECRETVALUE`;
const m2mOpts = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

/** Captures everything written to stderr (the logger's only sink) while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; logs: string }> {
    const orig = process.stderr.write.bind(process.stderr); let logs = '';
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => { logs += String(c); return true; };
    let result: T | undefined; let error: unknown;
    try { result = await fn(); } catch (e) { error = e; } finally { process.stderr.write = orig; }
    return { result, error, logs };
}
const noSleep = async (_ms: number) => undefined;

// ---- 1. token provider ---------------------------------------------------------------------------------------------
console.log('\ntoken provider');
function stubFetch(script: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: unknown, init: RequestInit) => {
        calls.push({ url: String(url), init });
        const s = script[Math.min(calls.length - 1, script.length - 1)]!;
        if (s instanceof Error) throw s;
        return new Response(JSON.stringify(s.body ?? {}), { status: s.status, headers: { 'content-type': 'application/json', ...(s.headers ?? {}) } });
    }) as unknown as typeof fetch;
    return { f, calls };
}
const ok = (n: number, expires_in = 300) => ({ status: 200, body: { access_token: `tok-${n}`, expires_in, m2m_client_id: CLIENT_ID } });
const URL_OK = 'https://api.example.invalid/v1/workspaces/w1/m2m/token';
const mkProv = (f: typeof fetch, now: () => number = Date.now, over: Record<string, unknown> = {}) =>
    new M2mTokenProvider({ tokenUrl: URL_OK, ...m2mOpts, clientSecret: () => CLIENT_SECRET, fetchImpl: f, sleep: noSleep, now, ...over });

test('mint request follows the reference client contract: POST JSON {client_id, client_secret} to {api}/v1/workspaces/{ws}/m2m/token', async () => {
    assert.equal(m2mTokenUrlFor('https://api.example.invalid/', 'w 1'), 'https://api.example.invalid/v1/workspaces/w%201/m2m/token');
    const s = stubFetch([ok(1)]); const p = mkProv(s.f);
    assert.equal(await p.get(), 'tok-1');
    const c = s.calls[0]!; assert.equal(c.url, URL_OK); assert.equal(c.init.method, 'POST'); assert.equal(c.init.redirect, 'error');
    assert.deepEqual(JSON.parse(String(c.init.body)), { client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    assert.equal((c.init.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('token is cached until 80% of expires_in, then re-minted (no restart)', async () => {
    const s = stubFetch([ok(1, 100), ok(2, 100)]); let t = 1_000_000; const p = mkProv(s.f, () => t);
    assert.equal(await p.get(), 'tok-1'); t += 79_000; assert.equal(await p.get(), 'tok-1'); assert.equal(s.calls.length, 1);
    t += 2_000; assert.equal(await p.get(), 'tok-2'); assert.equal(s.calls.length, 2);
    assert.equal(p.status().mints, 2);
});

test('missing or nonsense expires_in is treated as a short life, not forever', async () => {
    for (const bad of [undefined, 0, -5, 'soon']) {
        const s = stubFetch([{ status: 200, body: { access_token: 'tok-a', expires_in: bad } }, ok(2)]); let t = 5_000; const p = mkProv(s.f, () => t);
        await p.get(); t += M2M_FALLBACK_LIFETIME_SEC * 1000 * 0.8 - 1; await p.get(); assert.equal(s.calls.length, 1);
        t += 2; assert.equal(await p.get(), 'tok-2');
    }
});

test('single flight: 25 concurrent callers share one mint', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let n = 0;
    const f = (async () => { n++; await gate; return new Response(JSON.stringify({ access_token: 'tok-sf', expires_in: 300 }), { status: 200 }); }) as unknown as typeof fetch;
    const p = mkProv(f); const all = Promise.all(Array.from({ length: 25 }, () => p.get()));
    await sleepReal(30); release(); const got = await all;
    assert.equal(n, 1); assert.ok(got.every((x) => x === 'tok-sf'));
});

test('refresh(rejected): re-mints once for many 401s on the same token, and not at all if the token already changed', async () => {
    const s = stubFetch([ok(1), ok(2), ok(3)]); const p = mkProv(s.f);
    const a = await p.get();
    await Promise.all(Array.from({ length: 10 }, () => p.refresh(a)));
    assert.equal(s.calls.length, 2); assert.equal(await p.get(), 'tok-2');
    await p.refresh('tok-1'); assert.equal(s.calls.length, 2, 'a stale rejected token does not trigger a mint');
    await p.refresh('tok-2'); assert.equal(s.calls.length, 3);
});

test('5xx, 429 and network errors retry with bounded backoff; Retry-After honoured and capped at 10 s', async () => {
    const sleeps: number[] = [];
    const s = stubFetch([{ status: 503 }, { status: 429, headers: { 'retry-after': '3' } }, new TypeError('fetch failed'), ok(1)]);
    const p = mkProv(s.f, Date.now, { sleep: async (ms: number) => { sleeps.push(ms); }, retryBaseMs: 100 });
    assert.equal(await p.get(), 'tok-1'); assert.equal(s.calls.length, 4); assert.deepEqual(sleeps, [100, 3000, 400]);
    const sleeps2: number[] = []; const s2 = stubFetch([{ status: 429, headers: { 'retry-after': '9999' } }, ok(2)]);
    await mkProv(s2.f, Date.now, { sleep: async (ms: number) => { sleeps2.push(ms); } }).get(); assert.deepEqual(sleeps2, [10_000]);
});

test('retries are bounded; a 401/403/400 from the mint is not retried; a failed mint cools down (fails fast, no extra calls) then recovers', async () => {
    let t = 10_000; const s = stubFetch([{ status: 503 }]); const p = mkProv(s.f, () => t, { maxRetries: 2 });
    await assert.rejects(p.get(), /HTTP 503/); assert.equal(s.calls.length, 3);
    await assert.rejects(p.get(), /HTTP 503/); await assert.rejects(p.get(), /HTTP 503/); assert.equal(s.calls.length, 3, 'cooldown: no hammering');
    assert.equal(p.status().lastFailure, 'HTTP 503');
    for (const code of [400, 401, 403]) {
        const s2 = stubFetch([{ status: code }, ok(9)]); let t2 = 1; const p2 = mkProv(s2.f, () => t2);
        await assert.rejects(p2.get(), new RegExp(`HTTP ${code}`)); assert.equal(s2.calls.length, 1, `HTTP ${code} not retried`);
        t2 += M2M_FAILURE_COOLDOWN_MS + 1; assert.equal(await p2.get(), 'tok-9', 'recovers after the cooldown');
        assert.equal(p2.status().lastFailure, null);
    }
});

test('malformed mint responses are errors, not tokens', async () => {
    for (const body of [{}, { access_token: '' }, { access_token: 5 }, { access_token: 'a\r\nInjected: 1' }, 'nope']) {
        const s = stubFetch([{ status: 200, body }]); await assert.rejects(mkProv(s.f).get(), /malformed response/); assert.equal(s.calls.length, 1);
    }
});

test('URL rules: https only (http for loopback), no credentials, no query; redirects are refused and not followed', async () => {
    const mk = (u: string) => new M2mTokenProvider({ tokenUrl: u, ...m2mOpts, clientSecret: () => CLIENT_SECRET });
    assert.throws(() => mk('http://api.example.invalid/m2m/token'), /https/);
    assert.throws(() => mk('https://user:pw@api.example.invalid/m2m/token'), /credentials/);
    assert.throws(() => mk('https://api.example.invalid/m2m/token?client_secret=x'), /query/);
    assert.throws(() => mk('not a url'), /valid URL/);
    assert.doesNotThrow(() => mk('http://127.0.0.1:1/m2m/token'));
    assert.throws(() => new M2mTokenProvider({ tokenUrl: URL_OK, clientId: '', clientSecret: () => 'x' }), /client id/);
    let hits = 0; let elsewhere = 0;
    const srv = http.createServer((req, res) => { if (req.url === '/elsewhere') { elsewhere++; res.writeHead(200); return void res.end('{}'); } hits++; res.writeHead(302, { location: '/elsewhere' }); res.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
        const port = (srv.address() as { port: number }).port;
        const p = new M2mTokenProvider({ tokenUrl: `http://127.0.0.1:${port}/m2m/token`, ...m2mOpts, clientSecret: () => CLIENT_SECRET, sleep: noSleep, maxRetries: 0 });
        await assert.rejects(p.get(), /m2m token request failed/); assert.equal(hits, 1); assert.equal(elsewhere, 0, 'redirect was not followed');
    } finally { srv.closeAllConnections(); srv.close(); }
});


// ---- 1b. lane f2: renewal failure keeps the token, #private fields, config-fault secret, clamp -----------------------
console.log('\nrenewal + rotation hardening');
const bearerOf = (init: RequestInit) => JSON.parse(String(init.body)) as { client_id: string; client_secret: string };

test('a failed renewal at 80% keeps serving the still-valid token (one attempt, no backoff sleep), retries after the cooldown, and only fails once truly expired', async () => {
    const s = stubFetch([ok(1, 100), { status: 503 }, { status: 503 }, ok(2, 100)]); let t = 1_000_000; const sleeps: number[] = [];
    const p = mkProv(s.f, () => t, { sleep: async (ms: number) => { sleeps.push(ms); } });
    assert.equal(await p.get(), 'tok-1');
    t += 80_000;                                  // 80% mark; real expiry is at 95 s (100 s minus the 5 s margin)
    assert.equal(await p.get(), 'tok-1', 'the renewal failed but the token is still valid'); assert.equal(s.calls.length, 2); assert.deepEqual(sleeps, [], 'no backoff in the caller path');
    assert.equal(p.status().lastFailure, 'HTTP 503'); assert.equal(p.status().hasToken, true);
    t += 1_000; assert.equal(await p.get(), 'tok-1'); assert.equal(s.calls.length, 2, 'cooldown: no extra mint calls (20/min platform limit)');
    t += M2M_FAILURE_COOLDOWN_MS; assert.equal(await p.get(), 'tok-1', 'second renewal also fails, still served'); assert.equal(s.calls.length, 3);
    t += M2M_FAILURE_COOLDOWN_MS; assert.equal(await p.get(), 'tok-2', 'renewal succeeds after the next cooldown'); assert.equal(s.calls.length, 4); assert.equal(p.status().lastFailure, null);
    // Now let renewals keep failing until the token really expires: only then does a failure surface (with full retries).
    const s2 = stubFetch([ok(1, 100), { status: 503 }]); let t2 = 1_000_000; const p2 = mkProv(s2.f, () => t2, { maxRetries: 2 });
    await p2.get(); t2 += 80_000; assert.equal(await p2.get(), 'tok-1');
    t2 += 14_999; assert.equal(await p2.get(), 'tok-1', 'one ms before real expiry (95 s) it is still served');
    t2 += 5_001; const before = s2.calls.length;           // past expiry and past the cooldown
    await assert.rejects(p2.get(), /HTTP 503/); assert.equal(s2.calls.length - before, 3, 'expired token: the mint is attempted with full retries');
    assert.equal(p2.status().hasToken, false);
});

test('renewal during a mint outage with concurrent callers: all are served the old token, one mint attempt', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let n = 0;
    const f = (async () => { n++; if (n === 1) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 100 }), { status: 200 }); await gate; return new Response('{}', { status: 503 }); }) as unknown as typeof fetch;
    let t = 1; const p = mkProv(f, () => t); await p.get(); t += 80_000;
    const all = Promise.all(Array.from({ length: 20 }, () => p.get())); await sleepReal(20); release();
    assert.ok((await all).every((x) => x === 'tok-1')); assert.equal(n, 2);
});

test('the 401 path still forces a fresh mint: a rejected token is never reused, even when it is still valid and the mint fails', async () => {
    const s = stubFetch([ok(1, 300), { status: 503 }, ok(2, 300)]); let t = 1_000; const p = mkProv(s.f, () => t, { maxRetries: 0 });
    const a = await p.get();
    await assert.rejects(p.refresh(a), /HTTP 503/);
    await assert.rejects(p.get(), /HTTP 503/, 'the rejected token is gone; during the cooldown nothing serves it');
    assert.equal(p.status().hasToken, false);
    t += M2M_FAILURE_COOLDOWN_MS + 1; assert.equal(await p.get(), 'tok-2');
    const s2 = stubFetch([ok(1, 300), ok(2, 300)]); const p2 = mkProv(s2.f); const b = await p2.get(); await p2.refresh(b); assert.equal(await p2.get(), 'tok-2');
});

test('a rotated client secret is used at the next mint (the provider asks for it on every mint)', async () => {
    let secret = 'first-secret-AAAA'; const s = stubFetch([ok(1), ok(2)]); const p = mkProv(s.f, Date.now, { clientSecret: () => secret });
    const a = await p.get(); secret = 'rotated-secret-BBBBBB'; await p.refresh(a);
    assert.deepEqual(s.calls.map((c) => bearerOf(c.init).client_secret), ['first-secret-AAAA', 'rotated-secret-BBBBBB']);
});

test('the token and the secret reader are invisible to inspect(customInspect:false), Object.entries/keys/values, spread, JSON and Reflect.ownKeys', async () => {
    const SECRET = `reader-secret-${rnd()}`; const s = stubFetch([ok(1)]); const p = mkProv(s.f, Date.now, { clientSecret: () => SECRET });
    await p.get();
    const shown = [
        inspect(p, { customInspect: false, showHidden: true, depth: 6 }), inspect(p, { depth: 6 }), JSON.stringify(p), JSON.stringify({ ...p }),
        JSON.stringify(Object.entries(p)), JSON.stringify(Object.values(p)), JSON.stringify(Object.keys(p)), String(Reflect.ownKeys(p).map(String)),
        JSON.stringify(Object.getOwnPropertyNames(p)), inspect(structuredCloneSafe(p), { depth: 6 }),
    ].join('\n');
    for (const n of ['tok-1', SECRET, CLIENT_SECRET]) assert.ok(!shown.includes(n), `leaked ${n.slice(0, 8)}`);
    assert.ok(!Object.getOwnPropertyNames(p).some((k) => /token|secret/i.test(k)), 'no secret-bearing own property names');
    assert.equal(await p.get(), 'tok-1', 'and it still works');
    function structuredCloneSafe(x: object): unknown { try { return structuredClone(x); } catch { return 'not cloneable'; } }
});

test('a throwing or empty secret reader is a configuration fault: zero fetches, zero retries, zero sleeps, a clear secret-free message', async () => {
    for (const reader of [() => { throw new Error('EACCES: /secret/path/leak-me'); }, () => '']) {
        const s = stubFetch([ok(1)]); const sleeps: number[] = []; const p = mkProv(s.f, Date.now, { clientSecret: reader, sleep: async (ms: number) => { sleeps.push(ms); } });
        const { error, logs } = await captureLogs(async () => { await p.get(); });
        assert.ok(error instanceof Error && error.name === 'GroundfloorTokenError'); assert.match((error as Error).message, /client secret unreadable/);
        assert.ok(!`${(error as Error).message}${logs}`.includes('leak-me'));
        assert.equal(s.calls.length, 0); assert.deepEqual(sleeps, []); assert.equal(p.status().lastFailure, 'client secret unreadable');
        await assert.rejects(p.get(), /client secret unreadable/); assert.equal(s.calls.length, 0);
    }
    // With a still-valid token, an unreadable secret at renewal time keeps the token; it recovers when the secret is readable again.
    let ok1 = true; const s = stubFetch([ok(1, 100), ok(2, 100)]); let t = 1; const p = mkProv(s.f, () => t, { clientSecret: () => { if (!ok1) throw new Error('gone'); return CLIENT_SECRET; } });
    await p.get(); ok1 = false; t += 80_000; assert.equal(await p.get(), 'tok-1'); assert.equal(s.calls.length, 1);
    ok1 = true; t += M2M_FAILURE_COOLDOWN_MS + 1; assert.equal(await p.get(), 'tok-2');
});

test('expires_in is clamped to [30 s, 24 h]: 1e306 does not mean "never renew", 0.001 does not mean "mint every call"', async () => {
    const s = stubFetch([{ status: 200, body: { access_token: 'tok-big', expires_in: 1e306 } }, ok(2)]); let t = 5_000; const p = mkProv(s.f, () => t);
    await p.get(); assert.ok(p.status().refreshInMs <= 24 * 3600 * 1000 * 0.8 && Number.isFinite(p.status().refreshInMs));
    t += 24 * 3600 * 1000 * 0.8 - 1; assert.equal(await p.get(), 'tok-big'); t += 2; assert.equal(await p.get(), 'tok-2');
    const s2 = stubFetch([{ status: 200, body: { access_token: 'tok-tiny', expires_in: 0.001 } }, ok(2)]); let t2 = 5_000; const p2 = mkProv(s2.f, () => t2);
    for (let i = 0; i < 5; i++) assert.equal(await p2.get(), 'tok-tiny'); assert.equal(s2.calls.length, 1, 'not minted on every call');
    t2 += 30_000 * 0.8 + 1; assert.equal(await p2.get(), 'tok-2');
});

test('a mint failure is reported with the same retryable flag on the token() path and the 401 path (retryable: every cause is fixable without changing the job)', async () => {
    const files = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    const mkStore = (prov: InstanceType<typeof M2mTokenProvider>, filesStatus: number) => new GroundfloorBlobStore({ baseUrl: 'http://127.0.0.1:9', filesWorkspaceId: FAKE_WS, token: () => prov.get(), onUnauthorized: (r) => prov.refresh(r), fetchImpl: files(filesStatus), sleep: noSleep, maxRetries: 0 });
    for (const code of [503, 401]) {
        // token() path: the very first mint fails.
        const a = mkStore(mkProv(stubFetch([{ status: code }]).f, Date.now, { maxRetries: 0 }), 200);
        const ea = await a.has(`gf1:abc:${'a'.repeat(64)}`).then(() => null, (e: unknown) => e as InstanceType<typeof GroundfloorBlobError>);
        // 401 path: the Files API rejects a good token, then the re-mint fails.
        const b = mkStore(mkProv(stubFetch([ok(1), { status: code }]).f, Date.now, { maxRetries: 0 }), 401);
        const eb = await b.has(`gf1:abc:${'a'.repeat(64)}`).then(() => null, (e: unknown) => e as InstanceType<typeof GroundfloorBlobError>);
        // cooldown variant on both paths: the same provider fails fast the second time.
        const pc = mkProv(stubFetch([{ status: code }]).f, Date.now, { maxRetries: 0 }); const c = mkStore(pc, 200);
        await c.has(`gf1:abc:${'a'.repeat(64)}`).catch(() => undefined); const ec = await c.has(`gf1:abc:${'a'.repeat(64)}`).then(() => null, (e: unknown) => e as InstanceType<typeof GroundfloorBlobError>);
        for (const e of [ea, eb, ec]) { assert.ok(e instanceof GroundfloorBlobError, `mint HTTP ${code}`); assert.equal(e.retryable, true, `mint HTTP ${code}: retryable on every path`); }
    }
});

// ---- 2. config + factory -------------------------------------------------------------------------------------------
console.log('\nconfig + factory');
const baseEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: 'https://api.example.invalid', LORE_INGEST_GF_WORKSPACE_ID: FAKE_WS, ...over,
});
const m2mEnv = (over: Record<string, string> = {}) => baseEnv({ LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET: CLIENT_SECRET, ...over });
const build = (env: NodeJS.ProcessEnv) => makeBlobStoreFactory(loadIngestHostConfig(env).blobs);

test('static token and m2m are mutually exclusive: both set fails closed with a message free of secrets', async () => {
    const tokenFile = path.join(tmp, 'tok'); fs.writeFileSync(tokenFile, 'static-token-VALUE');
    for (const env of [m2mEnv({ LORE_INGEST_GF_TOKEN: 'static-token-VALUE' }), m2mEnv({ LORE_INGEST_GF_TOKEN_FILE: tokenFile }), m2mEnv({ LORE_INGEST_GF_TOKEN_FILE: path.join(tmp, 'missing') }),
                       baseEnv({ LORE_INGEST_GF_TOKEN: 'static-token-VALUE', LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID })]) {
        let msg = ''; try { build(env); } catch (e) { msg = (e as Error).message; }
        assert.match(msg, /mutually exclusive/); assert.ok(!msg.includes(CLIENT_SECRET) && !msg.includes('static-token-VALUE'), 'no secret in the message');
    }
});

test('m2m needs client id AND secret (by value or readable non-empty file); names are reported, values never', async () => {
    const empty = path.join(tmp, 'empty'); fs.writeFileSync(empty, '\n');
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
        [baseEnv({ LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID }), /M2M_CLIENT_SECRET/],
        [baseEnv({ LORE_INGEST_GF_M2M_CLIENT_SECRET: CLIENT_SECRET }), /M2M_CLIENT_ID/],
        [baseEnv({ LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET_FILE: path.join(tmp, 'nope') }), /M2M_CLIENT_SECRET/],
        [baseEnv({ LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET_FILE: empty }), /M2M_CLIENT_SECRET/],
        [{ ...m2mEnv(), LORE_INGEST_GF_API_URL: '' }, /LORE_INGEST_GF_API_URL/],
        [baseEnv(), /LORE_INGEST_GF_TOKEN/],
    ];
    for (const [env, re] of cases) { let msg = ''; try { build(env); } catch (e) { msg = (e as Error).message; } assert.match(msg, re); assert.ok(!msg.includes(CLIENT_SECRET)); }
});

test('bad URLs for the m2m path fail at build time (https only, no credentials)', async () => {
    assert.throws(() => build(m2mEnv({ LORE_INGEST_GF_API_URL: 'http://api.example.invalid' })), /https/);
    assert.throws(() => build(m2mEnv({ LORE_INGEST_GF_API_URL: 'https://u:p@api.example.invalid' })), /credentials/);
    assert.doesNotThrow(() => build(m2mEnv()));
});

test('secret file: re-read when it changes (rotation without restart); loose file mode is flagged, 0600 and by-value are not', async () => {
    const f = path.join(tmp, 'secret-file'); fs.writeFileSync(f, `${CLIENT_SECRET}\n`, { mode: 0o600 }); fs.chmodSync(f, 0o600);
    const cfg = loadIngestHostConfig(baseEnv({ LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET_FILE: f })).blobs.groundfloor.m2m;
    assert.equal(cfg.clientSecret!.reveal(), CLIENT_SECRET); assert.equal(cfg.secretFileLoose, false);
    fs.writeFileSync(f, 'changed-later-longer'); assert.equal(cfg.clientSecret!.reveal(), 'changed-later-longer', 'a rotated file is picked up');
    fs.writeFileSync(f, ''); assert.equal(cfg.clientSecret!.reveal(), 'changed-later-longer', 'an emptied file keeps the last good value');
    if (process.platform !== 'win32') {
        fs.chmodSync(f, 0o644);
        assert.equal(loadIngestHostConfig(baseEnv({ LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET_FILE: f })).blobs.groundfloor.m2m.secretFileLoose, true);
        assert.equal(loadIngestHostConfig(m2mEnv()).blobs.groundfloor.m2m.secretFileLoose, false);
    }
});

test('the static-token path is unchanged when no m2m setting is present', async () => {
    const fake = await startFakeGroundfloor();
    try {
        const store = makeBlobStoreFactory(loadIngestHostConfig(baseEnv({ LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_TOKEN: 'tok-SECRET-do-not-log-0123456789' })).blobs)('ws');
        const bytes = Buffer.from('static path'); const ref = await store.put('w', sha256Hex(bytes), bytes); assert.deepEqual(await store.get(ref), bytes);
    } finally { await fake.close(); }
});

// ---- 3. store: 401 -> refresh once -> retry once -------------------------------------------------------------------
console.log('\nstore 401 handling');
test('Files API 401: the provider is asked once and the call is retried once; a second 401 is an error, not a loop', async () => {
    let calls = 0; let refreshed = 0;
    const f = (async () => { calls++; return new Response('{}', { status: 401 }); }) as unknown as typeof fetch;
    const store = new GroundfloorBlobStore({ baseUrl: 'http://127.0.0.1:9', filesWorkspaceId: FAKE_WS, token: () => `t${refreshed}`, onUnauthorized: (r) => { refreshed++; assert.equal(r, `t${refreshed - 1}`); }, fetchImpl: f, sleep: noSleep });
    await assert.rejects(store.get(`gf1:abc:${'a'.repeat(64)}`), (e: unknown) => e instanceof GroundfloorBlobError && e.status === 401);
    assert.equal(calls, 2); assert.equal(refreshed, 1);
});
test('without a refresher (static token) a 401 is returned at once, as before', async () => {
    let calls = 0; const f = (async () => { calls++; return new Response('{}', { status: 401 }); }) as unknown as typeof fetch;
    const store = new GroundfloorBlobStore({ baseUrl: 'http://127.0.0.1:9', filesWorkspaceId: FAKE_WS, token: () => 't', fetchImpl: f, sleep: noSleep });
    await assert.rejects(store.has(`gf1:abc:${'a'.repeat(64)}`), /HTTP 401/); assert.equal(calls, 1);
});

// ---- 4. redaction --------------------------------------------------------------------------------------------------
console.log('\nredaction');
test('secret, tokens, response bodies and presigned signatures appear in no log line, error, status() or config dump', async () => {
    const fake = await startFakeGroundfloor({ m2m: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    const errors: unknown[] = [];
    try {
        const cfg = loadIngestHostConfig(baseEnv({ LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET: CLIENT_SECRET }));
        const { logs } = await captureLogs(async () => {
            const store = makeBlobStoreFactory(cfg.blobs, { sleep: noSleep })('ws');
            const bytes = Buffer.from('redaction run'); const ref = await store.put('w', sha256Hex(bytes), bytes); await store.get(ref);
            fake.m2m!.expireAll(); await store.get(ref);                 // 401 -> refresh path
            fake.m2m!.failNext([503, 503, 503, 503, 429]);                // mint failures with a body that tries to echo
            fake.m2m!.expireAll(); await store.get(ref).catch((e) => errors.push(e));
            await store.get(ref).catch((e) => errors.push(e));
        });
        // A client with the wrong secret: 401 from the mint.
        const bad = makeBlobStoreFactory(loadIngestHostConfig(baseEnv({ LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET: `${CLIENT_SECRET}-wrong` })).blobs, { sleep: noSleep })('ws');
        const badLogs = await captureLogs(async () => { await bad.get(`gf1:f1:${'a'.repeat(64)}`).catch((e) => errors.push(e)); });
        const p = new M2mTokenProvider({ tokenUrl: m2mTokenUrlFor(fake.baseUrl, FAKE_WS), ...m2mOpts, clientSecret: () => CLIENT_SECRET, sleep: noSleep });
        await p.get();
        const needles = [CLIENT_SECRET, `${CLIENT_SECRET}-wrong`, 'RESPONSE-BODY-MUST-NOT-LEAK', 'SIGNATURE-SECRET', ...fake.m2m!.issued];
        assert.ok(fake.m2m!.issued.length >= 3 && errors.length >= 2, 'the scenario exercised mint, refresh and failure paths');
        const haystack = [logs, badLogs.logs, ...errors.map((e) => `${(e as Error).message}\n${(e as Error).stack}\n${inspect(e, { depth: 5 })}\n${JSON.stringify(e)}`),
                          JSON.stringify(p.status()), inspect(p), JSON.stringify(cfg), inspect(cfg, { depth: 8 })].join('\n');
        for (const n of needles) assert.ok(!haystack.includes(n), `leaked: ${n.slice(0, 12)}...`);
        assert.ok(haystack.includes('[redacted]'), 'config dump shows the secret as redacted');
        assert.ok(/m2m token request failed/.test(logs), 'the failure itself is logged (status only)');
    } finally { await fake.close(); }
});

// ---- 5. real wire-up through IngestionHost.start --------------------------------------------------------------------
console.log('\nhost wire-up');
const TXT = (tag: string) => Buffer.from(`Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n${tag}\n`);
async function hostRig(env: Record<string, string>, ws: string) {
    const dirOf = (w: string) => { const d = path.join(tmp, 'ws', w); fs.mkdirSync(d, { recursive: true }); return d; };
    const tables = new Map<string, InstanceType<typeof SqliteTableStorage>>();
    const config = loadIngestHostConfig({ LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: ws, LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_DRAIN_MS: '300', ...env } as NodeJS.ProcessEnv);
    const host = await IngestionHost.start({
        config, lore: { nodeUpsert: async () => ({ ok: true }) }, deploymentMode: 'local', home: process.env['LORE_HOME']!,
        listWorkspaces: () => [ws], workspacePath: dirOf, engineFor: () => 'sqlite',
        tableStorageFor: async (w: string) => { let t = tables.get(w); if (!t) { t = new SqliteTableStorage(path.join(dirOf(w), 'tables.db')); tables.set(w, t); } return t as never; },
    } as never);
    return { host, dirOf, stop: () => host.stop() };
}
const gfEnv = (fake: { baseUrl: string }, over: Record<string, string> = {}) => ({
    LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_WORKSPACE_ID: FAKE_WS,
    LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET: CLIENT_SECRET, ...over,
});

test('IngestionHost + env config + real HTTP: upload, read back, token rejected mid-run is refreshed, no restart', async () => {
    const fake = await startFakeGroundfloor({ m2m: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, expiresIn: 300 } });
    const ws = `ws-m2m-${rnd()}`; const r = await hostRig(gfEnv(fake), ws); const m = fake.m2m!;
    try {
        assert.deepEqual(r.host.status().blobs, { store: 'groundfloor', ready: true, retentionDays: null, purged: 0, purgeFailed: 0 });
        const co = await r.host.coordinatorFor(ws);
        const a = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT('a') });
        assert.ok(a.source.storageRef.startsWith('gf1:')); assert.equal(fake.objects.size, 1); assert.equal(m.mints, 1, 'one mint serves the whole upload (init, finalize)');
        assert.deepEqual(await co.deps.blobs.get(a.source.storageRef), TXT('a')); assert.equal(m.mints, 1, 'cached');
        assert.deepEqual(m.bodies[0], { client_id: CLIENT_ID, client_secret: CLIENT_SECRET }); assert.equal(m.contentTypes[0], 'application/json');
        assert.equal((await co.runDue()).succeeded, 1, 'the real extractor read the file back through the Files API');

        // Mid-run: the platform stops accepting the token (expiry/revocation). Next use refreshes once and carries on.
        m.expireAll();
        const b = await co.enqueueFile({ workspace: ws, fileName: 'b.txt', mimeType: 'text/plain', bytes: TXT('b') });
        assert.equal(m.mints, 2); assert.equal(fake.objects.size, 2); assert.deepEqual(await co.deps.blobs.get(b.source.storageRef), TXT('b'));
        assert.deepEqual(await co.deps.blobs.get(a.source.storageRef), TXT('a'));

        // Time-based renewal needs a 30 s+ life now (expires_in is clamped), so it is covered with a fake clock in section 1.
        const c = await co.enqueueFile({ workspace: ws, fileName: 'c.txt', mimeType: 'text/plain', bytes: TXT('c') }); assert.deepEqual(await co.deps.blobs.get(c.source.storageRef), TXT('c'));
        assert.equal(fake.seen.filter((q) => q.path.startsWith('/s3/') || q.path.startsWith('/dl/')).every((q) => !q.hasAuth), true, 'presigned transfers never carry the bearer');
        assert.ok(!fs.existsSync(path.join(r.dirOf(ws), 'ingestion-blobs')), 'nothing was written to the local disk');
    } finally { await r.stop(); await fake.close(); }
});

test('rotation without restart through the real path (hostConfig -> blobStoreFactory -> GroundfloorBlobStore -> real HTTP mint): a rotated _FILE secret is used at the next mint; renewal blip keeps serving', async () => {
    const opts = { clientId: CLIENT_ID, clientSecret: `old-${rnd()}${rnd()}`, expiresIn: 300 };
    const fake = await startFakeGroundfloor({ m2m: opts }); const m = fake.m2m!;
    const f = path.join(tmp, `rot-secret-${rnd()}`); fs.writeFileSync(f, `${opts.clientSecret}\n`, { mode: 0o600 }); fs.chmodSync(f, 0o600);
    try {
        const cfg = loadIngestHostConfig({ LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_WORKSPACE_ID: FAKE_WS, LORE_INGEST_GF_M2M_CLIENT_ID: CLIENT_ID, LORE_INGEST_GF_M2M_CLIENT_SECRET_FILE: f } as NodeJS.ProcessEnv);
        let clock = Date.now(); const store = makeBlobStoreFactory(cfg.blobs, { sleep: noSleep, now: () => clock })('ws');
        const bytes = Buffer.from('rotation run'); const ref = await store.put('w', sha256Hex(bytes), bytes);
        assert.equal(m.mints, 1); assert.equal(m.bodies[0]!['client_secret'], opts.clientSecret);
        // The platform rotates the secret; the operator rewrites the file (different length, so the change is always detected).
        const rotated = `new-${rnd()}${rnd()}-rotated`; opts.clientSecret = rotated; fs.writeFileSync(f, `${rotated}\n`);
        m.expireAll();                                  // the old token is rejected -> 401 -> re-mint with the file's NEW content
        assert.deepEqual(await store.get(ref), bytes);
        assert.equal(m.mints, 2); assert.equal(m.bodies.at(-1)!['client_secret'], rotated, 'the next mint used the rotated secret, no restart');
        // 80% of the token's life passes and the mint endpoint has a blip: the store keeps working on the still-valid token.
        clock += 241_000; const asked = m.bodies.length; m.failNext([503]);
        assert.deepEqual(await store.get(ref), bytes); assert.equal(m.bodies.length, asked + 1, 'the renewal was attempted once'); assert.equal(m.mints, 2, 'and failed; still on the second token');
        assert.deepEqual(await store.get(ref), bytes); assert.equal(m.bodies.length, asked + 1, 'cooldown: not hammered');
        clock += M2M_FAILURE_COOLDOWN_MS + 1; assert.deepEqual(await store.get(ref), bytes); assert.equal(m.mints, 3, 'the next renewal succeeded');
    } finally { await fake.close(); }
});

test('IngestionHost fails closed when static token and m2m are both configured: no workspace opens, nothing contacts the platform, nothing on disk', async () => {
    const fake = await startFakeGroundfloor({ m2m: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    const ws = `ws-m2m-${rnd()}`; let r!: Awaited<ReturnType<typeof hostRig>>;
    try {
        const { logs } = await captureLogs(async () => { r = await hostRig(gfEnv(fake, { LORE_INGEST_GF_TOKEN: 'static-token-VALUE' }), ws); });
        assert.equal(r.host.status().blobs.ready, false);
        await assert.rejects(r.host.coordinatorFor(ws), /blob storage is not configured/);
        assert.match(logs, /mutually exclusive/); assert.ok(!logs.includes(CLIENT_SECRET) && !logs.includes('static-token-VALUE'));
        assert.equal(fake.seen.length, 0); assert.equal(fs.existsSync(path.join(r.dirOf(ws), 'ingestion-blobs')), false);
    } finally { await r?.stop(); await fake.close(); }
});

test('IngestionHost with a wrong secret: uploads fail with a status-only error, no secret anywhere, and the host stays up', async () => {
    const fake = await startFakeGroundfloor({ m2m: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    const ws = `ws-m2m-${rnd()}`; const wrong = `${CLIENT_SECRET}-WRONG`;
    const r = await hostRig(gfEnv(fake, { LORE_INGEST_GF_M2M_CLIENT_SECRET: wrong }), ws);
    try {
        const co = await r.host.coordinatorFor(ws); let err: unknown;
        const { logs } = await captureLogs(async () => { try { await co.enqueueFile({ workspace: ws, fileName: 'x.txt', mimeType: 'text/plain', bytes: TXT('x') }); } catch (e) { err = e; } });
        assert.ok(err instanceof Error); assert.match((err as Error).message, /HTTP 401/);
        for (const s of [CLIENT_SECRET, wrong]) assert.ok(!`${(err as Error).stack}${logs}`.includes(s));
        assert.equal(fake.objects.size, 0);
    } finally { await r.stop(); await fake.close(); }
});

for (const q of queue) await q();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ingestion-gf-m2m: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
