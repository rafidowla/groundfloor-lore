#!/usr/bin/env tsx
/**
 * test/pg-query-plan-money-unit.ts - currency-aware money columns in query plans, on a REAL Postgres (Tables P3).
 *
 * Goes through the production path: executePlan -> runPlanPostgres -> PostgresTableStorage (the real table storage
 * factory, real tables, real snapshot transaction). Throwaway database `lore_gate_plans_money` on the LORE_PG_URL
 * server (skips with a printed reason when unset).
 *   covers  filter on amount / currency (other-currency rows excluded and counted per step), order, sum/min/max/avg/count,
 *           group by currency, mixed-currency refusal (typed error, step index), having thresholds that carry a currency,
 *           exact decimals end to end ('0.10' + '0.20' = '0.30', '99999999999999.99'), the refusing extension point.
 * Run: npx tsx test/pg-query-plan-money-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { MixedCurrencyError } from '../packages/lore/src/engines/postgres/postgresTableErrors.js';
import { executePlan } from '../packages/lore/src/query/executePlan.js';
import { decideCurrencyCombination } from '../packages/lore/src/query/planMoney.js';
import type { PlanResult } from '../packages/lore/src/query/planTypes.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_plans_money';
const WS = 'pg-gate-plans-money';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

// The pure extension point needs no database.
await test('decideCurrencyCombination always refuses with the table API MixedCurrencyError (no rate table exists)', () => {
    for (const cs of [['USD', 'CAD'], ['EUR', 'GBP', 'JPY']]) {
        assert.throws(() => decideCurrencyCombination('invoices.amount', cs), (e: unknown) =>
            e instanceof MixedCurrencyError && e.code === 'mixed_currency' && e.column === 'invoices.amount' && JSON.stringify(e.currencies) === JSON.stringify(cs));
    }
});

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-query-plan-money: LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
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

const INVOICES: TableSchema = { name: 'invoices', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant', type: 'string' }, { name: 'amount', type: 'money' }] };
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
let t: PostgresTableStorage;
const run = (plan: unknown): Promise<PlanResult> => executePlan(t, WS, plan, { now: FIXED_NOW });
const rowsOf = (r: PlanResult): Array<Record<string, unknown>> => {
    assert.equal(r.status === 'ok' || r.status === 'empty', true, `status ${r.status}: ${JSON.stringify(r)}`);
    return 'rows' in r ? r.rows.map(x => x.values) : [];
};
const usd = (amount: string) => ({ amount, currency: 'USD' });
const cad = (amount: string) => ({ amount, currency: 'CAD' });
const inv = (where: unknown[] = []) => ({ op: 'filter', type: 'invoices', where });
const A = { alias: 'invoices', field: 'amount' };
const ordById = { op: 'order', by: [{ alias: 'invoices', field: 'id' }] };
const sum = (as = 'total') => ({ fn: 'sum', as, ...A });
const onlyUsd = { field: 'amount__currency', op: 'eq', value: 'USD' };

try {
    t = await PostgresTableStorage.open(WS, pool);
    await t.createTable(INVOICES);
    await t.createTable({ name: 'accounts', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'balance', type: 'money' }] });
    await t.insertBatch('invoices', [
        { id: 'i1', tenant: 't1', amount: usd('0.10') }, { id: 'i2', tenant: 't1', amount: usd('0.20') },
        { id: 'i3', tenant: 't1', amount: cad('5.00') }, { id: 'i4', tenant: 't2', amount: usd('99999999999999.99') },
        { id: 'i6', tenant: 't3', amount: cad('1000.00') }, { id: 'i7', tenant: 't3', amount: cad('250.50') },
        { id: 'i8', tenant: 't2', amount: null }]);

    console.log('\nfilter');
    await test('amount comparison holds only within the literal currency; other-currency rows are excluded and COUNTED on the step', async () => {
        const r = await run({ steps: [inv([{ field: 'amount', op: 'gt', value: usd('0.15') }]), ordById] });
        assert.deepEqual(rowsOf(r).map(x => x['invoices.id']), ['i2', 'i4']);
        assert.equal(r.status === 'ok' && r.steps[0]!.excludedOtherCurrency, 3, 'i3, i6, i7 are CAD (the NULL amount is not "another currency")');
        assert.equal(r.status === 'ok' && r.steps[0]!.rows, 2);
    });
    await test('rows come back as exact {amount, currency} strings, never numbers', async () => {
        const r = await run({ steps: [inv([{ field: 'amount', op: 'gt', value: usd('1') }]), ordById] });
        assert.deepEqual(rowsOf(r)[0]!['invoices.amount'], usd('99999999999999.99'));
        for (const row of rowsOf(await run({ steps: [inv([{ field: 'amount', op: 'not_null' }]), ordById] }))) {
            const m = row['invoices.amount'] as { amount: unknown; currency: unknown };
            assert.equal(typeof m.amount, 'string');
            assert.equal(typeof m.currency, 'string');
        }
    });
    await test('eq / neq / lte / in on amount; neq does not pull in other currencies', async () => {
        const ids = async (where: unknown[]) => rowsOf(await run({ steps: [inv(where), ordById] })).map(x => x['invoices.id']);
        assert.deepEqual(await ids([{ field: 'amount', op: 'eq', value: usd('0.1') }]), ['i1'], '0.1 equals stored 0.10');
        assert.deepEqual(await ids([{ field: 'amount', op: 'neq', value: usd('0.10') }]), ['i2', 'i4']);
        assert.deepEqual(await ids([{ field: 'amount', op: 'lte', value: cad('250.50') }]), ['i3', 'i7']);
        assert.deepEqual(await ids([{ field: 'amount', op: 'in', value: [usd('0.20'), cad('1000.00'), cad('0.20')] }]), ['i2', 'i6']);
        assert.deepEqual(await ids([{ field: 'amount', op: 'eq', value: usd('5.00') }]), [], 'a CAD 5.00 row is not USD 5.00');
    });
    await test('the currency pseudo-field filters rows; is_null / not_null work on the amount', async () => {
        const ids = async (where: unknown[]) => rowsOf(await run({ steps: [inv(where), ordById] })).map(x => x['invoices.id']);
        assert.deepEqual(await ids([{ field: 'amount__currency', op: 'eq', value: 'cad' }]), ['i3', 'i6', 'i7']);
        assert.deepEqual(await ids([{ field: 'amount__currency', op: 'in', value: ['EUR', 'CAD'] }, { field: 'amount', op: 'gt', value: cad('100') }]), ['i6', 'i7']);
        assert.deepEqual(await ids([{ field: 'amount', op: 'is_null' }]), ['i8']);
        assert.deepEqual(await ids([{ field: 'amount__currency', op: 'neq', value: 'USD' }]), ['i3', 'i6', 'i7']);
    });
    await test('a money filter value without a currency is a validation error naming the step (no query runs)', async () => {
        const r = await run({ steps: [inv([{ field: 'amount', op: 'gt', value: '5' }])] });
        assert.equal(r.status, 'invalid');
        assert.equal(r.status === 'invalid' && r.errors[0]!.path, '$.steps[0].where[0].value');
        const r2 = await run({ steps: [inv([{ field: 'amount', op: 'gt', value: { amount: '5' } }])] });
        assert.equal(r2.status, 'invalid');
    });

    console.log('\norder');
    await test('order by money sorts by currency first, then amount (never mixes magnitudes across currencies)', async () => {
        const asc = rowsOf(await run({ steps: [inv([{ field: 'amount', op: 'not_null' }]), { op: 'order', by: [{ ...A }] }] })).map(x => x['invoices.id']);
        assert.deepEqual(asc, ['i3', 'i7', 'i6', 'i1', 'i2', 'i4']);
        const desc = rowsOf(await run({ steps: [inv([{ field: 'amount', op: 'not_null' }]), { op: 'order', by: [{ ...A, dir: 'desc' }] }] })).map(x => x['invoices.id']);
        assert.deepEqual(desc, ['i6', 'i7', 'i3', 'i4', 'i2', 'i1'], 'currency stays ascending; the amount flips inside each currency');
    });

    console.log('\naggregate');
    await test('exact decimals: 0.10 + 0.20 = 0.30 and 99999999999999.99 survive the round trip', async () => {
        const small = await run({ steps: [inv([onlyUsd, { field: 'tenant', op: 'eq', value: 't1' }]), { op: 'aggregate', measures: [sum()] }] });
        assert.deepEqual(rowsOf(small), [{ total: usd('0.30') }]);
        const big = await run({ steps: [inv([onlyUsd, { field: 'tenant', op: 'eq', value: 't2' }]), { op: 'aggregate', measures: [sum()] }] });
        assert.deepEqual(rowsOf(big), [{ total: usd('99999999999999.99') }]);
        const both = await run({ steps: [inv([onlyUsd]), { op: 'aggregate', measures: [sum()] }] });
        assert.deepEqual(rowsOf(both), [{ total: usd('100000000000000.29') }], 'a float would print 100000000000000.3');
    });
    await test('min / max / avg / count over one currency; count never trips the mixed-currency rule', async () => {
        const r = await run({ steps: [inv([onlyUsd]), { op: 'aggregate', measures: [
            { fn: 'min', as: 'lo', ...A }, { fn: 'max', as: 'hi', ...A }, { fn: 'avg', as: 'mean', ...A }, { fn: 'count', as: 'n', ...A }] }] });
        const [row] = rowsOf(r) as Array<{ lo: unknown; hi: unknown; mean: { amount: string; currency: string }; n: number }>;
        assert.deepEqual(row!.lo, usd('0.10'));
        assert.deepEqual(row!.hi, usd('99999999999999.99'));
        assert.equal(row!.mean.currency, 'USD');
        assert.match(row!.mean.amount, /^33333333333333\.43/);
        assert.equal(row!.n, 3);
        const all = await run({ steps: [inv(), { op: 'aggregate', measures: [{ fn: 'count', as: 'n', ...A }, { fn: 'count', as: 'rows' }] }] });
        assert.deepEqual(rowsOf(all), [{ n: 6, rows: 7 }], 'count of a money column counts non-null amounts; no currency check');
    });
    await test('group by <col>__currency: one exact sum per currency (null amounts ignored)', async () => {
        const r = await run({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'amount__currency' }], measures: [sum(), { fn: 'count', as: 'n' }] },
            { op: 'order', by: [{ alias: 'invoices', field: 'amount__currency' }] }] });
        const rows = rowsOf(r);
        const byCur = new Map(rows.map(x => [x['invoices.amount__currency'], x['total']] as const));
        assert.deepEqual(byCur.get('CAD'), cad('1255.50'));
        assert.deepEqual(byCur.get('USD'), usd('100000000000000.29'));
        assert.equal(byCur.get(null), null, 'the row with no amount forms its own group with a null total');
    });

    console.log('\nmixed currencies');
    await test('a sum over more than one currency fails with mixed_currency naming the step and the currencies', async () => {
        const r = await run({ steps: [inv(), { op: 'aggregate', measures: [sum()] }] });
        assert.equal(r.status, 'error');
        assert.ok(r.status === 'error');
        assert.equal(r.error.code, 'mixed_currency');
        assert.equal(r.error.step, 2);
        assert.equal(r.error.column, 'invoices.amount');
        assert.deepEqual(r.error.currencies, ['CAD', 'USD']);
        assert.match(r.error.message, /rate|currenc/i);
    });
    await test('min, max and avg are refused too; a group by another column is checked per group', async () => {
        for (const fn of ['min', 'max', 'avg']) {
            const r = await run({ steps: [inv(), { op: 'aggregate', measures: [{ fn, as: 'm', ...A }] }] });
            assert.equal(r.status === 'error' && r.error.code, 'mixed_currency', fn);
        }
        const byTenant = await run({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'tenant' }], measures: [sum()] }] });
        assert.equal(byTenant.status === 'error' && byTenant.error.code, 'mixed_currency', 't1 holds USD and CAD');
        const t3 = await run({ steps: [inv([{ field: 'tenant', op: 'eq', value: 't3' }]), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'tenant' }], measures: [sum()] }] });
        assert.deepEqual(rowsOf(t3).map(x => x['total']), [cad('1250.50')], 'a single-currency group is fine');
    });
    await test('a HAVING threshold or a LIMIT cannot hide a mixed group', async () => {
        const r = await run({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'tenant' }], measures: [sum()],
            having: [{ measure: 'total', op: 'gt', value: cad('100000') }] }] });
        assert.equal(r.status === 'error' && r.error.code, 'mixed_currency');
        const lim = await run({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'tenant' }], measures: [sum()] }, { op: 'limit', n: 1 }] });
        assert.equal(lim.status === 'error' && lim.error.code, 'mixed_currency');
    });
    await test('filtering to one currency first makes the same aggregate valid', async () => {
        const r = await run({ steps: [inv([{ field: 'amount__currency', op: 'eq', value: 'CAD' }]), { op: 'aggregate', measures: [sum()] }] });
        assert.deepEqual(rowsOf(r), [{ total: cad('1255.50') }]);
    });

    console.log('\nhaving');
    await test('a money HAVING threshold compares exactly, in the threshold currency', async () => {
        const grouped = (having: unknown[]) => run({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'amount__currency' }], measures: [sum()], having }] });
        const cadOnly = await grouped([{ measure: 'total', op: 'gt', value: cad('1000') }]);
        assert.deepEqual(rowsOf(cadOnly).map(x => x['total']), [cad('1255.50')]);
        assert.equal(cadOnly.status === 'ok' && cadOnly.steps[1]!.excludedOtherCurrencyGroups, 1, 'the USD group was not compared');
        const usdExact = await grouped([{ measure: 'total', op: 'gt', value: usd('100000000000000.28') }]);
        assert.deepEqual(rowsOf(usdExact).map(x => x['total']), [usd('100000000000000.29')]);
        const none = await grouped([{ measure: 'total', op: 'gt', value: usd('100000000000000.29') }]);
        assert.equal(none.status, 'empty');
    });
    await test('a threshold currency that differs from the (ungrouped-by-currency) group currency is a validation error naming the step', async () => {
        const r = await run({ steps: [inv([{ field: 'tenant', op: 'eq', value: 't3' }]), { op: 'aggregate', measures: [sum()], having: [{ measure: 'total', op: 'gt', value: usd('1') }] }] });
        assert.equal(r.status, 'invalid');
        assert.ok(r.status === 'invalid');
        assert.equal(r.errors[0]!.step, 2);
        assert.equal(r.errors[0]!.path, '$.steps[1].having[0].value.currency');
        assert.match(r.errors[0]!.message, /CAD|USD/);
    });
    await test('a bare-number threshold on a money sum is refused at validation', async () => {
        const r = await run({ steps: [inv([onlyUsd]), { op: 'aggregate', measures: [sum()], having: [{ measure: 'total', op: 'gt', value: 10 }] }] });
        assert.equal(r.status, 'invalid');
    });

    console.log('\nhostile values');
    await test('injection attempts in an amount or currency never reach SQL; steps without a money filter report no excluded count', async () => {
        for (const value of [{ amount: "1'; DROP TABLE lore_entity; --", currency: 'USD' }, { amount: '1', currency: "US'D" }, { amount: '1e999999999', currency: 'USD' }, { amount: '1', currency: 'USD\u0000' }]) {
            const r = await run({ steps: [inv([{ field: 'amount', op: 'gt', value }])] });
            assert.equal(r.status, 'invalid', JSON.stringify(value));
        }
        assert.equal((await run({ steps: [inv([{ field: 'amount__currency', op: 'eq', value: "USD' OR '1'='1" }])] })).status, 'invalid');
        const plain = await run({ steps: [inv([{ field: 'tenant', op: 'eq', value: 't1' }])] });
        assert.equal(plain.status === 'ok' && plain.steps[0]!.excludedOtherCurrency, undefined);
        assert.equal((await run({ steps: [inv()] })).status, 'ok', 'the table is intact');
    });

    console.log('\nstill not supported');
    await test('money group_by and money join keys stay not_supported_yet', async () => {
        const g = await run({ steps: [inv(), { op: 'aggregate', group_by: [A], measures: [{ fn: 'count', as: 'n' }] }] });
        assert.equal(g.status === 'invalid' && g.errors[0]!.code, 'not_supported_yet');
        const j = await run({ steps: [inv(), { op: 'join', type: 'accounts', on: { left: { alias: 'invoices', field: 'id' }, right: { field: 'balance' } } }] });
        assert.equal(j.status === 'invalid' && j.errors[0]!.code, 'not_supported_yet');
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
