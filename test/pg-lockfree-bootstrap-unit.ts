#!/usr/bin/env tsx
/**
 * test/pg-lockfree-bootstrap-unit.ts - 3.38.1: a steady-state Postgres open takes no table lock.
 *
 * The bug (found by the 1M-row 3.37.2 -> 3.38.0 upgrade run): one embedded open builds two PostgresGraph handles.
 * The first starts a background CREATE INDEX CONCURRENTLY; the second's bootstrap replays
 * `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ...`, which waits for ACCESS EXCLUSIVE even though the columns exist,
 * and the concurrent build waits for that statement: deadlock 40P01, open fails. Postgres takes the lock before the
 * "if not exists" check for CREATE INDEX IF NOT EXISTS and ADD COLUMN IF NOT EXISTS alike.
 *
 *   parse      the statement splitter / classifier recognizes the bootstrap DDL and passes everything else through
 *   lock       with another session holding SHARE UPDATE EXCLUSIVE (what a concurrent index build holds) on every
 *              graph and table-storage table, a second graph open and table-storage open both complete
 *   repair     a missing index or column is still created by the next open (the guard only skips what exists)
 *   two-handle a large-table open (background builds pending) plus a second handle opened right after both succeed
 *   builds     the keyword, workspace-sk and created_at_ts background builds never run CREATE INDEX CONCURRENTLY together
 *              (they deadlocked on the 1M run) and leave no INVALID index
 *
 * Runs against the throwaway database `lore_gate_lockfree` on the LORE_PG_URL server (skips with a printed reason
 * when LORE_PG_URL is unset).
 *
 * Run: npx tsx test/pg-lockfree-bootstrap-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { classifyDdl, classifyStatement, splitSqlStatements } from '../packages/lore/src/engines/postgres/postgresLockFreeDdl.js';
import { workspaceSkBuildDone } from '../packages/lore/src/engines/postgres/postgresWorkspaceSk.js';
import { KEYWORD_INDEXES } from '../packages/lore/src/engines/postgres/postgresKeywordIndex.js';
import { gateDbUrl } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

/* ── parse (no database) ─────────────────────────────────────────── */

await test('parse: splitter keeps quotes, dollar bodies and drops comments', () => {
    const parts = splitSqlStatements(`
        CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT ';');
        -- a comment with a quote ' and a ; inside
        CREATE INDEX IF NOT EXISTS i ON t(a);
        /* block ; comment */ DO $$ BEGIN PERFORM 1; END $$;`);
    assert.equal(parts.length, 3);
    assert.match(parts[0]!, /DEFAULT ';'\)$/);
    assert.match(parts[1]!, /^CREATE INDEX IF NOT EXISTS i ON t\(a\)$/);
    assert.match(parts[2]!, /^DO \$\$ BEGIN PERFORM 1; END \$\$$/);
});

await test('parse: recognizes the bootstrap DDL shapes', () => {
    assert.deepEqual(classifyStatement('CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(workspace_id, "updatedAt" DESC, id)'),
        { kind: 'index', sql: 'CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(workspace_id, "updatedAt" DESC, id)', table: 'nodes', index: 'idx_nodes_updatedat' });
    const u = classifyStatement('CREATE UNIQUE INDEX IF NOT EXISTS lore_link_to_uq ON lore_entity_link (workspace_id) WHERE valid_to IS NULL');
    assert.equal(u?.kind, 'index');
    const c = classifyStatement(`ALTER TABLE nodes
            ADD COLUMN IF NOT EXISTS valid_from_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS valid_until_at TIMESTAMPTZ`);
    assert.deepEqual(c && c.kind === 'columns' ? c.columns : null, ['valid_from_at', 'valid_until_at']);
    const chk = classifyStatement('ALTER TABLE v ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))');
    assert.deepEqual(chk && chk.kind === 'columns' ? chk.columns : null, ['confidence']);
    const q = classifyStatement('ALTER TABLE t ADD IF NOT EXISTS "MixedCase" NUMERIC(10, 2)');
    assert.deepEqual(q && q.kind === 'columns' ? q.columns : null, ['MixedCase']);
    assert.equal(classifyStatement('CREATE TABLE IF NOT EXISTS link_optout ( workspace_id TEXT )')?.kind, 'table');
});

await test('parse: anything else passes through untouched', () => {
    for (const sql of [
        'ALTER TABLE nodes ADD COLUMN sk BIGINT',                                  // no IF NOT EXISTS
        'ALTER TABLE nodes ADD COLUMN IF NOT EXISTS a INT, DROP COLUMN b',         // a mixed ALTER
        'ALTER TABLE nodes ADD CONSTRAINT k UNIQUE USING INDEX k',
        'CREATE INDEX i ON t(a)',                                                  // no IF NOT EXISTS
        'CREATE EXTENSION IF NOT EXISTS pg_trgm',
        'DO $$ BEGIN END $$',
        'SELECT 1',
    ]) assert.equal(classifyStatement(sql), null, sql);
    assert.equal(classifyDdl('CREATE INDEX IF NOT EXISTS i ON t(a); SELECT 1'), null, 'one unknown statement disables the guard');
    assert.equal(classifyDdl('   '), null);
});

/* ── database cases ──────────────────────────────────────────────── */

const DB = 'lore_gate_lockfree';
const A = 'pg-lockfree-a';
const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-lockfree-bootstrap database cases: LORE_PG_URL is not set');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}
const urlFor = (db: string): string => { const u = new URL(gate); u.pathname = `/${db}`; return u.toString(); };
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: urlFor('postgres') });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: urlFor(DB), max: 8 });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const open = async (ws: string, opts: { keywordIndexInlineRowLimit?: number } = {}): Promise<PostgresGraph> => {
    const g = new PostgresGraph(ws, pool, opts); await g.initialize(); return g;
};
const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;

/** Resolve `p`, or fail after `ms` (the caller then frees whatever was blocking it). */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms (blocked on a table lock)`)), ms); });
    try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
}

const TABLES = ['nodes', 'edges', 'link_optout', 'lore_entity', 'lore_entity_value', 'lore_entity_link', 'lore_entity_alias',
    'lore_entity_type', 'lore_field_def', 'lore_link_type'];

try {
    // First open of a fresh database creates everything (real DDL, not skipped).
    const g0 = await open(A);
    const t0 = await PostgresTableStorage.open(A, pool);
    await t0.waitForIndexes();
    await g0.close(); await t0.close();

    await test('lock: a steady-state open completes while another session holds SHARE UPDATE EXCLUSIVE on every table', async () => {
        const present = (await q<{ t: string }>('SELECT relname AS t FROM pg_class WHERE relname = ANY($1) AND relkind = \'r\'', [TABLES])).map((r) => r.t);
        assert.ok(present.includes('nodes') && present.includes('edges') && present.includes('lore_entity_value'), `tables: ${present.join(',')}`);
        const locker = new Client({ connectionString: urlFor(DB) });
        await locker.connect();
        try {
            await locker.query('BEGIN');
            for (const t of present) await locker.query(`LOCK TABLE ${t} IN SHARE UPDATE EXCLUSIVE MODE`);
            let g: PostgresGraph | undefined;
            let t: PostgresTableStorage | undefined;
            try {
                g = await within(open(A), 15_000, 'graph open');
                t = await within(PostgresTableStorage.open(A, pool), 15_000, 'table-storage open');
            } finally {
                await locker.query('ROLLBACK'); // frees a blocked open on failure so the test can still clean up
                await g?.close(); await t?.close();
            }
        } finally { await locker.end(); }
    });

    await test('repair: a missing index and a missing column are still created by the next open', async () => {
        await q('DROP INDEX idx_nodes_type');
        await q('DROP INDEX idx_edges_relation');
        await q('ALTER TABLE nodes DROP COLUMN valid_until_at');
        await (await open(A)).close();
        const idx = await q<{ n: string }>("SELECT count(*)::text AS n FROM pg_class WHERE relname IN ('idx_nodes_type', 'idx_edges_relation')");
        assert.equal(Number(idx[0]!.n), 2);
        const col = await q("SELECT 1 FROM pg_attribute WHERE attrelid = 'nodes'::regclass AND attname = 'valid_until_at' AND NOT attisdropped");
        assert.equal(col.length, 1);
    });

    await test('two-handle: an open that leaves the edge index to the background build, then a second handle, both succeed', async () => {
        const g = await open(A);
        for (let i = 0; i < 60; i++) await g.upsertNode(node(`n${i}`));
        for (let i = 0; i < 59; i++) await g.addEdge({ sourceId: `n${i}`, targetId: `n${i + 1}`, relation: 'next' });
        await g.close();
        // The edges table (59 rows) is now over the inline limit below, so rebuilding this index is background work.
        await q('DROP INDEX IF EXISTS idx_edges_ws_dst_sk');
        // inline limit below the row count: the workspace-sk / keyword work goes to the background build.
        const g1 = await open(A, { keywordIndexInlineRowLimit: 10 });
        const g2 = await within(open(A, { keywordIndexInlineRowLimit: 10 }), 30_000, 'second handle open');
        await workspaceSkBuildDone(pool);
        await g2.close(); await g1.close();
        const ok = await q<{ v: boolean }>('SELECT i.indisvalid AND i.indisready AS v FROM pg_index i WHERE i.indexrelid = to_regclass($1)', ['idx_edges_ws_dst_sk']);
        assert.equal(ok[0]?.v, true, 'the background build finished the workspace-led edge index');
    });

    await test('builds: keyword, workspace-sk and created_at_ts background builds run one at a time and leave no INVALID index', async () => {
        // Make every builder pending at once: keyword trgm indexes, the workspace-led edge index, the created_at_ts
        // pending index plus rows to backfill. On the 1M run two of these ran CREATE INDEX CONCURRENTLY on `nodes`
        // together and deadlocked, leaving idx_nodes_created_at_ts_pending INVALID.
        for (const k of KEYWORD_INDEXES) await q(`DROP INDEX IF EXISTS ${k.name}`);
        await q('DROP INDEX IF EXISTS idx_edges_ws_dst_sk');
        await q('DROP INDEX IF EXISTS idx_nodes_created_at_ts_pending');
        // Enough rows that each build takes long enough for an overlap to show (tiny tables finish in milliseconds).
        await q(`INSERT INTO nodes (workspace_id, id, label, content)
                 SELECT workspace_id, 'bulk-' || g, 'bulk ' || g, repeat(md5(g::text), 8)
                   FROM (SELECT workspace_id FROM nodes LIMIT 1) w, generate_series(1, 60000) g`);
        await q(`UPDATE nodes SET "createdAt" = '2026-01-02T03:04:05.000Z', created_at_ts = NULL`);
        const watcher = new Client({ connectionString: urlFor(DB) });
        await watcher.connect();
        let peak = 0, watching = true;
        const watch = (async () => {
            while (watching) {
                const r = await watcher.query<{ n: string }>(
                    "SELECT count(*) AS n FROM pg_stat_progress_create_index WHERE command = 'CREATE INDEX CONCURRENTLY'");
                peak = Math.max(peak, Number(r.rows[0]!.n));
                await new Promise((res) => setTimeout(res, 5));
            }
        })();
        try {
            const g = await open(A, { keywordIndexInlineRowLimit: 10 });
            await Promise.all([g.waitForKeywordIndexes(), g.waitForWorkspaceSk(), g.waitForCreatedAtTs()]);
            await g.close();
        } finally { watching = false; await watch; await watcher.end(); }
        assert.ok(peak <= 1, `${peak} concurrent index builds ran at once`);
        const invalid = await q<{ name: string }>(
            "SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT (i.indisvalid AND i.indisready)");
        assert.deepEqual(invalid.map((r) => r.name), [], 'no INVALID index left behind');
        const want = [...KEYWORD_INDEXES.map((k) => k.name), 'idx_edges_ws_dst_sk', 'idx_nodes_created_at_ts_pending'];
        const have = (await q<{ name: string }>('SELECT relname AS name FROM pg_class WHERE relname = ANY($1)', [want])).map((r) => r.name);
        assert.deepEqual(have.sort(), want.slice().sort(), 'every background index was built');
        const left = await q('SELECT 1 FROM nodes WHERE created_at_ts IS NULL LIMIT 1');
        assert.equal(left.length, 0, 'the created_at_ts backfill finished');
    });
} finally {
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
