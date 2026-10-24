#!/usr/bin/env tsx
/**
 * test/pg-edge-pk-migration-unit.ts - in-place conversion of a legacy (text-keyed) edges table to edge layout 2, plus
 * keyset paging on the new key and the layout guard. Throwaway database `lore_gate_pkmig` on the LORE_PG_URL server
 * (skips cleanly with a printed reason when it is unset).
 *
 *   convert      the bootstrap converts a legacy table: same edges, text ids resolved through nodes, provenance kept
 *   quarantine   dangling edges (source / target / both missing) land in edges_dangling with full detail, never deleted
 *   rollback     edges_pre_pk keeps the old rows until dropPrePkEdges; refuses to overwrite one
 *   idempotent   re-running rewrites nothing; a second opener finds layout 2
 *   resumable    a copy stopped mid-way resumes from its progress mark and ends identical to an uninterrupted run
 *   catch-up     inserts / updates / deletes made on the old table while the copy ran are in the swapped table
 *   guard        a database stamped with a newer layout is refused; an old engine's text-column write fails loudly
 *   paging       queryEdgesPage walks every edge once on the physical key, stable under concurrent inserts; bad cursors rejected
 *   backup       edges_dangling is backed up and restored; migration scaffolding tables are excluded
 *
 * Run: npx tsx test/pg-edge-pk-migration-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { migrateEdgesToSurrogatePk, dropPrePkEdges } from '../packages/lore/src/engines/postgres/postgresEdgePkMigration.js';
import { readEdgeLayout } from '../packages/lore/src/engines/postgres/postgresEdgeSchema.js';
import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import { discoverWorkspaceSchema } from '../packages/lore/src/engines/postgres/postgresBackupDiscovery.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { gateDbUrl } from './helpers/testPostgres.js';
import { legacyEdge, makeLegacyEdgesTable } from './helpers/legacyEdges.js';

const DB = 'lore_gate_pkmig';
const A = 'pg-gate-pkmig-a';
const B = 'pg-gate-pkmig-b';
const REL = 'depends_on';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-edge-pk-migration: LORE_PG_URL is not set - postgres cases skipped cleanly');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpkmig-'));

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const open = async (ws = A): Promise<PostgresGraph> => { const g = new PostgresGraph(ws, pool); await g.initialize(); return g; };
const N = 40;
const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(2, '0')}`);

/** Ensure the nodes table (with sk) exists WITHOUT touching edges: bootstrap on a clean database, then swap in a legacy edges table. */
async function freshNodes(): Promise<void> {
    await pool.query('DROP TABLE IF EXISTS edges, edges_next, edges_pre_pk, edges_dangling, edges_pk_progress CASCADE');
    const g = await open(); await g.close(); // creates nodes + a layout-2 edges
    await pool.query('DELETE FROM nodes');
    for (const ws of [A, B]) {
        await pool.query(
            `INSERT INTO nodes (workspace_id, id, type, label, content) SELECT $1, i, 'note', i, 'c ' || i FROM unnest($2::text[]) AS i`, [ws, ids]);
    }
}
async function legacyFixture(opts: { d3?: boolean } = {}): Promise<void> {
    await freshNodes();
    await makeLegacyEdgesTable(pool, opts);
    for (let i = 0; i < N - 1; i++) await legacyEdge(pool, A, ids[i]!, ids[i + 1]!, REL, { score: 0.5 + i / 100 });
    for (let i = 2; i < 12; i++) await legacyEdge(pool, A, ids[0]!, ids[i]!, 'semantic_neighbor', { confidence: 'inferred', score: 0.8 });
    for (let i = 0; i < 10; i++) await legacyEdge(pool, B, ids[i]!, ids[(i + 7) % N]!, REL);
    await legacyEdge(pool, A, ids[3]!, 'ghost-target', REL);
    await legacyEdge(pool, A, 'ghost-source', ids[4]!, REL);
    await legacyEdge(pool, A, 'ghost-source', 'ghost-target', 'both_missing');
    await legacyEdge(pool, B, ids[1]!, 'ghost-target', REL);
    if (opts.d3) {
        await q(`UPDATE edges SET origin = 'link_on_arrival', policy_version = 'p1', model_fingerprint = 'm1', created_at = '2026-05-01T00:00:00Z' WHERE workspace_id = $1 AND relation = 'semantic_neighbor'`, [A]);
        await q(`UPDATE edges SET valid_to = '2026-06-01T00:00:00Z' WHERE workspace_id = $1 AND source_id = $2 AND target_id = $3`, [A, ids[5], ids[6]]);
    }
}
const LEGACY_TOTAL = (N - 1) + 10 + 10 + 4;
const LEGACY_DANGLING = 4;
/** Edge triples as text, resolved through nodes, sorted. */
const triples = async (table = 'edges'): Promise<string[]> => (await q<{ t: string }>(
    `SELECT s.workspace_id || '|' || s.id || '>' || t.id || '|' || e.relation || '|' || e."confidenceScore" || '|' || coalesce(e.origin,'-') || '|' || (e.valid_to IS NOT NULL) AS t
       FROM ${table} e JOIN nodes s ON s.sk = e.src_sk JOIN nodes t ON t.sk = e.dst_sk ORDER BY 1`)).map((r) => r.t);
const legacyTriples = async (): Promise<string[]> => (await q<{ t: string }>(
    `SELECT e.workspace_id || '|' || e.source_id || '>' || e.target_id || '|' || e.relation || '|' || e."confidenceScore" || '|' || coalesce(e.origin,'-') || '|' || (e.valid_to IS NOT NULL) AS t
       FROM edges_pre_pk e WHERE EXISTS (SELECT 1 FROM nodes WHERE workspace_id = e.workspace_id AND id = e.source_id)
        AND EXISTS (SELECT 1 FROM nodes WHERE workspace_id = e.workspace_id AND id = e.target_id) ORDER BY 1`)).map((r) => r.t);

try {
    console.log('\nconvert, quarantine, rollback');
    await legacyFixture({ d3: true });
    await test('precondition: the fixture is layout 1 with dangling rows', async () => {
        const c = await pool.connect();
        try { assert.equal(await readEdgeLayout(c), 1); } finally { c.release(); }
        assert.equal(Number((await q<{ c: string }>('SELECT count(*) AS c FROM edges'))[0]!.c), LEGACY_TOTAL);
    });
    const g1 = await open(); // the bootstrap migrates
    await test('the bootstrap converted the table in place to layout 2 (stamped, text columns gone)', async () => {
        const c = await pool.connect();
        try { assert.equal(await readEdgeLayout(c), 2); } finally { c.release(); }
        const cols = (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'edges'")).map((r) => r.column_name);
        assert.ok(!cols.includes('source_id') && !cols.includes('target_id'));
        const idx = (await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'edges' ORDER BY 1")).map((r) => r.indexname);
        assert.deepEqual(idx, ['edges_pkey', 'idx_edges_dst_sk', 'idx_edges_relation']);
    });
    await test('every resolvable edge survived with the same relation, score, provenance and invalidation', async () => {
        const now = await triples(); const old = await legacyTriples();
        assert.equal(now.length, LEGACY_TOTAL - LEGACY_DANGLING);
        assert.deepEqual(now, old);
        assert.ok(now.some((t) => t.includes('link_on_arrival')) && now.some((t) => t.endsWith('|true')));
    });
    await test('dangling edges are quarantined with the full legacy row and which endpoint was missing; none deleted', async () => {
        const d = await q<{ workspace_id: string; source_id: string; target_id: string; relation: string; missing_endpoint: string }>(
            'SELECT workspace_id, source_id, target_id, relation, missing_endpoint FROM edges_dangling ORDER BY 1,2,3');
        assert.deepEqual(d.map((r) => `${r.workspace_id}|${r.source_id}>${r.target_id}|${r.missing_endpoint}`), [
            `${A}|ghost-source>ghost-target|both`, `${A}|ghost-source>${ids[4]}|source`, `${A}|${ids[3]}>ghost-target|target`, `${B}|${ids[1]}>ghost-target|target`,
        ]);
        assert.equal(Number((await q<{ c: string }>('SELECT count(*) AS c FROM edges_pre_pk'))[0]!.c), LEGACY_TOTAL, 'the old table still holds every row');
    });
    await test('reads over the converted table work: text ids, provenance, traversal, stats', async () => {
        assert.equal((await g1.getEdge(ids[5]!, ids[6]!, REL, { includeProvenance: true, includeInvalidated: true }))?.provenance?.validTo, '2026-06-01T00:00:00.000Z');
        assert.equal(await g1.getEdge(ids[5]!, ids[6]!, REL), null, 'invalidated edge is hidden by default');
        assert.equal((await g1.queryEdges({ limit: 100, offset: 0, source: ids[0]!, relation: 'semantic_neighbor' })).length, 10);
        assert.equal((await g1.traverse(ids[0]!, 1)).length, 11);
        assert.equal((await g1.getStats()).edgeCount, 48, 'workspace A: 39 chain + 10 fan-out - 1 invalidated');
    });
    await test('a second open is idempotent: no row rewritten, no new quarantine rows', async () => {
        const snap = async () => JSON.stringify([await q('SELECT xmin::text AS x FROM edges ORDER BY ctid'), await q('SELECT count(*) FROM edges_dangling')]);
        const before = await snap();
        await (await open()).close(); await (await open(B)).close();
        assert.equal(await snap(), before);
    });
    await test('a pre-pk rollback copy is never overwritten; dropPrePkEdges removes it once, then reports none', async () => {
        const c = await pool.connect();
        try {
            await makeLegacyEdgesTable(pool); // would be a second migration: refused because edges_pre_pk is gone? recreate it first
            await c.query('CREATE TABLE IF NOT EXISTS edges_pre_pk (x int)');
            await assert.rejects(() => migrateEdgesToSurrogatePk(c), /edges_pre_pk already exists/);
            assert.equal(await dropPrePkEdges(c), true);
            assert.equal(await dropPrePkEdges(c), false);
        } finally { c.release(); }
    });
    await g1.close();

    console.log('\nresumable');
    await legacyFixture();
    const expectedTriples = await (async () => {
        const c = await pool.connect();
        try { await migrateEdgesToSurrogatePk(c, { batchSize: 1000 }); } finally { c.release(); }
        const t = await triples(); const d = (await q<{ c: string }>('SELECT count(*) AS c FROM edges_dangling'))[0]!.c;
        return { t, d };
    })();
    await legacyFixture();
    await test('a copy stopped after 2 small batches leaves progress and a partial staging table; the rerun finishes identically', async () => {
        const c = await pool.connect();
        try {
            const paused = await migrateEdgesToSurrogatePk(c, { batchSize: 7, maxBatches: 2 });
            assert.equal(paused.status, 'paused');
            assert.equal(Number((await q<{ c: string }>('SELECT count(*) AS c FROM edges_next'))[0]!.c) > 0, true);
            assert.equal(Number((await q<{ c: string }>('SELECT count(*) AS c FROM edges_next'))[0]!.c) < LEGACY_TOTAL - LEGACY_DANGLING, true);
            const done = await migrateEdgesToSurrogatePk(c, { batchSize: 5 }); // different batch size on resume
            assert.equal(done.status, 'migrated');
            assert.equal(done.quarantined, LEGACY_DANGLING);
        } finally { c.release(); }
        assert.deepEqual(await triples(), expectedTriples.t);
        assert.equal((await q<{ c: string }>('SELECT count(*) AS c FROM edges_dangling'))[0]!.c, expectedTriples.d);
        assert.equal((await q("SELECT 1 FROM pg_class WHERE relname IN ('edges_next','edges_pk_progress')")).length, 0, 'scaffolding cleaned up');
    });

    console.log('\ncatch-up of writes made during the copy');
    await legacyFixture();
    await test('inserts, updates, deletes and new dangling rows on the old table between copy and swap all reach the new table', async () => {
        const c = await pool.connect();
        try {
            await migrateEdgesToSurrogatePk(c, {
                batchSize: 9,
                beforeSwap: async (cl) => {
                    await legacyEdge(cl, A, ids[20]!, ids[30]!, 'late_added');                                     // insert
                    await cl.query(`UPDATE edges SET "confidenceScore" = 0.123 WHERE workspace_id = $1 AND source_id = $2 AND target_id = $3`, [A, ids[1], ids[2]]); // update
                    await cl.query(`DELETE FROM edges WHERE workspace_id = $1 AND source_id = $2 AND target_id = $3`, [A, ids[8], ids[9]]);                       // delete
                    await legacyEdge(cl, A, ids[22]!, 'late-ghost', REL);                                             // new dangling
                },
            });
        } finally { c.release(); }
        const t = await triples();
        assert.ok(t.includes(`${A}|${ids[20]}>${ids[30]}|late_added|1|-|false`), 'late insert');
        assert.ok(t.some((x) => x.startsWith(`${A}|${ids[1]}>${ids[2]}|${REL}|0.123|`)), 'late update');
        assert.ok(!t.some((x) => x.startsWith(`${A}|${ids[8]}>${ids[9]}|`)), 'late delete');
        assert.equal(Number((await q<{ c: string }>("SELECT count(*) AS c FROM edges_dangling WHERE target_id = 'late-ghost'"))[0]!.c), 1, 'late dangling quarantined');
        assert.deepEqual(t, await legacyTriples(), 'new table equals the old one over resolvable endpoints');
    });

    console.log('\nlayout guard');
    await test('a database stamped with a newer layout is refused, naming both layouts; nothing is modified', async () => {
        await q("COMMENT ON TABLE edges IS 'lore:edge-layout=3'");
        const before = JSON.stringify(await q('SELECT xmin::text AS x FROM edges ORDER BY ctid'));
        const c = await pool.connect();
        try { await assert.rejects(() => ensureGraphSchema(c, A), /layout 3.*only understands layout 2/); } finally { c.release(); }
        assert.equal(JSON.stringify(await q('SELECT xmin::text AS x FROM edges ORDER BY ctid')), before);
        await q("COMMENT ON TABLE edges IS 'lore:edge-layout=2'");
    });
    await test('an older engine\'s text-column write fails loudly instead of writing a keyless row', async () => {
        await assert.rejects(() => q(`INSERT INTO edges (workspace_id, source_id, target_id, relation) VALUES ('x','a','b','r')`), /source_id/);
        await assert.rejects(() => q(`INSERT INTO edges (workspace_id, relation) VALUES ('x','r')`), /null value/);
    });

    console.log('\nkeyset paging');
    const g = await open();
    for (let i = 0; i < 25; i++) await g.addEdge({ sourceId: ids[i]!, targetId: ids[(i * 3 + 1) % N]!, relation: 'paged' });
    const total = (await g.queryEdges({ limit: 1000, offset: 0, includeInvalidated: true })).length;
    await test('walking pages of 7 returns every edge exactly once, in physical-key order, with a final null cursor', async () => {
        const seen: string[] = []; let cursor: string | null = null; let pages = 0;
        do {
            const page = await g.queryEdgesPage({ limit: 7, cursor, includeInvalidated: true });
            seen.push(...page.edges.map((e) => `${e.sourceId}>${e.targetId}>${e.relation}`));
            cursor = page.nextCursor; pages++;
        } while (cursor && pages < 100);
        assert.equal(seen.length, total);
        assert.equal(new Set(seen).size, total);
        assert.equal(pages, Math.ceil(total / 7));
    });
    await test('paging is stable under inserts between pages: nothing already behind the cursor is repeated or skipped', async () => {
        const first = await g.queryEdgesPage({ limit: 5, includeInvalidated: true });
        await g.addEdge({ sourceId: ids[39]!, targetId: ids[38]!, relation: 'inserted_mid_walk' });
        await g.addEdge({ sourceId: ids[0]!, targetId: ids[39]!, relation: 'inserted_mid_walk' });
        const rest: string[] = []; let cursor = first.nextCursor;
        while (cursor) { const p = await g.queryEdgesPage({ limit: 5, cursor, includeInvalidated: true }); rest.push(...p.edges.map((e) => `${e.sourceId}>${e.targetId}>${e.relation}`)); cursor = p.nextCursor; }
        const firstKeys = first.edges.map((e) => `${e.sourceId}>${e.targetId}>${e.relation}`);
        assert.equal(firstKeys.filter((k) => rest.includes(k)).length, 0);
        assert.ok(rest.length >= total - 5);
    });
    await test('filters ride the keyset page (source / relation)', async () => {
        const p = await g.queryEdgesPage({ limit: 100, source: ids[0]!, relation: 'semantic_neighbor' });
        assert.equal(p.edges.length, 10); assert.equal(p.nextCursor, null);
    });
    await test('invalid, legacy-shaped and tampered cursors are rejected with an instruction to restart', async () => {
        for (const bad of ['not-a-cursor', Buffer.from('["n00","n01","r"]').toString('base64url'), Buffer.from('[1,"1","2","r"]').toString('base64url'), Buffer.from('[2,"x","2","r"]').toString('base64url')]) {
            await assert.rejects(() => g.queryEdgesPage({ limit: 5, cursor: bad }), /Invalid edge cursor/);
        }
    });
    await test('offset queryEdges is unchanged by the layout: same text-id order, deep offsets, same page contents as a keyset-free walk', async () => {
        const all = await g.queryEdges({ limit: 1000, offset: 0 });
        const sorted = [...all].sort((x, y) => (x.sourceId < y.sourceId ? -1 : x.sourceId > y.sourceId ? 1 : x.targetId < y.targetId ? -1 : x.targetId > y.targetId ? 1 : x.relation < y.relation ? -1 : 1));
        assert.deepEqual(all.map((e) => `${e.sourceId}>${e.targetId}>${e.relation}`), sorted.map((e) => `${e.sourceId}>${e.targetId}>${e.relation}`));
        assert.deepEqual((await g.queryEdges({ limit: 5, offset: 20 })).map((e) => e.sourceId + e.targetId), all.slice(20, 25).map((e) => e.sourceId + e.targetId));
    });

    console.log('\nbackup / restore');
    await test('discovery backs up edges_dangling and excludes migration scaffolding by name', async () => {
        await q('CREATE TABLE IF NOT EXISTS edges_pre_pk (workspace_id TEXT, x int)');
        await q('CREATE TABLE IF NOT EXISTS edges_next (workspace_id TEXT, x int)');
        const c = await pool.connect();
        try {
            const d = await discoverWorkspaceSchema(c);
            assert.ok(d.tables.some((t) => t.name === 'edges_dangling'));
            assert.ok(d.tables.some((t) => t.name === 'edges'));
            for (const n of ['edges_pre_pk', 'edges_next']) {
                assert.ok(!d.tables.some((t) => t.name === n), `${n} not exported`);
                assert.ok(d.excluded.some((e) => e.table === n), `${n} reported as excluded`);
            }
        } finally { c.release(); await q('DROP TABLE edges_pre_pk, edges_next'); }
    });
    await test('quarantined rows and remapped edges survive a same-database restore into a new workspace', async () => {
        const out = path.join(tmp, 'bundle');
        const sum = await exportWorkspaceBundle(pool, { workspaceId: A, outDir: out });
        const r = await restoreWorkspaceBundle(pool, { bundlePath: sum.bundlePath, targetWorkspaceId: 'pg-gate-pkmig-restored' });
        assert.ok(r.idRemaps.some((m) => m.table === 'edges' && m.column === 'src_sk'));
        const live = async (ws: string) => Number((await q<{ c: string }>(`SELECT count(*) AS c FROM edges e JOIN nodes s ON s.sk = e.src_sk JOIN nodes t ON t.sk = e.dst_sk WHERE e.workspace_id = $1`, [ws]))[0]!.c);
        assert.equal(await live('pg-gate-pkmig-restored'), await live(A));
        assert.equal(Number((await q<{ c: string }>("SELECT count(*) AS c FROM edges_dangling WHERE workspace_id = 'pg-gate-pkmig-restored'"))[0]!.c),
            Number((await q<{ c: string }>('SELECT count(*) AS c FROM edges_dangling WHERE workspace_id = $1', [A]))[0]!.c));
    });
    await g.close();
} finally {
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
