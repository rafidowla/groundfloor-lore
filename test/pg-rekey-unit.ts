/**
 * test/pg-rekey-unit.ts - Postgres rows are keyed by the workspace's PERMANENT id; the one-time name -> id rewrite.
 *
 * Needs a throwaway Postgres with pgvector (`LORE_PG_URL`); unset -> prints the reason, exits 0. Builds its own
 * database (`lore_rekey_<pid>`) and its own registry home. Name-keyed rows are written the way an older build did
 * (stores constructed directly with the NAME as key), then the migration is triggered by opening a store through
 * the resolver, exactly as production does.
 *
 * Covers: every table re-keyed (rows byte-identical apart from the key), views and partitions follow, ledger,
 * idempotence, the mixed-key guard, stray rows left alone, a deleted workspace re-keyed under its recorded id,
 * name reuse after delete (the new owner is untouched by erasing the old id), the eraser receipt `complete`,
 * the resolver's typed refusal, and logical backups (old name-keyed bundle restores under the restoring id).
 *
 * Run: npx tsx test/pg-rekey-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { PostgresIngestionStore } from '../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import { setLinkOptOuts } from '../packages/lore/src/engines/postgres/postgresGraphLinkOptOut.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { createPostgresWorkspaceEraser, POSTGRES_ROWS_KEYED_BY } from '../packages/lore/src/engines/postgres/postgresWorkspaceErase.js';
import { PostgresWorkspaceKeyError, resolvePostgresWorkspaceKey } from '../packages/lore/src/engines/postgres/postgresWorkspaceKey.js';
import { PostgresRekeyConflictError, REKEY_LEDGER_TABLE } from '../packages/lore/src/engines/postgres/postgresRekey.js';
import { buildRekeyPlan } from '../packages/lore/src/engines/postgres/postgresRekeyPlan.js';
import { peekLogicalBundle } from '../packages/lore/src/engines/workspaceLogicalBackup.js';
import { backupPostgresWorkspace, restoreLogicalBundleCli } from '../packages/lore/src/cli/commands/backupPostgres.js';
import { writeControl, type WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';
import { appendRestoredEvent, recordWorkspaceDeletion } from '../packages/lore/src/config/deletedWorkspaces.js';
import { CONTRACT_A_VERSION } from '../packages/lore/src/ingestion/index.js';
import type { EraseTarget } from '../packages/lore/src/engines/workspaceErase/types.js';
import { gateDbUrl } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-rekey-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}
const DB = `lore_rekey_${process.pid}`;
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
const DIM = 8;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrekey-home-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrekey-out-'));
process.env['LORE_HOME'] = HOME;                 // the CLI paths resolve the registry through loreHome()
process.env['LORE_PG_URL'] = dbUrl.toString();   // ...and the shared pool through this

const ACME = '11111111-aaaa-4aaa-8aaa-000000000001';
const BETA = '11111111-aaaa-4aaa-8aaa-000000000002';
const GONE = '11111111-aaaa-4aaa-8aaa-000000000003';
const MIXED = '11111111-aaaa-4aaa-8aaa-000000000004';
const ACME2 = '11111111-aaaa-4aaa-8aaa-000000000005';
const RESTORE = '11111111-aaaa-4aaa-8aaa-000000000006';
const entry = (name: string, id: string): WorkspaceEntry => ({
    name, id, path: path.join(HOME, 'ws', name), createdAt: '2026-01-01T00:00:00Z', graphEngine: 'postgres', vectorEngine: 'postgres',
} as WorkspaceEntry);
const E = { acme: entry('rk-acme', ACME), beta: entry('rk-beta', BETA), gone: entry('rk-gone', GONE), mixed: entry('rk-mixed', MIXED), acme2: entry('rk-acme', ACME2), restore: entry('rk-restore', RESTORE) };
const writeRegistry = (entries: WorkspaceEntry[]): void => {
    for (const e of entries) fs.mkdirSync(e.path, { recursive: true });
    writeControl({ active: entries[0]!.name, workspaces: entries } as never, HOME);
};

const vec = (seed: number): string => `[${Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7.13 + i) * 1e-3 + (seed % 5) / 3).join(',')}]`;
const sha = (c: string): string => c.repeat(64);
const T0 = new Date('2026-01-01T00:00:00Z');
const targetOf = (id: string, name: string): EraseTarget => ({ id, name, path: '/nonexistent', mode: 'cloud', orgId: null });

async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pools: Pool[] = [];
const newPool = (): Pool => { const p = createPostgresPool({ url: dbUrl.toString() }); pools.push(p); return p; };
const pool = newPool();
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

/** Seed one workspace through the real write paths, keyed by `key` (the NAME for pre-migration data). */
async function seed(key: string, n: number): Promise<void> {
    const g = new PostgresGraph(key, pool);
    await g.initialize();
    for (let i = 0; i < n; i++) {
        await g.upsertNode({ id: `n${i}`, type: 'note', label: `label ${i}`, content: `content ${i}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
        if (i > 0) await g.addEdge({ sourceId: `n${i - 1}`, targetId: `n${i}`, relation: 'next' } as never);
    }
    await setLinkOptOuts(pool, key, ['n0'], true);
    await g.close();

    const c = await pool.connect();
    try { await ensureVerbatimSchema(c, key, DIM); } finally { c.release(); }
    for (let i = 0; i < n; i++) {
        await pool.query(`INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at, tags) VALUES ($1,$2,$3,$4::vector,'2026-01-01','2026-01-01',NULL)`,
            [key, `v${i}`, `verbatim text ${i}`, vec(i + 1)]);
    }

    const t = await PostgresTableStorage.open(key, pool);
    await t.createTable({
        name: 'deals',
        columns: [{ name: 'id', type: 'string', primary: true }, { name: 'amount', type: 'integer', indexed: true }, { name: 'code', type: 'string', unique: true }],
    } as never);
    await t.insertBatch('deals', Array.from({ length: n }, (_, i) => ({ id: `d${i}`, amount: i * 10, code: `c${i}` })));

    const ing = await PostgresIngestionStore.open(key, pool);
    const s = await ing.upsertSource({ workspace: key, fileName: 'f.txt', mimeType: 'text/plain', sha256: sha('a'), sizeBytes: 3, storageRef: 'ref-shared' });
    for (let i = 0; i < n; i++) {
        const { job } = await ing.createJob({ workspace: key, sourceId: s.sourceId, stage: 'extract', processorId: 'p', contractVersion: CONTRACT_A_VERSION, maxAttempts: 3, params: { i } } as never, T0);
        await ing.recordDelivery(job.jobId, `del-${i}`, T0);
        if (i === 0) await ing.recordPending({ jobId: job.jobId, workspace: key, sourceId: s.sourceId, reason: 'no table', payload: { x: 1 } }, T0);
    }
}

async function keyedTables(): Promise<string[]> {
    return (await q<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname <> '${REKEY_LEDGER_TABLE}' ORDER BY 1`)).map((r) => r.relname);
}

/** Per table: "<rows>:<md5 of the rows with the key blanked out>", so a re-keyed copy compares equal to its source. */
async function fp(key: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of await keyedTables()) {
        const r = await q<{ n: string; h: string }>(
            `SELECT count(*)::text AS n, coalesce(md5(string_agg(replace(x::text, $1, '@'), '|' ORDER BY replace(x::text, $1, '@'))), '-') AS h FROM "${t}" x WHERE workspace_id = $1`, [key]);
        out[t] = `${r[0]!.n}:${r[0]!.h}`;
    }
    return out;
}
const counts = (f: Record<string, string>): Record<string, number> => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v.split(':')[0])]));
const total = (f: Record<string, string>): number => Object.values(f).reduce((a, v) => a + Number(v.split(':')[0]), 0);
const viewCount = async (literal: string): Promise<number> => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_class WHERE relkind='v' AND relname LIKE 'lore\\_tv\\_%' AND position($1 in pg_get_viewdef(oid)) > 0`, [`workspace_id = '${literal}'`]))[0]!.n);
const partitionCount = async (literal: string): Promise<number> => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE pg_get_expr(c.relpartbound, c.oid) = $1`, [`FOR VALUES IN ('${literal}')`]))[0]!.n);
const ledger = async (): Promise<Array<{ key_id: string; rows_moved: number; rekeyed_at: string }>> =>
    q(`SELECT key_id, rows_moved, rekeyed_at::text AS rekeyed_at FROM ${REKEY_LEDGER_TABLE} ORDER BY key_id`);

/** Open the workspace named `name` the way production does: resolve its id, construct the store, initialize. */
async function openViaResolver(p: Pool, name: string): Promise<string> {
    const key = resolvePostgresWorkspaceKey(name, HOME);
    const g = new PostgresGraph(key, p);
    await g.initialize();
    await g.close();
    return key;
}

try {
    // ---- pre-migration state: name-keyed rows, as an older build wrote them ----------------------------------
    writeRegistry([E.acme, E.beta, E.gone]);
    recordWorkspaceDeletion(E.gone, [E.acme, E.beta], HOME, new Date('2026-02-01T00:00:00Z'));
    writeRegistry([E.acme, E.beta]); // 'rk-gone' is out of the registry, only in the deletion log
    await seed('rk-acme', 8);
    await seed('rk-beta', 5);
    await seed('rk-gone', 4);
    await seed('rk-stray', 3); // belongs to no registry workspace
    const pre = { acme: await fp('rk-acme'), beta: await fp('rk-beta'), gone: await fp('rk-gone'), stray: await fp('rk-stray') };
    const oldAcmeBundle = (await exportWorkspaceBundle(pool, { workspaceId: 'rk-acme', outDir: OUT })).bundlePath;
    const oldBetaBundle = (await exportWorkspaceBundle(pool, { workspaceId: 'rk-beta', outDir: OUT })).bundlePath;

    await test('production switch: rows are keyed by the permanent id', async () => {
        assert.equal(POSTGRES_ROWS_KEYED_BY, 'permanent-id');
        for (const f of Object.values(pre)) assert.ok(total(f) > 20, JSON.stringify(f));
    });

    await test('the resolver has no fallback: unknown name, empty name, and a missing registry all throw the typed error', async () => {
        assert.throws(() => resolvePostgresWorkspaceKey('rk-nope', HOME), (e: unknown) => e instanceof PostgresWorkspaceKeyError && e.code === 'postgres_workspace_key_missing');
        assert.throws(() => resolvePostgresWorkspaceKey('  ', HOME), PostgresWorkspaceKeyError);
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrekey-empty-'));
        assert.throws(() => resolvePostgresWorkspaceKey('rk-acme', empty), /no workspace registry/);
        fs.rmSync(empty, { recursive: true, force: true });
        assert.equal(resolvePostgresWorkspaceKey('rk-acme', HOME), ACME);
    });

    await test('registry plan: aliases share an id, a live name beats a deleted one, restored deletions are skipped', async () => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrekey-plan-'));
        const T1 = '22222222-bbbb-4bbb-8bbb-000000000001', T2 = '22222222-bbbb-4bbb-8bbb-000000000002', R1 = '22222222-bbbb-4bbb-8bbb-000000000003';
        const twinOld = { ...entry('rk-twin', T1), path: path.join(h, 'a') }, twinNew = { ...entry('rk-twin', T2), path: path.join(h, 'b') };
        const alias = { ...entry('rk-twin-alias', T2), path: path.join(h, 'b') };
        const back = { ...entry('rk-back', R1), path: path.join(h, 'c') };
        recordWorkspaceDeletion(twinOld, [twinNew, alias], h, new Date('2026-02-01T00:00:00Z'));
        recordWorkspaceDeletion(back, [twinNew, alias], h, new Date('2026-02-02T00:00:00Z'));
        appendRestoredEvent({ id: R1, name: 'rk-back' }, h);
        writeControl({ active: 'rk-twin', workspaces: [twinNew, alias] } as never, h);
        const plan = buildRekeyPlan(h);
        assert.deepEqual(plan.targets.map((t) => [t.id, t.names, t.deleted]), [[T1, [], true], [T2, ['rk-twin', 'rk-twin-alias'], false]]);
        assert.deepEqual(plan.shadowed, [{ id: T1, name: 'rk-twin' }]);
        fs.rmSync(h, { recursive: true, force: true });
    });

    // ---- the migration ------------------------------------------------------------------------------------------
    await test('opening ONE workspace through the resolver re-keys every registry workspace (live and deleted), every table, one ledger row each', async () => {
        const key = await openViaResolver(pool, 'rk-acme');
        assert.equal(key, ACME);
        assert.deepEqual(await fp(ACME), pre.acme);
        assert.deepEqual(await fp(BETA), pre.beta);
        assert.deepEqual(await fp(GONE), pre.gone, 'a deleted (held) workspace is re-keyed under its recorded id');
        for (const n of ['rk-acme', 'rk-beta', 'rk-gone']) assert.equal(total(await fp(n)), 0, `rows still under name ${n}`);
        const l = await ledger();
        assert.deepEqual(l.map((x) => x.key_id), [ACME, BETA, GONE].sort());
        assert.ok(l.every((x) => x.rows_moved > 0));
    });

    await test('rows under a key that matches no registry workspace are left exactly as they were', async () => {
        assert.deepEqual(await fp('rk-stray'), pre.stray);
    });

    await test('typed views and verbatim partitions follow the key', async () => {
        for (const id of [ACME, BETA, GONE]) {
            assert.equal(await viewCount(id), 1, `view for ${id}`);
            assert.equal(await partitionCount(id), 1, `partition for ${id}`);
        }
        for (const n of ['rk-acme', 'rk-beta', 'rk-gone']) {
            assert.equal(await viewCount(n), 0, `view still keyed by ${n}`);
            assert.equal(await partitionCount(n), 0, `partition still keyed by ${n}`);
        }
        assert.equal(await partitionCount('rk-stray'), 1);
    });

    await test('the stores work against the id afterwards (writes land under the id, nothing is written under the name)', async () => {
        const key = resolvePostgresWorkspaceKey('rk-beta', HOME);
        const ing = await PostgresIngestionStore.open('rk-beta', pool, key);
        const before = Number((await q<{ n: string }>(`SELECT count(*)::text n FROM lore_ingest_sources WHERE workspace_id=$1`, [BETA]))[0]!.n);
        await ing.upsertSource({ workspace: 'rk-beta', fileName: 'g.txt', mimeType: 'text/plain', sha256: sha('b'), sizeBytes: 4, storageRef: 'ref-new' });
        assert.equal(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM lore_ingest_sources WHERE workspace_id=$1`, [BETA]))[0]!.n), before + 1);
        assert.equal(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM lore_ingest_sources WHERE workspace_id='rk-beta'`))[0]!.n), 0);
        const t = await PostgresTableStorage.open(key, pool);
        await t.insertBatch('deals', [{ id: 'dnew', amount: 1, code: 'cnew' }]);
        assert.equal(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM lore_entity WHERE workspace_id=$1`, [BETA]))[0]!.n), 6);
    });

    await test('second run is a no-op: a fresh pool re-checks, changes nothing, adds no ledger row', async () => {
        const ledgerBefore = await ledger();
        const fpBefore = { acme: await fp(ACME), beta: await fp(BETA), gone: await fp(GONE), stray: await fp('rk-stray') };
        const p2 = newPool();
        await openViaResolver(p2, 'rk-beta');
        await openViaResolver(p2, 'rk-acme');
        assert.deepEqual(await ledger(), ledgerBefore);
        assert.deepEqual({ acme: await fp(ACME), beta: await fp(BETA), gone: await fp(GONE), stray: await fp('rk-stray') }, fpBefore);
    });

    // ---- mixed-key guard ----------------------------------------------------------------------------------------
    await test('mixed-key guard: rows under BOTH the name and the id stop the open with a clear error and change nothing', async () => {
        writeRegistry([E.acme, E.beta, E.mixed]);
        await seed('rk-mixed', 3);
        await seed(MIXED, 2);
        const nameBefore = await fp('rk-mixed'), idBefore = await fp(MIXED);
        const ledgerBefore = await ledger();
        await assert.rejects(openViaResolver(newPool(), 'rk-mixed'), (e: unknown) => {
            assert.ok(e instanceof PostgresRekeyConflictError, String(e));
            assert.equal(e.code, 'postgres_rekey_mixed_keys');
            assert.match(e.message, /BOTH/);
            assert.ok(e.tables.includes('nodes'));
            return true;
        });
        assert.deepEqual(await fp('rk-mixed'), nameBefore);
        assert.deepEqual(await fp(MIXED), idBefore);
        assert.deepEqual(await ledger(), ledgerBefore, 'a refused workspace must not be recorded');
    });

    await test('a conflict on a workspace that is NOT being opened does not block the others', async () => {
        await openViaResolver(newPool(), 'rk-acme');
        assert.equal(total(await fp('rk-mixed')) > 0, true);
        assert.ok(!(await ledger()).some((x) => x.key_id === MIXED));
    });

    await test('after the operator removes the stale name-keyed set, the next open records the workspace', async () => {
        for (const t of await keyedTables()) {
            if (t === 'verbatim') continue;
            await pool.query(`DELETE FROM "${t}" WHERE workspace_id = 'rk-mixed'`).catch(() => undefined);
        }
        await pool.query(`DELETE FROM verbatim WHERE workspace_id = 'rk-mixed'`);
        await pool.query(`DROP TABLE IF EXISTS "${(await q<{ relname: string }>(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE pg_get_expr(c.relpartbound, c.oid) = $1`, [`FOR VALUES IN ('rk-mixed')`]))[0]?.relname ?? 'zz_none'}"`);
        await openViaResolver(newPool(), 'rk-mixed');
        assert.ok((await ledger()).some((x) => x.key_id === MIXED));
        assert.equal(total(await fp('rk-mixed')), 0);
    });

    // ---- name reuse + eraser ------------------------------------------------------------------------------------
    await test('name reuse after delete: the new owner has its own id; erasing the old id deletes only the old rows; receipt is complete', async () => {
        recordWorkspaceDeletion(E.acme, [E.beta, E.mixed], HOME, new Date('2026-03-01T00:00:00Z'));
        writeRegistry([E.acme2, E.beta, E.mixed]); // a different workspace now holds the name 'rk-acme'
        const p = newPool();
        const key = await openViaResolver(p, 'rk-acme');
        assert.equal(key, ACME2, 'the reused name resolves to the NEW workspace id');
        await seed(ACME2, 3);
        const newBefore = await fp(ACME2), betaBefore = await fp(BETA), goneBefore = await fp(GONE);
        const oldRows = total(await fp(ACME));
        assert.ok(oldRows > 0 && total(newBefore) > 0);

        const receipt = await createPostgresWorkspaceEraser({ pool, vacuum: false }).erase(targetOf(ACME, 'rk-acme'));
        assert.equal(receipt.status, 'complete', JSON.stringify(receipt));
        assert.equal(total(await fp(ACME)), 0, 'the old workspace is gone');
        assert.deepEqual(await fp(ACME2), newBefore, 'the new owner of the name is untouched');
        assert.deepEqual(await fp(BETA), betaBefore);
        assert.deepEqual(await fp(GONE), goneBefore);
        assert.equal(await viewCount(ACME), 0); assert.equal(await partitionCount(ACME), 0);
        assert.equal(await viewCount(ACME2), 1); assert.equal(await partitionCount(ACME2), 1);
    });

    await test('erasing a deleted (held) workspace that was re-keyed removes its rows for real', async () => {
        const r = await createPostgresWorkspaceEraser({ pool, vacuum: false }).erase(targetOf(GONE, 'rk-gone'));
        assert.equal(r.status, 'complete', JSON.stringify(r));
        assert.equal(total(await fp(GONE)), 0);
        assert.deepEqual(await fp('rk-stray'), pre.stray);
    });

    // ---- backups ------------------------------------------------------------------------------------------------
    await test('restoring an OLD name-keyed bundle lands the rows under the restoring workspace id', async () => {
        const header = await peekLogicalBundle(oldAcmeBundle);
        assert.equal(header?.sourceWorkspaceId, 'rk-acme', 'the old bundle really is name-keyed');
        await restoreWorkspaceBundle(pool, { bundlePath: oldAcmeBundle, targetWorkspaceId: RESTORE });
        assert.equal(total(await fp('rk-acme')), 0, 'nothing is written under the old name');
        const got = await fp(RESTORE);
        for (const t of Object.keys(pre.acme)) assert.equal(got[t]!.split(':')[0], pre.acme[t]!.split(':')[0], `row count for ${t}`);
    });

    await test('CLI round trip: new bundles are keyed by the id, and either the name or the id is accepted as the source', async () => {
        writeRegistry([E.acme2, E.beta, E.mixed, E.restore]);
        const betaNow = await fp(BETA);
        const summary = await backupPostgresWorkspace('rk-beta', E.beta.path, OUT, 5);
        const header = await peekLogicalBundle(summary.bundlePath);
        assert.equal(header?.sourceWorkspaceId, BETA, 'the new bundle records the permanent id');
        assert.ok(path.basename(summary.bundlePath).includes(BETA), path.basename(summary.bundlePath));

        const deps = { workspaceDir: (n: string) => (n === 'rk-beta' ? E.beta.path : E.restore.path), daemonServesHome: async () => false, daemonMessage: 'daemon' };
        // new bundle (source = id) into the same workspace, replacing: accepted without --allow-name-mismatch
        assert.equal(await restoreLogicalBundleCli(summary.bundlePath, BETA, 'rk-beta', { force: true, replace: true }, deps), true);
        assert.deepEqual(counts(await fp(BETA)), counts(betaNow)); // a restore shifts entity ids, so compare row counts
        // OLD bundle (source = name) into the same workspace, replacing: the rows end up under the id again
        assert.equal(await restoreLogicalBundleCli(oldBetaBundle, 'rk-beta', 'rk-beta', { force: true, replace: true }, deps), true);
        assert.equal(total(await fp('rk-beta')), 0, 'no name-keyed rows after restoring an old bundle');
        const after = counts(await fp(BETA));
        const old = counts(pre.beta);
        for (const t of Object.keys(old)) if (t !== 'lore_ingest_sources') assert.equal(after[t], old[t], `row count for ${t}`);
        // a different workspace's bundle is still refused without the flag
        assert.equal(await restoreLogicalBundleCli(oldBetaBundle, 'rk-beta', 'rk-restore', { force: true }, deps), false);
    });
} finally {
    await closeSharedPostgresPool().catch(() => undefined);
    for (const p of pools) await closePostgresPool(p).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
