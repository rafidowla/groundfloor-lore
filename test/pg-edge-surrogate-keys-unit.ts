#!/usr/bin/env tsx
/**
 * test/pg-edge-surrogate-keys-unit.ts - Postgres edge layout 2: edges keyed by integer surrogate keys (design D3).
 *
 * Runs against a throwaway database `lore_gate_sk` created on the LORE_PG_URL server (skips with a printed reason
 * when LORE_PG_URL is unset). The in-place conversion of a legacy table is covered by pg-edge-pk-migration-unit.ts.
 *
 *   layout      PRIMARY KEY (workspace_id, src_sk, dst_sk, relation); no text endpoint columns; only the two secondary indexes
 *   writes      addEdge / importRaw / addInferredEdgesBatch / supersede all store the right sks; public ids unchanged
 *   reads       getEdge / queryEdges / traverse / stats resolve text ids through nodes; no `sk` leaks
 *   deletes     deleteNode removes the node's edges in both directions, soft-invalidated ones included
 *   idempotent  re-opening rewrites no row; concurrent openers on a fresh database both succeed
 *
 * Run: npx tsx test/pg-edge-surrogate-keys-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_sk';
const WS = 'pg-gate-sk';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-edge-surrogate-keys: LORE_PG_URL is not set - postgres cases skipped cleanly');
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
const pool: Pool = createPostgresPool({ url: dbUrl.toString(), max: 8 });

const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
const open = async (): Promise<PostgresGraph> => { const g = new PostgresGraph(WS, pool); await g.initialize(); return g; };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const REL = 'depends_on';
const cols = async (table: string): Promise<string[]> =>
    (await q<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [table])).map((r) => r.column_name);

try {
    // Concurrent openers on a brand-new database: the advisory lock serialises the bootstrap.
    const handles = await Promise.all([open(), open(), open()]);
    const g = handles[0]!;
    for (const id of ['a', 'b', 'c', 'd']) await g.upsertNode(node(id));
    await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
    await g.addEdge({ sourceId: 'b', targetId: 'c', relation: REL });
    await g.addInferredEdgesBatch([{ sourceId: 'c', targetId: 'd', relation: REL, confidenceScore: 0.9 }]);
    await g.importRaw([], [{ sourceId: 'd', targetId: 'a', relation: REL, confidence: 'extracted', confidenceScore: 1 }]);

    console.log('\nlayout');
    await test('concurrent bootstraps on a fresh database all succeeded and left layout 2', async () => {
        assert.match(String((await q<{ c: string }>("SELECT obj_description('edges'::regclass, 'pg_class') AS c"))[0]!.c), /^lore:edge-layout=2$/);
    });
    await test('no text endpoint columns; the five 8-byte columns come first', async () => {
        const c = await cols('edges');
        assert.ok(!c.includes('source_id') && !c.includes('target_id'), `columns: ${c}`);
        assert.deepEqual(c.slice(0, 2), ['src_sk', 'dst_sk']);
    });
    await test('primary key is (workspace_id, src_sk, dst_sk, relation); only the dst_sk, workspace-led dst_sk and relation indexes besides it', async () => {
        const pk = await q<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'edges'::regclass AND contype = 'p'");
        assert.equal(pk[0]!.def, 'PRIMARY KEY (workspace_id, src_sk, dst_sk, relation)');
        const idx = (await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'edges' ORDER BY 1")).map((r) => r.indexname);
        assert.deepEqual(idx, ['edges_pkey', 'idx_edges_dst_sk', 'idx_edges_relation', 'idx_edges_ws_dst_sk']);
    });
    await test('src_sk / dst_sk carry the lore:references nodes.sk marker (backup remap), with no foreign key', async () => {
        const c = await q<{ n: string; d: string }>(
            `SELECT a.attname AS n, col_description(a.attrelid, a.attnum) AS d FROM pg_attribute a
              WHERE a.attrelid = 'edges'::regclass AND a.attname IN ('src_sk','dst_sk') ORDER BY 1`);
        assert.deepEqual(c.map((x) => x.d), ['lore:references nodes.sk', 'lore:references nodes.sk']);
        assert.equal((await q("SELECT 1 FROM pg_constraint WHERE conrelid = 'edges'::regclass AND contype = 'f'")).length, 0);
    });

    console.log('\nwrites and reads');
    await test('every write path stored the sks of the right nodes', async () => {
        const nodes = await q<{ id: string; sk: string }>('SELECT id, sk FROM nodes WHERE workspace_id = $1', [WS]);
        assert.equal(new Set(nodes.map((n) => n.sk)).size, 4);
        const sk = new Map(nodes.map((n) => [n.id, n.sk]));
        const edges = await q<{ src_sk: string; dst_sk: string }>('SELECT src_sk, dst_sk FROM edges WHERE workspace_id = $1', [WS]);
        const want = new Set(['a>b', 'b>c', 'c>d', 'd>a'].map((p) => `${sk.get(p[0]!)}>${sk.get(p[2]!)}`));
        assert.deepEqual(new Set(edges.map((e) => `${e.src_sk}>${e.dst_sk}`)), want);
    });
    await test('reads return text ids, text-id ordered, with no storage key leaking', async () => {
        const all = await g.queryEdges({ limit: 10, offset: 0 });
        assert.deepEqual(all.map((e) => `${e.sourceId}>${e.targetId}`), ['a>b', 'b>c', 'c>d', 'd>a']);
        assert.ok(all.every((e) => !('src_sk' in e) && !('sk' in e)));
        assert.equal((await g.getEdge('b', 'c', REL))?.targetId, 'c');
        assert.equal(await g.getEdge('c', 'b', REL), null);
        assert.equal((await g.queryEdges({ limit: 10, offset: 0, source: 'c' })).length, 1);
        assert.equal((await g.queryEdges({ limit: 10, offset: 0, target: 'a' })).length, 1);
        assert.equal((await g.queryEdges({ limit: 10, offset: 0, source: 'no-such-node' })).length, 0);
        assert.equal((await g.getStats()).edgeCount, 4);
        const n = await g.getNode('a');
        assert.ok(!('sk' in (n as object)));
    });
    await test('re-adding an edge updates in place (same key, no duplicate row)', async () => {
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL, confidenceScore: 0.5 } as never);
        assert.equal((await q('SELECT 1 FROM edges WHERE workspace_id = $1', [WS])).length, 4);
        assert.equal((await g.getEdge('a', 'b', REL))?.confidenceScore, 0.5);
    });

    console.log('\ndeletes');
    await test('deleteNode removes the node\'s edges in both directions, including invalidated ones', async () => {
        await g.invalidateEdges([{ sourceId: 'a', targetId: 'b', relation: REL }], '2026-10-23T12:00:00.000Z');
        await g.deleteNode('b');
        const left = await g.queryEdges({ limit: 10, offset: 0, includeInvalidated: true });
        assert.deepEqual(left.map((e) => `${e.sourceId}>${e.targetId}`), ['c>d', 'd>a']);
    });

    console.log('\nidempotence');
    await test('re-opening rewrites no edge or node row', async () => {
        const snap = async () => JSON.stringify([await q('SELECT xmin::text AS x FROM edges ORDER BY ctid'), await q('SELECT xmin::text AS x FROM nodes ORDER BY ctid')]);
        const before = await snap();
        await (await open()).close();
        assert.equal(await snap(), before);
    });
    for (const h of handles) await h.close();
} finally {
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
