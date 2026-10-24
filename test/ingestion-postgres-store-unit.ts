#!/usr/bin/env tsx
/**
 * test/ingestion-postgres-store-unit.ts — what is specific to the Postgres
 * ingestion store (the engine-neutral behaviour is the shared contract in
 * ingestion-core-unit / ingestion-coordinator-unit):
 *   - exactly-once claim under real concurrency (many claimers, several pools)
 *   - hard tenant isolation by workspace_id, and the bound-store write guard
 *   - unique constraints enforced by the database itself
 *   - idempotent, concurrent schema bootstrap
 *   - JSONB/TEXT hazards (NUL, lone surrogates)
 *   - engine selection: workspace engine -> store, and NO fallback
 *   - tenant-scoped retention
 * Needs LORE_PG_URL (dedicated `lore_gate` database); without it prints a skip
 * reason and exits 0.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CONTRACT_A_VERSION, SqliteIngestionStore, createIngestionStore, type IngestionJob,
} from '../packages/lore/src/ingestion/index.js';
import { PostgresIngestionStore, IngestionWorkspaceMismatchError } from '../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import { INGEST_TABLES } from '../packages/lore/src/engines/postgres/postgresIngestionSchema.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { createGatePool, gateDbUrl } from './helpers/testPostgres.js';
import { ING_WS_PREFIX } from './helpers/ingestionBackends.js';

const gate = await createGatePool('ingestion-postgres-store');
if (!gate) { console.log('\n0 passed, 0 failed (skipped: LORE_PG_URL not set)'); process.exit(0); }
const pool = gate;

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const rnd = () => Math.random().toString(36).slice(2, 10);
const wsName = (tag: string) => `${ING_WS_PREFIX}${tag}-${rnd()}`;
const T0 = new Date('2026-01-01T00:00:00Z');
const sha = (c: string) => c.repeat(64);
const src = (ws: string, c = 'a') => ({ workspace: ws, fileName: 'f.txt', mimeType: 'text/plain', sha256: sha(c), sizeBytes: 3, storageRef: 'ref' });
const mkJob = (ws: string, sourceId: string, i = 0, extra: object = {}) =>
    ({ workspace: ws, sourceId, stage: 'extract' as const, processorId: 'p', contractVersion: CONTRACT_A_VERSION, maxAttempts: 3, params: { i }, ...extra });

await test('exactly-once claim: 12 concurrent claimers over 4 pools claim each of 240 jobs once', async () => {
    const ws = wsName('claim'); const M = 240; const N = 12;
    const url = gateDbUrl()!;
    const pools = [pool, ...[1, 2, 3].map(() => createPostgresPool({ url }))];
    try {
        const seed = await PostgresIngestionStore.open(ws, pool);
        const s0 = await seed.upsertSource(src(ws));
        const ids = new Set<string>();
        for (let i = 0; i < M; i++) ids.add((await seed.createJob(mkJob(ws, s0.sourceId, i), T0)).job.jobId);
        assert.equal(ids.size, M);
        const claimers = await Promise.all(Array.from({ length: N }, (_, i) => PostgresIngestionStore.open(ws, pools[i % pools.length]!)));
        const claimedBy: IngestionJob[][] = await Promise.all(claimers.map(async (c) => {
            const mine: IngestionJob[] = [];
            for (;;) { const got = await c.claimDue(T0, 7); if (got.length === 0) break; mine.push(...got); }
            return mine;
        }));
        const all = claimedBy.flat();
        assert.equal(all.length, M, 'every job claimed (sum of per-claimer claims equals M, so none claimed twice)');
        assert.equal(new Set(all.map((j) => j.jobId)).size, M, 'no job id appears twice');
        assert.deepEqual([...new Set(all.map((j) => j.jobId))].sort(), [...ids].sort(), 'exactly the seeded jobs');
        assert.ok(claimedBy.filter((m) => m.length > 0).length > 1, 'work was actually spread over several claimers');
        const states = await pool.query(`SELECT state, count(*)::int AS n FROM ${INGEST_TABLES.jobs} WHERE workspace_id = $1 GROUP BY state`, [ws]);
        assert.deepEqual(states.rows, [{ state: 'running', n: M }]);
        assert.equal((await seed.claimDue(T0, 50)).length, 0, 'nothing is left to claim');
    } finally { for (const p of pools.slice(1)) await closePostgresPool(p); }
});

await test('claim honours the limit exactly and a claimer never takes another workspace\'s jobs', async () => {
    const a = await PostgresIngestionStore.open(wsName('lim-a'), pool); const b = await PostgresIngestionStore.open(wsName('lim-b'), pool);
    const sa = await a.upsertSource(src(a.workspace)); const sb = await b.upsertSource(src(b.workspace));
    for (let i = 0; i < 10; i++) { await a.createJob(mkJob(a.workspace, sa.sourceId, i), new Date(T0.getTime() + i)); await b.createJob(mkJob(b.workspace, sb.sourceId, i), T0); }
    const got = await a.claimDue(new Date(T0.getTime() + 100), 4);
    assert.equal(got.length, 4); assert.ok(got.every((j) => j.workspace === a.workspace));
    assert.deepEqual(got.map((j) => j.params), [0, 1, 2, 3].map((i) => ({ i })), 'oldest first');
    const left = await b.claimDue(T0, 100); assert.equal(left.length, 10, 'the other workspace still has all of its jobs');
});

await test('concurrent state changes: failures are serialized per job; only one markSucceeded wins', async () => {
    const st = await PostgresIngestionStore.open(wsName('race'), pool); const ws = st.workspace;
    const s = await st.upsertSource(src(ws));
    const { job } = await st.createJob(mkJob(ws, s.sourceId, 0, { maxAttempts: 50 }), T0);
    await st.claimDue(T0, 1);
    await Promise.all(Array.from({ length: 8 }, () => st.recordFailure(job.jobId, 'x', true, T0)));
    assert.equal((await st.getJob(job.jobId))!.attempts, 8, 'eight concurrent failures count eight attempts (no lost update)');
    await st.claimDue(new Date(T0.getTime() + 3_600_000), 1);
    const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => st.markSucceeded(job.jobId, { i }, new Date(T0.getTime() + 3_600_001))));
    assert.equal(wins.filter(Boolean).length, 1, 'exactly one concurrent callback completes the job');
    assert.equal(await st.markSucceeded(job.jobId, { late: 1 }, new Date()), false);
});

await test('tenant isolation: same bytes in two workspaces never share a source, job, delivery or pending row', async () => {
    const a = await PostgresIngestionStore.open(wsName('iso-a'), pool); const b = await PostgresIngestionStore.open(wsName('iso-b'), pool);
    const sa = await a.upsertSource(src(a.workspace)); const sb = await b.upsertSource(src(b.workspace));
    assert.notEqual(sa.sourceId, sb.sourceId);
    const ja = (await a.createJob(mkJob(a.workspace, sa.sourceId), T0)).job; const jb = (await b.createJob(mkJob(b.workspace, sb.sourceId), T0)).job;
    assert.notEqual(ja.jobId, jb.jobId);
    // reads
    assert.equal(await b.getJob(ja.jobId), undefined);
    assert.equal(await b.getSource(a.workspace, sa.sourceId), undefined);
    assert.equal(await b.getSource(b.workspace, sa.sourceId), undefined);
    assert.deepEqual((await b.listJobs(a.workspace)), []);
    assert.deepEqual((await b.listJobs(b.workspace)).map((j) => j.jobId), [jb.jobId]);
    // writes by id against another tenant's job do nothing
    await a.claimDue(T0, 1);
    assert.equal(await b.markSucceeded(ja.jobId, { stolen: true }, T0), false);
    assert.equal(await b.recordFailure(ja.jobId, 'x', false, T0), undefined);
    assert.equal(await b.requeueDeadLetter(ja.jobId, T0), false);
    await b.markAwaitingCallback(ja.jobId, 'evil', T0); await b.markResultsWritten(ja.jobId, T0);
    assert.equal(await b.recordDelivery(ja.jobId, 'd1', T0), false, 'cannot record a delivery against another tenant\'s job');
    const after = (await a.getJob(ja.jobId))!;
    assert.equal(after.state, 'running'); assert.equal(after.result, null); assert.equal(after.remoteRequestId, null); assert.equal(after.resultsWrittenAt, null);
    assert.equal((await pool.query(`SELECT 1 FROM ${INGEST_TABLES.deliveries} WHERE job_id = $1`, [ja.jobId])).rowCount, 0);
    await a.recordPending({ jobId: ja.jobId, workspace: a.workspace, sourceId: sa.sourceId, reason: 'r', payload: { k: 1 } }, T0);
    await assert.rejects(b.recordPending({ jobId: ja.jobId, workspace: b.workspace, sourceId: sb.sourceId, reason: 'x', payload: {} }, T0), /not in workspace/);
    await b.clearPending(ja.jobId);
    assert.equal((await a.listPending(a.workspace)).length, 1, 'another tenant cannot clear a pending row');
    assert.deepEqual(await b.listPending(a.workspace), []);
    // the bound-store guard: writes that name another workspace throw
    await assert.rejects(b.upsertSource(src(a.workspace, 'c')), IngestionWorkspaceMismatchError);
    await assert.rejects(b.createJob(mkJob(a.workspace, sa.sourceId, 9), T0), IngestionWorkspaceMismatchError);
    await assert.rejects(b.recordPending({ jobId: ja.jobId, workspace: a.workspace, sourceId: sa.sourceId, reason: 'x', payload: {} }, T0), IngestionWorkspaceMismatchError);
    assert.equal((await a.listPending(a.workspace))[0]!.reason, 'r');
    // every row in every table carries the tenant column
    for (const t of Object.values(INGEST_TABLES)) {
        const n = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE workspace_id IS NULL OR workspace_id = ''`);
        assert.equal(n.rows[0].n, 0, `${t} has no row without a workspace`);
    }
});

await test('deliveries retention is tenant-scoped', async () => {
    const a = await PostgresIngestionStore.open(wsName('ret-a'), pool); const b = await PostgresIngestionStore.open(wsName('ret-b'), pool);
    const ja = (await a.createJob(mkJob(a.workspace, (await a.upsertSource(src(a.workspace))).sourceId), T0)).job;
    const jb = (await b.createJob(mkJob(b.workspace, (await b.upsertSource(src(b.workspace))).sourceId), T0)).job;
    await a.recordDelivery(ja.jobId, 'd', T0); await b.recordDelivery(jb.jobId, 'd', T0);
    const later = new Date(T0.getTime() + 60 * 86_400_000);
    assert.equal(await a.purgeOldDeliveries(later, { retentionDays: 30 }), 1);
    assert.equal((await pool.query(`SELECT 1 FROM ${INGEST_TABLES.deliveries} WHERE job_id = $1`, [jb.jobId])).rowCount, 1, 'the other tenant\'s old delivery is untouched');
    assert.equal(await b.purgeOldDeliveries(later, { retentionDays: 30 }), 1);
});

await test('the database enforces the unique constraints itself (raw inserts, bypassing the store)', async () => {
    const st = await PostgresIngestionStore.open(wsName('uniq'), pool); const ws = st.workspace;
    const s = await st.upsertSource(src(ws));
    const { job } = await st.createJob(mkJob(ws, s.sourceId), T0);
    const dup = async (sql: string, params: unknown[]) => assert.rejects(pool.query(sql, params), (e: { code?: string }) => e.code === '23505');
    await dup(`INSERT INTO ${INGEST_TABLES.sources} (workspace_id, source_id, file_name, mime_type, sha256, size_bytes, storage_ref, created_at) VALUES ($1,'other','f','t',$2,1,'r',now())`, [ws, s.sha256]);
    await dup(`INSERT INTO ${INGEST_TABLES.sources} (workspace_id, source_id, file_name, mime_type, sha256, size_bytes, storage_ref, created_at) VALUES ($1,$2,'f','t','zz',1,'r',now())`, [ws, s.sourceId]);
    const row = (await pool.query(`SELECT * FROM ${INGEST_TABLES.jobs} WHERE job_id = $1`, [job.jobId])).rows[0];
    const cols = Object.keys(row);
    await dup(`INSERT INTO ${INGEST_TABLES.jobs} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => row[c]));
    await st.recordDelivery(job.jobId, 'd1', T0);
    await dup(`INSERT INTO ${INGEST_TABLES.deliveries} (workspace_id, job_id, delivery_id, seen_at) VALUES ($1,$2,'d1',now())`, [ws, job.jobId]);
    await st.recordPending({ jobId: job.jobId, workspace: ws, sourceId: s.sourceId, reason: 'r', payload: {} }, T0);
    await dup(`INSERT INTO ${INGEST_TABLES.pending} (job_id, workspace_id, source_id, reason, payload, created_at) VALUES ($1,$2,$3,'r2','{}',now())`, [job.jobId, ws, s.sourceId]);
    // and the store's idempotent paths report it correctly under a concurrent burst
    const created = await Promise.all(Array.from({ length: 10 }, () => st.createJob(mkJob(ws, s.sourceId), T0)));
    assert.equal(created.filter((c) => c.created).length, 0, 'the job already existed; no burst call re-creates it');
    const fresh = await Promise.all(Array.from({ length: 10 }, () => st.createJob(mkJob(ws, s.sourceId, 77), T0)));
    assert.equal(fresh.filter((c) => c.created).length, 1, 'exactly one of ten concurrent creates inserts');
    assert.equal(new Set(fresh.map((c) => c.job.jobId)).size, 1);
    const sources = await Promise.all(Array.from({ length: 10 }, () => st.upsertSource(src(ws, 'e'))));
    assert.equal(new Set(sources.map((x) => x.sourceId)).size, 1);
    const dels = await Promise.all(Array.from({ length: 10 }, () => st.recordDelivery(job.jobId, 'burst', T0)));
    assert.equal(dels.filter(Boolean).length, 1, 'exactly one concurrent delivery is first');
});

await test('schema bootstrap is idempotent and safe to run concurrently', async () => {
    const stores = await Promise.all(Array.from({ length: 12 }, (_, i) => PostgresIngestionStore.open(wsName('boot'), i % 2 ? pool : pool)));
    assert.equal(stores.length, 12);
    await PostgresIngestionStore.open(wsName('boot'), pool); // and again, serially
    const t = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ANY($1)`, [Object.values(INGEST_TABLES)]);
    assert.equal(t.rows[0].n, 4);
    const j = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('params','result') ORDER BY column_name`, [INGEST_TABLES.jobs]);
    assert.deepEqual(j.rows.map((r) => r.data_type), ['jsonb', 'jsonb']);
    const pj = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'payload'`, [INGEST_TABLES.pending]);
    assert.equal(pj.rows[0].data_type, 'jsonb');
});

await test('JSONB/TEXT hazards: NUL and lone surrogates are sanitised instead of failing the write', async () => {
    const st = await PostgresIngestionStore.open(wsName('json'), pool); const ws = st.workspace;
    const s = await st.upsertSource({ ...src(ws), fileName: 'we\u0000ird.txt' });
    assert.equal(s.fileName, 'weird.txt');
    const params = { a: 'x\u0000y', b: 'lone\ud800surrogate', c: ['ok', { d: '\u0000' }], emoji: 'ok \u{1F600}' };
    const { job } = await st.createJob(mkJob(ws, s.sourceId, 0, { params }), T0);
    await st.claimDue(T0, 1);
    await st.markSucceeded(job.jobId, { text: 'p\u0000age', bad: '\udc00' }, T0);
    const got = (await st.getJob(job.jobId))!;
    assert.deepEqual(got.params, { a: 'xy', b: 'lone�surrogate', c: ['ok', { d: '' }], emoji: 'ok \u{1F600}' });
    assert.deepEqual(got.result, { text: 'page', bad: '�' });
    await st.recordPending({ jobId: job.jobId, workspace: ws, sourceId: s.sourceId, reason: 'r\u0000', payload: { v: 'a\u0000b' } }, T0);
    assert.deepEqual((await st.listPending(ws))[0]!.payload, { v: 'ab' });
});

await test('engine selection: postgres workspaces get the postgres store, others sqlite, and there is no fallback', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-factory-'));
    const home = path.join(tmp, 'home'); fs.mkdirSync(home);
    const gateUrl = gateDbUrl()!; const pgWs = wsName('fac'); const sqWs = 'fac-sqlite';
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: sqWs, workspaces: [
            { name: sqWs, id: 'id-1', path: path.join(tmp, 'a'), createdAt: T0.toISOString(), graphEngine: 'sqlite' },
            { name: pgWs, id: 'id-2', path: path.join(tmp, 'b'), createdAt: T0.toISOString(), graphEngine: 'postgres' },
        ],
    }));
    const prev = process.env['LORE_PG_URL'];
    try {
        // postgres engine + no URL => loud failure, never a SQLite file
        delete process.env['LORE_PG_URL']; await closeSharedPostgresPool();
        await assert.rejects(createIngestionStore({ workspace: pgWs, home, sqlitePath: path.join(tmp, 'fallback.db') }), /LORE_PG_URL/);
        assert.equal(fs.existsSync(path.join(tmp, 'fallback.db')), false, 'no sqlite file was created as a fallback');
        // postgres engine + URL => the postgres store, bound to the workspace
        process.env['LORE_PG_URL'] = gateUrl;
        const pg = await createIngestionStore({ workspace: pgWs, home, sqlitePath: path.join(tmp, 'ignored.db') });
        assert.ok(pg instanceof PostgresIngestionStore); assert.equal((pg as PostgresIngestionStore).workspace, pgWs);
        assert.equal(fs.existsSync(path.join(tmp, 'ignored.db')), false);
        const s = await pg.upsertSource(src(pgWs)); assert.equal((await pg.getSource(pgWs, s.sourceId))!.sha256, sha('a'));
        await pg.close();
        // sqlite workspace => sqlite store (even with a URL set); a sqlite workspace without a path is a config error
        const sq = await createIngestionStore({ workspace: sqWs, home, sqlitePath: path.join(tmp, 'x.db') });
        assert.ok(sq instanceof SqliteIngestionStore); await sq.close();
        await assert.rejects(createIngestionStore({ workspace: sqWs, home }), /sqlitePath/);
        // explicit override
        const forced = await createIngestionStore({ workspace: sqWs, home, engine: 'postgres' });
        assert.ok(forced instanceof PostgresIngestionStore); await forced.close();
    } finally {
        if (prev === undefined) delete process.env['LORE_PG_URL']; else process.env['LORE_PG_URL'] = prev;
        await closeSharedPostgresPool();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// cleanup of rows written through the shared pool in the factory case, then the gate pool
for (const t of Object.values(INGEST_TABLES)) await pool.query(`DELETE FROM ${t} WHERE workspace_id LIKE $1 OR workspace_id = 'fac-sqlite'`, [`${ING_WS_PREFIX}%`]);
await closePostgresPool(pool);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
