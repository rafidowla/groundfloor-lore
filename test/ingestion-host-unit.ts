#!/usr/bin/env tsx
/**
 * test/ingestion-host-unit.ts - daemon wiring for ingestion: boot on/off, listener plan + refusals, signed hosted
 * callbacks over the real separate listener, cross-workspace isolation, scheduler, boot reclaim, clean shutdown.
 * Every case runs on SQLite, and on Postgres too when LORE_PG_URL is set. Hosted processor = a fetch stub;
 * the listener binds 127.0.0.1:0. A temp LORE_HOME is set before anything reads it.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-host-'));
process.env['LORE_HOME'] = path.join(tmp, 'home');
fs.mkdirSync(process.env['LORE_HOME'], { recursive: true });

const { IngestionHost, HOSTED_STRUCTURER_ID } = await import('../packages/lore/src/ingestion/ingestionHost.js');
const { loadIngestHostConfig, isIngestionEnabled } = await import('../packages/lore/src/ingestion/hostConfig.js');
const { startIngestionHost } = await import('../packages/lore/src/mcp/ingestionBoot.js');
const { jobBearerToken, signLoreHmac } = await import('../packages/lore/src/ingestion/callbackAuth.js');
const { SqliteIngestionStore } = await import('../packages/lore/src/ingestion/sqliteStore.js');
const { SqliteTableStorage } = await import('../packages/lore/src/engines/sqliteTableStorage.js');
const { PostgresIngestionStore } = await import('../packages/lore/src/engines/postgres/postgresIngestionStore.js');
const { ingestionBackends, ING_WS_PREFIX } = await import('./helpers/ingestionBackends.js');
type Host = Awaited<ReturnType<typeof IngestionHost.start>>;

let passed = 0; let failed = 0;
const bk = await ingestionBackends(tmp, 'ingestion-host');
let backend: 'sqlite' | 'postgres' = 'sqlite';
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => Promise<void>, opts: { once?: boolean } = {}): void {
    queue.push(async () => {
        for (const b of opts.once ? bk.list.slice(0, 1) : bk.list) {
            backend = b.name; const label = opts.once ? name : `[${b.name}] ${name}`;
            try { await fn(); console.log(`  ok  ${label}`); passed++; } catch (err) { console.error(`  FAIL ${label}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
        }
    });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> { const t = Date.now(); while (!(await pred())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20); } }

const SECRET_STR = 'm'.repeat(40);
const MASTER = Buffer.from(SECRET_STR, 'utf8');
const HOSTED_URL = 'https://structuring.example.invalid/structure';
const rnd = () => Math.random().toString(36).slice(2, 8);
const wsName = (tag: string) => (backend === 'postgres' ? ING_WS_PREFIX : 'ws-') + `${tag}-${rnd()}`;
const TXT = Buffer.from('Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n');
const spec = { processorId: HOSTED_STRUCTURER_ID, itemPath: 'units', tableName: 'rr' };

function structEnvelope(jobId: string): string {
    return JSON.stringify({ data: { requestID: jobId, format: 'json', values: {
        content: { units: [{ unit: '4B', rent: 2400 }, { unit: '5A', rent: 2650 }] },
        annotations: { items: [{ index: 0, source_page: 1, source_quote: 'Unit 4B rent 2400', quote_verified: true, confidence: { score: 0.97, level: 'High', reasons: [] }, needs_review: false },
                               { index: 1, source_page: 1, source_quote: 'Unit 5A rent 2650', quote_verified: true, confidence: { score: 0.9, level: 'High', reasons: [] }, needs_review: false }], rejected: [], document: {} } } } });
}

interface Rig { host: Host; lore: { nodes: any[]; nodeUpsert(a: any): Promise<any> }; sent: Array<{ url: string; body: any }>; tables: Map<string, InstanceType<typeof SqliteTableStorage>>; wsDir: (ws: string) => string; stop(): Promise<void> }
async function rig(env: Record<string, string | undefined>, workspaces: string[], over: { mainPort?: number } = {}): Promise<Rig> {
    const sent: Rig['sent'] = []; const nodes: any[] = []; const tables = new Map<string, InstanceType<typeof SqliteTableStorage>>();
    const lore = { nodes, async nodeUpsert(a: any) { nodes.push(a); return { ok: true }; } };
    const fetchImpl = (async (url: unknown, init?: { body?: string }) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ requestID: 'remote-1' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const dirOf = (ws: string) => { const d = path.join(tmp, 'ws', ws); fs.mkdirSync(d, { recursive: true }); return d; };
    const pool = bk.pool;
    const config = loadIngestHostConfig({ LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: workspaces.join(','), ...env } as NodeJS.ProcessEnv);
    const host = await IngestionHost.start({
        config, lore, deploymentMode: 'local', fetchImpl, home: process.env['LORE_HOME']!,
        ...(over.mainPort !== undefined ? { mainPort: over.mainPort } : {}),
        listWorkspaces: () => workspaces, workspacePath: dirOf,
        engineFor: () => backend,
        ...(backend === 'postgres' ? { createStore: async (o: { workspace: string }) => PostgresIngestionStore.open(o.workspace, pool!) } : {}),
        tableStorageFor: async (ws: string) => { let t = tables.get(ws); if (!t) { t = new SqliteTableStorage(path.join(dirOf(ws), 'tables.db')); tables.set(ws, t); } return t as never; },
    });
    return { host, lore, sent, tables, wsDir: dirOf, stop: () => host.stop() };
}
const hostedEnv = (over: Record<string, string | undefined> = {}) => ({
    LORE_INGEST_HOSTED_STRUCTURING_URL: HOSTED_URL, LORE_INGEST_CALLBACK_PORT: '0', LORE_INGEST_CALLBACK_SECRET: SECRET_STR,
    LORE_INGEST_CALLBACK_PUBLIC_URL: 'https://lore.example.invalid', LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_DRAIN_MS: '400', ...over,
});
const listening = (r: Rig) => { const s = r.host.status().listener; assert.equal(s.state, 'listening', JSON.stringify(s)); return (s as { port: number }).port; };
async function post(port: number, jobId: string, body: string, headers: Record<string, string>): Promise<{ status: number; code: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/ingest/callback/${encodeURIComponent(jobId)}`, { method: 'POST', body, headers });
    const t = await res.text(); return { status: res.status, code: (JSON.parse(t) as { code: string }).code };
}
/** Enqueue a text file with the hosted structurer, run extract then dispatch; returns the structure job id. */
async function toAwaitingCallback(r: Rig, ws: string): Promise<string> {
    const co = await r.host.coordinatorFor(ws);
    await co.enqueueFile({ workspace: ws, fileName: 'rent.txt', mimeType: 'text/plain', bytes: TXT, structure: spec });
    await co.runDue(); await co.runDue();
    const sj = (await co.deps.store.listJobs(ws)).find((j) => j.stage === 'structure')!;
    assert.equal(sj.state, 'awaiting_callback'); return sj.jobId;
}

test('off by default: no flag means no host, no import of ingestion code, stop() is a no-op', async () => {
    assert.equal(isIngestionEnabled({}), false); assert.equal(isIngestionEnabled({ LORE_INGEST_ENABLED: '0' }), false);
    const b = await startIngestionHost({ lore: { nodeUpsert: async () => ({ ok: true }) }, deploymentMode: 'local', mainPort: 1, env: {} });
    assert.equal(b.host, null); await b.stop(); await b.stop();
}, { once: true });

test('enabled via the boot step starts a host (no workspaces registered here), reports status and stops cleanly', async () => {
    const b = await startIngestionHost({ lore: { nodeUpsert: async () => ({ ok: true }) }, deploymentMode: 'local', mainPort: 1, env: { LORE_INGEST_ENABLED: 'true', LORE_INGEST_DRAIN_MS: '100' } });
    assert.ok(b.host); assert.equal(b.host!.status().listener.state, 'off'); assert.equal(b.host!.status().hostedProcessor, false);
    await b.stop();
}, { once: true });

test('enabled, no callback configured: local pipeline works, no listener, no hosted processor', async () => {
    const ws = wsName('loc'); const r = await rig({ LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_DRAIN_MS: '200' }, [ws]);
    try {
        assert.equal(r.host.status().listener.state, 'off'); assert.equal(r.host.status().hostedProcessor, false);
        const co = await r.host.coordinatorFor(ws);
        const { job } = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT });
        assert.equal((await co.runDue()).succeeded, 1);
        assert.equal((await co.deps.store.getJob(job.jobId))!.state, 'succeeded'); assert.ok(r.lore.nodes.length >= 1); assert.equal(r.lore.nodes[0].workspace, ws);
    } finally { await r.stop(); }
});

test('local-only: a callback port alone (no hosted processor) or hosted URL without hosted workspaces never opens a listener', async () => {
    const ws = wsName('lo');
    const a = await rig({ LORE_INGEST_CALLBACK_PORT: '0', LORE_INGEST_CALLBACK_SECRET: SECRET_STR, LORE_INGEST_DRAIN_MS: '100' }, [ws]);
    assert.equal(a.host.status().listener.state, 'off'); await a.stop();
    const b = await rig(hostedEnv({ LORE_INGEST_HOSTED_WORKSPACES: undefined }), [ws]);
    const st = b.host.status(); assert.equal(st.listener.state, 'refused'); assert.match((st.listener as { reason: string }).reason, /hosted-allowed/); assert.equal(st.hostedProcessor, false);
    const co = await b.host.coordinatorFor(ws);
    await assert.rejects(co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT, structure: spec }), 'hosted structurer is not selectable');
    await b.stop();
});

test('refuses to listen (daemon still starts, local ingestion works, hosted disabled) on a missing or short secret, port clash, bad URLs', async () => {
    const ws = wsName('ref');
    const cases: Array<[string, Record<string, string | undefined>, RegExp, number?]> = [
        ['missing secret', { LORE_INGEST_CALLBACK_SECRET: undefined }, /secret missing or shorter/],
        ['31-byte secret', { LORE_INGEST_CALLBACK_SECRET: 's'.repeat(31) }, /secret missing or shorter/],
        ['port == main port', { LORE_INGEST_CALLBACK_PORT: '43111' }, /differ from the main daemon port/, 43111],
        ['standard-webhooks without webhook secret', { LORE_INGEST_CALLBACK_SCHEME: 'standard-webhooks' }, /webhook secret/],
        ['no public url', { LORE_INGEST_CALLBACK_PUBLIC_URL: undefined }, /PUBLIC_URL/],
        ['hosted URL over plain http to a non-loopback host', { LORE_INGEST_HOSTED_STRUCTURING_URL: 'http://structuring.example.invalid/x' }, /must be https/],
    ];
    for (const [label, over, re, mainPort] of cases) {
        const r = await rig(hostedEnv({ LORE_INGEST_HOSTED_WORKSPACES: ws, ...over }), [ws], mainPort !== undefined ? { mainPort } : {});
        try {
            const st = r.host.status(); assert.equal(st.listener.state, 'refused', label); assert.match((st.listener as { reason: string }).reason, re, label);
            assert.ok(!JSON.stringify(st).includes(SECRET_STR), `${label}: no secret in status`); assert.equal(st.hostedProcessor, false, label);
            const co = await r.host.coordinatorFor(ws); const { job } = await co.enqueueFile({ workspace: ws, fileName: `${rnd()}.txt`, mimeType: 'text/plain', bytes: Buffer.from(rnd()) });
            await co.runDue(); assert.equal((await co.deps.store.getJob(job.jobId))!.state, 'succeeded', `${label}: local still works`);
        } finally { await r.stop(); }
    }
});

test('hosted flow over the real listener: dispatch carries the callback url + per-job bearer; bad/unknown 401, good 200, replay ignored; 404/405/413 fixed', async () => {
    const ws = wsName('h'); const r = await rig(hostedEnv({ LORE_INGEST_HOSTED_WORKSPACES: ws }), [ws]);
    try {
        const port = listening(r); assert.equal(r.host.status().hostedProcessor, true);
        const jobId = await toAwaitingCallback(r, ws);
        const sent = r.sent[0]!.body; assert.equal(sent.request_id, jobId); assert.equal(sent.callback_url, `https://lore.example.invalid/api/ingest/callback/${jobId}`);
        assert.equal(sent.bearer_token, jobBearerToken(MASTER, jobId));
        const body = structEnvelope(jobId); const good = { authorization: `Bearer ${jobBearerToken(MASTER, jobId)}`, 'content-type': 'application/json' };
        for (const h of [{} as Record<string, string>, { authorization: 'Bearer nope' }, { authorization: `Bearer ${jobBearerToken(MASTER, 'job_someoneelse01')}` }]) assert.deepEqual(await post(port, jobId, body, h), { status: 401, code: 'unauthorized' });
        assert.equal((await post(port, 'job_doesnotexist0001', body, good)).status, 401, 'unknown job is indistinguishable');
        assert.deepEqual(await post(port, jobId, body, good), { status: 200, code: 'accepted' });
        const rows = await r.tables.get(ws)!.query('ingest_rr'); assert.equal(rows.length, 2);
        assert.deepEqual(await post(port, jobId, body, good), { status: 200, code: 'duplicate_ignored' }); assert.equal((await r.tables.get(ws)!.query('ingest_rr')).length, 2);
        const o = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' }); assert.equal(o.status, 404); assert.equal(await o.text(), '{"code":"not_found"}');
        const g = await fetch(`http://127.0.0.1:${port}/api/ingest/callback/${jobId}`); assert.equal(g.status, 405);
        const big = await new Promise<number>((res, rej) => {
            const s = net.connect(port, '127.0.0.1'); let buf = ''; s.on('data', (d) => { buf += d.toString(); }); s.on('close', () => res(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0))); s.on('error', rej);
            s.write(`POST /api/ingest/callback/${jobId} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nauthorization: Bearer ${jobBearerToken(MASTER, jobId)}\r\nContent-Length: ${9 * 1024 * 1024}\r\n\r\n`);
        });
        assert.equal(big, 413, 'declared oversize body');
    } finally { await r.stop(); }
});

test('lore-hmac scheme: valid signature accepted; stale timestamp and tampered body rejected', async () => {
    const ws = wsName('hm'); const r = await rig(hostedEnv({ LORE_INGEST_HOSTED_WORKSPACES: ws, LORE_INGEST_CALLBACK_SCHEME: 'lore-hmac' }), [ws]);
    try {
        const port = listening(r); const jobId = await toAwaitingCallback(r, ws); const raw = Buffer.from(structEnvelope(jobId));
        const hdr = (ts: number, b: Buffer) => ({ 'x-lore-timestamp': String(ts), 'x-lore-signature': signLoreHmac(MASTER, jobId, ts, b), 'content-type': 'application/json' });
        const now = Math.floor(Date.now() / 1000);
        assert.equal((await post(port, jobId, raw.toString(), hdr(now - 3600, raw))).status, 401, 'stale');
        assert.equal((await post(port, jobId, raw.toString() + ' ', hdr(now, raw))).status, 401, 'tampered');
        assert.equal((await post(port, jobId, raw.toString(), hdr(now, raw))).status, 200);
    } finally { await r.stop(); }
});

test('cross-workspace isolation: a coordinator cannot write another workspace; a job resolves only to its own coordinator', async () => {
    const a = wsName('iso-a'); const b = wsName('iso-b'); const r = await rig(hostedEnv({ LORE_INGEST_HOSTED_WORKSPACES: `${a},${b}` }), [a, b]);
    try {
        const port = listening(r); const jobA = await toAwaitingCallback(r, a); const jobB = await toAwaitingCallback(r, b);
        const coA = await r.host.coordinatorFor(a); const coB = await r.host.coordinatorFor(b);
        assert.equal(await r.host.resolveJob(jobA), coA); assert.equal(await r.host.resolveJob(jobB), coB); assert.equal(await r.host.resolveJob('job_nobody000000001'), undefined);
        assert.deepEqual(await coB.deps.memory.upsert({ id: 'x', workspace: a, ecosystem: 'ingestion', nodeData: { content: 'leak' } } as never), { ok: false, error: 'workspace_mismatch' });
        assert.equal(await coB.deps.tables.forWorkspace(a), null); assert.ok(await coB.deps.tables.forWorkspace(b));
        assert.equal(r.lore.nodes.filter((n) => n.nodeData?.content === 'leak').length, 0);
        // A's bearer cannot complete B's job, and the attempt writes nothing.
        const rowsOf = async (w: string) => { try { return (await r.tables.get(w)!.query('ingest_rr')).length; } catch { return 0; } };
        const before = await rowsOf(b);
        assert.equal((await post(port, jobB, structEnvelope(jobB), { authorization: `Bearer ${jobBearerToken(MASTER, jobA)}`, 'content-type': 'application/json' })).status, 401);
        assert.equal(await rowsOf(b), before);
        await assert.rejects(r.host.coordinatorFor(wsName('not-enabled')), /not enabled/);
        assert.equal((await post(port, jobA, structEnvelope(jobA), { authorization: `Bearer ${jobBearerToken(MASTER, jobA)}`, 'content-type': 'application/json' })).status, 200);
        assert.equal(await rowsOf(a), 2); assert.equal(await rowsOf(b), before);
    } finally { await r.stop(); }
});

test('scheduler: with short intervals a queued local job is processed without any manual runDue', async () => {
    const ws = wsName('sch'); const r = await rig({ LORE_INGEST_RUN_INTERVAL_MS: '100', LORE_INGEST_DRAIN_MS: '300' }, [ws]);
    try {
        const co = await r.host.coordinatorFor(ws);
        const { job } = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT });
        await until(async () => (await co.deps.store.getJob(job.jobId))!.state === 'succeeded');
    } finally { await r.stop(); }
});

test('boot reclaim: a job left running with an expired lease is queued again when the host starts', async () => {
    const ws = wsName('rec'); const r1 = await rig({ LORE_INGEST_DRAIN_MS: '100' }, [ws]);
    const co = await r1.host.coordinatorFor(ws);
    const { job } = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT });
    const claimed = await co.deps.store.claimDue(new Date(), 5, 1); assert.equal(claimed.length, 1); await sleep(30);
    assert.equal((await co.deps.store.getJob(job.jobId))!.state, 'running');
    await r1.stop();
    const r2 = await rig({ LORE_INGEST_DRAIN_MS: '100' }, [ws]);
    try {
        const co2 = await r2.host.coordinatorFor(ws);
        assert.equal((await co2.deps.store.getJob(job.jobId))!.state, 'queued', 'reclaimed at boot');
    } finally { await r2.stop(); }
});

test('clean shutdown: listener closed, coordinators gone, stop() idempotent and bounded, nothing hangs', async () => {
    const ws = wsName('sd'); const r = await rig(hostedEnv({ LORE_INGEST_HOSTED_WORKSPACES: ws, LORE_INGEST_RUN_INTERVAL_MS: '100' }), [ws]);
    const port = listening(r); const co = await r.host.coordinatorFor(ws);
    const idle = net.connect(port, '127.0.0.1'); idle.on('error', () => undefined); await new Promise<void>((res) => idle.once('connect', () => res()));
    const t0 = Date.now(); await r.stop(); await r.stop(); assert.ok(Date.now() - t0 < 3000, `stop took ${Date.now() - t0}ms`);
    await assert.rejects(new Promise<void>((res, rej) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(); }); s.once('error', rej); }), 'listener refuses connections after stop');
    await assert.rejects(r.host.coordinatorFor(ws), /stopping/); assert.deepEqual(r.host.status().workspaces, []);
    if (backend === 'sqlite') await assert.rejects(co.deps.store.getJob('job_whatever00000001'), 'sqlite store was closed');
    idle.destroy();
});

for (const q of queue) await q();
void SqliteIngestionStore;
await bk.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ingestion-host: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
