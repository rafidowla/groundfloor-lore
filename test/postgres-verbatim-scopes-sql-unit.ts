#!/usr/bin/env tsx
/**
 * test/postgres-verbatim-scopes-sql-unit.ts - Phase 0 lane L4: scopes in SQL + pgvector 0.8 iterative scans.
 *
 *   - verbatim.security_scope_arr is derived from the JSON TEXT column by a trigger (old writers and old-bundle restores
 *     keep working), with a fail-closed sentinel for unreadable text
 *   - searchByVector / searchByVectors / bm25Search filter by scope IN SQL, before the LIMIT: an actor who can see ~5% of
 *     the workspace gets a full topK through the public store API, on the HNSW index (EXPLAIN) with iterative scans
 *   - `[]` actor = public rows only; undefined actor = no filter
 *   - a database bootstrapped by main (no column, no index) is backfilled in batches; re-running changes nothing
 *   - a bundle exported by main's code (fixtures/pg-bundle-pre-scope-arr.ndjson.gz) restores and derives the array
 *
 * Needs a throwaway Postgres with pgvector >= 0.8 (`LORE_PG_URL`); creates and drops its own database
 * (`lore_l4_<pid>`). Skips cleanly (exit 0) when LORE_PG_URL is unset.
 * Run: LORE_PG_URL=postgres://... npx tsx test/postgres-verbatim-scopes-sql-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Client, type Pool } from 'pg';

import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { SCOPE_BACKFILL_MARKER, scopesJsonToArray, scopesToArray, UNREADABLE_SCOPE_SENTINEL } from '../packages/lore/src/engines/postgres/postgresVerbatimScopeArr.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { stampGateManifest } from './helpers/testPostgres.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const url = process.env['LORE_PG_URL'];
if (!url || url.trim() === '') {
    console.log('SKIP postgres-verbatim-scopes-sql-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector 0.8+); exiting 0');
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
}

const DIM = 4;
const dbName = `lore_l4_${process.pid}`;
const withDb = (db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'pg-scopes-sql-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('must not embed'); }
    async embedQuery(): Promise<number[]> { throw new Error('must not embed'); }
    async embedDocument(): Promise<number[]> { return [-1, 0, 0, 0]; }
}
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0, 0];
const row = (id: string, deg: number, scopes: string[], text = `text ${id}`) => ({
    id, label: id, text, type: 'note', project: 'p', ecosystem: '*', security_scopes: scopes,
    vector: at(deg), contentHash: `h-${id}`, updatedAt: '2026-10-29T00:00:00.000Z',
});
const dirs: string[] = [];
async function open(pool: Pool, ws: string): Promise<PostgresVerbatimStore> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-scopes-'));
    dirs.push(base);
    stampGateManifest(base, 'pg-scopes-sql-none', DIM);
    const s = new PostgresVerbatimStore(base, pool, ws, new NoEmbed());
    await s.initialize();
    return s;
}
const ids = (hits: Array<{ id: string }>): string[] => hits.map((h) => h.id);

const admin = new Client({ connectionString: withDb('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${dbName}`);
// Deterministic plans for the small tables a unit test can afford: the planner may not pick the HNSW index for a
// 3000-row partition on its own. Production tables are large enough that it does; the EXPLAIN case below shows the
// index path explicitly and the full-topK cases run with it forced.
await admin.query(`ALTER DATABASE ${dbName} SET enable_seqscan = off`);
const pool = createPostgresPool({ url: withDb(dbName) });
pool.on('error', () => undefined);

try {
    const boot = await pool.connect();
    try {
        await ensureGraphSchema(boot, 'setup');
        await ensureVerbatimSchema(boot, 'setup', DIM);
    } finally { boot.release(); }

    console.log('\npostgres verbatim - scopes in SQL (security_scope_arr) + HNSW iterative scans');

    // ---- trigger / derivation -------------------------------------------------------------------------------------
    await test('trigger derives security_scope_arr from the TEXT column for writers that only know the TEXT column', async () => {
        const store = await open(pool, 'l4-trigger');
        void store;
        const cases: Array<[string | null, string[]]> = [
            [null, []], ['', []], ['[]', []], ['null', []],
            ['["b","a","a",""]', ['a', 'b']],
            ['"x, y"', ['x', 'y']],
            ['garbage{', [UNREADABLE_SCOPE_SENTINEL]],
            ['{"a":1}', [UNREADABLE_SCOPE_SENTINEL]],
            ['123', [UNREADABLE_SCOPE_SENTINEL]],
        ];
        for (const [i, [text, want]] of cases.entries()) {
            await pool.query(
                `INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at, security_scopes)
                 VALUES ('l4-trigger', $1, 't', $2::vector, 'x', 'x', $3)`, [`t${i}`, `[1,0,0,0]`, text]);
            const got = (await pool.query<{ a: string[] }>(`SELECT security_scope_arr AS a FROM verbatim WHERE workspace_id='l4-trigger' AND id=$1`, [`t${i}`])).rows[0]!.a;
            assert.deepEqual(got, want, `security_scopes=${JSON.stringify(text)}`);
        }
        // UPDATE of the TEXT column re-derives
        await pool.query(`UPDATE verbatim SET security_scopes = '["z"]' WHERE workspace_id='l4-trigger' AND id='t0'`);
        assert.deepEqual((await pool.query(`SELECT security_scope_arr AS a FROM verbatim WHERE workspace_id='l4-trigger' AND id='t0'`)).rows[0]!.a, ['z']);
    });

    await test('JS twins agree with the SQL function', async () => {
        for (const text of [null, '', '[]', 'null', '["b","a","a",""]', '"x, y"', 'garbage{', '{"a":1}', '123', '["é中","Z"]']) {
            const sql = (await pool.query<{ a: string[] }>(`SELECT verbatim_scopes_to_arr($1::text) AS a`, [text])).rows[0]!.a;
            assert.deepEqual([...scopesJsonToArray(text)].sort(), [...sql].sort(), JSON.stringify(text));
        }
        assert.deepEqual(scopesToArray(['b', 'a', 'a', '']), ['a', 'b']);
    });

    await test('every writer fills both columns (upsert, bulk add, replace, tombstone, tombstoneMany)', async () => {
        const s = await open(pool, 'l4-writers');
        await s.bulkAddPrebuiltRows([row('w1', 0, ['team-a', 'team-b']), row('w2', 10, [])]);
        await s.tombstone('w1', 'test');
        await s.tombstoneMany(['w2'], 'test');
        const r = await pool.query<{ id: string; is_tombstone: number; s: string | null; a: string[] }>(
            `SELECT id, is_tombstone, security_scopes AS s, security_scope_arr AS a FROM verbatim WHERE workspace_id='l4-writers'`);
        assert.ok(r.rows.some((x) => x.a.includes('team-a')), 'scoped rows carry their scopes in the array');
        assert.ok(r.rows.length >= 2);
        for (const x of r.rows) assert.deepEqual([...x.a].sort(), [...scopesJsonToArray(x.s)].sort(), `${x.id} tombstone=${x.is_tombstone}`);
        const live = await pool.query(`SELECT 1 FROM verbatim WHERE workspace_id='l4-writers' AND id IN ('w1','w2') AND is_canonical=1 AND is_tombstone=0`);
        assert.equal(live.rowCount, 0, 'tombstoned rows are no longer live');
    });

    // ---- the 5% visibility case -----------------------------------------------------------------------------------
    const TOTAL = 3000, VISIBLE = 150; // 5%
    const wsBig = 'l4-big';
    const big = await open(pool, wsBig);
    const bigVec: Record<string, number[]> = {};
    {
        // Hidden rows form a tight cluster around the query direction; the visible 5% sit in a second, further cluster, so
        // every HNSW candidate near the query is hidden (what starved a post-filtered topK). Seeded PRNG: reproducible.
        let seed = 0x1234abcd;
        const rnd = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const rows = [];
        for (let i = 0; i < TOTAL; i++) {
            const visible = i % (TOTAL / VISIBLE) === 0; // 1 in 20
            const vector = visible
                ? [0.3 + rnd() * 0.6, 0.3 + rnd() * 0.6, rnd() - 0.5, rnd() - 0.5]
                : [1 + rnd() * 0.3, rnd() * 0.3, rnd() * 0.3 - 0.15, rnd() * 0.3 - 0.15];
            bigVec[`b${i}`] = vector;
            rows.push({ ...row(`b${i}`, 0, visible ? ['team-a'] : ['team-b'], visible ? `zebra filler ${i}` : `zebra zebra zebra ${i}`), vector });
        }
        await big.bulkAddPrebuiltRows(rows);
        await pool.query('ANALYZE verbatim');
    }

    await test('searchByVector: an actor who sees ~5% of the workspace still gets a full topK, all visible, best first', async () => {
        const hits = await big.searchByVector([1, 0, 0, 0], { topK: 10, actorScopes: ['team-a'] });
        assert.equal(hits.length, 10);
        for (const h of hits) assert.deepEqual(h.metadata.security_scopes, ['team-a'], h.id);
        const scores = hits.map((h) => h.score);
        assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'result is ordered by score');
        // HNSW is approximate and relaxed_order may reorder neighbours: require near-exact recall against a brute-force scan.
        const c = await pool.connect();
        let visible: string[];
        try {
            await c.query('BEGIN');
            await c.query('SET LOCAL enable_indexscan = off'); await c.query('SET LOCAL enable_bitmapscan = off'); await c.query('SET LOCAL enable_seqscan = on');
            visible = (await c.query<{ id: string }>(
                `SELECT id FROM verbatim WHERE workspace_id=$1 AND is_canonical=1 AND is_tombstone=0 AND security_scope_arr && ARRAY['team-a'] ORDER BY vector <=> '[1,0,0,0]'::vector, id LIMIT 10`,
                [wsBig])).rows.map((r) => r.id);
            await c.query('ROLLBACK');
        } finally { c.release(); }
        const overlap = ids(hits).filter((x) => visible.includes(x)).length;
        assert.ok(overlap >= 7, `recall ${overlap}/10 against the brute-force nearest visible rows`);
    });

    await test('searchByVectors: every key gets a full topK at 5% visibility', async () => {
        const qs = [0, 5, 10, 20].map((d) => ({ key: `q${d}`, vector: [1, 0.01 * d, 0.005 * d, 0] }));
        const out = await big.searchByVectors(qs, { topK: 10, actorScopes: ['team-a'] });
        for (const q of qs) {
            const hits = out.get(q.key)!;
            assert.equal(hits.length, 10, q.key);
            assert.ok(hits.every((h) => (h.metadata.security_scopes ?? []).includes('team-a')));
            const single = ids(await big.searchByVector(q.vector, { topK: 10, actorScopes: ['team-a'] }));
            assert.ok(ids(hits).filter((x) => single.includes(x)).length >= 7, `${q.key}: batched and single agree`);
        }
    });

    await test('bm25Search: full limit at 5% visibility (hidden rows outrank the visible ones)', async () => {
        const env = await big.bm25Search('zebra', 10, undefined, ['team-a']);
        assert.equal(env.hits.length, 10);
        assert.ok(env.hits.every((h) => (h.metadata.security_scopes ?? []).includes('team-a')));
        const all = await big.bm25Search('zebra', 10, undefined, ['team-b']);
        assert.equal(all.hits.length, 10);
        assert.ok(all.hits.every((h) => (h.metadata.security_scopes ?? []).includes('team-b')));
    });

    await test('policy: [] sees public rows only, undefined sees everything, a mix sees the union', async () => {
        const s = await open(pool, 'l4-policy');
        await s.bulkAddPrebuiltRows([
            row('pub1', 0, []), row('pub2', 1, []), row('a1', 2, ['team-a']), row('b1', 3, ['team-b']), row('ab', 4, ['team-a', 'team-b']), row('c1', 5, ['team-c']),
        ]);
        const q = at(0);
        const sorted = (h: Array<{ id: string }>): string[] => ids(h).sort();
        assert.deepEqual(sorted(await s.searchByVector(q, { topK: 20, actorScopes: [] })), ['pub1', 'pub2']);
        assert.deepEqual(sorted(await s.searchByVector(q, { topK: 20 })), ['a1', 'ab', 'b1', 'c1', 'pub1', 'pub2']);
        assert.deepEqual(sorted(await s.searchByVector(q, { topK: 20, actorScopes: ['team-a'] })), ['a1', 'ab', 'pub1', 'pub2']);
        assert.deepEqual(sorted(await s.searchByVector(q, { topK: 20, actorScopes: ['team-b', 'team-c'] })), ['ab', 'b1', 'c1', 'pub1', 'pub2']);
        assert.deepEqual(sorted(await s.searchByVector(q, { topK: 20, actorScopes: ['nope'] })), ['pub1', 'pub2']);
        const many = await s.searchByVectors([{ key: 'k', vector: q }], { topK: 20, actorScopes: [] });
        assert.deepEqual(sorted(many.get('k')!), ['pub1', 'pub2']);
        const kw = (scopes?: string[]) => s.bm25Search('text', 20, undefined, scopes).then((e) => sorted(e.hits));
        assert.deepEqual(await kw([]), ['pub1', 'pub2']);
        assert.deepEqual(await kw(undefined), ['a1', 'ab', 'b1', 'c1', 'pub1', 'pub2']);
        assert.deepEqual(await kw(['team-a']), ['a1', 'ab', 'pub1', 'pub2']);
    });

    await test('fail closed: a row whose scope text cannot be read is invisible to scoped actors', async () => {
        const s = await open(pool, 'l4-sentinel');
        await s.bulkAddPrebuiltRows([row('ok', 0, [])]);
        await pool.query(
            `INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at, security_scopes)
             VALUES ('l4-sentinel', 'bad', 'bad text', '[1,0,0,0]'::vector, 'x', 'x', 'not json')`);
        assert.deepEqual(ids(await s.searchByVector(at(0), { topK: 10, actorScopes: [] })), ['ok']);
        assert.deepEqual(ids(await s.searchByVector(at(0), { topK: 10, actorScopes: ['team-a'] })), ['ok']);
    });

    // ---- plan / pgvector behaviour ---------------------------------------------------------------------------------
    await test('EXPLAIN: the scoped vector query uses the HNSW index with the scope predicate in the same scan', async () => {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
            await c.query('SET LOCAL enable_bitmapscan = off');
            const plan = (await c.query<Record<string, string>>(
                `EXPLAIN (COSTS OFF) SELECT id FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0
                    AND (cardinality(security_scope_arr) = 0 OR security_scope_arr && $2::text[])
                  ORDER BY vector <=> $3::vector LIMIT 10`, [wsBig, ['team-a'], '[1,0,0,0]'])).rows.map((r) => r['QUERY PLAN']).join('\n');
            await c.query('ROLLBACK');
            console.log(plan.split('\n').map((l) => `      ${l}`).join('\n'));
            assert.match(plan, /Index Scan using \S*vector_idx/);
            const idxName = /Index Scan using (\S+)/.exec(plan)![1]!;
            const am = (await pool.query<{ amname: string }>(`SELECT am.amname FROM pg_class ic JOIN pg_am am ON am.oid = ic.relam WHERE ic.relname = $1`, [idxName])).rows[0]!.amname;
            assert.equal(am, 'hnsw');
            assert.match(plan, /security_scope_arr/);
            assert.doesNotMatch(plan, /Seq Scan/);
        } finally { c.release(); }
    });

    await test('why SET LOCAL hnsw.iterative_scan matters: without it the same SQL starves at 5% visibility', async () => {
        const c = await pool.connect();
        try {
            const run = async (mode: 'off' | 'relaxed_order'): Promise<number> => {
                await c.query('BEGIN');
                await c.query(`SET LOCAL hnsw.iterative_scan = ${mode}`);
                await c.query('SET LOCAL enable_bitmapscan = off');
                const n = (await c.query(
                    `SELECT id FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0
                        AND (cardinality(security_scope_arr) = 0 OR security_scope_arr && $2::text[])
                      ORDER BY vector <=> $3::vector LIMIT 10`, [wsBig, ['team-a'], '[1,0,0,0]'])).rowCount ?? 0;
                await c.query('ROLLBACK');
                return n;
            };
            assert.ok(await run('off') < 10, 'control: without iterative scan the index scan starves');
            assert.equal(await run('relaxed_order'), 10);
        } finally { c.release(); }
    });

    // ---- old bundle -------------------------------------------------------------------------------------------------
    await test('a bundle exported by main (before this change) restores, and security_scope_arr is derived from the TEXT column', async () => {
        const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'pg-bundle-pre-scope-arr.ndjson.gz');
        const bundleText = zlib.gunzipSync(fs.readFileSync(fixture)).toString('utf8');
        assert.ok(!bundleText.includes('security_scope_arr'), 'fixture really predates the column');
        const summary = await restoreWorkspaceBundle(pool, { bundlePath: fixture, targetWorkspaceId: 'l4-restored' });
        assert.equal(summary.totalRows, 12);
        const r = await pool.query<{ id: string; s: string | null; a: string[] }>(
            `SELECT id, security_scopes AS s, security_scope_arr AS a FROM verbatim WHERE workspace_id='l4-restored' ORDER BY id`);
        assert.equal(r.rowCount, 12);
        for (const x of r.rows) assert.deepEqual(x.a, scopesJsonToArray(x.s), x.id);
        const byId = new Map(r.rows.map((x) => [x.id, x.a]));
        assert.deepEqual(byId.get('old2'), ['team-a']);
        assert.deepEqual(byId.get('old3'), ['team-a', 'team-b']);
        assert.deepEqual(byId.get('old5'), ['team-a', 'team-c']);
        assert.deepEqual(byId.get('old0'), []);
        // and the restored workspace is searchable under scope policy
        const s = await open(pool, 'l4-restored');
        const pub = ids(await s.searchByVector(at(0), { topK: 20, actorScopes: [] })).sort();
        assert.deepEqual(pub, ['old0', 'old1', 'old6', 'old7']);
        const a = ids(await s.searchByVector(at(0), { topK: 20, actorScopes: ['team-a'] })).sort();
        assert.deepEqual(a, ['old0', 'old1', 'old11', 'old2', 'old3', 'old5', 'old6', 'old7', 'old8', 'old9']);
    });
    // ---- bootstrap on a main-shaped database -------------------------------------------------------------------------
    await test('bootstrap on a database as main left it: backfills in batches, builds the index concurrently, second run is a no-op', async () => {
        const ws = 'l4-main-shaped';
        const s = await open(pool, ws);
        await s.bulkAddPrebuiltRows(Array.from({ length: 40 }, (_, i) => row(`m${i}`, i, i % 4 === 0 ? ['team-a'] : i % 4 === 1 ? ['team-a', 'team-b'] : [])));
        // Put the schema back the way main created it: no column, no trigger, no scope index, no backfill marker.
        await pool.query(`DROP TRIGGER IF EXISTS verbatim_scope_arr_biu ON verbatim`);
        await pool.query(`ALTER TABLE verbatim DROP COLUMN security_scope_arr`);
        const parts = (await pool.query<{ p: string }>(
            `SELECT c.relname AS p FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='verbatim'::regclass AND pg_get_expr(c.relpartbound,c.oid) = $1`,
            [`FOR VALUES IN ('${ws}')`])).rows;
        assert.equal(parts.length, 1);
        await pool.query(`COMMENT ON TABLE ${parts[0]!.p} IS NULL`);
        assert.equal((await pool.query(`SELECT 1 FROM pg_attribute WHERE attrelid='verbatim'::regclass AND attname='security_scope_arr' AND NOT attisdropped`)).rowCount, 0);

        const c = await pool.connect();
        try { await ensureVerbatimSchema(c, ws, DIM); } finally { c.release(); }

        const got = await pool.query<{ id: string; s: string | null; a: string[] }>(
            `SELECT id, security_scopes AS s, security_scope_arr AS a FROM verbatim WHERE workspace_id=$1`, [ws]);
        assert.equal(got.rowCount, 40);
        for (const r of got.rows) assert.deepEqual(r.a, scopesJsonToArray(r.s), r.id);
        assert.ok(got.rows.some((r) => r.a.length === 2) && got.rows.some((r) => r.a.length === 0));
        const marker = (await pool.query<{ d: string | null }>(`SELECT obj_description($1::regclass) AS d`, [parts[0]!.p])).rows[0]!.d;
        assert.equal(marker, SCOPE_BACKFILL_MARKER);
        const idx = await pool.query<{ valid: boolean; attached: number }>(
            `SELECT i.indisvalid AS valid,
                    (SELECT count(*)::int FROM pg_inherits h WHERE h.inhparent = i.indexrelid) AS attached
               FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'verbatim_scope_arr_gin'`);
        assert.equal(idx.rowCount, 1);
        assert.equal(idx.rows[0]!.valid, true);
        assert.ok(idx.rows[0]!.attached >= 1, 'the partition index is attached to the parent');
        // main-shaped DB, new column: search works and is scoped
        assert.deepEqual(ids(await s.searchByVector(at(0), { topK: 50, actorScopes: [] })).length, 20);

        // second bootstrap: nothing is rewritten (xmin of every row unchanged), nothing fails
        const xminBefore = (await pool.query(`SELECT id, xmin::text AS x FROM verbatim WHERE workspace_id=$1 ORDER BY id`, [ws])).rows;
        const c2 = await pool.connect();
        try { await ensureVerbatimSchema(c2, ws, DIM); await ensureVerbatimSchema(c2, ws, DIM); } finally { c2.release(); }
        const xminAfter = (await pool.query(`SELECT id, xmin::text AS x FROM verbatim WHERE workspace_id=$1 ORDER BY id`, [ws])).rows;
        assert.deepEqual(xminAfter, xminBefore);
    });

    await test('an INVALID scope index left by a cancelled CREATE INDEX CONCURRENTLY is dropped and rebuilt', async () => {
        const ws = 'l4-invalid-idx';
        await open(pool, ws);
        const part = (await pool.query<{ p: string }>(
            `SELECT c.relname AS p FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='verbatim'::regclass AND pg_get_expr(c.relpartbound,c.oid) = $1`,
            [`FOR VALUES IN ('${ws}')`])).rows[0]!.p;
        // The shape a cancelled build leaves: no parent index, an unattached INVALID index on the partition.
        await pool.query(`DROP INDEX verbatim_scope_arr_gin`);
        await pool.query(`CREATE INDEX CONCURRENTLY ${part}_scope_arr_gin ON ${part} USING gin(security_scope_arr)`);
        await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${part}_scope_arr_gin'::regclass`);
        const c = await pool.connect();
        try { await ensureVerbatimSchema(c, ws, DIM); } finally { c.release(); }
        const st = await pool.query<{ rel: string; valid: boolean }>(
            `SELECT c.relname AS rel, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'verbatim_scope_arr_gin' OR c.relname = '${part}_scope_arr_gin'`);
        assert.ok(st.rows.length >= 2 && st.rows.every((x) => x.valid), JSON.stringify(st.rows));
        const unattached = await pool.query(
            `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
              WHERE t.relkind = 'r' AND t.relname LIKE 'verbatim\\_ws\\_%' AND c.relname LIKE '%scope_arr_gin'
                AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = c.oid)`);
        assert.equal(unattached.rowCount, 0, 'every partition scope index is attached to the parent');
    });
} finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    await closePostgresPool(pool).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    if (!process.env['L4_KEEP_DB']) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
