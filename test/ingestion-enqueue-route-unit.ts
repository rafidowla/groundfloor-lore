#!/usr/bin/env tsx
/**
 * test/ingestion-enqueue-route-unit.ts - the admin HTTP enqueue route (POST /api/admin/ingest/enqueue, GET
 * /api/admin/ingest/jobs/<id>): auth lane, ingestion off, workspace checks, body limits, file name / mime / structure
 * validation, happy path through runDue, duplicates, status, in-flight cap, and "no exception text leaks".
 * The route runs behind a real node:http server (so Content-Length and streaming behave for real); the caller's
 * principal is chosen per request by the x-test-who header. Cases that touch the store run on SQLite, and on
 * Postgres too when LORE_PG_URL is set. A temp LORE_HOME is set before anything reads it.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-enqueue-'));
process.env['LORE_HOME'] = path.join(tmp, 'home');
fs.mkdirSync(process.env['LORE_HOME'], { recursive: true });

const { IngestionHost, HOSTED_STRUCTURER_ID } = await import('../packages/lore/src/ingestion/ingestionHost.js');
const { loadIngestHostConfig } = await import('../packages/lore/src/ingestion/hostConfig.js');
const { startIngestionHost, getActiveIngestionHost } = await import('../packages/lore/src/mcp/ingestionBoot.js');
const { tryIngestEnqueueRoutes, inflightEnqueues, MAX_INFLIGHT_ENQUEUES, wireCapFor } = await import('../packages/lore/src/mcp/http/routes/ingestEnqueue.js');
const { PostgresIngestionStore } = await import('../packages/lore/src/engines/postgres/postgresIngestionStore.js');
const { SqliteTableStorage } = await import('../packages/lore/src/engines/sqliteTableStorage.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { ingestionBackends, ING_WS_PREFIX } = await import('./helpers/ingestionBackends.js');
type Host = Awaited<ReturnType<typeof IngestionHost.start>>;
type Principal = import('../packages/lore/src/auth/principal.js').Principal;

let passed = 0; let failed = 0;
const bk = await ingestionBackends(tmp, 'ingestion-enqueue');
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
const rnd = () => Math.random().toString(36).slice(2, 8);
const wsName = (tag: string) => (backend === 'postgres' ? ING_WS_PREFIX : 'ws-') + `${tag}-${rnd()}`;
const TXT = Buffer.from('Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n');
const SECRET_STR = 'm'.repeat(40);
const LEAK = 'LEAK-MARKER-/Users/nobody/secret';

const PRINCIPALS: Record<string, Principal | null> = {
    bootstrap: { kind: 'bootstrap', workspace: 'boot', scopes: ['read', 'write'], label: 'bootstrap' },
    shared: { kind: 'shared-secret', workspace: 'boot', scopes: ['read', 'write'], label: 'shared-secret' },
    appRead: { kind: 'app', workspace: 'w', scopes: ['read'], label: 'app-r' },
    appWrite: { kind: 'app', workspace: 'w', scopes: ['read', 'write'], label: 'app-w' },
    appXws: { kind: 'app', workspace: 'w', scopes: ['read', 'write', 'cross-workspace-write'], label: 'app-x' },
    none: null,
};

interface Rig {
    host: Host; url: string; lore: { nodes: any[] }; jobsOf: (ws: string) => Promise<number>; hostRef: { current: any };
    stop(): Promise<void>;
}
/** A real host (local extractor, stub memory port) behind a real http server running only the enqueue route. */
async function rig(env: Record<string, string | undefined>, eligible: string[], registered: string[] = eligible): Promise<Rig> {
    const nodes: any[] = [];
    const lore = { nodes, async nodeUpsert(a: any) { nodes.push(a); return { ok: true }; } };
    const dirOf = (ws: string) => { const d = path.join(tmp, 'ws', ws); fs.mkdirSync(d, { recursive: true }); return d; };
    const tables = new Map<string, InstanceType<typeof SqliteTableStorage>>();
    const pool = bk.pool;
    const config = loadIngestHostConfig({ LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: eligible.join(','), LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_DRAIN_MS: '200', ...env } as NodeJS.ProcessEnv);
    const host = await IngestionHost.start({
        config, lore, deploymentMode: 'local', fetchImpl: (async () => new Response('{}', { status: 202 })) as unknown as typeof fetch,
        home: process.env['LORE_HOME']!, listWorkspaces: () => registered, workspacePath: dirOf, engineFor: () => backend,
        ...(backend === 'postgres' ? { createStore: async (o: { workspace: string }) => PostgresIngestionStore.open(o.workspace, pool!) } : {}),
        tableStorageFor: async (ws: string) => { let t = tables.get(ws); if (!t) { t = new SqliteTableStorage(path.join(dirOf(ws), 'tables.db')); tables.set(ws, t); } return t as never; },
    });
    const hostRef: { current: any } = { current: host };
    const server = http.createServer((req, res) => {
        const who = String(req.headers['x-test-who'] ?? 'bootstrap');
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        const run = () => tryIngestEnqueueRoutes(req, res, req.url ?? '/', pathname, { getIngestionHost: () => hostRef.current, deploymentMode: 'local', dataplane: null })
            .then((handled) => { if (!handled) { res.writeHead(404); res.end('{}'); } })
            .catch(() => { if (!res.writableEnded) { res.writeHead(599); res.end('{}'); } });
        if (who === 'actor') runWithActor({ portalUserId: 'u1', scopes: [] }, run);
        else { const p = PRINCIPALS[who]; if (p) runWithPrincipal(p, run); else run(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    return {
        host, url, lore, hostRef,
        jobsOf: async (ws) => (await (await host.coordinatorFor(ws)).deps.store.listJobs(ws)).length,
        stop: async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }); await host.stop(); },
    };
}

interface Reply { status: number; body: any; text: string; headers: Headers }
async function call(r: Rig, method: 'POST' | 'GET', p: string, body?: unknown, who = 'bootstrap'): Promise<Reply> {
    const res = await fetch(r.url + p, { method, headers: { 'x-test-who': who, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const text = await res.text(); let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const ENQ = '/api/admin/ingest/enqueue';
const good = (ws: string, over: Record<string, unknown> = {}) => ({ workspace: ws, fileName: 'rent.txt', mimeType: 'text/plain', contentBase64: TXT.toString('base64'), ...over });
function assertFixedError(r: Reply, status: number, code: string): void {
    assert.equal(r.status, status, r.text); assert.equal(r.body.code, code, r.text);
    assert.equal(typeof r.body.message, 'string'); assert.ok(!r.text.includes(LEAK));
}

test('auth lane: operators pass; read-only, plain app token and a row-scoped actor are refused and nothing is queued', async () => {
    const ws = wsName('auth'); const r = await rig({}, [ws]);
    try {
        for (const who of ['bootstrap', 'shared', 'none', 'appXws']) {
            const out = await call(r, 'POST', ENQ, good(ws, { fileName: `${who}.txt`, contentBase64: Buffer.from(`body-${who}`).toString('base64') }), who);
            assert.equal(out.status, 202, `${who}: ${out.text}`);
        }
        const before = await r.jobsOf(ws); assert.equal(before, 4);
        const denied: Array<[string, string]> = [['appRead', 'denied'], ['appWrite', 'workspace_forbidden'], ['actor', 'maintenance_forbidden']];
        for (const [who, code] of denied) {
            const out = await call(r, 'POST', ENQ, good(ws, { fileName: `denied-${who}.txt`, contentBase64: Buffer.from(`x${who}`).toString('base64') }), who);
            assertFixedError(out, 403, code);
            const st = await call(r, 'GET', `/api/admin/ingest/jobs/job_x?workspace=${ws}`, undefined, who);
            assert.equal(st.status, 403, `${who} status: ${st.text}`);
        }
        assert.equal(await r.jobsOf(ws), before, 'a refused caller queued nothing');
    } finally { await r.stop(); }
});

test('unmatched shapes fall through: other methods and paths are not handled by this route', async () => {
    const ws = wsName('thru'); const r = await rig({}, [ws]);
    try {
        assert.equal((await call(r, 'GET', ENQ)).status, 404);
        assert.equal((await call(r, 'POST', '/api/admin/ingest/jobs/job_x', good(ws))).status, 404);
        assert.equal((await call(r, 'GET', '/api/admin/ingest/jobs/')).status, 404);
        assert.equal((await call(r, 'GET', '/api/admin/ingest/other')).status, 404);
    } finally { await r.stop(); }
}, { once: true });

test('ingestion off: a fixed 404 for both routes, no body read needed', async () => {
    const ws = wsName('off'); const r = await rig({}, [ws]);
    try {
        r.hostRef.current = null;
        assertFixedError(await call(r, 'POST', ENQ, good(ws)), 404, 'ingestion_unavailable');
        assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/job_x?workspace=${ws}`), 404, 'ingestion_unavailable');
        r.hostRef.current = r.host;
    } finally { await r.stop(); }
}, { once: true });

test('boot registry: the running host is reachable through getActiveIngestionHost and cleared on stop', async () => {
    assert.equal(getActiveIngestionHost(), null);
    const off = await startIngestionHost({ lore: { nodeUpsert: async () => ({ ok: true }) }, deploymentMode: 'local', mainPort: 1, env: {} });
    assert.equal(getActiveIngestionHost(), null); await off.stop();
    const b = await startIngestionHost({ lore: { nodeUpsert: async () => ({ ok: true }) }, deploymentMode: 'local', mainPort: 1, env: { LORE_INGEST_ENABLED: '1', LORE_INGEST_DRAIN_MS: '100' } });
    assert.ok(b.host); assert.equal(getActiveIngestionHost(), b.host);
    await b.stop(); assert.equal(getActiveIngestionHost(), null); await b.stop();
}, { once: true });

test('workspace: required, well-formed, registered and enabled; never defaulted', async () => {
    const ws = wsName('wsa'); const other = wsName('wsb'); const r = await rig({}, [ws], [ws, other]);
    try {
        const { workspace: _w, ...noWs } = good(ws);
        assertFixedError(await call(r, 'POST', ENQ, noWs), 400, 'workspace_required');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { workspace: '' })), 400, 'workspace_required');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { workspace: 42 })), 400, 'invalid_workspace');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { workspace: 'a\u0000b' })), 400, 'invalid_workspace');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { workspace: 'x'.repeat(300) })), 400, 'invalid_workspace');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { workspace: 'ws-does-not-exist' })), 404, 'workspace_not_found');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { workspace: '../../etc' })), 404, 'workspace_not_found');
        assertFixedError(await call(r, 'POST', ENQ, good(other)), 409, 'ingestion_workspace_not_enabled');
        assertFixedError(await call(r, 'GET', '/api/admin/ingest/jobs/job_x'), 400, 'workspace_required');
        assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/job_x?workspace=${other}`), 409, 'ingestion_workspace_not_enabled');
        assertFixedError(await call(r, 'GET', '/api/admin/ingest/jobs/job_x?workspace=nope'), 404, 'workspace_not_found');
        assert.equal(await r.jobsOf(ws), 0);
    } finally { await r.stop(); }
});

test('body size: declared oversize gets 413 without reading; real overflow and decoded overflow also 413', async () => {
    const ws = wsName('big'); const r = await rig({ LORE_INGEST_ENQUEUE_MAX_BYTES: '2048' }, [ws]);
    try {
        assert.equal(r.host.enqueueMaxBytes(), 2048);
        // 1. Declared: send headers only, with a Content-Length far above the cap, and never send the body.
        const port = Number(new URL(r.url).port);
        const raw = await new Promise<string>((resolve, reject) => {
            const s = net.connect(port, '127.0.0.1'); let buf = '';
            s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n') && buf.includes('}')) { s.destroy(); resolve(buf); } });
            s.on('error', reject); setTimeout(() => { s.destroy(); reject(new Error('no early 413 for a declared oversize')); }, 3000).unref();
            s.write(`POST ${ENQ} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-test-who: bootstrap\r\nContent-Type: application/json\r\nContent-Length: 99999999999\r\n\r\n`);
        });
        assert.ok(raw.startsWith('HTTP/1.1 413'), raw); assert.ok(raw.includes('payload_too_large'));
        // 2. Streamed past the wire cap (no usable Content-Length: chunked).
        const huge = JSON.stringify(good(ws, { contentBase64: 'A'.repeat(wireCapFor(2048) + 4096) }));
        const chunked = await new Promise<number>((resolve, reject) => {
            const q = http.request(r.url + ENQ, { method: 'POST', headers: { 'x-test-who': 'bootstrap', 'transfer-encoding': 'chunked', 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
            q.on('error', (e) => { if ((e as NodeJS.ErrnoException).code === 'ECONNRESET' || (e as NodeJS.ErrnoException).code === 'EPIPE') resolve(413); else reject(e); });
            q.write(huge.slice(0, 100_000)); q.write(huge.slice(100_000)); q.end();
        });
        assert.equal(chunked, 413);
        // 3. Fits on the wire but decodes above the cap.
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { contentBase64: Buffer.alloc(3000, 1).toString('base64') })), 413, 'payload_too_large');
        // Exactly at the cap is accepted.
        assert.equal((await call(r, 'POST', ENQ, good(ws, { contentBase64: Buffer.alloc(2048, 7).toString('base64'), fileName: 'cap.txt' }))).status, 202);
        assert.equal(await r.jobsOf(ws), 1); assert.equal(inflightEnqueues(), 0);
    } finally { await r.stop(); }
});

test('fileName: bare names only (no separators, NUL, control or bidi characters, dot names, long names)', async () => {
    const ws = wsName('fn'); const r = await rig({}, [ws]);
    try {
        const bad = ['', '.', '..', '../x.txt', 'a/b.txt', 'a\\b.txt', 'a\u0000.txt', 'a\nb.txt', 'a\u0007.txt', 'txt‮gpj.exe', ' lead.txt', 'trail.txt ', 'é'.repeat(200), 'x'.repeat(256), 12, null, ['a.txt']];
        for (const fileName of bad) assertFixedError(await call(r, 'POST', ENQ, good(ws, { fileName })), 400, 'invalid_file_name');
        const missing = good(ws) as Record<string, unknown>; delete missing['fileName'];
        assertFixedError(await call(r, 'POST', ENQ, missing), 400, 'invalid_file_name');
        for (const fileName of ['rent roll 2026.txt', 'x'.repeat(255), 'résumé.txt', 'a.b.c']) {
            assert.equal((await call(r, 'POST', ENQ, good(ws, { fileName, contentBase64: Buffer.from(fileName).toString('base64') }))).status, 202, fileName);
        }
        assert.equal(await r.jobsOf(ws), 4);
    } finally { await r.stop(); }
});

test('mimeType, content and structure shapes are validated', async () => {
    const ws = wsName('shape'); const r = await rig({}, [ws]);
    try {
        for (const mimeType of ['', 'text', 'text/', '/plain', 'text/plain; charset=utf-8', 'text/pla in', 'a/b/c', 7, undefined, 'x'.repeat(300) + '/y'])
            assertFixedError(await call(r, 'POST', ENQ, good(ws, { mimeType })), 400, 'invalid_mime_type');
        for (const contentBase64 of ['', 'abc', 'ab!d', 'AAAA=AAA', '====', 5, undefined, 'AA\nAA', 'A===', 'AAAA AAAA'])
            assertFixedError(await call(r, 'POST', ENQ, good(ws, { contentBase64 })), 400, 'invalid_file_content');
        const badStructures: unknown[] = [
            'x', [], null, {}, { processorId: '' }, { processorId: 5 }, { processorId: 'p', extra: 1 }, { processorId: 'p', itemKey: 'k' }, { processorId: 'p', itemKey: [] },
            { processorId: 'p', itemKey: [1] }, { processorId: 'p', reviewThreshold: 2 }, { processorId: 'p', reviewThreshold: 'x' }, { processorId: 'p', sourceRefs: 'yes' },
            { processorId: 'p', outputSchema: [] }, { processorId: 'p', outputSchema: 'x' }, { processorId: 'p', tableName: 'a\u0000b' }, { processorId: 'p', instructions: 'x'.repeat(9000) },
            { processorId: 'p', __proto__x: 1 },
        ];
        for (const structure of badStructures) assertFixedError(await call(r, 'POST', ENQ, good(ws, { structure })), 400, 'invalid_structure');
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { extractorId: '' })), 400, 'invalid_structure');
        for (const body of ['not json', '[1]', '"s"', '{"a":']) assertFixedError(await call(r, 'POST', ENQ, body), 400, 'invalid_json_body');
        assert.equal(await r.jobsOf(ws), 0, 'nothing validated-out was queued');
    } finally { await r.stop(); }
}, { once: true });

test('happy path: 202 {jobId, sourceId, created, state}, runDue processes it, status route reports it', async () => {
    const ws = wsName('ok'); const r = await rig({}, [ws]);
    try {
        const out = await call(r, 'POST', ENQ, good(ws));
        assert.equal(out.status, 202, out.text);
        assert.deepEqual(Object.keys(out.body).sort(), ['created', 'jobId', 'sourceId', 'state']);
        assert.equal(out.body.created, true); assert.equal(out.body.state, 'queued');
        assert.match(out.body.jobId, /^[A-Za-z0-9._:-]+$/);
        const q = await call(r, 'GET', `/api/admin/ingest/jobs/${encodeURIComponent(out.body.jobId)}?workspace=${encodeURIComponent(ws)}`);
        assert.equal(q.status, 200, q.text); assert.equal(q.body.job.state, 'queued'); assert.equal(q.body.job.stage, 'extract'); assert.equal(q.body.job.workspace, ws);
        assert.equal(q.body.job.sourceId, out.body.sourceId); assert.equal(q.body.job.hasError, false); assert.ok(!('lastError' in q.body.job)); assert.ok(!('result' in q.body.job));
        const co = await r.host.coordinatorFor(ws);
        assert.equal((await co.runDue()).succeeded, 1);
        const done = await call(r, 'GET', `/api/admin/ingest/jobs/${out.body.jobId}?workspace=${ws}`);
        assert.equal(done.body.job.state, 'succeeded'); assert.ok(done.body.job.completedAt);
        assert.ok(r.lore.nodes.length >= 1); assert.equal(r.lore.nodes[0].workspace, ws);
        assert.equal(inflightEnqueues(), 0);
    } finally { await r.stop(); }
});

test('structure spec is carried onto the job; duplicate (same bytes and options) returns created:false', async () => {
    const ws = wsName('dup'); const r = await rig({}, [ws]);
    try {
        const first = await call(r, 'POST', ENQ, good(ws));
        const again = await call(r, 'POST', ENQ, good(ws, { fileName: 'renamed.txt' }));
        assert.equal(first.status, 202); assert.equal(again.status, 200, again.text);
        assert.equal(again.body.created, false); assert.equal(again.body.jobId, first.body.jobId); assert.equal(again.body.sourceId, first.body.sourceId);
        assert.equal(await r.jobsOf(ws), 1);
        // A different payload is a different job.
        const other = await call(r, 'POST', ENQ, good(ws, { contentBase64: Buffer.from('different').toString('base64') }));
        assert.equal(other.body.created, true); assert.notEqual(other.body.jobId, first.body.jobId);
        // The same file with a structure spec is a distinct job whose params hold the spec (no hosted structurer here: refused).
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { structure: { processorId: HOSTED_STRUCTURER_ID, itemPath: 'units' } })), 422, 'ingest_no_processor');
    } finally { await r.stop(); }
});

test('processor errors map to 4xx with fixed bodies: unsupported type and a hosted structurer on a local-only workspace', async () => {
    const ws = wsName('proc'); const hostedWs = wsName('hosted');
    const r = await rig({
        LORE_INGEST_HOSTED_WORKSPACES: hostedWs, LORE_INGEST_HOSTED_STRUCTURING_URL: 'https://structuring.example.invalid/structure', LORE_INGEST_CALLBACK_PORT: '0',
        LORE_INGEST_CALLBACK_SECRET: SECRET_STR, LORE_INGEST_CALLBACK_PUBLIC_URL: 'https://lore.example.invalid',
    }, [ws, hostedWs]);
    try {
        assertFixedError(await call(r, 'POST', ENQ, good(ws, { mimeType: 'application/x-nothing-reads-this' })), 422, 'ingest_no_processor');
        const viol = await call(r, 'POST', ENQ, good(ws, { structure: { processorId: HOSTED_STRUCTURER_ID, itemPath: 'units' } }));
        assertFixedError(viol, 422, 'ingest_policy_violation');
        assert.ok(!viol.text.includes(ws), 'the refusal does not echo internals');
        const ok = await call(r, 'POST', ENQ, good(hostedWs, { structure: { processorId: HOSTED_STRUCTURER_ID, itemPath: 'units', tableName: 'rr', reviewThreshold: 0.5, sourceRefs: true, itemKey: ['unit'], outputSchema: { type: 'object' } } }));
        assert.equal(ok.status, 202, ok.text);
        const job = await (await r.host.coordinatorFor(hostedWs)).deps.store.getJob(ok.body.jobId);
        assert.equal((job!.params as any).structure.processorId, HOSTED_STRUCTURER_ID); assert.equal((job!.params as any).structure.tableName, 'rr');
        assert.equal(await r.jobsOf(ws), 0, 'refused requests recorded nothing');
    } finally { await r.stop(); }
});

test('status route: job ids are validated and bound to the named workspace', async () => {
    const a = wsName('sa'); const b = wsName('sb'); const r = await rig({}, [a, b]);
    try {
        const made = await call(r, 'POST', ENQ, good(a));
        assert.equal((await call(r, 'GET', `/api/admin/ingest/jobs/${made.body.jobId}?workspace=${a}`)).status, 200);
        assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/${made.body.jobId}?workspace=${b}`), 404, 'job_not_found');
        assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/job_does_not_exist?workspace=${a}`), 404, 'job_not_found');
        for (const id of ['%2e%2e%2fx', 'a%00b', '%E0%A4%A', 'a b', 'x'.repeat(300)]) assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/${id}?workspace=${a}`), 400, 'invalid_job_id');
    } finally { await r.stop(); }
});

test('status reports failure without leaking the processor error text', async () => {
    const ws = wsName('fail'); const r = await rig({}, [ws]);
    try {
        // Bytes the text extractor accepts but the pdf extractor will reject: a deterministic extraction failure.
        const out = await call(r, 'POST', ENQ, good(ws, { fileName: 'broken.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('this is not a pdf ' + LEAK).toString('base64') }));
        assert.equal(out.status, 202, out.text);
        const co = await r.host.coordinatorFor(ws); await co.runDue();
        const st = await call(r, 'GET', `/api/admin/ingest/jobs/${out.body.jobId}?workspace=${ws}`);
        assert.equal(st.status, 200); assert.notEqual(st.body.job.state, 'queued'); assert.equal(st.body.job.hasError, true);
        assert.ok(!st.text.includes('not a pdf') && !st.text.includes(LEAK) && !st.text.includes('extraction failed'));
    } finally { await r.stop(); }
});

test('internal failures answer a fixed 500/503 and never return exception text', async () => {
    const ws = wsName('boom'); const r = await rig({}, [ws]);
    try {
        const fake = (co: () => Promise<unknown>) => ({ workspaceState: () => 'enabled', enqueueMaxBytes: () => 1 << 20, coordinatorFor: co });
        r.hostRef.current = fake(() => Promise.reject(new Error(LEAK)));
        assertFixedError(await call(r, 'POST', ENQ, good(ws)), 503, 'ingestion_unavailable');
        assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/job_x?workspace=${ws}`), 503, 'ingestion_unavailable');
        r.hostRef.current = fake(async () => ({ enqueueFile: async () => { throw new Error(LEAK); }, deps: { store: { getJob: async () => { throw new Error(LEAK); } } } }));
        assertFixedError(await call(r, 'POST', ENQ, good(ws)), 500, 'internal_error');
        assertFixedError(await call(r, 'GET', `/api/admin/ingest/jobs/job_x?workspace=${ws}`), 500, 'internal_error');
        assert.equal(inflightEnqueues(), 0, 'the in-flight counter is released on failure');
    } finally { r.hostRef.current = r.host; await r.stop(); }
}, { once: true });

test('in-flight cap: uploads beyond the limit get 503 ingest_busy + Retry-After, and the slot is released after', async () => {
    const ws = wsName('busy'); const r = await rig({}, [ws]);
    try {
        const port = Number(new URL(r.url).port);
        const open: net.Socket[] = [];
        for (let i = 0; i < MAX_INFLIGHT_ENQUEUES; i++) {
            const s = net.connect(port, '127.0.0.1');
            await new Promise<void>((res) => s.once('connect', () => res()));
            s.write(`POST ${ENQ} HTTP/1.1\r\nHost: x\r\nx-test-who: bootstrap\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`); // body never completes
            open.push(s);
        }
        for (let i = 0; i < 100 && inflightEnqueues() < MAX_INFLIGHT_ENQUEUES; i++) await new Promise((res) => setTimeout(res, 20));
        assert.equal(inflightEnqueues(), MAX_INFLIGHT_ENQUEUES);
        const busy = await call(r, 'POST', ENQ, good(ws));
        assertFixedError(busy, 503, 'ingest_busy'); assert.equal(busy.headers.get('retry-after'), '5');
        for (const s of open) s.destroy();
        for (let i = 0; i < 100 && inflightEnqueues() > 0; i++) await new Promise((res) => setTimeout(res, 20));
        assert.equal(inflightEnqueues(), 0, 'abandoned uploads release their slots');
        assert.equal((await call(r, 'POST', ENQ, good(ws))).status, 202);
    } finally { await r.stop(); }
}, { once: true });

for (const q of queue) await q();
await bk.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ingestion-enqueue-route: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
