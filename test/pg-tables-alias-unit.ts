#!/usr/bin/env tsx
/**
 * test/pg-tables-alias-unit.ts - the per-workspace alias table on PostgresTableStorage (Tables, Wave D lane d3).
 *
 *   normalise  NFKC / case / apostrophes / punctuation / whitespace, pure and locale independent
 *   alias      add (idempotent), list, soft remove (valid_to), single-hop rules, conflicts, workspace isolation
 *   unresolved stored spellings with no alias entry, grouped by normalised form, paginated
 *   plan       eq / in on a string column match the canonical plus its aliases through executePlan; neq is NOT widened
 *
 * Throwaway database `lore_gate_tbl_alias` on the LORE_PG_URL server (skips with a printed reason when unset).
 * Run: npx tsx test/pg-tables-alias-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { executePlan } from '../packages/lore/src/query/executePlan.js';
import { normaliseAliasValue, TableReviewError } from '../packages/lore/src/query/tableReview.js';
import type { PlanResult } from '../packages/lore/src/query/planTypes.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_alias';
const WS = 'pg-gate-alias-a';
const WS2 = 'pg-gate-alias-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-alias: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { assert.ok(e instanceof TableReviewError, `not a TableReviewError: ${String(e)}`); return (e as TableReviewError).code; }
    return assert.fail('expected a TableReviewError');
};

console.log('normalise');
await test('normaliseAliasValue: case, accents kept, apostrophes dropped, punctuation and runs of space collapsed, NFKC', () => {
    assert.equal(normaliseAliasValue('  ACME   Corp. '), 'acme corp');
    assert.equal(normaliseAliasValue("O'Brien & Sons, Ltd."), 'obrien sons ltd');
    assert.equal(normaliseAliasValue('Smith-Jones'), 'smith jones');
    assert.equal(normaliseAliasValue('ＡＣＭＥ'), 'acme', 'full-width letters');
    assert.equal(normaliseAliasValue('Café'), 'café', 'letters of any script survive');
    assert.equal(normaliseAliasValue('...'), '');
    assert.equal(normaliseAliasValue(normaliseAliasValue('A.B.  C')), normaliseAliasValue('A.B.  C'), 'idempotent');
    assert.notEqual(normaliseAliasValue('Acme Corp'), normaliseAliasValue('Acme Corporation'), 'no fuzzy step');
});

await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

const TENANTS: TableSchema = { name: 'tenants', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }, { name: 'rent', type: 'integer' }, { name: 'note', type: 'string' }] };
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

try {
    const t = await PostgresTableStorage.open(WS, pool);
    const other = await PostgresTableStorage.open(WS2, pool);
    await t.createTable(TENANTS);
    await other.createTable(TENANTS);
    const api = t.reviewApi();
    const otherApi = other.reviewApi();
    await t.insertBatch('tenants', [
        { id: '1', name: 'Acme Corp', rent: 100 }, { id: '2', name: 'ACME Corporation', rent: 200 }, { id: '3', name: 'Acme Corp.', rent: 300 },
        { id: '4', name: 'Beta LLC', rent: 400 }, { id: '5', name: 'Gamma', rent: 500 }, { id: '6', name: "O'Brien", rent: 600 }, { id: '7', name: 'Obrien', rent: 700 },
        { id: '8', name: 'Acme Holdings', rent: 800 }]);
    await other.insertBatch('tenants', [{ id: '1', name: 'Acme Corp' }, { id: '2', name: 'ACME Corporation' }]);

    console.log('\nalias');
    let acmeCorporation: string;
    await test('addAlias registers the canonical (self row) and the alias; a repeat is a no-op', async () => {
        const r = await api.addAlias({ table: 'tenants', field: 'name', canonical: 'Acme Corp', alias: 'ACME Corporation', createdBy: 'ops' });
        assert.equal(r.created, true);
        assert.equal(r.record.alias, 'ACME Corporation');
        assert.equal(r.record.canonical, 'Acme Corp');
        assert.equal(r.record.aliasNormalised, 'acme corporation');
        assert.equal(r.record.canonicalNormalised, 'acme corp');
        assert.equal(r.record.isCanonical, false);
        assert.equal(r.record.validTo, null);
        assert.equal(r.record.createdBy, 'ops');
        acmeCorporation = r.record.aliasId;
        const again = await api.addAlias({ table: 'tenants', field: 'name', canonical: 'acme corp', alias: 'Acme   Corporation' });
        assert.equal(again.created, false);
        assert.equal(again.record.aliasId, acmeCorporation);
        const all = await api.listAliases({ table: 'tenants', field: 'name' });
        assert.deepEqual(all.items.map(a => [a.alias, a.isCanonical]).sort(), [['ACME Corporation', false], ['Acme Corp', true]]);
    });
    await test('single-hop and conflict rules: an alias cannot point at two canonicals, a canonical cannot itself be an alias', async () => {
        assert.equal(await code(api.addAlias({ table: 'tenants', field: 'name', canonical: 'Beta LLC', alias: 'acme corporation' })), 'conflict');
        assert.equal(await code(api.addAlias({ table: 'tenants', field: 'name', canonical: 'ACME Corporation', alias: 'Acme Co' })), 'conflict');
    });
    await test('validation: unknown table / column, non-string column, empty spelling, spelling with nothing left after normalising', async () => {
        assert.equal(await code(api.addAlias({ table: 'nope', field: 'name', canonical: 'a', alias: 'b' })), 'invalid_argument');
        assert.equal(await code(api.addAlias({ table: 'tenants', field: 'nope', canonical: 'a', alias: 'b' })), 'invalid_argument');
        assert.equal(await code(api.addAlias({ table: 'tenants', field: 'rent', canonical: 'a', alias: 'b' })), 'invalid_argument');
        assert.equal(await code(api.addAlias({ table: 'tenants', field: 'name', canonical: '   ', alias: 'b' })), 'invalid_argument');
        assert.equal(await code(api.addAlias({ table: 'tenants', field: 'name', canonical: 'Acme Corp', alias: '...' })), 'invalid_argument');
        assert.equal(await code(api.listAliases({ limit: 0 })), 'invalid_argument');
        assert.equal(await code(api.removeAlias('abc')), 'invalid_argument');
        assert.equal(await code(api.removeAlias('999999999')), 'not_found');
    });
    await test('list filters and cursor pagination; the other workspace has its own (empty) alias table', async () => {
        await api.addAlias({ table: 'tenants', field: 'name', canonical: "O'Brien", alias: 'Obrien Ltd' });
        const p1 = await api.listAliases({ limit: 2 });
        assert.equal(p1.items.length, 2);
        assert.ok(p1.nextCursor);
        const p2 = await api.listAliases({ limit: 2, cursor: p1.nextCursor! });
        assert.equal(p2.items.length, 2);
        assert.equal(p2.nextCursor, null);
        assert.equal(new Set([...p1.items, ...p2.items].map(a => a.aliasId)).size, 4);
        assert.deepEqual((await api.listAliases({ canonical: 'acme corp' })).items.length, 2);
        assert.equal((await otherApi.listAliases()).items.length, 0);
        assert.equal(await code(api.listAliases({ cursor: 'zzz' })), 'invalid_argument');
    });

    console.log('\nplan');
    const run = (plan: unknown): Promise<PlanResult> => executePlan(t, WS, plan, { now: FIXED_NOW });
    const names = (r: PlanResult): string[] => { assert.equal(r.status, 'ok', JSON.stringify(r)); return (r as Extract<PlanResult, { status: 'ok' }>).rows.map(x => String(x.values['tenants.name'])).sort(); };
    const filterPlan = (where: unknown[]) => ({ steps: [{ op: 'filter', type: 'tenants', where }] });
    await test('eq on the canonical matches the canonical, the alias spelling and the punctuation variant; aliasesApplied says what was added', async () => {
        const r = await run(filterPlan([{ field: 'name', op: 'eq', value: 'Acme Corp' }]));
        assert.deepEqual(names(r), ['ACME Corporation', 'Acme Corp', 'Acme Corp.']);
        const ok = r as Extract<PlanResult, { status: 'ok' }>;
        assert.equal(ok.aliasesApplied!.length, 1);
        assert.deepEqual(ok.aliasesApplied![0]!.given, ['Acme Corp']);
        assert.deepEqual([...ok.aliasesApplied![0]!.matched].sort(), ['ACME Corporation', 'Acme Corp.']);
        assert.equal(ok.rows.every(x => x.label === 'exact'), true, 'the exact label is untouched');
    });
    await test('eq on the alias spelling gives the same rows; "in" mixes aliased and plain values', async () => {
        assert.deepEqual(names(await run(filterPlan([{ field: 'name', op: 'eq', value: 'acme corporation' }]))), ['ACME Corporation', 'Acme Corp', 'Acme Corp.']);
        assert.deepEqual(names(await run(filterPlan([{ field: 'name', op: 'in', value: ['ACME Corporation', 'Gamma'] }]))), ['ACME Corporation', 'Acme Corp', 'Acme Corp.', 'Gamma']);
    });
    await test('a value with no alias entry keeps exact equality; a non-aliased spelling of a similar name is NOT pulled in', async () => {
        const r = await run(filterPlan([{ field: 'name', op: 'eq', value: 'Gamma' }]));
        assert.deepEqual(names(r), ['Gamma']);
        assert.equal((r as Extract<PlanResult, { status: 'ok' }>).aliasesApplied, undefined);
        assert.deepEqual(names(await run(filterPlan([{ field: 'name', op: 'eq', value: 'Acme Holdings' }]))), ['Acme Holdings']);
    });
    await test('alias match combines with other predicates, joins and aggregates', async () => {
        assert.deepEqual(names(await run(filterPlan([{ field: 'name', op: 'eq', value: 'Acme Corp' }, { field: 'rent', op: 'gt', value: 150 }]))), ['ACME Corporation', 'Acme Corp.']);
        const agg = await run({ steps: [
            { op: 'filter', type: 'tenants', where: [{ field: 'name', op: 'eq', value: 'Acme Corp' }] },
            { op: 'aggregate', group_by: [], measures: [{ fn: 'sum', as: 'total', alias: 'tenants', field: 'rent' }, { fn: 'count', as: 'n' }] }] });
        assert.equal(agg.status, 'ok', JSON.stringify(agg));
        assert.deepEqual((agg as Extract<PlanResult, { status: 'ok' }>).rows.map(r => r.values), [{ total: 600, n: 3 }]);
    });
    await test('neq is not alias-aware (documented): it excludes only the exact value', async () => {
        const r = await run(filterPlan([{ field: 'name', op: 'neq', value: 'Acme Corp' }]));
        assert.ok(names(r).includes('ACME Corporation'));
    });
    await test('the other workspace\'s plan is not affected by this workspace\'s aliases', async () => {
        const r = await executePlan(other, WS2, filterPlan([{ field: 'name', op: 'eq', value: 'Acme Corp' }]), { now: FIXED_NOW });
        assert.equal(r.status, 'ok');
        assert.deepEqual((r as Extract<PlanResult, { status: 'ok' }>).rows.map(x => x.values['tenants.name']), ['Acme Corp']);
    });

    console.log('\nunresolved');
    await test('unresolved lists stored spellings with no alias entry, grouped by normalised form, with counts', async () => {
        const u = await api.listUnresolved({ table: 'tenants', field: 'name' });
        const byNorm = Object.fromEntries(u.items.map(i => [i.normalised, i]));
        // registered: acme corp, acme corporation, obrien, obrien ltd -> 'Acme Corp', 'ACME Corporation', 'Acme Corp.', "O'Brien", 'Obrien' resolve
        assert.deepEqual(Object.keys(byNorm).sort(), ['acme holdings', 'beta llc', 'gamma']);
        assert.equal(byNorm['gamma']!.rows, 1);
        assert.equal(byNorm['gamma']!.example, 'Gamma');
        assert.equal(u.nextCursor, null);
        const p1 = await api.listUnresolved({ table: 'tenants', field: 'name', limit: 2 });
        assert.equal(p1.items.length, 2);
        const p2 = await api.listUnresolved({ table: 'tenants', field: 'name', limit: 2, cursor: p1.nextCursor! });
        assert.deepEqual([...p1.items, ...p2.items].map(i => i.normalised), ['acme holdings', 'beta llc', 'gamma']);
        assert.equal(await code(api.listUnresolved({ table: 'tenants', field: 'rent' })), 'invalid_argument');
        assert.equal(await code(api.listUnresolved({ table: 'tenants', field: 'name', cursor: '!!' })), 'invalid_argument');
    });
    await test('adding the alias resolves it: the value leaves unresolved, and new matches appear in plans', async () => {
        await api.addAlias({ table: 'tenants', field: 'name', canonical: 'Beta LLC', alias: 'Beta Limited' });
        const u = await api.listUnresolved({ table: 'tenants', field: 'name' });
        assert.deepEqual(u.items.map(i => i.normalised), ['acme holdings', 'gamma']);
    });

    console.log('\nremove');
    await test('removeAlias is soft (valid_to), idempotent, history stays listable, and the plan stops widening', async () => {
        const before = Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_alias WHERE workspace_id = $1`, [WS]))[0]!.c);
        const r = await api.removeAlias(acmeCorporation, 'ops');
        assert.equal(r.removed, true);
        assert.notEqual(r.record.validTo, null);
        assert.equal(r.record.removedBy, 'ops');
        assert.equal((await api.removeAlias(acmeCorporation)).removed, false);
        assert.equal(Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_alias WHERE workspace_id = $1`, [WS]))[0]!.c), before, 'row kept');
        assert.equal((await api.listAliases({ canonical: 'Acme Corp' })).items.length, 1);
        assert.equal((await api.listAliases({ canonical: 'Acme Corp', includeRemoved: true })).items.length, 2);
        // canonical self row still registered (matches punctuation variant) but the alias spelling no longer widens
        assert.deepEqual(names(await run(filterPlan([{ field: 'name', op: 'eq', value: 'Acme Corp' }]))), ['Acme Corp', 'Acme Corp.']);
        // and the alias spelling can now be pointed somewhere else
        const re = await api.addAlias({ table: 'tenants', field: 'name', canonical: 'Gamma', alias: 'ACME Corporation' });
        assert.equal(re.created, true);
        assert.deepEqual(names(await run(filterPlan([{ field: 'name', op: 'eq', value: 'Gamma' }]))), ['ACME Corporation', 'Gamma']);
    });
    await test('removing a canonical that still has open aliases is a conflict', async () => {
        const gamma = (await api.listAliases({ canonical: 'Gamma' })).items.find(a => a.isCanonical)!;
        assert.equal(await code(api.removeAlias(gamma.aliasId)), 'conflict');
    });
    await test('a different workspace cannot remove this workspace\'s alias', async () => {
        const any = (await api.listAliases()).items[0]!;
        assert.equal(await code(otherApi.removeAlias(any.aliasId)), 'not_found');
    });
    await test('concurrent addAlias for the same spelling: no duplicate open rows, all calls agree or conflict cleanly', async () => {
        const res = await Promise.allSettled(Array.from({ length: 6 }, () => api.addAlias({ table: 'tenants', field: 'name', canonical: 'Delta Inc', alias: 'Delta Incorporated' })));
        assert.equal(res.filter(r => r.status === 'rejected').length, 0);
        assert.equal(res.filter(r => r.status === 'fulfilled' && r.value.created).length, 1);
        const open = await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_alias WHERE workspace_id = $1 AND alias_norm = 'delta incorporated' AND valid_to IS NULL`, [WS]);
        assert.equal(open[0]!.c, '1');
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
