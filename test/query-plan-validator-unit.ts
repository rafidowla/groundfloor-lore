#!/usr/bin/env tsx
/**
 * test/query-plan-validator-unit.ts - the closed-grammar query-plan validator (Tables P3). Pure: no database.
 * Run: npx tsx test/query-plan-validator-unit.ts
 */
import assert from 'node:assert/strict';

import { validatePlan } from '../packages/lore/src/query/planValidator.js';
import type { PlanIssue, PlanValidation } from '../packages/lore/src/query/planTypes.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const COIS: TableSchema = { name: 'cois', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant_id', type: 'string' }, { name: 'status', type: 'string' },
    { name: 'premium', type: 'integer' }, { name: 'rate', type: 'float' }, { name: 'expires', type: 'date' },
    { name: 'active', type: 'boolean' }, { name: 'meta', type: 'json' }] };
const TENANTS: TableSchema = { name: 'tenants', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }, { name: 'region', type: 'string' }] };
const INVOICES: TableSchema = { name: 'invoices', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'coi_id', type: 'string' }, { name: 'amount', type: 'money' }] };
const CAT = new Map<string, TableSchema>([['cois', COIS], ['tenants', TENANTS], ['invoices', INVOICES]]);

const ok = (p: unknown): PlanValidation => validatePlan(p, CAT);
const errs = (p: unknown): PlanIssue[] => { const v = ok(p); assert.equal(v.ok, false, 'expected refusal'); return v.ok ? [] : v.errors; };
const codes = (p: unknown): string[] => errs(p).map(e => e.code);
const f = (where: unknown[] = []) => ({ op: 'filter', type: 'cois', where });

console.log('\naccepted');
test('a full filter -> join -> aggregate -> order -> limit plan validates', () => {
    const v = ok({ version: 1, steps: [
        f([{ field: 'status', op: 'eq', value: 'active' }, { field: 'premium', op: 'gte', value: 10 }]),
        { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'id' } } },
        { op: 'as_of', date: '2026-03-01' },
        { op: 'aggregate', group_by: [{ alias: 'tenants', field: 'region' }], measures: [{ fn: 'sum', as: 'total', alias: 'cois', field: 'premium' }, { fn: 'count', as: 'n' }], having: [{ measure: 'n', op: 'gte', value: 2 }] },
        { op: 'order', by: [{ measure: 'total', dir: 'desc' }] },
        { op: 'limit', n: 5 },
    ] });
    assert.equal(v.ok, true);
});
test('every predicate operator validates on a suitable column', () => {
    const v = ok({ steps: [f([
        { field: 'status', op: 'neq', value: 'x' }, { field: 'status', op: 'in', value: ['a', 'b'] }, { field: 'expires', op: 'lt', value: '2026-01-01' },
        { field: 'status', op: 'contains', value: 'ac' }, { field: 'status', op: 'starts_with', value: 'ac' },
        { field: 'meta', op: 'is_null' }, { field: 'tenant_id', op: 'not_null' }, { field: 'active', op: 'eq', value: true }])] });
    assert.equal(v.ok, true);
});
test('values are coerced to the column type (integer from a numeric string)', () => {
    const v = ok({ steps: [f([{ field: 'premium', op: 'eq', value: '42' }])] });
    assert.equal(v.ok, true);
});

console.log('\nrefusals');
test('not an object / no steps / bad version', () => {
    assert.deepEqual(codes('x'), ['invalid_plan']);
    assert.deepEqual(codes({ steps: [] }), ['invalid_plan']);
    assert.deepEqual(codes({ version: 2, steps: [f()] }), ['invalid_plan']);
});
test('a plan cannot name a workspace (any spelling), at plan or step level', () => {
    for (const key of ['workspace', 'workspace_id', 'workspaceId', 'tenant', 'tenant_id']) {
        assert.ok(codes({ [key]: 'other', steps: [f()] }).includes('workspace_not_allowed'), key);
        assert.ok(codes({ steps: [{ ...f(), [key]: 'other' }] }).includes('workspace_not_allowed'), key);
    }
});
test('unknown properties are refused (strict schema)', () => {
    assert.ok(codes({ steps: [f()], sql: 'select 1' }).includes('unknown_property'));
    assert.ok(codes({ steps: [{ ...f(), limit: 5 }] }).includes('unknown_property'));
    assert.ok(codes({ steps: [f([{ field: 'status', op: 'eq', value: 'a', raw: 'x' }])] }).includes('unknown_property'));
});
test('unknown step op is refused and names the allowed set', () => {
    const e = errs({ steps: [f(), { op: 'drop_table' }] });
    assert.equal(e[0]!.code, 'unknown_step'); assert.equal(e[0]!.step, 2); assert.match(e[0]!.message, /filter, join, aggregate/);
});
test('follow_link / semantic_search / judge are in the grammar but not_supported_yet', () => {
    for (const op of ['follow_link', 'semantic_search', 'judge']) assert.deepEqual(codes({ steps: [f(), { op }] }), ['not_supported_yet'], op);
});
test('recorded-time as_of is not_supported_yet; valid time is accepted; garbage dates are refused', () => {
    assert.deepEqual(codes({ steps: [f(), { op: 'as_of', date: '2026-01-01', time: 'recorded' }] }), ['not_supported_yet']);
    assert.equal(ok({ steps: [f(), { op: 'as_of', date: 'today', time: 'valid' }] }).ok, true);
    assert.deepEqual(codes({ steps: [f(), { op: 'as_of', date: 'last tuesday' }] }), ['bad_value']);
});
test('unknown type / unknown field / unknown alias', () => {
    assert.deepEqual(codes({ steps: [{ op: 'filter', type: 'secrets' }] }), ['unknown_type']);
    assert.deepEqual(codes({ steps: [f([{ field: 'nope', op: 'eq', value: 1 }])] }), ['unknown_field']);
    assert.deepEqual(codes({ steps: [f(), { op: 'join', type: 'tenants', on: { left: { alias: 'ghost', field: 'x' }, right: { field: 'id' } } }] }), ['unknown_alias']);
    assert.deepEqual(codes({ steps: [f(), { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'zzz' } } }] }), ['unknown_field']);
});
test('step cap 12 and join cap 4', () => {
    assert.deepEqual(codes({ steps: Array.from({ length: 13 }, () => f()) }), ['step_cap']);
    assert.equal(ok({ steps: Array.from({ length: 12 }, (_, i) => (i === 0 ? f() : { op: 'filter', alias: 'cois', where: [] })) }).ok, true);
    const join = (alias: string) => ({ op: 'join', type: 'tenants', alias, on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'id' } } });
    const four = [f(), join('a'), join('b'), join('c'), join('d')];
    assert.equal(ok({ steps: four }).ok, true);
    assert.deepEqual(codes({ steps: [...four, join('e')] }), ['join_hop_cap']);
});
test('duplicate alias and type mismatches', () => {
    const j = { op: 'join', type: 'tenants', alias: 'cois', on: { left: { alias: 'cois', field: 'tenant_id' }, right: { field: 'id' } } };
    assert.deepEqual(codes({ steps: [f(), j] }), ['duplicate_alias']);
    assert.deepEqual(codes({ steps: [f(), { op: 'join', type: 'tenants', on: { left: { alias: 'cois', field: 'premium' }, right: { field: 'id' } } }] }), ['type_mismatch']);
    assert.deepEqual(codes({ steps: [f([{ field: 'premium', op: 'contains', value: '1' }])] }), ['type_mismatch']);
    assert.deepEqual(codes({ steps: [f([{ field: 'active', op: 'gt', value: true }])] }), ['type_mismatch']);
    assert.deepEqual(codes({ steps: [f([{ field: 'meta', op: 'eq', value: 'x' }])] }), ['type_mismatch']);
});
test('bad values: wrong type, null, object, oversized, NUL, int64 overflow, empty in', () => {
    const one = (value: unknown, field = 'premium', op = 'eq') => codes({ steps: [f([{ field, op, value }])] });
    assert.deepEqual(one('abc'), ['bad_value']);
    assert.deepEqual(one(null), ['bad_value']);
    assert.deepEqual(one({ $gt: 1 }), ['bad_value']);
    assert.deepEqual(one('x'.repeat(1001), 'status'), ['bad_value']);
    assert.deepEqual(one('a\u0000b', 'status'), ['bad_value']);
    assert.deepEqual(one('9223372036854775808'), ['bad_value']);
    assert.deepEqual(one([], 'status', 'in'), ['bad_value']);
    assert.deepEqual(one(5, 'status'), ['bad_value']);
});
test('bad operator is refused', () => {
    assert.deepEqual(codes({ steps: [f([{ field: 'status', op: 'regex', value: '.*' }])] }), ['bad_operator']);
});
test('step ordering: no source, aggregate is terminal, nothing after limit, order only before limit', () => {
    assert.deepEqual(codes({ steps: [{ op: 'limit', n: 3 }] }), ['no_source']);
    assert.deepEqual(codes({ steps: [{ op: 'filter', alias: 'cois' }] }), ['no_source']);
    const agg = { op: 'aggregate', measures: [{ fn: 'count', as: 'n' }] };
    assert.deepEqual(codes({ steps: [f(), agg, f()] }), ['bad_order']);
    assert.deepEqual(codes({ steps: [f(), { op: 'limit', n: 3 }, f()] }), ['bad_order']);
    assert.deepEqual(codes({ steps: [f(), { op: 'order', by: [{ alias: 'cois', field: 'id' }] }, f()] }), ['bad_order']);
});
test('aggregate rules: sum needs a number, having names a measure, order after aggregate uses a group key or measure', () => {
    const agg = (measures: unknown[], extra: object = {}) => ({ steps: [f(), { op: 'aggregate', measures, ...extra }] });
    assert.deepEqual(codes(agg([{ fn: 'sum', as: 't', alias: 'cois', field: 'status' }])), ['type_mismatch']);
    assert.deepEqual(codes(agg([{ fn: 'count', as: 'n' }], { having: [{ measure: 'zzz', op: 'gt', value: 1 }] })), ['unknown_field']);
    assert.deepEqual(codes(agg([{ fn: 'count', as: 'n' }, { fn: 'count', as: 'n' }])), ['duplicate_alias']);
    assert.deepEqual(codes(agg([{ fn: 'max', as: 'm', alias: 'cois', field: 'meta' }])), ['type_mismatch']);
    assert.deepEqual(codes({ steps: [f(), { op: 'aggregate', measures: [{ fn: 'count', as: 'n' }] }, { op: 'order', by: [{ alias: 'cois', field: 'status' }] }] }), ['bad_order']);
    assert.deepEqual(codes({ steps: [f(), { op: 'order', by: [{ measure: 'n' }] }] }), ['bad_order']);
});
test('limit bounds', () => {
    for (const n of [0, -1, 1.5, '3', 1_000_001]) assert.deepEqual(codes({ steps: [f(), { op: 'limit', n }] }), ['bad_value'], String(n));
});
test('every reason is returned, not just the first', () => {
    const e = errs({ steps: [f([{ field: 'nope', op: 'eq', value: 1 }, { field: 'status', op: 'regex', value: 'x' }])] });
    assert.equal(e.length, 2);
    assert.ok(e.every(x => x.step === 1 && x.path.startsWith('$.steps[0].where[')));
});
test('money: join keys and group_by stay not_supported_yet; everything else is the money section below', () => {
    const inv = (where: unknown[] = []) => ({ op: 'filter', type: 'invoices', where });
    assert.deepEqual(codes({ steps: [f(), { op: 'join', type: 'invoices', on: { left: { alias: 'cois', field: 'id' }, right: { field: 'amount' } } }] }), ['not_supported_yet']);
    assert.deepEqual(codes({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'amount' }], measures: [{ fn: 'count', as: 'n' }] }] }), ['not_supported_yet']);
    assert.equal(ok({ steps: [inv([{ field: 'coi_id', op: 'eq', value: 'c1' }])] }).ok, true, 'non-money columns of the same type still work');
});

console.log('\nmoney (currency-aware)');
{
    const inv = (where: unknown[] = []) => ({ op: 'filter', type: 'invoices', where });
    const usd = (amount: string) => ({ amount, currency: 'USD' });
    const sumAmt = { fn: 'sum', as: 't', alias: 'invoices', field: 'amount' };
    const aggInv = (measures: unknown[], extra: Record<string, unknown> = {}) => ({ steps: [inv(), { op: 'aggregate', measures, ...extra }] });
    test('money filter: comparisons need {amount,currency}; currency has its own pseudo-field', () => {
        for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) assert.equal(ok({ steps: [inv([{ field: 'amount', op, value: usd('10.50') }])] }).ok, true, op);
        assert.equal(ok({ steps: [inv([{ field: 'amount', op: 'in', value: [usd('1'), { amount: '2', currency: 'cad' }] }])] }).ok, true);
        assert.equal(ok({ steps: [inv([{ field: 'amount', op: 'is_null' }, { field: 'amount', op: 'not_null' }])] }).ok, true);
        assert.equal(ok({ steps: [inv([{ field: 'amount__currency', op: 'eq', value: 'usd' }])] }).ok, true);
        assert.equal(ok({ steps: [inv([{ field: 'amount__currency', op: 'in', value: ['USD', 'CAD'] }])] }).ok, true);
    });
    test('money filter: a bare number, a missing currency, extra keys and a bad amount are refused with the path', () => {
        for (const value of [5, '5', { amount: '5' }, { currency: 'USD' }, { amount: '5', currency: 'USD', x: 1 }, { amount: 'abc', currency: 'USD' }, { amount: '5', currency: 'US' }, { amount: 5, currency: 'USD' }]) {
            const e = errs({ steps: [inv([{ field: 'amount', op: 'gt', value }])] });
            assert.equal(e[0]!.step, 1, JSON.stringify(value));
            assert.equal(e[0]!.path, '$.steps[0].where[0].value', JSON.stringify(value));
        }
        assert.match(errs({ steps: [inv([{ field: 'amount', op: 'gt', value: 5 }])] })[0]!.message, /currency/);
    });
    test('money filter: text operators are refused; currency pseudo-field takes only eq/neq/in', () => {
        assert.deepEqual(codes({ steps: [inv([{ field: 'amount', op: 'contains', value: usd('1') }])] }), ['type_mismatch']);
        assert.deepEqual(codes({ steps: [inv([{ field: 'amount__currency', op: 'gt', value: 'USD' }])] }), ['type_mismatch']);
        assert.deepEqual(codes({ steps: [inv([{ field: 'nope__currency', op: 'eq', value: 'USD' }])] }), ['unknown_field']);
        assert.deepEqual(codes({ steps: [{ op: 'filter', type: 'cois', where: [{ field: 'status__currency', op: 'eq', value: 'USD' }] }] }), ['unknown_field']);
    });
    test('money order is allowed (currency first, then amount); aggregate sum/min/max/avg/count validate', () => {
        assert.equal(ok({ steps: [inv(), { op: 'order', by: [{ alias: 'invoices', field: 'amount', dir: 'desc' }] }] }).ok, true);
        for (const fn of ['sum', 'min', 'max', 'avg', 'count']) assert.equal(ok(aggInv([{ fn, as: 'm', alias: 'invoices', field: 'amount' }])).ok, true, fn);
        assert.equal(ok({ steps: [inv(), { op: 'aggregate', group_by: [{ alias: 'invoices', field: 'amount__currency' }], measures: [sumAmt] }] }).ok, true, 'group by currency');
    });
    test('money having: a threshold must be {amount,currency}; a bare number is refused', () => {
        assert.equal(ok(aggInv([sumAmt], { having: [{ measure: 't', op: 'gt', value: usd('100.00') }] })).ok, true);
        const e = errs(aggInv([sumAmt], { having: [{ measure: 't', op: 'gt', value: 100 }] }));
        assert.equal(e[0]!.path, '$.steps[1].having[0].value');
        assert.match(e[0]!.message, /currency/);
    });
    test('money having: a threshold currency that contradicts an earlier filter on the same alias is a validation error naming the step', () => {
        const e = errs({ steps: [inv([{ field: 'amount__currency', op: 'eq', value: 'CAD' }]), { op: 'aggregate', measures: [sumAmt], having: [{ measure: 't', op: 'gt', value: usd('1') }] }] });
        assert.deepEqual(e.map(x => x.code), ['type_mismatch']);
        assert.equal(e[0]!.step, 2);
        assert.equal(e[0]!.path, '$.steps[1].having[0].value.currency');
        assert.equal(ok({ steps: [inv([{ field: 'amount', op: 'gt', value: usd('1') }]), { op: 'aggregate', measures: [sumAmt], having: [{ measure: 't', op: 'gt', value: usd('1') }] }] }).ok, true, 'same currency passes');
    });
    test('money measures cannot be compared with a plain number, and the currency field only counts', () => {
        assert.deepEqual(codes(aggInv([{ fn: 'sum', as: 't', alias: 'invoices', field: 'amount__currency' }])), ['type_mismatch']);
        assert.equal(ok(aggInv([{ fn: 'count', as: 'n', alias: 'invoices', field: 'amount__currency' }], { having: [{ measure: 'n', op: 'gt', value: 1 }] })).ok, true);
    });
}
test('identifier injection attempts in type, field and alias never validate', () => {
    assert.deepEqual(codes({ steps: [{ op: 'filter', type: 'cois"; DROP TABLE lore_entity; --' }] }), ['unknown_type']);
    assert.deepEqual(codes({ steps: [f([{ field: 'status"; DROP TABLE x; --', op: 'eq', value: 'a' }])] }), ['unknown_field']);
    assert.ok(codes({ steps: [{ op: 'filter', type: 'cois', alias: 'a"; DROP TABLE x; --' }] }).includes('invalid_plan'));
    assert.deepEqual(codes({ steps: [f(), { op: 'aggregate', measures: [{ fn: 'count', as: 'n"; --' }] }] }), ['invalid_plan']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
