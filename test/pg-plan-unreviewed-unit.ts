#!/usr/bin/env tsx
/**
 * test/pg-plan-unreviewed-unit.ts - the "unreviewed" flag and header counts on Postgres plan results (design 6.3).
 *
 *   rows       plain plans flag a row when ANY current value of its entity needs review; aggregates flag a group only when
 *              a value the plan REFERENCED (filter / join / group / measure column) needs review
 *   header     review: { threshold, unreviewedRows, totalRows }; the exact label is untouched; empty results carry none
 *   lifecycle  confirm / correct / threshold change move the counts; other workspaces are untouched; no provenance = no flags
 *
 * Throwaway database `lore_gate_plan_unrev` on the LORE_PG_URL server (skips with a printed reason when unset).
 * Run: npx tsx test/pg-plan-unreviewed-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { executePlan } from '../packages/lore/src/query/executePlan.js';
import type { PlanResult } from '../packages/lore/src/query/planTypes.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_plan_unrev';
const WS = 'pg-gate-unrev-a';
const WS2 = 'pg-gate-unrev-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-plan-unreviewed: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
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

const TENANTS: TableSchema = { name: 'tenants', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }, { name: 'region', type: 'string' }] };
const LEASES: TableSchema = { name: 'leases', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant_id', type: 'string' }, { name: 'rent', type: 'integer' }, { name: 'note', type: 'string' }] };
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const prov = (confidence: number, needsReview?: boolean): Record<string, unknown> =>
    ({ sourceDocumentId: 'doc-1', sourcePage: 1, verifiedQuote: 'q', confidence, ...(needsReview === undefined ? {} : { needsReview }), extractor: 'x/1', extractedAt: '2026-10-01T00:00:00Z' });
type Ok = Extract<PlanResult, { status: 'ok' }>;
const ok = (r: PlanResult): Ok => { assert.equal(r.status, 'ok', JSON.stringify(r)); return r as Ok; };

try {
    const t = await PostgresTableStorage.open(WS, pool);
    const other = await PostgresTableStorage.open(WS2, pool);
    for (const s of [TENANTS, LEASES]) { await t.createTable(s); await other.createTable(s); }
    const api = t.reviewApi();
    const run = (plan: unknown): Promise<PlanResult> => executePlan(t, WS, plan, { now: FIXED_NOW });
    const idOf = (r: Ok, col = 'leases.id'): string[] => r.rows.map(x => String(x.values[col]));
    const flagged = (r: Ok, col = 'leases.id'): string[] => r.rows.filter(x => x.unreviewed).map(x => String(x.values[col])).sort();

    await t.insertBatch('tenants', [{ id: 't1', name: 'Acme', region: 'east' }, { id: 't2', name: 'Beta', region: 'east' }, { id: 't3', name: 'Gamma', region: 'west' }],
        { provenance: [{ region: prov(0.99) }, { region: prov(0.95, true) }, undefined] });
    // l1: rent confident; l2: rent flagged; l3: only the NOTE is low confidence (not referenced by the aggregate); l4: no provenance
    await t.insert('leases', { id: 'l1', tenant_id: 't1', rent: 100, note: 'a' }, { provenance: { rent: prov(0.95) } });
    await t.insert('leases', { id: 'l2', tenant_id: 't1', rent: 200, note: 'b' }, { provenance: { rent: prov(0.9, true) } });
    await t.insert('leases', { id: 'l3', tenant_id: 't3', rent: 300, note: 'c' }, { provenance: { rent: prov(0.99), note: prov(0.3) } });
    await t.insert('leases', { id: 'l4', tenant_id: 't3', rent: 400, note: 'd' });
    await other.insert('leases', { id: 'x1', tenant_id: 'q', rent: 1 }, { provenance: { rent: prov(0.1, true) } });

    const all = { steps: [{ op: 'filter', type: 'leases', where: [] }, { op: 'order', by: [{ alias: 'leases', field: 'id' }] }] };

    console.log('plain plans');
    await test('rows are flagged per entity, the header counts them, and the exact label is untouched', async () => {
        const r = ok(await run(all));
        assert.deepEqual(idOf(r), ['l1', 'l2', 'l3', 'l4']);
        assert.deepEqual(flagged(r), ['l2', 'l3']);
        assert.deepEqual(r.rows.map(x => x.unreviewed), [false, true, true, false]);
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 2, totalRows: 4 });
        assert.equal(r.rows.every(x => x.label === 'exact'), true);
    });
    await test('a filter that excludes the unreviewed rows reports zero; an empty result has no review header', async () => {
        const r = ok(await run({ steps: [{ op: 'filter', type: 'leases', where: [{ field: 'id', op: 'in', value: ['l1', 'l4'] }] }] }));
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 0, totalRows: 2 });
        assert.equal(r.rows.every(x => x.unreviewed === false), true);
        const empty = await run({ steps: [{ op: 'filter', type: 'leases', where: [{ field: 'id', op: 'eq', value: 'nope' }] }] });
        assert.equal(empty.status, 'empty');
        assert.equal('review' in empty, false);
    });
    await test('joined rows are flagged when either side has an unreviewed value', async () => {
        const r = ok(await run({ steps: [
            { op: 'filter', type: 'leases', where: [] },
            { op: 'join', type: 'tenants', on: { left: { alias: 'leases', field: 'tenant_id' }, right: { field: 'id' } } },
            { op: 'order', by: [{ alias: 'leases', field: 'id' }] }] }));
        // t2 (flagged region) has no lease; l1/l2 -> t1 (clean region), l3/l4 -> t3 (no provenance)
        assert.deepEqual(flagged(r), ['l2', 'l3']);
    });

    console.log('\naggregate plans');
    const byRegion = { steps: [
        { op: 'filter', type: 'leases', where: [] },
        { op: 'join', type: 'tenants', on: { left: { alias: 'leases', field: 'tenant_id' }, right: { field: 'id' } } },
        { op: 'aggregate', group_by: [{ alias: 'tenants', field: 'region' }], measures: [{ fn: 'sum', as: 'total', alias: 'leases', field: 'rent' }, { fn: 'count', as: 'n' }] },
        { op: 'order', by: [{ alias: 'tenants', field: 'region' }] }] };
    await test('a group is flagged only when a value the plan referenced needs review (an unreferenced low-confidence note does not)', async () => {
        const r = ok(await run(byRegion));
        assert.deepEqual(r.rows.map(x => [x.values['tenants.region'], x.values['total'], x.unreviewed]), [['east', 300, true], ['west', 700, false]]);
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 1, totalRows: 2 });
    });
    await test('referencing the note column flags the west group; east stays clean because its flagged rent is not referenced', async () => {
        const r = ok(await run({ steps: [
            { op: 'filter', type: 'leases', where: [{ field: 'note', op: 'not_null' }] },
            { op: 'join', type: 'tenants', on: { left: { alias: 'leases', field: 'tenant_id' }, right: { field: 'id' } } },
            { op: 'aggregate', group_by: [{ alias: 'tenants', field: 'region' }], measures: [{ fn: 'count', as: 'n' }] },
            { op: 'order', by: [{ alias: 'tenants', field: 'region' }] }] }));
        assert.deepEqual(r.rows.map(x => [x.values['tenants.region'], x.unreviewed]), [['east', false], ['west', true]]);
    });
    await test('a global aggregate (no group by) is a single row flagged if anything it used is unreviewed', async () => {
        const r = ok(await run({ steps: [{ op: 'filter', type: 'leases', where: [] }, { op: 'aggregate', group_by: [], measures: [{ fn: 'sum', as: 'total', alias: 'leases', field: 'rent' }] }] }));
        assert.deepEqual(r.rows.map(x => [x.values['total'], x.unreviewed]), [[1000, true]]);
        const clean = ok(await run({ steps: [{ op: 'filter', type: 'leases', where: [{ field: 'id', op: 'in', value: ['l1', 'l4'] }] }, { op: 'aggregate', group_by: [], measures: [{ fn: 'sum', as: 'total', alias: 'leases', field: 'rent' }] }] }));
        assert.deepEqual(clean.rows.map(x => [x.values['total'], x.unreviewed]), [[500, false]]);
    });

    console.log('\nlifecycle');
    await test('confirming a flagged value moves the counts; correcting changes the answer and the counts together', async () => {
        const rent2 = (await api.listQueue({ table: 'leases', field: 'rent' })).items.find(i => i.rowKey === 'l2')!;
        await api.confirm({ valueId: rent2.valueId, reviewer: 'alice' });
        let r = ok(await run(all));
        assert.deepEqual(flagged(r), ['l3']);
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 1, totalRows: 4 });
        const note3 = (await api.listQueue({ table: 'leases', field: 'note' })).items.find(i => i.rowKey === 'l3')!;
        await api.correct({ valueId: note3.valueId, reviewer: 'alice', value: 'c2' });
        r = ok(await run(all));
        assert.deepEqual(r.rows.map(x => x.values['leases.note']), ['a', 'b', 'c2', 'd']);
        assert.deepEqual(flagged(r), []);
        assert.equal(r.review!.unreviewedRows, 0);
    });
    await test('lowering and raising the workspace threshold changes the flags; another workspace keeps its own threshold', async () => {
        await api.setReviewConfidenceThreshold(0.999, 'ops');
        let r = ok(await run(all));
        assert.deepEqual(flagged(r), ['l1', 'l3'], 'l1.rent 0.95 and l3.rent 0.99 are now below the bar; reviewed values never re-flag');
        assert.equal(r.review!.threshold, 0.999);
        await api.setReviewConfidenceThreshold(0, 'ops');
        r = ok(await run(all));
        assert.deepEqual(flagged(r), [], 'threshold 0 leaves only explicit needs_review flags, and those were confirmed');
        await api.setReviewConfidenceThreshold(0.8, 'ops');
        const o = ok(await executePlan(other, WS2, { steps: [{ op: 'filter', type: 'leases', where: [] }] }, { now: FIXED_NOW }));
        assert.deepEqual(o.review, { threshold: 0.8, unreviewedRows: 1, totalRows: 1 });
    });
    await test('a plan over a workspace with no provenance at all reports zero and flags nothing', async () => {
        const fresh = await PostgresTableStorage.open('pg-gate-unrev-c', pool);
        await fresh.createTable(LEASES);
        await fresh.insert('leases', { id: 'z', rent: 1 });
        const r = ok(await executePlan(fresh, 'pg-gate-unrev-c', { steps: [{ op: 'filter', type: 'leases', where: [] }] }, { now: FIXED_NOW }));
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 0, totalRows: 1 });
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
