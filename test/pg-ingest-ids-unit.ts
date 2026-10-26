#!/usr/bin/env tsx
/**
 * test/pg-ingest-ids-unit.ts - Postgres ingestion job/source ids hash the PERMANENT workspace id, not the name.
 *
 * `lore_ingest_jobs.job_id` is a global primary key, so two workspaces that share a NAME at different times (a deleted
 * workspace whose rows are held, then a successor) must not derive the same ids from identical uploads. Also proves rows
 * written under the old name-hashed ids are still found (scoped to the store's own workspace) so a resubmission after
 * the upgrade is a repeat, not a second job. Skips cleanly when LORE_PG_URL is unset.
 *
 * Run: LORE_PG_URL=postgres://... npx tsx test/pg-ingest-ids-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostgresIngestionStore } from '../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import { INGEST_TABLES } from '../packages/lore/src/engines/postgres/postgresIngestionSchema.js';
import { makeJobId, makeSourceId, type NewJob } from '../packages/lore/src/ingestion/store.js';
import { ingestionBackends, ING_WS_PREFIX } from './helpers/ingestionBackends.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const rnd = (): string => Math.random().toString(36).slice(2, 10);
const SHA = 'ab'.repeat(32);
const jobFor = (workspace: string, sourceId: string): NewJob => ({
    workspace, sourceId, stage: 'extract', processorId: 'p1', contractVersion: 'a1', params: { k: 1 },
});
const src = (workspace: string) => ({ workspace, fileName: 'f.txt', mimeType: 'text/plain', sha256: SHA, sizeBytes: 3, storageRef: 'ref' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ingest-ids-'));
const be = await ingestionBackends(tmp, 'pg-ingest-ids');
const pool = be.pool;
if (!pool) { console.log('SKIP pg-ingest-ids: no postgres'); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }
const { jobs: JOBS, sources: SOURCES } = INGEST_TABLES;

try {
    await test('same name, different permanent ids: identical upload+job gives two distinct, mutually invisible jobs', async () => {
        const name = `${ING_WS_PREFIX}same-${rnd()}`;
        const keyA = `${ING_WS_PREFIX}keyA-${rnd()}`; const keyB = `${ING_WS_PREFIX}keyB-${rnd()}`;
        const a = await PostgresIngestionStore.open(name, pool, keyA);
        const b = await PostgresIngestionStore.open(name, pool, keyB);
        const sa = await a.upsertSource(src(name)); const sb = await b.upsertSource(src(name));
        assert.notEqual(sa.sourceId, sb.sourceId, 'source ids differ across keys');
        const ja = await a.createJob(jobFor(name, sa.sourceId), new Date());
        const jb = await b.createJob(jobFor(name, sb.sourceId), new Date());
        assert.equal(ja.created, true); assert.equal(jb.created, true, 'the second workspace gets its own job, not a silent conflict');
        assert.notEqual(ja.job.jobId, jb.job.jobId);
        assert.equal((await a.listJobs(name)).length, 1); assert.equal((await b.listJobs(name)).length, 1);
        assert.equal(await a.getJob(jb.job.jobId), undefined); assert.equal(await b.getJob(ja.job.jobId), undefined);
        const rows = await pool.query(`SELECT workspace_id FROM ${JOBS} WHERE workspace_id IN ($1,$2) ORDER BY 1`, [keyA, keyB]);
        assert.equal(rows.rowCount, 2);
        // A repeat on the same store is still idempotent.
        const again = await a.createJob(jobFor(name, sa.sourceId), new Date());
        assert.equal(again.created, false); assert.equal(again.job.jobId, ja.job.jobId);
        assert.equal(ja.job.jobId, makeJobId({ ...jobFor(name, sa.sourceId), workspace: keyA }), 'job id hashes the key');
    });

    await test('legacy name-hashed job row (own workspace) is returned; no second job is created', async () => {
        const name = `${ING_WS_PREFIX}leg-${rnd()}`; const key = `${ING_WS_PREFIX}legkey-${rnd()}`;
        const st = await PostgresIngestionStore.open(name, pool, key);
        const legacySource = makeSourceId(name, SHA);
        await pool.query(`INSERT INTO ${SOURCES} (workspace_id, source_id, file_name, mime_type, sha256, size_bytes, storage_ref, created_at) VALUES ($1,$2,'f.txt','text/plain',$3,3,'ref',now())`, [key, legacySource, SHA]);
        const j = jobFor(name, legacySource);
        const legacyJobId = makeJobId(j);
        await pool.query(`INSERT INTO ${JOBS} (job_id, workspace_id, source_id, stage, processor_id, contract_version, state, attempts, max_attempts, next_attempt_at, params, created_at, updated_at)
            VALUES ($1,$2,$3,'extract','p1','a1','succeeded',1,5,now(),$4::jsonb,now(),now())`, [legacyJobId, key, legacySource, JSON.stringify(j.params)]);
        const r = await st.createJob(j, new Date());
        assert.equal(r.created, false); assert.equal(r.job.jobId, legacyJobId); assert.equal(r.job.state, 'succeeded');
        assert.equal((await pool.query(`SELECT 1 FROM ${JOBS} WHERE workspace_id = $1`, [key])).rowCount, 1, 'no second row');
    });

    await test('legacy lookup never reads another workspace\'s rows', async () => {
        const name = `${ING_WS_PREFIX}iso-${rnd()}`; const keyOld = `${ING_WS_PREFIX}old-${rnd()}`; const keyNew = `${ING_WS_PREFIX}new-${rnd()}`;
        const legacySource = makeSourceId(name, SHA);
        const j = jobFor(name, legacySource);
        // The deleted predecessor's row (held until erase) carries the name-hashed id under ITS key.
        await pool.query(`INSERT INTO ${JOBS} (job_id, workspace_id, source_id, stage, processor_id, contract_version, state, attempts, max_attempts, next_attempt_at, params, created_at, updated_at)
            VALUES ($1,$2,$3,'extract','p1','a1','queued',0,5,now(),$4::jsonb,now(),now())`, [makeJobId(j), keyOld, legacySource, JSON.stringify(j.params)]);
        const st = await PostgresIngestionStore.open(name, pool, keyNew);
        const r = await st.createJob(j, new Date());
        assert.equal(r.created, true); assert.notEqual(r.job.jobId, makeJobId(j));
        assert.equal((await st.listJobs(name)).length, 1);
    });

    await test('source upsert and resolveSourceId (the coordinator\'s lookup) agree, for new and legacy sources', async () => {
        const name = `${ING_WS_PREFIX}src-${rnd()}`; const key = `${ING_WS_PREFIX}srckey-${rnd()}`;
        const st = await PostgresIngestionStore.open(name, pool, key);
        assert.equal(await st.resolveSourceId(name, SHA), makeSourceId(key, SHA), 'new source: key-hashed id');
        assert.equal(await st.getSource(name, await st.resolveSourceId(name, SHA)), undefined);
        const rec = await st.upsertSource(src(name));
        assert.equal(rec.sourceId, makeSourceId(key, SHA));
        assert.equal(await st.resolveSourceId(name, SHA), rec.sourceId);
        assert.equal((await st.getSource(name, await st.resolveSourceId(name, SHA)))?.sourceId, rec.sourceId);
        // Legacy source (name-hashed id): resolve returns the id it already has, and upsert keeps it.
        const name2 = `${ING_WS_PREFIX}src2-${rnd()}`; const key2 = `${ING_WS_PREFIX}src2key-${rnd()}`;
        const st2 = await PostgresIngestionStore.open(name2, pool, key2);
        const legacy = makeSourceId(name2, SHA);
        await pool.query(`INSERT INTO ${SOURCES} (workspace_id, source_id, file_name, mime_type, sha256, size_bytes, storage_ref, created_at) VALUES ($1,$2,'f.txt','text/plain',$3,3,'ref',now())`, [key2, legacy, SHA]);
        assert.equal(await st2.resolveSourceId(name2, SHA), legacy);
        assert.equal((await st2.upsertSource(src(name2))).sourceId, legacy);
        assert.equal((await st2.getSource(name2, await st2.resolveSourceId(name2, SHA)))?.sourceId, legacy);
        await assert.rejects(() => st2.resolveSourceId('someone-else', SHA), /bound to workspace/);
    });
} finally {
    await be.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
