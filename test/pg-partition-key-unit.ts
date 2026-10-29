#!/usr/bin/env tsx
/**
 * test/pg-partition-key-unit.ts - Phase 0 lane L3 on Postgres: `partition_key` (nodes / edges / verbatim) and
 * `nodes.created_at_ts`.
 *
 * Runs against a throwaway database `lore_p0l3_<pid>` created on the LORE_PG_URL server (skips with a printed
 * reason when LORE_PG_URL is unset). Never prints the URL.
 *
 *   schema        the three partition_key columns are TEXT NOT NULL DEFAULT ''; created_at_ts is TIMESTAMPTZ; the
 *                 pending-backfill index is valid
 *   bootstrap     a database seeded from the pre-L3 shape (columns dropped) gains every column on open, the backfill
 *                 fills created_at_ts in batches, and a SECOND open runs no ALTER on nodes/edges/verbatim and rewrites
 *                 no row
 *   node writes   every write path stores the key and created_at_ts (upsert, insertNodeIfAbsent, upsertNodeAtRevision,
 *                 bulkUpsertNodes, importRaw, commitNodeBatch); an unkeyed node carries no `partitionKey` property
 *   immutability  '' -> 'x' allowed; 'x' -> 'y' and 'x' -> '' refused with PARTITION_KEY_IMMUTABLE on every path;
 *                 omitting the key keeps it; an in-SQL guard refuses a concurrent keyed writer
 *   edges         an edge inherits its SOURCE node's key (addEdge, importRaw)
 *   verbatim      the store writes / keeps / reports the key; the legacy plain-table migration gains the column
 *   backup        export -> restore round-trips partition_key on all three tables
 *
 * Run: npx tsx test/pg-partition-key-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool, type PoolClient } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { createPostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { runSchemaBootstrap } from '../packages/lore/src/engines/postgres/postgresStartup.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { ensurePartitionColumns, backfillCreatedAtTs } from '../packages/lore/src/engines/postgres/postgresPartitionKeySchema.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { isPartitionKeyImmutable } from '../packages/lore/src/engines/graphShared/partitionKey.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { gateDbUrl, stampGateManifest } from './helpers/testPostgres.js';

const DB = `lore_p0l3_${process.pid}`;
const WS = 'p0l3-ws';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-partition-key: LORE_PG_URL is not set - postgres cases skipped cleanly');
    process.exit(0);
}
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });

class Emb implements EmbeddingProvider {
    readonly dimension = 4; readonly modelId = 'p0l3-fixed'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedDocument(_t?: string): Promise<number[]> { return [0.5, 0.5, 0.5, 0.5]; }
}

const node = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}', ...over }) as never;
const open = async (ws = WS): Promise<PostgresGraph> => { const g = new PostgresGraph(ws, pool); await g.initialize(); return g; };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const pk = async (id: string, ws = WS): Promise<string | undefined> =>
    (await q<{ partition_key: string }>('SELECT partition_key FROM nodes WHERE workspace_id = $1 AND id = $2', [ws, id]))[0]?.partition_key;
const caTs = async (id: string): Promise<{ createdAt: string; ts: string | null }> => (await q<{ createdAt: string; ts: string | null }>(
    `SELECT "createdAt", to_char(created_at_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts FROM nodes WHERE workspace_id = $1 AND id = $2`, [WS, id]))[0]!;
const refused = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
    let err: unknown;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(isPartitionKeyImmutable(err), `${label}: expected PARTITION_KEY_IMMUTABLE, got ${err instanceof Error ? err.message : String(err)}`);
};
const PRE = /ALTER TABLE (nodes|edges|verbatim)\b.*(partition_key|created_at_ts)/is;

try {
    console.log('\nschema');
    const g = await open();
    await test('partition_key is TEXT NOT NULL DEFAULT \'\' on nodes, edges and verbatim; created_at_ts is timestamptz', async () => {
        const c = await q<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
            `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = current_schema() AND column_name IN ('partition_key','created_at_ts') ORDER BY 1, 2`);
        const by = Object.fromEntries(c.map((r) => [`${r.table_name}.${r.column_name}`, r]));
        for (const t of ['nodes', 'edges']) {
            assert.equal(by[`${t}.partition_key`]?.data_type, 'text', t);
            assert.equal(by[`${t}.partition_key`]?.is_nullable, 'NO', t);
            assert.match(String(by[`${t}.partition_key`]?.column_default), /''/, t);
        }
        assert.equal(by['nodes.created_at_ts']?.data_type, 'timestamp with time zone');
        assert.equal(by['nodes.created_at_ts']?.is_nullable, 'YES');
    });
    // verbatim is created by the store (needs a manifest + embedder); open one for its workspace.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p0l3-vb-'));
    stampGateManifest(base, 'p0l3-fixed', 4);
    const vs = new PostgresVerbatimStore(base, pool, WS, new Emb());
    await vs.initialize();
    await test('verbatim.partition_key exists, NOT NULL DEFAULT \'\'', async () => {
        const c = await q<{ is_nullable: string; column_default: string | null }>(
            `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'verbatim' AND column_name = 'partition_key'`);
        assert.equal(c.length, 1);
        assert.equal(c[0]!.is_nullable, 'NO');
        assert.match(String(c[0]!.column_default), /''/);
    });
    await test('the pending-backfill index exists and is valid', async () => {
        const r = await q<{ indisvalid: boolean }>(
            `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_nodes_created_at_ts_pending'`);
        assert.equal(r.length, 1);
        assert.equal(r[0]!.indisvalid, true);
    });

    console.log('\nnode writes');
    await test('upsertNode stores the key and created_at_ts; getNode / getNodesByIds / listNodes report the key', async () => {
        const w = await g.upsertNode(node('k1', { partitionKey: 'tenant-a' }));
        assert.equal(w.partitionKey, 'tenant-a');
        assert.equal(await pk('k1'), 'tenant-a');
        const t = await caTs('k1');
        assert.equal(t.ts, new Date(t.createdAt).toISOString());
        assert.equal((await g.getNode('k1'))?.partitionKey, 'tenant-a');
        assert.equal((await g.getNodesByIds(['k1'])).get('k1')?.partitionKey, 'tenant-a');
        assert.equal((await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true })).find((n) => n.id === 'k1')?.partitionKey, 'tenant-a');
        const page = await g.bulkList({ limit: 100 });
        assert.equal(page.nodes.find((n) => n['id'] === 'k1')?.['partitionKey'], 'tenant-a', 'bulkList (export) carries the key');
        assert.ok(!('partition_key' in page.nodes[0]!), 'the raw column is not leaked');
    });
    await test('an unkeyed node stores \'\' and has NO partitionKey property on any read (output shape unchanged)', async () => {
        const w = await g.upsertNode(node('u1'));
        assert.ok(!('partitionKey' in w), 'upsert result');
        assert.equal(await pk('u1'), '');
        assert.ok(!('partitionKey' in ((await g.getNode('u1')) as object)), 'getNode');
        assert.ok(!('partitionKey' in ((await g.getNodesByIds(['u1'])).get('u1') as object)), 'getNodesByIds');
        assert.ok(!('partitionKey' in (await g.bulkList({ limit: 1000 })).nodes.find((n) => n['id'] === 'u1')!), 'bulkList');
    });
    await test('insertNodeIfAbsent / upsertNodeAtRevision / bulkUpsertNodes store the key and created_at_ts', async () => {
        await g.insertNodeIfAbsent(node('i1', { partitionKey: 'tenant-b' }));
        assert.equal(await pk('i1'), 'tenant-b');
        assert.ok((await caTs('i1')).ts);
        await g.upsertNodeAtRevision(node('r1', { partitionKey: 'tenant-b' }), 0, '2026-02-01T00:00:00.000Z');
        assert.equal(await pk('r1'), 'tenant-b');
        assert.equal((await caTs('r1')).ts, '2026-02-01T00:00:00.000Z');
        await g.bulkUpsertNodes([node('b1', { partitionKey: 'tenant-c' }), node('b2')]);
        assert.equal(await pk('b1'), 'tenant-c');
        assert.equal(await pk('b2'), '');
        assert.ok((await caTs('b2')).ts);
    });
    await test('importRaw and commitNodeBatch store the key', async () => {
        const now = '2026-03-01T00:00:00.000Z';
        await g.importRaw([{ ...(node('imp1', { partitionKey: 'tenant-d' }) as object), createdAt: now, updatedAt: now, syncedAt: now } as never], []);
        assert.equal(await pk('imp1'), 'tenant-d');
        assert.equal((await caTs('imp1')).ts, now);
        const out = await g.commitNodeBatch([], [{ kind: 'insert', node: node('cb1', { partitionKey: 'tenant-e' }), updatedAt: now }] as never);
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.equal(await pk('cb1'), 'tenant-e');
        assert.equal((await caTs('cb1')).ts, now);
    });

    console.log('\nimmutability');
    await test("'' -> 'x' is allowed (keying a legacy node); same key and omitted key are fine", async () => {
        await g.upsertNode(node('m1'));
        assert.equal(await pk('m1'), '');
        await g.upsertNode(node('m1', { partitionKey: 'x' }));
        assert.equal(await pk('m1'), 'x');
        await g.upsertNode(node('m1', { partitionKey: 'x', label: 'again' }));
        await g.upsertNode(node('m1', { label: 'no key given' }));
        assert.equal(await pk('m1'), 'x', 'an omitted key keeps the stored one');
        assert.equal((await g.getNode('m1'))?.partitionKey, 'x');
    });
    await test("'x' -> 'y' and 'x' -> '' are refused on upsertNode, insert paths, bulk and batch; the row is unchanged", async () => {
        await refused(() => g.upsertNode(node('m1', { partitionKey: 'y' })), 'upsertNode x->y');
        await refused(() => g.upsertNode(node('m1', { partitionKey: '' })), 'upsertNode x->empty');
        const rev = (await g.getNode('m1'))!.revision!;
        await refused(() => g.upsertNodeAtRevision(node('m1', { partitionKey: 'y' }), rev, '2026-04-01T00:00:00.000Z'), 'upsertNodeAtRevision');
        const bulk = await g.bulkUpsertNodes([node('m1', { partitionKey: 'y' })]);
        assert.equal(bulk[0]?.ok, false, 'bulkUpsertNodes reports the refusal per item');
        assert.match(String(bulk[0]?.error), /PARTITION_KEY_IMMUTABLE/);
        await refused(() => g.commitNodeBatch([], [{ kind: 'cas', node: node('m1', { partitionKey: 'y' }), expectedRevision: rev, mustExist: true, updatedAt: '2026-04-01T00:00:00.000Z' }] as never), 'commitNodeBatch');
        assert.equal(await pk('m1'), 'x');
        assert.equal((await g.getNode('m1'))?.label, 'no key given', 'a refused write changed nothing');
    });
    await test('the in-SQL guard refuses a writer that read before another writer keyed the row', async () => {
        await g.upsertNode(node('race1'));
        // Writer B keys the row directly (as a concurrent daemon would) after writer A already decided the row is unkeyed.
        const gA = await open();
        await q("UPDATE nodes SET partition_key = 'first' WHERE workspace_id = $1 AND id = 'race1'", [WS]);
        await refused(() => gA.upsertNode(node('race1', { partitionKey: 'second' })), 'racing writer');
        assert.equal(await pk('race1'), 'first');
        await gA.close();
    });

    console.log('\nedges');
    await test('an edge inherits the SOURCE node\'s key (addEdge, importRaw); an unkeyed source gives \'\'', async () => {
        await g.upsertNode(node('es', { partitionKey: 'tenant-edge' }));
        await g.upsertNode(node('et', { partitionKey: 'other' }));
        await g.upsertNode(node('eu'));
        await g.addEdge({ sourceId: 'es', targetId: 'et', relation: 'related_to' } as never);
        await g.addEdge({ sourceId: 'eu', targetId: 'es', relation: 'related_to' } as never);
        const rows = await q<{ s: string; partition_key: string }>(
            `SELECT s.id AS s, e.partition_key FROM edges e JOIN nodes s ON s.sk = e.src_sk WHERE e.workspace_id = $1 AND s.id IN ('es','eu') ORDER BY 1`, [WS]);
        assert.deepEqual(rows.map((r) => `${r.s}:${r.partition_key}`), ['es:tenant-edge', 'eu:']);
        const now = '2026-03-01T00:00:00.000Z';
        await g.importRaw([], [{ sourceId: 'es', targetId: 'eu', relation: 'imported', confidence: 'extracted', confidenceScore: 1, createdAt: now } as never]);
        const imp = await q<{ partition_key: string }>(
            `SELECT e.partition_key FROM edges e JOIN nodes s ON s.sk = e.src_sk WHERE e.workspace_id = $1 AND e.relation = 'imported'`, [WS]);
        assert.deepEqual(imp.map((r) => r.partition_key), ['tenant-edge']);
    });

    console.log('\nverbatim');
    const vdoc = (id: string, meta: Record<string, unknown> = {}) => ({ id, text: `text ${id}`, metadata: { type: 'note', label: id, project: 'p', ecosystem: '*', ...meta } }) as never;
    const vpk = async (id: string): Promise<string | undefined> =>
        (await q<{ partition_key: string }>('SELECT partition_key FROM verbatim WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1', [WS, id]))[0]?.partition_key;
    await test('store writes the key; an undefined key keeps it; a changed explicit key rewrites the row; tombstone keeps it', async () => {
        await vs.store(vdoc('lore:v1', { partitionKey: 'tenant-v' }));
        assert.equal(await vpk('lore:v1'), 'tenant-v');
        await vs.store(vdoc('lore:v1', { /* no key given */ }));
        assert.equal(await vpk('lore:v1'), 'tenant-v', 'a keyless write keeps the existing row key');
        await vs.store(vdoc('lore:v2'));
        assert.equal(await vpk('lore:v2'), '');
        await vs.store(vdoc('lore:v2', { partitionKey: 'later' }));
        assert.equal(await vpk('lore:v2'), 'later', "'' -> key on the verbatim copy");
        await vs.storeBatch([vdoc('lore:v3', { partitionKey: 'tenant-v' }), vdoc('lore:v4')]);
        assert.equal(await vpk('lore:v3'), 'tenant-v');
        assert.equal(await vpk('lore:v4'), '');
        await vs.tombstone('lore:v1', 'p0l3 test');
        assert.equal(await vpk('lore:v1'), 'tenant-v', 'a tombstone row carries the key');
    });
    await test('getById on a keyless row is unchanged (no partitionKey property leaks into the result)', async () => {
        const r = await vs.getById('lore:v4');
        assert.ok(r);
        assert.ok(!('partitionKey' in (r as object)));
    });
    await vs.close?.();
    await g.close();

    console.log('\nbootstrap on a database seeded from the pre-L3 shape');
    await test('dropping every L3 column and re-opening restores them; created_at_ts is backfilled; second open is a no-op', async () => {
        await q('ALTER TABLE nodes DROP COLUMN partition_key, DROP COLUMN created_at_ts');
        await q('ALTER TABLE edges DROP COLUMN partition_key');
        await q('ALTER TABLE verbatim DROP COLUMN partition_key');
        await q('DROP INDEX IF EXISTS idx_nodes_created_at_ts_pending');
        await q(`INSERT INTO nodes (workspace_id, id, type, label, content, "createdAt") VALUES ($1, 'garbage-ts', 'note', 'g', 'g', 'not-a-date')`, [WS]);
        const g2 = await open();
        await g2.close();
        const cols = await q<{ table_name: string; column_name: string }>(
            `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name IN ('partition_key','created_at_ts') ORDER BY 1, 2`);
        assert.deepEqual(cols.map((c) => `${c.table_name}.${c.column_name}`), ['edges.partition_key', 'nodes.created_at_ts', 'nodes.partition_key']);
        // verbatim is re-created by the verbatim store open, not the graph bootstrap
        const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p0l3-vb2-'));
        stampGateManifest(base2, 'p0l3-fixed', 4);
        const vs2 = new PostgresVerbatimStore(base2, pool, WS, new Emb());
        await vs2.initialize();
        assert.equal((await q("SELECT 1 FROM information_schema.columns WHERE table_name = 'verbatim' AND column_name = 'partition_key'")).length, 1);
        await vs2.close?.();
        assert.equal((await q<{ c: string }>('SELECT count(*) AS c FROM nodes WHERE workspace_id = $1 AND created_at_ts IS NULL AND "createdAt" <> \'\' AND id <> $2', [WS, 'garbage-ts']))[0]!.c, '0',
            'every parseable createdAt was backfilled by the bootstrap');
        assert.equal((await caTs('garbage-ts')).ts, null, 'unparseable text stays NULL');
        assert.deepEqual(await q<{ partition_key: string }>('SELECT DISTINCT partition_key FROM nodes WHERE workspace_id = $1 AND id = $2', [WS, 'k1']), [{ partition_key: '' }],
            'rows that pre-date the column read as the empty key');
    });
    await test('backfill in batches of 5 is complete, then a second run updates 0 rows and rewrites nothing', async () => {
        await q('UPDATE nodes SET created_at_ts = NULL WHERE workspace_id = $1', [WS]);
        const c = await pool.connect();
        try {
            const n = await backfillCreatedAtTs(c, 5);
            const parseable = Number((await q<{ c: string }>(`SELECT count(*) AS c FROM nodes WHERE workspace_id = $1 AND id <> 'garbage-ts'`, [WS]))[0]!.c);
            assert.equal(n, parseable);
            const before = await q<{ ctid: string; xmin: string }>('SELECT ctid::text AS ctid, xmin::text AS xmin FROM nodes WHERE workspace_id = $1 ORDER BY id', [WS]);
            assert.equal(await backfillCreatedAtTs(c, 5), 0);
            assert.equal(await backfillCreatedAtTs(c), 0);
            assert.deepEqual(await q('SELECT ctid::text AS ctid, xmin::text AS xmin FROM nodes WHERE workspace_id = $1 ORDER BY id', [WS]), before);
        } finally { c.release(); }
    });
    await test('large table (over the inline limit): bootstrap leaves the backfill + CONCURRENT index to a background job; concurrent openers do not deadlock', async () => {
        await q('UPDATE nodes SET created_at_ts = NULL WHERE workspace_id = $1', [WS]);
        await q('DROP INDEX IF EXISTS idx_nodes_created_at_ts_pending');
        const open = async (): Promise<PostgresGraph> => {
            const g = new PostgresGraph(WS, pool, { keywordIndexInlineRowLimit: 2 });
            await g.initialize();
            return g;
        };
        const left = async (): Promise<number> => Number((await q<{ c: string }>(
            `SELECT count(*) AS c FROM nodes WHERE workspace_id = $1 AND "createdAt" <> '' AND created_at_ts IS NULL AND id <> 'garbage-ts'`, [WS]))[0]!.c);
        const g1 = await open(); // the first opener only sees "pending"; the heavy work runs off the schema lock
        const settle = (g: PostgresGraph): Promise<unknown> => Promise.all([g.waitForCreatedAtTs(), g.waitForWorkspaceSk(), g.waitForKeywordIndexes()]);
        await settle(g1);
        const gs = await Promise.all([open(), open(), open(), open()]); // concurrent re-openers: the 40P01 shape, nothing left to build
        await Promise.all(gs.map(settle));
        assert.equal(await left(), 0, 'background job filled every parseable createdAt');
        assert.equal((await q<{ indisvalid: boolean }>(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_nodes_created_at_ts_pending'`))[0]?.indisvalid, true);
        // up to date: a further open reports nothing pending and does not start a job
        const g2 = await open();
        await g2.waitForCreatedAtTs();
        for (const g of [g1, ...gs, g2]) await g.close();
    });
    await test('re-opening an up-to-date database issues no ALTER of the L3 columns and ensurePartitionColumns adds nothing', async () => {
        const seen: string[] = [];
        const spy = new Proxy(pool, {
            get(t, p, r) {
                if (p === 'connect') {
                    return async (...a: unknown[]) => {
                        const cl = await (t.connect as (...x: unknown[]) => Promise<PoolClient>)(...a);
                        const orig = cl.query.bind(cl) as (...x: unknown[]) => unknown;
                        (cl as unknown as { query: unknown }).query = (...x: unknown[]) => {
                            const sql = typeof x[0] === 'string' ? x[0] : (x[0] as { text?: string })?.text ?? '';
                            if (PRE.test(sql)) seen.push(sql.slice(0, 80));
                            return orig(...x);
                        };
                        return cl;
                    };
                }
                if (p === 'query') {
                    return (...x: unknown[]) => {
                        const sql = typeof x[0] === 'string' ? x[0] : (x[0] as { text?: string })?.text ?? '';
                        if (PRE.test(sql)) seen.push(sql.slice(0, 80));
                        return (t.query as (...y: unknown[]) => unknown)(...x);
                    };
                }
                return Reflect.get(t, p, r);
            },
        }) as Pool;
        const g3 = new PostgresGraph(WS, spy);
        await g3.initialize();
        await g3.close();
        const base3 = fs.mkdtempSync(path.join(os.tmpdir(), 'p0l3-vb3-'));
        stampGateManifest(base3, 'p0l3-fixed', 4);
        const vs3 = new PostgresVerbatimStore(base3, spy, WS, new Emb());
        await vs3.initialize();
        await vs3.close?.();
        assert.deepEqual(seen, [], 'no ALTER touching partition_key / created_at_ts on re-open');
        const c = await pool.connect();
        try { assert.deepEqual(await ensurePartitionColumns(c), []); } finally { c.release(); }
        // and the whole bootstrap path directly, twice
        await runSchemaBootstrap(pool, { requirePgvector: true }, (cl) => ensureVerbatimSchema(cl, WS, 4));
        await runSchemaBootstrap(pool, { requirePgvector: true }, (cl) => ensureVerbatimSchema(cl, WS, 4));
    });
    await test('the legacy plain (pre-partitioning) verbatim table gains the column through the migration', async () => {
        // Build the legacy shape in a scratch schema-free way: a fresh DB is cheaper than undoing partitioning.
        const LEG = `${DB}_legacy`;
        await admin(`DROP DATABASE IF EXISTS ${LEG} WITH (FORCE)`);
        await admin(`CREATE DATABASE ${LEG}`);
        const legUrl = new URL(gate); legUrl.pathname = `/${LEG}`;
        const lp = createPostgresPool({ url: legUrl.toString() });
        try {
            await lp.query('CREATE EXTENSION IF NOT EXISTS vector');
            await lp.query(`CREATE TABLE verbatim (
                row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
                vector vector(4), content_hash TEXT, type TEXT, label TEXT, tags TEXT, project TEXT, ecosystem TEXT, "updatedAt" TEXT,
                security_scopes TEXT, is_canonical INTEGER NOT NULL DEFAULT 1, is_tombstone INTEGER NOT NULL DEFAULT 0, superseded_at TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, text_tsv tsvector NOT NULL DEFAULT ''::tsvector)`);
            await lp.query(`CREATE UNIQUE INDEX verbatim_canonical_id_uq ON verbatim(workspace_id, id) WHERE is_canonical = 1`);
            await lp.query(`CREATE INDEX verbatim_id_idx ON verbatim(workspace_id, id)`);
            await lp.query(`CREATE TABLE verbatim_changes_log (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, row_rowid BIGINT NOT NULL, row_id TEXT NOT NULL,
                is_canonical INTEGER NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert','delete')), at TEXT NOT NULL)`);
            await lp.query(`INSERT INTO verbatim (workspace_id, id, text, vector, created_at, updated_at) VALUES ('legacy-ws', 'lx', 'legacy text', '[1,0,0,0]', '2026-01-01', '2026-01-01')`);
            await runSchemaBootstrap(lp, { requirePgvector: true }, (cl) => ensureVerbatimSchema(cl, 'legacy-ws', 4));
            const cols = (await lp.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'verbatim' AND column_name = 'partition_key'`)).rows;
            assert.equal(cols.length, 1, 'the partitioned verbatim table has partition_key');
            const row = (await lp.query(`SELECT partition_key FROM verbatim WHERE workspace_id = 'legacy-ws' AND id = 'lx'`)).rows;
            assert.deepEqual(row, [{ partition_key: '' }], 'the migrated legacy row reads as the empty key');
        } finally {
            await lp.end().catch(() => undefined);
            await admin(`DROP DATABASE IF EXISTS ${LEG} WITH (FORCE)`).catch(() => undefined);
        }
    });

    console.log('\nbackup / export round trip');
    await test('export -> restore into another workspace keeps partition_key on nodes, edges and verbatim', async () => {
        const gb = await open();
        await gb.upsertNode(node('bk-a', { partitionKey: 'tenant-bk' }));
        await gb.upsertNode(node('bk-b'));
        await gb.addEdge({ sourceId: 'bk-a', targetId: 'bk-b', relation: 'related_to' } as never);
        await gb.close();
        const baseb = fs.mkdtempSync(path.join(os.tmpdir(), 'p0l3-vbk-'));
        stampGateManifest(baseb, 'p0l3-fixed', 4);
        const vb = new PostgresVerbatimStore(baseb, pool, WS, new Emb());
        await vb.initialize();
        await vb.store(vdoc('lore:bk-a', { partitionKey: 'tenant-bk' }));
        await vb.close?.();
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p0l3-bk-'));
        const sum = await exportWorkspaceBundle(pool, { workspaceId: WS, outDir: out });
        assert.ok(sum.tables.some((t) => t.name === 'nodes' && t.rowCount > 0));
        await restoreWorkspaceBundle(pool, { bundlePath: sum.bundlePath, targetWorkspaceId: 'p0l3-restored' });
        const nodes = await q<{ id: string; partition_key: string }>(`SELECT id, partition_key FROM nodes WHERE workspace_id = 'p0l3-restored' AND id IN ('bk-a','bk-b') ORDER BY id`);
        assert.deepEqual(nodes, [{ id: 'bk-a', partition_key: 'tenant-bk' }, { id: 'bk-b', partition_key: '' }]);
        const edges = await q<{ partition_key: string }>(
            `SELECT e.partition_key FROM edges e JOIN nodes s ON s.sk = e.src_sk WHERE e.workspace_id = 'p0l3-restored' AND s.id = 'bk-a'`);
        assert.deepEqual(edges, [{ partition_key: 'tenant-bk' }]);
        const vrows = await q<{ partition_key: string }>(`SELECT partition_key FROM verbatim WHERE workspace_id = 'p0l3-restored' AND id = 'lore:bk-a'`);
        assert.deepEqual(vrows, [{ partition_key: 'tenant-bk' }]);
        const ts = await q<{ ok: boolean }>(`SELECT created_at_ts IS NOT NULL AS ok FROM nodes WHERE workspace_id = 'p0l3-restored' AND id = 'bk-a'`);
        assert.equal(ts[0]!.ok, true, 'created_at_ts survives the round trip');
    });
} finally {
    await pool.end().catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
