/**
 * postgres-workspace-backup-unit.ts — per-workspace logical backup / restore
 * of the Postgres engine.
 *
 * Needs a throwaway Postgres with pgvector (`LORE_PG_URL`); with it unset the
 * file prints the reason and exits 0. It creates its own database
 * (`lore_bk_<pid>`) holding the REAL Lore tables (nodes, edges, verbatim) plus
 * synthetic tables for the shapes other lanes will add (surrogate ids with a
 * referencing column, a LIST-partitioned vector table, a table created after
 * the backup code was written, a table without workspace_id), and drops it at
 * the end.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Client, Pool } from 'pg';

import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { bundleRows, verifyBundle } from '../packages/lore/src/engines/postgres/postgresBackupBundle.js';
import { openPostgresWorkspaceBackup } from '../packages/lore/src/engines/postgres/postgresWorkspaceBackup.js';
import { peekLogicalBundle, LogicalBackupError } from '../packages/lore/src/engines/workspaceLogicalBackup.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const DIM = 8;
const url = process.env['LORE_PG_URL'];
if (!url || url.trim() === '') {
    console.log('SKIP postgres-workspace-backup-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}

const dbName = `lore_bk_${process.pid}`;
const withDb = (db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgbk-'));

const vec = (seed: number): string => `[${Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7.13 + i) * 1e-3 + (seed % 5) / 3).join(',')}]`;

async function seed(pool: Pool, ws: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        await pool.query(`INSERT INTO nodes (workspace_id, id, type, label, content, "createdAt") VALUES ($1,$2,'note',$3,$4,'2026-01-01')`,
            [ws, `n${i}`, `label ${i} of ${ws}`, `content ${ws} ${i} é中 "quoted" \\ back\nnewline`]);
        if (i > 0) await pool.query(
            `INSERT INTO edges (workspace_id, src_sk, dst_sk, relation)
             SELECT $1, s.sk, t.sk, 'next' FROM nodes s, nodes t WHERE s.workspace_id=$1 AND s.id=$2 AND t.workspace_id=$1 AND t.id=$3`, [ws, `n${i - 1}`, `n${i}`]);
        await pool.query(`INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at, tags)
                          VALUES ($1,$2,$3,$4::vector,'2026-01-01','2026-01-01',NULL)`, [ws, `n${i}`, `text ${ws} ${i} fox`, vec(i + 1)]);
        const it = await pool.query<{ id: string }>(`INSERT INTO bk_items (workspace_id, title) VALUES ($1,$2) RETURNING id::text AS id`, [ws, `item ${ws} ${i}`]);
        await pool.query(`INSERT INTO bk_item_notes (workspace_id, item_id, body) VALUES ($1,$2,$3)`, [ws, it.rows[0]!.id, `note on ${ws} ${i}`]);
        await pool.query(`INSERT INTO bk_loose (workspace_id, item_id, tag) VALUES ($1,$2,$3)`, [ws, it.rows[0]!.id, `tag ${i}`]);
        await pool.query(`INSERT INTO bk_parted (workspace_id, k, v) VALUES ($1,$2,$3::vector)`, [ws, `k${i}`, vec(i + 100)]);
    }
}

/** Canonical, id-independent picture of one workspace (surrogate ids are replaced by what they point at). */
async function picture(pool: Pool, ws: string): Promise<Record<string, string[]>> {
    const q = async (sql: string): Promise<string[]> => (await pool.query<{ r: string }>(sql, [ws])).rows.map((x) => x.r).sort();
    return {
        nodes: await q(`SELECT (n::text) AS r FROM (SELECT id,type,label,content,tags,"createdAt",revision FROM nodes WHERE workspace_id=$1) n`),
        edges: await q(`SELECT (e::text) AS r FROM (SELECT s.id AS source_id, t.id AS target_id, e.relation, e."confidenceScore" FROM edges e JOIN nodes s ON s.sk=e.src_sk JOIN nodes t ON t.sk=e.dst_sk WHERE e.workspace_id=$1) e`),
        verbatim: await q(`SELECT (v::text) AS r FROM (SELECT id,text,vector::text,is_canonical,created_at,text_tsv::text FROM verbatim WHERE workspace_id=$1) v`),
        items: await q(`SELECT i.title AS r FROM bk_items i WHERE i.workspace_id=$1`),
        notes: await q(`SELECT (i.title || ' | ' || n.body) AS r FROM bk_item_notes n JOIN bk_items i ON i.id=n.item_id WHERE n.workspace_id=$1`),
        loose: await q(`SELECT (i.title || ' | ' || l.tag) AS r FROM bk_loose l JOIN bk_items i ON i.id=l.item_id WHERE l.workspace_id=$1`),
        parted: await q(`SELECT (p.k || ' ' || p.v::text) AS r FROM bk_parted p WHERE p.workspace_id=$1`),
    };
}
const counts = async (pool: Pool, ws: string): Promise<number> => {
    let n = 0;
    for (const t of ['nodes', 'edges', 'verbatim', 'bk_items', 'bk_item_notes', 'bk_loose', 'bk_parted']) {
        n += Number((await pool.query<{ c: string }>(`SELECT count(*) AS c FROM ${t} WHERE workspace_id=$1`, [ws])).rows[0]!.c);
    }
    return n;
};
const dump = (f: string): string => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');
const gzTo = (f: string, text: string): string => { fs.writeFileSync(f, zlib.gzipSync(Buffer.from(text, 'utf8'))); return f; };
async function rejects(p: Promise<unknown>, code: string): Promise<LogicalBackupError> {
    try { await p; } catch (e) {
        assert.ok(e instanceof LogicalBackupError, `expected LogicalBackupError(${code}), got ${(e as Error).stack}`);
        assert.equal((e as LogicalBackupError).code, code, (e as Error).message);
        return e as LogicalBackupError;
    }
    throw new Error(`expected rejection with ${code}, but it resolved`);
}

async function main(): Promise<void> {
    const admin = new Client({ connectionString: withDb('postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const pool = new Pool({ connectionString: withDb(dbName), max: 6 });
    // pool.end() resolves before each idle client's socket has closed, so the DROP ... WITH (FORCE) in the
    // finally can terminate one mid-close (57P01). Without a listener that error crashes the process after
    // every test already passed. The product pool (postgresClient.ts) has the same guard.
    pool.on('error', () => undefined);
    try {
        const c = await pool.connect();
        try {
            await ensureGraphSchema(c, 'setup');
            await ensureVerbatimSchema(c, 'setup', DIM);
            // verbatim is LIST-partitioned per workspace (vector-partitions lane): the seeded workspaces need their partitions.
            await ensureVerbatimSchema(c, 'ws-a', DIM);
            await ensureVerbatimSchema(c, 'ws-b', DIM);
            await c.query(`CREATE TABLE bk_items (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL)`);
            await c.query(`CREATE TABLE bk_item_notes (note_id SERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, item_id BIGINT NOT NULL REFERENCES bk_items(id), body TEXT NOT NULL)`);
            await c.query(`CREATE TABLE bk_parted (workspace_id TEXT NOT NULL, k TEXT NOT NULL, v vector(${DIM}), PRIMARY KEY (workspace_id, k)) PARTITION BY LIST (workspace_id)`);
            await c.query(`CREATE TABLE bk_parted_a PARTITION OF bk_parted FOR VALUES IN ('ws-a')`);
            await c.query(`CREATE TABLE bk_parted_b PARTITION OF bk_parted FOR VALUES IN ('ws-b')`);
            await c.query(`CREATE INDEX bk_parted_hnsw ON bk_parted USING hnsw (v vector_cosine_ops)`);
            await c.query(`CREATE TABLE bk_loose (workspace_id TEXT NOT NULL, item_id BIGINT NOT NULL, tag TEXT NOT NULL)`);
            await c.query(`COMMENT ON COLUMN bk_loose.item_id IS 'lore:references bk_items.id'`);
            await c.query(`CREATE TABLE bk_global (k TEXT PRIMARY KEY, v TEXT)`);
        } finally { c.release(); }
        await seed(pool, 'ws-a', 25);
        await seed(pool, 'ws-b', 17);
        await pool.query(`INSERT INTO bk_global VALUES ('x','y')`);

        const out = path.join(tmp, 'out');
        const wsB = await picture(pool, 'ws-b');
        let bundleA = '';
        let sumA!: Awaited<ReturnType<typeof exportWorkspaceBundle>>;

        await test('export: counts per table match the database, excluded tables are listed with a reason', async () => {
            sumA = await exportWorkspaceBundle(pool, { workspaceId: 'ws-a', outDir: out, fetchSize: 7 });
            bundleA = sumA.bundlePath;
            const by = Object.fromEntries(sumA.tables.map((t) => [t.name, t.rowCount]));
            assert.equal(by['nodes'], 25); assert.equal(by['edges'], 24); assert.equal(by['verbatim'], 25);
            assert.equal(by['bk_items'], 25); assert.equal(by['bk_item_notes'], 25); assert.equal(by['bk_parted'], 25);
            assert.equal(sumA.totalRows, 25 * 6 + 24);
            const ex = sumA.excluded.map((e) => e.table).sort();
            assert.ok(ex.includes('bk_global') && ex.includes('verbatim_changes_log'), JSON.stringify(ex));
            assert.ok(sumA.excluded.every((e) => e.reason.length > 10));
            const manifest = JSON.parse(fs.readFileSync(sumA.manifestPath, 'utf8')) as { header: { sourceWorkspaceId: string; pgvectorVersion: string | null; loreVersion: string; tables: { columns: { type: string }[] }[] } };
            assert.equal(manifest.header.sourceWorkspaceId, 'ws-a');
            assert.ok(manifest.header.pgvectorVersion && manifest.header.loreVersion);
            assert.ok(manifest.header.tables.some((t) => t.columns.some((cc) => cc.type === `vector(${DIM})`)));
        });

        await test('isolation: the bundle contains no row of another workspace and no foreign workspace_id', async () => {
            let rows = 0;
            for await (const r of bundleRows(bundleA)) {
                rows++;
                for (const v of r.values) assert.ok(v === null || !v.includes('ws-b'), `foreign data in bundle: ${v}`);
            }
            assert.equal(rows, sumA.totalRows);
            assert.ok(!dump(bundleA).includes('ws-b'));
            assert.equal((await peekLogicalBundle(bundleA))?.sourceWorkspaceId, 'ws-a');
            assert.equal(await peekLogicalBundle(sumA.manifestPath), null);
        });

        await test('round trip: restore as ws-a2 on the same server is content-identical, ws-b untouched, ids remapped consistently', async () => {
            const before = await counts(pool, 'ws-a');
            const r = await restoreWorkspaceBundle(pool, { bundlePath: bundleA, targetWorkspaceId: 'ws-a2' });
            assert.equal(r.totalRows, sumA.totalRows);
            assert.deepEqual(await picture(pool, 'ws-a2'), await picture(pool, 'ws-a'));
            assert.deepEqual(await picture(pool, 'ws-b'), wsB);
            assert.equal(await counts(pool, 'ws-a'), before);
            assert.ok(r.idRemaps.some((m) => m.table === 'bk_items' && m.column === 'id'), 'bk_items.id must be shifted: the source still holds the originals');
            assert.ok(r.idRemaps.some((m) => m.table === 'bk_item_notes' && m.column === 'item_id'), 'the referencing column must be shifted with it');
            assert.ok(r.idRemaps.some((m) => m.table === 'bk_loose' && m.column === 'item_id'), 'a column declared only by a lore:references comment is shifted too');
            const orphan = await pool.query(`SELECT 1 FROM bk_item_notes n LEFT JOIN bk_items i ON i.id=n.item_id WHERE n.workspace_id='ws-a2' AND i.id IS NULL`);
            assert.equal(orphan.rowCount, 0);
            // the partition for ws-a2 was created by the provisioning hook
            const part = await pool.query(`SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='bk_parted'::regclass AND pg_get_expr(c.relpartbound,c.oid) = $1`, [`FOR VALUES IN ('ws-a2')`]);
            assert.equal(part.rowCount, 1);
        });

        await test('vectors round-trip bit-exact (compared inside Postgres, not via text)', async () => {
            const bad = await pool.query(`SELECT 1 FROM verbatim a JOIN verbatim b ON a.id=b.id AND a.workspace_id='ws-a' AND b.workspace_id='ws-a2' WHERE a.vector <> b.vector OR a.vector IS NULL`);
            assert.equal(bad.rowCount, 0);
            const bad2 = await pool.query(`SELECT 1 FROM bk_parted a JOIN bk_parted b ON a.k=b.k AND a.workspace_id='ws-a' AND b.workspace_id='ws-a2' WHERE a.v <> b.v`);
            assert.equal(bad2.rowCount, 0);
            const n = await pool.query(`SELECT count(*)::int AS c FROM verbatim a JOIN verbatim b ON a.id=b.id AND a.workspace_id='ws-a' AND b.workspace_id='ws-a2' WHERE a.vector = b.vector`);
            assert.equal(n.rows[0].c, 25);
        });

        await test('non-empty target is refused with nothing changed; force replaces it in one transaction', async () => {
            const before = await picture(pool, 'ws-a2');
            await rejects(restoreWorkspaceBundle(pool, { bundlePath: bundleA, targetWorkspaceId: 'ws-a2' }), 'restore_target_not_empty');
            assert.deepEqual(await picture(pool, 'ws-a2'), before);
            await pool.query(`UPDATE nodes SET content='drifted' WHERE workspace_id='ws-a2' AND id='n3'`);
            await pool.query(`INSERT INTO nodes (workspace_id,id) VALUES ('ws-a2','stray')`);
            const r = await restoreWorkspaceBundle(pool, { bundlePath: bundleA, targetWorkspaceId: 'ws-a2', force: true });
            assert.ok(r.clearedRows >= sumA.totalRows);
            assert.deepEqual(await picture(pool, 'ws-a2'), await picture(pool, 'ws-a'));
            assert.equal((await pool.query(`SELECT 1 FROM nodes WHERE workspace_id='ws-a2' AND id='stray'`)).rowCount, 0);
            assert.deepEqual(await picture(pool, 'ws-b'), wsB);
        });

        await test('failed restore rolls back completely (forced restore that dies mid-load leaves the old rows)', async () => {
            const before = await picture(pool, 'ws-a2');
            let batches = 0;
            await assert.rejects(restoreWorkspaceBundle(pool, {
                bundlePath: bundleA, targetWorkspaceId: 'ws-a2', force: true, batchRows: 4,
                afterBatch: async () => { if (++batches === 6) throw new Error('boom mid-load'); },
            }), /boom mid-load/);
            assert.deepEqual(await picture(pool, 'ws-a2'), before);
        });

        await test('tampered bundle is refused before any write (changed value, truncated file, flipped gzip byte)', async () => {
            const text = dump(bundleA);
            const lines = text.split('\n');
            const i = lines.findIndex((l, k) => k > 0 && l.startsWith('['));
            assert.ok(i > 0);
            const arr = JSON.parse(lines[i]!) as (string | number | null)[];
            const j = arr.findIndex((v, k) => k > 0 && typeof v === 'string');
            arr[j] = `${arr[j]}-tampered`;
            lines[i] = JSON.stringify(arr);
            assert.notEqual(lines[i], dump(bundleA).split('\n')[i], 'the forgery must actually differ');
            const forged = gzTo(path.join(tmp, 'forged.ndjson.gz'), lines.join('\n'));
            const truncated = gzTo(path.join(tmp, 'trunc.ndjson.gz'), text.slice(0, Math.floor(text.length * 0.6)));
            const flipped = path.join(tmp, 'flip.ndjson.gz');
            const raw = Buffer.from(fs.readFileSync(bundleA)); raw[Math.floor(raw.length / 2)]! ^= 0xff; fs.writeFileSync(flipped, raw);
            const partsBefore = Number((await pool.query(`SELECT count(*) AS c FROM pg_inherits WHERE inhparent='bk_parted'::regclass`)).rows[0].c);
            for (const f of [forged, truncated, flipped]) {
                await rejects(restoreWorkspaceBundle(pool, { bundlePath: f, targetWorkspaceId: 'ws-tamper' }), 'bundle_hash_mismatch');
            }
            assert.equal(await counts(pool, 'ws-tamper'), 0);
            assert.equal(Number((await pool.query(`SELECT count(*) AS c FROM pg_inherits WHERE inhparent='bk_parted'::regclass`)).rows[0].c), partsBefore, 'no partition may be created for a refused bundle');
            await assert.rejects(verifyBundle(forged));
        });

        await test('restoring back over the original id keeps ids, sequences end ahead of every id', async () => {
            const b = await exportWorkspaceBundle(pool, { workspaceId: 'ws-a', outDir: out });
            const idsBefore = (await pool.query<{ id: string }>(`SELECT id::text FROM bk_items WHERE workspace_id='ws-a' ORDER BY id`)).rows.map((x) => x.id);
            const r = await restoreWorkspaceBundle(pool, { bundlePath: b.bundlePath, targetWorkspaceId: 'ws-a', force: true });
            assert.deepEqual(r.idRemaps, [], 'original ids are free once the workspace is cleared: no remap');
            assert.deepEqual((await pool.query<{ id: string }>(`SELECT id::text FROM bk_items WHERE workspace_id='ws-a' ORDER BY id`)).rows.map((x) => x.id), idsBefore);
            for (const [t, col] of [['bk_items', 'id'], ['bk_item_notes', 'note_id'], ['verbatim', 'row_id']] as const) {
                const mx = (await pool.query<{ m: string }>(`SELECT max(${col})::text AS m FROM ${t}`)).rows[0]!.m;
                // verbatim.row_id is fed by a free-standing sequence (not OWNED BY), so pg_get_serial_sequence cannot see it.
                const seqSql = t === 'verbatim' ? `'verbatim_row_seq'` : `pg_get_serial_sequence('${t}','${col}')`;
                const nx = (await pool.query<{ n: string }>(`SELECT nextval(${seqSql})::text AS n`)).rows[0]!.n;
                assert.ok(BigInt(nx) > BigInt(mx), `${t}.${col}: nextval ${nx} must exceed max ${mx}`);
            }
            await pool.query(`INSERT INTO bk_items (workspace_id,title) VALUES ('ws-b','post-restore insert')`);
            await pool.query(`DELETE FROM bk_items WHERE workspace_id='ws-b' AND title='post-restore insert'`);
        });

        await test('a table created after the code was written is captured automatically; a schema change makes the old bundle refuse cleanly', async () => {
            await pool.query(`CREATE TABLE bk_late (workspace_id TEXT NOT NULL, label TEXT, n NUMERIC(10,2), at TIMESTAMPTZ, j JSONB, flags TEXT[], PRIMARY KEY (workspace_id, label))`);
            await pool.query(`INSERT INTO bk_late VALUES ('ws-a','one',1.50,'2026-02-03 04:05:06.789+00','{"b":[1,2],"a":null}','{x,"y z",NULL}'), ('ws-a','two',NULL,NULL,NULL,NULL), ('ws-b','b-only',9,NULL,NULL,NULL)`);
            const b = await exportWorkspaceBundle(pool, { workspaceId: 'ws-a', outDir: out });
            const late = b.tables.find((t) => t.name === 'bk_late');
            assert.equal(late?.rowCount, 2);
            await restoreWorkspaceBundle(pool, { bundlePath: b.bundlePath, targetWorkspaceId: 'ws-late' });
            const got = await pool.query(`SELECT label, n::text, at::text, j::text, flags::text FROM bk_late WHERE workspace_id='ws-late' ORDER BY label`);
            const want = await pool.query(`SELECT label, n::text, at::text, j::text, flags::text FROM bk_late WHERE workspace_id='ws-a' ORDER BY label`);
            assert.deepEqual(got.rows, want.rows);
            // the OLD bundle (no bk_late) restored now: the extra table's rows for the target are not left behind silently
            await pool.query(`ALTER TABLE bk_late RENAME COLUMN n TO n_renamed`);
            await rejects(restoreWorkspaceBundle(pool, { bundlePath: b.bundlePath, targetWorkspaceId: 'ws-late2' }), 'schema_mismatch');
            assert.equal(await counts(pool, 'ws-late2'), 0);
            await pool.query(`ALTER TABLE bk_late RENAME COLUMN n_renamed TO n`);
        });

        await test('snapshot consistency: writes committed during the export are not in the bundle', async () => {
            await pool.query(`CREATE TABLE bk_parted_c PARTITION OF bk_parted FOR VALUES IN ('ws-c')`);
            { const vc = await pool.connect(); try { await ensureVerbatimSchema(vc, 'ws-c', DIM); } finally { vc.release(); } }
            await seed(pool, 'ws-c', 30);
            const expected = await counts(pool, 'ws-c');
            let injected = 0;
            const s = await exportWorkspaceBundle(pool, {
                workspaceId: 'ws-c', outDir: out, fetchSize: 3,
                afterBatch: async (table) => {
                    if (injected >= 6) return;
                    injected++;
                    // other connections (autocommit) change ws-c while the snapshot is open
                    await pool.query(`INSERT INTO nodes (workspace_id,id,label) VALUES ('ws-c',$1,'late')`, [`late-${injected}-${table}`]);
                    await pool.query(`DELETE FROM edges WHERE workspace_id='ws-c' AND src_sk = (SELECT sk FROM nodes WHERE workspace_id='ws-c' AND id=$1)`, [`n${injected}`]);
                    await pool.query(`UPDATE nodes SET label='mutated' WHERE workspace_id='ws-c' AND id=$1`, [`n${injected + 10}`]);
                },
            });
            assert.ok(injected >= 6);
            assert.equal(s.totalRows, expected, 'bundle holds exactly the rows visible when the snapshot began');
            let leaked = 0, mutated = 0;
            for await (const r of bundleRows(s.bundlePath)) {
                if (r.table === 0 && r.values.some((v) => v?.startsWith('late-'))) leaked++;
                if (r.table === 0 && r.values.some((v) => v === 'mutated')) mutated++;
            }
            assert.equal(leaked, 0); assert.equal(mutated, 0);
            const rs = await restoreWorkspaceBundle(pool, { bundlePath: s.bundlePath, targetWorkspaceId: 'ws-c2' });
            assert.equal(rs.totalRows, expected);
        });

        await test('refusals: empty/unknown workspace, un-drained outbox (backup and restore), blank target', async () => {
            await rejects(exportWorkspaceBundle(pool, { workspaceId: 'ws-nope', outDir: out }), 'workspace_empty');
            await rejects(exportWorkspaceBundle(pool, { workspaceId: 'ws-a', outDir: out, outboxDepth: async () => 3 }), 'outbox_not_drained');
            await rejects(restoreWorkspaceBundle(pool, { bundlePath: bundleA, targetWorkspaceId: 'ws-x', outboxDepth: async () => 1 }), 'outbox_not_drained');
            await rejects(restoreWorkspaceBundle(pool, { bundlePath: bundleA, targetWorkspaceId: ' ' }), 'invalid_workspace');
            assert.equal(await counts(pool, 'ws-x'), 0);
            assert.ok(fs.readdirSync(out).every((f) => !f.endsWith('.partial')), 'no .partial files left behind');
        });

        await test('adapter behind the port: backup then restore through openPostgresWorkspaceBackup', async () => {
            const port = openPostgresWorkspaceBackup({ pool, gzip: false });
            const s = await port.backup({ workspaceId: 'ws-b', outDir: path.join(tmp, 'port') });
            assert.ok(s.bundlePath.endsWith('.ndjson'));
            const r = await port.restore({ bundlePath: s.bundlePath, targetWorkspaceId: 'ws-b2' });
            assert.equal(r.totalRows, s.totalRows);
            assert.deepEqual(await picture(pool, 'ws-b2'), await picture(pool, 'ws-b'));
            await port.close();
        });
    } finally {
        await pool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
