/**
 * test/pg-restore-partition-rekey-guard-unit.ts - two Postgres-engine fixes.
 *
 * 1. Restore into a NEW workspace provisions the verbatim partition under the RUNTIME's name
 *    (`verbatim_ws_<24 hex>`), so the restored workspace opens, recalls by vector and accepts new writes. Before the
 *    fix restore used the generic `<table>_ws_<12 hex>` name; the runtime then could not create its own partition (the
 *    bound overlaps), the open failed and writes dead-lettered. A workspace already restored that way (3.37.0/3.37.1)
 *    is healed by the runtime reusing the partition that holds its bound. Generic tables keep the generic name.
 * 2. Re-key mixed-key guard for an ALREADY re-keyed workspace: if an older build writes name-keyed rows after the
 *    upgrade, the next open refuses with `postgres_rekey_mixed_keys` and changes nothing; no stragglers -> opens fine.
 *
 * Needs a throwaway Postgres with pgvector (`LORE_PG_URL`); unset -> prints the reason, exits 0. Creates and drops its
 * own database (`lore_pgfix_<pid>`) and its own registry home.
 *
 * Run: npx tsx test/pg-restore-partition-rekey-guard-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool, type PoolClient } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { verbatimPartitionName } from '../packages/lore/src/engines/postgres/postgresVerbatimPartitionDdl.js';
import { ensureWorkspacePartition } from '../packages/lore/src/engines/postgres/postgresWorkspacePartitions.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { resolvePostgresWorkspaceKey } from '../packages/lore/src/engines/postgres/postgresWorkspaceKey.js';
import { PostgresRekeyConflictError, REKEY_LEDGER_TABLE } from '../packages/lore/src/engines/postgres/postgresRekey.js';
import { backupPostgresWorkspace, restoreLogicalBundleCli } from '../packages/lore/src/cli/commands/backupPostgres.js';
import { writeControl, type WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { gateDbUrl, stampGateManifest } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-restore-partition-rekey-guard-unit: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}
const DB = `lore_pgfix_${process.pid}`;
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
const DIM = 4;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pgfix-home-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgfix-out-'));
process.env['LORE_HOME'] = HOME;
process.env['LORE_PG_URL'] = dbUrl.toString();

const SRC = '33333333-cccc-4ccc-8ccc-000000000001';
const DST = '33333333-cccc-4ccc-8ccc-000000000002';
const HEAL = '33333333-cccc-4ccc-8ccc-000000000003';
const DELTA = '33333333-cccc-4ccc-8ccc-000000000004';
const CLEAN = '33333333-cccc-4ccc-8ccc-000000000005';
const entry = (name: string, id: string): WorkspaceEntry => ({
    name, id, path: path.join(HOME, 'ws', name), createdAt: '2026-01-01T00:00:00Z', graphEngine: 'postgres', vectorEngine: 'postgres',
} as WorkspaceEntry);
const E = { src: entry('pf-src', SRC), dst: entry('pf-dst', DST), heal: entry('pf-heal', HEAL), delta: entry('pf-delta', DELTA), clean: entry('pf-clean', CLEAN) };
const entries = Object.values(E);
for (const e of entries) fs.mkdirSync(e.path, { recursive: true });
writeControl({ active: 'pf-src', workspaces: entries } as never, HOME);

/** A fixed 4-d embedder: documents carry their own vectors, the query points at axis 0. */
class FixedEmbedder implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'pg-fix-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embed(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embedDocument(): Promise<number[]> { return [1, 0, 0, 0]; }
}
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgfix-base-'));
stampGateManifest(baseDir, 'pg-fix-fixed', DIM);

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

const doc = (id: string, text: string) => ({ id, text, vector: [1, 0, 0, 0], metadata: { type: 'note', label: id } });
async function openStore(key: string): Promise<PostgresVerbatimStore> {
    const s = new PostgresVerbatimStore(baseDir, pool, key, new FixedEmbedder());
    await s.initialize();
    return s;
}
const partitionsOf = async (id: string): Promise<string[]> => (await q<{ relname: string }>(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'verbatim'::regclass AND pg_get_expr(c.relpartbound, c.oid) = $1`,
    [`FOR VALUES IN ('${id}')`])).map((r) => r.relname);
const rowsUnder = async (table: string, key: string): Promise<number> =>
    Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE workspace_id = $1`, [key]))[0]!.n);
const ledger = async (): Promise<string[]> => (await q<{ key_id: string }>(`SELECT key_id FROM ${REKEY_LEDGER_TABLE} ORDER BY key_id`)).map((r) => r.key_id);

async function openViaResolver(p: Pool, name: string): Promise<string> {
    const key = resolvePostgresWorkspaceKey(name, HOME);
    const g = new PostgresGraph(key, p);
    await g.initialize();
    await g.close();
    return key;
}
async function seedNodes(key: string, n: number, from = 0): Promise<void> {
    const g = new PostgresGraph(key, pool);
    await g.initialize();
    for (let i = from; i < from + n; i++) {
        await g.upsertNode({ id: `n${i}`, type: 'note', label: `label ${i}`, content: `content ${i}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
    }
    await g.close();
}

try {
    // Name-keyed rows exactly as 3.36.0 wrote them. They must exist BEFORE the first store opens through the resolver,
    // because that first open re-keys every registry workspace (and records each in the ledger).
    await seedNodes('pf-delta', 3);
    await seedNodes('pf-clean', 2);

    // ---- 1. restore into a new workspace --------------------------------------------------------------------
    const deps = { workspaceDir: (n: string) => entries.find((e) => e.name === n)?.path ?? null, daemonServesHome: async () => false, daemonMessage: 'daemon' };
    let bundle = '';

    await test('restore into a new workspace: partition carries the runtime name, the workspace opens, recalls by vector and accepts new writes', async () => {
        const src = await openStore(SRC);
        await src.storeBatch([doc('a', 'alpha restored text'), doc('b', 'beta restored text'), doc('c', 'gamma restored text')]);
        await seedNodes(SRC, 2);
        await src.close();
        bundle = (await backupPostgresWorkspace('pf-src', E.src.path, OUT, 5)).bundlePath;

        assert.equal(await restoreLogicalBundleCli(bundle, 'pf-src', 'pf-dst', { force: true, allowNameMismatch: true }, deps), true);
        assert.deepEqual(await partitionsOf(DST), [verbatimPartitionName(DST)], 'the restored partition has the runtime name, and there is only one');
        assert.equal(await rowsUnder('verbatim', DST), 3);
        assert.equal(await rowsUnder('nodes', DST), 2);

        const dst = await openStore(DST); // before the fix: "would overlap partition" here
        try {
            const hits = await dst.search('alpha', 5);
            assert.deepEqual(hits.map((h) => h.id).sort(), ['a', 'b', 'c'], 'vector recall finds the restored content');
            await dst.store(doc('d', 'delta fresh write after the restore'));
            assert.ok(await dst.getById('d'), 'a new write on the restored workspace succeeds');
            assert.equal((await dst.search('delta', 10)).length, 4);
        } finally { await dst.close(); }
        assert.equal(await rowsUnder('verbatim', DST), 4);
        assert.deepEqual(await partitionsOf(DST), [verbatimPartitionName(DST)]);
    });

    await test('the restored partition carries the parent\'s indexes (HNSW, GIN) like a runtime-made one', async () => {
        const idx = async (rel: string): Promise<string[]> => (await q<{ i: string }>(
            `SELECT pg_get_indexdef(x.indexrelid) AS i FROM pg_index x WHERE x.indrelid = $1::regclass ORDER BY 1`, [rel])).map((r) => r.i.replace(/ON \S+ USING/, 'ON <t> USING').replace(/INDEX \S+ ON/, 'INDEX <i> ON'));
        const restored = await idx(verbatimPartitionName(DST));
        const src = await idx(verbatimPartitionName(SRC));
        assert.deepEqual(restored, src);
        assert.ok(restored.some((x) => /hnsw/.test(x)) && restored.some((x) => /gin/.test(x)), restored.join('\n'));
    });

    await test('a partition another path created under a different name (restored by 3.37.0/3.37.1) is reused, not duplicated: the workspace opens and writes', async () => {
        await pool.query(`CREATE TABLE verbatim_ws_aaaaaaaaaaaa PARTITION OF verbatim FOR VALUES IN ('${HEAL}')`);
        const s = await openStore(HEAL);
        try {
            await s.store(doc('h', 'healed workspace write'));
            assert.ok(await s.getById('h'));
        } finally { await s.close(); }
        assert.deepEqual(await partitionsOf(HEAL), ['verbatim_ws_aaaaaaaaaaaa']);
    });

    await test('a relation squatting on the runtime name that is not a partition is still refused', async () => {
        const squat = '33333333-cccc-4ccc-8ccc-0000000000ff';
        await pool.query(`CREATE TABLE ${verbatimPartitionName(squat)} (x int)`);
        const c: PoolClient = await pool.connect();
        try {
            const { ensureWorkspacePartition: ensureV } = await import('../packages/lore/src/engines/postgres/postgresVerbatimPartitionDdl.js');
            await assert.rejects(ensureV(c, squat), /not a partition/);
        } finally { c.release(); }
    });

    await test('generic list-partitioned tables keep the generic name (<table>_ws_<12 hex>)', async () => {
        await pool.query(`CREATE TABLE pf_parted (workspace_id TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (workspace_id, k)) PARTITION BY LIST (workspace_id)`);
        const c: PoolClient = await pool.connect();
        try {
            const table = { name: 'pf_parted', qualified: '"public"."pf_parted"', partitioned: true } as never;
            await ensureWorkspacePartition(c, table, DST);
            await ensureWorkspacePartition(c, table, DST); // idempotent
        } finally { c.release(); }
        const parts = (await q<{ relname: string }>(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'pf_parted'::regclass`)).map((r) => r.relname);
        assert.equal(parts.length, 1);
        assert.match(parts[0]!, /^pf_parted_ws_[0-9a-f]{12}$/);
    });

    // ---- 2. mixed-key guard for an already re-keyed workspace ---------------------------------------------------
    await test('upgrade re-keys both workspaces (ledger rows recorded)', async () => {
        await openViaResolver(newPool(), 'pf-delta');
        assert.ok((await ledger()).includes(DELTA) && (await ledger()).includes(CLEAN), (await ledger()).join(','));
        assert.equal(await rowsUnder('nodes', DELTA), 3);
        assert.equal(await rowsUnder('nodes', 'pf-delta'), 0);
    });

    await test('recorded workspace WITHOUT stragglers opens fine, repeatedly, and changes nothing', async () => {
        const before = await ledger();
        await openViaResolver(newPool(), 'pf-clean');
        await openViaResolver(newPool(), 'pf-clean');
        assert.deepEqual(await ledger(), before);
        assert.equal(await rowsUnder('nodes', CLEAN), 2);
    });

    await test('recorded workspace + name-keyed rows written by an older build: open refuses with postgres_rekey_mixed_keys, every time, and changes nothing', async () => {
        await seedNodes('pf-delta', 3, 100); // the old build writes under the NAME again
        const snapshot = async () => ({ name: await rowsUnder('nodes', 'pf-delta'), id: await rowsUnder('nodes', DELTA), ledger: await ledger() });
        const before = await snapshot();
        assert.equal(before.name, 3);
        for (let i = 0; i < 2; i++) {
            await assert.rejects(openViaResolver(newPool(), 'pf-delta'), (e: unknown) => {
                assert.ok(e instanceof PostgresRekeyConflictError, String(e));
                assert.equal(e.code, 'postgres_rekey_mixed_keys');
                assert.equal(e.id, DELTA);
                assert.deepEqual(e.names, ['pf-delta']);
                assert.ok(e.tables.includes('nodes'), e.tables.join(','));
                assert.match(e.message, /older Lore build/);
                return true;
            });
        }
        assert.deepEqual(await snapshot(), before, 'nothing merged, moved or recorded');
    });

    await test('the straggler guard also covers a store opened through PostgresVerbatimStore (the open that dead-lettered)', async () => {
        const s = new PostgresVerbatimStore(baseDir, newPool(), DELTA, new FixedEmbedder());
        await assert.rejects(s.initialize(), (e: unknown) => e instanceof PostgresRekeyConflictError);
    });

    await test('other workspaces are not blocked by one workspace\'s stragglers', async () => {
        await openViaResolver(newPool(), 'pf-clean');
    });

    await test('after the operator removes the stragglers the workspace opens again', async () => {
        await pool.query(`DELETE FROM nodes WHERE workspace_id = 'pf-delta'`);
        await openViaResolver(newPool(), 'pf-delta');
        assert.equal(await rowsUnder('nodes', DELTA), 3);
    });

    await test('cost: the check on a recorded workspace is one catalog lookup plus one combined query, and rewrites nothing', async () => {
        const p = newPool();
        const raw: string[] = [];
        const realConnect = p.connect.bind(p) as (...a: unknown[]) => Promise<PoolClient>;
        (p as unknown as { connect: (...a: unknown[]) => Promise<PoolClient> }).connect = async (...a) => {
            const c = await realConnect(...a);
            const realQuery = c.query.bind(c) as (...x: unknown[]) => unknown;
            (c as unknown as { query: (...x: unknown[]) => unknown }).query = (...x) => {
                const t = x[0]; raw.push(typeof t === 'string' ? t : (t as { text?: string })?.text ?? '');
                return realQuery(...x);
            };
            return c;
        };
        // The startup wrapper reports each client statement twice; collapse adjacent repeats to count real statements.
        const t0 = process.hrtime.bigint();
        await openViaResolver(p, 'pf-delta');
        const seen = raw.filter((x, i) => i === 0 || x !== raw[i - 1]);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const unions = seen.filter((s) => /SELECT 0::int AS i FROM/.test(s));
        const keyed = (await q<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id' AND a.attnum>0 AND NOT a.attisdropped
              WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition`))[0]!.n;
        console.log(`      info: recorded-workspace open on ${keyed} keyed tables: ${seen.length} statements total, ${unions.length} straggler query, ${ms.toFixed(0)} ms wall`);
        assert.equal(unions.length, 1, 'one combined straggler query');
        assert.ok(!seen.some((s) => /UPDATE .* SET workspace_id/.test(s)), 'nothing was rewritten');
    });
} finally {
    await closeSharedPostgresPool().catch(() => undefined);
    for (const p of pools) await closePostgresPool(p).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    for (const d of [HOME, OUT, baseDir]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
