#!/usr/bin/env tsx
/**
 * test/ingestion-coordinator-unit.ts — ingestion coordinator slice 1, end to end:
 * enqueue -> process -> signed callback -> memories + table rows with provenance.
 * Processors are in-process mock http servers on 127.0.0.1 (port 0). The callback
 * listener under test is also started in-process. No Lore daemon, no real processor.
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    IngestionCoordinator, FsBlobStore, ProcessorRegistry, StaticPolicyProvider, LocalExtractProcessor, AiApiExtractProcessor,
    StructuringV2Processor, LocalStructureProcessor, makeAllowlist, PolicyViolationError, createCallbackServer, loreMemoryPort, jobBearerToken,
    signStandardWebhook, signLoreHmac, type IIngestionStore, type MemoryWritePort, type TablePort, type CoordinatorDeps,
} from '../packages/lore/src/ingestion/index.js';
import { memoryNodeId } from '../packages/lore/src/ingestion/memoryWriter.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { ITableStorage } from '../packages/lore/src/contracts/tables.js';
import { ingestionBackends, type Backend } from './helpers/ingestionBackends.js';

let passed = 0; let failed = 0;
const pending: Array<Promise<void>> = [];
const queue: Array<() => Promise<void>> = [];
/** Every case runs once per backend (sqlite always; postgres when LORE_PG_URL is set), serially for readable failures.
 *  `B` is the backend of the pass in progress; `world()` opens its store. Pass `{ once: true }` for cases with no store. */
let B!: Backend;
function test(name: string, fn: () => Promise<void>, opts: { once?: boolean } = {}): void { queue.push(async () => {
    for (const b of opts.once ? bk.list.slice(0, 1) : bk.list) {
        B = b; const label = opts.once ? name : `[${b.name}] ${name}`;
        try { await fn(); console.log(`  ok  ${label}`); passed++; }
        catch (err) { console.error(`  FAIL ${label}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    }
}); }
void pending;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-coord-'));
const bk = await ingestionBackends(tmp, 'ingestion-coordinator');
const SECRET = Buffer.alloc(32, 9);
const WHSEC = 'whsec_' + Buffer.from('structuring-shared-secret-0123456789').toString('base64');
const json = (res: http.ServerResponse, status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

interface Seen { url: string; headers: http.IncomingHttpHeaders; body: string }
async function mock(handler: (s: Seen, res: http.ServerResponse) => void): Promise<{ origin: string; seen: Seen[]; close(): Promise<void> }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { const s = { url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }; seen.push(s); handler(s, res); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

class FakeMemory implements MemoryWritePort {
    nodes = new Map<string, any>(); failNext = 0;
    async upsert(a: { id: string; workspace: string; ecosystem: string; nodeData: Record<string, unknown> }) {
        if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'boom' }; }
        this.nodes.set(a.id, a); return { ok: true };
    }
}

interface World { c: IngestionCoordinator; store: IIngestionStore; ws: string; backend: string; mem: FakeMemory; policy: StaticPolicyProvider; tables: SqliteTableStorage; clock: { t: number }; registry: ProcessorRegistry; tablesNull: { on: boolean }; close(): Promise<void> }
async function world(setup: (r: ProcessorRegistry) => void, over: Partial<CoordinatorDeps> = {}): Promise<World> {
    const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
    const { store, ws } = await B.open();
    const tables = new SqliteTableStorage(path.join(dir, 'tables.db'));
    const registry = new ProcessorRegistry(); setup(registry);
    const mem = new FakeMemory(); const policy = new StaticPolicyProvider(); const clock = { t: Date.now() }; const tablesNull = { on: false };
    const port: TablePort = { forWorkspace: async () => (tablesNull.on ? null : (tables as unknown as ITableStorage)) };
    const c = new IngestionCoordinator({
        store, registry, policy, blobs: new FsBlobStore(path.join(dir, 'blobs')), memory: mem, tables: port,
        callbackBaseUrl: 'https://lore.example.invalid', callbackAuth: { masterSecret: SECRET, webhookSecret: WHSEC, replayWindowSec: 300 },
        fileUrlFor: async () => 'https://files.example.invalid/signed', now: () => new Date(clock.t),
        backoff: { baseMs: 1000, maxMs: 8000 }, maxAttempts: 3, ...over,
    });
    return { c, store, ws, backend: B.name, mem, policy, tables, clock, registry, tablesNull, close: async () => { await store.close(); } };
}
const TXT = Buffer.from('Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n');
const spec = { processorId: 'local-llm', itemPath: 'units', tableName: 'rentroll' };
const llmReply = { choices: [{ message: { content: JSON.stringify({ units: [{ unit: '4B', rent: 2400 }, { unit: '5A', rent: 2650 }] }) } }] };

async function localWorld(llm: { origin: string }) {
    const w = await world((r) => {
        r.registerExtract(new LocalExtractProcessor());
        r.registerStructure(new LocalStructureProcessor({ id: 'local-llm', baseUrl: llm.origin + '/v1', model: 'm1', http: { allowlist: makeAllowlist([llm.origin]) } }));
    });
    return w;
}

test('all-local pipeline: extract -> memories with provenance -> structure -> table rows with provenance', async () => {
    const llm = await mock((_s, res) => json(res, 200, llmReply));
    const w = await localWorld(llm);
    try {
        const { source, job, created } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'rent.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        assert.equal(created, true);
        let s = await w.c.runDue();
        assert.deepEqual([s.claimed, s.succeeded], [1, 1]);
        assert.equal((await w.store.getJob(job.jobId))!.state, 'succeeded');
        const nodes = [...w.mem.nodes.values()];
        assert.ok(nodes.length >= 1);
        const n = nodes[0]!; const md = JSON.parse(n.nodeData.metadata).ingestion;
        assert.equal(n.workspace, w.ws); assert.equal(n.nodeData.type, 'document_chunk'); assert.ok(n.nodeData.content.includes('Unit 4B'));
        assert.equal(md.sourceId, source.sourceId); assert.equal(md.sourceFileName, 'rent.txt'); assert.equal(md.processor.id, 'lore-local-extractors');
        assert.equal(md.processor.locality, 'local'); assert.equal(md.jobId, job.jobId); assert.equal(n.id, memoryNodeId(job.jobId, 0));
        // second pass runs the chained structure job
        s = await w.c.runDue();
        assert.deepEqual([s.claimed, s.succeeded], [1, 1]);
        const sj = (await w.store.listJobs(w.ws)).find((j) => j.stage === 'structure')!;
        assert.equal(sj.state, 'succeeded'); assert.equal(sj.parentJobId, job.jobId);
        const rows = await w.tables.query('ingest_rentroll');
        assert.equal(rows.length, 2);
        const r4b = rows.find((r) => r.unit === '4B')!;
        assert.equal(r4b.rent, 2400); assert.equal(r4b._source_id, source.sourceId); assert.equal(r4b._source_file, 'rent.txt');
        assert.equal(r4b._processor, 'local-llm'); assert.equal(r4b._processor_version, 'm1'); assert.equal(r4b._job_id, sj.jobId);
        assert.ok(r4b._needs_review === 1 || r4b._needs_review === true, 'local model output is flagged for review');
        assert.equal(llm.seen.length, 1);
        assert.equal((await w.store.listPending(w.ws)).length, 0);
    } finally { await w.close(); await llm.close(); }
});

test('idempotent: re-enqueue, re-run and re-completion never duplicate jobs, memories or rows', async () => {
    const llm = await mock((_s, res) => json(res, 200, llmReply));
    const w = await localWorld(llm);
    try {
        const a = await w.c.enqueueFile({ workspace: w.ws, fileName: 'rent.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        const b = await w.c.enqueueFile({ workspace: w.ws, fileName: 'rent-copy.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        assert.equal(b.created, false); assert.equal(a.job.jobId, b.job.jobId); assert.equal(a.source.sourceId, b.source.sourceId);
        await w.c.runDue(); await w.c.runDue();
        const memCount = w.mem.nodes.size; const jobs = (await w.store.listJobs(w.ws)).length;
        await w.c.enqueueFile({ workspace: w.ws, fileName: 'rent.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        assert.equal((await w.c.runDue()).claimed, 0, 'terminal jobs are not re-run');
        // forced re-completion of the same extract result (what a duplicate callback would do)
        const ex = (await w.store.getJob(a.job.jobId))!;
        await w.c.completeExtract(ex, a.source, ex.result as never);
        assert.equal(w.mem.nodes.size, memCount); assert.equal((await w.store.listJobs(w.ws)).length, jobs);
        const sj = (await w.store.listJobs(w.ws)).find((j) => j.stage === 'structure')!;
        await w.c.completeStructure(sj, sj.result as never);
        assert.equal((await w.tables.query('ingest_rentroll')).length, 2);
        // same bytes in another workspace is a separate source, job and set of memories
        // (postgres stores are bound to one workspace; cross-workspace behaviour is covered in ingestion-postgres-store-unit)
        if (w.backend === 'sqlite') {
            const other = await w.c.enqueueFile({ workspace: 'w2', fileName: 'rent.txt', mimeType: 'text/plain', bytes: TXT });
            assert.notEqual(other.source.sourceId, a.source.sourceId); assert.notEqual(other.job.jobId, a.job.jobId);
        }
    } finally { await w.close(); await llm.close(); }
});

test('policy: local-only refuses hosted processors at enqueue (nothing recorded) and at dispatch; hosted-allowed admits', async () => {
    const hosted = await mock((_s, res) => json(res, 202, { requestID: 'r1' }));
    const al = makeAllowlist([hosted.origin]);
    const w = await world((r) => {
        r.registerExtract(new LocalExtractProcessor());
        r.registerExtract(new AiApiExtractProcessor({ id: 'ai-api-extract', endpoint: hosted.origin + '/extract', engineVersion: 'v1', http: { allowlist: al }, mimeTypes: ['application/x-hosted-only'] }), { callbackScheme: 'bearer' });
        r.registerStructure(new StructuringV2Processor({ id: 'sv2', endpoint: hosted.origin + '/structure', engineVersion: 'v2', http: { allowlist: al } }), { callbackScheme: 'standard-webhooks' });
    });
    try {
        // default policy is local-only
        await assert.rejects(w.c.enqueueFile({ workspace: w.ws, fileName: 'a.bin', mimeType: 'application/x-hosted-only', bytes: Buffer.from('zz') }), PolicyViolationError);
        await assert.rejects(w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT, structure: { processorId: 'sv2' } }), PolicyViolationError);
        await assert.rejects(w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT, extractorId: 'ai-api-extract' }), PolicyViolationError);
        assert.equal((await w.store.listJobs(w.ws)).length, 0, 'refused requests leave no job behind');
        assert.equal(hosted.seen.length, 0);
        // allowed -> queued; then the workspace flips back to local-only before dispatch
        w.policy.set(w.ws, 'hosted-allowed');
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.bin', mimeType: 'application/x-hosted-only', bytes: Buffer.from('zz') });
        w.policy.set(w.ws, 'local-only');
        const s = await w.c.runDue();
        assert.equal(s.deadLettered, 1, 'policy violation is permanent');
        assert.match((await w.store.getJob(job.jobId))!.lastError ?? '', /PolicyViolation/);
        assert.equal(hosted.seen.length, 0, 'no request left the building');
        if (w.backend === 'sqlite') { // a second workspace needs a second bound store on postgres
            // a different workspace with hosted-allowed is unaffected
            w.policy.set('w2', 'hosted-allowed');
            const ok = await w.c.enqueueFile({ workspace: 'w2', fileName: 'a.bin', mimeType: 'application/x-hosted-only', bytes: Buffer.from('zz') });
            await w.c.runDue();
            assert.equal((await w.store.getJob(ok.job.jobId))!.state, 'awaiting_callback'); assert.equal(hosted.seen.length, 1);
        }
    } finally { await w.close(); await hosted.close(); }
});

/** Hosted extractor + hosted Structuring V2, results delivered through the real callback listener. */
async function hostedWorld() {
    const hosted = await mock((s, res) => json(res, 202, { requestID: 'remote-' + hosted.seen.length }));
    const al = makeAllowlist([hosted.origin]);
    const w = await world((r) => {
        r.registerExtract(new AiApiExtractProcessor({ id: 'ai-api-extract', endpoint: hosted.origin + '/extract', engineVersion: 'v1', http: { allowlist: al }, mimeTypes: ['application/x-hosted-only'] }), { callbackScheme: 'bearer' });
        r.registerStructure(new StructuringV2Processor({ id: 'sv2', endpoint: hosted.origin + '/structure', engineVersion: 'v2', http: { allowlist: al } }), { callbackScheme: 'standard-webhooks' });
    });
    w.policy.set(w.ws, 'hosted-allowed');
    const server = createCallbackServer(w.c);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (jobId: string, body: Buffer | string, headers: Record<string, string>) => {
        const res = await fetch(`${origin}/api/ingest/callback/${encodeURIComponent(jobId)}`, { method: 'POST', body: body as never, headers });
        return { status: res.status, body: (await res.json()) as { code: string } };
    };
    const close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await w.close(); await hosted.close(); };
    return { w, hosted, post, close, origin };
}
const extractEnvelope = (jobId: string, content: string) => JSON.stringify({ data: { requestID: jobId, values: { content }, format: 'text' }, status: 'success', statusCode: 200 });
const structEnvelope = (jobId: string) => JSON.stringify({ data: { requestID: jobId, format: 'json', values: {
    content: { units: [{ unit: '4B', rent: 2400 }, { unit: '5A', rent: 2650 }] },
    annotations: { items: [{ index: 0, source_page: 1, source_quote: 'Unit 4B rent 2400', quote_verified: true, confidence: { score: 0.97, level: 'High', reasons: [] }, needs_review: false },
                           { index: 1, source_page: 2, source_quote: 'Unit 5A rent 2650', quote_verified: false, confidence: { score: 0.4, level: 'Low', reasons: ['quote'] }, needs_review: true }], rejected: [], document: {} } } } });

test('hosted pipeline: dispatch carries callback url + per-job bearer; signed callbacks complete extract then structure', async () => {
    const h = await hostedWorld();
    try {
        const { source, job } = await h.w.c.enqueueFile({ workspace: h.w.ws, fileName: 'scan.pdf', mimeType: 'application/x-hosted-only', bytes: Buffer.from('%scan%'), structure: { processorId: 'sv2', itemPath: 'units', tableName: 'rr' } });
        await h.w.c.runDue();
        const sent = JSON.parse(h.hosted.seen[0]!.body);
        assert.equal(sent.request_id, job.jobId); assert.equal(sent.callback_url, `https://lore.example.invalid/api/ingest/callback/${job.jobId}`);
        assert.equal(sent.bearer_token, jobBearerToken(SECRET, job.jobId)); assert.ok(!('bytes' in sent) && !JSON.stringify(sent).includes('%scan%'), 'file bytes are never sent');
        assert.equal((await h.w.store.getJob(job.jobId))!.state, 'awaiting_callback');

        // 1) bad credentials first: all indistinguishable 401s and nothing is written
        const body = extractEnvelope(job.jobId, 'Page_Number: 1\nUnit 4B rent 2400\nPage_Number: 2\nUnit 5A rent 2650');
        const good = { authorization: `Bearer ${jobBearerToken(SECRET, job.jobId)}`, 'content-type': 'application/json' };
        for (const hdr of [{} as Record<string, string>, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${jobBearerToken(SECRET, 'job_other')}` }]) {
            const r = await h.post(job.jobId, body, hdr); assert.equal(r.status, 401); assert.equal(r.body.code, 'unauthorized');
        }
        assert.equal((await h.post('job_doesnotexist0001', body, good)).status, 401, 'unknown job looks the same');
        assert.equal(h.w.mem.nodes.size, 0);
        // 2) good callback
        const ok = await h.post(job.jobId, body, good);
        assert.deepEqual(ok, { status: 200, body: { code: 'accepted' } });
        assert.equal(h.w.mem.nodes.size, 2, 'one memory per page chunk');
        const pg2 = [...h.w.mem.nodes.values()].map((n) => JSON.parse(n.nodeData.metadata).ingestion).find((m) => m.page === 2)!;
        assert.equal(pg2.processor.id, 'ai-api-extract'); assert.equal(pg2.processor.locality, 'hosted'); assert.equal(pg2.sourceId, source.sourceId);
        // 3) replay of the identical delivery is acknowledged but changes nothing
        const again = await h.post(job.jobId, body, good);
        assert.deepEqual(again, { status: 200, body: { code: 'duplicate_ignored' } }); assert.equal(h.w.mem.nodes.size, 2);

        // structure stage, Standard Webhooks auth
        await h.w.c.runDue();
        const sj = (await h.w.store.listJobs(h.w.ws)).find((j) => j.stage === 'structure')!;
        assert.equal(sj.state, 'awaiting_callback');
        const sbody = Buffer.from(structEnvelope(sj.jobId));
        const ts = Math.floor(h.w.clock.t / 1000);
        const wh = (id: string, t: number, b: Buffer) => ({ 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': signStandardWebhook(WHSEC, id, t, b), 'content-type': 'application/json' });
        assert.equal((await h.post(sj.jobId, sbody, wh('m1', ts - 1000, sbody))).status, 401, 'stale timestamp');
        assert.equal((await h.post(sj.jobId, sbody, wh('m1', ts + 1000, sbody))).status, 401, 'future timestamp');
        assert.equal((await h.post(sj.jobId, Buffer.from(sbody.toString() + ' '), wh('m1', ts, sbody))).status, 401, 'body changed after signing');
        assert.equal((await h.post(sj.jobId, sbody, { ...wh('m1', ts, sbody), 'webhook-signature': 'v1,AAAA' })).status, 401);
        assert.equal((await h.post(sj.jobId, sbody, wh('m1', ts, sbody))).status, 200);
        const rows = await h.w.tables.query('ingest_rr');
        assert.equal(rows.length, 2);
        const lo = rows.find((r) => r.unit === '5A')!;
        assert.equal(lo._source_page, 2); assert.equal(lo._source_quote, 'Unit 5A rent 2650'); assert.equal(lo._confidence_level, 'Low');
        assert.equal(lo._processor, 'sv2'); assert.equal(lo._source_id, source.sourceId);
        assert.deepEqual(rows.find((r) => r.unit === '4B')!._needs_review === 0 || rows.find((r) => r.unit === '4B')!._needs_review === false, true);
        assert.equal((await h.post(sj.jobId, sbody, wh('m2', ts, sbody))).body.code, 'duplicate_ignored', 'terminal job ignores a re-signed redelivery');
        assert.equal((await h.w.tables.query('ingest_rr')).length, 2);
    } finally { await h.close(); }
});

test('callback binding: a validly signed message cannot complete a different job', async () => {
    const h = await hostedWorld();
    try {
        const a = await h.w.c.enqueueFile({ workspace: h.w.ws, fileName: 'a.pdf', mimeType: 'application/x-hosted-only', bytes: Buffer.from('A'), structure: { processorId: 'sv2' } });
        await h.w.c.runDue();
        const ok = await h.post(a.job.jobId, extractEnvelope(a.job.jobId, 'alpha'), { authorization: `Bearer ${jobBearerToken(SECRET, a.job.jobId)}` });
        assert.equal(ok.status, 200);
        await h.w.c.runDue();
        const sj = (await h.w.store.listJobs(h.w.ws)).find((j) => j.stage === 'structure')!;
        const ts = Math.floor(h.w.clock.t / 1000);
        // a Standard-Webhooks-signed body that names the OTHER job's id, posted to this structure job's URL
        const b = Buffer.from(structEnvelope(a.job.jobId));
        const r = await h.post(sj.jobId, b, { 'webhook-id': 'x1', 'webhook-timestamp': String(ts), 'webhook-signature': signStandardWebhook(WHSEC, 'x1', ts, b) });
        assert.equal(r.status, 200); assert.equal(r.body.code, 'failure_recorded');
        assert.notEqual((await h.w.store.getJob(sj.jobId))!.state, 'succeeded');
        assert.equal((await h.w.tables.listTables?.() ?? []).length, 0, 'no table was created from a mis-bound message');
        // a bearer token minted for job A cannot be replayed against the extract callback of job B
        const bj = await h.w.c.enqueueFile({ workspace: h.w.ws, fileName: 'b.pdf', mimeType: 'application/x-hosted-only', bytes: Buffer.from('B') });
        await h.w.c.runDue();
        assert.equal((await h.post(bj.job.jobId, extractEnvelope(bj.job.jobId, 'beta'), { authorization: `Bearer ${jobBearerToken(SECRET, a.job.jobId)}` })).status, 401);
    } finally { await h.close(); }
});

test('callback transport: gzip bodies verify and decode; oversize and malformed bodies are rejected; non-POST and unknown paths', async () => {
    const h = await hostedWorld();
    try {
        const { job } = await h.w.c.enqueueFile({ workspace: h.w.ws, fileName: 'g.pdf', mimeType: 'application/x-hosted-only', bytes: Buffer.from('G') });
        await h.w.c.runDue();
        const auth = { authorization: `Bearer ${jobBearerToken(SECRET, job.jobId)}` };
        const raw = Buffer.from(extractEnvelope(job.jobId, 'gzipped text'));
        // signed over the decompressed bytes OR the wire bytes both work for bearer; this exercises the decode path
        const r = await h.post(job.jobId, gzipSync(raw), { ...auth, 'content-encoding': 'gzip' });
        assert.equal(r.status, 200); assert.ok([...h.w.mem.nodes.values()].some((n) => n.nodeData.content === 'gzipped text'));
        const res405 = await fetch(`${h.origin}/api/ingest/callback/${job.jobId}`); assert.equal(res405.status, 405);
        assert.equal((await fetch(`${h.origin}/api/other`, { method: 'POST' })).status, 404);
        assert.equal((await fetch(`${h.origin}/api/ingest/callback/..%2F..%2Fetc`, { method: 'POST', body: '{}' })).status, 401);
        const big = await h.post(job.jobId, Buffer.alloc(9 * 1024 * 1024, 65), auth).catch(() => ({ status: 413 }));
        assert.equal(big.status, 413);
    } finally { await h.close(); }
});

test('callback: processor-reported error is recorded (retryable -> requeued with backoff); bad JSON is permanent; policy flip blocks results', async () => {
    const h = await hostedWorld();
    try {
        const mk = async (n: string) => { const e = await h.w.c.enqueueFile({ workspace: h.w.ws, fileName: n, mimeType: 'application/x-hosted-only', bytes: Buffer.from(n) }); return e.job; };
        const j1 = await mk('one'); const j2 = await mk('two'); const j3 = await mk('three');
        await h.w.c.runDue();
        const au = (j: string) => ({ authorization: `Bearer ${jobBearerToken(SECRET, j)}` });
        const err503 = JSON.stringify({ data: { requestID: j1.jobId, values: {} }, status: 'error', statusCode: 503, message: 'upstream busy' });
        assert.equal((await h.post(j1.jobId, err503, au(j1.jobId))).body.code, 'failure_recorded');
        const after = (await h.w.store.getJob(j1.jobId))!; assert.equal(after.state, 'queued'); assert.equal(after.attempts, 1); assert.match(after.lastError ?? '', /503/);
        assert.equal((await h.post(j2.jobId, '{not json', au(j2.jobId))).status, 400);
        assert.equal((await h.w.store.getJob(j2.jobId))!.state, 'dead_letter');
        h.w.policy.set(h.w.ws, 'local-only');
        assert.equal((await h.post(j3.jobId, extractEnvelope(j3.jobId, 'late'), au(j3.jobId))).status, 403);
        assert.equal((await h.w.store.getJob(j3.jobId))!.state, 'dead_letter'); assert.equal(h.w.mem.nodes.size, 0);
    } finally { await h.close(); }
});

test('retry and dead-letter: transient processor failure backs off then succeeds; exhausted attempts dead-letter; reaper requeues silent callbacks', async () => {
    let calls = 0;
    const llm = await mock((_s, res) => { calls++; if (calls <= 2) json(res, 503, {}); else json(res, 200, llmReply); });
    const w = await localWorld(llm);
    try {
        await w.c.enqueueFile({ workspace: w.ws, fileName: 'r.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        await w.c.runDue();                                   // extract ok, structure job created
        let s = await w.c.runDue(); assert.equal(s.retried, 1, 'first 503 -> queued with backoff');
        assert.equal((await w.c.runDue()).claimed, 0, 'not due yet');
        w.clock.t += 1500; s = await w.c.runDue(); assert.equal(s.retried, 1);
        w.clock.t += 2500; s = await w.c.runDue(); assert.equal(s.succeeded, 1, 'third attempt succeeds');
        assert.equal(calls, 3);
        assert.equal((await w.tables.query('ingest_rentroll')).length, 2);
    } finally { await w.close(); await llm.close(); }
    const down = await mock((_s, res) => json(res, 500, {}));
    const w2 = await localWorld(down);
    try {
        const { job } = await w2.c.enqueueFile({ workspace: w2.ws, fileName: 'r.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        await w2.c.runDue();
        for (let i = 0; i < 4; i++) { w2.clock.t += 20_000; await w2.c.runDue(); }
        const sj = (await w2.store.listJobs(w2.ws)).find((j) => j.stage === 'structure')!;
        assert.equal(sj.state, 'dead_letter'); assert.equal(sj.attempts, 3);
        assert.equal(await w2.store.requeueDeadLetter(sj.jobId, new Date(w2.clock.t)), true);
        assert.equal((await w2.store.getJob(job.jobId))!.state, 'succeeded', 'the extract result and memories are unaffected');
    } finally { await w2.close(); await down.close(); }
    const h = await hostedWorld();
    try {
        const { job } = await h.w.c.enqueueFile({ workspace: h.w.ws, fileName: 's.pdf', mimeType: 'application/x-hosted-only', bytes: Buffer.from('s') });
        await h.w.c.runDue();
        assert.equal(await h.w.c.reapStale(60_000), 0);
        h.w.clock.t += 120_000;
        assert.equal(await h.w.c.reapStale(60_000), 1);
        const j = (await h.w.store.getJob(job.jobId))!; assert.equal(j.state, 'queued'); assert.match(j.lastError ?? '', /callback timeout/);
    } finally { await h.close(); }
});

test('memory write failure fails the attempt (retry), and succeeds without duplicates on the next try', async () => {
    const llm = await mock((_s, res) => json(res, 200, llmReply));
    const w = await localWorld(llm);
    try {
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'r.txt', mimeType: 'text/plain', bytes: TXT });
        w.mem.failNext = 1;
        await w.c.runDue(); assert.equal((await w.store.getJob(job.jobId))!.state, 'queued');
        w.clock.t += 6000; await w.c.runDue();
        assert.equal((await w.store.getJob(job.jobId))!.state, 'succeeded'); assert.equal(w.mem.nodes.size, 1);
    } finally { await w.close(); await llm.close(); }
});

test('no table storage: structured fields are recorded as pending, not dropped or force-fit', async () => {
    const llm = await mock((_s, res) => json(res, 200, llmReply));
    const w = await localWorld(llm);
    try {
        w.tablesNull.on = true;
        await w.c.enqueueFile({ workspace: w.ws, fileName: 'r.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
        await w.c.runDue(); await w.c.runDue();
        const sj = (await w.store.listJobs(w.ws)).find((j) => j.stage === 'structure')!;
        assert.equal(sj.state, 'succeeded');
        const p = await w.store.listPending(w.ws); assert.equal(p.length, 1);
        assert.equal(p[0]!.reason, 'tables_unavailable'); assert.deepEqual((p[0]!.payload as { content: unknown }).content, { units: [{ unit: '4B', rent: 2400 }, { unit: '5A', rent: 2650 }] });
    } finally { await w.close(); await llm.close(); }
});

test('loreMemoryPort adapts nodeUpsert results, including {ok:false}', async () => {
    const calls: any[] = [];
    const lore = { nodeUpsert: async (a: any) => { calls.push(a); return a.id.endsWith('bad') ? { ok: false, code: 'workspace_required', error: { message: 'nope' } } : { ok: true }; } };
    const port = loreMemoryPort(lore);
    assert.deepEqual(await port.upsert({ id: 'good', workspace: 'w', ecosystem: '*', nodeData: {} }), { ok: true });
    const bad = await port.upsert({ id: 'bad', workspace: 'w', ecosystem: '*', nodeData: {} });
    assert.equal(bad.ok, false); assert.equal(calls[0].asyncEmbed, true);
    void signLoreHmac;
}, { once: true });

(async () => {
    for (const t of queue) await t();
    await bk.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
