#!/usr/bin/env tsx
/**
 * test/ingestion-extract-worker-unit.ts - the sovereign File Content Extractor as its own worker (contract A, step 2),
 * plus the local vision engine for scans and images. Everything is OFF by default.
 *
 * Covered: the worker gives the same result as the in-process path (text, markdown, text PDF), over a forked child and
 * over the loopback HTTP worker; a crash or hang costs one attempt (same job id retried, dead-letter after max attempts,
 * the host survives, the hung child is killed); an image or scanned PDF goes through a fake local vision server to text
 * with page references; hosted processors stay refused for local-only workspaces and vision/worker URLs must be loopback;
 * size cap; RSS recycle; busy/timeout on the HTTP worker; stop() leaves no child process (checked with ps).
 * Fake loopback servers only; temp HOME/LORE_HOME; LORE_MODEL_SERVER=0.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-extract-worker-'));
process.env['LORE_HOME'] = path.join(tmp, 'home');
process.env['HOME'] = path.join(tmp, 'home');
process.env['LORE_MODEL_SERVER'] = '0';
fs.mkdirSync(process.env['LORE_HOME'], { recursive: true });

const { IngestionCoordinator, FsBlobStore, ProcessorRegistry, StaticPolicyProvider, LocalExtractProcessor, AiApiExtractProcessor, PolicyViolationError, SqliteIngestionStore, makeAllowlist,
    WorkerExtractProcessor, ExtractWorkerClient, HttpExtractWorkerClient, startExtractWorkerServer, OpenAiVisionEngine, buildSovereignExtractor, IngestionHost, loadIngestHostConfig,
} = await import('../packages/lore/src/ingestion/index.js');
const { ProcessorError } = await import('../packages/lore/src/ingestion/contracts.js');
const { workerEnv } = await import('../packages/lore/src/ingestion/worker/extractWorkerClient.js');
const { resolveEmbeddedIngestion } = await import('../packages/lore/src/mcp/embeddedIngestion.js');
const { buildDefaultRegistry } = await import('../packages/lore/src/engines/extractors/index.js');
type Coordinator = InstanceType<typeof IngestionCoordinator>;

let passed = 0; let failed = 0;
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    queue.push(async () => {
        try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FIXTURE_ENTRY = path.resolve('test/helpers/extractWorkerFixtureEntry.ts');

// ---------- fixtures ----------
type Run = [number, number, string];
/** A hand-built PDF. Pages with no runs have an empty content stream: no text layer, i.e. a scan. */
function buildPdf(pages: Run[][]): Buffer {
    const objs: string[] = [];
    const add = (body: string): number => { objs.push(body); return objs.length; };
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pagesId = objs.length + 1 + pages.length * 2;
    const pageIds: number[] = [];
    for (const runs of pages) {
        const stream = runs.map(([x, y, t]) => `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${t}) Tj ET`).join('\n');
        const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
        pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    const pagesObj = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    assert.equal(pagesObj, pagesId);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
    let out = '%PDF-1.4\n'; const offsets: number[] = [];
    objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}
const TEXT_PDF = buildPdf([[[72, 700, 'Quarterly report alpha']], [[72, 700, 'Second page beta']]]);
const SCAN_PDF = buildPdf([[], [], []]);
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TXT = Buffer.from('Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n');
const MD = Buffer.from('# Rent roll\n\n| unit | rent |\n| --- | --- |\n| 4B | 2400 |\n| 5A | 2650 |\n\nNotes follow.\n');

// ---------- fake local vision server (OpenAI-compatible) ----------
interface VisionSeen { model: string; mime: string; png: boolean; prompt: string }
async function fakeVision(reply?: (n: number) => string): Promise<{ url: string; seen: VisionSeen[]; close(): Promise<void> }> {
    const seen: VisionSeen[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const parts = body.messages[body.messages.length - 1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
            const img = parts.find((p) => p.type === 'image_url')!.image_url!.url;
            const m = /^data:([^;]+);base64,(.*)$/.exec(img)!;
            seen.push({ model: body.model, mime: m[1]!, png: Buffer.from(m[2]!, 'base64').subarray(0, 8).toString('hex') === '89504e470d0a1a0a', prompt: parts.find((p) => p.type === 'text')?.text ?? '' });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: reply ? reply(seen.length) : `scanned text ${seen.length}` } }] }));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// ---------- process helpers ----------
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Extractor children of THIS process, found with ps (not our own bookkeeping). */
function workerChildren(): number[] {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().split('\n');
    return out.map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
        .filter((m) => Number(m[2]) === process.pid && /extractWorker(Fixture)?Entry/.test(m[3]!)).map((m) => Number(m[1]));
}
async function gone(pid: number, ms = 3000): Promise<boolean> { const t = Date.now(); while (alive(pid)) { if (Date.now() - t > ms) return false; await sleep(20); } return true; }

// ---------- coordinator rig ----------
class FakeMemory { nodes = new Map<string, any>(); async upsert(a: { id: string; nodeData: Record<string, unknown> }) { this.nodes.set(a.id, a); return { ok: true }; } }
interface World { c: Coordinator; ws: string; mem: FakeMemory; policy: InstanceType<typeof StaticPolicyProvider>; clock: { t: number }; store: InstanceType<typeof SqliteIngestionStore> }
function world(register: (r: InstanceType<typeof ProcessorRegistry>) => void): World {
    const dir = fs.mkdtempSync(path.join(tmp, 'w-'));
    const store = new SqliteIngestionStore(path.join(dir, 'ing.db'));
    const registry = new ProcessorRegistry(); register(registry);
    const mem = new FakeMemory(); const policy = new StaticPolicyProvider(); const clock = { t: Date.now() };
    const c = new IngestionCoordinator({
        store, registry, policy, blobs: new FsBlobStore(path.join(dir, 'blobs')), memory: mem as never, tables: { forWorkspace: async () => null },
        callbackBaseUrl: 'https://lore.example.invalid', callbackAuth: { masterSecret: Buffer.alloc(32, 9), replayWindowSec: 300 },
        now: () => new Date(clock.t), backoff: { baseMs: 1000, maxMs: 8000 }, maxAttempts: 3,
    });
    return { c, ws: 'w', mem, policy, clock, store };
}
const childClient = (over: Partial<ConstructorParameters<typeof ExtractWorkerClient>[0]> = {}) =>
    new ExtractWorkerClient({ vision: null, maxFileBytes: 50 * 1024 * 1024, maxMemoryMb: 512, timeoutMs: 20_000, ...over });
const nodeText = (w: World) => [...w.mem.nodes.values()].map((n) => JSON.stringify(n)).join('\n');

/** What a processor returned, minus the processor id (which names the path taken). */
async function viaProcessor(p: { extract(r: any): Promise<any> }, bytes: Buffer, mime: string) {
    const o = await p.extract({ contractVersion: 'extract.v1', jobId: 'j', workspace: 'w', sourceId: 's', fileName: 'f', mimeType: mime, bytes });
    assert.equal(o.status, 'done');
    const { processor: _p, ...rest } = o.result;
    return JSON.parse(JSON.stringify(rest));
}

// =====================================================================================================
test('default: no worker, no vision - the in-process extractor is used and no child process exists', async () => {
    const cfg = loadIngestHostConfig({});
    assert.equal(cfg.extract.mode, 'in-process'); assert.equal(cfg.extract.url, null); assert.equal(cfg.vision, null);
    const p = buildSovereignExtractor(cfg);
    assert.ok(p instanceof LocalExtractProcessor, 'plain in-process extractor');
    assert.equal(p.info.version, 'in-process.1');
    assert.equal((await viaProcessor(p, TXT, 'text/plain')).text, TXT.toString('utf8'));
    assert.deepEqual(workerChildren(), []);
});

test('config: env switches, URL beats flag, bounds fall back, embedded options win over env and are validated', async () => {
    assert.equal(loadIngestHostConfig({ LORE_INGEST_EXTRACT_WORKER: '1' }).extract.mode, 'child');
    assert.equal(loadIngestHostConfig({ LORE_INGEST_EXTRACT_WORKER: 'off' }).extract.mode, 'in-process');
    const u = loadIngestHostConfig({ LORE_INGEST_EXTRACT_WORKER: '1', LORE_INGEST_EXTRACT_WORKER_URL: 'http://127.0.0.1:9700' }).extract;
    assert.equal(u.mode, 'url'); assert.equal(u.url, 'http://127.0.0.1:9700');
    assert.equal(loadIngestHostConfig({ LORE_INGEST_EXTRACT_TIMEOUT_MS: '5' }).extract.timeoutMs, 120_000, 'out of range -> default');
    assert.equal(loadIngestHostConfig({ LORE_INGEST_EXTRACT_TIMEOUT_MS: '30000' }).extract.timeoutMs, 30_000);
    assert.equal(loadIngestHostConfig({ LORE_INGEST_VISION_URL: 'http://127.0.0.1:1/v1' }).vision, null, 'URL without a model = off');
    assert.deepEqual(loadIngestHostConfig({ LORE_INGEST_VISION_URL: 'http://127.0.0.1:1/v1', LORE_INGEST_VISION_MODEL: 'm', LORE_INGEST_VISION_MAX_PAGES: '3' }).vision,
        { url: 'http://127.0.0.1:1/v1', model: 'm', maxPages: 3, timeoutMs: 120_000 });
    // embedded
    const env = { LORE_INGEST_EXTRACT_WORKER: '1' } as NodeJS.ProcessEnv;
    assert.equal(resolveEmbeddedIngestion(true, env)!.config.extract.mode, 'child', 'env applies when no option');
    assert.equal(resolveEmbeddedIngestion({ extractWorker: false }, env)!.config.extract.mode, 'in-process', 'option wins over env');
    assert.equal(resolveEmbeddedIngestion(true, {})!.config.extract.mode, 'in-process', 'off by default');
    const t = resolveEmbeddedIngestion({ extractWorker: { timeoutMs: 9000, maxMemoryMb: 1024 }, vision: { url: 'http://127.0.0.1:1/v1', model: 'm' } }, {})!.config;
    assert.equal(t.extract.mode, 'child'); assert.equal(t.extract.timeoutMs, 9000); assert.equal(t.extract.maxMemoryMb, 1024);
    assert.equal(t.vision!.maxPages, 25);
    assert.equal(resolveEmbeddedIngestion({ extractWorker: { url: 'http://127.0.0.1:9700' } }, {})!.config.extract.mode, 'url');
    assert.throws(() => resolveEmbeddedIngestion({ extractWorker: { timeoutMs: 5 } }, {}), RangeError);
    assert.throws(() => resolveEmbeddedIngestion({ extractWorker: { url: '' } }, {}), RangeError);
    assert.throws(() => resolveEmbeddedIngestion({ vision: { url: '', model: 'm' } }, {}), RangeError);
    assert.throws(() => resolveEmbeddedIngestion({ vision: { url: 'http://127.0.0.1:1/v1', model: 'm', maxPages: 0 } }, {}), RangeError);
});

test('child env is an allowlist: tokens and ingestion secrets never reach the file parser', async () => {
    const env = workerEnv({ PATH: '/bin', HOME: '/h', LORE_INGEST_CALLBACK_SECRET: 's', LORE_INGEST_HOSTED_STRUCTURING_TOKEN: 't', ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'a', LORE_OCR_LANGUAGES: 'eng', TSX_TSCONFIG_PATH: 'x' }, '/lorehome');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LORE_HOME', 'LORE_OCR_LANGUAGES', 'PATH', 'TSX_TSCONFIG_PATH']);
    assert.equal(env['LORE_HOME'], '/lorehome');
});

test('parity: the child worker returns exactly what the in-process path returns (text, markdown, text PDF)', async () => {
    const inproc = new LocalExtractProcessor();
    const client = childClient();
    const worker = new WorkerExtractProcessor(client);
    try {
        assert.equal(worker.info.id, inproc.info.id, 'same processor id, so queued jobs survive a setting change');
        assert.equal(worker.info.locality, 'local');
        assert.match(worker.info.version, /^worker-child/);
        for (const [bytes, mime] of [[TXT, 'text/plain'], [MD, 'text/markdown'], [TEXT_PDF, 'application/pdf']] as const) {
            const a = await viaProcessor(inproc, bytes, mime); const b = await viaProcessor(worker, bytes, mime);
            assert.deepEqual(b, a, `${mime} identical`);
        }
        const pdf = await viaProcessor(worker, TEXT_PDF, 'application/pdf');
        assert.match(pdf.text, /Quarterly report alpha/); assert.match(pdf.text, /Second page beta/);
        assert.equal(worker.supports('text/plain'), true); assert.equal(worker.supports('application/x-nope'), false);
    } finally { await client.dispose(); }
});

test('parity over the loopback HTTP worker', async () => {
    const server = await startExtractWorkerServer({ port: 0, vision: null, maxFileBytes: 50 * 1024 * 1024, timeoutMs: 20_000 });
    const worker = new WorkerExtractProcessor(new HttpExtractWorkerClient({ url: `http://127.0.0.1:${server.port}`, timeoutMs: 20_000 }));
    try {
        assert.match(worker.info.version, /^worker-url/);
        const inproc = new LocalExtractProcessor();
        for (const [bytes, mime] of [[TXT, 'text/plain'], [MD, 'text/markdown'], [TEXT_PDF, 'application/pdf']] as const) {
            assert.deepEqual(await viaProcessor(worker, bytes, mime), await viaProcessor(inproc, bytes, mime), `${mime} identical`);
        }
        assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
    } finally { await worker.dispose(); await server.close(); }
});

test('HTTP worker: size cap is permanent, a busy worker and a slow extraction are retryable, a non-loopback bind/url is refused', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const slowRegistry = buildDefaultRegistry();
    const realExtract = slowRegistry.extract.bind(slowRegistry);
    (slowRegistry as any).extract = async (b: Buffer, m: string) => { if (b.toString('latin1').startsWith('SLOW')) await gate; return realExtract(b, m); };
    const server = await startExtractWorkerServer({ port: 0, vision: null, maxFileBytes: 2_000, timeoutMs: 400, deps: { registry: slowRegistry } });
    const client = new HttpExtractWorkerClient({ url: `http://127.0.0.1:${server.port}`, timeoutMs: 5_000 });
    const req = (bytes: Buffer) => ({ jobId: 'j', mimeType: 'text/plain', fileName: 'a.txt', bytes });
    try {
        await assert.rejects(client.extract(req(Buffer.alloc(5_000, 65))), (e: any) => e instanceof ProcessorError && e.retryable === false && /cap/.test(e.message));
        const slow = client.extract(req(Buffer.from('SLOW file')));
        await sleep(100);
        await assert.rejects(client.extract(req(Buffer.from('second'))), (e: any) => e instanceof ProcessorError && e.retryable === true && /busy/.test(e.message));
        await assert.rejects(slow, (e: any) => e instanceof ProcessorError && e.retryable === true && /timed out/.test(e.message), 'deadline answers 504 retryable');
        release();
        await sleep(100);
        assert.equal((await client.extract(req(Buffer.from('fine')))).text, 'fine', 'slot is free again once the work really finished');
    } finally { release(); await server.close(); }
    await assert.rejects(startExtractWorkerServer({ port: 0, bind: '0.0.0.0', vision: null, maxFileBytes: 10, timeoutMs: 10 }), /not loopback/);
    assert.throws(() => new HttpExtractWorkerClient({ url: 'http://example.com:9700', timeoutMs: 10 }), /not loopback/);
    // unreachable worker -> retryable
    await assert.rejects(new HttpExtractWorkerClient({ url: 'http://127.0.0.1:1', timeoutMs: 500 }).extract(req(TXT)), (e: any) => e instanceof ProcessorError && e.retryable === true);
});

test('crash: the child dies mid-file; the SAME job id is retried with backoff, succeeds on a fresh child, the host survives', async () => {
    const client = childClient({ entry: FIXTURE_ENTRY });
    const w = world((r) => r.registerExtract(new WorkerExtractProcessor(client)));
    try {
        const marker = path.join(tmp, 'crash-once');
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'x.txt', mimeType: 'text/plain', bytes: Buffer.from(`CRASHONCE:${marker}\nUnit 9Z rent 3100.\n`) });
        let s = await w.c.runDue();
        assert.equal(s.retried, 1, 'crash = retryable'); assert.equal(s.deadLettered, 0);
        const after1 = (await w.store.getJob(job.jobId))!;
        assert.equal(after1.state, 'queued'); assert.equal(after1.attempts, 1);
        assert.equal(client.pid, undefined, 'dead child is not reused');
        assert.equal((await w.c.runDue()).claimed, 0, 'not due yet');
        w.clock.t += 1500;
        s = await w.c.runDue();
        assert.equal(s.succeeded, 1);
        const done = (await w.store.getJob(job.jobId))!;
        assert.equal(done.jobId, job.jobId, 'same job id'); assert.equal(done.attempts, 1, 'attempts counts failures: one crash, then success'); assert.equal(done.state, 'succeeded');
        assert.match(nodeText(w), /Unit 9Z rent 3100/);
    } finally { await client.dispose(); await w.store.close(); }
    assert.deepEqual(workerChildren(), []);
});

test('crash every time: dead-letters after max attempts (3), job id unchanged, nothing written, host alive', async () => {
    const client = childClient({ entry: FIXTURE_ENTRY });
    const w = world((r) => r.registerExtract(new WorkerExtractProcessor(client)));
    try {
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'x.txt', mimeType: 'text/plain', bytes: Buffer.from('CRASH always') });
        for (let i = 0; i < 4; i++) { await w.c.runDue(); w.clock.t += 20_000; }
        const j = (await w.store.getJob(job.jobId))!;
        assert.equal(j.state, 'dead_letter'); assert.equal(j.attempts, 3); assert.equal(j.jobId, job.jobId);
        assert.equal(w.mem.nodes.size, 0);
        // the host is fine: a healthy file still goes through the same worker
        const ok = await w.c.enqueueFile({ workspace: w.ws, fileName: 'ok.txt', mimeType: 'text/plain', bytes: Buffer.from('still alive') });
        assert.equal((await w.c.runDue()).succeeded, 1);
        assert.equal((await w.store.getJob(ok.job.jobId))!.state, 'succeeded');
    } finally { await client.dispose(); await w.store.close(); }
});

test('hang: the deadline kills the child (SIGKILL), the job is retried and then succeeds; a permanent hang dead-letters', async () => {
    const client = childClient({ entry: FIXTURE_ENTRY, timeoutMs: 700 });
    const w = world((r) => r.registerExtract(new WorkerExtractProcessor(client)));
    try {
        const marker = path.join(tmp, 'hang-once');
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'h.txt', mimeType: 'text/plain', bytes: Buffer.from(`HANGONCE:${marker}\nafter the hang\n`) });
        // Start the first attempt, note which child it is in, and make sure it is gone once the deadline has fired.
        const run = w.c.runDue();
        await sleep(400);
        const hung = workerChildren(); assert.equal(hung.length, 1, 'one child, stuck on the file');
        const s = await run;
        assert.equal(s.retried, 1);
        assert.equal(await gone(hung[0]!), true, 'hung child was killed, not left running');
        w.clock.t += 1500;
        assert.equal((await w.c.runDue()).succeeded, 1);
        assert.match(nodeText(w), /after the hang/);
        assert.equal((await w.store.getJob(job.jobId))!.attempts, 1, 'one failed attempt (the hang)');

        const bad = await w.c.enqueueFile({ workspace: w.ws, fileName: 'h2.txt', mimeType: 'text/plain', bytes: Buffer.from('HANG forever') });
        for (let i = 0; i < 3; i++) { await w.c.runDue(); w.clock.t += 20_000; }
        const j = (await w.store.getJob(bad.job.jobId))!;
        assert.equal(j.state, 'dead_letter'); assert.equal(j.attempts, 3);
    } finally { await client.dispose(); await w.store.close(); }
    assert.deepEqual(workerChildren(), [], 'no child left after dispose');
});

test('size cap in the child is permanent: dead-letter on the first attempt, no retry storm', async () => {
    const client = childClient({ maxFileBytes: 1_000 });
    const w = world((r) => r.registerExtract(new WorkerExtractProcessor(client)));
    try {
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'big.txt', mimeType: 'text/plain', bytes: Buffer.alloc(5_000, 66) });
        const s = await w.c.runDue();
        assert.equal(s.deadLettered, 1);
        assert.equal((await w.store.getJob(job.jobId))!.attempts, 1);
    } finally { await client.dispose(); await w.store.close(); }
});

test('RSS recycle: a child over its memory ceiling exits after answering and the next file gets a fresh child', async () => {
    const client = childClient({ recycleRssMb: 1 });
    try {
        const a = await client.extract({ jobId: 'a', mimeType: 'text/plain', fileName: 'a', bytes: Buffer.from('one') });
        const pidA = client.pid;
        assert.equal(a.text, 'one');
        if (pidA !== undefined) assert.equal(await gone(pidA), true, 'recycled child exited by itself');
        const b = await client.extract({ jobId: 'b', mimeType: 'text/plain', fileName: 'b', bytes: Buffer.from('two') });
        assert.equal(b.text, 'two');
        assert.notEqual(client.pid, pidA, 'fresh child');
    } finally { await client.dispose(); }
});

test('dispose(): kills the child, rejects what is in flight, leaves nothing running (ps), and is idempotent', async () => {
    const client = childClient({ entry: FIXTURE_ENTRY, timeoutMs: 60_000 });
    await client.extract({ jobId: 'w', mimeType: 'text/plain', fileName: 'w', bytes: Buffer.from('warm') });
    const pid = client.pid!; assert.ok(pid); assert.deepEqual(workerChildren(), [pid]);
    const stuck = client.extract({ jobId: 'h', mimeType: 'text/plain', fileName: 'h', bytes: Buffer.from('HANG') });
    await sleep(150);
    await client.dispose(); await client.dispose();
    await assert.rejects(stuck, (e: any) => e instanceof ProcessorError && e.retryable === true);
    assert.equal(alive(pid), false, 'process is gone');
    assert.deepEqual(workerChildren(), [], 'ps shows no extractor child');
    await assert.rejects(client.extract({ jobId: 'x', mimeType: 'text/plain', fileName: 'x', bytes: Buffer.from('after') }), /stopped/);
});

test('vision: an image goes through the local vision model to text; a scanned PDF gets one call per page and Page_Number references', async () => {
    const v = await fakeVision((n) => `scanned text ${n}`);
    const client = childClient({ vision: { baseUrl: v.url, model: 'fake-vlm', maxPages: 25 } });
    const worker = new WorkerExtractProcessor(client);
    try {
        const img = await viaProcessor(worker, PNG_1x1, 'image/png');
        assert.equal(img.text, 'scanned text 1'); assert.equal(img.confidence, 0.7);
        assert.equal(img.metadata.source, 'vision'); assert.equal(img.metadata.visionModel, 'fake-vlm');
        assert.deepEqual(v.seen[0], { model: 'fake-vlm', mime: 'image/png', png: true, prompt: v.seen[0]!.prompt });

        const scan = await viaProcessor(worker, SCAN_PDF, 'application/pdf');
        assert.equal(v.seen.length, 4, 'three pages rendered and read');
        assert.ok(v.seen.slice(1).every((s) => s.png && s.mime === 'image/png'), 'real rendered PNGs reached the model');
        assert.equal(scan.text, 'Page_Number: 1\nscanned text 2\n\nPage_Number: 2\nscanned text 3\n\nPage_Number: 3\nscanned text 4');
        assert.deepEqual(scan.chunks, [{ text: 'scanned text 2', page: 1 }, { text: 'scanned text 3', page: 2 }, { text: 'scanned text 4', page: 3 }]);
        assert.equal(scan.metadata.source, 'vision'); assert.equal(scan.metadata.visionPages, 3); assert.equal(scan.metadata.visionTruncated, false);
        assert.equal(scan.metadata.pageCount, 3);

        // a PDF WITH a text layer never touches the model
        const before = v.seen.length;
        const txt = await viaProcessor(worker, TEXT_PDF, 'application/pdf');
        assert.match(txt.text, /Quarterly report alpha/); assert.equal(v.seen.length, before);
        const plain = await viaProcessor(worker, TXT, 'text/plain');
        assert.equal(plain.text, TXT.toString('utf8')); assert.equal(v.seen.length, before);
    } finally { await client.dispose(); await v.close(); }
});

test('vision: maxPages bounds a long scan and says so; in-process + vision (no worker) behaves the same; no vision = scan returned as today', async () => {
    const v = await fakeVision();
    try {
        const inproc = buildSovereignExtractor({ extract: loadIngestHostConfig({}).extract, vision: { url: v.url, model: 'fake-vlm', maxPages: 2, timeoutMs: 20_000 } });
        assert.ok(inproc instanceof LocalExtractProcessor); assert.equal(inproc.info.version, 'in-process.1');
        const r = await viaProcessor(inproc, SCAN_PDF, 'application/pdf');
        assert.equal(v.seen.length, 2); assert.equal(r.metadata.visionPages, 2); assert.equal(r.metadata.visionTruncated, true);
        assert.deepEqual(r.chunks.map((c: { page: number }) => c.page), [1, 2]);
        const img = await viaProcessor(inproc, PNG_1x1, 'image/png');
        assert.equal(img.metadata.source, 'vision'); assert.equal(v.seen.length, 3);
        // vision off: the scanned PDF is exactly what the registry returns (textBearing false, no vision calls)
        const plain = await viaProcessor(new LocalExtractProcessor(), SCAN_PDF, 'application/pdf');
        assert.equal(plain.metadata.textBearing, false); assert.equal(plain.metadata.source, undefined); assert.equal(v.seen.length, 3);
    } finally { await v.close(); }
});

test('vision failures: an unreachable model is retryable, a model that returns nothing for a page skips it, and nothing leaves loopback', async () => {
    const dead = new WorkerExtractProcessor(childClient({ vision: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', maxPages: 5, timeoutMs: 2_000 } }));
    try {
        await assert.rejects(dead.extract({ contractVersion: 'extract.v1', jobId: 'j', workspace: 'w', sourceId: 's', fileName: 'a.png', mimeType: 'image/png', bytes: PNG_1x1 }),
            (e: any) => e instanceof ProcessorError && e.retryable === true);
    } finally { await dead.dispose(); }
    const v = await fakeVision((n) => (n === 2 ? '' : `page text ${n}`));
    const ok = new WorkerExtractProcessor(childClient({ vision: { baseUrl: v.url, model: 'm', maxPages: 5 } }));
    try {
        const r = await viaProcessor(ok, SCAN_PDF, 'application/pdf');
        assert.deepEqual(r.chunks.map((c: { page: number }) => c.page), [1, 3], 'empty page 2 is skipped, numbering is kept');
    } finally { await ok.dispose(); await v.close(); }
    // a hosted vision endpoint is refused outright; the factory degrades to no vision instead of failing ingestion
    assert.throws(() => new OpenAiVisionEngine({ baseUrl: 'https://api.openai.com/v1', model: 'gpt' }), /not loopback/);
    const p = buildSovereignExtractor({ extract: loadIngestHostConfig({}).extract, vision: { url: 'https://vision.example.com/v1', model: 'm', maxPages: 5, timeoutMs: 1000 } });
    assert.ok(p instanceof LocalExtractProcessor); assert.equal(p.info.version, 'in-process.1');
    const u = buildSovereignExtractor({ extract: { ...loadIngestHostConfig({}).extract, mode: 'url', url: 'http://example.com:9700' }, vision: null });
    assert.ok(u instanceof LocalExtractProcessor, 'a non-loopback worker URL falls back to in-process');
});

test('policy: a local-only workspace refuses a hosted extractor at enqueue and at dispatch; the worker stays local and always allowed', async () => {
    const client = childClient();
    const hosted = new AiApiExtractProcessor({ id: 'ai-api-extract', endpoint: 'https://ai.example.invalid/extract', engineVersion: '1', http: { allowlist: makeAllowlist(['https://ai.example.invalid']) }, mimeTypes: ['application/x-hosted-only'] } as never);
    const w = world((r) => { r.registerExtract(new WorkerExtractProcessor(client)); r.registerExtract(hosted); });
    try {
        await assert.rejects(w.c.enqueueFile({ workspace: w.ws, fileName: 'a.bin', mimeType: 'application/x-hosted-only', bytes: Buffer.from('zz') }), PolicyViolationError);
        await assert.rejects(w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT, extractorId: 'ai-api-extract' }), PolicyViolationError);
        assert.equal((await w.store.listJobs(w.ws)).length, 0, 'refused requests leave no job');
        // default selection for a normal file is the worker, not the hosted engine
        const { job } = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT });
        assert.equal(job.processorId, 'lore-local-extractors');
        // hosted-allowed then flipped back before dispatch: permanent policy failure
        w.policy.set(w.ws, 'hosted-allowed');
        const h = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.bin', mimeType: 'application/x-hosted-only', bytes: Buffer.from('zz') });
        w.policy.set(w.ws, 'local-only');
        await w.c.runDue();
        assert.equal((await w.store.getJob(h.job.jobId))!.state, 'dead_letter');
        assert.match((await w.store.getJob(h.job.jobId))!.lastError ?? '', /PolicyViolation/);
        assert.equal((await w.store.getJob(job.jobId))!.state, 'succeeded', 'local work is unaffected');
    } finally { await client.dispose(); await w.store.close(); }
});

test('host: extract.mode child + vision from config; jobs are processed in a child; stop() reaps it; status reports the mode', async () => {
    const v = await fakeVision((n) => `host scan ${n}`);
    const cfg = loadIngestHostConfig({
        LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: 'ws-a', LORE_INGEST_EXTRACT_WORKER: '1', LORE_INGEST_VISION_URL: v.url, LORE_INGEST_VISION_MODEL: 'fake-vlm',
        LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_DRAIN_MS: '500',
    } as NodeJS.ProcessEnv);
    const nodes: any[] = [];
    const host = await IngestionHost.start({
        config: cfg, lore: { async nodeUpsert(a: any) { nodes.push(a); return { ok: true }; } }, deploymentMode: 'local', home: process.env['LORE_HOME']!,
        listWorkspaces: () => ['ws-a'], workspacePath: (ws: string) => { const d = path.join(tmp, 'hostws', ws); fs.mkdirSync(d, { recursive: true }); return d; },
        engineFor: () => 'sqlite', autoRun: false,
    });
    try {
        assert.deepEqual(host.status().extractor, { mode: 'child', vision: true });
        assert.deepEqual(workerChildren(), [], 'lazy: no child until the first file');
        const co = await host.coordinatorFor('ws-a');
        await co.enqueueFile({ workspace: 'ws-a', fileName: 'rent.txt', mimeType: 'text/plain', bytes: TXT });
        await co.enqueueFile({ workspace: 'ws-a', fileName: 'scan.pdf', mimeType: 'application/pdf', bytes: SCAN_PDF });
        const s = await co.runDue(10);
        assert.equal(s.succeeded, 2, JSON.stringify(s));
        assert.equal(workerChildren().length, 1, 'extraction ran in exactly one child process');
        assert.match(JSON.stringify(nodes), /Unit 4B rent 2400/); assert.match(JSON.stringify(nodes), /host scan 1/);
    } finally {
        const pids = workerChildren();
        await host.stop();
        for (const p of pids) assert.equal(await gone(p), true, 'child reaped by stop()');
        await v.close();
    }
    assert.deepEqual(workerChildren(), []);
    assert.equal(host.status().extractor.mode, 'child');
});

test('host: default config spawns nothing; extract.mode url uses the loopback worker and stop() leaves it running (not owned)', async () => {
    const mk = async (env: Record<string, string>) => {
        const nodes: any[] = [];
        const host = await IngestionHost.start({
            config: loadIngestHostConfig({ LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: 'ws-b', LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_DRAIN_MS: '500', ...env } as NodeJS.ProcessEnv),
            lore: { async nodeUpsert(a: any) { nodes.push(a); return { ok: true }; } }, deploymentMode: 'local', home: process.env['LORE_HOME']!,
            listWorkspaces: () => ['ws-b'], workspacePath: (ws: string) => { const d = path.join(tmp, 'hostws2', ws, String(Math.random()).slice(2)); fs.mkdirSync(d, { recursive: true }); return d; },
            engineFor: () => 'sqlite', autoRun: false,
        });
        return { host, nodes };
    };
    const off = await mk({});
    try {
        assert.deepEqual(off.host.status().extractor, { mode: 'in-process', vision: false });
        const co = await off.host.coordinatorFor('ws-b');
        await co.enqueueFile({ workspace: 'ws-b', fileName: 'r.txt', mimeType: 'text/plain', bytes: TXT });
        assert.equal((await co.runDue(5)).succeeded, 1);
        assert.deepEqual(workerChildren(), [], 'default path never starts a worker');
    } finally { await off.host.stop(); }

    const server = await startExtractWorkerServer({ port: 0, vision: null, maxFileBytes: 50 * 1024 * 1024, timeoutMs: 20_000 });
    const on = await mk({ LORE_INGEST_EXTRACT_WORKER_URL: `http://127.0.0.1:${server.port}` });
    try {
        assert.equal(on.host.status().extractor.mode, 'url');
        const co = await on.host.coordinatorFor('ws-b');
        await co.enqueueFile({ workspace: 'ws-b', fileName: 'r.txt', mimeType: 'text/plain', bytes: TXT });
        assert.equal((await co.runDue(5)).succeeded, 1);
        assert.match(JSON.stringify(on.nodes), /Unit 5A rent 2650/);
        assert.deepEqual(workerChildren(), [], 'a URL worker is not a child of this process');
    } finally {
        await on.host.stop();
        assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200, 'separately run worker is left alone');
        await server.close();
    }
});

for (const run of queue) await run();
console.log(`\ningestion-extract-worker: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
