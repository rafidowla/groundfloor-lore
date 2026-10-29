#!/usr/bin/env tsx
/**
 * test/pg-workspace-keys-unit.ts - Phase 0 (shard-ready) lane L2: workspace in every key.
 *
 *   expand     a database seeded the way main leaves it (legacy single-column keys only) is upgraded by opening the
 *              ingestion store: the workspace-led unique keys appear as valid constraints; opening again (and a
 *              concurrent open) changes nothing (index oids unchanged)
 *   on-conflict the store's SQL targets the workspace-led keys (no remaining old-form target in the source)
 *   contract   dropLegacyIngestionKeys / dropLegacyKeywordIndexes / dropVerbatimChangesLog refuse when the replacement
 *              is missing and drop nothing; contractPhase0 then makes the workspace-led key the PRIMARY KEY of the jobs /
 *              pending / deliveries tables (no UNIQUE twin left; a partial run is completed), after which the same job id
 *              can live in two workspaces (enqueue -> claim -> deliver -> park, through the public store API)
 *   indexes    the workspace-led trigram / tag GINs are valid next to the legacy ones, and the contract drops only
 *              the legacy ones
 *   changes log a Postgres database no longer gets verbatim_changes_log; a leftover empty one is dropped by the
 *              contract step, a non-empty one is kept
 *   blob scope  new FsBlobStore refs of a Postgres-backed workspace are filed under the permanent id, so two
 *              workspaces that reuse a NAME never share a blob (the name-keyed guard is no longer needed)
 *
 * Needs a throwaway Postgres with pgvector (LORE_PG_URL); unset -> prints the reason, exits 0. Creates and drops its
 * own database (`lore_p0l2_<pid>`).
 *
 * Run: npx tsx test/pg-workspace-keys-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { CONTRACT_A_VERSION } from '../packages/lore/src/ingestion/index.js';
import { PostgresIngestionStore } from '../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import {
    INGEST_TABLES, INGEST_WORKSPACE_KEYS, dropLegacyIngestionKeys, ingestionSchema_ddl,
} from '../packages/lore/src/engines/postgres/postgresIngestionSchema.js';
import { runSchemaBootstrap } from '../packages/lore/src/engines/postgres/postgresStartup.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { KEYWORD_INDEXES, dropLegacyKeywordIndexes, validKeywordIndexes } from '../packages/lore/src/engines/postgres/postgresKeywordIndex.js';
import { dropVerbatimChangesLog } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { contractPhase0 } from '../packages/lore/src/engines/postgres/postgresPhase0Contract.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { FsBlobStore, sha256Hex } from '../packages/lore/src/ingestion/blobStore.js';
import { SqliteIngestionStore } from '../packages/lore/src/ingestion/sqliteStore.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const raw = process.env['LORE_PG_URL'];
if (!raw || raw.trim() === '') {
    console.log('SKIP pg-workspace-keys-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}
const DB = `lore_p0l2_${process.pid}`;
const adminUrl = new URL(raw); adminUrl.pathname = '/postgres';
const dbUrl = new URL(raw); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const { jobs: JOBS, pending: PENDING, deliveries: DELIVERIES } = INGEST_TABLES;
const T0 = new Date('2026-01-01T00:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p0l2-'));

const oidOf = async (name: string): Promise<string | undefined> => (await q<{ oid: string }>(`SELECT oid::text FROM pg_class WHERE relname = $1`, [name]))[0]?.oid;
const conNames = async (table: string): Promise<string[]> =>
    (await q<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [table])).map((r) => r.conname);
const validKey = async (name: string): Promise<boolean> =>
    (await q(`SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid WHERE c.conname = $1 AND i.indisvalid AND i.indisready`, [name])).length === 1;
/** The PRIMARY KEY (name + ordered columns) and any UNIQUE constraint names of a table. */
const keysOf = async (table: string): Promise<{ pk?: { name: string; columns: string[] }; uniques: string[] }> => {
    const rows = await q<{ conname: string; contype: string; columns: string[] }>(
        `SELECT c.conname, c.contype, (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype IN ('p','u') ORDER BY c.conname`, [table]);
    const pk = rows.find((r) => r.contype === 'p');
    return { ...(pk ? { pk: { name: pk.conname, columns: pk.columns } } : {}), uniques: rows.filter((r) => r.contype === 'u').map((r) => r.conname) };
};
const WS_PKS: Array<[string, string, string[]]> = [
    [JOBS, 'lore_ingest_jobs_pkey', ['workspace_id', 'job_id']],
    [PENDING, 'lore_ingest_pending_pkey', ['workspace_id', 'job_id']],
    [DELIVERIES, 'lore_ingest_deliveries_pkey', ['workspace_id', 'job_id', 'delivery_id']],
];
/** The lane's own pool is autocommit, but DROP INDEX CONCURRENTLY wants one dedicated connection. */
async function withClient<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try { return await fn(c); } finally { c.release(); }
}

const sha = (c: string) => c.repeat(64);
const src = (ws: string, c = 'a') => ({ workspace: ws, fileName: 'f.txt', mimeType: 'text/plain', sha256: sha(c), sizeBytes: 3, storageRef: 'ref' });
const mkJob = (ws: string, sourceId: string, i = 0) =>
    ({ workspace: ws, sourceId, stage: 'extract' as const, processorId: 'p', contractVersion: CONTRACT_A_VERSION, maxAttempts: 3, params: { i } });

const NAME_A = 'p0l2-a';
const KEY_A = '55555555-aaaa-4aaa-8aaa-000000000001';
const KEY_B = '55555555-bbbb-4bbb-8bbb-000000000002';

try {
    console.log('\nexpand: a database seeded the way main leaves it');
    // What main's bootstrap produces: the ingestion tables with only the legacy single-column keys.
    await runSchemaBootstrap(pool, {}, async (client) => { for (const stmt of ingestionSchema_ddl()) await client.query(stmt); });
    await test('precondition: the legacy keys are there, the workspace-led ones are not', async () => {
        assert.deepEqual(await conNames(PENDING), ['lore_ingest_pending_pkey']);
        assert.deepEqual(await conNames(DELIVERIES), ['lore_ingest_deliveries_pkey']);
        for (const k of INGEST_WORKSPACE_KEYS) assert.equal(await oidOf(k.name), undefined);
    });
    // Existing rows (one workspace) that the new keys must be built over.
    await q(`INSERT INTO ${JOBS} (job_id, workspace_id, source_id, stage, processor_id, contract_version, state, max_attempts, next_attempt_at, created_at, updated_at)
             VALUES ('legacy-job', $1, 's', 'extract', 'p', 'v', 'queued', 3, $2, $2, $2)`, [KEY_A, T0]);
    await q(`INSERT INTO ${PENDING} (job_id, workspace_id, source_id, reason, payload, created_at) VALUES ('legacy-job', $1, 's', 'r', '{}'::jsonb, $2)`, [KEY_A, T0]);
    await q(`INSERT INTO ${DELIVERIES} (job_id, delivery_id, workspace_id, seen_at) VALUES ('legacy-job', 'd0', $1, $2)`, [KEY_A, T0]);

    const a = await PostgresIngestionStore.open(NAME_A, pool, KEY_A);
    await test('opening the store builds both workspace-led keys (valid, ready) next to the legacy ones', async () => {
        for (const k of INGEST_WORKSPACE_KEYS) assert.ok(await validKey(k.name), `${k.name} missing or invalid`);
        assert.deepEqual(await conNames(PENDING), ['lore_ingest_pending_pkey', 'lore_ingest_pending_ws_job_key']);
        assert.deepEqual(await conNames(DELIVERIES), ['lore_ingest_deliveries_pkey', 'lore_ingest_deliveries_ws_job_delivery_key']);
    });
    await test('the pre-existing rows survive and still conflict correctly (replay guard, replace-on-conflict)', async () => {
        assert.equal(await a.recordDelivery('legacy-job', 'd0', T0), false, 'the seeded delivery is a replay');
        assert.equal(await a.recordDelivery('legacy-job', 'd1', T0), true);
        await a.recordPending({ jobId: 'legacy-job', workspace: NAME_A, sourceId: 's', reason: 'again', payload: { n: 2 } }, T0);
        const rows = await q<{ reason: string }>(`SELECT reason FROM ${PENDING} WHERE workspace_id = $1 AND job_id = 'legacy-job'`, [KEY_A]);
        assert.deepEqual(rows, [{ reason: 'again' }]);
    });
    await test('a second and a concurrent open change nothing (index oids unchanged, constraints valid)', async () => {
        const before = await Promise.all(INGEST_WORKSPACE_KEYS.map((k) => oidOf(k.name)));
        await Promise.all([1, 2, 3].map(() => PostgresIngestionStore.open(NAME_A, pool, KEY_A)));
        await PostgresIngestionStore.open(NAME_A, pool, KEY_A);
        assert.deepEqual(await Promise.all(INGEST_WORKSPACE_KEYS.map((k) => oidOf(k.name))), before);
        for (const k of INGEST_WORKSPACE_KEYS) assert.ok(await validKey(k.name));
        assert.equal((await q(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ANY($1) AND NOT i.indisvalid`, [INGEST_WORKSPACE_KEYS.map((k) => k.name)])).length, 0);
    });
    await test('an INVALID leftover (cancelled CREATE INDEX CONCURRENTLY) is replaced on the next open', async () => {
        const k = INGEST_WORKSPACE_KEYS[0]!;
        const before = await oidOf(k.name);
        // A constraint-backed index cannot be flagged invalid in place: drop the constraint, leave a half-built index.
        await q(`ALTER TABLE ${k.table} DROP CONSTRAINT ${k.name}`);
        await q(`CREATE UNIQUE INDEX ${k.name} ON ${k.table} (${k.columns})`);
        await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${k.name}'::regclass`);
        await PostgresIngestionStore.open(NAME_A, pool, KEY_A);
        assert.ok(await validKey(k.name));
        assert.notEqual(await oidOf(k.name), before, 'the invalid index was rebuilt, not reused');
    });

    console.log('\non-conflict targets');
    await test('no ON CONFLICT target in the Postgres ingestion store is the old single-column / job-only form', () => {
        const srcText = fs.readFileSync(path.join(process.cwd(), 'packages/lore/src/engines/postgres/postgresIngestionStore.ts'), 'utf-8');
        const targets = [...srcText.matchAll(/ON CONFLICT\s*(\([^)]*\))/g)].map((m) => m[1]!.replace(/\s+/g, ' '));
        assert.ok(targets.length >= 2, 'found the ON CONFLICT clauses');
        for (const t of targets) assert.match(t, /workspace_id/, `ON CONFLICT ${t} is not workspace-led`);
        assert.ok(!/ON CONFLICT\s*\(\s*job_id/.test(srcText));
    });

    console.log('\ncontract: ingestion keys');
    await test('the contract refuses (drops nothing) while a replacement key is missing', async () => {
        const k = INGEST_WORKSPACE_KEYS[1]!;
        await q(`ALTER TABLE ${k.table} DROP CONSTRAINT ${k.name}`);
        const r = await withClient((c) => dropLegacyIngestionKeys(c));
        assert.deepEqual(r.dropped, []);
        assert.ok(r.refused.some((x) => x.includes(k.name)), JSON.stringify(r));
        assert.deepEqual(await conNames(DELIVERIES), ['lore_ingest_deliveries_pkey']);
        await PostgresIngestionStore.open(NAME_A, pool, KEY_A); // restores the key
        assert.ok(await validKey(k.name));
    });

    console.log('\nindexes: workspace-led GINs next to the legacy ones');
    const g = new PostgresGraph(KEY_A, pool);
    await g.initialize();
    const legacyNames = KEYWORD_INDEXES.filter((s) => !s.workspaceLed).map((s) => s.name);
    const wsNames = KEYWORD_INDEXES.filter((s) => s.workspaceLed).map((s) => s.name);
    await test('opening the graph builds the three workspace-led indexes (valid) beside the three legacy ones', async () => {
        assert.equal(wsNames.length, 3); assert.equal(legacyNames.length, 3);
        const have = await validKeywordIndexes(pool);
        for (const n of [...wsNames, ...legacyNames]) assert.ok(have.has(n), `${n} missing or invalid`);
        const defs = (await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'nodes' AND indexname = ANY($1)`, [wsNames])).map((r) => r.indexdef).join('\n');
        assert.equal((defs.match(/\(workspace_id,/g) ?? []).length, 3, 'every workspace-led index leads with workspace_id');
        assert.match(defs, /gin_trgm_ops/);
        assert.match(defs, /jsonb_path_ops/);
    });
    await test('the contract refuses to drop the legacy indexes while a workspace-led one is missing', async () => {
        await q(`DROP INDEX idx_nodes_ws_tags_gin`);
        const r = await withClient((c) => dropLegacyKeywordIndexes(c));
        assert.deepEqual(r.dropped, []);
        assert.equal(r.refused.length, 1);
        const have = await validKeywordIndexes(pool);
        for (const n of legacyNames) assert.ok(have.has(n), `${n} must still be there`);
        const g2 = new PostgresGraph(KEY_A, pool); await g2.initialize(); await g2.close(); // rebuilds it
        assert.ok((await validKeywordIndexes(pool)).has('idx_nodes_ws_tags_gin'));
    });

    console.log('\nchanges log');
    await test('a fresh Postgres database has no verbatim_changes_log', async () => {
        assert.equal((await q<{ t: string | null }>(`SELECT to_regclass('verbatim_changes_log')::text AS t`))[0]!.t, null);
    });
    await test('a leftover empty log is dropped by the contract step; a non-empty one is kept and reported', async () => {
        await q(`CREATE TABLE verbatim_changes_log (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, row_id TEXT NOT NULL)`);
        await q(`INSERT INTO verbatim_changes_log (row_id) VALUES ('x')`);
        const kept = await withClient((c) => dropVerbatimChangesLog(c));
        assert.equal(kept.dropped, false);
        assert.match(kept.refused ?? '', /holds 1 row/);
        await q('DELETE FROM verbatim_changes_log');
        assert.deepEqual(await withClient((c) => dropVerbatimChangesLog(c)), { dropped: true });
        assert.deepEqual(await withClient((c) => dropVerbatimChangesLog(c)), { dropped: false }, 'second run is a no-op');
    });

    console.log('\ncontract end to end + two workspaces, same job id');
    await test('contractPhase0 ends with a workspace-led PRIMARY KEY on all three tables (no PK-less table, no UNIQUE twin); a second run changes nothing', async () => {
        const first = await withClient((c) => contractPhase0(c));
        assert.deepEqual(first.ingestionKeys.refused, []);
        assert.deepEqual([...first.ingestionKeys.dropped].sort(), [
            `${JOBS}.lore_ingest_jobs_pkey`, `${JOBS}.lore_ingest_jobs_workspace_id_job_id_key`,
            `${PENDING}.lore_ingest_pending_pkey`, `${PENDING}.lore_ingest_pending_ws_job_key`,
            `${DELIVERIES}.lore_ingest_deliveries_pkey`, `${DELIVERIES}.lore_ingest_deliveries_ws_job_delivery_key`].sort());
        assert.equal(first.ingestionKeys.promoted.length, 3);
        for (const [table, name, columns] of WS_PKS) {
            const k = await keysOf(table);
            assert.deepEqual(k.pk, { name, columns }, `${table} primary key`);
            assert.deepEqual(k.uniques, [], `${table} has no leftover UNIQUE twin`);
            const idx = await q<{ indisvalid: boolean; indisprimary: boolean }>(`SELECT i.indisvalid, i.indisprimary FROM pg_index i WHERE i.indrelid = $1::regclass AND i.indisprimary`, [table]);
            assert.deepEqual(idx, [{ indisvalid: true, indisprimary: true }]);
        }
        assert.deepEqual([...first.keywordIndexes.dropped].sort(), [...legacyNames].sort());
        const have = await validKeywordIndexes(pool);
        for (const n of wsNames) assert.ok(have.has(n));
        for (const n of legacyNames) assert.ok(!have.has(n));
        const before = await q(`SELECT conrelid::regclass::text AS t, conname, oid::text FROM pg_constraint WHERE contype IN ('p','u') AND conrelid = ANY($1::regclass[]) ORDER BY 1,2`, [[JOBS, PENDING, DELIVERIES]]);
        const second = await withClient((c) => contractPhase0(c));
        assert.deepEqual(second.ingestionKeys, { dropped: [], promoted: [], refused: [] }); assert.deepEqual(second.keywordIndexes.dropped, []);
        assert.deepEqual(await q(`SELECT conrelid::regclass::text AS t, conname, oid::text FROM pg_constraint WHERE contype IN ('p','u') AND conrelid = ANY($1::regclass[]) ORDER BY 1,2`, [[JOBS, PENDING, DELIVERIES]]), before, 'same constraints, same oids');
    });
    await test('opening the store after the contract does not rebuild the UNIQUE twins', async () => {
        await PostgresIngestionStore.open(NAME_A, pool, KEY_A);
        for (const [table] of WS_PKS) assert.deepEqual((await keysOf(table)).uniques, [], table);
    });
    await test('a partial earlier run is completed: no primary key + UNIQUE twin + an INVALID leftover index -> PK restored, twin dropped', async () => {
        const pk = 'lore_ingest_pending_pkey', uq = 'lore_ingest_pending_ws_job_key', idx = 'lore_ingest_pending_ws_pk_idx';
        await q(`ALTER TABLE ${PENDING} ADD CONSTRAINT ${uq} UNIQUE (workspace_id, job_id)`);
        await q(`ALTER TABLE ${PENDING} DROP CONSTRAINT ${pk}`);
        await q(`CREATE UNIQUE INDEX ${idx} ON ${PENDING} (workspace_id, job_id)`);
        await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${idx}'::regclass`);
        const r = await withClient((c) => dropLegacyIngestionKeys(c));
        assert.deepEqual(r.refused, []);
        assert.deepEqual(r.promoted, [`${PENDING} PRIMARY KEY (workspace_id, job_id)`]);
        assert.deepEqual(r.dropped, [`${PENDING}.${uq}`]);
        assert.deepEqual(await keysOf(PENDING), { pk: { name: pk, columns: ['workspace_id', 'job_id'] }, uniques: [] });
        assert.deepEqual(await withClient((c) => dropLegacyIngestionKeys(c)), { dropped: [], promoted: [], refused: [] });
    });
    await test('enqueue -> claim -> deliver -> park works in two workspaces with the SAME job id (after the contract)', async () => {
        const b = await PostgresIngestionStore.open('p0l2-b', pool, KEY_B);
        const ids: Record<string, string> = {};
        for (const [store, key] of [[a, KEY_A], [b, KEY_B]] as const) {
            const s = await store.upsertSource(src(store.workspace, 'e'));
            const { job } = await store.createJob(mkJob(store.workspace, s.sourceId, 1), T0);
            ids[key] = job.jobId;
        }
        // Force the same job id in both workspaces (raw, as a restore into a new workspace without re-minting would).
        await q(`UPDATE ${JOBS} SET job_id = 'shared-job' WHERE workspace_id = ANY($1) AND job_id = ANY($2)`, [[KEY_A, KEY_B], Object.values(ids)]);
        const claimedA = await a.claimDue(T0, 10);
        const claimedB = await b.claimDue(T0, 10);
        assert.ok(claimedA.some((j) => j.jobId === 'shared-job') && claimedB.some((j) => j.jobId === 'shared-job'));
        assert.equal(await a.recordDelivery('shared-job', 'cb-1', T0), true);
        assert.equal(await b.recordDelivery('shared-job', 'cb-1', T0), true, 'the other workspace\'s identical delivery is not a replay');
        assert.equal(await a.recordDelivery('shared-job', 'cb-1', T0), false, 'a real replay is still refused');
        await a.recordPending({ jobId: 'shared-job', workspace: 'p0l2-a', sourceId: 'x', reason: 'a-reason', payload: { w: 'a' } }, T0);
        await b.recordPending({ jobId: 'shared-job', workspace: 'p0l2-b', sourceId: 'x', reason: 'b-reason', payload: { w: 'b' } }, T0);
        assert.deepEqual((await a.listPending('p0l2-a')).filter((p) => p.jobId === 'shared-job').map((p) => p.reason), ['a-reason']);
        assert.deepEqual((await b.listPending('p0l2-b')).map((p) => p.reason), ['b-reason']);
        // Retention stays tenant-scoped on the new key.
        const later = new Date(T0.getTime() + 60 * 86_400_000);
        assert.equal(await b.purgeOldDeliveries(later, { retentionDays: 30 }), 1);
        assert.equal((await q(`SELECT 1 FROM ${DELIVERIES} WHERE workspace_id = $1 AND job_id = 'shared-job'`, [KEY_A])).length, 1, 'workspace a\'s delivery untouched');
        await a.clearPending('shared-job');
        assert.equal((await b.listPending('p0l2-b')).length, 1, 'clearing in one workspace leaves the other');
    });

    console.log('\ncontract on a database without ingestion tables');
    await test('contractPhase0 skips absent ingestion tables (embedded host that never ingested) and still drops the legacy keyword indexes', async () => {
        const DB2 = `${DB}_noingest`;
        await admin(`DROP DATABASE IF EXISTS ${DB2} WITH (FORCE)`);
        await admin(`CREATE DATABASE ${DB2}`);
        const url2 = new URL(raw); url2.pathname = `/${DB2}`;
        const pool2: Pool = createPostgresPool({ url: url2.toString() });
        try {
            const g2 = new PostgresGraph(KEY_A, pool2); await g2.initialize(); await g2.close();
            assert.equal((await pool2.query(`SELECT to_regclass($1) IS NULL AS absent`, [JOBS])).rows[0].absent, true, 'precondition: no ingestion tables');
            const c = await pool2.connect();
            let r: Awaited<ReturnType<typeof contractPhase0>>;
            try { r = await contractPhase0(c); } finally { c.release(); }
            assert.deepEqual(r.ingestionKeys, { dropped: [], promoted: [], refused: [] });
            assert.deepEqual(r.keywordIndexes.refused, []);
            assert.deepEqual([...r.keywordIndexes.dropped].sort(), ['idx_nodes_content_trgm', 'idx_nodes_label_trgm', 'idx_nodes_tags_gin']);
            assert.equal((await pool2.query(`SELECT to_regclass($1) IS NULL AS absent`, [JOBS])).rows[0].absent, true, 'the contract creates nothing');
        } finally {
            await closePostgresPool(pool2);
            await admin(`DROP DATABASE IF EXISTS ${DB2} WITH (FORCE)`).catch(() => undefined);
        }
    });

    console.log('\nblob scope');
    await test('Postgres-backed refs are filed under the permanent id: a reused NAME never shares a blob across workspaces', async () => {
        const blobs = new FsBlobStore(path.join(tmp, 'blobs'));
        const bytes = Buffer.from('same bytes in both');
        const sha256 = sha256Hex(bytes);
        const x = await PostgresIngestionStore.open('reused-name', pool, KEY_A);
        const y = await PostgresIngestionStore.open('reused-name', pool, KEY_B);
        assert.equal(x.blobScope('reused-name'), KEY_A);
        assert.equal(y.blobScope('reused-name'), KEY_B);
        const refX = await blobs.put(x.blobScope('reused-name'), sha256, bytes);
        const refY = await blobs.put(y.blobScope('reused-name'), sha256, bytes);
        assert.notEqual(refX, refY);
        await blobs.delete!(refX);
        assert.equal(await blobs.has!(refX), false);
        assert.equal(await blobs.has!(refY), true, 'erasing one workspace\'s blob leaves the same-named workspace\'s blob');
    });
    await test('the SQLite store has no permanent id: it does not define blobScope and keeps the name', async () => {
        const s = new SqliteIngestionStore(path.join(tmp, 'i.db'));
        assert.equal((s as unknown as { blobScope?: unknown }).blobScope, undefined);
        await s.close();
    });

    await g.close();
} finally {
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
