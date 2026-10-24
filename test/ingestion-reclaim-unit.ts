#!/usr/bin/env tsx
/**
 * test/ingestion-reclaim-unit.ts — stuck-job reclaim (claim lease + heartbeat) on every backend.
 * SQLite always; Postgres when LORE_PG_URL is set (including two stores/coordinators on one workspace
 * to prove a job is neither reclaimed nor processed twice).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { IngestionCoordinator, FsBlobStore, ProcessorRegistry, StaticPolicyProvider, type IIngestionStore, type IngestionJob } from '../packages/lore/src/ingestion/index.js';
import { SqliteIngestionStore } from '../packages/lore/src/ingestion/sqliteStore.js';
import { RECLAIM_ERROR } from '../packages/lore/src/ingestion/store.js';
import { CONTRACT_A_VERSION } from '../packages/lore/src/ingestion/contracts.js';
import { ingestionBackends, type Backend } from './helpers/ingestionBackends.js';

let passed = 0; let failed = 0;
const queue: Array<() => Promise<void>> = [];
let B!: Backend;
function test(name: string, fn: () => Promise<void>, opts: { pgOnly?: boolean; sqliteOnly?: boolean } = {}): void { queue.push(async () => {
    for (const b of bk.list) {
        if (opts.pgOnly && b.name !== 'postgres') continue;
        if (opts.sqliteOnly && b.name !== 'sqlite') continue;
        B = b;
        try { await fn(); console.log(`  ok  [${b.name}] ${name}`); passed++; }
        catch (err) { console.error(`  FAIL [${b.name}] ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    }
}); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-reclaim-'));
const bk = await ingestionBackends(tmp, 'ingestion-reclaim');
const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const RO = { limit: 100, legacyGraceMs: 10 * 60_000, backoff: { baseMs: 1000, maxMs: 8000 } };

async function enqueue(store: IIngestionStore, ws: string, n = 1, maxAttempts = 3): Promise<IngestionJob[]> {
    const out: IngestionJob[] = [];
    for (let i = 0; i < n; i++) {
        const src = await store.upsertSource({ workspace: ws, fileName: `f${i}.txt`, mimeType: 'text/plain', sha256: String(i).padStart(64, 'a'), sizeBytes: 1, storageRef: 'x' });
        out.push((await store.createJob({ workspace: ws, sourceId: src.sourceId, stage: 'extract', processorId: 'p', contractVersion: CONTRACT_A_VERSION, maxAttempts }, T0)).job);
    }
    return out;
}

test('claimDue with a lease stamps leaseUntil; without one leaves it null', async () => {
    const { store, ws } = await B.open();
    await enqueue(store, ws, 2);
    const [a] = await store.claimDue(at(0), 1, 60_000);
    assert.equal(a!.state, 'running');
    assert.equal(a!.leaseUntil, at(60_000).toISOString());
    const [b] = await store.claimDue(at(0), 1);
    assert.equal(b!.leaseUntil, null);
});

test('reclaim ignores live leases and takes expired ones back to queued with backoff', async () => {
    const { store, ws } = await B.open();
    const [j] = await enqueue(store, ws);
    await store.claimDue(at(0), 5, 60_000);
    assert.deepEqual(await store.reclaimExpiredLeases(at(59_000), RO), []);
    const r = await store.reclaimExpiredLeases(at(61_000), RO);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.jobId, j!.jobId);
    assert.equal(r[0]!.state, 'queued');
    assert.equal(r[0]!.attempts, 1);
    assert.equal(r[0]!.leaseUntil, null);
    assert.equal(r[0]!.lastError, RECLAIM_ERROR);
    assert.equal(r[0]!.nextAttemptAt, at(61_000 + 1000).toISOString());
    assert.deepEqual(await store.claimDue(at(61_500), 5, 60_000), []); // still backing off
    assert.equal((await store.claimDue(at(63_000), 5, 60_000)).length, 1);
});

test('reclaim dead-letters once attempts are spent', async () => {
    const { store, ws } = await B.open();
    await enqueue(store, ws, 1, 2);
    await store.claimDue(at(0), 1, 1000);
    assert.equal((await store.reclaimExpiredLeases(at(2000), RO))[0]!.state, 'queued');
    await store.claimDue(at(60_000), 1, 1000);
    const r = await store.reclaimExpiredLeases(at(62_000), RO);
    assert.equal(r[0]!.state, 'dead_letter');
    assert.equal(r[0]!.attempts, 2);
    assert.ok(r[0]!.completedAt);
});

test('extendLease keeps a job from being reclaimed; refuses a non-running job', async () => {
    const { store, ws } = await B.open();
    const [j] = await enqueue(store, ws);
    assert.equal(await store.extendLease(j!.jobId, at(5000), at(0)), false); // queued
    await store.claimDue(at(0), 1, 1000);
    assert.equal(await store.extendLease(j!.jobId, at(100_000), at(500)), true);
    assert.deepEqual(await store.reclaimExpiredLeases(at(50_000), RO), []);
    assert.equal((await store.reclaimExpiredLeases(at(100_001), RO)).length, 1);
});

test('lease-less running rows (older build) are reclaimed only after the legacy grace', async () => {
    const { store, ws } = await B.open();
    await enqueue(store, ws);
    await store.claimDue(at(0), 1); // no lease
    assert.deepEqual(await store.reclaimExpiredLeases(at(5 * 60_000), RO), []);
    assert.equal((await store.reclaimExpiredLeases(at(11 * 60_000), RO)).length, 1);
});

test('leaving running clears the lease; awaiting_callback and succeeded are never reclaimed', async () => {
    const { store, ws } = await B.open();
    const [a, b] = await enqueue(store, ws, 2);
    await store.claimDue(at(0), 2, 1000);
    await store.markAwaitingCallback(a!.jobId, 'rid', at(10));
    await store.markSucceeded(b!.jobId, { ok: 1 }, at(10));
    assert.equal((await store.getJob(a!.jobId))!.leaseUntil, null);
    assert.equal((await store.getJob(b!.jobId))!.leaseUntil, null);
    assert.deepEqual(await store.reclaimExpiredLeases(at(10 * 60_000), RO), []);
});

test('reclaim honours the limit', async () => {
    const { store, ws } = await B.open();
    await enqueue(store, ws, 3);
    await store.claimDue(at(0), 3, 1000);
    assert.equal((await store.reclaimExpiredLeases(at(5000), { ...RO, limit: 2 })).length, 2);
    assert.equal((await store.reclaimExpiredLeases(at(5000), { ...RO, limit: 2 })).length, 1);
});

test('coordinator.reclaimStuck + heartbeat: a hung job is reclaimed, a slow-but-alive job is not', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
    const { store, ws } = await B.open();
    const registry = new ProcessorRegistry();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    registry.registerExtract({
        info: { id: 'slow', kind: 'extract', locality: 'local', version: '1' },
        supports: () => true,
        extract: async () => { await gate; return { status: 'accepted' as const }; },
    });
    const c = new IngestionCoordinator({
        store, registry, policy: new StaticPolicyProvider(), blobs: new FsBlobStore(path.join(dir, 'b')),
        memory: { upsert: async () => ({ ok: true }) }, tables: { forWorkspace: async () => null },
        callbackBaseUrl: 'https://lore.example.invalid', callbackAuth: { masterSecret: Buffer.alloc(32, 7), webhookSecret: 'x', replayWindowSec: 300 },
        leaseMs: 300, backoff: { baseMs: 10, maxMs: 10 },
    });
    await c.enqueueFile({ workspace: ws, fileName: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('hi') });
    const run = c.runDue(1);
    await new Promise((r) => setTimeout(r, 900)); // 3 lease periods: only the heartbeat keeps it alive
    assert.equal(await c.reclaimStuck(), 0, 'heartbeat must hold the lease');
    release(); await run;
    assert.equal((await store.listJobs(ws, 'awaiting_callback')).length, 1);
    // A crashed worker: claimed with a lease, never heartbeats.
    const [other] = await enqueue(store, ws, 1);
    await store.claimDue(new Date(), 5, 100);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await c.reclaimStuck(), 1);
    assert.equal((await store.getJob(other!.jobId))!.state, 'queued');
});

test('two stores on one workspace never reclaim the same job twice', async () => {
    const h = await B.open();
    const other = await h.reopen();
    await enqueue(h.store, h.ws, 20);
    await h.store.claimDue(at(0), 20, 1000);
    const [x, y] = await Promise.all([h.store.reclaimExpiredLeases(at(5000), RO), other.reclaimExpiredLeases(at(5000), RO)]);
    const ids = [...x, ...y].map((j) => j.jobId);
    assert.equal(ids.length, 20, 'every stuck job reclaimed');
    assert.equal(new Set(ids).size, 20, 'none reclaimed twice');
    for (const j of [...x, ...y]) assert.equal(j.attempts, 1);
}, { pgOnly: true });

test('two stores claiming while one reclaims never hand a job out twice', async () => {
    const h = await B.open();
    const other = await h.reopen();
    await enqueue(h.store, h.ws, 30);
    const claimed = (await Promise.all([h.store.claimDue(at(0), 20, 1000), other.claimDue(at(0), 20, 1000)])).flat();
    assert.equal(claimed.length, 30);
    assert.equal(new Set(claimed.map((j) => j.jobId)).size, 30);
}, { pgOnly: true });

test('an older SQLite file (no lease column) is migrated additively and keeps its rows', async () => {
    const f = path.join(tmp, 'old.sqlite');
    const db = new Database(f);
    db.exec(`CREATE TABLE ingest_jobs (job_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, source_id TEXT NOT NULL, stage TEXT NOT NULL,
      processor_id TEXT NOT NULL, contract_version TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL, last_error TEXT, params_json TEXT NOT NULL, parent_job_id TEXT, remote_request_id TEXT,
      results_written_at TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      INSERT INTO ingest_jobs VALUES ('job_old','w','s','extract','p','1.0','running',0,3,'2026-01-01T00:00:00.000Z',NULL,'{}',NULL,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);`);
    db.close();
    const store = new SqliteIngestionStore(f);
    const j = await store.getJob('job_old');
    assert.equal(j!.state, 'running'); assert.equal(j!.leaseUntil, null);
    await store.close();
    await new SqliteIngestionStore(f).close(); // second open is a no-op
}, { sqliteOnly: true });

try { for (const t of queue) await t(); } finally { await bk.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\ningestion-reclaim: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
