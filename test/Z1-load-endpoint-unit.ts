#!/usr/bin/env tsx
/**
 * test/Z1-load-endpoint-unit.ts — Sprint Z1 streaming-upload endpoint
 * unit tests.
 *
 * Drives tryLoadRoutes directly with a tmp-dir LoadJobsStore + a stub
 * OutboxStore so the per-endpoint contract (workspace_required,
 * backpressure, job creation, chunked-upload byte tracking) is pinned
 * without needing a live daemon.
 *
 * Pins from Z1 spec:
 *   - POST /api/load?workspace=X → 200 + job_id immediately
 *   - POST /api/load without workspace → 400 workspace_required (Z-D7 sentinel)
 *   - POST /api/load when outbox lag exceeds threshold → 503 outbox_lag
 *   - GET /api/load/jobs/<id> existing → 200 with state
 *   - GET /api/load/jobs/<id> unknown → 404 load_job_not_found
 *   - GET /api/load/jobs?workspace=X → list shape
 *   - Multi-chunk streamed upload → bytes_received accurate end-to-end
 *   - load.received outbox entry emitted on receive-complete
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void>) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('Sprint Z1 — POST /api/load + GET /api/load/jobs');

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'z1-load-'));
}

interface ReqOpts { method: 'POST' | 'GET'; chunks?: Buffer[]; }
function makeReq(opts: ReqOpts): IncomingMessage {
    const chunks = opts.chunks ?? [];
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        method: opts.method,
        on(event: string, cb: (arg?: unknown) => void) {
            (handlers[event] ??= []).push(cb);
            return this;
        },
        // helper for the test driver to flush
        _flush(): void {
            for (const c of chunks) {
                for (const cb of handlers['data'] ?? []) cb(c);
            }
            for (const cb of handlers['end'] ?? []) cb();
        },
    } as unknown as IncomingMessage & { _flush(): void };
    setImmediate(() => (req as unknown as { _flush(): void })._flush());
    return req;
}

function fakeRes(): ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
    const r = {
        _status: 0, _body: '', _headers: {} as Record<string, string>,
        writeHead(s: number, headers?: Record<string, string>) {
            (this as { _status: number })._status = s;
            if (headers) (this as { _headers: Record<string, string> })._headers = { ...headers };
            return this;
        },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
}

function makeStubOutbox(): { records: OutboxEntry[]; store: OutboxStore } {
    const records: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(e: OutboxEntry) { records.push(e); },
        async markStep() { /* noop */ },
        async markCompleted() { /* noop */ },
        async remove() { /* noop */ },
        async listUnfinished() { return []; },
    };
    return { records, store };
}

interface LagCacheStub {
    shouldBackpressure: (ws: string) => {
        shouldBlock: boolean; currentLagSeconds: number; thresholdSeconds: number;
        outboxDepth: number; cacheMiss: boolean;
    };
}
function makeLagCache(block: boolean): LagCacheStub {
    return {
        shouldBackpressure: () => ({
            shouldBlock: block,
            currentLagSeconds: block ? 999 : 0,
            thresholdSeconds: 60,
            outboxDepth: block ? 5000 : 0,
            cacheMiss: false,
        }),
    };
}

// ─── tests ───────────────────────────────────────────────────────────────

test('Z1-T1 POST /api/load with workspace → 200 + job_id', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const { store: outbox, records } = makeStubOutbox();
    const req = makeReq({ method: 'POST', chunks: [Buffer.from('{"id":"a"}\n')] });
    const res = fakeRes();
    const handled = await tryLoadRoutes(req, res, '/api/load?workspace=default', '/api/load',
        { loreDir: dir, loadJobsStore: store, outboxStore: outbox, deploymentMode: 'local', dataplane: null });
    assert.equal(handled, true);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.ok(body.job_id, 'job_id present');
    assert.equal(body.status, 'received');
    assert.equal(body.workspace, 'default');
    assert.equal(body.format, 'jsonl');
    assert.equal(body.embed, 'skip');
    assert.equal(records.length, 1);
    assert.equal(records[0].operationKind, 'load.received');
    store.close();
});

test('Z1-T2 POST /api/load without workspace → 400 workspace_required (Z-D7)', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    const handled = await tryLoadRoutes(req, res, '/api/load', '/api/load',
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    assert.equal(handled, true);
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'workspace_required');
    store.close();
});

test('Z1-T3 POST /api/load when outbox lag exceeds threshold → 503 outbox_lag', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const lagCache = makeLagCache(true);
    const req = makeReq({ method: 'POST', chunks: [Buffer.from('x')] });
    const res = fakeRes();
    const handled = await tryLoadRoutes(req, res, '/api/load?workspace=default', '/api/load',
        { loreDir: dir, loadJobsStore: store, outboxLagCache: lagCache, deploymentMode: 'local', dataplane: null });
    assert.equal(handled, true);
    assert.equal(res._status, 503);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'outbox_lag');
    assert.ok(res._headers['Retry-After'], 'Retry-After header present');
    store.close();
});

test('Z1-T4 GET /api/load/jobs/<id> existing → 200 with state', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    // Create via POST first
    const req = makeReq({ method: 'POST', chunks: [Buffer.from('hello world')] });
    const res = fakeRes();
    await tryLoadRoutes(req, res, '/api/load?workspace=default', '/api/load',
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    const { job_id } = JSON.parse(res._body);
    // Now read
    const getRes = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq({ method: 'GET' }), getRes,
        `/api/load/jobs/${job_id}`, `/api/load/jobs/${job_id}`,
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    assert.equal(handled, true);
    assert.equal(getRes._status, 200);
    const body = JSON.parse(getRes._body);
    assert.equal(body.job_id, job_id);
    assert.equal(body.status, 'received');
    assert.equal(typeof body.rowsProcessed, 'number');
    store.close();
});

test('Z1-T5 GET /api/load/jobs/<id> unknown → 404', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const res = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq({ method: 'GET' }), res,
        '/api/load/jobs/no-such-id', '/api/load/jobs/no-such-id',
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    assert.equal(handled, true);
    assert.equal(res._status, 404);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'load_job_not_found');
    store.close();
});

test('Z1-T6 GET /api/load/jobs?workspace=X → list shape', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    // Create two jobs
    for (let i = 0; i < 2; i++) {
        const req = makeReq({ method: 'POST', chunks: [Buffer.from(`row${i}\n`)] });
        const res = fakeRes();
        await tryLoadRoutes(req, res, '/api/load?workspace=default', '/api/load',
            { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    }
    const listRes = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq({ method: 'GET' }), listRes,
        '/api/load/jobs?workspace=default', '/api/load/jobs',
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    assert.equal(handled, true);
    assert.equal(listRes._status, 200);
    const body = JSON.parse(listRes._body);
    assert.equal(body.workspace, 'default');
    assert.equal(body.count, 2);
    assert.ok(Array.isArray(body.jobs));
    assert.equal(body.jobs.length, 2);
    store.close();
});

test('Z1-T7 multi-chunk streamed upload → bytes_received accurate', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const chunks = [
        Buffer.from('{"row":1}\n'),
        Buffer.from('{"row":2}\n'),
        Buffer.from('{"row":3}\n'),
    ];
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const req = makeReq({ method: 'POST', chunks });
    const res = fakeRes();
    await tryLoadRoutes(req, res, '/api/load?workspace=default&format=jsonl', '/api/load',
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    const body = JSON.parse(res._body);
    assert.equal(body.bytesReceived, total);
    // Reread via GET to confirm persisted value
    const getRes = fakeRes();
    await tryLoadRoutes(
        makeReq({ method: 'GET' }), getRes,
        `/api/load/jobs/${body.job_id}`, `/api/load/jobs/${body.job_id}`,
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    const persisted = JSON.parse(getRes._body);
    assert.equal(persisted.bytesReceived, total);
    store.close();
});

test('Z1-T8 load.received outbox entry payload includes jobId + tempFilePath', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const { store: outbox, records } = makeStubOutbox();
    const req = makeReq({ method: 'POST', chunks: [Buffer.from('hi')] });
    const res = fakeRes();
    await tryLoadRoutes(req, res, '/api/load?workspace=ws1', '/api/load',
        { loreDir: dir, loadJobsStore: store, outboxStore: outbox, deploymentMode: 'local', dataplane: null });
    const { job_id } = JSON.parse(res._body);
    assert.equal(records.length, 1);
    const entry = records[0];
    assert.equal(entry.operationKind, 'load.received');
    assert.equal(entry.workspace, 'ws1');
    assert.equal((entry.payload as { jobId: string }).jobId, job_id);
    assert.ok((entry.payload as { tempFilePath: string }).tempFilePath.includes(job_id));
    store.close();
});

await Promise.all(pending);
console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
