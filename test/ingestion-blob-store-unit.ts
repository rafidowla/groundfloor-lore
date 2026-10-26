#!/usr/bin/env tsx
/**
 * test/ingestion-blob-store-unit.ts - the source-file stores: FsBlobStore hardening and the Groundfloor Files API store,
 * the latter against a local fake HTTP server on an ephemeral port (never a real Groundfloor endpoint). Covers the
 * upload/download/delete contract, retry on 5xx/429 with backoff, sha256 verification on read, timeouts, size caps,
 * redirect refusal, SSRF refusals on server-supplied URLs, and that the token / signed URLs / response bodies never
 * reach an error message. Also the host config + factory (selection, fail-closed).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { FsBlobStore, BlobNotFoundError, sha256Hex } from '../packages/lore/src/ingestion/blobStore.js';
import { GroundfloorBlobStore, GroundfloorBlobError } from '../packages/lore/src/ingestion/groundfloorBlobStore.js';
import { makeBlobStoreFactory } from '../packages/lore/src/ingestion/blobStoreFactory.js';
import { loadIngestHostConfig } from '../packages/lore/src/ingestion/hostConfig.js';
import { startFakeGroundfloor, FAKE_WS, FAKE_TOKEN } from './helpers/fakeGroundfloorFiles.js';

let passed = 0; let failed = 0;
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>): void {
    queue.push(async () => {
        try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-blob-'));
const BYTES = Buffer.from('Unit 4B rent 2400.\nUnit 5A rent 2650.\n');
const SHA = sha256Hex(BYTES);
const fake = await startFakeGroundfloor();
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
const mk = (over: Record<string, unknown> = {}) => new GroundfloorBlobStore({
    baseUrl: fake.baseUrl, filesWorkspaceId: FAKE_WS, token: () => FAKE_TOKEN, sleep, retryBaseMs: 100, ...over,
} as never);
const messageOf = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; } throw new Error('expected a rejection'); };
const SECRETS = [FAKE_TOKEN, 'SIGNATURE-SECRET', 'RESPONSE-BODY-MUST-NOT-LEAK'];
const assertNoSecrets = (s: string) => { for (const x of SECRETS) assert.ok(!s.includes(x), `leaked ${x} in: ${s}`); };

// ---- FsBlobStore -----------------------------------------------------------------------------------------------------
console.log('\nFsBlobStore');
test('round-trips, reports has/delete, and delete is idempotent', async () => {
    const s = new FsBlobStore(path.join(tmp, 'fs1'));
    const ref = await s.put('ws-a', SHA, BYTES);
    assert.deepEqual(await s.get(ref), BYTES);
    assert.equal(await s.has!(ref), true);
    assert.equal(await s.delete!(ref), true);
    assert.equal(await s.has!(ref), false);
    assert.equal(await s.delete!(ref), false, 'second delete is a no-op');
    await assert.rejects(s.get(ref), BlobNotFoundError);
});
test('refuses refs that are not <16 hex>/<64 hex> (path traversal, absolute paths, odd shapes)', async () => {
    const s = new FsBlobStore(path.join(tmp, 'fs2'));
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret');
    for (const bad of ['../outside.txt', '../../etc/passwd', '/etc/passwd', 'a/b', `${'a'.repeat(16)}/../${'b'.repeat(64)}`, `${'A'.repeat(16)}/${'b'.repeat(64)}`, '', `${'a'.repeat(16)}/${'b'.repeat(63)}`, `${'a'.repeat(16)}/${'b'.repeat(64)}\0`]) {
        await assert.rejects(s.get(bad), /./, `get(${JSON.stringify(bad)})`);
        await assert.rejects(Promise.resolve().then(() => s.delete!(bad)), /./, `delete(${JSON.stringify(bad)})`);
    }
    assert.equal(fs.readFileSync(path.join(tmp, 'outside.txt'), 'utf8'), 'secret');
});
test('put refuses a sha that is not hex or does not match the bytes', async () => {
    const s = new FsBlobStore(path.join(tmp, 'fs3'));
    await assert.rejects(s.put('w', '../x', BYTES), /sha/i);
    await assert.rejects(s.put('w', 'b'.repeat(64), BYTES), /sha/i);
});

// ---- GroundfloorBlobStore ----------------------------------------------------------------------------------------------
console.log('\nGroundfloorBlobStore');
test('put then get: documented call sequence, bearer on control calls only, presigned calls carry no auth', async () => {
    fake.reset(); const s = mk();
    const ref = await s.put('ws-a', SHA, BYTES);
    assert.match(ref, /^gf1:f\d+:[0-9a-f]{64}$/);
    assert.deepEqual(await s.get(ref), BYTES);
    const base = `/v1/workspaces/${FAKE_WS}/files`;
    assert.deepEqual(fake.seen.map((r) => `${r.method} ${r.path.replace(/f\d+/, 'ID')}`), [
        `POST ${base}/upload-url`, 'PUT /s3/ID', `POST ${base}/ID/finalize`, `GET ${base}/ID/download-url`, 'GET /dl/ID',
    ]);
    for (const r of fake.seen) assert.equal(r.hasAuth, r.path.startsWith(base), `${r.method} ${r.path} auth=${r.hasAuth}`);
    assert.equal(fake.seen[0]!.auth, `Bearer ${FAKE_TOKEN}`);
    assert.equal(fake.seen[1]!.bytes, BYTES.length);
});
test('delete soft-deletes like real stage: has() is false and get() is not-found afterwards (409), repeat delete is fine', async () => {
    fake.reset(); const s = mk();
    const ref = await s.put('ws-a', SHA, BYTES);
    assert.equal(await s.has(ref), true);
    assert.equal(await s.delete(ref), true);
    assert.equal(await s.has(ref), false);
    await assert.rejects(s.get(ref), BlobNotFoundError);
    assert.equal(await s.delete(ref), true); // the server answers 200 for an already-deleted file
});
test('a file id that never existed (404): has() and delete() are false, get() is not-found', async () => {
    const s = mk(); const ref = `gf1:f999999:${SHA}`;
    assert.equal(await s.has(ref), false);
    assert.equal(await s.delete(ref), false);
    await assert.rejects(s.get(ref), BlobNotFoundError);
});
test('any other 409 on a control call is still an error, not a silent not-found', async () => {
    fake.reset(); const s = mk();
    fake.fail('upload-url', [409]);
    await assert.rejects(s.put('ws-a', SHA, BYTES), (e: unknown) => e instanceof GroundfloorBlobError && e.status === 409);
});
test('get verifies the sha256: a corrupted or swapped object is refused', async () => {
    fake.reset(); const s = mk();
    const ref = await s.put('ws-a', SHA, BYTES);
    fake.corrupt(ref.split(':')[1]!, Buffer.from('tampered'));
    assert.match(await messageOf(s.get(ref)), /sha256/);
});
test('put refuses bytes that do not match the sha it was given', async () => {
    await assert.rejects(mk().put('w', 'c'.repeat(64), BYTES), /sha/i);
});
test('retries 5xx and 429 on control calls with backoff, honouring Retry-After', async () => {
    fake.reset(); sleeps.length = 0; const s = mk();
    fake.fail('upload-url', [503, 502]);
    const ref = await s.put('ws-a', SHA, BYTES);
    assert.equal(fake.calls('upload-url'), 3);
    assert.deepEqual(sleeps, [100, 200], 'exponential from retryBaseMs');
    sleeps.length = 0; fake.fail('download-url', [429], { 'retry-after': '2' });
    assert.deepEqual(await s.get(ref), BYTES);
    assert.deepEqual(sleeps, [2000], 'Retry-After wins');
});
test('retries the presigned upload and download on 5xx too', async () => {
    fake.reset(); sleeps.length = 0; const s = mk();
    fake.fail('put', [500]); fake.fail('get', [503]);
    const ref = await s.put('ws-a', SHA, BYTES);
    assert.equal(fake.calls('put'), 2);
    assert.deepEqual(await s.get(ref), BYTES);
    assert.equal(fake.calls('get'), 2);
});
test('gives up after maxRetries with a typed error that names the status only', async () => {
    fake.reset(); const s = mk({ maxRetries: 2 });
    fake.fail('upload-url', [500, 500, 500, 500]);
    const m = await messageOf(s.put('ws-a', SHA, BYTES));
    assert.match(m, /GroundfloorBlobError: upload-init failed with HTTP 500/);
    assert.equal(fake.calls('upload-url'), 3, '1 try + 2 retries');
    assertNoSecrets(m);
});
test('does not retry other 4xx (401/403) and surfaces the status', async () => {
    fake.reset(); const s = mk();
    fake.fail('upload-url', [403, 403]);
    try { await s.put('ws-a', SHA, BYTES); assert.fail('should throw'); } catch (e) { assert.ok(e instanceof GroundfloorBlobError); assert.equal(e.status, 403); assert.equal(e.retryable, false); }
    assert.equal(fake.calls('upload-url'), 1);
    const wrong = mk({ token: () => 'a-wrong-token' });
    assert.match(await messageOf(wrong.put('ws-a', SHA, BYTES)), /HTTP 401/);
});
test('a failed upload removes the half-made file and rethrows', async () => {
    fake.reset(); const s = mk({ maxRetries: 0 });
    fake.objects.clear(); fake.fail('put', [500]);
    await assert.rejects(s.put('ws-a', SHA, BYTES), /upload transfer failed with HTTP 500/);
    assert.equal(fake.calls('delete'), 1, 'cleanup DELETE issued');
    assert.equal(fake.objects.size, 0);
});
test('a failed finalize also cleans up', async () => {
    fake.reset(); const s = mk({ maxRetries: 0 });
    fake.objects.clear(); fake.fail('finalize', [500]);
    await assert.rejects(s.put('ws-a', SHA, BYTES), /finalize failed with HTTP 500/);
    assert.equal(fake.objects.size, 0);
});
test('a request that never answers times out instead of hanging', async () => {
    fake.reset(); const s = mk({ timeoutMs: 150, maxRetries: 0 });
    fake.fail('upload-url', [0]);
    const t0 = Date.now();
    assert.match(await messageOf(s.put('ws-a', SHA, BYTES)), /upload-init failed/);
    assert.ok(Date.now() - t0 < 3000);
});
test('size caps: oversize upload refused before any request; oversize download body refused while streaming', async () => {
    fake.reset();
    await assert.rejects(mk({ maxBytes: 10 }).put('ws-a', SHA, BYTES), /exceeds the configured limit/);
    assert.equal(fake.seen.length, 0, 'nothing was sent');
    const ref = await mk().put('ws-a', SHA, BYTES);
    await assert.rejects(mk({ maxBytes: 10 }).get(ref), /exceeds the configured limit/);
});
test('redirects are not followed, so a presigned URL cannot bounce the client elsewhere', async () => {
    fake.reset(); const s = mk({ maxRetries: 0 });
    const ref = await s.put('ws-a', SHA, BYTES);
    fake.fail('get', ['redirect']);
    const m = await messageOf(s.get(ref));
    assert.match(m, /GroundfloorBlobError/); assertNoSecrets(m);
    assert.ok(!fake.seen.some((r) => r.path === '/elsewhere'));
});
test('the token, signed URLs and response bodies never appear in any error', async () => {
    fake.reset(); const s = mk({ maxRetries: 0 });
    const ref = await s.put('ws-a', SHA, BYTES);
    for (const [route, call] of [
        ['upload-url', () => s.put('ws-a', SHA, BYTES)], ['download-url', () => s.get(ref)], ['get', () => s.get(ref)], ['delete', () => s.delete(ref)],
    ] as const) {
        fake.fail(route, [500]);
        assertNoSecrets(await messageOf(call()));
    }
});
test('refs: only gf1:<id>:<sha> is accepted (no path or URL smuggling)', async () => {
    const s = mk();
    for (const bad of ['', 'gf1:../x:' + SHA, 'gf1:a/b:' + SHA, 'gf1:f1:short', 'http://evil/x', `gf1:f1:${SHA}/extra`, 'ab/' + SHA]) {
        await assert.rejects(s.get(bad), /reference/, bad); await assert.rejects(s.delete(bad), /reference/, bad);
    }
    assert.equal(fake.seen.filter((r) => r.path.includes('..')).length, 0);
});

// ---- SSRF: server-supplied URLs are untrusted ---------------------------------------------------------------------------
console.log('\nSSRF');
function stubFetch(first: unknown) {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
        calls.push(String(url));
        if (calls.length === 1) return new Response(JSON.stringify(first), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}
for (const [label, url] of [
    ['cloud metadata IP', 'https://169.254.169.254/latest/meta-data'], ['private IPv4', 'https://10.0.0.5/x'], ['loopback IPv4', 'https://127.0.0.1/x'],
    ['loopback name', 'https://localhost/x'], ['IPv6 loopback', 'https://[::1]/x'], ['plain http', 'http://files.example.invalid/x'],
    ['embedded credentials', 'https://user:pw@files.example.invalid/x'], ['not a URL', 'nope'],
] as const) {
    test(`a non-loopback deployment refuses an upload URL that is ${label}`, async () => {
        const { calls, fetchImpl } = stubFetch({ upload_url: url, file: { id: 'f1' } });
        const s = new GroundfloorBlobStore({ baseUrl: 'https://platform.example.invalid', filesWorkspaceId: FAKE_WS, token: () => FAKE_TOKEN, fetchImpl, sleep, maxRetries: 0 });
        await assert.rejects(s.put('ws-a', SHA, BYTES), /GroundfloorBlobError|upload-url/);
        assert.ok(!calls.includes(url), `the bad URL was fetched: ${calls.join(' ')}`);
        assert.equal(calls.filter((c) => c !== 'https://platform.example.invalid/v1/workspaces/gf-ws-test/files/upload-url' && !c.endsWith('/DELETE') && !c.includes('/files/f1')).length, 0);
    });
}
test('the operator base URL is validated: https only (loopback http allowed), no credentials, sane workspace id', () => {
    const ok = { filesWorkspaceId: FAKE_WS, token: () => 't' };
    assert.throws(() => new GroundfloorBlobStore({ ...ok, baseUrl: 'http://platform.example.invalid' }), /https/);
    assert.throws(() => new GroundfloorBlobStore({ ...ok, baseUrl: 'https://u:p@platform.example.invalid' }), /credentials/);
    assert.throws(() => new GroundfloorBlobStore({ ...ok, baseUrl: 'ftp://x' }), /https/);
    assert.throws(() => new GroundfloorBlobStore({ ...ok, baseUrl: 'not a url' }), /valid URL/);
    assert.throws(() => new GroundfloorBlobStore({ ...ok, baseUrl: 'https://platform.example.invalid', filesWorkspaceId: '../x' }), /workspace id/);
    new GroundfloorBlobStore({ ...ok, baseUrl: 'http://127.0.0.1:1' }); new GroundfloorBlobStore({ ...ok, baseUrl: 'https://platform.example.invalid/' });
});

// ---- host config + factory -----------------------------------------------------------------------------------------------
console.log('\nconfig + factory');
const cfg = (env: Record<string, string>) => loadIngestHostConfig({ LORE_INGEST_ENABLED: '1', ...env } as NodeJS.ProcessEnv).blobs;
test('defaults: local disk, retention off', () => {
    const b = cfg({}); assert.equal(b.store, 'fs'); assert.equal(b.retentionDays, null); assert.equal(b.retentionInvalid, false);
    assert.ok(makeBlobStoreFactory(b)(path.join(tmp, 'w1')) instanceof FsBlobStore);
});
test('LORE_INGEST_BLOB_RETENTION_DAYS: positive numbers enable; 0/blank are off; junk is off AND flagged', () => {
    assert.equal(cfg({ LORE_INGEST_BLOB_RETENTION_DAYS: '30' }).retentionDays, 30);
    assert.equal(cfg({ LORE_INGEST_BLOB_RETENTION_DAYS: '0.5' }).retentionDays, 0.5);
    for (const off of ['0', '', '  ']) { const b = cfg({ LORE_INGEST_BLOB_RETENTION_DAYS: off }); assert.equal(b.retentionDays, null); assert.equal(b.retentionInvalid, false); }
    for (const bad of ['-1', 'soon', 'NaN', '99999', '1e9', 'Infinity']) { const b = cfg({ LORE_INGEST_BLOB_RETENTION_DAYS: bad }); assert.equal(b.retentionDays, null, bad); assert.equal(b.retentionInvalid, true, bad); }
});
test('groundfloor selection builds the API store; the token is a redacted Secret and can come from a file', () => {
    const f = path.join(tmp, 'tok'); fs.writeFileSync(f, `${FAKE_TOKEN}\n`);
    const b = cfg({ LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_WORKSPACE_ID: FAKE_WS, LORE_INGEST_GF_TOKEN_FILE: f });
    assert.equal(b.store, 'groundfloor'); assert.equal(b.groundfloor.token!.reveal(), FAKE_TOKEN);
    assert.ok(!JSON.stringify(b).includes(FAKE_TOKEN)); assert.ok(JSON.stringify(b).includes('[redacted]'));
    assert.ok(makeBlobStoreFactory(b)('/ignored') instanceof GroundfloorBlobStore);
});
test('LORE_INGEST_GF_TOKEN_FILE is re-read when it changes, so a short-lived token can rotate without a restart', async () => {
    const f = path.join(tmp, 'tok-rotate'); fs.writeFileSync(f, 'old-token-value\n');
    const b = cfg({ LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_WORKSPACE_ID: FAKE_WS, LORE_INGEST_GF_TOKEN_FILE: f });
    const s = makeBlobStoreFactory(b)('/ignored');
    fake.reset();
    await assert.rejects(s.put('ws-a', SHA, BYTES), (e: unknown) => e instanceof GroundfloorBlobError && e.status === 401);
    fs.writeFileSync(f, `${FAKE_TOKEN}\n`); const t = new Date(Date.now() + 5_000); fs.utimesSync(f, t, t);
    const ref = await s.put('ws-a', SHA, BYTES);
    assert.deepEqual(await s.get(ref), BYTES);
    fs.rmSync(f); // a vanished file keeps the last good token rather than failing every call
    assert.equal(await s.has!(ref), true);
    assert.ok(!inspect(b).includes(FAKE_TOKEN) && !JSON.stringify(b).includes(FAKE_TOKEN));
});
test('fail closed: unknown store name or incomplete groundfloor settings throw (names only, never values) instead of using disk', () => {
    assert.throws(() => makeBlobStoreFactory(cfg({ LORE_INGEST_BLOB_STORE: 'groundflor' })), /unrecognised/);
    const partial = cfg({ LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_TOKEN: FAKE_TOKEN });
    try { makeBlobStoreFactory(partial); assert.fail('should throw'); } catch (e) {
        const m = (e as Error).message; assert.match(m, /LORE_INGEST_GF_API_URL/); assert.match(m, /LORE_INGEST_GF_WORKSPACE_ID/); assert.ok(!m.includes(FAKE_TOKEN));
    }
    assert.throws(() => makeBlobStoreFactory(cfg({ LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: 'http://platform.example.invalid', LORE_INGEST_GF_WORKSPACE_ID: 'w', LORE_INGEST_GF_TOKEN: 't' })), /https/);
});

for (const q of queue) await q();
await fake.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ingestion-blob-store: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
