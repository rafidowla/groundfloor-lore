/**
 * test/pg-workspace-erase-unit.ts - the Postgres WorkspaceEraser (lane f6a): erase ONE workspace, prove NEIGHBOURS untouched.
 *
 * Needs a throwaway Postgres with pgvector (`LORE_PG_URL`); unset -> prints the reason, exits 0. Builds its own
 * database (`lore_f6a_<pid>`), seeds a TARGET and several look-alike NEIGHBOURS through the real write paths
 * (PostgresGraph, PostgresTableStorage, PostgresIngestionStore, link opt-outs; verbatim and the rollback copy by SQL),
 * erases the target and compares the neighbours row-for-row (per-table md5) and through the logical-backup export.
 *
 * The production switch POSTGRES_ROWS_KEYED_BY says rows are keyed by the PERMANENT ID (3.37), so the default eraser
 * deletes for real; the old count-only mode is still exercised with `rowsKeyedBy: 'workspace-name'`. The stores here are
 * constructed directly with id-style strings, which is exactly how production keys them.
 *
 * Run: npx tsx test/pg-workspace-erase-unit.ts
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
import { edgeTableDdl } from '../packages/lore/src/engines/postgres/postgresEdgeSchema.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { discoverWorkspaceSchema } from '../packages/lore/src/engines/postgres/postgresBackupDiscovery.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import {
    createPostgresWorkspaceEraser, GLOBAL_POSTGRES_TABLES, POSTGRES_ROWS_KEYED_BY,
} from '../packages/lore/src/engines/postgres/postgresWorkspaceErase.js';
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
    console.log('SKIP pg-workspace-erase-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}
const DB = `lore_f6a_${process.pid}`;
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
const DIM = 8;

// Permanent-id style keys. The neighbours are deliberately confusable with the target.
const TARGET = '3f2a9c10-1111-4aaa-8bbb-000000000001';
const NEIGHBOURS = {
    prefix: '3f2a9c10-1111-4aaa-8bbb-00000000000',        // a prefix of the target id
    upper: TARGET.toUpperCase(),                           // same id, different case
    like: '3f2a9c10-1111-4aaa-8bbb-00000000000%',          // LIKE wildcard
    under: '3f2a9c10-1111-4aaa-8bbb-00000000000_',         // LIKE single-char wildcard
    suffix: `${TARGET}-x`,                                 // the target id plus a suffix
} as const;
const NEIGHBOUR_IDS = Object.values(NEIGHBOURS);
const targetOf = (id: string, name = 'acme'): EraseTarget => ({ id, name, path: '/nonexistent', mode: 'cloud', orgId: null });

const vec = (seed: number): string => `[${Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7.13 + i) * 1e-3 + (seed % 5) / 3).join(',')}]`;
const sha = (c: string): string => c.repeat(64);
const T0 = new Date('2026-01-01T00:00:00Z');

async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

/** Seed one workspace (same content for every workspace, so a wrong delete would be visible). */
async function seed(ws: string, n: number): Promise<void> {
    const g = new PostgresGraph(ws, pool);
    await g.initialize();
    for (let i = 0; i < n; i++) {
        await g.upsertNode({ id: `n${i}`, type: 'note', label: `label ${i}`, content: `content ${i}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
        await g.upsertNode({ id: `n${i}`, type: 'note', label: `label ${i} v2`, content: `content ${i} edited`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
        if (i > 0) await g.addEdge({ sourceId: `n${i - 1}`, targetId: `n${i}`, relation: 'next' } as never);
    }
    await setLinkOptOuts(pool, ws, ['n0', 'n1'], true);
    await g.close();

    const c = await pool.connect();
    try { await ensureVerbatimSchema(c, ws, DIM); } finally { c.release(); }
    for (let i = 0; i < n; i++) {
        await pool.query(`INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at, tags) VALUES ($1,$2,$3,$4::vector,'2026-01-01','2026-01-01',NULL)`,
            [ws, `v${i}`, `verbatim text ${i} fox`, vec(i + 1)]);
    }

    const t = await PostgresTableStorage.open(ws, pool);
    await t.createTable({
        name: 'deals',
        columns: [
            { name: 'id', type: 'string', primary: true },
            { name: 'amount', type: 'integer', indexed: true },
            { name: 'code', type: 'string', unique: true },
        ],
    } as never);
    await t.insertBatch('deals', Array.from({ length: n }, (_, i) => ({ id: `d${i}`, amount: i * 10, code: `c${i}` })));

    const ing = await PostgresIngestionStore.open(ws, pool);
    const s = await ing.upsertSource({ workspace: ws, fileName: 'f.txt', mimeType: 'text/plain', sha256: sha('a'), sizeBytes: 3, storageRef: 'ref-shared-content' });
    for (let i = 0; i < n; i++) {
        const { job } = await ing.createJob({ workspace: ws, sourceId: s.sourceId, stage: 'extract', processorId: 'p', contractVersion: CONTRACT_A_VERSION, maxAttempts: 3, params: { i } } as never, T0);
        await ing.recordDelivery(job.jobId, `del-${i}`, T0);
        if (i === 0) await ing.recordPending({ jobId: job.jobId, workspace: ws, sourceId: s.sourceId, reason: 'no table', payload: { x: 1 } }, T0);
    }
    // Rollback/scaffolding copy the logical backup skips on purpose: the eraser must still clear it.
    await pool.query(`INSERT INTO edges_next (workspace_id, src_sk, dst_sk, relation) VALUES ($1, 1, 2, 'copy')`, [ws]);
}

/** Every workspace-scoped table: per-table count and md5 of the rows for `ws`. */
async function fingerprint(ws: string): Promise<Record<string, string>> {
    const c = await pool.connect();
    try {
        const inv = await c.query<{ relname: string }>(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`);
        const out: Record<string, string> = {};
        for (const { relname } of inv.rows) {
            const r = await c.query<{ n: string; h: string }>(
                `SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '-') AS h FROM "${relname}" t WHERE workspace_id = $1`, [ws]);
            out[relname] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
        }
        const views = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_class WHERE relkind='v' AND relname LIKE 'lore\\_tv\\_%' AND position($1 in pg_get_viewdef(oid)) > 0`, [`workspace_id = '${ws.replace(/'/g, "''")}'`]);
        out['@views'] = views.rows[0]!.n;
        const parts = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE pg_get_expr(c.relpartbound, c.oid) = $1`, [`FOR VALUES IN ('${ws.replace(/'/g, "''")}')`]);
        out['@partitions'] = parts.rows[0]!.n;
        const idx = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_class i WHERE i.relkind='i' AND i.relname ~ '^lore_ev_[0-9]+_[ui]$'
               AND substring(i.relname from '^lore_ev_([0-9]+)_') IN (SELECT field_id::text FROM lore_field_def WHERE workspace_id = $1)`, [ws]);
        out['@field_indexes'] = idx.rows[0]!.n;
        return out;
    } finally { c.release(); }
}
const totalRows = (f: Record<string, string>): number => Object.entries(f).filter(([k]) => !k.startsWith('@')).reduce((a, [, v]) => a + Number(v.split(':')[0]), 0);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgerase-'));
async function bundleCounts(ws: string): Promise<string> {
    const s = await exportWorkspaceBundle(pool, { workspaceId: ws, outDir: bundleDir });
    return JSON.stringify(s.tables.map((x) => [x.name, x.rowCount]).sort());
}
const eraser = (extra: Record<string, unknown> = {}) => createPostgresWorkspaceEraser({ pool, rowsKeyedBy: 'permanent-id', vacuum: true, ...extra });

try {
    // Schema (graph + table + ingestion + opt-out are created by the stores; the rollback copy by hand).
    const boot = new PostgresGraph('boot', pool); await boot.initialize(); await boot.close();
    await PostgresTableStorage.open('boot', pool);
    await PostgresIngestionStore.open('boot', pool);
    await pool.query(edgeTableDdl('edges_next'));

    await test('production switch: rows are keyed by the permanent id, so the destructive path is on', async () => {
        assert.equal(POSTGRES_ROWS_KEYED_BY, 'permanent-id');
    });

    await test('completeness guard: every table is workspace-scoped (erased) or on the documented global list', async () => {
        const c = await pool.connect();
        try {
            const found = await discoverWorkspaceSchema(c, undefined);
            const scoped = new Set(found.tables.map((t) => t.name));
            const all = (await c.query<{ relname: string; has: boolean }>(
                `SELECT c.relname, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.attnum>0 AND NOT a.attisdropped) AS has
                   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') ORDER BY 1`)).rows;
            const orphans = all.filter((r) => !r.has && !(r.relname in GLOBAL_POSTGRES_TABLES) && !scoped.has(r.relname)).map((r) => r.relname);
            assert.deepEqual(orphans, [], `table(s) with no workspace_id and not on GLOBAL_POSTGRES_TABLES (add an eraser rule or a documented reason): ${orphans.join(', ')}`);
            // And the live eraser sees the same: an absent id on a fully initialised store is a clean no-op, no caveats.
            const r = await eraser().erase(targetOf('00000000-0000-4000-8000-00000000dead'));
            assert.equal(r.status, 'not-applicable', JSON.stringify(r));
            assert.equal(r.detail, undefined);
        } finally { c.release(); }
    });

    await test('completeness guard (source scan): every literal CREATE TABLE under engines/postgres/ exists in a fully initialised store or is known scaffolding', async () => {
        const dir = path.resolve('packages/lore/src/engines/postgres');
        const names = new Set<string>();
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.ts') || f === 'postgresWorkspaceErase.ts') continue;
            const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
            for (const m of code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) if (m[1]!.toLowerCase() !== 'if') names.add(m[1]!.toLowerCase()); // 'if' = `IF NOT EXISTS ${templated}`: covered by the live-catalog guard above
        }
        // Created lazily by a migration, a rebuild or a test fixture, and not part of a fresh store. Each is either
        // workspace-scoped (the eraser finds it by catalog discovery) or on GLOBAL_POSTGRES_TABLES.
        const r = await pool.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relkind IN ('r','p') AND relnamespace = 'public'::regnamespace`);
        {
            const live = new Set(r.rows.map((x) => x.relname));
            const lazy = new Set(['edges_pre_pk', 'edges_dangling', 'edges_pk_progress', 'verbatim_pre_partition', 'verbatim_changes_log', 'verbatim_partition_progress']);
            const unknown = [...names].filter((n) => !live.has(n) && !lazy.has(n) && !n.startsWith('verbatim_ws_'));
            assert.deepEqual(unknown, [], `new CREATE TABLE not in a fresh store and not acknowledged here - decide how f6a erases it: ${unknown.join(', ')}`);
        }
    });

    await test('a table with a workspace-like column under another name makes the result unverifiable (never a silent complete)', async () => {
        await pool.query(`CREATE TABLE zz_future (tenant_id TEXT, v TEXT)`);
        try {
            const r = await eraser().erase(targetOf('00000000-0000-4000-8000-00000000dead'));
            assert.equal(r.status, 'unverifiable', JSON.stringify(r));
            assert.match(r.detail ?? '', /zz_future/);
        } finally { await pool.query(`DROP TABLE zz_future`); }
    });

    await test('a new table that has workspace_id is erased without any code change (catalog discovery)', async () => {
        await pool.query(`CREATE TABLE zz_newer (workspace_id TEXT NOT NULL, v TEXT)`);
        try {
            await pool.query(`INSERT INTO zz_newer VALUES ($1,'mine'),($2,'theirs')`, [TARGET, NEIGHBOURS.prefix]);
            const r = await eraser().erase(targetOf(TARGET));
            assert.equal(r.removed['zz_newer'], 1, JSON.stringify(r));
            assert.equal(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM zz_newer WHERE workspace_id=$1`, [NEIGHBOURS.prefix]))[0]!.n), 1);
        } finally { await pool.query(`DROP TABLE zz_newer`); }
    });

    // ---- the main scenario -------------------------------------------------------------------------------------
    await seed(TARGET, 12);
    for (const ws of NEIGHBOUR_IDS) await seed(ws, 12);
    const before: Record<string, Record<string, string>> = {};
    for (const ws of NEIGHBOUR_IDS) before[ws] = await fingerprint(ws);
    const bundlesBefore: Record<string, string> = {};
    for (const ws of NEIGHBOUR_IDS) bundlesBefore[ws] = await bundleCounts(ws);
    const targetBefore = await fingerprint(TARGET);

    await test('seed covers every kind of data (the target has rows in every store, views, indexes and a partition)', async () => {
        assert.ok(totalRows(targetBefore) > 100, JSON.stringify(targetBefore));
        for (const t of ['nodes', 'edges', 'verbatim', 'link_optout', 'lore_entity_type', 'lore_field_def', 'lore_entity', 'lore_entity_value', 'lore_ingest_sources', 'lore_ingest_jobs', 'lore_ingest_deliveries', 'lore_ingest_pending', 'edges_next']) {
            assert.ok(Number(targetBefore[t]?.split(':')[0]) > 0, `seed missed ${t}: ${JSON.stringify(targetBefore)}`);
        }
        assert.equal(targetBefore['@views'], '1');
        assert.equal(targetBefore['@partitions'], '1');
        assert.ok(Number(targetBefore['@field_indexes']) >= 2);
    });

    await test('view bodies carry the workspace literal in the exact form the eraser looks for', async () => {
        const v = await q<{ def: string }>(`SELECT pg_get_viewdef(c.oid) AS def FROM pg_class c WHERE c.relkind='v' AND c.relname LIKE 'lore\\_tv\\_%'`);
        assert.ok(v.some((x) => x.def.includes(`workspace_id = '${TARGET}'`)), v.map((x) => x.def.slice(0, 200)).join('\n'));
    });

    await test('count-only mode (rowsKeyedBy workspace-name) deletes NOTHING and says so', async () => {
        for (const e of [createPostgresWorkspaceEraser({ pool, rowsKeyedBy: 'workspace-name' })]) {
            const r = await e.erase(targetOf(TARGET, TARGET));
            assert.equal(r.status, 'unverifiable', JSON.stringify(r));
            assert.deepEqual(r.removed, {});
            assert.match(r.detail ?? '', /NOTHING WAS DELETED/);
            const none = await e.erase(targetOf('00000000-0000-4000-8000-00000000dead', 'ghost'));
            assert.equal(none.status, 'not-applicable');
        }
        assert.deepEqual(await fingerprint(TARGET), targetBefore, 'count-only eraser must not change a byte');
    });

    await test('abort mid-way -> partial with an honest remaining count, neighbours untouched; resumed run completes', async () => {
        let calls = 0;
        const signal = { get aborted() { return ++calls > 6; } } as unknown as AbortSignal;
        const r1 = await eraser({ batchRows: 3 }).erase(targetOf(TARGET), { signal });
        assert.equal(r1.status, 'partial', JSON.stringify(r1));
        assert.ok(Object.values(r1.remaining).some((n) => n > 0));
        assert.match(r1.detail ?? '', /aborted/);
        for (const ws of NEIGHBOUR_IDS) assert.deepEqual(await fingerprint(ws), before[ws], `neighbour ${ws} changed during a partial erase`);
        const r2 = await eraser({ batchRows: 3 }).erase(targetOf(TARGET));
        assert.equal(r2.status, 'complete', JSON.stringify(r2));
        assert.ok(Object.values(r2.remaining).every((n) => n === 0), JSON.stringify(r2.remaining));
    });

    await test('target is fully gone: no rows in any table, no view, no field index, no partition', async () => {
        const f = await fingerprint(TARGET);
        assert.equal(totalRows(f), 0, JSON.stringify(f));
        assert.equal(f['@views'], '0'); assert.equal(f['@partitions'], '0'); assert.equal(f['@field_indexes'], '0');
        const left = await q<{ relname: string }>(`SELECT relname FROM pg_class WHERE relname LIKE 'lore\\_tv\\_%' AND relkind='v' AND position($1 in pg_get_viewdef(oid)) > 0`, [`'${TARGET}'`]);
        assert.equal(left.length, 0);
    });

    await test('NEIGHBOURS (prefix / case / LIKE wildcards / suffix) are byte-identical row-for-row and in the logical-backup export', async () => {
        for (const ws of NEIGHBOUR_IDS) {
            assert.deepEqual(await fingerprint(ws), before[ws], `neighbour ${ws} changed`);
            assert.equal(await bundleCounts(ws), bundlesBefore[ws], `neighbour ${ws} export changed`);
        }
        // Their typed views, partitions and indexes are all still there.
        for (const ws of NEIGHBOUR_IDS) {
            const f = await fingerprint(ws);
            assert.equal(f['@views'], '1'); assert.equal(f['@partitions'], '1'); assert.ok(Number(f['@field_indexes']) >= 2);
        }
    });

    await test('second run is a clean no-op (idempotent); a full run on a fresh erase reported what it removed', async () => {
        const again = await eraser().erase(targetOf(TARGET));
        assert.equal(again.status, 'not-applicable', JSON.stringify(again));
        assert.ok(Object.values(again.remaining).every((n) => n === 0));
        for (const ws of NEIGHBOUR_IDS) assert.deepEqual(await fingerprint(ws), before[ws]);
    });

    await test('single-pass erase of a seeded workspace reports counts that match what was there, and VACUUM ran', async () => {
        const ws = '9d1c0b22-2222-4ccc-8ddd-000000000002';
        await seed(ws, 7);
        const pre = await fingerprint(ws);
        const r = await eraser({ batchRows: 2 }).erase(targetOf(ws));
        assert.equal(r.status, 'complete', JSON.stringify(r));
        for (const [t, v] of Object.entries(pre)) {
            if (t.startsWith('@') || t === 'verbatim') continue;
            const n = Number(v.split(':')[0]);
            if (n > 0) assert.equal(r.removed[t], n, `removed.${t}: ${JSON.stringify(r.removed)}`);
        }
        assert.equal(r.removed['verbatim'], 7); assert.equal(r.removed['partitions'], 1); assert.equal(r.removed['views'], 1);
        assert.doesNotMatch(r.detail ?? '', /VACUUM could not run/);
        for (const nb of NEIGHBOUR_IDS) assert.deepEqual(await fingerprint(nb), before[nb]);
    });

    await test('erasing a NEIGHBOUR id removes only that neighbour (the id is compared whole, never as a prefix or pattern)', async () => {
        const r = await eraser().erase(targetOf(NEIGHBOURS.like));
        assert.equal(r.status, 'complete', JSON.stringify(r));
        assert.equal(totalRows(await fingerprint(NEIGHBOURS.like)), 0);
        for (const ws of NEIGHBOUR_IDS.filter((x) => x !== NEIGHBOURS.like)) assert.deepEqual(await fingerprint(ws), before[ws], `collateral damage to ${ws}`);
    });

    await test('views left by an interrupted erase (type rows already gone) are still found and dropped', async () => {
        const ws = '5e5e5e5e-3333-4eee-8fff-000000000003';
        await seed(ws, 3);
        const t = await q<{ entity_type_id: string }>(`SELECT entity_type_id::text FROM lore_entity_type WHERE workspace_id=$1`, [ws]);
        await pool.query(`DELETE FROM lore_entity_value WHERE workspace_id=$1`, [ws]);
        await pool.query(`DELETE FROM lore_entity WHERE workspace_id=$1`, [ws]);
        await pool.query(`DELETE FROM lore_field_def WHERE workspace_id=$1`, [ws]);
        await pool.query(`DELETE FROM lore_entity_type WHERE workspace_id=$1`, [ws]);
        assert.ok(t.length === 1);
        const r = await eraser().erase(targetOf(ws));
        assert.equal(r.status, 'complete', JSON.stringify(r));
        assert.equal(r.removed['views'], 1, JSON.stringify(r));
    });

    await test('the edge-migration cursor naming the target is reported (partial), never edited', async () => {
        await pool.query(`CREATE TABLE edges_pk_progress (id INTEGER PRIMARY KEY CHECK (id = 1), ws TEXT, src TEXT, dst TEXT, rel TEXT)`);
        try {
            await pool.query(`INSERT INTO edges_pk_progress (id, ws) VALUES (1, $1)`, [TARGET]);
            const r = await eraser().erase(targetOf(TARGET));
            assert.equal(r.status, 'partial', JSON.stringify(r));
            assert.equal(r.remaining['edges_pk_progress'], 1);
            assert.equal(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM edges_pk_progress WHERE ws=$1`, [TARGET]))[0]!.n), 1);
        } finally { await pool.query(`DROP TABLE edges_pk_progress`); }
    });

    await test('an empty target id is refused (never a wildcard)', async () => {
        await assert.rejects(eraser().erase(targetOf('')), /target\.id/);
        await assert.rejects(eraser().erase(targetOf('   ')), /target\.id/);
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    fs.rmSync(bundleDir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
