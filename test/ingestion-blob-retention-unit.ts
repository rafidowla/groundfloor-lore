#!/usr/bin/env tsx
/**
 * test/ingestion-blob-retention-unit.ts - blob retention for ingestion source files.
 *
 *  1. Store contract (SQLite always, Postgres when LORE_PG_URL is set): which sources claimBlobPurge may take.
 *  2. Coordinator: sweep behaviour, counters, failure release, dedupe, re-upload, enqueue-vs-sweep race.
 *  3. Real wire-up: IngestionHost (the daemon / embedded-host path, real scheduler, real extractor) with
 *     LORE_INGEST_BLOB_RETENTION_DAYS and LORE_INGEST_BLOB_STORE=fs|groundfloor (fake Files API server on an ephemeral
 *     port): enqueue -> processed -> terminal -> scheduled sweep -> blob gone, source row kept; re-upload restores it.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-retention-'));
process.env['LORE_HOME'] = path.join(tmp, 'home');
fs.mkdirSync(process.env['LORE_HOME'], { recursive: true });

const { IngestionCoordinator, FsBlobStore, ProcessorRegistry, StaticPolicyProvider, LocalExtractProcessor } = await import('../packages/lore/src/ingestion/index.js');
const { ProcessorError, CONTRACT_A_VERSION } = await import('../packages/lore/src/ingestion/contracts.js');
const { IngestionHost } = await import('../packages/lore/src/ingestion/ingestionHost.js');
const { loadIngestHostConfig } = await import('../packages/lore/src/ingestion/hostConfig.js');
const { GroundfloorBlobStore } = await import('../packages/lore/src/ingestion/groundfloorBlobStore.js');
const { makeSourceId, TERMINAL_JOB_STATES } = await import('../packages/lore/src/ingestion/store.js');
const { PostgresIngestionStore } = await import('../packages/lore/src/engines/postgres/postgresIngestionStore.js');
const { SqliteTableStorage } = await import('../packages/lore/src/engines/sqliteTableStorage.js');
const { ingestionBackends, ING_WS_PREFIX } = await import('./helpers/ingestionBackends.js');
const { startFakeGroundfloor, FAKE_WS, FAKE_TOKEN } = await import('./helpers/fakeGroundfloorFiles.js');
import type { IIngestionStore } from '../packages/lore/src/ingestion/store.js';
import type { IBlobStore } from '../packages/lore/src/ingestion/blobStore.js';
import type { Backend } from './helpers/ingestionBackends.js';

let passed = 0; let failed = 0;
const bk = await ingestionBackends(tmp, 'ingestion-retention');
let B!: Backend;
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => Promise<void>, opts: { once?: boolean } = {}): void {
    queue.push(async () => {
        for (const b of opts.once ? bk.list.slice(0, 1) : bk.list) {
            B = b; const label = opts.once ? name : `[${b.name}] ${name}`;
            try { await fn(); console.log(`  ok  ${label}`); passed++; } catch (err) { console.error(`  FAIL ${label}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
        }
    });
}
const DAY = 86_400_000;
const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<void> { const t = Date.now(); while (!(await pred())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(25); } }
const rnd = () => Math.random().toString(36).slice(2, 8);
const shaOf = (n: number) => String(n).padStart(64, 'a');
const fileBytes = (tag: string) => Buffer.from(`Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n${tag}\n`);

// ---- 1. store contract ------------------------------------------------------------------------------------------------
console.log('\nstore contract');
type Target = 'queued' | 'running' | 'awaiting' | 'succeeded' | 'dead_letter';
async function seed(store: IIngestionStore, ws: string, n: number, targets: Target[], doneAt = at(0), ref = `ref-${n}`) {
    const src = await store.upsertSource({ workspace: ws, fileName: `f${n}.txt`, mimeType: 'text/plain', sha256: shaOf(n), sizeBytes: 1, storageRef: ref });
    for (const [i, t] of targets.entries()) {
        const { job } = await store.createJob({ workspace: ws, sourceId: src.sourceId, stage: 'extract', processorId: `p${i}`, contractVersion: CONTRACT_A_VERSION }, T0);
        if (t === 'queued') continue;
        const [claimed] = await store.claimDue(T0, 50, 60_000);
        assert.ok(claimed, 'claimed'); const id = claimed!.jobId;
        if (t === 'awaiting') await store.markAwaitingCallback(id, 'r1', T0);
        else if (t === 'succeeded') await store.markSucceeded(id, { ok: true }, doneAt);
        else if (t === 'dead_letter') await store.recordFailure(id, 'permanent', false, doneAt);
        void job;
    }
    return src;
}
const claim = (s: IIngestionStore, cutoff: Date, limit = 50) => s.claimBlobPurge(cutoff, at(100 * DAY), limit);

test('a source whose jobs are all terminal and old is claimed; the row is kept and marked', async () => {
    const { store, ws } = await B.open(); const src = await seed(store, ws, 1, ['succeeded'], at(DAY));
    const got = await claim(store, at(2 * DAY));
    assert.deepEqual(got.map((g) => [g.workspace, g.sourceId, g.storageRef]), [[ws, src.sourceId, 'ref-1']]);
    const row = await store.getSource(ws, src.sourceId);
    assert.ok(row, 'row kept'); assert.equal(row!.blobPurgedAt, at(100 * DAY).toISOString()); assert.equal(row!.storageRef, 'ref-1');
    assert.deepEqual(await claim(store, at(2 * DAY)), [], 'already purged: never claimed again');
});
test('dead_letter counts as terminal; the boundary is inclusive', async () => {
    const { store, ws } = await B.open(); await seed(store, ws, 2, ['dead_letter'], at(DAY));
    assert.equal((await claim(store, at(DAY - 1))).length, 0, 'one ms too early');
    assert.equal((await claim(store, at(DAY))).length, 1, 'exactly at the cutoff');
});
test('too recent: a job finished after the cutoff keeps its blob', async () => {
    const { store, ws } = await B.open(); await seed(store, ws, 3, ['succeeded'], at(5 * DAY));
    assert.deepEqual(await claim(store, at(4 * DAY)), []);
});
test('any non-terminal job protects the blob (queued, running, awaiting_callback), even beside a finished one', async () => {
    const { store, ws } = await B.open();
    await seed(store, ws, 4, ['queued']); await seed(store, ws, 5, ['running']); await seed(store, ws, 6, ['awaiting']);
    await seed(store, ws, 7, ['succeeded', 'queued'], at(0));
    assert.deepEqual(await claim(store, at(50 * DAY)), []);
});
test('a source with no job at all is never claimed (its job may be about to be created)', async () => {
    const { store, ws } = await B.open();
    await store.upsertSource({ workspace: ws, fileName: 'x', mimeType: 'text/plain', sha256: shaOf(8), sizeBytes: 1, storageRef: 'ref-8' });
    assert.deepEqual(await claim(store, at(50 * DAY)), []);
});
test('dedupe: a blob shared with an unfinished source is never claimed; once that source finishes both go', async () => {
    const { store, ws } = await B.open();
    const done = await seed(store, ws, 9, ['succeeded'], at(0), 'shared-ref');
    const live = await seed(store, ws, 10, ['queued'], at(0), 'shared-ref');
    assert.deepEqual(await claim(store, at(50 * DAY)), [], 'queued sibling protects the shared blob');
    const [c] = await store.claimDue(T0, 5, 60_000); await store.markSucceeded(c!.jobId, { ok: true }, at(1));
    const got = await claim(store, at(50 * DAY));
    assert.deepEqual(got.map((g) => g.sourceId).sort(), [done.sourceId, live.sourceId].sort());
});
test('release makes a source claimable again; setSourceBlob restores a purged source', async () => {
    const { store, ws } = await B.open(); const src = await seed(store, ws, 11, ['succeeded'], at(0));
    assert.equal((await claim(store, at(DAY))).length, 1);
    await store.releaseBlobPurge(ws, src.sourceId);
    assert.equal((await store.getSource(ws, src.sourceId))!.blobPurgedAt, null);
    assert.equal((await claim(store, at(DAY))).length, 1, 'claimable again');
    await store.setSourceBlob(ws, src.sourceId, 'ref-new');
    const row = (await store.getSource(ws, src.sourceId))!; assert.equal(row.storageRef, 'ref-new'); assert.equal(row.blobPurgedAt, null);
});
test('the limit is respected and oldest sources go first', async () => {
    const { store, ws } = await B.open(); const ids: string[] = [];
    for (let i = 20; i < 25; i++) ids.push((await seed(store, ws, i, ['succeeded'], at(0))).sourceId);
    assert.equal((await claim(store, at(DAY), 2)).length, 2); assert.equal((await claim(store, at(DAY), 10)).length, 3);
});
test('two concurrent sweepers never take the same source', async () => {
    const { store, ws } = await B.open(); for (let i = 30; i < 40; i++) await seed(store, ws, i, ['succeeded'], at(0));
    const [a, b] = await Promise.all([claim(store, at(DAY), 6), claim(store, at(DAY), 6)]);
    const all = [...a, ...b].map((g) => g.sourceId);
    assert.equal(new Set(all).size, all.length, 'no duplicates'); assert.equal(all.length, 10, 'together they took everything');
});
test('a job going terminal sets completed_at: TERMINAL_JOB_STATES is exactly succeeded/failed/dead_letter', async () => {
    assert.deepEqual([...TERMINAL_JOB_STATES].sort(), ['dead_letter', 'failed', 'succeeded']);
}, { once: true });

// ---- 2. coordinator ---------------------------------------------------------------------------------------------------
console.log('\ncoordinator');
class FlakyExtract extends LocalExtractProcessor {
    override async extract(req: Parameters<InstanceType<typeof LocalExtractProcessor>["extract"]>[0]) {
        if (req.fileName.startsWith('bad')) throw new ProcessorError('cannot read this file', false);
        return super.extract(req);
    }
}
interface CWorld { c: InstanceType<typeof IngestionCoordinator>; store: IIngestionStore; ws: string; clock: { t: number }; blobs: IBlobStore & { puts: number; deleted: string[]; failDeletes: number } }
function countingBlobs(inner: IBlobStore): CWorld['blobs'] {
    const b = {
        puts: 0, deleted: [] as string[], failDeletes: 0,
        async put(ws: string, sha: string, bytes: Buffer) { b.puts++; return inner.put(ws, sha, bytes); },
        get: (ref: string) => inner.get(ref), has: (ref: string) => inner.has!(ref),
        async delete(ref: string) { if (b.failDeletes > 0) { b.failDeletes--; throw new Error('storage down'); } b.deleted.push(ref); return inner.delete!(ref); },
    };
    return b;
}
async function cworld(inner: IBlobStore, retentionDays: number | undefined): Promise<CWorld> {
    const { store, ws } = await B.open(); const registry = new ProcessorRegistry(); registry.registerExtract(new FlakyExtract());
    const clock = { t: T0.getTime() }; const blobs = countingBlobs(inner);
    const c = new IngestionCoordinator({
        store, registry, policy: new StaticPolicyProvider(), blobs, memory: { upsert: async () => ({ ok: true }) }, tables: { forWorkspace: async () => null },
        callbackBaseUrl: 'https://lore.example.invalid', callbackAuth: { masterSecret: Buffer.alloc(32, 7), replayWindowSec: 300 },
        now: () => new Date(clock.t), maxAttempts: 2, ...(retentionDays ? { blobRetentionDays: retentionDays } : {}),
    });
    return { c, store, ws, clock, blobs };
}
const fsInner = () => new FsBlobStore(fs.mkdtempSync(path.join(tmp, 'b-')));
async function enqueueRun(w: CWorld, name: string, bytes: Buffer) {
    const r = await w.c.enqueueFile({ workspace: w.ws, fileName: name, mimeType: 'text/plain', bytes }); await w.c.runDue(); return r;
}

test('retention OFF (the default): nothing is ever deleted, however old', async () => {
    const w = await cworld(fsInner(), undefined);
    const { source } = await enqueueRun(w, 'a.txt', fileBytes('off')); w.clock.t += 3650 * DAY;
    assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 0, failed: 0 });
    assert.equal(await w.blobs.has!(source.storageRef), true); assert.equal(w.c.blobRetentionEnabled, false);
});
test('sweep: old finished source loses its blob, keeps its row and jobs; counters and clock respected', async () => {
    const w = await cworld(fsInner(), 30);
    const { source, job } = await enqueueRun(w, 'a.txt', fileBytes('one'));
    assert.equal((await w.store.getJob(job.jobId))!.state, 'succeeded');
    w.clock.t += 29 * DAY; assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 0, failed: 0 }, 'not yet 30 days');
    assert.equal(await w.blobs.has!(source.storageRef), true);
    w.clock.t += 2 * DAY; assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 1, failed: 0 });
    assert.equal(await w.blobs.has!(source.storageRef), false, 'blob gone');
    const row = (await w.store.getSource(w.ws, source.sourceId))!; assert.ok(row.blobPurgedAt, 'row kept, marked purged'); assert.equal(row.fileName, 'a.txt');
    assert.equal((await w.store.getJob(job.jobId))!.state, 'succeeded', 'job record untouched');
    assert.deepEqual(w.c.blobRetentionStats.purged, 1); assert.equal(w.c.blobRetentionStats.sweeps, 2); assert.ok(w.c.blobRetentionStats.lastSweepAt);
    assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 0, failed: 0 }, 'idempotent');
});
test('a source with an unfinished job keeps its blob while a finished one is purged', async () => {
    const w = await cworld(fsInner(), 1);
    const done = await enqueueRun(w, 'a.txt', fileBytes('done'));
    const live = await w.c.enqueueFile({ workspace: w.ws, fileName: 'b.txt', mimeType: 'text/plain', bytes: fileBytes('live') }); // queued, never run
    w.clock.t += 10 * DAY;
    assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 1, failed: 0 });
    assert.equal(await w.blobs.has!(done.source.storageRef), false); assert.equal(await w.blobs.has!(live.source.storageRef), true);
    assert.equal(await w.blobs.get(live.source.storageRef).then((b) => b.length > 0), true);
});
test('a failed blob delete is released and retried by the next sweep; failures are counted', async () => {
    const w = await cworld(fsInner(), 1);
    const { source } = await enqueueRun(w, 'a.txt', fileBytes('flaky')); w.clock.t += 5 * DAY; w.blobs.failDeletes = 1;
    assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 0, failed: 1 });
    assert.equal(await w.blobs.has!(source.storageRef), true); assert.equal((await w.store.getSource(w.ws, source.sourceId))!.blobPurgedAt, null, 'mark released');
    assert.deepEqual(await w.c.purgeTerminalBlobs(), { purged: 1, failed: 0 });
    assert.deepEqual([w.c.blobRetentionStats.purged, w.c.blobRetentionStats.failed], [1, 1]);
});
test('re-uploading identical bytes after a purge restores the blob and clears the mark (no new job needed)', async () => {
    const w = await cworld(fsInner(), 1); const bytes = fileBytes('again');
    const first = await enqueueRun(w, 'a.txt', bytes); w.clock.t += 5 * DAY; await w.c.purgeTerminalBlobs();
    assert.equal(await w.blobs.has!(first.source.storageRef), false);
    w.clock.t = T0.getTime() + 3600_000; // upload "now" is shortly after the first job finished: not yet due again
    const again = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes });
    assert.equal(again.source.sourceId, first.source.sourceId); assert.equal(again.created, false, 'same deterministic job');
    assert.deepEqual(await w.blobs.get(again.source.storageRef), bytes, 'bytes are back');
    const row = (await w.store.getSource(w.ws, first.source.sourceId))!; assert.equal(row.blobPurgedAt, null);
    assert.equal(row.storageRef, again.source.storageRef);
});
test('dead-lettered job whose file was purged: operator requeue fails permanently with a re-upload message, then re-upload works', async () => {
    const w = await cworld(fsInner(), 1); const bytes = fileBytes('bad');
    const { source, job } = await enqueueRun(w, 'bad.txt', bytes);
    assert.equal((await w.store.getJob(job.jobId))!.state, 'dead_letter');
    w.clock.t += 5 * DAY; assert.equal((await w.c.purgeTerminalBlobs()).purged, 1);
    assert.equal(await w.store.requeueDeadLetter(job.jobId, new Date(w.clock.t)), true); w.clock.t += 60 * DAY; await w.c.runDue();
    const after = (await w.store.getJob(job.jobId))!;
    assert.equal(after.state, 'dead_letter'); assert.match(String(after.lastError), /removed by blob retention; upload the file again/);
    await w.c.enqueueFile({ workspace: w.ws, fileName: 'bad.txt', mimeType: 'text/plain', bytes });
    assert.equal(await w.blobs.has!((await w.store.getSource(w.ws, source.sourceId))!.storageRef), true);
});
test('a blob that vanished outside Lore is a permanent, explained failure (not endless retries)', async () => {
    const w = await cworld(fsInner(), undefined);
    const src = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: fileBytes('gone') });
    await w.blobs.delete!(src.source.storageRef); await w.c.runDue();
    const j = (await w.store.getJob(src.job.jobId))!; assert.equal(j.state, 'dead_letter'); assert.match(String(j.lastError), /no longer in blob storage; upload the file again/);
});
test('enqueue repairs a record whose blob is missing, and reuses a present blob without storing a second copy', async () => {
    const w = await cworld(fsInner(), undefined); const bytes = fileBytes('repair');
    const a = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes }); assert.equal(w.blobs.puts, 1);
    await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes }); assert.equal(w.blobs.puts, 1, 'present blob reused');
    await w.blobs.delete!(a.source.storageRef);
    const b = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes }); assert.equal(w.blobs.puts, 2, 'missing blob stored again');
    assert.deepEqual(await w.blobs.get(b.source.storageRef), bytes);
});
test('race: enqueue of identical bytes concurrent with a sweep never leaves a live record pointing at a missing blob', async () => {
    for (let i = 0; i < 12; i++) {
        const w = await cworld(fsInner(), 1); const bytes = fileBytes(`race-${i}`);
        const first = await enqueueRun(w, 'a.txt', bytes); w.clock.t = T0.getTime() + 5 * DAY;
        await Promise.all([w.c.purgeTerminalBlobs(), w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes }), w.c.purgeTerminalBlobs()]);
        const row = (await w.store.getSource(w.ws, first.source.sourceId))!;
        if (!row.blobPurgedAt) assert.equal(await w.blobs.has!(row.storageRef), true, `iteration ${i}: unmarked record must have its blob`);
        else assert.equal(await w.blobs.has!(row.storageRef), false, `iteration ${i}: purged record must not keep a blob`);
    }
});
test('with a Groundfloor store: one object per distinct file, deleted by retention, restored on re-upload', async () => {
    const fake = await startFakeGroundfloor();
    try {
        const gf = new GroundfloorBlobStore({ baseUrl: fake.baseUrl, filesWorkspaceId: FAKE_WS, token: () => FAKE_TOKEN });
        const w = await cworld(gf, 1); const bytes = fileBytes('gf');
        const a = await enqueueRun(w, 'a.txt', bytes); await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes });
        assert.equal(fake.objects.size, 1, 'the repeat upload did not leak a second remote copy'); assert.equal(fake.calls('upload-url'), 1);
        w.clock.t += 5 * DAY; assert.equal((await w.c.purgeTerminalBlobs()).purged, 1); assert.equal(fake.objects.size, 0, 'remote object deleted');
        w.clock.t = T0.getTime() + 3600_000;
        const again = await w.c.enqueueFile({ workspace: w.ws, fileName: 'a.txt', mimeType: 'text/plain', bytes });
        assert.equal(fake.objects.size, 1); assert.notEqual(again.source.storageRef, a.source.storageRef, 'new remote object, new ref'); assert.deepEqual(await gf.get(again.source.storageRef), bytes);
    } finally { await fake.close(); }
});

// ---- 3. real wire-up through IngestionHost -------------------------------------------------------------------------------
console.log('\nhost wire-up');
const clock = { t: T0.getTime() };
async function hostRig(env: Record<string, string>, ws: string) {
    const dirs = new Map<string, string>(); const nodes: unknown[] = []; const tables = new Map<string, InstanceType<typeof SqliteTableStorage>>();
    const dirOf = (w: string) => { let d = dirs.get(w); if (!d) { d = path.join(tmp, 'ws', w); fs.mkdirSync(d, { recursive: true }); dirs.set(w, d); } return d; };
    const config = loadIngestHostConfig({ LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: ws, LORE_INGEST_RUN_INTERVAL_MS: '3600000', LORE_INGEST_PURGE_INTERVAL_MS: '1000', LORE_INGEST_DRAIN_MS: '300', ...env } as NodeJS.ProcessEnv);
    const pool = bk.pool; const backend = B.name;
    const host = await IngestionHost.start({
        config, lore: { nodeUpsert: async (a: unknown) => { nodes.push(a); return { ok: true }; } }, deploymentMode: 'local', home: process.env['LORE_HOME']!,
        listWorkspaces: () => [ws], workspacePath: dirOf, engineFor: () => backend, now: () => new Date(clock.t),
        ...(backend === 'postgres' ? { createStore: async (o: { workspace: string }) => PostgresIngestionStore.open(o.workspace, pool!) } : {}),
        tableStorageFor: async (w: string) => { let t = tables.get(w); if (!t) { t = new SqliteTableStorage(path.join(dirOf(w), 'tables.db')); tables.set(w, t); } return t as never; },
    } as never);
    return { host, dirOf, stop: () => host.stop() };
}
const wsName = () => (B.name === 'postgres' ? ING_WS_PREFIX : 'ws-') + `ret-${rnd()}`;
const blobFilesOnDisk = (dir: string): string[] => { const root = path.join(dir, 'ingestion-blobs'); return fs.existsSync(root) ? fs.readdirSync(root).flatMap((d) => fs.readdirSync(path.join(root, d))) : []; };

for (const mode of ['fs', 'groundfloor'] as const) {
    test(`LORE_INGEST_BLOB_STORE=${mode} + retention: enqueue -> processed -> terminal -> scheduled sweep -> blob gone, row kept; re-upload restores; unfinished protected`, async () => {
        const fake = mode === 'groundfloor' ? await startFakeGroundfloor() : null;
        const ws = wsName(); clock.t = T0.getTime();
        const env: Record<string, string> = { LORE_INGEST_BLOB_RETENTION_DAYS: '7' };
        if (fake) Object.assign(env, { LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_API_URL: fake.baseUrl, LORE_INGEST_GF_WORKSPACE_ID: FAKE_WS, LORE_INGEST_GF_TOKEN: FAKE_TOKEN });
        const r = await hostRig(env, ws);
        const stored = () => (fake ? fake.objects.size : blobFilesOnDisk(r.dirOf(ws)).length);
        try {
            assert.deepEqual(r.host.status().blobs, { store: mode, ready: true, retentionDays: 7, purged: 0, purgeFailed: 0 });
            const co = await r.host.coordinatorFor(ws);
            const doneBytes = fileBytes(`done-${mode}`); const liveBytes = fileBytes(`live-${mode}`);
            const done = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: doneBytes });
            assert.equal((await co.runDue()).succeeded, 1, 'processed by the real extractor');
            const live = await co.enqueueFile({ workspace: ws, fileName: 'b.txt', mimeType: 'text/plain', bytes: liveBytes }); // stays queued
            assert.equal(stored(), 2);
            if (fake) assert.ok(fake.seen.some((q) => q.method === 'PUT' && q.path.startsWith('/s3/')), 'uploaded through the Files API');
            else assert.equal(blobFilesOnDisk(r.dirOf(ws)).length, 2, 'fs store used');

            // Not yet due: the real scheduler runs but nothing is deleted.
            await sleep(1300); assert.equal(stored(), 2, 'inside the retention window');

            // Time passes; the REAL scheduled task (purgeIntervalMs=1000) does the sweep.
            clock.t = T0.getTime() + 8 * DAY;
            await until(() => stored() === 1);
            assert.equal(stored(), 1); assert.deepEqual(await co.deps.blobs.has!(live.source.storageRef), true, 'unfinished source keeps its blob');
            assert.equal(await co.deps.blobs.has!(done.source.storageRef), false);
            const row = (await co.deps.store.getSource(ws, done.source.sourceId))!; assert.ok(row.blobPurgedAt); assert.equal((await co.deps.store.getJob(done.job.jobId))!.state, 'succeeded');
            assert.equal(r.host.status().blobs.purged, 1);

            // Re-upload of the identical bytes (clock back inside the window so the next sweep leaves it alone).
            clock.t = T0.getTime() + 3600_000;
            const again = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: doneBytes });
            assert.equal(again.source.sourceId, makeSourceId(ws, row.sha256)); assert.deepEqual(await co.deps.blobs.get(again.source.storageRef), doneBytes);
            await sleep(1300); assert.equal(stored(), 2, 'restored and not swept inside its window');

            // Finish the second file; much later both go, rows stay.
            assert.equal((await co.runDue()).succeeded, 1); clock.t = T0.getTime() + 30 * DAY;
            await until(() => stored() === 0);
            for (const s of [done.source, live.source]) assert.ok((await co.deps.store.getSource(ws, s.sourceId))!.blobPurgedAt, 'rows kept');
            assert.equal(r.host.status().blobs.purged, 3);
        } finally { await r.stop(); await fake?.close(); }
    });
}

test('retention OFF by default through the host: no sweep task runs and nothing is deleted', async () => {
    const ws = wsName(); clock.t = T0.getTime(); const r = await hostRig({}, ws);
    try {
        assert.deepEqual(r.host.status().blobs, { store: 'fs', ready: true, retentionDays: null, purged: 0, purgeFailed: 0 });
        const co = await r.host.coordinatorFor(ws); const a = await co.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: fileBytes('off-host') });
        await co.runDue(); clock.t = T0.getTime() + 3650 * DAY; await sleep(1300);
        assert.equal(await co.deps.blobs.has!(a.source.storageRef), true);
        assert.equal((await co.deps.store.getSource(ws, a.source.sourceId))!.blobPurgedAt, null);
    } finally { await r.stop(); }
});
test('fail closed: groundfloor selected with missing settings opens no workspace and creates no local blob directory', async () => {
    const ws = wsName(); const r = await hostRig({ LORE_INGEST_BLOB_STORE: 'groundfloor', LORE_INGEST_GF_TOKEN: FAKE_TOKEN }, ws);
    try {
        assert.equal(r.host.status().blobs.ready, false);
        await assert.rejects(r.host.coordinatorFor(ws), /blob storage is not configured/);
        assert.equal(fs.existsSync(path.join(r.dirOf(ws), 'ingestion-blobs')), false);
    } finally { await r.stop(); }
});
test('fail closed: an unrecognised LORE_INGEST_BLOB_STORE does not quietly use the disk', async () => {
    const ws = wsName(); const r = await hostRig({ LORE_INGEST_BLOB_STORE: 'groundflor' }, ws);
    try { await assert.rejects(r.host.coordinatorFor(ws), /blob storage is not configured/); assert.equal(r.host.status().blobs.store, 'invalid'); } finally { await r.stop(); }
});

for (const q of queue) await q();
await bk.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ingestion-blob-retention: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
