/**
 * postgres-edge-backup-unit.ts — integration of the edge surrogate-key lane
 * (edges.src_sk / dst_sk -> nodes.sk) with the logical backup/restore lane.
 *
 * Restoring into a database that already holds other rows shifts `nodes.sk`
 * (identity column). Every restored edge's src_sk/dst_sk must be shifted with
 * it (they reference nodes.sk through a `lore:references` column comment), and
 * soft-invalidated edges (valid_to set) must survive the round trip.
 *
 * Needs a throwaway Postgres (`LORE_PG_URL`); with it unset the file prints
 * the reason and exits 0. It creates and drops its own databases.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, Pool } from 'pg';

import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const url = process.env['LORE_PG_URL'];
if (!url || url.trim() === '') {
    console.log('SKIP postgres-edge-backup-unit: LORE_PG_URL is not set (needs a throwaway Postgres); exiting 0');
    process.exit(0);
}

const srcDb = `lore_ebk_src_${process.pid}`;
const dstDb = `lore_ebk_dst_${process.pid}`;
const withDb = (db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgebk-'));
const N = 12;
const DIM = 8;

async function open(db: string): Promise<Pool> {
    const pool = new Pool({ connectionString: withDb(db), max: 4 });
    const c = await pool.connect();
    try { await ensureGraphSchema(c, 'setup'); await ensureVerbatimSchema(c, 'setup', DIM); } finally { c.release(); }
    return pool;
}

async function seed(pool: Pool, ws: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        await pool.query(`INSERT INTO nodes (workspace_id, id, type, label, content, "createdAt") VALUES ($1,$2,'note',$3,'c','2026-01-01')`, [ws, `n${i}`, `label ${i}`]);
    }
    for (let i = 1; i < n; i++) {
        await pool.query(
            `INSERT INTO edges (workspace_id, relation, src_sk, dst_sk, origin, created_at)
             SELECT $1, 'next', s.sk, t.sk, 'test', now()
               FROM nodes s, nodes t WHERE s.workspace_id=$1 AND s.id=$2 AND t.workspace_id=$1 AND t.id=$3`,
            [ws, `n${i - 1}`, `n${i}`]);
    }
}

/** Edges whose sks do NOT resolve to the node with the matching id (must be zero). */
async function brokenEdges(pool: Pool, ws: string): Promise<number> {
    const r = await pool.query<{ c: string }>(
        `SELECT count(*) AS c FROM edges e
           LEFT JOIN nodes s ON s.sk = e.src_sk AND s.workspace_id = e.workspace_id
           LEFT JOIN nodes t ON t.sk = e.dst_sk AND t.workspace_id = e.workspace_id
          WHERE e.workspace_id = $1 AND (s.sk IS NULL OR t.sk IS NULL)`, [ws]);
    return Number(r.rows[0]!.c);
}

async function main(): Promise<void> {
    const admin = new Client({ connectionString: withDb('postgres') });
    await admin.connect();
    for (const d of [srcDb, dstDb]) { await admin.query(`DROP DATABASE IF EXISTS ${d}`); await admin.query(`CREATE DATABASE ${d}`); }
    const src = await open(srcDb);
    const dst = await open(dstDb);
    try {
        await seed(src, 'ws-a', N);
        { const c = await src.connect(); try { await ensureVerbatimSchema(c, 'ws-a', DIM); } finally { c.release(); } }
        for (let i = 0; i < 5; i++) {
            await src.query(`INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at) VALUES ('ws-a',$1,$2,$3::vector,'2026-01-01','2026-01-01')`,
                [`v${i}`, `text ${i}`, `[${Array.from({ length: DIM }, (_, k) => (i + k) / 10).join(',')}]`]);
        }
        // One soft-invalidated edge: backup must carry it (raw-table read, not the live-only API).
        await src.query(`UPDATE edges e SET valid_to = '2026-02-02T00:00:00Z' FROM nodes s, nodes t
            WHERE e.workspace_id='ws-a' AND s.sk=e.src_sk AND t.sk=e.dst_sk AND s.id='n3' AND t.id='n4'`);
        // Target already holds other workspaces' rows, so its sks overlap the source's and a shift is forced.
        await seed(dst, 'ws-other', N + 5);
        const dstMaxBefore = Number((await dst.query<{ m: string }>(`SELECT max(sk)::text AS m FROM nodes`)).rows[0]!.m);

        await test('schema declares nodes.sk references on edges.src_sk / dst_sk (comment, no FK)', async () => {
            const r = await src.query<{ col: string; c: string }>(
                `SELECT a.attname AS col, col_description(a.attrelid, a.attnum) AS c FROM pg_attribute a
                  WHERE a.attrelid = 'edges'::regclass AND a.attname IN ('src_sk','dst_sk') ORDER BY 1`);
            assert.deepEqual(r.rows.map((x) => [x.col, x.c]), [['dst_sk', 'lore:references nodes.sk'], ['src_sk', 'lore:references nodes.sk']]);
            const fk = await src.query(`SELECT 1 FROM pg_constraint WHERE conrelid='edges'::regclass AND contype='f'`);
            assert.equal(fk.rowCount, 0);
            // replay is a no-op
            const c = await src.connect();
            try { await ensureGraphSchema(c, 'setup'); } finally { c.release(); }
        });

        const out = path.join(tmp, 'out');
        let bundle = '';
        await test('export carries every edge, including the soft-invalidated one', async () => {
            const sum = await exportWorkspaceBundle(src, { workspaceId: 'ws-a', outDir: out });
            bundle = sum.bundlePath;
            const by = Object.fromEntries(sum.tables.map((t) => [t.name, t.rowCount]));
            assert.equal(by['nodes'], N);
            assert.equal(by['edges'], N - 1);
        });

        await test('restore into a non-empty database: sks shifted, every edge resolves to the matching node', async () => {
            const r = await restoreWorkspaceBundle(dst, { bundlePath: bundle, targetWorkspaceId: 'ws-restored' });
            const shifts = r.idRemaps.filter((m) => (m.table === 'nodes' && m.column === 'sk') || (m.table === 'edges' && ['src_sk', 'dst_sk'].includes(m.column)));
            assert.ok(shifts.some((m) => m.table === 'nodes' && m.column === 'sk'), 'nodes.sk must have been shifted: the target already uses those ids');
            assert.ok(shifts.some((m) => m.table === 'edges' && m.column === 'src_sk'), 'edges.src_sk must be shifted with nodes.sk');
            assert.ok(shifts.some((m) => m.table === 'edges' && m.column === 'dst_sk'), 'edges.dst_sk must be shifted with nodes.sk');
            const minNew = Number((await dst.query<{ m: string }>(`SELECT min(sk)::text AS m FROM nodes WHERE workspace_id='ws-restored'`)).rows[0]!.m);
            assert.ok(minNew > dstMaxBefore, `restored sks (${minNew}) must clear the target's existing ids (${dstMaxBefore})`);
            const cnt = Number((await dst.query<{ c: string }>(`SELECT count(*) AS c FROM edges WHERE workspace_id='ws-restored'`)).rows[0]!.c);
            assert.equal(cnt, N - 1);
            assert.equal(await brokenEdges(dst, 'ws-restored'), 0, 'restored edges must resolve to the nodes with the matching ids');
            assert.equal(await brokenEdges(dst, 'ws-other'), 0, 'pre-existing workspace untouched');
        });

        await test('verbatim.row_id (free-standing sequence) is advanced past restored ids in a fresh database', async () => {
            // The target never issued ids 1..5, so a restore that keeps the original row_ids must still move verbatim_row_seq.
            const mx = Number((await dst.query<{ m: string }>(`SELECT max(row_id)::text AS m FROM verbatim WHERE workspace_id='ws-restored'`)).rows[0]!.m);
            const nx = Number((await dst.query<{ n: string }>(`SELECT nextval('verbatim_row_seq')::text AS n`)).rows[0]!.n);
            assert.ok(nx > mx, `nextval ${nx} must exceed restored max row_id ${mx}`);
        });

        await test('provenance and soft-invalidation survive the round trip', async () => {
            const q = `SELECT s.id AS source_id, t.id AS target_id, e.origin, e.valid_to IS NOT NULL AS inv FROM edges e
                JOIN nodes s ON s.sk = e.src_sk JOIN nodes t ON t.sk = e.dst_sk WHERE e.workspace_id=$1 ORDER BY 1, 2`;
            const a = (await src.query(q, ['ws-a'])).rows;
            const b = (await dst.query(q, ['ws-restored'])).rows;
            assert.deepEqual(b, a);
            assert.equal(b.filter((x) => x.inv).length, 1);
            assert.ok(b.every((x) => x.origin === 'test'));
        });

        await test('same-database restore (source still present) also keeps edges resolving', async () => {
            await restoreWorkspaceBundle(src, { bundlePath: bundle, targetWorkspaceId: 'ws-a-copy' });
            assert.equal(await brokenEdges(src, 'ws-a-copy'), 0);
            assert.equal(await brokenEdges(src, 'ws-a'), 0);
            // a freshly written node after restore must not collide with a restored sk
            await src.query(`INSERT INTO nodes (workspace_id, id, type, label, content, "createdAt") VALUES ('ws-a-copy','fresh','note','f','c','2026-01-01')`);
        });
    } finally {
        await src.end(); await dst.end();
        for (const d of [srcDb, dstDb]) await admin.query(`DROP DATABASE IF EXISTS ${d}`).catch(() => undefined);
        await admin.end();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
