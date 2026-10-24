#!/usr/bin/env tsx
/**
 * test/postgres-rollback-copies-unit.ts - `lore postgres rollback-copies`: list / verify / drop the rollback
 * copies left by the verbatim partitioning migration (verbatim_pre_partition) and the edge layout 2 migration
 * (edges_pre_pk). Engine functions are called directly; exit codes and --json are checked by spawning the REAL CLI.
 *
 *   list         read-only report: rows, size, verification against the live table; nothing created or changed
 *   verify       passes right after a migration; tolerates live inserts and later endpoint removal; fails on lost rows
 *   drop         needs --yes (exit 2, nothing dropped); refuses on failed verification (exit 3); --force overrides;
 *                all-or-nothing across `all`; the shared verbatim_row_seq survives the drop
 *   allowlist    edges_dangling (and any other name) is never dropped, at the CLI or the engine
 *   no-postgres  no LORE_PG_URL -> explanation, exit 0, JSON status not_postgres
 *
 * Throwaway database lore_rbc_<pid> on the LORE_PG_URL server (skips cleanly with a printed reason when unset).
 * Run: LORE_PG_URL=postgres://... npx tsx test/postgres-rollback-copies-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { migrateVerbatimToPartitioned } from '../packages/lore/src/engines/postgres/postgresVerbatimPartitionMigration.js';
import {
    inspectRollbackCopies, dropRollbackCopies, ROLLBACK_COPY_NAMES, type RollbackCopyName,
} from '../packages/lore/src/engines/postgres/postgresRollbackCopies.js';
import { legacyEdge, makeLegacyEdgesTable } from './helpers/legacyEdges.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const raw = process.env['LORE_PG_URL'];
if (!raw || raw.trim() === '') {
    console.log('  SKIP postgres-rollback-copies: LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');

const DIM = 4;
const DB = `lore_rbc_${process.pid}`;
const withDb = (name: string): string => { const u = new URL(raw); u.pathname = `/${name}`; return u.toString(); };
const admin = new Client({ connectionString: withDb('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
const dbUrl = withDb(DB);
const pool: Pool = createPostgresPool({ url: dbUrl, max: 4 });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-home-'));

const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool.query(sql, params)).rows as T[];
const num = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(sql, params))[0]!.n);
const exists = async (t: string): Promise<boolean> => (await q<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [t]))[0]!.t != null;
const vec = (...x: number[]): string => `[${x.join(',')}]`;

/** Run the real CLI against the throwaway database. */
function cli(args: string[], env: Record<string, string | undefined> = { LORE_PG_URL: dbUrl }): { code: number | null; out: string; err: string } {
    const e: Record<string, string | undefined> = { ...process.env, LORE_HOME: home, LORE_PG_URL: undefined, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const r = spawnSync(tsxBin, [cliEntry, 'postgres', 'rollback-copies', ...args], { env: e as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const withClient = async <T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try { return await fn(c); } finally { c.release(); }
};

// ---------------------------------------------------------------- fixtures
const LEGACY_VERBATIM_DDL = [
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `CREATE TABLE verbatim (
        row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
        vector vector(${DIM}), content_hash TEXT, type TEXT, label TEXT, tags TEXT, project TEXT, ecosystem TEXT, "updatedAt" TEXT,
        security_scopes TEXT, is_canonical INTEGER NOT NULL DEFAULT 1, is_tombstone INTEGER NOT NULL DEFAULT 0, superseded_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, text_tsv tsvector NOT NULL DEFAULT ''::tsvector)`,
    `CREATE UNIQUE INDEX verbatim_canonical_id_uq ON verbatim(workspace_id, id) WHERE is_canonical = 1`,
    `CREATE INDEX verbatim_id_idx ON verbatim(workspace_id, id)`,
    `CREATE INDEX verbatim_content_hash_idx ON verbatim(workspace_id, content_hash)`,
    `CREATE INDEX verbatim_project_idx ON verbatim(workspace_id, project)`,
    `CREATE INDEX verbatim_text_tsv_gin ON verbatim USING gin(text_tsv)`,
    `CREATE INDEX verbatim_vector_hnsw ON verbatim USING hnsw(vector vector_cosine_ops)`,
    `CREATE OR REPLACE FUNCTION verbatim_text_tsv_apply() RETURNS trigger AS $$ BEGIN NEW.text_tsv := to_tsvector('simple', NEW.text); RETURN NEW; END; $$ LANGUAGE plpgsql`,
    `CREATE TRIGGER verbatim_text_tsv_biur BEFORE INSERT OR UPDATE ON verbatim FOR EACH ROW EXECUTE FUNCTION verbatim_text_tsv_apply()`,
    `CREATE TABLE verbatim_changes_log (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, row_rowid BIGINT NOT NULL, row_id TEXT NOT NULL,
        is_canonical INTEGER NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert','delete')), at TEXT NOT NULL)`,
];
const VWS = ['rb-alpha', 'rb-beta'];
const VROWS = 12;

async function insVerbatim(ws: string, id: string, text: string, v: string): Promise<void> {
    await pool.query(
        `INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at) VALUES ($1,$2,$3,$4::vector,'2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')`,
        [ws, id, text, v]);
}
/** Legacy single verbatim table -> partitioned, leaving verbatim_pre_partition behind. */
async function verbatimWithCopy(): Promise<void> {
    await q(`DROP TABLE IF EXISTS verbatim, verbatim_next, verbatim_pre_partition, verbatim_partition_progress, verbatim_changes_log CASCADE`);
    await q(`DROP SEQUENCE IF EXISTS verbatim_row_seq`);
    for (const s of LEGACY_VERBATIM_DDL) await q(s);
    for (const ws of VWS) for (let i = 0; i < VROWS; i++) await insVerbatim(ws, `${ws}-${i}`, `doc ${i} of ${ws}`, vec(Math.cos(i), Math.sin(i), 0.3, 0.1));
    assert.equal(await withClient((c) => migrateVerbatimToPartitioned(c, DIM, { batchSize: 10 })), 'migrated');
    assert.ok(await exists('verbatim_pre_partition'));
}

const N = 20;
const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(2, '0')}`);
const EWS = 'pg-rbc-edges';
const LEGACY_EDGES = (N - 1) + 2; // chain + 2 dangling
/** Legacy text-keyed edges (with two dangling) -> layout 2 through the real bootstrap, leaving edges_pre_pk behind. */
async function edgesWithCopy(): Promise<void> {
    await q('DROP TABLE IF EXISTS edges, edges_next, edges_pre_pk, edges_dangling, edges_pk_progress CASCADE');
    const g0 = new PostgresGraph(EWS, pool); await g0.initialize(); await g0.close(); // creates nodes + layout-2 edges
    await q('DELETE FROM nodes');
    await q(`INSERT INTO nodes (workspace_id, id, type, label, content) SELECT $1, i, 'note', i, 'c ' || i FROM unnest($2::text[]) AS i`, [EWS, ids]);
    await makeLegacyEdgesTable(pool);
    for (let i = 0; i < N - 1; i++) await legacyEdge(pool, EWS, ids[i]!, ids[i + 1]!, 'depends_on');
    await legacyEdge(pool, EWS, ids[2]!, 'ghost-target', 'depends_on');
    await legacyEdge(pool, EWS, 'ghost-source', ids[3]!, 'depends_on');
    const g = new PostgresGraph(EWS, pool); await g.initialize(); await g.close(); // the bootstrap migrates
    assert.ok(await exists('edges_pre_pk'));
}

const byName = (i: Awaited<ReturnType<typeof inspectRollbackCopies>>, n: RollbackCopyName) => i.copies.find((c) => c.name === n)!;
const inspect = () => withClient((c) => inspectRollbackCopies(c));

try {
    console.log('\npostgres rollback copies');

    // ------------------------------------------------------------ absent
    await test('fresh database: nothing present, nothing to drop; quarantine table absent', async () => {
        const i = await inspect();
        assert.deepEqual(i.copies.map((c) => [c.name, c.exists, c.verified]), [['verbatim_pre_partition', false, false], ['edges_pre_pk', false, false]]);
        assert.equal(i.quarantine.exists, false);
        const out = await withClient((c) => dropRollbackCopies(c, ['verbatim_pre_partition', 'edges_pre_pk']));
        assert.deepEqual(out.map((o) => [o.dropped, o.skipped]), [[false, 'absent'], [false, 'absent']]);
    });

    // ------------------------------------------------------------ verbatim
    await verbatimWithCopy();
    await test('verbatim: list reports rows, size and a PASSED verification right after the migration; changes nothing', async () => {
        const before = await q(`SELECT relname FROM pg_class WHERE relkind IN ('r','p') AND relnamespace = current_schema()::regnamespace ORDER BY 1`);
        const r = byName(await inspect(), 'verbatim_pre_partition');
        assert.equal(r.exists, true);
        assert.equal(r.rows, VWS.length * VROWS);
        assert.ok(r.bytes > 0);
        assert.equal(r.liveRows, VWS.length * VROWS);
        assert.equal(r.verified, true, JSON.stringify(r.checks));
        assert.deepEqual(r.sampleMissing, []);
        assert.deepEqual(await q(`SELECT relname FROM pg_class WHERE relkind IN ('r','p') AND relnamespace = current_schema()::regnamespace ORDER BY 1`), before);
    });
    await test('verbatim: rows inserted live after the migration do not break verification', async () => {
        await insVerbatim('rb-alpha', 'post-migration', 'written after the swap', vec(1, 1, 1, 1));
        const r = byName(await inspect(), 'verbatim_pre_partition');
        assert.equal(r.verified, true);
        assert.equal(r.liveRows, r.rows + 1);
    });
    await test('CLI: listing exits 0 and --json puts only JSON on stdout', () => {
        const human = cli([]);
        assert.equal(human.code, 0, human.err);
        assert.match(human.out, /verbatim_pre_partition/);
        assert.match(human.out, /verification: PASSED/);
        assert.ok(!human.out.includes(new URL(dbUrl).password || '\u0000'), 'the URL password must never print');
        const j = cli(['--json']);
        assert.equal(j.code, 0, j.err);
        const doc = JSON.parse(j.out) as { status: string; exitCode: number; copies: Array<{ name: string; verified: boolean }> };
        assert.equal(doc.status, 'listed');
        assert.equal(doc.exitCode, 0);
        assert.equal(doc.copies.find((c) => c.name === 'verbatim_pre_partition')?.verified, true);
    });
    await test('CLI: --drop without --yes prints what would be dropped, exits 2 and drops nothing', () => {
        const r = cli(['--drop', 'verbatim_pre_partition']);
        assert.equal(r.code, 2, r.err);
        assert.match(r.out, /Would drop: verbatim_pre_partition/);
    });
    await test('...and the table is still there', async () => { assert.ok(await exists('verbatim_pre_partition')); });
    await test('a row lost from the live table fails verification with a sample; CLI --drop --yes then exits 3 and drops nothing', async () => {
        await q(`DELETE FROM verbatim WHERE workspace_id = 'rb-beta' AND id = 'rb-beta-3'`);
        const r = byName(await inspect(), 'verbatim_pre_partition');
        assert.equal(r.verified, false);
        assert.deepEqual(r.sampleMissing, ['rb-beta/rb-beta-3']);
        const c = cli(['--drop', 'verbatim_pre_partition', '--yes']);
        assert.equal(c.code, 3, c.err);
        assert.match(c.out, /REFUSED/);
        assert.ok(await exists('verbatim_pre_partition'));
    });
    await test('engine: dropRollbackCopies without force reports unverified and keeps the table', async () => {
        const out = await withClient((c) => dropRollbackCopies(c, ['verbatim_pre_partition']));
        assert.deepEqual(out.map((o) => [o.dropped, o.skipped]), [[false, 'unverified']]);
        assert.ok(await exists('verbatim_pre_partition'));
    });
    await test('CLI: --force without --yes still only previews (exit 2), with a warning', () => {
        const r = cli(['--drop', 'verbatim_pre_partition', '--force']);
        assert.equal(r.code, 2, r.err);
        assert.match(r.out, /WARNING: verification FAILED/);
        assert.match(r.out, /Nothing was dropped/);
    });
    await test('CLI: --force --yes drops it despite the failed verification, with a loud warning; the shared sequence survives', async () => {
        const r = cli(['--drop', 'verbatim_pre_partition', '--yes', '--force']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /WARNING: --force/);
        assert.match(r.out, /dropped verbatim_pre_partition \(forced/);
        assert.equal(await exists('verbatim_pre_partition'), false);
        assert.ok(await exists('verbatim_row_seq'), 'verbatim_row_seq is free-standing and must outlive the copy');
        await insVerbatim('rb-alpha', 'after-drop', 'row_id still comes from the sequence', vec(0, 1, 0, 1));
        assert.ok((await num(`SELECT max(row_id) AS n FROM verbatim`)) > 0);
        assert.equal(await num(`SELECT count(*) AS n FROM verbatim WHERE id = 'after-drop'`), 1);
    });

    // ------------------------------------------------------------ edges
    await edgesWithCopy();
    await test('edges: verification accounts for every copy edge (live + quarantined) and passes; edges_dangling is reported', async () => {
        const i = await inspect();
        const r = byName(i, 'edges_pre_pk');
        assert.equal(r.rows, LEGACY_EDGES);
        assert.equal(r.verified, true, JSON.stringify(r.checks));
        assert.match(r.checks.find((c) => c.name === 'edges_accounted')!.detail, /19 in live edges \+ 2 quarantined/);
        assert.deepEqual(i.quarantine, { exists: true, rows: 2 });
    });
    await test('edges: an endpoint removed since the migration is accounted for, not reported as loss', async () => {
        await q(`DELETE FROM edges WHERE src_sk = (SELECT sk FROM nodes WHERE workspace_id = $1 AND id = $2) OR dst_sk = (SELECT sk FROM nodes WHERE workspace_id = $1 AND id = $2)`, [EWS, ids[10]]);
        await q(`DELETE FROM nodes WHERE workspace_id = $1 AND id = $2`, [EWS, ids[10]]);
        const r = byName(await inspect(), 'edges_pre_pk');
        assert.equal(r.verified, true, JSON.stringify(r.checks));
        assert.match(r.checks.find((c) => c.name === 'edges_accounted')!.detail, /2 whose endpoint was removed since/);
    });
    await test('edges: an edge lost from the live table while both endpoints remain fails verification, with a sample', async () => {
        await q(`DELETE FROM edges WHERE src_sk = (SELECT sk FROM nodes WHERE workspace_id = $1 AND id = $2)`, [EWS, ids[5]]);
        const r = byName(await inspect(), 'edges_pre_pk');
        assert.equal(r.verified, false);
        assert.deepEqual(r.sampleMissing, [`${EWS}/${ids[5]}->${ids[6]} (depends_on)`]);
    });
    await test('allowlist: edges_dangling and any other name is refused by the CLI and by the engine; nothing changes', async () => {
        for (const name of ['edges_dangling', 'edges', 'nodes', 'verbatim', 'edges_pre_pk; DROP TABLE nodes']) {
            const r = cli(['--drop', name, '--yes', '--force']);
            assert.equal(r.code, 1, `${name}: ${r.err}`);
            assert.match(r.err, /is not a rollback copy/);
        }
        assert.ok(await exists('edges_dangling') && await exists('edges') && await exists('nodes') && await exists('edges_pre_pk'));
        await assert.rejects(withClient((c) => dropRollbackCopies(c, ['edges_dangling' as RollbackCopyName], { force: true })), /not a rollback copy/);
        assert.deepEqual([...ROLLBACK_COPY_NAMES], ['verbatim_pre_partition', 'edges_pre_pk']);
        assert.ok(await exists('edges_dangling'));
    });
    await test('CLI: --yes / --force without --drop is a usage error (exit 1)', () => {
        assert.equal(cli(['--yes']).code, 1);
        assert.equal(cli(['--force']).code, 1);
        assert.equal(cli(['--bogus']).code, 1);
    });

    // ------------------------------------------------------------ all
    await test('--drop all is all-or-nothing: one unverified copy keeps BOTH tables', async () => {
        await verbatimWithCopy();
        assert.equal(byName(await inspect(), 'verbatim_pre_partition').verified, true);
        assert.equal(byName(await inspect(), 'edges_pre_pk').verified, false, 'edges copy is still unverified from the previous case');
        const r = cli(['--drop', 'all', '--yes']);
        assert.equal(r.code, 3, r.err);
        assert.ok(await exists('verbatim_pre_partition') && await exists('edges_pre_pk'));
        const out = await withClient((c) => dropRollbackCopies(c, ['verbatim_pre_partition', 'edges_pre_pk']));
        assert.deepEqual(out.map((o) => o.skipped), ['unverified', 'unverified'], 'a verified copy is held back too when its sibling fails');
        assert.ok(await exists('verbatim_pre_partition') && await exists('edges_pre_pk'));
    });
    await test('--drop all --yes drops both verified copies, leaves edges_dangling and the live tables, and a rerun has nothing to do', async () => {
        await edgesWithCopy();
        const live = [await num(`SELECT count(*) AS n FROM edges`), await num(`SELECT count(*) AS n FROM verbatim`), await num(`SELECT count(*) AS n FROM edges_dangling`)];
        const r = cli(['--drop', 'all', '--yes', '--json']);
        assert.equal(r.code, 0, r.err);
        const doc = JSON.parse(r.out) as { status: string; outcomes: Array<{ name: string; dropped: boolean }> };
        assert.equal(doc.status, 'dropped');
        assert.deepEqual(doc.outcomes.map((o) => [o.name, o.dropped]), [['verbatim_pre_partition', true], ['edges_pre_pk', true]]);
        assert.equal(await exists('verbatim_pre_partition'), false);
        assert.equal(await exists('edges_pre_pk'), false);
        assert.ok(await exists('edges_dangling'));
        assert.deepEqual([await num(`SELECT count(*) AS n FROM edges`), await num(`SELECT count(*) AS n FROM verbatim`), await num(`SELECT count(*) AS n FROM edges_dangling`)], live);
        const again = cli(['--drop', 'all', '--yes']);
        assert.equal(again.code, 0, again.err);
        assert.match(again.out, /Nothing to drop/);
    });

    // ------------------------------------------------------------ no postgres
    await test('no LORE_PG_URL (SQLite / LanceDB setup): explains there is nothing to do, exit 0, JSON status not_postgres', () => {
        const t = cli([], { LORE_PG_URL: undefined });
        assert.equal(t.code, 0, t.err);
        assert.match(t.out, /Nothing to do: LORE_PG_URL is not set/);
        const j = cli(['--json'], { LORE_PG_URL: undefined });
        assert.equal(j.code, 0, j.err);
        assert.equal((JSON.parse(j.out) as { status: string }).status, 'not_postgres');
        const d = cli(['--drop', 'all', '--yes'], { LORE_PG_URL: undefined });
        assert.equal(d.code, 0, d.err);
    });
    await test('unreachable server: exit 1 with a redacted explanation, no stack trace', () => {
        const u = new URL(dbUrl); u.port = '1';
        const r = cli([], { LORE_PG_URL: u.toString() });
        assert.equal(r.code, 1);
        assert.match(r.err, /postgres engine/);
        assert.ok(!r.err.includes(new URL(dbUrl).password || '\u0000'));
    });
} finally {
    await closePostgresPool(pool);
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
