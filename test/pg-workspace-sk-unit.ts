#!/usr/bin/env tsx
/**
 * test/pg-workspace-sk-unit.ts - Phase 0 lane L1: nodes.sk is unique PER WORKSPACE, every edge->node join names the
 * workspace, lore_entity points at nodes by (workspace_id, sk), and the D10 field indexes are workspace-led.
 *
 * Runs against throwaway databases `lore_gate_wssk` and `lore_gate_wssk_r` on the LORE_PG_URL server (skips with a
 * printed reason when LORE_PG_URL is unset).
 *
 *   expand      UNIQUE (workspace_id, sk) + idx_edges_ws_dst_sk + the composite lore_entity FK exist and are valid after
 *               open; the database-wide indexes are still there; a second open changes nothing
 *   wiring      the field indexes carry the workspace hash and lead with workspace_id; an old-named one is upgraded
 *   tables      the composite FK sets ONLY memory_node_sk to NULL when the node goes
 *   contract    dropGlobalSkIndexes refuses until the replacements are valid, then drops, and startup does not undo it
 *   collision   two workspaces with the SAME sk values read back only their own edges, via the public engine API
 *   build       a pending build runs in the background; an INVALID leftover is replaced
 *   restore     a bundle restores into a database whose other workspace already holds overlapping sk values
 *
 * Run: npx tsx test/pg-workspace-sk-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { dropGlobalSkIndexes } from '../packages/lore/src/engines/postgres/postgresWorkspaceSk.js';
import { fieldIndexName, legacyFieldIndexName } from '../packages/lore/src/engines/postgres/postgresFieldIndexName.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_wssk';
const DB_R = 'lore_gate_wssk_r';
const A = 'pg-wssk-a';
const B = 'pg-wssk-b';
const C = 'pg-wssk-c';
const REL = 'depends_on';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-workspace-sk: LORE_PG_URL is not set - postgres cases skipped cleanly');
    process.exit(0);
}
const urlFor = (db: string): string => { const u = new URL(gate); u.pathname = `/${db}`; return u.toString(); };
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: urlFor('postgres') });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
for (const db of [DB, DB_R]) { await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin(`CREATE DATABASE ${db}`); }
const pool: Pool = createPostgresPool({ url: urlFor(DB), max: 8 });
const poolR: Pool = createPostgresPool({ url: urlFor(DB_R), max: 8 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-wssk-'));

const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
const qp = (p: Pool) => async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await p.query(sql, params)).rows as T[];
const q = qp(pool);
const qR = qp(poolR);
const open = async (ws: string, p: Pool = pool, opts: { keywordIndexInlineRowLimit?: number } = {}): Promise<PostgresGraph> => {
    const g = new PostgresGraph(ws, p, opts); await g.initialize(); return g;
};
const indexDefs = async (table: string, p: Pool = pool): Promise<string[]> =>
    (await qp(p)<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname', [table])).map((r) => r.indexdef);
const valid = async (name: string): Promise<boolean> =>
    (await q<{ v: boolean }>('SELECT i.indisvalid AND i.indisready AS v FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]))[0]?.v === true;
const edgeKeys = async (g: PostgresGraph): Promise<string[]> =>
    (await g.queryEdges({ limit: 100, offset: 0 })).map((e) => `${e.sourceId}>${e.targetId}>${e.relation}`).sort();

const ACCOUNTS = {
    name: 'accounts',
    columns: [
        { name: 'id', type: 'string' as const, primary: true },
        { name: 'email', type: 'string' as const, unique: true },
        { name: 'name', type: 'string' as const, indexed: true },
        { name: '_memory_node_id', type: 'string' as const },
    ],
};

try {
    /* ── expand ─────────────────────────────────────────────────────── */
    console.log('\nexpand');
    const [gA, gB] = await Promise.all([open(A), open(B), open(A)]);
    for (const id of ['a', 'b', 'c', 'd']) await gA!.upsertNode(node(id));
    for (const id of ['p', 'q', 'r', 'z']) await gB!.upsertNode(node(id));
    await gA!.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
    await gA!.addEdge({ sourceId: 'b', targetId: 'c', relation: REL });
    await gA!.addEdge({ sourceId: 'c', targetId: 'd', relation: REL });
    await gB!.addEdge({ sourceId: 'p', targetId: 'q', relation: 'cites' });
    await gB!.addEdge({ sourceId: 'q', targetId: 'r', relation: 'cites' });
    const tA = await PostgresTableStorage.open(A, pool);
    await tA.createTable(ACCOUNTS);
    await tA.insertBatch('accounts', [
        { id: 'u1', email: 'u1@x.io', name: 'One', _memory_node_id: 'a' },
        { id: 'u2', email: 'u2@x.io', name: 'Two', _memory_node_id: 'b' },
    ]);
    await tA.waitForIndexes();

    await test('UNIQUE (workspace_id, sk) is a valid constraint on nodes; idx_edges_ws_dst_sk is valid', async () => {
        const c = await q<{ def: string; ok: boolean }>("SELECT pg_get_constraintdef(oid) AS def, convalidated AS ok FROM pg_constraint WHERE conname = 'nodes_workspace_sk_key' AND conrelid = 'nodes'::regclass");
        assert.equal(c.length, 1);
        assert.equal(c[0]!.def, 'UNIQUE (workspace_id, sk)');
        assert.ok(c[0]!.ok);
        assert.ok(await valid('idx_edges_ws_dst_sk'));
        const d = (await indexDefs('edges')).find((x) => x.includes('idx_edges_ws_dst_sk'))!;
        assert.match(d, /\(workspace_id, dst_sk\)/);
    });
    await test('the database-wide indexes are still there (expand only adds)', async () => {
        assert.ok(await valid('idx_nodes_sk'));
        assert.ok(await valid('idx_edges_dst_sk'));
        assert.ok(await valid('edges_pkey'));
    });
    await test('lore_entity points at nodes by (workspace_id, sk) and sets only memory_node_sk to NULL on delete', async () => {
        const f = await q<{ def: string; ok: boolean }>("SELECT pg_get_constraintdef(oid) AS def, convalidated AS ok FROM pg_constraint WHERE conname = 'lore_entity_workspace_node_fkey' AND conrelid = 'lore_entity'::regclass");
        assert.equal(f.length, 1);
        assert.match(f[0]!.def, /^FOREIGN KEY \(workspace_id, memory_node_sk\) REFERENCES nodes\(workspace_id, sk\) ON DELETE SET NULL \(memory_node_sk\)$/);
        assert.ok(f[0]!.ok);
        assert.ok(await valid('lore_entity_ws_node_sk_idx'));
        const before = await q<{ sk: string | null }>("SELECT memory_node_sk::text AS sk FROM lore_entity WHERE workspace_id = $1 AND pk_text = 'u1'", [A]);
        assert.ok(before[0]!.sk !== null, 'row is linked to its node');
        await gA!.upsertNode(node('tmp'));
        await tA.insert('accounts', { id: 'u3', email: 'u3@x.io', name: 'Three', _memory_node_id: 'tmp' });
        await gA!.deleteNode('tmp');
        const after = await q<{ ws: string; sk: string | null }>("SELECT workspace_id AS ws, memory_node_sk::text AS sk FROM lore_entity WHERE pk_text = 'u3'");
        assert.equal(after.length, 1, 'the typed row survives the node delete');
        assert.equal(after[0]!.ws, A, 'workspace_id is untouched');
        assert.equal(after[0]!.sk, null);
    });
    await test('re-opening changes no catalog entry and rewrites no row', async () => {
        const snap = async () => JSON.stringify([
            await indexDefs('nodes'), await indexDefs('edges'), await indexDefs('lore_entity'),
            await q('SELECT conname, convalidated FROM pg_constraint WHERE conrelid IN (\'nodes\'::regclass, \'edges\'::regclass, \'lore_entity\'::regclass) ORDER BY conname'),
            await q('SELECT xmin::text AS x FROM nodes ORDER BY ctid'), await q('SELECT xmin::text AS x FROM edges ORDER BY ctid'),
        ]);
        const before = await snap();
        await (await open(A)).close();
        await (await open(B)).close();
        assert.equal(await snap(), before);
    });

    /* ── field indexes ──────────────────────────────────────────────── */
    console.log('\nfield indexes');
    const fieldIds = (await q<{ field_id: number }>('SELECT field_id::int AS field_id FROM lore_field_def WHERE workspace_id = $1 ORDER BY field_id', [A])).map((r) => r.field_id);
    const fieldIdx = async (): Promise<string[]> => (await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE indexname LIKE 'lore\\_ev\\_%\\_u' OR indexname LIKE 'lore\\_ev\\_%\\_i' ORDER BY 1")).map((r) => r.indexname);
    await test('field indexes are named lore_ev_<workspace hash>_<field>_<u|i> and lead with workspace_id', async () => {
        const names = await fieldIdx();
        assert.ok(names.length >= 2, `expected unique + plain indexes, got ${names.join(',')}`);
        for (const n of names) assert.match(n, /^lore_ev_[0-9a-f]{8}_\d+_[ui]$/);
        for (const id of fieldIds) {
            for (const kind of ['u', 'i'] as const) {
                const n = fieldIndexName(A, id, kind);
                if (!names.includes(n)) continue;
                const d = (await indexDefs('lore_entity_value')).find((x) => x.includes(` ${n} `));
                assert.ok(d && /\(workspace_id, /.test(d), `${n}: ${d}`);
            }
        }
    });
    await test('an index under the old name is not mistaken for the new one: reopening builds the new name, the old stays for the contract', async () => {
        const names = await fieldIdx();
        const target = names.find((n) => n.endsWith('_i'))!;
        const id = Number(/_(\d+)_i$/.exec(target)![1]);
        const valueCol = (await q<{ attname: string }>(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[1] WHERE i.indexrelid = to_regclass('${target}')`))[0]!.attname;
        await q(`DROP INDEX ${target}`);
        await q(`CREATE INDEX ${legacyFieldIndexName(id, 'i')} ON lore_entity_value (${valueCol}) WHERE field_id = ${id} AND superseded_at IS NULL`);
        const t2 = await PostgresTableStorage.open(A, pool);
        await t2.waitForIndexes();
        assert.ok(await valid(fieldIndexName(A, id, 'i')), 'new-named index rebuilt');
        assert.ok(await valid(legacyFieldIndexName(id, 'i')), 'old-named index kept until the contract step');
        await t2.close();
    });

    /* ── contract ───────────────────────────────────────────────────── */
    console.log('\ncontract');
    // A database that ran on main also has lore_entity's single-column FK (it depends on idx_nodes_sk) and index.
    await q('ALTER TABLE lore_entity ADD CONSTRAINT lore_entity_memory_node_sk_fkey FOREIGN KEY (memory_node_sk) REFERENCES nodes (sk) ON DELETE SET NULL');
    await q('CREATE INDEX lore_entity_node_sk_idx ON lore_entity (memory_node_sk)');
    await test('a dry run lists what would go and drops nothing', async () => {
        const c = await pool.connect();
        try {
            const r = await dropGlobalSkIndexes(c, { dryRun: true });
            assert.equal(r.refused, null);
            assert.ok(r.dryRun);
            for (const n of ['idx_nodes_sk', 'idx_edges_dst_sk', 'lore_entity_memory_node_sk_fkey']) assert.ok(r.dropped.some((d) => d === n || d.endsWith(`.${n}`)), `${n} in ${r.dropped.join(',')}`);
        } finally { c.release(); }
        assert.ok(await valid('idx_nodes_sk'));
    });
    await test('it refuses, dropping nothing, while the per-workspace constraint is missing; reopening rebuilds it', async () => {
        await q('ALTER TABLE nodes DROP CONSTRAINT nodes_workspace_sk_key CASCADE');
        const c = await pool.connect();
        try {
            const r = await dropGlobalSkIndexes(c);
            assert.match(String(r.refused), /nodes_workspace_sk_key/);
            assert.deepEqual(r.dropped, []);
        } finally { c.release(); }
        assert.ok(await valid('idx_nodes_sk'));
        await (await open(A)).close();
        assert.equal((await q("SELECT 1 FROM pg_constraint WHERE conname = 'nodes_workspace_sk_key' AND convalidated")).length, 1);
    });
    await test('the contract drops the database-wide indexes, the old FK and the old-named field indexes', async () => {
        const c = await pool.connect();
        try {
            const r = await dropGlobalSkIndexes(c);
            assert.equal(r.refused, null);
            assert.ok(r.dropped.includes('idx_nodes_sk') && r.dropped.includes('idx_edges_dst_sk'));
        } finally { c.release(); }
        assert.equal(await q("SELECT to_regclass('idx_nodes_sk')::text AS r").then((x) => x[0]!.r), null);
        assert.equal(await q("SELECT to_regclass('idx_edges_dst_sk')::text AS r").then((x) => x[0]!.r), null);
        assert.equal((await q("SELECT 1 FROM pg_constraint WHERE conname = 'lore_entity_memory_node_sk_fkey'")).length, 0);
        assert.equal((await q("SELECT to_regclass('lore_entity_node_sk_idx')::text AS r"))[0]!.r, null);
        assert.ok((await fieldIdx()).every((n) => /^lore_ev_[0-9a-f]{8}_/.test(n)), `left: ${(await fieldIdx()).join(',')}`);
        assert.ok(await valid('nodes_workspace_sk_key'));
        assert.equal((await q("SELECT 1 FROM pg_constraint WHERE conname = 'lore_entity_workspace_node_fkey' AND convalidated")).length, 1);
    });
    await test('startup does not recreate them, and a second contract run is a no-op', async () => {
        await (await open(A)).close();
        await (await open(B)).close();
        const t = await PostgresTableStorage.open(A, pool); await t.waitForIndexes(); await t.close();
        assert.equal((await q("SELECT to_regclass('idx_nodes_sk')::text AS r"))[0]!.r, null);
        assert.equal((await q("SELECT to_regclass('idx_edges_dst_sk')::text AS r"))[0]!.r, null);
        const c = await pool.connect();
        try {
            const r = await dropGlobalSkIndexes(c);
            assert.equal(r.refused, null);
            assert.deepEqual(r.dropped, []);
        } finally { c.release(); }
    });

    /* ── collision ──────────────────────────────────────────────────── */
    console.log('\ncolliding sk values');
    // Workspace C gets A's sk values (what a shard move or a restore into a fresh database produces).
    const gC = await open(C);
    for (const id of ['w', 'x', 'y', 'v']) await gC.upsertNode(node(id));
    await gC.addEdge({ sourceId: 'w', targetId: 'x', relation: 'cites' });
    await gC.addEdge({ sourceId: 'x', targetId: 'y', relation: 'cites' });
    await gC.addEdge({ sourceId: 'y', targetId: 'v', relation: 'cites' });
    const aBefore = { edges: await edgeKeys(gA!), stats: (await gA!.getStats()).edgeCount, lint: await gA!.lintGraph() };
    const cBefore = { edges: await edgeKeys(gC), stats: (await gC.getStats()).edgeCount };
    {
        const aSks = (await q<{ sk: string }>('SELECT sk::text AS sk FROM nodes WHERE workspace_id = $1 AND id IN (\'a\',\'b\',\'c\',\'d\') ORDER BY id', [A])).map((r) => r.sk);
        const cNodes = await q<{ id: string; sk: string }>('SELECT id, sk::text AS sk FROM nodes WHERE workspace_id = $1 ORDER BY CASE id WHEN \'w\' THEN 1 WHEN \'x\' THEN 2 WHEN \'y\' THEN 3 ELSE 4 END', [C]);
        const map = new Map(cNodes.map((n, i) => [n.sk, aSks[i]!]));
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            // Edges first (they have no FK), then the nodes; the primary key includes workspace_id, so no clash.
            const cases = (col: string) => `CASE ${col} ${[...map].map(([from, to]) => `WHEN ${from} THEN ${to}`).join(' ')} END`;
            await c.query(`UPDATE edges SET src_sk = ${cases('src_sk')}, dst_sk = ${cases('dst_sk')} WHERE workspace_id = $1`, [C]);
            await c.query(`UPDATE nodes SET sk = ${cases('sk')} WHERE workspace_id = $1`, [C]);
            await c.query('COMMIT');
        } finally { c.release(); }
    }
    await test('the two workspaces now hold the same sk values', async () => {
        const dup = await q<{ n: string }>('SELECT count(*)::text AS n FROM (SELECT sk FROM nodes GROUP BY sk HAVING count(DISTINCT workspace_id) > 1) t');
        assert.equal(Number(dup[0]!.n), 4);
    });
    await test('control: an unscoped join WOULD mix them (this is the bug the scoped joins prevent)', async () => {
        const unscoped = await q<{ n: string }>('SELECT count(*)::text AS n FROM edges e JOIN nodes s ON s.sk = e.src_sk WHERE e.workspace_id = $1', [A]);
        const scoped = await q<{ n: string }>('SELECT count(*)::text AS n FROM edges e JOIN nodes s ON s.workspace_id = e.workspace_id AND s.sk = e.src_sk WHERE e.workspace_id = $1', [A]);
        assert.equal(Number(unscoped[0]!.n), 6);
        assert.equal(Number(scoped[0]!.n), 3);
    });
    await test('queryEdges / getEdge / getStats return only the workspace\'s own edges', async () => {
        assert.deepEqual(await edgeKeys(gA!), aBefore.edges);
        assert.deepEqual(await edgeKeys(gC), cBefore.edges);
        assert.equal((await gA!.getStats()).edgeCount, 3);
        assert.equal((await gC.getStats()).edgeCount, 3);
        assert.equal((await gA!.getEdge('a', 'b', REL))?.targetId, 'b');
        assert.equal(await gA!.getEdge('w', 'x', 'cites'), null);
        assert.equal((await gC.getEdge('w', 'x', 'cites'))?.targetId, 'x');
        assert.equal(await gC.getEdge('a', 'b', REL), null);
        assert.equal((await gA!.queryEdges({ limit: 10, offset: 0, target: 'b' })).length, 1);
        assert.equal((await gC.queryEdges({ limit: 10, offset: 0, target: 'b' })).length, 0);
    });
    await test('traverse and topology stay inside the workspace', async () => {
        const ids = (r: { node: { id: string } }[]) => r.map((x) => x.node.id).sort();
        assert.deepEqual(ids(await gA!.traverse('a', 5) as never), ['b', 'c', 'd']);
        assert.deepEqual(ids(await gC.traverse('w', 5) as never), ['v', 'x', 'y']);
        const topoA = await gA!.getTopology(100, undefined, 100);
        const topoC = await gC.getTopology(100, undefined, 100);
        assert.equal(topoA.edges.length, 3);
        assert.equal(topoC.edges.length, 3);
        assert.ok(topoA.edges.every((e) => ['a', 'b', 'c'].includes(String(e['from']))));
        assert.ok(topoC.edges.every((e) => ['w', 'x', 'y'].includes(String(e['from']))));
    });
    await test('overview and lint are unchanged by the other workspace\'s identical sk values', async () => {
        assert.deepEqual(await gA!.lintGraph(), aBefore.lint);
        const ovA = await gA!.getTopologyOverview();
        const ovC = await gC.getTopologyOverview();
        assert.equal(JSON.stringify(ovA).includes('"w"'), false);
        assert.equal(JSON.stringify(ovC).includes('"a"'), false);
    });
    await test('deleting a node removes only its own workspace\'s edges', async () => {
        await gC.deleteNode('x');
        assert.deepEqual(await edgeKeys(gC), ['y>v>cites']);
        assert.deepEqual(await edgeKeys(gA!), aBefore.edges);
    });
    await test('the same sk twice in ONE workspace is still refused', async () => {
        await assert.rejects(
            q("INSERT INTO nodes (workspace_id, id, type, label, sk) SELECT workspace_id, 'dup', 'note', 'dup', sk FROM nodes WHERE workspace_id = $1 LIMIT 1", [A]),
            (e: { code?: string; constraint?: string }) => e.code === '23505' && e.constraint === 'nodes_workspace_sk_key');
    });

    /* ── build ──────────────────────────────────────────────────────── */
    console.log('\nbackground build');
    await test('a pending build runs in the background and finishes; an INVALID leftover is replaced', async () => {
        // Workspace C's colliding values are gone first: with the constraint absent, startup would (rightly) try to
        // rebuild the database-wide unique index, which colliding sks make impossible.
        await q('DELETE FROM edges WHERE workspace_id = $1', [C]);
        await q('DELETE FROM nodes WHERE workspace_id = $1', [C]);
        await q('ALTER TABLE nodes DROP CONSTRAINT nodes_workspace_sk_key CASCADE');
        await q('DROP INDEX idx_edges_ws_dst_sk');
        // A failed CONCURRENTLY build leaves an INVALID index behind: make one with a transient duplicate.
        await q("INSERT INTO nodes (workspace_id, id, type, label, sk) SELECT workspace_id, 'dup', 'note', 'dup', sk FROM nodes WHERE workspace_id = $1 LIMIT 1", [A]);
        await assert.rejects(q('CREATE UNIQUE INDEX CONCURRENTLY nodes_workspace_sk_key ON nodes (workspace_id, sk)'));
        assert.equal(await valid('nodes_workspace_sk_key'), false, 'INVALID leftover exists');
        await q("DELETE FROM nodes WHERE workspace_id = $1 AND id = 'dup'", [A]);
        const g = await open(A, pool, { keywordIndexInlineRowLimit: 0 });
        await g.waitForWorkspaceSk();
        assert.ok(await valid('nodes_workspace_sk_key'), 'rebuilt');
        assert.equal((await q("SELECT 1 FROM pg_constraint WHERE conname = 'nodes_workspace_sk_key' AND contype = 'u' AND convalidated")).length, 1, 'promoted to a constraint');
        assert.ok(await valid('idx_edges_ws_dst_sk'));
        await g.close();
    });
    await gA!.close(); await gB!.close(); await gC.close(); await tA.close();

    /* ── restore ────────────────────────────────────────────────────── */
    console.log('\nrestore');
    const gX = await open('pg-wssk-x', poolR);
    for (const id of ['m', 'n', 'o']) await gX.upsertNode(node(id));
    await gX.addEdge({ sourceId: 'm', targetId: 'n', relation: 'owns' });
    await gX.addEdge({ sourceId: 'n', targetId: 'o', relation: 'owns' });
    const tX = await PostgresTableStorage.open('pg-wssk-x', poolR);
    await tX.createTable(ACCOUNTS);
    await tX.insert('accounts', { id: 'x1', email: 'x1@x.io', name: 'X1', _memory_node_id: 'm' });
    const xEdges = await edgeKeys(gX);
    await test('a bundle restores into a database where another workspace already holds overlapping sk values', async () => {
        const g = await open(A);
        const sum = await exportWorkspaceBundle(pool, { workspaceId: A, outDir: path.join(tmp, 'bundle') });
        const aEdges = await edgeKeys(g);
        const overlap = await qR<{ n: string }>('SELECT count(*)::text AS n FROM nodes WHERE sk <= (SELECT max(sk) FROM nodes) AND workspace_id = $1', ['pg-wssk-x']);
        assert.ok(Number(overlap[0]!.n) > 0);
        const r = await restoreWorkspaceBundle(poolR, { bundlePath: sum.bundlePath, targetWorkspaceId: 'pg-wssk-restored' });
        assert.ok(r.idRemaps.some((m) => m.table === 'nodes' && m.column === 'sk' && m.offset !== '0'), 'sk was shifted clear of the other workspace');
        assert.ok(r.idRemaps.some((m) => m.table === 'edges' && m.column === 'src_sk'), 'edge endpoints shifted with it');
        const gR = await open('pg-wssk-restored', poolR);
        assert.deepEqual(await edgeKeys(gR), aEdges);
        assert.equal((await gR.getStats()).edgeCount, aEdges.length);
        assert.deepEqual(await edgeKeys(gX), xEdges, 'the other workspace is untouched');
        assert.equal((await gX.getStats()).edgeCount, 2);
        assert.equal((await gR.traverse('a', 5)).length, 3);
        assert.equal((await gX.traverse('m', 5)).length, 2);
        const typed = await qR<{ ws: string; sk: string | null }>("SELECT workspace_id AS ws, memory_node_sk::text AS sk FROM lore_entity WHERE pk_text IN ('u1','u2','x1') ORDER BY pk_text");
        assert.ok(typed.every((t) => t.sk !== null), 'typed rows still point at their nodes');
        const crossed = await qR<{ n: string }>('SELECT count(*)::text AS n FROM lore_entity e JOIN nodes n ON n.sk = e.memory_node_sk AND n.workspace_id <> e.workspace_id');
        assert.equal(Number(crossed[0]!.n), 0, 'no typed row points into another workspace');
        await g.close(); await gR.close();
    });
    await test('the restored database holds the same invariants: valid constraint, composite FK, no duplicate (workspace_id, sk)', async () => {
        assert.equal((await qR("SELECT 1 FROM pg_constraint WHERE conname = 'nodes_workspace_sk_key' AND convalidated")).length, 1);
        assert.equal((await qR("SELECT 1 FROM pg_constraint WHERE conname = 'lore_entity_workspace_node_fkey' AND convalidated")).length, 1);
        const dup = await qR<{ n: string }>('SELECT count(*)::text AS n FROM (SELECT workspace_id, sk FROM nodes GROUP BY 1, 2 HAVING count(*) > 1) t');
        assert.equal(Number(dup[0]!.n), 0);
    });
    await gX.close(); await tX.close();
} finally {
    await closePostgresPool(pool);
    await closePostgresPool(poolR);
    for (const db of [DB, DB_R]) await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
