#!/usr/bin/env tsx
/**
 * dataplaneScopeFilter — engine filter grammar, per-route scope building,
 * per-workspace row keys, guardScope and fail-closed workspace resolution.
 *
 * The central property (F1): no emitted filter object ever has a key outside
 * `field|and|or|not|all|id_eq` — i.e. no flat / suffix-key map can reach the
 * engine, which would 400 on it.
 */

import assert from 'node:assert/strict';
import {
    DataplaneScopeError,
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    engineAnd,
    engineField,
    engineValue,
    guardScope,
    resolveDataplaneScope,
    scopeRowFields,
    SCOPE_COLUMNS,
    SCOPE_KEY_INDEX,
    type DataplaneScope,
    type ScopeFilterInput,
    type ScopeRoute,
} from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { registryAcceptingAny, testRegistry } from './helpers/workspace-registry.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1: DataplaneScope = { orgId: 'org1', loreWorkspace: 'w1', dataplaneWorkspaceId: 'dp' };
const W2: DataplaneScope = { orgId: 'org1', loreWorkspace: 'w2', dataplaneWorkspaceId: 'dp' };
const O2: DataplaneScope = { orgId: 'org2', loreWorkspace: 'w1', dataplaneWorkspaceId: 'dp' };

const ALLOWED_KEYS = new Set(['field', 'and', 'or', 'not', 'id_eq']);
const VALUE_TAGS = new Set(['string', 'integer', 'float', 'boolean', 'array']);
const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'starts_with', 'ends_with', 'exists', 'regex']);

/** Structural validator: throws unless `f` is a valid engine filter tree. */
function assertEngineFilter(f: unknown, path = '$'): void {
    if (f === 'all') return;
    assert.ok(f && typeof f === 'object' && !Array.isArray(f), `${path}: not a filter object`);
    const keys = Object.keys(f as object);
    assert.equal(keys.length, 1, `${path}: exactly one tag expected, got [${keys}]`);
    const k = keys[0]!;
    assert.ok(ALLOWED_KEYS.has(k), `${path}: key '${k}' is not an engine filter tag (flat map leaked)`);
    const inner = (f as Record<string, unknown>)[k];
    if (k === 'field') {
        const c = inner as Record<string, unknown>;
        assert.deepEqual(Object.keys(c).sort(), ['field', 'operator', 'value'], `${path}: field clause shape`);
        assert.equal(typeof c['field'], 'string');
        assert.ok(OPS.has(c['operator'] as string), `${path}: bad operator ${String(c['operator'])}`);
        assertValue(c['value'], `${path}.value`);
    } else if (k === 'and' || k === 'or') {
        assert.ok(Array.isArray(inner) && (inner as unknown[]).length >= 2, `${path}.${k}: needs >= 2 clauses (single/empty collapse)`);
        (inner as unknown[]).forEach((c, i) => assertEngineFilter(c, `${path}.${k}[${i}]`));
    } else if (k === 'not') assertEngineFilter(inner, `${path}.not`);
    else assert.equal(typeof inner, 'string');
}
function assertValue(v: unknown, path: string): void {
    if (v === 'null') return;
    assert.ok(v && typeof v === 'object' && !Array.isArray(v), `${path}: untagged value ${JSON.stringify(v)}`);
    const keys = Object.keys(v as object);
    assert.equal(keys.length, 1, `${path}: value must have one tag`);
    assert.ok(VALUE_TAGS.has(keys[0]!), `${path}: unknown value tag ${keys[0]}`);
    if (keys[0] === 'array') ((v as { array: unknown[] }).array).forEach((x, i) => assertValue(x, `${path}[${i}]`));
}

/** Collect every clause as `field:op:value` strings for readable assertions. */
function clauses(f: unknown): string[] {
    if (f === 'all' || f === null) return [];
    const o = f as Record<string, unknown>;
    if ('and' in o) return (o['and'] as unknown[]).flatMap(clauses);
    if ('field' in o) {
        const c = o['field'] as { field: string; operator: string; value: unknown };
        return [`${c.field} ${c.operator} ${JSON.stringify(c.value)}`];
    }
    return [JSON.stringify(f)];
}

const INPUTS: ScopeFilterInput[] = [
    {},
    { loreId: 'a' },
    { loreId: ['a', 'b', 'c'] },
    { type: 'decision', project: 'p', ecosystem: 'e' },
    { type: ['decision', 'bug_pattern'], ecosystem: 'e' },
    { project: '*', ecosystem: '' },
    { tags: ['x', 'y'], revision: 'current' },
    { extra: [{ field: 'updated_at', op: 'gt', value: '2026-01-01' }, { field: 'n', op: 'lte', value: 3 }, { field: 'b', op: 'eq', value: true }, { field: 'z', op: 'eq', value: null }, { field: 'k', op: 'in', value: ['q', 'r'] }] },
];
const ROUTES: ScopeRoute[] = ['crud', 'vector', 'keyword', 'traverse'];

console.log('dataplaneScopeFilter');

await test('every emitted server filter is a valid engine tree — no flat keys, ever', () => {
    let n = 0;
    for (const route of ROUTES) for (const input of INPUTS) {
        const b = buildDataplaneScopeFilter(W1, input, route, 10);
        if (b.server !== null) { assertEngineFilter(b.server, `${route}`); n++; }
    }
    assert.ok(n >= 16, `expected many filters checked, got ${n}`);
    // the helper builders too
    assertEngineFilter(engineField('a', 'eq', 'x'));
    assertEngineFilter(engineAnd([engineField('a', 'eq', 'x'), engineField('b', 'in', ['1', 2])]));
    assert.equal(engineAnd([]), 'all');
    assert.deepEqual(engineAnd([engineField('a', 'eq', 1)]), engineField('a', 'eq', 1));
});

await test('flat-map detection works (validator rejects the old wire format)', () => {
    assert.throws(() => assertEngineFilter({ org_id: 'x' }), /not an engine filter tag/);
    assert.throws(() => assertEngineFilter({ tags_contains: 'y' }), /not an engine filter tag/);
    assert.throws(() => assertEngineFilter({ and: [{ field: { field: 'a', operator: 'eq', value: 'plain' } }, engineField('b', 'eq', 1)] }), /untagged value/);
});

await test('engineValue tags scalars, arrays and null', () => {
    assert.deepEqual(engineValue('s'), { string: 's' });
    assert.deepEqual(engineValue(3), { integer: 3 });
    assert.deepEqual(engineValue(3.5), { float: 3.5 });
    assert.deepEqual(engineValue(true), { boolean: true });
    assert.deepEqual(engineValue(null), 'null');
    assert.deepEqual(engineValue(['a', 1]), { array: [{ string: 'a' }, { integer: 1 }] });
});

await test('crud: org + workspace always first, caller clauses follow, predicate is guardScope', () => {
    const b = buildDataplaneScopeFilter(W1, { loreId: 'n1', type: 'decision' }, 'crud', 5);
    const c = clauses(b.server);
    assert.equal(c[0], 'org_id eq {"string":"org1"}');
    assert.equal(c[1], 'lore_workspace eq {"string":"w1"}');
    assert.ok(c.includes('lore_id eq {"string":"n1"}'));
    assert.ok(c.includes('type eq {"string":"decision"}'));
    assert.equal(b.fetchLimit, 5);
    const row = { ...scopeRowFields(W1, 'n1'), type: 'decision' };
    assert.equal(b.clientPredicate(row), true);
    assert.equal(b.clientPredicate({ ...row, lore_workspace: 'w2' }), false);
    // review A1 #5: the crud predicate also re-checks the caller clauses.
    assert.equal(b.clientPredicate({ ...row, type: 'note' }), false);
    assert.equal(b.clientPredicate({ ...scopeRowFields(W1, 'other'), type: 'decision' }), false);
});

await test('empty crud input still scopes (never "all")', () => {
    for (const route of ['crud', 'vector'] as ScopeRoute[]) {
        const b = buildDataplaneScopeFilter(W1, {}, route, 3);
        assert.deepEqual(clauses(b.server), ['org_id eq {"string":"org1"}', 'lore_workspace eq {"string":"w1"}']);
    }
});

await test("'' and '*' project/ecosystem produce no clause on any route", () => {
    for (const route of ROUTES) {
        const b = buildDataplaneScopeFilter(W1, { project: '*', ecosystem: '' }, route, 3);
        assert.ok(!clauses(b.server).some((s) => s.startsWith('project') || s.startsWith('ecosystem')), route);
        const row = { ...scopeRowFields(W1, 'x'), project: 'anything', ecosystem: 'any' };
        assert.equal(b.clientPredicate(row), true, `${route} predicate lets any project through`);
    }
});

await test('vector: server clauses are string-eq only; arrays / tags stay client-side', () => {
    const b = buildDataplaneScopeFilter(W1, { type: ['a', 'b'], project: 'p1', tags: ['t'], revision: 'current' }, 'vector', 10);
    const c = clauses(b.server);
    for (const s of c) assert.match(s, / eq \{"string":/, `non-eq clause pushed to vector route: ${s}`);
    assert.ok(!c.some((s) => s.startsWith('type ')), 'multi-valued type must not be pushed');
    assert.ok(c.includes('project eq {"string":"p1"}'), 'single-valued project is eq');
    assert.ok(c.includes('revision_state eq {"string":"current"}'));
    assert.ok(!c.some((s) => s.startsWith('tags')));
    // client predicate enforces what the server could not
    const base = { ...scopeRowFields(W1, 'v1'), type: 'a', project: 'p1', tags: 'x,t', revision_state: 'current' };
    assert.equal(b.clientPredicate(base), true);
    assert.equal(b.clientPredicate({ ...base, type: 'zzz' }), false);
    assert.equal(b.clientPredicate({ ...base, tags: 'x,tt' }), false, 'tags are exact membership, not substring');
    assert.equal(b.clientPredicate({ ...base, revision_state: 'history' }), false);
});

await test('vector/keyword fetch limits', () => {
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'vector', 5).fetchLimit, 25);
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'vector', 50).fetchLimit, 100);
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'vector', 1000).fetchLimit, 100);
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'keyword', 1).fetchLimit, 50);
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'keyword', 20).fetchLimit, 200);
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'keyword', 1000).fetchLimit, 500);
    assert.equal(buildDataplaneScopeFilter(W1, {}, 'traverse', 7).fetchLimit, 7);
});

await test('keyword + traverse send no server filter (engine has none) but scope client-side', () => {
    for (const route of ['keyword', 'traverse'] as ScopeRoute[]) {
        const b = buildDataplaneScopeFilter(W1, { type: 'decision' }, route, 5);
        assert.equal(b.server, null);
        const mine = { ...scopeRowFields(W1, 'k'), type: 'decision' };
        assert.equal(b.clientPredicate(mine), true, route);
        assert.equal(b.clientPredicate({ ...scopeRowFields(W2, 'k'), type: 'decision' }), false, `${route}: other Lore workspace`);
        assert.equal(b.clientPredicate({ ...scopeRowFields(O2, 'k'), type: 'decision' }), false, `${route}: other org`);
        assert.equal(b.clientPredicate({ ...mine, type: 'other' }), false, `${route}: type`);
    }
});

await test('predicate covers project and extra ops (full modes)', () => {
    const b = buildDataplaneScopeFilter(W1, {
        project: 'p1',
        extra: [{ field: 'updated_at', op: 'gt', value: '2026-01-01' }, { field: 'label', op: 'contains', value: 'FOO' }],
    }, 'keyword', 5);
    const ok = { ...scopeRowFields(W1, 'a'), project: 'p1', updated_at: '2026-02-01', label: 'a foo b' };
    assert.equal(b.clientPredicate(ok), true);
    assert.equal(b.clientPredicate({ ...ok, project: 'p2' }), false);
    assert.equal(b.clientPredicate({ ...ok, updated_at: '2025-01-01' }), false);
    assert.equal(b.clientPredicate({ ...ok, label: 'bar' }), false);
});

await test('row keys: deterministic, versioned, unique across org/workspace/id', () => {
    assert.equal(dataplaneRowKey(W1, 'n1'), dataplaneRowKey({ ...W1 }, 'n1'));
    assert.match(dataplaneRowKey(W1, 'n1'), /^lw1_[0-9a-f]{64}$/);
    const keys = new Set([
        dataplaneRowKey(W1, 'n1'), dataplaneRowKey(W2, 'n1'), dataplaneRowKey(O2, 'n1'),
        dataplaneRowKey(W1, 'n2'),
        // separator ambiguity must not collide
        dataplaneRowKey({ ...W1, orgId: 'a', loreWorkspace: 'bc' }, 'x'),
        dataplaneRowKey({ ...W1, orgId: 'ab', loreWorkspace: 'c' }, 'x'),
        dataplaneRowKey({ ...W1, orgId: 'a', loreWorkspace: 'b' }, 'cx'),
    ]);
    assert.equal(keys.size, 7);
    // the Dataplane workspace is NOT part of the key (it is credential-fixed)
    assert.equal(dataplaneRowKey(W1, 'n1'), dataplaneRowKey({ ...W1, dataplaneWorkspaceId: 'other' }, 'n1'));
});

await test('scopeRowFields carries key + logical id + scope', () => {
    const f = scopeRowFields(W1, 'n1');
    assert.deepEqual(f, { id: dataplaneRowKey(W1, 'n1'), lore_id: 'n1', lore_workspace: 'w1', org_id: 'org1' });
});

await test('guardScope: org, workspace, logical id and row key must all agree', () => {
    const row = scopeRowFields(W1, 'n1');
    assert.equal(guardScope(row, W1), true);
    assert.equal(guardScope(row, W1, 'n1'), true);
    assert.equal(guardScope(row, W1, 'n2'), false);
    assert.equal(guardScope(row, W2), false);
    assert.equal(guardScope(row, O2), false);
    assert.equal(guardScope({ ...row, id: 'lw1_forged' }, W1), false, 'physical id must be the row key');
    assert.equal(guardScope({ ...row, lore_id: '' }, W1), false);
    const { lore_id: _l, ...noLogical } = row;
    assert.equal(guardScope(noLogical, W1), false, 'missing lore_id fails closed');
    assert.equal(guardScope({ ...row, org_id: undefined }, W1), false);
    assert.equal(guardScope(null as unknown as Record<string, unknown>, W1), false);
    // a row already mapped to logical id (id === lore_id) is not guardable — callers guard raw rows
    assert.equal(guardScope({ ...row, id: 'n1' }, W1), false);
});

await test('resolveDataplaneScope: fail-closed on missing workspace', () => {
    const base = { orgId: 'org1', dataplaneWorkspaceId: 'dp', workspaceRegistry: registryAcceptingAny() };
    for (const provider of [() => '', () => '   ', () => undefined as unknown as string, () => { throw new Error('no ctx'); }]) {
        assert.throws(
            () => resolveDataplaneScope({ ...base, loreWorkspaceProvider: provider }),
            (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_missing_workspace',
        );
    }
    assert.deepEqual(resolveDataplaneScope({ ...base, loreWorkspaceProvider: () => 'w1' }), { ...W1, workspaceName: 'w1' });
});

await test('resolveDataplaneScope: registry enforced on every call; no wildcard', () => {
    const registry = testRegistry('w1');
    const cfg = (w: string) => ({ orgId: 'org1', dataplaneWorkspaceId: 'dp', workspaceRegistry: registry, loreWorkspaceProvider: () => w });
    assert.equal(resolveDataplaneScope(cfg('w1')).loreWorkspace, 'w1');
    assert.throws(
        () => resolveDataplaneScope(cfg('w2')),
        (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_workspace_not_allowed',
    );
    // '*' is an ordinary (unregistered) name now, not a wildcard; registration changes apply immediately.
    assert.throws(
        () => resolveDataplaneScope(cfg('*')),
        (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_workspace_not_allowed',
    );
    registry.add('w2');
    assert.equal(resolveDataplaneScope(cfg('w2')).loreWorkspace, 'w2');
    registry.remove('w1');
    assert.throws(() => resolveDataplaneScope(cfg('w1')), DataplaneScopeError);
    assert.throws(
        () => resolveDataplaneScope({ ...cfg('w2'), workspaceRegistry: undefined as never }),
        (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_workspace_not_allowed',
    );
});

await test('scope columns + unique scope_key index declared (D1)', () => {
    assert.deepEqual(SCOPE_COLUMNS.map((c) => c.name), ['lore_workspace', 'lore_id']);
    assert.ok(SCOPE_COLUMNS.every((c) => c.indexed));
    assert.deepEqual(SCOPE_KEY_INDEX, { name: 'scope_key', fields: ['org_id', 'lore_workspace', 'lore_id'], unique: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
