#!/usr/bin/env tsx
/**
 * test/postgres-verbatim-partitions-unit.ts - the per-workspace partition layout of the Postgres verbatim store
 * (postgresVerbatimPartitionDdl.ts / postgresVerbatimSchema.ts) and the in-place migration from the pre-partitioning
 * single table (postgresVerbatimPartitionMigration.ts).
 *
 *   layout       verbatim is LIST-partitioned by workspace_id; a workspace gets its partition (with its own HNSW graph)
 *                on first open; re-opening and concurrent opens create exactly one.
 *   pruning      the REAL search statements (searchOne / searchMany) touch exactly one partition - proven from the
 *                EXPLAIN plan, not assumed.
 *   migration    legacy table -> partitioned: resumable after a partial copy, consistent with writes that land
 *                mid-migration (insert / delete / flag flip / brand-new workspace), row_id and tsvector preserved,
 *                sequence advanced, rollback copy kept, concurrent openers serialised by the advisory lock.
 *
 * Needs LORE_PG_URL (a throwaway server with pgvector); skips cleanly with a printed reason otherwise. Uses its own
 * database (lore_part_<pid>), dropped at the end.
 *
 * Run: LORE_PG_URL=postgres://... npx tsx test/postgres-verbatim-partitions-unit.ts
 */
import assert from 'node:assert/strict';

import { Client, type Pool, type PoolClient } from 'pg';

import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { runSchemaBootstrap } from '../packages/lore/src/engines/postgres/postgresStartup.js';
import { ensureVerbatimSchema, verbatimPartitionName, verbatimTableState } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { migrateVerbatimToPartitioned, dropPrePartitionVerbatim } from '../packages/lore/src/engines/postgres/postgresVerbatimPartitionMigration.js';
import { searchMany, searchOne } from '../packages/lore/src/engines/postgres/postgresVerbatim/postgresVerbatimVectorSearch.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const raw = process.env['LORE_PG_URL'];
if (!raw || raw.trim() === '') {
    console.log('  SKIP postgres-verbatim-partitions: LORE_PG_URL is not set - partition and migration cases skipped cleanly');
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
}

const DIM = 4;
const dbName = `lore_part_${process.pid}`;
const withDb = (name: string): string => { const u = new URL(raw); u.pathname = `/${name}`; return u.toString(); };
const admin = new Client({ connectionString: withDb('postgres') });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const pool: Pool = createPostgresPool({ url: withDb(dbName) });

const bootstrap = (ws: string): Promise<void> => runSchemaBootstrap(pool, { requirePgvector: true }, (c) => ensureVerbatimSchema(c, ws, DIM));
const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool.query(sql, params)).rows as T[];
const partitionsOf = async (): Promise<string[]> =>
    (await q<{ n: string }>(`SELECT c.relname AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = to_regclass('verbatim') ORDER BY 1`)).map((r) => r.n);
const vec = (...x: number[]): string => `[${x.join(',')}]`;

/** Fresh slate between scenarios. */
async function reset(): Promise<void> {
    await q(`DROP TABLE IF EXISTS verbatim, verbatim_next, verbatim_pre_partition, verbatim_partition_progress, verbatim_changes_log CASCADE`);
    await q(`DROP SEQUENCE IF EXISTS verbatim_row_seq`);
}

/** Insert one row through plain SQL (works on the legacy table and on the partitioned one). */
async function ins(c: Pool | PoolClient, ws: string, id: string, text: string, v: string | null, o: { canon?: number; tomb?: number; eco?: string; scopes?: string; sup?: string } = {}): Promise<void> {
    await c.query(
        `INSERT INTO verbatim (workspace_id, id, text, vector, is_canonical, is_tombstone, ecosystem, security_scopes, superseded_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4::vector,$5,$6,$7,$8,$9,'2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')`,
        [ws, id, text, v, o.canon ?? 1, o.tomb ?? 0, o.eco ?? null, o.scopes ?? null, o.sup ?? null],
    );
}

console.log('\npostgres verbatim partitions');

// ---------------------------------------------------------------- layout
await test('fresh database: verbatim is a partitioned parent; each opened workspace gets one partition with its own HNSW graph', async () => {
    await reset();
    await bootstrap('ws-a');
    await bootstrap('ws-b');
    assert.equal(await verbatimTableState(await pool.connect().then((c) => { c.release(); return c; })), 'partitioned');
    assert.deepEqual(await partitionsOf(), [verbatimPartitionName('ws-a'), verbatimPartitionName('ws-b')].sort());
    const idx = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE '%hnsw%'`, [verbatimPartitionName('ws-a')]);
    assert.equal(idx.length, 1, 'the partition must carry its own HNSW index (inherited from the parent definition)');
    // the parent keeps the canonical names the rest of the engine looks for
    const names = (await q<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'verbatim'`)).map((r) => r.indexname);
    for (const n of ['verbatim_vector_hnsw', 'verbatim_text_tsv_gin', 'verbatim_canonical_id_uq', 'verbatim_pkey']) assert.ok(names.includes(n), `missing ${n}`);
});

await test('re-opening a workspace is a no-op (same partitions, no error); a row insert fills the shared sequence', async () => {
    const before = await partitionsOf();
    await bootstrap('ws-a');
    await bootstrap('ws-a');
    assert.deepEqual(await partitionsOf(), before);
    await ins(pool, 'ws-a', 'x1', 'hello world', vec(1, 0, 0, 0));
    await ins(pool, 'ws-b', 'x2', 'hello again', vec(0, 1, 0, 0));
    const ids = (await q<{ row_id: string }>(`SELECT row_id FROM verbatim ORDER BY row_id`)).map((r) => Number(r.row_id));
    assert.equal(new Set(ids).size, 2, 'row_id is unique across partitions');
});

await test('8 concurrent first-opens of the SAME new workspace and 8 of DISTINCT workspaces: one partition each, no errors', async () => {
    const before = (await partitionsOf()).length;
    await Promise.all(Array.from({ length: 8 }, () => bootstrap('ws-same')));
    assert.equal((await partitionsOf()).length, before + 1);
    await Promise.all(Array.from({ length: 8 }, (_, i) => bootstrap(`ws-par-${i}`)));
    assert.equal((await partitionsOf()).length, before + 1 + 8);
});

// ---------------------------------------------------------------- pruning
/** A pool stand-in that EXPLAINs whatever the search module sends and keeps the plan. */
function explainPool(onPlan: (plan: unknown) => void): Pool {
    // The search module runs inside withTransaction (BEGIN / SET LOCAL hnsw.iterative_scan / COMMIT): pass the transaction
    // control through on a real client and EXPLAIN every other statement on it.
    return {
        connect: async () => {
            const c = await pool.connect();
            return {
                query: async (sql: string, params?: unknown[]) => {
                    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i.test(sql)) return c.query(sql);
                    const res = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
                    onPlan((res.rows[0] as Record<string, unknown>)['QUERY PLAN']);
                    return { rows: [] };
                },
                release: () => c.release(),
            };
        },
    } as unknown as Pool;
}
function relations(plan: unknown, acc: Set<string> = new Set()): Set<string> {
    if (Array.isArray(plan)) { for (const p of plan) relations(p, acc); return acc; }
    if (plan && typeof plan === 'object') {
        for (const [k, v] of Object.entries(plan)) {
            if (k === 'Relation Name' && typeof v === 'string') acc.add(v);
            else relations(v, acc);
        }
    }
    return acc;
}

await test('EXPLAIN: the real single-query and batched search statements touch exactly ONE partition (workspace_id equality prunes)', async () => {
    await reset();
    for (const ws of ['p-one', 'p-two', 'p-three']) {
        await bootstrap(ws);
        for (let i = 0; i < 40; i++) await ins(pool, ws, `${ws}-${i}`, `doc ${i}`, vec(Math.cos(i), Math.sin(i), 0.1, 0.2));
    }
    await q('ANALYZE verbatim');
    for (const label of ['searchOne', 'searchMany']) {
        let plan: unknown;
        const p = explainPool((pl) => { plan = pl; });
        if (label === 'searchOne') await searchOne(p, 'p-two', [1, 0, 0, 0], 5, undefined, undefined);
        else await searchMany(p, 'p-two', [{ key: 'a', vector: [1, 0, 0, 0] }, { key: 'b', vector: [0, 1, 0, 0] }], { topK: 5 });
        const rels = [...relations(plan)];
        assert.deepEqual(rels, [verbatimPartitionName('p-two')], `${label}: plan must reference only p-two's partition, got ${JSON.stringify(rels)}`);
    }
});

await test('EXPLAIN with seq scans disabled: the one partition is searched through ITS OWN hnsw index', async () => {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await c.query('SET LOCAL enable_seqscan = off');
        await c.query('SET LOCAL enable_bitmapscan = off');
        const res = await c.query(
            `EXPLAIN (FORMAT JSON) SELECT id FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 ORDER BY vector <=> $2::vector LIMIT 5`,
            ['p-three', vec(1, 0, 0, 0)],
        );
        await c.query('ROLLBACK');
        const text = JSON.stringify((res.rows[0] as Record<string, unknown>)['QUERY PLAN']);
        const rels = [...relations((res.rows[0] as Record<string, unknown>)['QUERY PLAN'])];
        assert.deepEqual(rels, [verbatimPartitionName('p-three')]);
        const used = /"Index Name":"([^"]+)"/.exec(text)?.[1];
        assert.ok(used, 'expected an index scan on the workspace partition');
        assert.ok(used.startsWith(verbatimPartitionName('p-three')), `index ${used} must belong to the workspace partition`);
        const def = (await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [used]))[0]?.indexdef ?? '';
        assert.match(def, /USING hnsw/, `index ${used} must be the HNSW vector index, got: ${def}`);
    } finally { c.release(); }
});

// ---------------------------------------------------------------- migration
const LEGACY_DDL = [
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
const WS = ['m-alpha', 'm-beta', 'm-gamma'];

/** Rebuild the pre-partitioning layout and fill it: 3 workspaces, history rows, a tombstone, scopes, ecosystems. */
async function seedLegacy(): Promise<void> {
    await reset();
    for (const s of LEGACY_DDL) await q(s);
    for (const ws of WS) {
        for (let i = 0; i < 25; i++) {
            await ins(pool, ws, `${ws}-${i}`, `legacy document ${i} of ${ws}`, vec(Math.cos(i), Math.sin(i), 0.3, 0.1), { eco: i % 2 ? 'eco-x' : '*', scopes: i % 5 === 0 ? '["team-a"]' : '[]' });
        }
        await ins(pool, ws, `${ws}-0`, 'older snapshot of document zero', vec(0, 0, 1, 0), { canon: 0, sup: '2026-10-22T00:00:00Z' });
        await ins(pool, ws, `${ws}-tomb`, '[TOMBSTONED x reason: y] gone', null, { tomb: 1 });
    }
}

const FP = `md5(string_agg(row_id::text||'|'||id||'|'||text||'|'||coalesce(vector::text,'~')||'|'||is_canonical||'|'||is_tombstone||'|'||coalesce(ecosystem,'~')||'|'||coalesce(security_scopes,'~')||'|'||coalesce(superseded_at,'~')||'|'||text_tsv::text, ',' ORDER BY row_id))`;
const fingerprint = (table: string) => q<{ workspace_id: string; n: string; fp: string }>(
    `SELECT workspace_id, count(*) AS n, ${FP} AS fp FROM ${table} GROUP BY workspace_id ORDER BY workspace_id`);

await test('migration: pauses after a partial copy, resumes, absorbs writes that landed mid-migration, and preserves every row byte for byte', async () => {
    await seedLegacy();
    const c = await pool.connect();
    try {
        assert.equal(await verbatimTableState(c), 'legacy');
        assert.equal(await migrateVerbatimToPartitioned(c, DIM, { batchSize: 10, maxBatches: 2 }), 'paused');
        assert.equal(await verbatimTableState(c), 'legacy', 'a paused migration must leave the live table untouched');
        const hwm = Number((await q<{ hwm: string }>(`SELECT hwm FROM verbatim_partition_progress`))[0]!.hwm);
        assert.ok(hwm > 0, 'progress must be recorded between batches');
        assert.equal(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM verbatim_next`))[0]!.n), 20);

        // Live writers keep going while the migration is paused / about to swap.
        let after: Awaited<ReturnType<typeof fingerprint>> = [];
        const result = await migrateVerbatimToPartitioned(c, DIM, {
            batchSize: 10,
            beforeSwap: async (cl) => {
                await ins(cl, 'm-alpha', 'm-alpha-late', 'inserted behind the high water mark', vec(0.5, 0.5, 0, 0));
                await ins(cl, 'm-newcomer', 'nc-1', 'a workspace that did not exist at copy time', vec(0, 0, 0, 1));
                await cl.query(`DELETE FROM verbatim WHERE workspace_id = 'm-beta' AND id = 'm-beta-3'`);
                await cl.query(`UPDATE verbatim SET is_canonical = 0, superseded_at = '2026-10-23T01:00:00Z' WHERE workspace_id = 'm-gamma' AND id = 'm-gamma-4' AND is_canonical = 1`);
                after = await fingerprint('verbatim');
            },
        });
        assert.equal(result, 'migrated');
        assert.equal(await verbatimTableState(c), 'partitioned');
        assert.deepEqual(await fingerprint('verbatim'), after, 'partitioned table must equal the live table as it stood at the swap');
        assert.ok(after.some((r) => r.workspace_id === 'm-newcomer'));
        assert.ok(!(await q(`SELECT 1 FROM verbatim WHERE id = 'm-beta-3'`)).length, 'a row deleted mid-migration must not reappear');
    } finally { c.release(); }
});

await test('migration: rollback copy kept, progress table gone, index names canonical, every workspace has a partition, sequence advanced', async () => {
    assert.ok((await q(`SELECT to_regclass('verbatim_pre_partition') AS t`))[0]!['t'], 'rollback copy missing');
    assert.equal((await q(`SELECT to_regclass('verbatim_partition_progress') AS t`))[0]!['t'], null);
    assert.equal((await q(`SELECT to_regclass('verbatim_next') AS t`))[0]!['t'], null);
    const names = (await q<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'verbatim'`)).map((r) => r.indexname);
    for (const n of ['verbatim_vector_hnsw', 'verbatim_text_tsv_gin', 'verbatim_canonical_id_uq', 'verbatim_pkey', 'verbatim_id_idx']) assert.ok(names.includes(n), `missing ${n}`);
    const parts = await partitionsOf();
    for (const ws of [...WS, 'm-newcomer']) assert.ok(parts.includes(verbatimPartitionName(ws)), `no partition for ${ws}`);
    const maxId = Number((await q<{ m: string }>(`SELECT max(row_id) AS m FROM verbatim`))[0]!.m);
    await ins(pool, 'm-alpha', 'after-migration', 'fresh write after the swap uses the trigger', vec(1, 1, 1, 1));
    const fresh = (await q<{ row_id: string; hit: boolean }>(`SELECT row_id, text_tsv @@ plainto_tsquery('simple','trigger') AS hit FROM verbatim WHERE id = 'after-migration'`))[0]!;
    assert.ok(Number(fresh.row_id) > maxId, 'new rows must get a row_id above everything copied');
    assert.equal(fresh.hit, true, 'the tsvector trigger must be attached to the new table');
    // The old table's index names were moved aside so the canonical names belong to the new table.
    assert.ok((await q(`SELECT 1 FROM pg_indexes WHERE tablename = 'verbatim_pre_partition' AND indexname = 'verbatim_vector_hnsw_pre_partition'`)).length === 1);
});

await test('migration: ensureVerbatimSchema afterwards is a no-op; dropPrePartitionVerbatim removes the rollback copy once, then reports none', async () => {
    const before = await partitionsOf();
    await bootstrap('m-alpha');
    assert.deepEqual(await partitionsOf(), before);
    const c = await pool.connect();
    try {
        assert.equal(await dropPrePartitionVerbatim(c), true);
        assert.equal(await dropPrePartitionVerbatim(c), false);
    } finally { c.release(); }
});

await test('migration through the public entry: 4 concurrent openers on a legacy database serialise on the advisory lock; rows preserved', async () => {
    await seedLegacy();
    const before = await fingerprint('verbatim');
    await Promise.all([1, 2, 3, 4].map(() => bootstrap('m-alpha')));
    const after = await fingerprint('verbatim');
    assert.deepEqual(after, before);
    assert.equal((await q<{ k: string }>(`SELECT relkind AS k FROM pg_class WHERE oid = to_regclass('verbatim')`))[0]!.k, 'p');
    assert.equal((await q(`SELECT 1 FROM pg_inherits WHERE inhparent = to_regclass('verbatim')`)).length, WS.length);
});

await test('migration refuses to overwrite an existing rollback copy (a half-finished earlier swap must be resolved by an operator)', async () => {
    await seedLegacy();
    await q(`CREATE TABLE verbatim_pre_partition (x int)`);
    await assert.rejects(bootstrap('m-alpha'), /verbatim_pre_partition already exists/);
    assert.equal((await q<{ k: string }>(`SELECT relkind AS k FROM pg_class WHERE oid = to_regclass('verbatim')`))[0]!.k, 'r', 'live table untouched');
});

await closePostgresPool(pool);
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
