#!/usr/bin/env tsx
/**
 * test/pg-tables-wiring-unit.ts - table storage is ONE backend per workspace on every code path.
 *
 * PR #222 made `LocalGraphRegistry.tableStorageFor` return Postgres tables for a Postgres-engine workspace, but the
 * MCP storage bundle (`createStorageClient`, behind store.tableStorage) and `lore diagnose` still built the SQLite
 * file regardless: tables written through MCP tools / ingestion landed in SQLite while registry-routed writes landed
 * in Postgres (split brain). Both now go through `createWorkspaceTableStorage` (tableStorageFactory.ts).
 *
 *   pg workspace      a table + row written via the bundle path is visible via the registry path, and the other way
 *                     round; no tables.sqlite is created; diagnose's table reader reports the Postgres rows
 *   sqlite workspace  bundle and registry are SQLite over the same file; tables.sqlite exists (behaviour unchanged)
 *   legacy callers    createStorageClient without a workspace still builds the SQLite file
 *   structure         no src file outside tableStorageFactory builds SqliteTableStorage / calls createTableStorage
 *                     except the allow-listed ones
 *
 * Runs against a throwaway database on the LORE_PG_URL server (skips with a printed reason when it is unset).
 * Run: npx tsx test/pg-tables-wiring-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

import { createStorageClient } from '../packages/lore/src/mcp/storageBundle.js';
import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { diagnoseConsistency } from '../packages/lore/src/diagnostics/consistency.js';
import type { ITableStorage, TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tables_wiring';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-tables-wiring: LORE_PG_URL is not set - postgres cases skipped cleanly');
    process.exit(0);
}
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

const WS_PG = 'pg-gate-wire-pg';
const WS_SQ = 'pg-gate-wire-sq';
const ORDERS: TableSchema = { name: 'orders', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'node_ref', type: 'string' }] };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pgtables-wiring-'));
const wsPath = (n: string): string => path.join(home, 'workspaces', n);
const sqliteFile = (n: string): string => path.join(wsPath(n), '.lore', 'tables.sqlite');
for (const [n, engine] of [[WS_PG, 'postgres'], [WS_SQ, 'sqlite']] as const) fs.mkdirSync(path.join(wsPath(n), '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1, active: WS_PG,
    workspaces: [{ name: WS_PG, path: wsPath(WS_PG), graphEngine: 'postgres' }, { name: WS_SQ, path: wsPath(WS_SQ), graphEngine: 'sqlite' }],
}));

// createStorageClient only reads these two structurally on the local path.
const fakeGraph = { listNodes: async () => [] } as never;
const fakeVerbatim = { bulkUpsertPrebuiltRows: () => undefined, handleCount: () => 0, tombstone: () => undefined } as never;
const bundleFor = (ws: string, withTables = true): Promise<{ tableStorage: ITableStorage }> =>
    createStorageClient(fakeGraph, fakeVerbatim, 'local', wsPath(ws), withTables ? { workspace: ws, home } : undefined);

const prevPg = process.env['LORE_PG_URL'];
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
process.env['LORE_PG_URL'] = dbUrl.toString();
const registry = new LocalGraphRegistry({ autoEvict: false, home });
const open: ITableStorage[] = [];
try {
    console.log('postgres workspace');
    await test('bundle (MCP/services path) and registry see the same Postgres tables and rows, in both directions', async () => {
        const bundle = (await bundleFor(WS_PG)).tableStorage;
        open.push(bundle);
        assert.equal(bundle.constructor.name, 'PostgresTableStorage', 'bundle table storage follows the workspace engine');
        await bundle.createTable(ORDERS);
        await bundle.insert('orders', { id: 'o1', node_ref: 'n1' });

        const viaRegistry = await registry.tableStorageFor(WS_PG);
        assert.equal(viaRegistry.constructor.name, 'PostgresTableStorage');
        assert.deepEqual((await viaRegistry.listTables()).map(t => t.name), ['orders']);
        assert.deepEqual((await viaRegistry.query('orders')).map(r => r['id']), ['o1']);

        await viaRegistry.insert('orders', { id: 'o2', node_ref: 'n2' });
        assert.deepEqual((await bundle.query('orders', undefined, { orderBy: 'id' })).map(r => r['id']), ['o1', 'o2']);
        assert.equal(await bundle.count('orders'), 2);
    });
    await test('a Postgres workspace never creates or writes tables.sqlite on either path', async () => {
        assert.equal(fs.existsSync(sqliteFile(WS_PG)), false);
        assert.deepEqual(fs.readdirSync(path.join(wsPath(WS_PG), '.lore')).filter(f => /tables|collection-schemas/.test(f)), []);
    });
    await test('closing the bundle handle does not break the registry handle (shared pool is not owned by either)', async () => {
        const bundle = (await bundleFor(WS_PG)).tableStorage;
        await (bundle as unknown as { close(): Promise<void> }).close();
        const viaRegistry = await registry.tableStorageFor(WS_PG);
        assert.equal(await viaRegistry.count('orders'), 2);
    });
    await test('diagnose reads the Postgres tables (createWorkspaceTableStorage is what lore diagnose opens)', async () => {
        const { createWorkspaceTableStorage } = await import('../packages/lore/src/engines/tableStorageFactory.js');
        const ts = await createWorkspaceTableStorage(WS_PG, home, home);
        open.push(ts);
        assert.equal(ts.constructor.name, 'PostgresTableStorage');
        await ts.insert('orders', { id: 'o3', node_ref: 'ghost-node' });
        const report = await diagnoseConsistency(fakeGraph as never, null, ts, { workspace: WS_PG, sqliteChecks: [{ table: 'orders', column: 'node_ref' }] });
        const orphans = report.sqliteOrphans.find(o => o.table === 'orders');
        assert.ok(orphans, 'orders check present');
        assert.ok(orphans.orphans.includes('ghost-node'), `orders rows were read from Postgres, got ${JSON.stringify(orphans.orphans)}`);
        assert.equal(fs.existsSync(sqliteFile(WS_PG)), false);
    });

    console.log('sqlite workspace (unchanged)');
    await test('bundle and registry are SQLite over the same file; tables.sqlite is created', async () => {
        const bundle = (await bundleFor(WS_SQ)).tableStorage;
        assert.ok(bundle instanceof SqliteTableStorage);
        await bundle.createTable(ORDERS);
        await bundle.insert('orders', { id: 's1', node_ref: 'n' });
        const viaRegistry = await registry.tableStorageFor(WS_SQ);
        assert.ok(viaRegistry instanceof SqliteTableStorage);
        assert.deepEqual((await viaRegistry.query('orders')).map(r => r['id']), ['s1']);
        assert.equal(fs.existsSync(sqliteFile(WS_SQ)), true);
        (bundle as SqliteTableStorage).close();
    });
    await test('createStorageClient without a workspace identity still builds the SQLite file (legacy callers)', async () => {
        const bundle = (await bundleFor(WS_PG, false)).tableStorage;
        assert.ok(bundle instanceof SqliteTableStorage);
        (bundle as SqliteTableStorage).close();
        fs.rmSync(sqliteFile(WS_PG), { force: true });
    });

    console.log('structure');
    await test('only the factory builds SqliteTableStorage; createTableStorage( is called only by allow-listed SQLite-only sites', () => {
        const root = path.resolve(import.meta.dirname, '..', 'packages/lore/src');
        const files: string[] = [];
        const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
        walk(root);
        const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/');
        const code = (f: string): string => fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        const direct = files.filter(f => /new SqliteTableStorage\(/.test(code(f))).map(rel);
        assert.deepEqual(direct, ['engines/tableStorageFactory.ts']);
        // storageBundle keeps createTableStorage for the no-workspace fallback only; everything else routes via the resolver.
        const callers = files.filter(f => /\bcreateTableStorage\(/.test(code(f))).map(rel).sort();
        assert.deepEqual(callers, ['engines/tableStorageFactory.ts', 'mcp/storageBundle.ts']);
        for (const f of ['cli/commands/diagnose.ts', 'engines/localGraphRegistry.ts', 'mcp/storageBundle.ts']) {
            assert.match(code(path.join(root, f)), /createWorkspaceTableStorage\(/, `${f} routes through createWorkspaceTableStorage`);
        }
    });
} finally {
    for (const t of open) await (t as unknown as { close?: () => Promise<void> | void }).close?.();
    await registry.disposeAll();
    await closeSharedPostgresPool();
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    if (prevPg === undefined) delete process.env['LORE_PG_URL']; else process.env['LORE_PG_URL'] = prevPg;
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
