#!/usr/bin/env tsx
/**
 * test/link-load-job-autolink-unit.ts - call-level `autolink` on /api/load (gap 1) and the embed=skip / placeholder-vector
 * path (gap 2) of link-on-arrival.
 *
 *   schema      load_jobs gains an additive `autolink` column; pre-existing rows read back as "link"
 *   job false   every row of the job is opted out (inline / queued / skip), graph.node rows included
 *   precedence  a per-row autolink:true never overrides a job-level false; per-row false still wins under a job-level true
 *   restart     the job-level flag is persisted: a fresh store + resume from a checkpoint still opts out the remaining rows
 *   durable     the opt-out is a durable flag in the workspace store (no expiry, not consumed): see test/link-optout-durable-unit.ts
 *   route       POST /api/load?autolink= is strict (400 on junk), persisted on the job and echoed back
 *   skip        a placeholder zero vector is never linked; once the real vector lands the later signal links it,
 *               (the durable load-time opt-out for that later signal is covered in test/link-optout-durable-unit.ts)
 *
 * Run: npx tsx test/link-load-job-autolink-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { wireLoadJobsRunner } from '../packages/lore/src/storage/loadJobsRunner.js';
import { effectiveAutolink } from '../packages/lore/src/storage/loadJobsLinking.js';
import { openLoadJobsDb, LOAD_JOBS_SQLITE_FILE } from '../packages/lore/src/storage/loadJobsMigration.js';
import type { BulkLoaderAdapter, BatchResult } from '../packages/lore/src/bulkLoader/types.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { StoredVectorLinker, isPlaceholderVector } from '../packages/lore/src/link/storedVectorLinker.js';
import type { LinkPolicy } from '../packages/lore/src/link/linkConfig.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

type Mode = 'inline' | 'queued' | 'skip';
interface Intent { ws: string; ids: string[]; autolink: boolean | undefined }

function adapter(substrate: 'sqlite' | 'lance'): BulkLoaderAdapter {
    return {
        substrate,
        async begin() { /* no-op */ },
        async writeBatch(r: unknown[]): Promise<BatchResult> { return { written: r.length, failed: 0, errors: [] }; },
        async checkpoint() { return { checkpointRowId: 0, at: new Date().toISOString(), offset: 0 }; },
        async commit() { /* no-op */ },
        async rollback() { /* no-op */ },
        async close() { /* no-op */ },
    } as BulkLoaderAdapter;
}
function recorder() {
    const intents: Intent[] = [];
    const signals: string[] = [];
    return {
        intents, signals,
        signaler: {
            signal: (_ws: string, items: Array<{ id: string }>) => { for (const i of items) signals.push(i.id); },
            setIntent: async (ws: string, ids: string[], autolink: boolean | undefined) => { intents.push({ ws, ids: [...ids], autolink }); },
        },
        optedOut: () => intents.filter((i) => i.autolink === false).flatMap((i) => i.ids).sort(),
        cleared: () => intents.filter((i) => i.autolink !== false).flatMap((i) => i.ids).sort(),
    };
}

const ROWS = [
    { id: 'lore:a', text: 'alpha' },
    { id: 'lore:b', text: 'beta', autolink: true },
    { id: 'lore:c', text: 'gamma', autolink: false },
    { id: 'lore:d', text: 'delta' },
];

async function runJob(opts: { mode: Mode; autolink?: boolean; rows?: object[]; dir?: string }) {
    const dir = opts.dir ?? mkTmp('lja-');
    const rec = recorder();
    const store = new LoadJobsStore(dir);
    const tempFile = path.join(dir, 'u.jsonl');
    fs.writeFileSync(tempFile, (opts.rows ?? ROWS).map((r) => JSON.stringify(r)).join('\n') + '\n');
    await store.create({ jobId: 'j', workspace: 'wsx', format: 'jsonl', embedMode: opts.mode, autolink: opts.autolink, tempFilePath: tempFile, createdAt: new Date().toISOString() });
    const runner = wireLoadJobsRunner({
        store, linkSignaler: rec.signaler as never, config: { progressIntervalRows: 2, checkpointIntervalRows: 3 },
        buildDispatcherDeps: async () => ({ sqlite: adapter('sqlite') as never, lance: adapter('lance') as never, flushThreshold: 1000 }),
    });
    await runner.tickOnce();
    const job = (await store.get('j'))!;
    store.close();
    return { rec, job };
}

console.log('\nschema');

await test('a pre-existing load_jobs table gains autolink defaulting to link (1)', async () => {
    const dir = mkTmp('lja-old-');
    const raw = new Database(path.join(dir, LOAD_JOBS_SQLITE_FILE));
    raw.exec(`CREATE TABLE load_jobs (job_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, format TEXT NOT NULL, embed_mode TEXT NOT NULL, status TEXT NOT NULL,
      rows_received INTEGER NOT NULL DEFAULT 0, rows_processed INTEGER NOT NULL DEFAULT 0, rows_failed INTEGER NOT NULL DEFAULT 0, errors_json TEXT, temp_file_path TEXT,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, bytes_received INTEGER NOT NULL DEFAULT 0, checkpoint_row INTEGER NOT NULL DEFAULT 0, checkpoint_at TEXT)`);
    raw.prepare(`INSERT INTO load_jobs (job_id, workspace, format, embed_mode, status, created_at) VALUES ('old','w','jsonl','skip','complete','2026-01-01T00:00:00Z')`).run();
    raw.close();
    const store = new LoadJobsStore(dir);
    assert.equal((await store.get('old'))!.autolink, true);
    store.close();
    const db = openLoadJobsDb(dir); db.close(); // second open is idempotent
});

await test('the job-level flag round-trips through the store', async () => {
    const dir = mkTmp('lja-rt-');
    const store = new LoadJobsStore(dir);
    await store.create({ jobId: 'f', workspace: 'w', format: 'jsonl', embedMode: 'skip', autolink: false, tempFilePath: null as never, createdAt: new Date().toISOString() });
    await store.create({ jobId: 't', workspace: 'w', format: 'jsonl', embedMode: 'skip', tempFilePath: null as never, createdAt: new Date().toISOString() });
    assert.equal((await store.get('f'))!.autolink, false);
    assert.equal((await store.get('t'))!.autolink, true);
    store.close();
});

console.log('\nprecedence');

await test('effectiveAutolink: false on either side wins; a row true never overrides a job false', () => {
    assert.equal(effectiveAutolink(false, true), false);
    assert.equal(effectiveAutolink(false, undefined), false);
    assert.equal(effectiveAutolink(false, false), false);
    assert.equal(effectiveAutolink(true, false), false);
    assert.equal(effectiveAutolink(true, true), true);
    assert.equal(effectiveAutolink(true, undefined), undefined);
});

for (const mode of ['inline', 'queued', 'skip'] as const) {
    await test(`${mode}: job autolink=false opts out EVERY row (a row's autolink:true does not override it)`, async () => {
        const { rec, job } = await runJob({ mode, autolink: false });
        assert.equal(job.status, 'complete');
        assert.deepEqual(rec.optedOut(), ['a', 'b', 'c', 'd']);
        assert.deepEqual(rec.cleared(), [], 'nothing is cleared under a job-level false');
    });
    await test(`${mode}: job autolink default (true) leaves per-row autolink:false as the only opt-out`, async () => {
        const { rec } = await runJob({ mode });
        assert.deepEqual(rec.optedOut(), ['c']);
        assert.deepEqual(rec.cleared(), ['b'], 'only an explicit per-row true clears the flag; an omitted autolink records no intent (the flag is kept)');
    });
}

await test('within one job a per-row false wins over a per-row true for the same id, in either order', async () => {
    const rows = [
        { id: 'lore:p', text: '1', autolink: true }, { id: 'lore:p', text: '2', autolink: false },
        { id: 'lore:q', text: '3', autolink: false }, { id: 'lore:q', text: '4', autolink: true },
        { id: 'lore:r', text: '5', autolink: true },
    ];
    const { rec } = await runJob({ mode: 'inline', rows });
    assert.deepEqual(rec.optedOut(), ['p', 'q']);
    assert.deepEqual(rec.cleared(), ['r']);
});

await test('inline + job false: the opt-out is recorded before the rows are signalled', async () => {
    const dir = mkTmp('lja-ord-');
    const order: string[] = [];
    const store = new LoadJobsStore(dir);
    const tempFile = path.join(dir, 'u.jsonl');
    fs.writeFileSync(tempFile, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await store.create({ jobId: 'o', workspace: 'wsx', format: 'jsonl', embedMode: 'inline', autolink: false, tempFilePath: tempFile, createdAt: new Date().toISOString() });
    const runner = wireLoadJobsRunner({
        store, config: { progressIntervalRows: 2, checkpointIntervalRows: 3 },
        linkSignaler: {
            signal: (_ws: string, items: Array<{ id: string }>) => { order.push(`signal:${items.map((i) => i.id).join(',')}`); },
            setIntent: (_ws: string, ids: string[], a: boolean | undefined) => { order.push(`intent:${a}:${ids.join(',')}`); },
        } as never,
        buildDispatcherDeps: async () => ({ sqlite: adapter('sqlite') as never, lance: adapter('lance') as never, flushThreshold: 1000 }),
    });
    await runner.tickOnce();
    const seen = new Set<string>();
    for (const e of order) {
        if (e.startsWith('intent:false:')) e.slice('intent:false:'.length).split(',').forEach((i) => seen.add(i));
        if (e.startsWith('signal:')) for (const i of e.slice(7).split(',')) assert.ok(seen.has(`lore:${i}`) || seen.has(i), `signalled ${i} before its opt-out: ${order.join(' | ')}`);
    }
    store.close();
});

await test('graph.node rows are opted out under a job-level false and left alone otherwise', async () => {
    const rows = [{ type: 'graph.node', id: 'n1', label: 'N1', nodeType: 'note' }, { id: 'lore:v', text: 'v' }];
    const off = await runJob({ mode: 'skip', autolink: false, rows });
    assert.ok(off.rec.optedOut().includes('n1'), JSON.stringify(off.rec.intents));
    const on = await runJob({ mode: 'skip', rows });
    assert.ok(!on.rec.optedOut().includes('n1'));
});

console.log('\nrestart mid-job');

await test('job-level false survives a daemon restart: a fresh store + resume from a checkpoint still opts out the remaining rows', async () => {
    const dir = mkTmp('lja-restart-');
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `lore:r${i}`, text: `t${i}`, autolink: true }));
    const tempFile = path.join(dir, 'u.jsonl');
    fs.writeFileSync(tempFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const s1 = new LoadJobsStore(dir);
    await s1.create({ jobId: 'rs', workspace: 'wsx', format: 'jsonl', embedMode: 'queued', autolink: false, tempFilePath: tempFile, createdAt: new Date().toISOString() });
    await s1.updateStatus('rs', 'running', { startedAt: new Date().toISOString() });
    await s1.writeCheckpoint('rs', 3, 0, 3);
    s1.close(); // "daemon dies"

    const s2 = new LoadJobsStore(dir); // "daemon restarts"
    assert.equal((await s2.get('rs'))!.autolink, false, 'persisted');
    const rec = recorder();
    const runner = wireLoadJobsRunner({
        store: s2, linkSignaler: rec.signaler as never, config: { progressIntervalRows: 2, checkpointIntervalRows: 3, log: () => {} },
        buildDispatcherDeps: async () => ({ sqlite: adapter('sqlite') as never, lance: adapter('lance') as never, flushThreshold: 1000 }),
    });
    await runner.startupReconcileAndResume();
    for (let w = 0; w < 10_000; w += 25) {
        const j = await s2.get('rs');
        if (j && (j.status === 'complete' || j.status === 'failed')) break;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await s2.get('rs'))!.status, 'complete');
    const out = rec.optedOut();
    assert.ok(out.length >= 5, `rows past the checkpoint are opted out: ${out.join(',')}`);
    assert.ok(['r3', 'r4', 'r5', 'r6', 'r7'].every((id) => out.includes(id)), out.join(','));
    assert.deepEqual(rec.cleared(), []);
    s2.close();
});

console.log('\nplaceholder vectors are never linked');

const DIM = 4;
class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'lja-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('never'); }
    async embedQuery(): Promise<number[]> { throw new Error('never'); }
    async embedDocument(): Promise<number[]> { return REAL_VEC; }
}
const REAL_VEC = [1, 0.02, 0, 0];
const POLICY: LinkPolicy = { minSim: 0.5, k: 5, dupSim: 0.9999, policyVersion: 'test' };

await test('isPlaceholderVector: all-zero / non-finite yes, any real component no', () => {
    assert.equal(isPlaceholderVector([0, 0, 0, 0]), true);
    assert.equal(isPlaceholderVector(new Float32Array(4)), true);
    assert.equal(isPlaceholderVector([0, NaN, 0, 0]), true);
    assert.equal(isPlaceholderVector([0, 0, 0.001, 0]), false);
});

await test('a zero-vector row is retried as no_vector and writes no edges, even with nearby real rows; once the real vector lands it links', async () => {
    const graph = new SqliteGraph(mkTmp('lja-g-'), { workspaceId: 'lja' });
    await graph.initialize();
    const verbatim = new SqliteVerbatimStore(mkTmp('lja-v-'), new NoEmbed());
    await verbatim.initialize();
    for (const id of ['z', 'r1', 'r2']) {
        await graph.upsertNode({ id, type: 'note', label: id, content: `c ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
    }
    const row = (id: string, vector: number[]) => ({ id: `lore:${id}`, label: id, text: `t ${id}`, type: 'note', project: 'p', ecosystem: '*', security_scopes: [], vector, contentHash: `h-${id}`, updatedAt: '2026-10-23T00:00:00.000Z' });
    await verbatim.bulkAddPrebuiltRows([row('z', [0, 0, 0, 0]), row('r1', [1, 0, 0, 0]), row('r2', [1, 0.01, 0, 0])] as never);
    const linker = new StoredVectorLinker(async () => ({ graph: graph as never, verbatim: verbatim as never }), POLICY);
    const r = await linker.linkBatch('ws', [{ id: 'z' }]);
    assert.deepEqual(r.retry, [{ id: 'z', reason: 'no_vector' }]);
    assert.deepEqual(r.done, []);
    assert.equal((await graph.queryEdges({ limit: 100, offset: 0 })).length, 0, 'no edge to/from a placeholder');
    // the real embed lands (what the re-embed path does: store() computes the vector and overwrites the placeholder)
    await verbatim.store({ id: 'lore:z', text: 't z', metadata: { label: 'z', type: 'note', project: 'p', ecosystem: '*' } } as never);
    const r2 = await linker.linkBatch('ws', [{ id: 'z' }]);
    assert.deepEqual(r2.done, ['z']);
    assert.ok((await graph.queryEdges({ limit: 100, offset: 0 })).length >= 1);
});

console.log('\nroute: POST /api/load?autolink=');

function makeReq(method: 'POST' | 'GET', chunks: Buffer[] = []): IncomingMessage {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        method,
        on(event: string, cb: (arg?: unknown) => void) { (handlers[event] ??= []).push(cb); return this; },
        _flush(): void { for (const c of chunks) for (const cb of handlers['data'] ?? []) cb(c); for (const cb of handlers['end'] ?? []) cb(); },
    } as unknown as IncomingMessage & { _flush(): void };
    setImmediate(() => (req as unknown as { _flush(): void })._flush());
    return req;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(st: number) { (this as { _status: number })._status = st; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
        setHeader() { return this; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
async function post(q: string) {
    const dir = mkTmp('lja-route-');
    const store = new LoadJobsStore(dir);
    const res = fakeRes();
    await tryLoadRoutes(makeReq('POST', [Buffer.from('{"id":"lore:a","text":"x"}\n')]), res, `/api/load?workspace=w${q}`, '/api/load',
        { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
    const body = JSON.parse(res._body);
    const job = body.job_id ? await store.get(body.job_id) : null;
    store.close();
    return { status: res._status, body, job };
}

for (const [q, want] of [['&autolink=false', false], ['&autolink=0', false], ['&autolink=FALSE', false], ['&autolink=true', true], ['&autolink=1', true], ['', true]] as const) {
    await test(`POST /api/load${q || ' (no autolink)'} -> job.autolink=${want}, echoed`, async () => {
        const r = await post(q);
        assert.equal(r.status, 200, r.body && JSON.stringify(r.body));
        assert.equal(r.job!.autolink, want);
        assert.equal(r.body.autolink, want);
    });
}
await test('POST /api/load?autolink=maybe -> 400 invalid_autolink and no job is created (junk never degrades to "link")', async () => {
    const r = await post('&autolink=maybe');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_autolink');
    assert.equal(r.job, null);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
