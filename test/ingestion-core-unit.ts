#!/usr/bin/env tsx
/**
 * test/ingestion-core-unit.ts — ingestion coordinator slice 1: contracts, job ids,
 * policy, SSRF allowlist, callback authentication, SQLite job store, registry.
 * Hermetic: temp dirs only, no network.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CONTRACT_A_VERSION, CONTRACT_B_VERSION, contractMajor, DEFAULT_POLICY, normalizePolicy, PolicyViolationError, assertProcessorAllowed,
    makeAllowlist, assertEndpointAllowed, EndpointNotAllowedError, makeJobId, makeSourceId, computeBackoffMs,
    verifyCallback, signLoreHmac, signStandardWebhook, jobBearerToken, ProcessorRegistry, NoProcessorError,
    LocalExtractProcessor, DEFAULT_DELIVERY_RETENTION_DAYS, type ProcessorInfo, type IExtractProcessor, type IIngestionStore,
} from '../packages/lore/src/ingestion/index.js';
import { ingestionBackends, type StoreHandle } from './helpers/ingestionBackends.js';

let passed = 0; let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ok  ${name}`); passed++; }
        catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-core-'));
const T0 = new Date('2026-10-23T12:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const hostedInfo: ProcessorInfo = { id: 'h', kind: 'extract', locality: 'hosted', version: '1' };
const localInfo: ProcessorInfo = { id: 'l', kind: 'extract', locality: 'local', version: '1' };

// ── contracts + ids ───────────────────────────────────────────────────────
test('contract versions are major-compatible only', () => {
    assert.equal(contractMajor(CONTRACT_A_VERSION), contractMajor('extract.v1'));
    assert.notEqual(contractMajor('extract.v2'), contractMajor(CONTRACT_A_VERSION));
    assert.ok(CONTRACT_B_VERSION.startsWith('structure.'));
});
test('job ids are deterministic and sensitive to every input', () => {
    const base = { workspace: 'w', sourceId: 's', stage: 'extract' as const, processorId: 'p', contractVersion: 'extract.v1' };
    assert.equal(makeJobId(base), makeJobId({ ...base }));
    assert.equal(makeJobId({ ...base, params: { a: 1, b: 2 } }), makeJobId({ ...base, params: { b: 2, a: 1 } }), 'param key order must not matter');
    for (const v of [{ workspace: 'x' }, { sourceId: 'x' }, { stage: 'structure' as const }, { processorId: 'x' }, { contractVersion: 'extract.v2' }, { parentJobId: 'j' }, { params: { a: 1 } }]) {
        assert.notEqual(makeJobId({ ...base, ...v }), makeJobId(base));
    }
    assert.match(makeJobId(base), /^job_[0-9a-f]{32}$/);
    assert.notEqual(makeSourceId('w1', 'aa'), makeSourceId('w2', 'aa'), 'same bytes in two workspaces are two sources');
});
test('backoff is exponential and capped', () => {
    const o = { baseMs: 1000, maxMs: 10_000 };
    assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => computeBackoffMs(n, o)), [1000, 2000, 4000, 8000, 10_000, 10_000]);
});

// ── policy ────────────────────────────────────────────────────────────────
test('default policy is local-only and unknown values fail closed', () => {
    assert.equal(DEFAULT_POLICY, 'local-only');
    for (const v of [undefined, null, '', 'HOSTED-ALLOWED', 'hosted', 1, {}]) assert.equal(normalizePolicy(v), 'local-only');
    assert.equal(normalizePolicy('hosted-allowed'), 'hosted-allowed');
});
test('local-only refuses hosted processors; hosted-allowed admits them; local always allowed', () => {
    assert.throws(() => assertProcessorAllowed('w', 'local-only', hostedInfo), PolicyViolationError);
    assert.doesNotThrow(() => assertProcessorAllowed('w', 'hosted-allowed', hostedInfo));
    assert.doesNotThrow(() => assertProcessorAllowed('w', 'local-only', localInfo));
});

// ── SSRF allowlist ────────────────────────────────────────────────────────
test('allowlist accepts only exact configured origins', () => {
    const a = makeAllowlist(['https://ai.example.com', 'http://127.0.0.1:9000']);
    assert.equal(assertEndpointAllowed(a, 'https://ai.example.com/v1/extract'), 'https://ai.example.com/v1/extract');
    assert.doesNotThrow(() => assertEndpointAllowed(a, 'http://127.0.0.1:9000/x'));
    for (const bad of [
        'https://evil.example.com/', 'https://ai.example.com.evil.com/', 'http://ai.example.com/', 'https://ai.example.com:8443/',
        'http://169.254.169.254/latest/meta-data', 'http://localhost:9000/', 'file:///etc/passwd', 'ftp://ai.example.com/',
        'https://user:pw@ai.example.com/', 'not a url', '', 'https://ai.example.com@evil.com/',
    ]) assert.throws(() => assertEndpointAllowed(a, bad), EndpointNotAllowedError, bad);
});
test('empty allowlist rejects everything', () => {
    assert.throws(() => assertEndpointAllowed(makeAllowlist([]), 'https://ai.example.com/'), EndpointNotAllowedError);
});

// ── callback authentication ───────────────────────────────────────────────
const master = Buffer.alloc(32, 7);
const cfg = { masterSecret: master, webhookSecret: 'whsec_' + Buffer.from('shared-webhook-secret-bytes-000000').toString('base64'), replayWindowSec: 300 };
const body = Buffer.from(JSON.stringify({ data: { requestID: 'job_1' } }));
const nowSec = Math.floor(T0.getTime() / 1000);

test('lore-hmac: valid signature verifies; delivery id returned', () => {
    const h = { 'x-lore-timestamp': String(nowSec), 'x-lore-signature': signLoreHmac(master, 'job_1', nowSec, body), 'x-lore-delivery-id': 'd1' };
    const r = verifyCallback('lore-hmac', cfg, 'job_1', h, body, T0);
    assert.deepEqual(r, { ok: true, deliveryId: 'd1' });
});
test('lore-hmac: tampered body, wrong job id, wrong secret all fail', () => {
    const h = { 'x-lore-timestamp': String(nowSec), 'x-lore-signature': signLoreHmac(master, 'job_1', nowSec, body) };
    assert.equal(verifyCallback('lore-hmac', cfg, 'job_1', h, Buffer.from(body.toString() + ' '), T0).ok, false);
    assert.equal(verifyCallback('lore-hmac', cfg, 'job_2', h, body, T0).ok, false, 'signature is bound to the job id');
    assert.equal(verifyCallback('lore-hmac', { ...cfg, masterSecret: Buffer.alloc(32, 8) }, 'job_1', h, body, T0).ok, false);
});
test('replay window: stale and future timestamps are rejected, edges accepted', () => {
    const mk = (ts: number) => ({ 'x-lore-timestamp': String(ts), 'x-lore-signature': signLoreHmac(master, 'job_1', ts, body) });
    assert.equal(verifyCallback('lore-hmac', cfg, 'job_1', mk(nowSec - 301), body, T0).ok, false);
    assert.equal(verifyCallback('lore-hmac', cfg, 'job_1', mk(nowSec + 301), body, T0).ok, false);
    assert.equal(verifyCallback('lore-hmac', cfg, 'job_1', mk(nowSec - 299), body, T0).ok, true);
    assert.equal(verifyCallback('lore-hmac', cfg, 'job_1', mk(nowSec + 299), body, T0).ok, true);
    const r = verifyCallback('lore-hmac', cfg, 'job_1', mk(nowSec - 301), body, T0);
    assert.ok(!r.ok && r.reason === 'outside_replay_window');
});
test('malformed or missing headers fail without throwing', () => {
    for (const h of [{}, { 'x-lore-timestamp': 'abc', 'x-lore-signature': 'v1=00' }, { 'x-lore-timestamp': String(nowSec) }, { 'x-lore-timestamp': '1e10', 'x-lore-signature': 'x' }]) {
        assert.equal(verifyCallback('lore-hmac', cfg, 'job_1', h as never, body, T0).ok, false);
    }
});
test('standard-webhooks: valid, multi-signature header, wrong secret, stale', () => {
    const sig = signStandardWebhook(cfg.webhookSecret, 'msg_1', nowSec, body);
    const h = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(nowSec), 'webhook-signature': 'v1,AAAA ' + sig };
    assert.deepEqual(verifyCallback('standard-webhooks', cfg, 'job_1', h, body, T0), { ok: true, deliveryId: 'msg_1' });
    assert.equal(verifyCallback('standard-webhooks', { ...cfg, webhookSecret: 'other-secret-0000000000000000000000' }, 'job_1', h, body, T0).ok, false);
    assert.equal(verifyCallback('standard-webhooks', cfg, 'job_1', h, body, at(1000)).ok, false);
    assert.equal(verifyCallback('standard-webhooks', { ...cfg, webhookSecret: undefined }, 'job_1', h, body, T0).ok, false);
});
test('bearer: per-job token verifies for its job only', () => {
    const tok = jobBearerToken(master, 'job_1');
    assert.equal(verifyCallback('bearer', cfg, 'job_1', { authorization: `Bearer ${tok}` }, body, T0).ok, true);
    assert.equal(verifyCallback('bearer', cfg, 'job_2', { authorization: `Bearer ${tok}` }, body, T0).ok, false);
    assert.equal(verifyCallback('bearer', cfg, 'job_1', { authorization: 'Bearer nope' }, body, T0).ok, false);
    assert.equal(verifyCallback('bearer', cfg, 'job_1', {}, body, T0).ok, false);
});
test('master secret shorter than 32 bytes is refused', () => {
    assert.throws(() => verifyCallback('bearer', { ...cfg, masterSecret: Buffer.alloc(16) }, 'job_1', {}, body, T0));
    void createHmac;
});

// ── job store contract (sqlite always; postgres when LORE_PG_URL is set) ──
const bk = await ingestionBackends(tmp, 'ingestion-core');
const srcArgs = (ws: string, sha = 'a'.repeat(64)) => ({ workspace: ws, fileName: 'f.txt', mimeType: 'text/plain', sha256: sha, sizeBytes: 3, storageRef: 'ref' });
const newJob = (ws: string, sourceId: string) => ({ workspace: ws, sourceId, stage: 'extract' as const, processorId: 'p', contractVersion: CONTRACT_A_VERSION, maxAttempts: 3 });

for (const b of bk.list) {
const t = (name: string, fn: (s: IIngestionStore, ws: string, h: StoreHandle) => Promise<void>) =>
    test(`store[${b.name}]: ${name}`, async () => { const h = await b.open(); try { await fn(h.store, h.ws, h); } finally { await h.store.close(); } });

t('upsertSource and createJob are idempotent', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws)); const b2 = await s.upsertSource(srcArgs(ws));
    assert.equal(a.sourceId, b2.sourceId);
    const c = await s.upsertSource(srcArgs(ws, 'b'.repeat(64)));
    assert.notEqual(c.sourceId, a.sourceId);
    assert.deepEqual(await s.getSource(ws, a.sourceId), a);
    const j1 = await s.createJob(newJob(ws, a.sourceId), T0); const j2 = await s.createJob(newJob(ws, a.sourceId), at(5));
    assert.equal(j1.created, true); assert.equal(j2.created, false); assert.equal(j1.job.jobId, j2.job.jobId);
    assert.equal((await s.listJobs(ws)).length, 1);
    assert.equal(await s.getJob('job_missing'), undefined);
});
t('job round-trips params, parent, times and result as JSON', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws));
    const params = { structure: { processorId: 'x', itemPath: 'units', nested: [1, { k: 'v' }] } };
    const { job } = await s.createJob({ ...newJob(ws, a.sourceId), params, parentJobId: 'job_parent' }, T0);
    assert.deepEqual(job.params, params); assert.equal(job.parentJobId, 'job_parent');
    assert.equal(job.state, 'queued'); assert.equal(job.attempts, 0); assert.equal(job.maxAttempts, 3);
    assert.equal(new Date(job.nextAttemptAt).getTime(), T0.getTime()); assert.equal(job.result, null); assert.equal(job.completedAt, null);
    await s.claimDue(T0, 1);
    assert.equal(await s.markSucceeded(job.jobId, { pages: [{ n: 1, text: 'hi' }], ok: true }, at(3)), true);
    const done = (await s.getJob(job.jobId))!;
    assert.deepEqual(done.result, { pages: [{ n: 1, text: 'hi' }], ok: true });
    assert.equal(new Date(done.completedAt!).getTime(), at(3).getTime());
    await s.markResultsWritten(job.jobId, at(4));
    assert.equal(new Date((await s.getJob(job.jobId))!.resultsWrittenAt!).getTime(), at(4).getTime());
});
t('claimDue is exclusive, honours due time and limit', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws));
    const { job } = await s.createJob(newJob(ws, a.sourceId), T0);
    assert.equal((await s.claimDue(at(-10), 5)).length, 0, 'not yet due');
    const [first, second] = await Promise.all([s.claimDue(T0, 5), s.claimDue(T0, 5)]);
    assert.equal(first.length + second.length, 1, 'exactly one claimer wins');
    assert.equal((await s.getJob(job.jobId))!.state, 'running');
    const more = [];
    for (let i = 0; i < 4; i++) more.push((await s.createJob({ ...newJob(ws, a.sourceId), params: { i } }, at(i))).job.jobId);
    const got = await s.claimDue(at(10), 3);
    assert.equal(got.length, 3, 'limit honoured'); assert.deepEqual(got.map((j) => j.jobId), more.slice(0, 3), 'oldest due first');
});
t('transient failure backs off then dead-letters at maxAttempts; permanent failure dead-letters at once', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws));
    const { job } = await s.createJob(newJob(ws, a.sourceId), T0);
    const bo = { baseMs: 1000, maxMs: 60_000 };
    await s.claimDue(T0, 1);
    let j = (await s.recordFailure(job.jobId, 'boom', true, T0, bo))!;
    assert.equal(j.state, 'queued'); assert.equal(j.attempts, 1);
    assert.equal(new Date(j.nextAttemptAt).getTime(), T0.getTime() + 1000);
    assert.equal((await s.claimDue(T0, 1)).length, 0, 'waits for backoff');
    await s.claimDue(at(1), 1);
    j = (await s.recordFailure(job.jobId, 'boom', true, at(1), bo))!;
    assert.equal(new Date(j.nextAttemptAt).getTime(), at(1).getTime() + 2000);
    await s.claimDue(at(10), 1);
    j = (await s.recordFailure(job.jobId, 'boom', true, at(10), bo))!;
    assert.equal(j.state, 'dead_letter'); assert.equal(j.lastError, 'boom');
    assert.equal((await s.recordFailure(job.jobId, 'late', true, at(11), bo))!.attempts, 3, 'a dead letter ignores further failures');
    assert.equal(await s.requeueDeadLetter(job.jobId, at(20)), true);
    j = (await s.getJob(job.jobId))!; assert.equal(j.state, 'queued'); assert.equal(j.attempts, 0);
    await s.claimDue(at(20), 1);
    j = (await s.recordFailure(job.jobId, 'bad input', false, at(20), bo))!;
    assert.equal(j.state, 'dead_letter', 'non-retryable goes straight to dead-letter');
    assert.equal(await s.requeueDeadLetter('job_missing', T0), false);
    assert.equal(await s.recordFailure('job_missing', 'x', true, T0), undefined);
});
t('markSucceeded is once-only; terminal jobs are not claimable; stale awaiting listed', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws));
    const { job } = await s.createJob(newJob(ws, a.sourceId), T0);
    await s.claimDue(T0, 1);
    await s.markAwaitingCallback(job.jobId, 'remote-1', T0);
    assert.equal((await s.getJob(job.jobId))!.remoteRequestId, 'remote-1');
    assert.equal((await s.listStaleAwaiting(at(-1), 10)).length, 0);
    assert.equal((await s.listStaleAwaiting(at(60), 10)).length, 1);
    assert.equal(await s.markSucceeded(job.jobId, { x: 1 }, at(1)), true);
    assert.equal(await s.markSucceeded(job.jobId, { x: 2 }, at(2)), false);
    assert.deepEqual((await s.getJob(job.jobId))!.result, { x: 1 });
    assert.equal((await s.claimDue(at(100), 5)).length, 0);
    assert.equal((await s.listStaleAwaiting(at(600), 10)).length, 0);
});
t('a late duplicate callback cannot flip a dead letter or move a succeeded job', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws));
    const { job } = await s.createJob({ ...newJob(ws, a.sourceId), maxAttempts: 1 }, T0);
    await s.claimDue(T0, 1);
    await s.recordFailure(job.jobId, 'timeout', true, at(1));
    assert.equal((await s.getJob(job.jobId))!.state, 'dead_letter');
    assert.equal(await s.markSucceeded(job.jobId, { late: true }, at(2)), false, 'dead letter stays dead');
    await s.markAwaitingCallback(job.jobId, 'late-remote', at(3));
    const j = (await s.getJob(job.jobId))!;
    assert.equal(j.state, 'dead_letter'); assert.equal(j.result, null); assert.equal(j.remoteRequestId, null);
});
t('delivery ids dedupe per job; pending records are idempotent; old deliveries purge in bounded batches', async (s, ws) => {
    const a = await s.upsertSource(srcArgs(ws));
    const { job } = await s.createJob(newJob(ws, a.sourceId), T0);
    assert.equal(await s.recordDelivery(job.jobId, 'd1', T0), true);
    assert.equal(await s.recordDelivery(job.jobId, 'd1', T0), false);
    assert.equal(await s.recordDelivery(job.jobId, 'd2', T0), true);
    const p = { jobId: job.jobId, workspace: ws, sourceId: a.sourceId, reason: 'tables_unavailable', payload: { content: { a: 1 } } };
    await s.recordPending(p, T0); await s.recordPending({ ...p, reason: 'second' }, at(1));
    assert.equal((await s.listPending(ws)).length, 1);
    assert.deepEqual((await s.listPending(ws))[0]!.payload, { content: { a: 1 } });
    assert.equal((await s.listPending(ws))[0]!.reason, 'second', 'a second record replaces the first');
    await s.clearPending(job.jobId);
    assert.equal((await s.listPending(ws)).length, 0);
    // retention: d1/d2 were seen at T0; 3 more are seen 40 days later
    const day = 86_400_000; const later = new Date(T0.getTime() + 40 * day);
    for (const d of ['n1', 'n2', 'n3']) assert.equal(await s.recordDelivery(job.jobId, d, later), true);
    const now = new Date(T0.getTime() + 41 * day);
    assert.equal(await s.purgeOldDeliveries(now, { retentionDays: 30, limit: 1 }), 1, 'bounded by limit');
    assert.equal(await s.purgeOldDeliveries(now, { retentionDays: 30 }), 1, 'the rest of the old rows');
    assert.equal(await s.purgeOldDeliveries(now, { retentionDays: 30 }), 0, 'recent rows are kept');
    assert.equal(await s.recordDelivery(job.jobId, 'd1', now), true, 'a purged id is forgotten');
    assert.equal(await s.recordDelivery(job.jobId, 'n1', now), false, 'a retained id still blocks replay');
    const prev = process.env['LORE_INGEST_DELIVERY_RETENTION_DAYS'];
    try {
        process.env['LORE_INGEST_DELIVERY_RETENTION_DAYS'] = '1';
        assert.equal(await s.purgeOldDeliveries(new Date(later.getTime() + 2 * day)), 3, 'env sets the default window');
        process.env['LORE_INGEST_DELIVERY_RETENTION_DAYS'] = 'banana';
        await assert.rejects(s.purgeOldDeliveries(now), /LORE_INGEST_DELIVERY_RETENTION_DAYS/);
    } finally { if (prev === undefined) delete process.env['LORE_INGEST_DELIVERY_RETENTION_DAYS']; else process.env['LORE_INGEST_DELIVERY_RETENTION_DAYS'] = prev; }
    assert.equal(DEFAULT_DELIVERY_RETENTION_DAYS, 30);
});
t('state survives reopen', async (s, ws, h) => {
    const a = await s.upsertSource(srcArgs(ws));
    const { job } = await s.createJob(newJob(ws, a.sourceId), T0); await s.close();
    const s2 = await h.reopen();
    try { assert.equal((await s2.getJob(job.jobId))!.sourceId, a.sourceId); } finally { await s2.close(); }
});
}

// ── registry ──────────────────────────────────────────────────────────────
const fakeHosted = (mimes: string[]): IExtractProcessor => ({ info: { ...hostedInfo, kind: 'extract' as const }, supports: (m) => mimes.includes(m), extract: async () => { throw new Error('unused'); } });
test('registry: local preferred; hosted only when allowed and no local support; explicit id is policy-checked', () => {
    const r = new ProcessorRegistry();
    r.registerExtract(new LocalExtractProcessor());
    r.registerExtract(fakeHosted(['text/plain', 'application/x-hosted-only']), { callbackScheme: 'bearer' });
    assert.equal(r.selectExtract('w', 'hosted-allowed', 'text/plain').info.locality, 'local', 'local wins even when hosted is allowed');
    assert.throws(() => r.selectExtract('w', 'local-only', 'application/x-hosted-only'), PolicyViolationError);
    assert.equal(r.selectExtract('w', 'hosted-allowed', 'application/x-hosted-only').info.id, 'h');
    assert.throws(() => r.selectExtract('w', 'local-only', 'text/plain', 'h'), PolicyViolationError);
    assert.throws(() => r.selectExtract('w', 'hosted-allowed', 'video/x-unknown'), NoProcessorError);
    assert.throws(() => r.selectExtract('w', 'hosted-allowed', 'text/plain', 'nope'), NoProcessorError);
    assert.equal(r.callbackScheme('h'), 'bearer');
    assert.throws(() => r.registerExtract(fakeHosted([])), /already registered/);
});

Promise.all(pending).then(async () => {
    await bk.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
});
