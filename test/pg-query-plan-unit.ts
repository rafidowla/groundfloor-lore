#!/usr/bin/env tsx
/**
 * test/pg-query-plan-unit.ts - query-plan executor on Postgres (Tables P3).
 *
 * Throwaway database `lore_gate_plans` on the LORE_PG_URL server (skips with a printed reason when unset).
 * Seeded COI-like workspace: tenants, cois (certificates of insurance), leases (valid-time rows).
 *   covers  filter -> join -> aggregate -> order/limit, as-of (valid time), empty-step reporting, per-step and
 *           total row caps (named, never silent), SQL-injection attempts in values and identifiers, read-only
 *           enforcement, timeouts, workspace isolation, engine gating, exact labels.
 * Run: npx tsx test/pg-query-plan-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { mapPlanError } from '../packages/lore/src/engines/postgres/postgresPlanExecutor.js';
import { executePlan } from '../packages/lore/src/query/executePlan.js';
import type { PlanResult } from '../packages/lore/src/query/planTypes.js';
import type { ITableStorage, TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_plans';
const WS = 'pg-gate-plans';
const WS2 = 'pg-gate-plans-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-query-plan: LORE_PG_URL is not set - postgres cases skipped cleanly');
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

const TENANTS: TableSchema = { name: 'tenants', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }, { name: 'region', type: 'string' }] };
const COIS: TableSchema = { name: 'cois', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant_id', type: 'string' }, { name: 'insurer', type: 'string' },
    { name: 'status', type: 'string' }, { name: 'premium', type: 'integer' }, { name: 'expires', type: 'date' },
    { name: 'notes', type: 'string' }, { name: 'meta', type: 'json' }, { name: '_source_id', type: 'string' }] };
const LEASES: TableSchema = { name: 'leases', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant_id', type: 'string' }, { name: 'rent', type: 'integer' },
    { name: '_valid_from', type: 'datetime' }, { name: '_valid_to', type: 'datetime' }, { name: '_source_id', type: 'string' }] };

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const run = (plan: unknown, limits: Record<string, unknown> = {}): Promise<PlanResult> => executePlan(t, WS, plan, { now: FIXED_NOW, ...limits });
const rowsOf = (r: PlanResult): Array<Record<string, unknown>> => { assert.equal(r.status === 'ok' || r.status === 'empty', true, `status ${r.status}: ${JSON.stringify(r)}`); return 'rows' in r ? r.rows.map(x => x.values) : []; };
const filter = (where: unknown[] = [], type = 'cois') => ({ op: 'filter', type, where });
const eq = (field: string, value: unknown) => ({ field, op: 'eq', value });

let t: PostgresTableStorage, other: PostgresTableStorage;
try {
    t = await PostgresTableStorage.open(WS, pool);
    other = await PostgresTableStorage.open(WS2, pool);
    for (const s of [TENANTS, COIS, LEASES]) { await t.createTable(s); await other.createTable(s); }
    await t.insertBatch('tenants', [
        { id: 't1', name: 'Acme', region: 'east' }, { id: 't2', name: 'Beta', region: 'east' },
        { id: 't3', name: 'Gamma', region: 'west' }, { id: 't4', name: 'Delta', region: 'west' }]);
    await t.insertBatch('cois', [
        { id: 'c1', tenant_id: 't1', insurer: 'Zenith', status: 'active', premium: 100, expires: '2026-12-31', notes: 'ok', _source_id: 'src-1' },
        { id: 'c2', tenant_id: 't1', insurer: 'Apex', status: 'active', premium: 200, expires: '2025-01-01', notes: 'discount 100%_ok' },
        { id: 'c3', tenant_id: 't2', insurer: 'Zenith', status: 'active', premium: 300, expires: '2027-06-30' },
        { id: 'c4', tenant_id: 't3', insurer: 'Apex', status: 'active', premium: 50, expires: '2026-07-01' },
        { id: 'c5', tenant_id: 't3', insurer: 'Apex', status: 'expired', premium: 70, expires: '2024-01-01' },
        { id: 'c6', tenant_id: 't4', insurer: 'Zenith', status: 'expired', premium: 900, expires: '2023-01-01', meta: { k: 1 } }]);
    await t.insertBatch('leases', [
        { id: 'l1', tenant_id: 't1', rent: 1000, _valid_from: '2025-01-01T00:00:00.000Z', _valid_to: '2026-01-01T00:00:00.000Z' },
        { id: 'l2', tenant_id: 't1', rent: 1200, _valid_from: '2026-01-01T00:00:00.000Z', _valid_to: null, _source_id: 'src-1' },
        { id: 'l3', tenant_id: 't2', rent: 800, _valid_from: '2024-01-01T00:00:00.000Z', _valid_to: '2025-06-01T00:00:00.000Z' }]);
    // the OTHER workspace has the same type names and loud, different data
    await other.insertBatch('cois', [{ id: 'x1', tenant_id: 'tx', insurer: 'Other', status: 'active', premium: 7_000_000 }]);
    await other.insertBatch('tenants', [{ id: 'tx', name: 'Elsewhere', region: 'east' }]);

    console.log('\nexecution');
    await test('filter: equals / in / range / text match / null checks return exact rows', async () => {
        assert.deepEqual(rowsOf(await run({ steps: [filter([eq('status', 'active')]), { op: 'order', by: [{ alias: 'cois', field: 'id' }] }] })).map(r => r['cois.id']), ['c1', 'c2', 'c3', 'c4']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'id', op: 'in', value: ['c1', 'c6', 'zz'] }]), { op: 'order', by: [{ alias: 'cois', field: 'id' }] }] })).map(r => r['cois.id']), ['c1', 'c6']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'premium', op: 'gte', value: 200 }, { field: 'premium', op: 'lt', value: 900 }]), { op: 'order', by: [{ alias: 'cois', field: 'id' }] }] })).map(r => r['cois.id']), ['c2', 'c3']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'insurer', op: 'starts_with', value: 'zen' }]), { op: 'order', by: [{ alias: 'cois', field: 'id' }] }] })).map(r => r['cois.id']), ['c1', 'c3', 'c6']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'notes', op: 'is_null' }, { field: 'status', op: 'eq', value: 'active' }]), { op: 'order', by: [{ alias: 'cois', field: 'id' }] }] })).map(r => r['cois.id']), ['c3', 'c4']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'meta', op: 'not_null' }])] })).map(r => r['cois.id']), ['c6']);
    });
    await test('row values decode to their declared types (integer, date, json)', async () => {
        const r = rowsOf(await run({ steps: [filter([eq('id', 'c6')])] }))[0]!;
        assert.equal(r['cois.premium'], 900); assert.equal(r['cois.expires'], '2023-01-01'); assert.deepEqual(r['cois.meta'], { k: 1 });
    });
    await test('filter -> join -> aggregate -> having -> order -> limit', async () => {
        const plan = { steps: [
            filter([eq('status', 'active')]),
            { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'id' } } },
            { op: 'aggregate', group_by: [{ alias: 'tenants', field: 'region' }],
              measures: [{ fn: 'sum', as: 'total', alias: 'cois', field: 'premium' }, { fn: 'count', as: 'n' }, { fn: 'max', as: 'latest', alias: 'cois', field: 'expires' }] },
            { op: 'order', by: [{ measure: 'total', dir: 'desc' }] }, { op: 'limit', n: 5 }] };
        const r = await run(plan);
        assert.equal(r.status, 'ok');
        assert.deepEqual(rowsOf(r), [
            { 'tenants.region': 'east', total: 600, n: 3, latest: '2027-06-30' },
            { 'tenants.region': 'west', total: 50, n: 1, latest: '2026-07-01' }]);
        assert.deepEqual(r.steps.map(s => [s.step, s.op, s.rows]), [[1, 'filter', 4], [2, 'join', 4], [3, 'aggregate', 2], [4, 'order', 2], [5, 'limit', 2]]);
        const having = rowsOf(await run({ steps: [...plan.steps.slice(0, 2), { ...plan.steps[2]!, having: [{ measure: 'n', op: 'gte', value: 2 }] }, plan.steps[3]!] }));
        assert.deepEqual(having.map(x => x['tenants.region']), ['east']);
    });
    await test('join on a non-key column and on a reserved column; avg / min / count(field)', async () => {
        const r = rowsOf(await run({ steps: [filter([eq('status', 'active')]),
            { op: 'join', type: 'leases', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'tenant_id' } } },
            { op: 'aggregate', measures: [{ fn: 'count', as: 'pairs' }, { fn: 'avg', as: 'avg_rent', alias: 'leases', field: 'rent' }, { fn: 'min', as: 'min_rent', alias: 'leases', field: 'rent' }] }] }));
        assert.deepEqual(r.map(x => [x['pairs'], x['avg_rent'], x['min_rent']]), [[5, 1040, 800]]);
        const res = await run({ steps: [filter([eq('id', 'c1')]), { op: 'join', type: 'leases', on: { left: { alias: 'cois', field: '_source_id' }, right: { field: '_source_id' } } }] });
        assert.deepEqual(rowsOf(res).map(x => x['leases.id']), ['l2'], 'a reserved header column joins like any other');
        const bad = await run({ steps: [filter([eq('id', 'c1')]), { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: '_lore_pk' } } }] });
        assert.equal(bad.status, 'invalid', 'an internal view column that is not declared on the type cannot be named');
    });
    await test('order is stable and sorts by column, ties broken deterministically; limit shortens', async () => {
        const r = rowsOf(await run({ steps: [filter(), { op: 'order', by: [{ alias: 'cois', field: 'insurer', dir: 'asc' }, { alias: 'cois', field: 'premium', dir: 'desc' }] }, { op: 'limit', n: 3 }] }));
        assert.deepEqual(r.map(x => x['cois.id']), ['c2', 'c5', 'c4']);
    });
    await test('as-of (valid time): half-open bounds, NULL = unbounded, "today" uses the supplied clock', async () => {
        const asOf = async (date: string) => rowsOf(await run({ steps: [filter([], 'leases'), { op: 'as_of', date }, { op: 'order', by: [{ alias: 'leases', field: 'id' }] }] })).map(x => x['leases.id']);
        assert.deepEqual(await asOf('2025-03-01'), ['l1', 'l3']);
        assert.deepEqual(await asOf('2026-01-01'), ['l2'], 'valid_to is excluded, valid_from is included');
        assert.deepEqual(await asOf('2026-06-01'), ['l2']);
        assert.deepEqual(await asOf('today'), ['l2']);
        const r = await run({ steps: [filter([], 'leases'), { op: 'as_of', date: '2025-03-01' }] });
        assert.equal(r.status === 'ok' && r.asOf, '2025-03-01T00:00:00.000Z');
    });
    await test('as-of placed AFTER a join still covers every source and every step count', async () => {
        const r = await run({ steps: [filter([], 'tenants'),
            { op: 'join', type: 'leases', on: { left: { alias: 'tenants', field: 'id' }, right: { field: 'tenant_id' } } },
            { op: 'as_of', date: '2025-03-01' }] });
        assert.deepEqual(rowsOf(r).map(x => x['leases.id']).sort(), ['l1', 'l3']);
        assert.deepEqual(r.status === 'ok' ? r.steps.map(s => s.rows) : [], [4, 2, 2], 'tenants carry no valid time (4); the join keeps only leases valid then (2)');
    });
    await test('empty step: "step N left 0 rows" with the counts at each step; later steps are marked not run', async () => {
        const r = await run({ steps: [filter([eq('status', 'active')]), { op: 'filter', alias: 'cois', where: [{ field: 'premium', op: 'gt', value: 100000 }] }, { op: 'limit', n: 3 }] });
        assert.equal(r.status, 'empty');
        if (r.status !== 'empty') return;
        assert.equal(r.emptyAt.step, 2);
        assert.match(r.emptyAt.message, /step 2 left 0 rows/); assert.match(r.emptyAt.message, /step 1: 4/);
        assert.deepEqual(r.steps.map(s => [s.step, s.rows]), [[1, 4], [2, 0], [3, 0]]);
        assert.match(r.steps[2]!.note ?? '', /not run: step 2 left 0 rows/);
    });
    await test('every step and every row is labelled exact', async () => {
        const r = await run({ steps: [filter([eq('status', 'active')]), { op: 'limit', n: 2 }] });
        assert.equal(r.status, 'ok');
        if (r.status !== 'ok') return;
        assert.equal(r.label, 'exact'); assert.ok(r.steps.every(s => s.label === 'exact')); assert.ok(r.rows.every(x => x.label === 'exact'));
    });

    console.log('\ncaps');
    await test('per-step cap: reports the cap and the step, returns no rows (no silent truncation)', async () => {
        const r = await run({ steps: [filter()] }, { maxRowsPerStep: 5 });
        assert.equal(r.status, 'capped');
        if (r.status !== 'capped') return;
        assert.equal(r.cap.kind, 'rows_per_step'); assert.equal(r.cap.step, 1); assert.equal(r.cap.limit, 5);
        assert.match(r.cap.message, /step 1 would leave more than 5 rows/); assert.deepEqual(r.rows, []);
    });
    await test('per-step cap is checked at the step that grows past it (a join), not only the first', async () => {
        const r = await run({ steps: [filter([eq('status', 'active')]),
            { op: 'join', type: 'leases', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'tenant_id' } } }] }, { maxRowsPerStep: 4 });
        assert.equal(r.status, 'capped');
        if (r.status === 'capped') assert.equal(r.cap.step, 2);
    });
    await test('a cap of exactly the row count is fine (cap + 1 probe, not cap)', async () => {
        assert.equal((await run({ steps: [filter()] }, { maxRowsPerStep: 6 })).status, 'ok');
    });
    await test('total-rows cap: names the cap and the step that crossed it', async () => {
        const r = await run({ steps: [filter(), { op: 'filter', alias: 'cois', where: [eq('status', 'active')] }] }, { maxRowsPerStep: 100, maxTotalRows: 8 });
        assert.equal(r.status, 'capped');
        if (r.status !== 'capped') return;
        assert.equal(r.cap.kind, 'total_rows'); assert.equal(r.cap.step, 2); assert.equal(r.cap.limit, 8);
    });
    await test('limit does not bypass the per-step cap', async () => {
        assert.equal((await run({ steps: [filter(), { op: 'limit', n: 2 }] }, { maxRowsPerStep: 5 })).status, 'capped');
    });
    await test('caller limits are validated', async () => {
        for (const bad of [{ maxRowsPerStep: 0 }, { maxRowsPerStep: 1.5 }, { statementTimeoutMs: -1 }, { maxTotalRows: 1e12 }, { lockTimeoutMs: NaN }]) {
            const r = await run({ steps: [filter()] }, bad);
            assert.equal(r.status === 'error' && r.error.code, 'invalid_limits', JSON.stringify(bad));
        }
    });

    console.log('\nrefusals reach the caller as typed results');
    await test('an invalid plan returns status invalid with reasons; nothing runs', async () => {
        const r = await run({ steps: [filter([eq('nope', 1)]), { op: 'judge' }] });
        assert.equal(r.status, 'invalid');
        if (r.status === 'invalid') assert.deepEqual(r.errors.map(e => e.code).sort(), ['not_supported_yet', 'unknown_field']);
    });
    await test('a type that exists only in ANOTHER workspace is unknown here', async () => {
        await other.createTable({ name: 'secrets', columns: [{ name: 'id', type: 'string', primary: true }] });
        const r = await run({ steps: [{ op: 'filter', type: 'secrets' }] });
        assert.equal(r.status === 'invalid' && r.errors[0]!.code, 'unknown_type');
    });

    console.log('\ninjection');
    await test('SQL in a value is data: bound, matched literally, nothing dropped', async () => {
        for (const evil of [`'; DROP TABLE lore_entity; --`, `x' OR '1'='1`, `\\'); DELETE FROM lore_entity_value; --`, '${1+1}', '"quoted"']) {
            const r = await run({ steps: [filter([eq('status', evil)])] });
            assert.equal(r.status, 'empty', evil);
        }
        const inList = await run({ steps: [filter([{ field: 'id', op: 'in', value: [`c1') OR ('1'='1`, 'c2'] }])] });
        assert.deepEqual(rowsOf(inList).map(x => x['cois.id']), ['c2']);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM lore_entity WHERE workspace_id=$1`, [WS])).rows[0].n, 13, 'rows untouched');
        assert.equal((await run({ steps: [filter()] })).status, 'ok', 'tables still answer');
    });
    await test('LIKE wildcards in text match values are escaped (a literal % or _ , not a wildcard)', async () => {
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'notes', op: 'contains', value: '%' }])] })).map(x => x['cois.id']), ['c2']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'notes', op: 'contains', value: '_ok' }])] })).map(x => x['cois.id']), ['c2']);
        assert.deepEqual(rowsOf(await run({ steps: [filter([{ field: 'notes', op: 'contains', value: 'o_' }])] })).map(x => x['cois.id']), [], 'underscore is not "any one char"');
    });
    await test('SQL in identifiers (type, field, alias, measure name) is refused by the validator', async () => {
        const evil = `cois"; DROP TABLE lore_entity; --`;
        for (const plan of [
            { steps: [{ op: 'filter', type: evil }] },
            { steps: [filter([eq(evil, 'x')])] },
            { steps: [{ op: 'filter', type: 'cois', alias: evil }] },
            { steps: [filter(), { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: evil }, right: { field: 'id' } } }] },
            { steps: [filter(), { op: 'aggregate', measures: [{ fn: 'count', as: evil }] }] },
        ]) assert.equal((await run(plan)).status, 'invalid', JSON.stringify(plan));
        assert.equal((await run({ steps: [filter()] })).status, 'ok');
    });
    await test('a plan cannot name a workspace; the workspace arg must match the storage binding', async () => {
        const named = await run({ workspace: WS2, steps: [filter()] });
        assert.equal(named.status === 'invalid' && named.errors[0]!.code, 'workspace_not_allowed');
        const mism = await executePlan(t, WS2, { steps: [filter()] });
        assert.equal(mism.status === 'error' && mism.error.code, 'workspace_mismatch');
        assert.equal((await executePlan(t, '', { steps: [filter()] })).status, 'error');
    });

    console.log('\nread-only + timeouts');
    await test('the transaction is READ ONLY: a write inside it fails with 25006 and changes nothing', async () => {
        const before = (await pool.query(`SELECT count(*)::int AS n FROM lore_entity`)).rows[0].n;
        await assert.rejects(t.runReadOnly({ statementTimeoutMs: 5000, lockTimeoutMs: 1000 }, async client => {
            await client.query(`INSERT INTO lore_entity_type (workspace_id, name) VALUES ('x','y')`);
        }), (e: { code?: string }) => e.code === '25006');
        await assert.rejects(t.runReadOnly({ statementTimeoutMs: 5000, lockTimeoutMs: 1000 }, async client => {
            await client.query(`DELETE FROM lore_entity`);
        }), (e: { code?: string }) => e.code === '25006');
        await assert.rejects(t.runReadOnly({ statementTimeoutMs: 5000, lockTimeoutMs: 1000 }, async client => {
            await client.query(`CREATE TABLE plan_escape (a int)`);
        }), (e: { code?: string }) => e.code === '25006');
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM lore_entity`)).rows[0].n, before);
    });
    await test('statement_timeout and lock_timeout are SET LOCAL in the transaction and do not leak to the pool', async () => {
        const seen = await t.runReadOnly({ statementTimeoutMs: 1234, lockTimeoutMs: 567 }, async client =>
            (await client.query(`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l, current_setting('transaction_read_only') AS ro`)).rows[0]);
        assert.deepEqual(seen, { s: '1234ms', l: '567ms', ro: 'on' });
        const after = (await pool.query(`SELECT current_setting('statement_timeout') AS s, current_setting('transaction_read_only') AS ro`)).rows[0];
        assert.notEqual(after.s, '1234ms'); assert.equal(after.ro, 'off');
    });
    await test('a statement that runs past the timeout is cancelled and mapped to statement_timeout', async () => {
        let err: unknown;
        try { await t.runReadOnly({ statementTimeoutMs: 100, lockTimeoutMs: 1000 }, async c => { await c.query('SELECT pg_sleep(3)'); }); } catch (e) { err = e; }
        assert.deepEqual(mapPlanError(err, 2), { code: 'statement_timeout', message: 'the query exceeded the statement timeout', step: 2 });
        assert.equal(mapPlanError({ code: '55P03' }).code, 'lock_timeout');
        const other2 = mapPlanError(new Error('boom'));
        assert.equal(other2.code, 'execution_failed');
    });
    await test('the connection is released and usable after errors', async () => {
        for (let i = 0; i < 12; i++) await t.runReadOnly({ statementTimeoutMs: 1000, lockTimeoutMs: 1000 }, async c => { await c.query('SELECT 1'); }).catch(() => undefined);
        for (let i = 0; i < 12; i++) await t.runReadOnly({ statementTimeoutMs: 1000, lockTimeoutMs: 1000 }, async c => { await c.query('INSERT INTO lore_entity_type (workspace_id,name) VALUES (1,1)'); }).catch(() => undefined);
        assert.equal((await run({ steps: [filter()] })).status, 'ok');
    });

    console.log('\nisolation + engine gating');
    await test('workspace isolation: the same plan sees only its own workspace; the other one is invisible', async () => {
        const agg = { steps: [filter(), { op: 'aggregate', measures: [{ fn: 'sum', as: 'total', alias: 'cois', field: 'premium' }, { fn: 'count', as: 'n' }] }] };
        assert.deepEqual(rowsOf(await run(agg)), [{ total: 1620, n: 6 }]);
        const r2 = await executePlan(other, WS2, agg, { now: FIXED_NOW });
        assert.deepEqual(rowsOf(r2), [{ total: 7_000_000, n: 1 }]);
        assert.equal(r2.status === 'ok' && r2.workspace, WS2);
        const joined = await executePlan(other, WS2, { steps: [filter(), { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'id' } } }] });
        assert.deepEqual(rowsOf(joined).map(x => x['tenants.name']), ['Elsewhere']);
    });
    await test('any engine other than Postgres answers engine_not_supported; the call never throws', async () => {
        const r = await executePlan({} as ITableStorage, WS, { steps: [filter()] });
        assert.deepEqual(r, { status: 'error', error: { code: 'engine_not_supported', message: r.status === 'error' ? r.error.message : '' } });
        assert.match(r.status === 'error' ? r.error.message : '', /Postgres/);
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
