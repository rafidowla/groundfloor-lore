#!/usr/bin/env tsx
/**
 * WP3b — POST /api/load/jobs/<id>/cancel + runner cooperative abort.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { LoadJobsRunner } from '../packages/lore/src/storage/loadJobsRunner.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';
import type { SurrealBulkLoaderAdapter } from '../packages/lore/src/bulkLoader/surrealAdapter.js';
import type { BatchResult } from '../packages/lore/src/bulkLoader/types.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void>) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('WP3b — load-job cancel');

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp3b-load-cancel-'));
}

function makeReq(method: 'POST' | 'GET', chunks: Buffer[] = []): IncomingMessage {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        method,
        on(event: string, cb: (arg?: unknown) => void) {
            (handlers[event] ??= []).push(cb);
            return this;
        },
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

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
        setHeader() { return this; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

const loadDeps = (dir: string, store: LoadJobsStore, extra?: Record<string, unknown>) => ({
    loreDir: dir,
    loadJobsStore: store,
    deploymentMode: 'local' as const,
    dataplane: null,
    ...extra,
});

function fakeGraph(onWrite?: () => void): { ids: string[]; adapter: SurrealBulkLoaderAdapter } {
    const ids: string[] = [];
    const adapter = {
        async begin() { /* noop */ },
        async writeBatch(rows: Array<{ kind: string; row: { id?: string } }>): Promise<BatchResult> {
            onWrite?.();
            for (const r of rows) {
                if (r.kind === 'node' && r.row.id) ids.push(r.row.id);
            }
            return { written: rows.length, failed: 0, errors: [] };
        },
        async commit() { /* noop */ },
        async rollback() { /* noop */ },
        async checkpoint() {
            return { checkpointRowId: 0, offset: 0, at: new Date().toISOString() };
        },
    } as unknown as SurrealBulkLoaderAdapter;
    return { ids, adapter };
}

test('POST cancel unknown job → 404', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const res = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq('POST'), res,
        '/api/load/jobs/no-such-id/cancel', '/api/load/jobs/no-such-id/cancel',
        loadDeps(dir, store));
    assert.equal(handled, true);
    assert.equal(res._status, 404);
    assert.equal(JSON.parse(res._body).code, 'load_job_not_found');
    store.close();
});

test('POST cancel received job → cancelled; runner does not complete it', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const tmpFile = path.join(dir, 'job.jsonl');
    fs.writeFileSync(tmpFile, Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ id: `n-${i}`, type: 'note', label: `n-${i}` })).join('\n'));
    await store.create({
        jobId: 'jobRecv', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: tmpFile, createdAt: new Date().toISOString(),
    });
    const res = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq('POST'), res,
        '/api/load/jobs/jobRecv/cancel', '/api/load/jobs/jobRecv/cancel',
        loadDeps(dir, store));
    assert.equal(handled, true);
    assert.equal(res._status, 200);
    assert.equal(JSON.parse(res._body).status, 'cancelled');
    const { ids, adapter } = fakeGraph();
    const runner = new LoadJobsRunner({
        store,
        buildDispatcherDeps: async () => ({ surreal: adapter, flushThreshold: 1 }),
        config: { maxJobsPerTick: 1, log: () => {} },
    });
    const advanced = await runner.tickOnce();
    assert.equal(advanced, 0);
    const job = await store.get('jobRecv');
    assert.equal(job!.status, 'cancelled');
    assert.equal(ids.length, 0);
    store.close();
});

test('POST cancel complete job → 409', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const tmpFile = path.join(dir, 'done.jsonl');
    fs.writeFileSync(tmpFile, JSON.stringify({ id: 'n-0', type: 'note', label: 'n-0' }) + '\n');
    await store.create({
        jobId: 'jobDone', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: tmpFile, createdAt: new Date().toISOString(),
    });
    const { adapter } = fakeGraph();
    const runner = new LoadJobsRunner({
        store,
        buildDispatcherDeps: async () => ({ surreal: adapter, flushThreshold: 1 }),
        config: { maxJobsPerTick: 1, log: () => {} },
    });
    await runner.tickOnce();
    assert.equal((await store.get('jobDone'))!.status, 'complete');
    const res = fakeRes();
    await tryLoadRoutes(
        makeReq('POST'), res,
        '/api/load/jobs/jobDone/cancel', '/api/load/jobs/jobDone/cancel',
        loadDeps(dir, store, { loadJobsRunner: runner }));
    assert.equal(res._status, 409);
    assert.equal(JSON.parse(res._body).code, 'job_not_cancellable');
    store.close();
});

test('in-flight cancel: status cancelled not complete; unflushed graph rows dropped', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const tmpFile = path.join(dir, 'run.jsonl');
    fs.writeFileSync(tmpFile, Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ id: `g-${i}`, type: 'note', label: `g-${i}` })).join('\n'));
    await store.create({
        jobId: 'jobRun', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: tmpFile, createdAt: new Date().toISOString(),
    });
    const outboxRecorded: OutboxEntry[] = [];
    const outboxStore = {
        record: async (e: OutboxEntry) => { outboxRecorded.push(e); },
    } as unknown as OutboxStore;

    let runner!: LoadJobsRunner;
    const { ids, adapter } = fakeGraph(() => { runner.requestCancel('jobRun'); });
    runner = new LoadJobsRunner({
        store,
        outboxStore,
        buildDispatcherDeps: async () => ({ surreal: adapter, flushThreshold: 1 }),
        config: { maxJobsPerTick: 1, progressIntervalRows: 10_000, log: () => {} },
    });
    const advanced = await runner.tickOnce();
    assert.equal(advanced, 1);
    const job = await store.get('jobRun');
    assert.equal(job!.status, 'cancelled');
    assert.ok(ids.length >= 1, 'first flushed graph batch is durable (finished prefix)');
    assert.ok(ids.length < 20, 'unflushed graph rows must not be written after cancel');
    assert.equal(outboxRecorded.length, 1);
    assert.equal((outboxRecorded[0]!.payload as { status?: string }).status, 'cancelled');
    store.close();
});

test('HTTP cancel of running job wires runner.requestCancel', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    await store.create({
        jobId: 'jobHttp', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: path.join(dir, 'missing.jsonl'), createdAt: new Date().toISOString(),
    });
    const seen: string[] = [];
    const res = fakeRes();
    await tryLoadRoutes(
        makeReq('POST'), res,
        '/api/load/jobs/jobHttp/cancel', '/api/load/jobs/jobHttp/cancel',
        loadDeps(dir, store, { loadJobsRunner: { requestCancel: (id: string) => seen.push(id) } }));
    assert.equal(res._status, 200);
    assert.deepEqual(seen, ['jobHttp']);
    store.close();
});

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}

test('POST cancel: alpha principal cannot cancel a beta-workspace job', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    await store.create({
        jobId: 'jobBeta', workspace: 'beta', format: 'jsonl', embedMode: 'skip',
        tempFilePath: path.join(dir, 'x.jsonl'), createdAt: new Date().toISOString(),
    });
    const seen: string[] = [];
    const res = fakeRes();
    await runWithPrincipal(appPrincipal('alpha', ['read', 'write']), () =>
        tryLoadRoutes(
            makeReq('POST'), res,
            '/api/load/jobs/jobBeta/cancel', '/api/load/jobs/jobBeta/cancel',
            loadDeps(dir, store, { loadJobsRunner: { requestCancel: (id: string) => seen.push(id) } })));
    assert.equal(res._status, 403, res._body);
    assert.match(res._body, /workspace_forbidden/);
    assert.equal((await store.get('jobBeta'))!.status, 'received');
    assert.deepEqual(seen, []);
    store.close();
});

test('POST cancel: own-workspace principal can cancel', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    await store.create({
        jobId: 'jobAlpha', workspace: 'alpha', format: 'jsonl', embedMode: 'skip',
        tempFilePath: path.join(dir, 'x.jsonl'), createdAt: new Date().toISOString(),
    });
    const res = fakeRes();
    await runWithPrincipal(appPrincipal('alpha', ['read', 'write']), () =>
        tryLoadRoutes(
            makeReq('POST'), res,
            '/api/load/jobs/jobAlpha/cancel', '/api/load/jobs/jobAlpha/cancel',
            loadDeps(dir, store)));
    assert.equal(res._status, 200, res._body);
    assert.equal((await store.get('jobAlpha'))!.status, 'cancelled');
    store.close();
});

test('GET /api/load/jobs/<id>/cancel is not a cancel (path reserved for POST)', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    await store.create({
        jobId: 'jobGet', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: path.join(dir, 'x.jsonl'), createdAt: new Date().toISOString(),
    });
    const res = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq('GET'), res,
        '/api/load/jobs/jobGet/cancel', '/api/load/jobs/jobGet/cancel',
        loadDeps(dir, store));
    assert.equal(handled, true);
    assert.equal(res._status, 400, 'GET treats jobGet/cancel as an invalid job id, not a cancel');
    assert.equal((await store.get('jobGet'))!.status, 'received');
    store.close();
});

test('POST cancel rejects path-y job ids', async () => {
    const dir = mkTmpDir();
    const store = new LoadJobsStore(dir);
    const res = fakeRes();
    const handled = await tryLoadRoutes(
        makeReq('POST'), res,
        '/api/load/jobs/../secret/cancel', '/api/load/jobs/../secret/cancel',
        loadDeps(dir, store));
    assert.equal(handled, false);
    store.close();
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
