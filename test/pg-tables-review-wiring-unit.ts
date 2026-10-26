#!/usr/bin/env tsx
/**
 * test/pg-tables-review-wiring-unit.ts - the review queue + alias table + unreviewed plan flags through the REAL
 * workspace wiring, not a hand-built PostgresTableStorage.
 *
 * `workspaces.json` declares a Postgres-engine workspace and a SQLite one. Table storage comes from the production
 * factory (`createWorkspaceTableStorage`) via both production routes: the MCP/service storage bundle
 * (`createStorageClient` -> `store.tableStorage`) and `LocalGraphRegistry.tableStorageFor`. No mocks, real Postgres.
 *
 *   write with provenance -> executePlan shows unreviewed rows + header -> review queue lists them -> correct one,
 *   confirm one -> the plan result reflects the corrected value and the counts change; an alias added through the
 *   registry handle widens a plan run through the bundle handle; a SQLite workspace says "not supported".
 *
 * Throwaway database `lore_gate_tbl_review_wire`; skips with a printed reason when LORE_PG_URL is unset.
 * Run: npx tsx test/pg-tables-review-wiring-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

import { createStorageClient } from '../packages/lore/src/mcp/storageBundle.js';
import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { executePlan } from '../packages/lore/src/query/executePlan.js';
import { tableReviewFor, TableReviewError } from '../packages/lore/src/query/tableReview.js';
import type { PlanResult } from '../packages/lore/src/query/planTypes.js';
import type { ITableStorage, TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_review_wire';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-review-wiring: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

const WS_PG = 'pg-gate-rwire-pg';
const WS_SQ = 'pg-gate-rwire-sq';
const LEASES: TableSchema = { name: 'leases', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant', type: 'string' }, { name: 'rent', type: 'integer' }] };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pgreview-wiring-'));
const wsPath = (n: string): string => path.join(home, 'workspaces', n);
for (const n of [WS_PG, WS_SQ]) fs.mkdirSync(path.join(wsPath(n), '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1, active: WS_PG,
    workspaces: [{ name: WS_PG, path: wsPath(WS_PG), graphEngine: 'postgres' }, { name: WS_SQ, path: wsPath(WS_SQ), graphEngine: 'sqlite' }],
}));
const fakeGraph = { listNodes: async () => [] } as never;
const fakeVerbatim = { bulkUpsertPrebuiltRows: () => undefined, handleCount: () => 0, tombstone: () => undefined } as never;
const bundleFor = (ws: string): Promise<{ tableStorage: ITableStorage }> =>
    createStorageClient(fakeGraph, fakeVerbatim, 'local', wsPath(ws), { workspace: ws, home });

type Ok = Extract<PlanResult, { status: 'ok' }>;
const ok = (r: PlanResult): Ok => { assert.equal(r.status, 'ok', JSON.stringify(r)); return r as Ok; };
const prov = (confidence: number, needsReview?: boolean): Record<string, unknown> =>
    ({ sourceDocumentId: 'lease-001.pdf', sourcePage: 2, verifiedQuote: 'Tenant: Acme', confidence, ...(needsReview === undefined ? {} : { needsReview }), extractor: 'ai-api/1', contract: 'B/1', extractedAt: '2026-10-01T00:00:00Z' });

const prevPg = process.env['LORE_PG_URL'];
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
process.env['LORE_PG_URL'] = dbUrl.toString();
const registry = new LocalGraphRegistry({ autoEvict: false, home });
const open: ITableStorage[] = [];
try {
    const bundle = (await bundleFor(WS_PG)).tableStorage;
    open.push(bundle);
    const viaRegistry = await registry.tableStorageFor(WS_PG);
    const NOW = new Date('2026-06-01T12:00:00.000Z');
    const plan = { steps: [{ op: 'filter', type: 'leases', where: [] }, { op: 'order', by: [{ alias: 'leases', field: 'id' }] }] };

    console.log('postgres workspace (factory-built storage)');
    await test('both production routes hand back PostgresTableStorage, and the review API is reachable from each', async () => {
        assert.equal(bundle.constructor.name, 'PostgresTableStorage');
        assert.equal(viaRegistry.constructor.name, 'PostgresTableStorage');
        assert.equal((await (await tableReviewFor(bundle)).getSettings()).reviewConfidenceThreshold, 0.8);
        assert.equal((await (await tableReviewFor(viaRegistry)).getSettings()).reviewConfidenceThreshold, 0.8);
    });
    await test('write via the bundle with provenance; executePlan through the registry handle shows unreviewed rows and the header', async () => {
        await bundle.createTable(LEASES);
        await (bundle as unknown as { insert(t: string, r: unknown, o: unknown): Promise<void> }).insert('leases', { id: 'a', tenant: 'Acme', rent: 1000 }, { provenance: { tenant: prov(0.95), rent: prov(0.9, true) } });
        await (bundle as unknown as { insert(t: string, r: unknown, o: unknown): Promise<void> }).insert('leases', { id: 'b', tenant: 'Beta Corp', rent: 2000 }, { provenance: { tenant: prov(0.4) } });
        await (bundle as unknown as { insert(t: string, r: unknown, o: unknown): Promise<void> }).insert('leases', { id: 'c', tenant: 'Clean', rent: 5 }, { provenance: { tenant: prov(0.99) } });
        const r = ok(await executePlan(viaRegistry, WS_PG, plan, { now: NOW }));
        assert.deepEqual(r.rows.map(x => [x.values['leases.id'], x.unreviewed]), [['a', true], ['b', true], ['c', false]]);
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 2, totalRows: 3 });
        assert.equal(r.rows.every(x => x.label === 'exact'), true);
    });
    await test('the queue (through the bundle handle) lists exactly the values behind those flags', async () => {
        const rv = await tableReviewFor(bundle);
        const page = await rv.listQueue({ table: 'leases' });
        assert.deepEqual(page.items.map(i => `${i.rowKey}.${i.field}`).sort(), ['a.rent', 'b.tenant']);
        assert.equal(page.items.find(i => i.field === 'rent')!.value, 1000);
        assert.equal(await rv.countQueue({ sourceDocumentId: 'lease-001.pdf' }), 2);
    });
    await test('correct one value and confirm the other: the plan result reflects the corrected value and the counts drop', async () => {
        const rv = await tableReviewFor(viaRegistry);
        const items = (await rv.listQueue()).items;
        const tenantB = items.find(i => i.rowKey === 'b')!;
        const rentA = items.find(i => i.rowKey === 'a')!;
        await rv.correct({ valueId: tenantB.valueId, reviewer: 'reviewer-1', value: 'Beta Corporation', verifiedQuote: 'Tenant: Beta Corporation' });
        let r = ok(await executePlan(bundle, WS_PG, plan, { now: NOW }));
        assert.deepEqual(r.rows.map(x => x.values['leases.tenant']), ['Acme', 'Beta Corporation', 'Clean']);
        assert.deepEqual(r.rows.map(x => x.unreviewed), [true, false, false]);
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 1, totalRows: 3 });
        await rv.confirm({ valueId: rentA.valueId, reviewer: 'reviewer-1' });
        r = ok(await executePlan(bundle, WS_PG, plan, { now: NOW }));
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 0, totalRows: 3 });
        assert.equal((await rv.listQueue()).items.length, 0);
        // confirming again through the OTHER handle is the same idempotent outcome
        const again = await (await tableReviewFor(bundle)).confirm({ valueId: rentA.valueId, reviewer: 'reviewer-1' });
        assert.equal(again.idempotent, true);
    });
    await test('an alias added through one handle widens a plan run through the other; the alias table is the same one', async () => {
        await (await tableReviewFor(viaRegistry)).addAlias({ table: 'leases', field: 'tenant', canonical: 'Beta Corporation', alias: 'Beta Corp', createdBy: 'ops' });
        const r = ok(await executePlan(bundle, WS_PG, { steps: [{ op: 'filter', type: 'leases', where: [{ field: 'tenant', op: 'eq', value: 'Beta Corp' }] }] }, { now: NOW }));
        assert.deepEqual(r.rows.map(x => x.values['leases.tenant']), ['Beta Corporation']);
        assert.equal(r.aliasesApplied![0]!.field, 'tenant');
        const un = await (await tableReviewFor(bundle)).listUnresolved({ table: 'leases', field: 'tenant' });
        assert.deepEqual(un.items.map(i => i.normalised), ['acme', 'clean']);
    });
    await test('the schema additions live in the workspace\'s Postgres only: no tables.sqlite appears for it', async () => {
        assert.deepEqual(fs.readdirSync(path.join(wsPath(WS_PG), '.lore')).filter(f => /tables/.test(f)), []);
    });

    console.log('\nsqlite workspace');
    await test('a SQLite workspace gets the typed not_supported error through the same entry point', async () => {
        const sq = (await bundleFor(WS_SQ)).tableStorage;
        open.push(sq);
        try { await tableReviewFor(sq); assert.fail('expected not_supported'); }
        catch (e) { assert.ok(e instanceof TableReviewError); assert.equal((e as TableReviewError).code, 'not_supported'); assert.match((e as Error).message, /SQLite/); }
        const sqViaRegistry = await registry.tableStorageFor(WS_SQ);
        await assert.rejects(tableReviewFor(sqViaRegistry), /not supported on SQLite/);
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
