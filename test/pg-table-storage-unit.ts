#!/usr/bin/env tsx
/**
 * test/pg-table-storage-unit.ts - PostgresTableStorage (Tables P1, slice 1).
 *
 * Runs against a throwaway database `lore_gate_tables` created on the LORE_PG_URL server (skips with a printed
 * reason when LORE_PG_URL is unset).
 *
 *   contract    Postgres twin of the SqliteTableStorage contract: createTable idempotency + shape errors, type
 *               round-trip, constraints, filters/order/limit, update history, delete guards, transactions,
 *               joins, evolveSchema, workspace isolation
 *   acceptance  (a) a typed row joins to its memory node in ONE SQL statement
 *               (b) "as of D" is a SQL predicate: the full valid set comes back, no page-filter under-return
 *   wiring      ingestion writeStructuredFields writes real rows through the table factory path
 *
 * Run: npx tsx test/pg-table-storage-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { writeStructuredFields } from '../packages/lore/src/ingestion/tableWriter.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { gateDbUrl } from './helpers/testPostgres.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = 'lore_gate_tables';
const WS = 'pg-gate-tables';
const WS2 = 'pg-gate-tables-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-table-storage: LORE_PG_URL is not set - postgres cases skipped cleanly');
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
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const rejects = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
    try { await p; } catch (e) { assert.match((e as Error).message, re); return; }
    assert.fail(`expected rejection matching ${re}`);
};

const ALL_TYPES: TableSchema = {
    name: 'all_types',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 's', type: 'string' }, { name: 'i', type: 'integer' }, { name: 'f', type: 'float' },
        { name: 'b', type: 'boolean' }, { name: 'd', type: 'date' }, { name: 'ts', type: 'datetime' }, { name: 'j', type: 'json' },
    ],
};
const ACCOUNTS: TableSchema = {
    name: 'accounts',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'email', type: 'string', unique: true },
        { name: 'name', type: 'string', required: true, indexed: true },
        { name: 'balance', type: 'integer' },
    ],
};
const LEDGER: TableSchema = {
    name: 'ledger',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'account_id', type: 'string', required: true },
        { name: 'amount', type: 'integer', required: true },
    ],
};

try {
    const t = await PostgresTableStorage.open(WS, pool);
    const other = await PostgresTableStorage.open(WS2, pool);

    console.log('\ncontract');
    await test('createTable is idempotent; a different shape is refused; listTables sees it', async () => {
        await t.createTable(ACCOUNTS);
        await t.createTable(ACCOUNTS);
        await rejects(t.createTable({ ...ACCOUNTS, columns: [...ACCOUNTS.columns, { name: 'extra', type: 'string' }] }), /different shape/);
        const list = await t.listTables();
        assert.ok(list.some(x => x.name === 'accounts' && x.primaryKey === 'id'));
    });
    await test('unknown table error names the op', async () => {
        await rejects(t.insert('nope', { id: 'x' }), /PostgresTableStorage\.insert: unknown table 'nope'/);
    });
    await test('all seven types round-trip', async () => {
        await t.createTable(ALL_TYPES);
        await t.insert('all_types', { id: 'a', s: 'hi', i: 42, f: 1.5, b: true, d: '2026-03-04', ts: '2026-03-04T05:06:07.000Z', j: { k: [1, 2] } });
        await t.insert('all_types', { id: 'n' });
        const a = await t.getByKey('all_types', 'a');
        assert.deepEqual(a, { id: 'a', s: 'hi', i: 42, f: 1.5, b: true, d: '2026-03-04', ts: '2026-03-04T05:06:07.000Z', j: { k: [1, 2] } });
        const n = await t.getByKey('all_types', 'n');
        assert.deepEqual(n, { id: 'n', s: null, i: null, f: null, b: null, d: null, ts: null, j: null });
        assert.equal(await t.getByKey('all_types', 'missing'), null);
    });
    await test('duplicate pk, unique and required violations', async () => {
        await t.insert('accounts', { id: '1', email: 'a@x', name: 'Ann', balance: 10 });
        await rejects(t.insert('accounts', { id: '1', email: 'b@x', name: 'Bob' }), /UNIQUE constraint failed: accounts\.id/);
        await rejects(t.insert('accounts', { id: '2', email: 'a@x', name: 'Bob' }), /UNIQUE constraint failed: accounts\.email/);
        await rejects(t.insert('accounts', { id: '3', email: 'c@x' }), /name/);
        assert.equal(await t.count('accounts'), 1);
    });
    await test('filters, ordering (NULLS), limit, case-sensitive contains', async () => {
        await t.insertBatch('accounts', [
            { id: '2', email: 'b@x', name: 'Bob', balance: 5 },
            { id: '3', email: 'c@x', name: 'carol', balance: null },
            { id: '4', email: 'd@x', name: 'Dan', balance: 30 },
        ]);
        assert.deepEqual((await t.query('accounts', { gte: { balance: 10 } }, { orderBy: 'balance', orderDir: 'desc' })).map(r => r['id']), ['4', '1']);
        assert.deepEqual((await t.query('accounts', {}, { orderBy: 'balance' })).map(r => r['id']), ['3', '2', '1', '4'], 'NULLS FIRST on asc');
        assert.deepEqual((await t.query('accounts', {}, { orderBy: 'balance', orderDir: 'desc' })).map(r => r['id']), ['4', '1', '2', '3'], 'NULLS LAST on desc');
        assert.equal((await t.query('accounts', {}, { limit: 2 })).length, 2);
        assert.deepEqual((await t.query('accounts', { contains: { name: 'ar' } })).map(r => r['id']), ['3']);
        assert.deepEqual((await t.query('accounts', { contains: { name: 'AR' } })).map(r => r['id']), []);
        assert.deepEqual((await t.query('accounts', { or: [{ eq: { id: '1' } }, { startsWith: { name: 'D' } }] })).map(r => r['id']), ['1', '4']);
        assert.deepEqual((await t.query('accounts', { not: { eq: { id: '1' } } }, { limit: 1 })).map(r => r['id']), ['2']);
        assert.equal(await t.count('accounts', { lt: { balance: 10 } }), 1);
    });
    await test('update keeps value history (superseded row), set-null, and refuses a pk change', async () => {
        assert.equal(await t.update('accounts', { eq: { id: '2' } }, { balance: 6 }), 1);
        assert.equal((await t.getByKey('accounts', '2'))!['balance'], 6);
        const hist = await q<{ n: string }>(
            `SELECT count(*)::text AS n FROM lore_entity_value v JOIN lore_entity e ON e.workspace_id=v.workspace_id AND e.entity_id=v.entity_id
              JOIN lore_field_def f ON f.workspace_id=v.workspace_id AND f.field_id=v.field_id
              WHERE e.workspace_id=$1 AND e.pk_text='2' AND f.name='balance' AND v.superseded_at IS NOT NULL`, [WS]);
        assert.equal(Number(hist[0]!.n), 1, 'the old value stays as a superseded row');
        await t.update('accounts', { eq: { id: '2' } }, { balance: null });
        assert.equal((await t.getByKey('accounts', '2'))!['balance'], null);
        await rejects(t.update('accounts', { eq: { id: '2' } }, { id: 'zz' }), /primary key/i);
        await rejects(t.update('accounts', { eq: { id: '2' } }, { name: null }), /name/);
    });
    await test('update/delete guards: empty filter, tautology, all:true', async () => {
        await rejects(t.delete('accounts', {}), /empty|all/i);
        await rejects(t.update('accounts', {}, { balance: 1 }), /empty|all/i);
        await rejects(t.delete('accounts', { not: { eq: { id: 'zzz' } } }), /empty\/all filter.*truncate/is);
        assert.equal(await t.count('accounts'), 4);
        assert.equal(await t.delete('accounts', { eq: { id: '3' } }), 1);
        assert.equal(await t.update('accounts', { gte: { id: '0' } }, { balance: 7 }, { all: true }), 3);
    });
    await test('truncate empties the table but keeps it', async () => {
        await t.createTable({ name: 'tmp', columns: [{ name: 'id', type: 'string', primary: true }] });
        await t.insertBatch('tmp', [{ id: 'a' }, { id: 'b' }]);
        assert.equal(await t.truncate('tmp'), 2);
        assert.equal(await t.count('tmp'), 0);
        await t.insert('tmp', { id: 'a' });
        assert.equal(await t.count('tmp'), 1);
    });
    await test('runTransaction is atomic, reports failedOpIndex, upsert works, limits enforced', async () => {
        await t.createTable(LEDGER);
        const res = await t.runTransaction([
            { op: 'insert', collection: 'ledger', row: { id: 'l1', account_id: '1', amount: 5 } },
            { op: 'upsert', collection: 'ledger', row: { id: 'l1', account_id: '1', amount: 9 } },
            { op: 'update', collection: 'accounts', filter: { eq: { id: '1' } }, patch: { balance: 99 } },
        ]);
        assert.equal(res.length, 3);
        assert.equal((await t.getByKey('ledger', 'l1'))!['amount'], 9);
        let err: (Error & { failedOpIndex?: number }) | undefined;
        try {
            await t.runTransaction([
                { op: 'insert', collection: 'ledger', row: { id: 'l2', account_id: '1', amount: 1 } },
                { op: 'insert', collection: 'ledger', row: { id: 'l1', account_id: '1', amount: 1 } },
            ]);
        } catch (e) { err = e as Error; }
        assert.ok(err); assert.match(err!.message, /table transaction operation 1 failed/);
        assert.equal(err!.failedOpIndex, 1);
        assert.equal(await t.getByKey('ledger', 'l2'), null, 'rolled back');
        await rejects(t.runTransaction([]), /at least|1/i);
    });
    await test('join / joinMany inner and left', async () => {
        await t.insertBatch('ledger', [{ id: 'l3', account_id: '4', amount: 3 }, { id: 'l4', account_id: 'ghost', amount: 4 }]);
        const inner = await t.join('ledger', { table: 'accounts', on: { left: 'account_id', right: 'id' } }, undefined, { orderBy: 'amount' });
        assert.equal(inner.length, 2);
        const left = await t.joinMany({ from: 'ledger', join: [{ collection: 'accounts', on: { from: 'account_id', to: 'id' }, type: 'left' }], opts: { orderBy: 'amount' } });
        assert.equal(left.length, 3);
        assert.equal(left[1]!['accounts.id'], null);
        assert.equal(left[0]!['ledger.id'], 'l3');
    });
    await test('evolveSchema: add column/index, refusals, required backfill', async () => {
        const steps = await t.evolveSchema('accounts', {
            ...ACCOUNTS, columns: [...ACCOUNTS.columns, { name: 'tier', type: 'string', required: true }, { name: 'note', type: 'string', indexed: true }],
        });
        assert.deepEqual(steps.map(s => `${s.kind}:${s.column}`).sort(), ['add_column:note', 'add_column:tier', 'add_index:note'].sort());
        assert.equal((await t.getByKey('accounts', '1'))!['tier'], '');
        await t.update('accounts', { eq: { id: '1' } }, { tier: 'gold', note: 'n' });
        assert.equal((await t.query('accounts', { eq: { tier: 'gold' } })).length, 1);
        await rejects(t.evolveSchema('accounts', { name: 'accounts', columns: ACCOUNTS.columns.filter(c => c.name !== 'balance') }), /remov|drop/i);
        await rejects(t.evolveSchema('accounts', { name: 'accounts', columns: ACCOUNTS.columns.map(c => c.name === 'balance' ? { ...c, type: 'string' as const } : c) }), /type/i);
    });
    await test('workspaces are isolated: same table name, separate rows, views do not cross', async () => {
        await other.createTable({ name: 'accounts', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'tag', type: 'string' }] });
        await other.insert('accounts', { id: '1', tag: 'other-ws' });
        assert.deepEqual(await other.query('accounts'), [{ id: '1', tag: 'other-ws' }]);
        assert.equal((await t.getByKey('accounts', '1'))!['tag' as never], undefined);
        assert.equal(await other.count('accounts'), 1);
        const leak = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${await other.readView('accounts')} WHERE _lore_pk = '4'`);
        assert.equal(Number(leak[0]!.n), 0);
        assert.deepEqual((await PostgresTableStorage.open(WS2, pool)).schemas.has('ledger'), false);
    });

    console.log('\nacceptance');
    const g = new PostgresGraph(WS, pool); await g.initialize();
    const node = (id: string, label: string) =>
        ({ id, type: 'note', label, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
    await t.createTable({
        name: 'deals',
        columns: [
            { name: 'id', type: 'string', primary: true },
            { name: 'amount', type: 'integer' },
            { name: '_memory_node_id', type: 'string' },
            { name: '_source_id', type: 'string', indexed: true },
            { name: '_valid_from', type: 'datetime' },
            { name: '_valid_to', type: 'datetime' },
        ],
    });
    await test('(a) a typed row joins to its node in ONE SQL statement', async () => {
        await g.upsertNode(node('n-1', 'Deal one')); await g.upsertNode(node('n-2', 'Deal two'));
        await t.insertBatch('deals', [
            { id: 'd1', amount: 100, _memory_node_id: 'n-1', _source_id: 'src-1' },
            { id: 'd2', amount: 200, _memory_node_id: 'n-2', _source_id: 'src-1' },
            { id: 'd3', amount: 300, _memory_node_id: 'n-missing' },
            { id: 'd4', amount: 400 },
        ]);
        // raw SQL: the view joins to nodes directly
        const raw = await q<{ id: string; label: string; amount: string }>(
            `SELECT v.id, n.label, v.amount::text AS amount FROM ${await t.readView('deals')} v
               JOIN nodes n ON n.workspace_id = $1 AND n.id = v._lore_memory_node_id WHERE v.amount >= 100 ORDER BY v.id`, [WS]);
        assert.deepEqual(raw.map(r => [r.id, r.label, r.amount]), [['d1', 'Deal one', '100'], ['d2', 'Deal two', '200']]);
        // helper: exactly one pool.query call
        let calls = 0; const orig = pool.query.bind(pool);
        (pool as unknown as { query: unknown }).query = (...a: unknown[]) => { calls++; return (orig as (...x: unknown[]) => unknown)(...a); };
        let inner: Record<string, unknown>[], left: Record<string, unknown>[];
        try { inner = await t.queryWithNodes('deals', { gte: { amount: 100 } }) } finally { (pool as unknown as { query: unknown }).query = orig; }
        assert.equal(calls, 1, 'one statement');
        assert.deepEqual(inner.map(r => [r['id'], r['node.label']]), [['d1', 'Deal one'], ['d2', 'Deal two']]);
        left = await t.queryWithNodes('deals', undefined, { join: 'left' });
        assert.deepEqual(left.map(r => [r['id'], r['node.id'] ?? null]), [['d1', 'n-1'], ['d2', 'n-2'], ['d3', null], ['d4', null]]);
    });
    await test('a row whose node is created later still joins (text key, sk may be null)', async () => {
        const before = await q<{ sk: string | null }>(`SELECT memory_node_sk::text AS sk FROM lore_entity WHERE workspace_id=$1 AND pk_text='d3'`, [WS]);
        assert.equal(before[0]!.sk, null);
        await g.upsertNode(node('n-missing', 'Late node'));
        const rows = await t.queryWithNodes('deals', { eq: { id: 'd3' } });
        assert.equal(rows[0]!['node.label'], 'Late node');
    });
    await test('source_id is a join key to the entity header', async () => {
        const r = await q<{ n: string }>(`SELECT count(*)::text AS n FROM lore_entity WHERE workspace_id=$1 AND source_id='src-1'`, [WS]);
        assert.equal(Number(r[0]!.n), 2);
        assert.deepEqual((await t.query('deals', { eq: { _source_id: 'src-1' } })).map(x => x['id']), ['d1', 'd2']);
    });
    await test('(b) "as of D" is a SQL predicate: no page-filter under-return, half-open bounds, NULL = unbounded', async () => {
        await t.createTable({
            name: 'terms',
            columns: [{ name: 'id', type: 'string', primary: true }, { name: 'v', type: 'integer' }, { name: '_valid_from', type: 'datetime' }, { name: '_valid_to', type: 'datetime' }],
        });
        // 120 rows: the first 110 expired before D; the last 10 are valid at D (10 spread in the id order's tail).
        const D = '2026-06-01T00:00:00.000Z';
        const rows = Array.from({ length: 120 }, (_, i) => ({
            id: `t${String(i).padStart(3, '0')}`, v: i,
            ...(i < 110 ? { _valid_from: '2025-01-01T00:00:00.000Z', _valid_to: '2026-01-01T00:00:00.000Z' }
                : { _valid_from: '2026-01-01T00:00:00.000Z', _valid_to: i === 119 ? null : '2027-01-01T00:00:00.000Z' }),
        }));
        await t.insertBatch('terms', rows);
        const page = await t.queryAsOf('terms', D, undefined, { limit: 5 });
        assert.equal(page.length, 5, 'a small page is full of valid rows (a page-then-filter would return 0)');
        assert.ok(page.every(r => Number(r['v']) >= 110));
        assert.equal((await t.queryAsOf('terms', D)).length, 10, 'the full valid set');
        // half-open: valid_from included, valid_to excluded
        assert.equal((await t.queryAsOf('terms', '2026-01-01T00:00:00.000Z')).length, 10);
        assert.equal((await t.queryAsOf('terms', '2025-12-31T23:59:59.999Z')).length, 110);
        assert.equal((await t.queryAsOf('terms', '2027-01-01T00:00:00.000Z')).length, 1, 'valid_to is excluded; NULL stays valid');
        assert.equal((await t.queryAsOf('terms', '2024-01-01T00:00:00.000Z')).length, 0);
        assert.equal((await t.queryAsOf('terms', D, { gte: { v: 115 } })).length, 5, 'filter composes with as-of');
    });

    console.log('\nwiring');
    await test('writeStructuredFields writes real rows through the Postgres table storage', async () => {
        const source = { sourceId: 'src-w', workspace: WS, fileName: 'f.pdf', mimeType: 'application/pdf', sha256: 'x', sizeBytes: 1, storageRef: 'r', createdAt: new Date().toISOString() };
        const result = {
            contractVersion: 'b1', jobId: 'job-1', annotations: null, incomplete: false,
            processor: { id: 'p', version: '1' },
            content: { items: [{ name: 'A', qty: 2, ok: true }, { name: 'B', qty: 3, ok: false, extra: { z: 1 } }] },
        } as never;
        const out = await writeStructuredFields({ port: { forWorkspace: async () => t }, source: source as never, jobId: 'job-1', result, itemPath: 'items', tableBase: 'lines' });
        assert.equal(out.kind, 'written');
        assert.equal((out as { rows: number }).rows, 2);
        const rows = await t.query((out as { table: string }).table, undefined, { orderBy: 'name' });
        assert.deepEqual(rows.map(r => [r['name'], r['qty'], r['ok'], r['_source_id']]), [['A', 2, true, 'src-w'], ['B', 3, false, 'src-w']]);
        // retry of the same job is idempotent
        await writeStructuredFields({ port: { forWorkspace: async () => t }, source: source as never, jobId: 'job-1', result, itemPath: 'items', tableBase: 'lines' });
        assert.equal(await t.count((out as { table: string }).table), 2);
    });
    await test('LocalGraphRegistry.tableStorageFor: postgres workspace -> PostgresTableStorage, sqlite workspace -> SqliteTableStorage', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pgtables-reg-'));
        const mk = (name: string, engine: string): { name: string; path: string; graphEngine: string } => {
            const p = path.join(home, 'workspaces', name); fs.mkdirSync(path.join(p, '.lore'), { recursive: true });
            return { name, path: p, graphEngine: engine };
        };
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ version: 1, active: 'pg-gate-reg-pg', workspaces: [mk('pg-gate-reg-pg', 'postgres'), mk('pg-gate-reg-sq', 'sqlite')] }));
        const prev = process.env['LORE_PG_URL']; process.env['LORE_PG_URL'] = dbUrl.toString();
        const registry = new LocalGraphRegistry({ autoEvict: false, home });
        try {
            const pg = await registry.tableStorageFor('pg-gate-reg-pg');
            assert.equal(pg.constructor.name, 'PostgresTableStorage');
            assert.equal(await registry.tableStorageFor('pg-gate-reg-pg'), pg, 'cached per workspace');
            assert.ok((await registry.tableStorageFor('pg-gate-reg-sq')) instanceof SqliteTableStorage);
            assert.equal(fs.existsSync(path.join(home, 'workspaces', 'pg-gate-reg-pg', '.lore', 'tables.sqlite')), false, 'no sqlite file for a postgres workspace');
        } finally {
            await registry.disposeAll();
            await closeSharedPostgresPool();
            if (prev === undefined) delete process.env['LORE_PG_URL']; else process.env['LORE_PG_URL'] = prev;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
