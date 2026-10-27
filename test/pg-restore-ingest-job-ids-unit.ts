/**
 * test/pg-restore-ingest-job-ids-unit.ts - restore of a Postgres logical bundle into a NEW workspace while the source
 * still exists in the same database.
 *
 * `lore_ingest_jobs.job_id` (and the `job_id` of `lore_ingest_pending` / `lore_ingest_deliveries`) is a globally unique
 * key. Restoring the source's rows verbatim into another workspace collided on `lore_ingest_jobs_pkey`. The restore now
 * re-mints job ids for the target exactly as a native `createJob` there would (parent ids first, since the parent id is a
 * hash input) and rewrites every reference inside the bundle. A restore into the bundle's own workspace id keeps ids.
 *
 * Needs a throwaway Postgres with pgvector (`LORE_PG_URL`); unset -> prints the reason, exits 0. Creates and drops its
 * own database (`lore_pgjobs_<pid>`) and its own registry home.
 *
 * Run: npx tsx test/pg-restore-ingest-job-ids-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresIngestionStore } from '../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import { INGEST_TABLES } from '../packages/lore/src/engines/postgres/postgresIngestionSchema.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { backupPostgresWorkspace, restoreLogicalBundleCli } from '../packages/lore/src/cli/commands/backupPostgres.js';
import { writeControl, type WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';
import { makeJobId } from '../packages/lore/src/ingestion/store.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const raw = process.env['LORE_PG_URL'];
if (!raw || raw.trim() === '') {
    console.log('SKIP pg-restore-ingest-job-ids-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}
const DB = `lore_pgjobs_${process.pid}`;
const adminUrl = new URL(raw); adminUrl.pathname = '/postgres';
const dbUrl = new URL(raw); dbUrl.pathname = `/${DB}`;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pgjobs-home-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgjobs-out-'));
process.env['LORE_HOME'] = HOME;
process.env['LORE_PG_URL'] = dbUrl.toString();

const SRC = '44444444-dddd-4ddd-8ddd-000000000001';
const DST = '44444444-dddd-4ddd-8ddd-000000000002';
const entry = (name: string, id: string): WorkspaceEntry => ({
    name, id, path: path.join(HOME, 'ws', name), createdAt: '2026-01-01T00:00:00Z', graphEngine: 'postgres', vectorEngine: 'postgres',
} as WorkspaceEntry);
const E = { src: entry('pj-src', SRC), dst: entry('pj-dst', DST) };
for (const e of Object.values(E)) fs.mkdirSync(e.path, { recursive: true });
writeControl({ active: 'pj-src', workspaces: Object.values(E) } as never, HOME);

async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const { jobs: JOBS, pending: PENDING, deliveries: DELIVERIES } = INGEST_TABLES;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

interface JobRow { job_id: string; source_id: string; stage: string; parent_job_id: string | null; state: string }
const jobsOf = (key: string): Promise<JobRow[]> =>
    q<JobRow>(`SELECT job_id, source_id, stage, parent_job_id, state FROM ${JOBS} WHERE workspace_id = $1 ORDER BY stage, job_id`, [key]);
const SHA = 'cd'.repeat(32);
const now = new Date();
const deps = { workspaceDir: (n: string) => Object.values(E).find((e) => e.name === n)?.path ?? null, daemonServesHome: async () => false, daemonMessage: 'daemon' };

try {
    // Source workspace: one source, an extract job, a structure job whose parent is the extract job (parent id is a hash
    // input of the child id), one parked pending row and two delivery rows. Plus a graph node so the bundle is mixed.
    const g = new PostgresGraph(SRC, pool);
    await g.initialize();
    await g.upsertNode({ id: 'n0', type: 'note', label: 'l', content: 'c', tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
    await g.close();
    const store = await PostgresIngestionStore.open('pj-src', pool, SRC);
    const source = await store.upsertSource({ workspace: 'pj-src', fileName: 'f.pdf', mimeType: 'application/pdf', sha256: SHA, sizeBytes: 9, storageRef: 'ref/f' });
    const ex = (await store.createJob({ workspace: 'pj-src', sourceId: source.sourceId, stage: 'extract', processorId: 'p1', contractVersion: 'a1', params: { k: 1, z: ['b', 'a'] } }, now)).job;
    const st = (await store.createJob({ workspace: 'pj-src', sourceId: source.sourceId, stage: 'structure', processorId: 'p2', contractVersion: 'b1', params: { profile: 'x' }, parentJobId: ex.jobId }, now)).job;
    await store.recordPending({ jobId: st.jobId, workspace: 'pj-src', sourceId: source.sourceId, reason: 'review', payload: { jobId: st.jobId } }, now);
    assert.equal(await store.recordDelivery(ex.jobId, 'd1', now), true);
    assert.equal(await store.recordDelivery(st.jobId, 'd2', now), true);
    const srcJobs = await jobsOf(SRC);
    assert.equal(srcJobs.length, 2);

    let bundle = '';
    await test('restore into a NEW workspace while the source still exists succeeds (was: duplicate key on lore_ingest_jobs_pkey)', async () => {
        bundle = (await backupPostgresWorkspace('pj-src', E.src.path, OUT, 5)).bundlePath;
        assert.equal(await restoreLogicalBundleCli(bundle, 'pj-src', 'pj-dst', { force: true, replace: true, allowNameMismatch: true }, deps), true);
        assert.equal((await jobsOf(DST)).length, 2);
    });

    await test('target job ids are re-minted for the target workspace, exactly as a native createJob there would derive them', async () => {
        const dst = await jobsOf(DST);
        const dEx = dst.find((j) => j.stage === 'extract')!; const dSt = dst.find((j) => j.stage === 'structure')!;
        const wantEx = makeJobId({ workspace: DST, sourceId: source.sourceId, stage: 'extract', processorId: 'p1', contractVersion: 'a1', params: { k: 1, z: ['b', 'a'] } });
        assert.equal(dEx.job_id, wantEx);
        assert.equal(dSt.parent_job_id, dEx.job_id, 'the child points at the re-minted parent');
        assert.equal(dSt.job_id, makeJobId({ workspace: DST, sourceId: source.sourceId, stage: 'structure', processorId: 'p2', contractVersion: 'b1', params: { profile: 'x' }, parentJobId: dEx.job_id }));
        const srcIds = new Set(srcJobs.map((j) => j.job_id));
        assert.ok(dst.every((j) => !srcIds.has(j.job_id)), 'no target job id equals a source job id');
        assert.equal(dEx.state, 'queued'); // non-key columns are restored as they were
    });

    await test('pending and delivery rows follow their jobs to the new ids', async () => {
        const dst = await jobsOf(DST);
        const ids = new Set(dst.map((j) => j.job_id));
        const dSt = dst.find((j) => j.stage === 'structure')!; const dEx = dst.find((j) => j.stage === 'extract')!;
        const pend = await q<{ job_id: string }>(`SELECT job_id FROM ${PENDING} WHERE workspace_id = $1`, [DST]);
        assert.deepEqual(pend.map((p) => p.job_id), [dSt.job_id]);
        const del = await q<{ job_id: string; delivery_id: string }>(`SELECT job_id, delivery_id FROM ${DELIVERIES} WHERE workspace_id = $1 ORDER BY delivery_id`, [DST]);
        assert.deepEqual(del.map((d) => [d.job_id, d.delivery_id]), [[dEx.job_id, 'd1'], [dSt.job_id, 'd2']]);
        assert.ok(del.every((d) => ids.has(d.job_id)) && pend.every((p) => ids.has(p.job_id)), 'every reference resolves inside the target workspace');
    });

    await test('the source workspace is untouched', async () => {
        assert.deepEqual(await jobsOf(SRC), srcJobs);
        assert.equal((await q(`SELECT 1 FROM ${PENDING} WHERE workspace_id = $1`, [SRC])).length, 1);
        assert.equal((await q(`SELECT 1 FROM ${DELIVERIES} WHERE workspace_id = $1`, [SRC])).length, 2);
    });

    await test('resubmitting the same work in the restored workspace is a repeat, not a second job', async () => {
        const dstStore = await PostgresIngestionStore.open('pj-dst', pool, DST);
        const sid = await dstStore.resolveSourceId('pj-dst', SHA);
        assert.equal(sid, source.sourceId, 'restored source keeps its id');
        const again = await dstStore.createJob({ workspace: 'pj-dst', sourceId: sid, stage: 'extract', processorId: 'p1', contractVersion: 'a1', params: { z: ['b', 'a'], k: 1 } }, now);
        assert.equal(again.created, false);
        assert.equal((await jobsOf(DST)).length, 2);
    });

    await test('restoring the bundle into its OWN workspace id keeps the job ids byte for byte', async () => {
        assert.equal(await restoreLogicalBundleCli(bundle, 'pj-src', 'pj-src', { force: true, replace: true }, deps), true);
        assert.deepEqual(await jobsOf(SRC), srcJobs);
        assert.equal((await jobsOf(DST)).length, 2, 'the other copy is untouched');
    });

    await test('restoring the same bundle over the target again (force) is idempotent', async () => {
        const before = await jobsOf(DST);
        assert.equal(await restoreLogicalBundleCli(bundle, 'pj-src', 'pj-dst', { force: true, replace: true, allowNameMismatch: true }, deps), true);
        assert.deepEqual(await jobsOf(DST), before);
    });
} finally {
    await closeSharedPostgresPool().catch(() => undefined);
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    for (const d of [HOME, OUT]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
