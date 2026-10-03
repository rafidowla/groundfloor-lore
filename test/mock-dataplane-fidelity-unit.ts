#!/usr/bin/env tsx
/**
 * Pins the fidelity of test/helpers/mock-dataplane.ts against the real
 * Dataplane engine's behaviour (design D7 items 1-5, 7, 8). The mock must never
 * be MORE permissive than the engine, or an isolation bug can hide behind it.
 * Item 6 (POST /v1/transaction, engine handlers.rs:5438) is covered at the end.
 */

import assert from 'node:assert/strict';
import { startMockDataplane, type MockDataplane, type MockDataplaneOptions } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { engineAnd, engineField } from '../packages/lore/src/engines/dataplaneScopeFilter.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let mock: MockDataplane;
const KEY_A = 'key-a';
const KEY_B = 'key-b';

async function http(method: string, path: string, body?: unknown, key: string | null = KEY_A, extra: Record<string, string> = {}): Promise<{ status: number; json: J }> {
    const res = await fetch(`${mock.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await res.text();
    return { status: res.status, json: t ? JSON.parse(t) : {} };
}
const recordsOf = (r: { json: J }): J[] => (r.json['data']?.['records'] ?? r.json['records']) as J[];
const F = engineField;

async function seed(coll: string, rows: J[], key = KEY_A): Promise<void> {
    for (const r of rows) {
        const res = await http('POST', `/v1/${coll}`, r, key);
        assert.equal(res.status, 201, `seed ${coll}: ${JSON.stringify(res.json)}`);
    }
}

console.log('mock Dataplane fidelity');
// DEFAULT_CONNECTOR=postgresql: ONE consistent data set for every route (the per-route defaults of an
// unconfigured engine are exercised in section 9 below).
mock = await startMockDataplane({ apiKeys: { [KEY_A]: 'ws-a', [KEY_B]: 'ws-b' }, defaultConnector: 'postgresql' });

try {
    /* ── 1. workspace from credential ─────────────────────────── */
    await test('D7-1 missing / unknown bearer -> 401 when apiKeys given', async () => {
        assert.equal((await http('POST', '/v1/c1/query', {}, null)).status, 401);
        assert.equal((await http('POST', '/v1/c1/query', {}, 'nope')).status, 401);
        assert.equal((await http('POST', '/v1/c1/query', {}, KEY_A)).status, 200);
    });

    await test('D7-1 workspace comes from the key; X-Tenant-Id is ignored', async () => {
        await seed('iso', [{ id: 'r1', v: 'a-only' }]);
        // Claiming ws-b through the header while holding key A must still hit ws-a
        const viaHeader = await http('POST', '/v1/iso/query', { filter: 'all' }, KEY_A, { 'X-Tenant-Id': 'ws-b' });
        assert.equal(recordsOf(viaHeader).length, 1);
        // Key B with header naming ws-a must NOT see ws-a's row
        const other = await http('POST', '/v1/iso/query', { filter: 'all' }, KEY_B, { 'X-Tenant-Id': 'ws-a' });
        assert.equal(recordsOf(other).length, 0);
        const snap = mock.snapshot();
        assert.deepEqual(snap.tenants.find((t) => t.tenantId === 'ws-a')?.collections.find((c) => c.name === 'iso')?.count, 1);
    });

    await test('D7-1 without apiKeys any key maps to the default workspace', async () => {
        const m2 = await startMockDataplane({ defaultWorkspace: 'dflt' });
        try {
            const r = await fetch(`${m2.url}/v1/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' }, body: JSON.stringify({ id: 'q' }) });
            assert.equal(r.status, 201); // engine create_record answers 201 (handlers.rs:2594)
            assert.equal(m2.snapshot().tenants[0]?.tenantId, 'dflt');
        } finally { await m2.close(); }
    });

    /* ── 8. collection-first only ─────────────────────────────── */
    await test('D7-8 tenant-first URLs are 404', async () => {
        assert.equal((await http('POST', '/v1/ws-a/iso/query', { filter: 'all' })).status, 404);
        assert.equal((await http('POST', '/v1/ws-a/iso', { id: 'zz' })).status, 404);
        assert.equal((await http('POST', '/v1/ws-a/iso/vector/search', { vector: [1] })).status, 404);
        assert.equal((await http('GET', '/v1/ws-a/iso/r1')).status, 404);
    });

    /* ── 2. filter grammar ────────────────────────────────────── */
    await test('D7-2 flat / suffix / untagged filters -> 400 INVALID_REQUEST', async () => {
        for (const bad of [
            { org_id: 'x' },
            { tags_contains: 'y' },
            { and: [{ org_id: 'x' }] },
            { field: { field: 'a', operator: 'eq', value: 'plain' } },
            { field: { field: 'a', operator: 'bogus', value: { string: 'x' } } },
            { field: { field: 'a', operator: 'in', value: { string: 'x' } } },
            { and: [F('a', 'eq', 'x')], or: [F('a', 'eq', 'y')] },
            [],
            'nothing',
        ]) {
            const r = await http('POST', '/v1/iso/query', { filter: bad });
            assert.equal(r.status, 400, `filter ${JSON.stringify(bad)} should 400, got ${r.status}`);
            assert.equal(r.json['error']?.['code'], 'INVALID_REQUEST');
        }
        for (const path of ['count']) {
            assert.equal((await http('POST', `/v1/iso/${path}`, { filter: { org_id: 'x' } })).status, 400);
        }
        assert.equal((await http('PUT', '/v1/iso/update-by-query', { filter: { a: 1 }, fields: { x: 1 } })).status, 400);
        assert.equal((await http('DELETE', '/v1/iso/delete-by-query', { filter: { a: 1 } })).status, 400);
    });

    await test('D7-2 evaluation semantics: eq/ne/contains/exists/in/nin/gt, missing fields', async () => {
        await seed('ev', [
            { id: 'e1', name: 'Alpha Beta', tag: 'x', n: 1, opt: 'set' },
            { id: 'e2', name: 'gamma', tag: 'y', n: 5 },
            { id: 'e3', name: 'DELTA alpha', n: 9, opt: 'set' },
        ]);
        const q = async (filter: unknown): Promise<string[]> =>
            recordsOf(await http('POST', '/v1/ev/query', { filter, sort: [{ field: 'id', direction: 'asc' }] })).map((r) => r['id'] as string);
        assert.deepEqual(await q('all'), ['e1', 'e2', 'e3']);
        assert.deepEqual(await q(F('tag', 'eq', 'x')), ['e1']);
        assert.deepEqual(await q(F('name', 'contains', 'ALPHA')), ['e1', 'e3'], 'contains is case-insensitive substring');
        assert.deepEqual(await q(F('tag', 'ne', 'x')), ['e2', 'e3'], 'a missing field matches ne');
        assert.deepEqual(await q(F('tag', 'eq', 'zzz')), [], 'a missing field never matches eq');
        assert.deepEqual(await q(F('tag', 'in', ['x', 'y'])), ['e1', 'e2']);
        assert.deepEqual(await q(F('tag', 'nin', ['x'])), ['e2', 'e3'], 'missing field matches nin');
        assert.deepEqual(await q(F('opt', 'exists', true)), ['e1', 'e3']);
        assert.deepEqual(await q(F('n', 'gt', 1)), ['e2', 'e3']);
        assert.deepEqual(await q(F('n', 'lte', 5)), ['e1', 'e2']);
        assert.deepEqual(await q(F('name', 'starts_with', 'gam')), ['e2']);
        assert.deepEqual(await q(engineAnd([F('n', 'gt', 1), F('opt', 'exists', true)])), ['e3']);
        assert.deepEqual(await q({ or: [F('tag', 'eq', 'x'), F('tag', 'eq', 'y')] }), ['e1', 'e2']);
        assert.deepEqual(await q({ not: F('tag', 'eq', 'x') }), ['e2', 'e3']);
        assert.deepEqual(await q({ id_eq: 'e2' }), ['e2']);
        // no filter at all behaves like "all"
        assert.equal(recordsOf(await http('POST', '/v1/ev/query', {})).length, 3);
    });

    await test('D7-2 update-by-query / delete-by-query require a filter and respect it', async () => {
        assert.equal((await http('PUT', '/v1/ev/update-by-query', { fields: { z: 1 } })).status, 400);
        assert.equal((await http('DELETE', '/v1/ev/delete-by-query', {})).status, 400);
        const u = await http('PUT', '/v1/ev/update-by-query', { filter: F('tag', 'eq', 'x'), fields: { z: 1 } });
        assert.equal(u.json['data']['updated'], 1);
        const cnt = await http('POST', '/v1/ev/count', { filter: F('z', 'eq', 1) });
        assert.equal(cnt.json['data']['count'], 1);
        const d = await http('DELETE', '/v1/ev/delete-by-query', { filter: { id_eq: 'e3' } });
        assert.equal(d.json['data']['deleted'], 1);
        assert.equal((await http('POST', '/v1/ev/count', {})).json['data']['count'], 2);
    });

    await test('D7-2 (review A1 #4) update/delete/count use the engine in-memory Filter::matches, NOT query semantics', async () => {
        await seed('st', [
            { id: 's1', name: 'Alpha', tags: ['x', 'y'], n: 1, opt: 'set' },
            { id: 's2', name: 'alpine', tags: ['z'], n: 5 },
            { id: 's3', name: 'beta', n: 9, opt: 'set' },
        ]);
        const cnt = async (filter: unknown): Promise<number> => (await http('POST', '/v1/st/count', { filter })).json['data']['count'] as number;
        const qn = async (filter: unknown): Promise<number> => recordsOf(await http('POST', '/v1/st/query', { filter })).length;
        // query (full push-down connector): starts_with / exists / nin / contains-on-array work ...
        assert.equal(await qn(F('name', 'starts_with', 'al')), 2);
        assert.equal(await qn(F('opt', 'exists', true)), 2);
        assert.equal(await qn(F('name', 'nin', ['beta'])), 2);
        assert.equal(await qn(F('tags', 'contains', 'x')), 1);
        // ... but count / update / delete evaluate them in memory, where they are always false:
        assert.equal(await cnt(F('name', 'starts_with', 'al')), 0, 'starts_with is unsupported in Filter::matches');
        assert.equal(await cnt(F('name', 'ends_with', 'a')), 0, 'ends_with is unsupported');
        assert.equal(await cnt(F('name', 'regex', '^A')), 0, 'regex is unsupported');
        assert.equal(await cnt(F('opt', 'exists', true)), 0, 'exists is unsupported');
        assert.equal(await cnt(F('name', 'nin', ['beta'])), 0, 'nin is unsupported');
        assert.equal(await cnt(F('tags', 'contains', 'x')), 0, 'contains is string-only (array field -> false)');
        assert.equal(await cnt(F('name', 'contains', 'ALP')), 2, 'contains on a string is a case-insensitive substring');
        assert.equal(await cnt(F('opt', 'eq', 'nope')), 0);
        assert.equal(await cnt(F('opt', 'ne', 'set')), 1, 'a missing field matches only ne');
        assert.equal(await cnt(F('opt', 'in', ['set'])), 2);
        // The physical id is not a field of the in-memory record: a field clause on `id` is a missing field.
        assert.equal(await cnt(F('id', 'eq', 's1')), 0, 'field clause on id never matches eq');
        assert.equal(await cnt(F('id', 'in', ['s1', 's2'])), 0, 'field clause on id never matches in');
        assert.equal(await cnt(F('id', 'ne', 's1')), 3, 'a missing field matches ne, for every row');
        assert.equal(await cnt({ id_eq: 's1' }), 1, 'id_eq is the only physical-id match');
        assert.equal(await cnt({ or: [{ id_eq: 's1' }, { id_eq: 's3' }, { id_eq: 'nope' }] }), 2, 'or[id_eq] matches each named row');
        assert.equal(await cnt(F('n', 'gt', 'zzz')), 0, 'ordering across scalar types is not defined');
        assert.equal((await http('PUT', '/v1/st/update-by-query', { filter: F('name', 'starts_with', 'al'), fields: { z: 1 } })).json['data']['updated'], 0);
        assert.equal((await http('DELETE', '/v1/st/delete-by-query', { filter: F('name', 'starts_with', 'al') })).json['data']['deleted'], 0);
        assert.equal(await cnt('all'), 3, 'nothing was deleted');
    });

    await test('D7-2 (review A1 #2) queryFilterMode sqlite: only id_eq is pushed down on query', async () => {
        mock.options.queryFilterMode = 'sqlite';
        try {
            assert.equal(recordsOf(await http('POST', '/v1/st/query', { filter: F('name', 'eq', 'beta') })).length, 3, 'any field filter returns every row');
            assert.deepEqual(recordsOf(await http('POST', '/v1/st/query', { filter: { id_eq: 's2' } })).map((r) => r['id']), ['s2']);
            // count / update / delete still apply the filter (engine post-filter)
            assert.equal((await http('POST', '/v1/st/count', { filter: F('name', 'eq', 'beta') })).json['data']['count'], 1);
        } finally { mock.options.queryFilterMode = 'full'; }
    });

    await test('cloud purge: sqlite mode pushes id_eq down at the top level AND inside `and` on the query route', async () => {
        await seed('idq', [{ id: 'i1', t: 'x' }, { id: 'i2', t: 'x' }, { id: 'i3', t: 'y' }]);
        mock.options.queryFilterMode = 'sqlite';
        try {
            const ids = async (filter: unknown): Promise<unknown[]> => recordsOf(await http('POST', '/v1/idq/query', { filter })).map((r) => r['id']);
            assert.deepEqual(await ids({ id_eq: 'i2' }), ['i2'], 'top level');
            assert.deepEqual(await ids({ and: [F('t', 'eq', 'x'), { id_eq: 'i2' }] }), ['i2'], 'inside and (sqlite.rs extract_id_from_filter)');
            assert.deepEqual(await ids({ and: [{ id_eq: 'i3' }, F('t', 'eq', 'x')] }), ['i3'], 'the id is pushed down, the other clause is NOT (the caller filters client-side)');
            assert.deepEqual(await ids({ and: [F('t', 'eq', 'x'), F('t', 'ne', 'q')] }), ['i1', 'i2', 'i3'], 'no id_eq -> every row');
            assert.deepEqual(await ids({ or: [{ id_eq: 'i2' }, F('t', 'eq', 'x')] }), ['i1', 'i2', 'i3'], 'id_eq inside or is not extracted');
        } finally { mock.options.queryFilterMode = 'full'; }
    });

    await test('cloud purge: delete-by-query rejects filter `all` (HTTP 200 envelope ERR_VALIDATION, handlers.rs:3680); count does not; a missing filter is 400', async () => {
        await seed('rej', [{ id: 'j1' }, { id: 'j2' }]);
        const r = await http('DELETE', '/v1/rej/delete-by-query', { filter: 'all' });
        assert.equal(r.status, 200, 'the engine answers an ApiResponse::error as HTTP 200');
        assert.equal(r.json['success'], false);
        assert.equal(r.json['error']['code'], 'ERR_VALIDATION');
        assert.match(r.json['error']['message'], /Filter::All is not allowed/);
        assert.equal(mock.rows('ws-a', 'rej').length, 2, 'nothing deleted');
        assert.equal((await http('DELETE', '/v1/rej/delete-by-query', {})).status, 400, 'filterOf(..., required=true): a missing filter is INVALID_REQUEST');
        assert.equal((await http('POST', '/v1/rej/count', { filter: 'all' })).json['data']['count'], 2, 'count has no such guard (handlers.rs:3481-3530)');
        const e = await http('DELETE', '/v1/rej/delete-by-query', { filter: { and: [] } });
        assert.equal(e.json['data']?.['deleted'], 2, 'an empty `and` is NOT the `all` variant, so it is not refused (it matches every row)');
    });

    await test('cloud purge: byQueryWindow — sqlite mode examines the first N UNFILTERED rows unless an id_eq is extractable; full mode the first N matching rows', async () => {
        const rows = Array.from({ length: 6 }, (_, i) => ({ id: `w${i + 1}`, g: i < 3 ? 'junk' : 'mine' }));
        const mine = F('g', 'eq', 'mine');
        const count = async (filter: unknown): Promise<number> => (await http('POST', '/v1/win/count', { filter })).json['data']['count'] as number;
        await seed('win', rows);
        mock.options.byQueryWindow = 3;
        try {
            // default (full) mode: the window applies to MATCHING rows, so a count is capped but not blinded.
            assert.equal(await count(mine), 3, 'full: first 3 matching rows (of 3 matching)');
            mock.options.queryFilterMode = 'sqlite';
            assert.equal(await count(mine), 0, 'sqlite: the window is the first 3 rows (all junk), the filter only runs on them');
            assert.equal(await count(F('g', 'eq', 'junk')), 3);
            assert.equal(await count({ id_eq: 'w6' }), 1, 'id_eq at the top level is an exact lookup, outside the window');
            assert.equal(await count({ and: [mine, { id_eq: 'w5' }] }), 1, 'id_eq inside and is an exact lookup too');
            assert.equal(await count({ and: [F('g', 'eq', 'junk'), { id_eq: 'w5' }] }), 0, 'the rest of the filter still runs in memory on the looked-up row');
            // delete-by-query sees the same window: a purge filter without id_eq silently misses rows past it.
            const miss = await http('DELETE', '/v1/win/delete-by-query', { filter: mine });
            assert.equal(miss.status, 200);
            assert.equal(miss.json['data']['deleted'], 0, 'still 200, but the rows beyond the window were never examined');
            assert.equal(mock.rows('ws-a', 'win').length, 6);
            const hit = await http('DELETE', '/v1/win/delete-by-query', { filter: { and: [mine, { id_eq: 'w6' }] } });
            assert.equal(hit.json['data']['deleted'], 1);
            mock.options.queryFilterMode = 'full';
            mock.options.byQueryWindow = 1;
            assert.equal((await http('DELETE', '/v1/win/delete-by-query', { filter: mine })).json['data']['deleted'], 1, 'full: at most N matching rows per call');
            assert.deepEqual(mock.rows('ws-a', 'win').map((r) => r['id']), ['w1', 'w2', 'w3', 'w5'], 'the first match (w4) went');
            assert.equal((await http('DELETE', '/v1/win/delete-by-query', { filter: mine })).json['data']['deleted'], 1, 'the next call takes the next match');
            assert.equal((await http('DELETE', '/v1/win/delete-by-query', { filter: mine })).json['data']['deleted'], 0);
        } finally {
            mock.options.queryFilterMode = 'full';
            mock.options.byQueryWindow = 100_000;
        }
    });

    await test('cloud purge: a failing per-row delete is skipped — delete-by-query still answers 200 with a lower `deleted`, and the row survives', async () => {
        await seed('flk', [{ id: 'f1', g: 'x' }, { id: 'f2', g: 'x' }, { id: 'f3', g: 'x' }, { id: 'f4', g: 'y' }]);
        mock.options.failRowDelete = (row) => row['id'] === 'f2';
        try {
            const r = await http('DELETE', '/v1/flk/delete-by-query', { filter: F('g', 'eq', 'x') });
            assert.equal(r.status, 200);
            assert.equal(r.json['success'], true);
            assert.equal(r.json['data']['deleted'], 2, 'f1 and f3; the failing row is not counted');
            assert.deepEqual(mock.rows('ws-a', 'flk').map((x) => x['id']), ['f2', 'f4']);
            assert.equal((await http('POST', '/v1/flk/count', { filter: F('g', 'eq', 'x') })).json['data']['count'], 1, 'the survivor is still counted');
            mock.options.failRowDelete = () => false;
            assert.equal((await http('DELETE', '/v1/flk/delete-by-query', { filter: F('g', 'eq', 'x') })).json['data']['deleted'], 1, 'a retry without the fault removes it');
        } finally { mock.options.failRowDelete = () => false; }
    });

    await test('D7-2 (review A1 #3) query reads `projection`, ignores `fields`', async () => {
        const withFields = recordsOf(await http('POST', '/v1/st/query', { filter: 'all', fields: ['name'] }));
        assert.ok(withFields.every((r) => 'n' in r || 'tags' in r || 'opt' in r), '`fields` does not narrow the columns');
        const withProjection = recordsOf(await http('POST', '/v1/st/query', { filter: 'all', projection: ['name'], sort: [{ field: 'id', direction: 'asc' }] }));
        assert.deepEqual(withProjection[0], { id: 's1', name: 'Alpha' });
    });

    /* ── 3. schema / PK / gf_extra ────────────────────────────── */
    const ENGINE_DUP = { code: 'ERR_QUERY', message: 'Query execution failed. Check server logs for details.' };

    await test('D7-3 primary key duplicate -> HTTP 500 ERR_QUERY with the suppressed engine message (NOT 409)', async () => {
        await seed('pk', [{ id: 'same', v: 1 }]);
        const r = await http('POST', '/v1/pk', { id: 'same', v: 2 });
        assert.equal(r.status, 500, 'handlers.rs:2594 maps every connector Err to 500');
        assert.deepEqual({ code: r.json['error']?.['code'], message: r.json['error']?.['message'] }, ENGINE_DUP);
        assert.equal(r.json['success'], false);
        assert.doesNotMatch(JSON.stringify(r.json), /duplicate|already exists|unique/i, 'the raw DB message is suppressed: nothing to match on');
        // primary key is per Dataplane workspace: the same id in ws-b is fine
        assert.equal((await http('POST', '/v1/pk', { id: 'same', v: 3 }, KEY_B)).status, 201);
    });

    await test('D7-3 declared unique index is enforced (500 ERR_QUERY) and PK is immutable', async () => {
        const schema = {
            name: 'uq',
            fields: [{ name: 'id', field_type: 'string' }, { name: 'a', field_type: 'string' }, { name: 'b', field_type: 'string' }],
            indexes: [{ name: 'ab', fields: ['a', 'b'], unique: true }],
        };
        assert.equal((await http('POST', '/v1/schema', schema)).status, 201);
        assert.equal((await http('POST', '/v1/uq', { id: 'r1', a: '1', b: '2' })).status, 201);
        assert.equal((await http('POST', '/v1/uq', { id: 'r2', a: '1', b: '2' })).status, 500);
        assert.equal((await http('POST', '/v1/uq', { id: 'r3', a: '1', b: '3' })).status, 201);
        assert.equal((await http('PUT', '/v1/uq/update-by-query', { filter: { id_eq: 'r1' }, fields: { id: 'renamed' } })).status, 400);
        // update that would collide on the unique index is the same suppressed 500
        const clash = await http('PUT', '/v1/uq/update-by-query', { filter: { id_eq: 'r3' }, fields: { b: '2' } });
        assert.equal(clash.status, 500);
        assert.equal(clash.json['error']?.['code'], 'ERR_QUERY');
    });

    await test('D7-3 undeclared fields are accepted and returned (gf_extra)', async () => {
        assert.equal((await http('POST', '/v1/schema', { name: 'ex', fields: [{ name: 'id', field_type: 'string' }] })).status, 201);
        assert.equal((await http('POST', '/v1/ex', { id: 'x1', surprise: 'yes' })).status, 201);
        assert.equal((await http('GET', '/v1/ex/x1')).json['data']['surprise'], 'yes');
        const q = await http('POST', '/v1/ex/query', { filter: F('surprise', 'eq', 'yes') });
        assert.equal(recordsOf(q).length, 1);
        assert.deepEqual(mock.declaredFields('ws-a', 'ex'), ['id'], 'undeclared field stays undeclared');
    });

    await test('D7-3 schema re-push adds no columns; ANY field or index over a missing column -> 500 ERR_SCHEMA (review B #4)', async () => {
        const first = { name: 'sc', fields: [{ name: 'id', field_type: 'string' }, { name: 'a', field_type: 'string' }] };
        assert.equal((await http('POST', '/v1/schema', first)).status, 201);
        await seed('sc', [{ id: 's1', a: 'x' }]);
        assert.equal((await http('POST', '/v1/schema', first)).status, 201, 'identical re-push is fine');
        // postgres.rs:1020ff — COMMENT ON COLUMN for every declared field: a NON-indexed new field fails too.
        const again = { ...first, fields: [...first.fields, { name: 'newcol', field_type: 'string' }] };
        const r = await http('POST', '/v1/schema', again);
        assert.equal(r.status, 500, 'a plain new field on an existing table rolls the whole re-push back');
        assert.equal(r.json['error']?.['code'], 'ERR_SCHEMA');
        assert.deepEqual(mock.declaredFields('ws-a', 'sc')?.sort(), ['a', 'id'], 're-push must not add newcol');
        assert.equal(mock.rows('ws-a', 'sc').length, 1, 're-push does not wipe rows');
        const badIdx = { ...first, indexes: [{ name: 'ix_new', fields: ['newcol'], unique: false }] };
        assert.equal((await http('POST', '/v1/schema', badIdx)).status, 500, 'index over a missing column');
        assert.equal((await http('POST', '/v1/schema', { ...first, indexes: [{ name: 'ix_a', fields: ['a'] }] })).status, 201);
    });

    await test('D7-3 GET /v1/schema/:c returns declared fields; unknown -> HTTP 200 + ERR_NOT_FOUND envelope (handlers.rs:1892)', async () => {
        const r = await http('GET', '/v1/schema/sc');
        assert.equal(r.status, 200);
        const names = (r.json['data']['fields'] as Array<{ name: string }>).map((f) => f.name).sort();
        assert.deepEqual(names, ['a', 'id']);
        const miss = await http('GET', '/v1/schema/does_not_exist');
        assert.equal(miss.status, 200, 'the engine does not use a 404 status here');
        assert.equal(miss.json['success'], false);
        assert.equal(miss.json['error']?.['code'], 'ERR_NOT_FOUND');
        // schemas are per Dataplane workspace
        assert.equal((await http('GET', '/v1/schema/sc', undefined, KEY_B)).json['error']?.['code'], 'ERR_NOT_FOUND');
    });

    await test('D7-8 GET /:c/:id is the ApiResponse envelope; a miss is HTTP 200 + ERR_NOT_FOUND (handlers.rs:2698)', async () => {
        await seed('gr', [{ id: 'g1', v: 'x' }]);
        const hit = await http('GET', '/v1/gr/g1');
        assert.equal(hit.status, 200);
        assert.equal(hit.json['success'], true);
        assert.equal(hit.json['data']['id'], 'g1');
        assert.equal(hit.json['data']['v'], 'x');
        assert.equal('v' in hit.json, false, 'fields live under data, not at the top level');
        const miss = await http('GET', '/v1/gr/nope');
        assert.equal(miss.status, 200);
        assert.deepEqual({ success: miss.json['success'], code: miss.json['error']?.['code'], message: miss.json['error']?.['message'] }, { success: false, code: 'ERR_NOT_FOUND', message: 'Record not found' });
    });

    await test('3b audit fields: create keeps caller values, fills the rest; update ALWAYS overwrites updated_at (review B #3)', async () => {
        const callerTs = '2020-01-02T03:04:05.000Z';
        await seed('au', [{ id: 'a1', created_at: callerTs, updated_at: callerTs }, { id: 'a2' }]);
        const [a1, a2] = ['a1', 'a2'].map((id) => mock.rows('ws-a', 'au').find((r) => r['id'] === id)!);
        assert.equal(a1['created_at'], callerTs, 'create keeps a caller-supplied created_at');
        assert.equal(a1['updated_at'], callerTs, 'create keeps a caller-supplied updated_at');
        assert.match(String(a2['created_at']), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}\+00:00$/, 'server-filled value is chrono rfc3339');
        assert.equal(a2['created_by'], 'ws-a');
        const upd = await http('PUT', '/v1/au/update-by-query', { filter: { id_eq: 'a1' }, fields: { v: 1, updated_at: callerTs } });
        assert.equal(upd.json['data']['updated'], 1);
        const after = mock.rows('ws-a', 'au').find((r) => r['id'] === 'a1')!;
        assert.notEqual(after['updated_at'], callerTs, 'a caller-supplied updated_at is discarded on update');
        assert.match(String(after['updated_at']), /\+00:00$/);
        assert.equal(after['created_at'], callerTs, 'created_at is never touched by update');
    });

    await test('3c /bulk ignores the caller id, assigns its own, answers {inserted, ids, total_requested}', async () => {
        const r = await http('POST', '/v1/bk/bulk', { records: [{ id: 'lw1_mine', v: 1 }, { id: 'lw1_mine2', v: 2 }] });
        assert.equal(r.status, 201);
        assert.equal(r.json['data']['inserted'], 2);
        assert.equal(r.json['data']['total_requested'], 2);
        assert.equal((r.json['data']['ids'] as string[]).length, 2);
        const stored = mock.rows('ws-a', 'bk');
        assert.equal(stored.length, 2);
        assert.ok(stored.every((row) => typeof row['id'] === 'string' && !(row['id'] as string).startsWith('lw1_')), 'physical ids are engine-assigned');
        assert.deepEqual((r.json['data']['ids'] as string[]).sort(), stored.map((row) => row['id'] as string).sort());
        assert.equal((await http('GET', '/v1/bk/lw1_mine')).json['success'], false, 'the caller id is not addressable');
        // no count cap (SQLite per-row INSERT), no all-or-nothing
        const many = Array.from({ length: 1200 }, (_, i) => ({ v: i }));
        assert.equal((await http('POST', '/v1/bk2/bulk', { records: many })).status, 201);
        assert.equal(mock.rows('ws-a', 'bk2').length, 1200);
    });

    await test('3c bulk is per-row, not all-or-nothing: a unique violation part-way keeps the earlier rows', async () => {
        assert.equal((await http('POST', '/v1/schema', { name: 'bu', fields: [{ name: 'id', field_type: 'string' }, { name: 'k', field_type: 'string' }], indexes: [{ name: 'uk', fields: ['k'], unique: true }] })).status, 201);
        const r = await http('POST', '/v1/bu/bulk', { records: [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: 'c' }] });
        assert.equal(r.status, 500);
        assert.equal(r.json['error']?.['code'], 'ERR_QUERY');
        assert.deepEqual(mock.rows('ws-a', 'bu').map((row) => row['k']), ['a', 'b']);
    });

    await test('D7-2 (review B #8) queryFilterMode sqlite ignores sort and offset; total_count = page length, has_more false', async () => {
        await seed('sq', [{ id: 'q3', n: 3 }, { id: 'q1', n: 1 }, { id: 'q2', n: 2 }]);
        mock.options.queryFilterMode = 'sqlite';
        try {
            const sorted = recordsOf(await http('POST', '/v1/sq/query', { sort: [{ field: 'n', direction: 'asc' }], limit: 10 })).map((r) => r['id']);
            assert.deepEqual(sorted, ['q3', 'q1', 'q2'], 'sort ignored: storage order');
            const p1 = await http('POST', '/v1/sq/query', { limit: 2, offset: 0 });
            const p2 = await http('POST', '/v1/sq/query', { limit: 2, offset: 2 });
            assert.deepEqual(recordsOf(p2).map((r) => r['id']), recordsOf(p1).map((r) => r['id']), 'offset ignored: the same page again');
            assert.equal(p1.json['has_more'], false);
            assert.equal(p1.json['total_count'], 2);
        } finally { mock.options.queryFilterMode = 'full'; }
    });

    await test('query: sort uses sort:[{field,direction}]; order_by is ignored', async () => {
        await seed('so', [{ id: 'a', n: 2 }, { id: 'b', n: 3 }, { id: 'c', n: 1 }]);
        const desc = recordsOf(await http('POST', '/v1/so/query', { sort: [{ field: 'n', direction: 'desc' }] })).map((r) => r['id']);
        assert.deepEqual(desc, ['b', 'a', 'c']);
        const legacy = recordsOf(await http('POST', '/v1/so/query', { order_by: 'n', order_dir: 'desc' })).map((r) => r['id']);
        assert.deepEqual(legacy, ['a', 'b', 'c'], 'legacy order_by is silently ignored (insertion order)');
        assert.equal((await http('POST', '/v1/so/query', { sort: [{ field: 'n' }] })).status, 400);
    });

    /* ── 4. vector search ─────────────────────────────────────── */
    const vecRows = (): J[] => [
        { id: 'v1', lore_workspace: 'w1', type: 'a', vector: [1, 0], project: 'p' },
        { id: 'v2', lore_workspace: 'w2', type: 'a', vector: [0.9, 0.1], project: 'p' },
        { id: 'v3', lore_workspace: 'w1', type: 'b', vector: [0, 1], project: 'q' },
    ];
    await seed('vec', vecRows());
    const vs = async (filter: unknown, limit = 10): Promise<{ status: number; json: J }> => http('POST', '/v1/vec/vector/search', { vector: [1, 0], limit, metadata_filter: filter });
    const ids = (r: { json: J }): string[] => recordsOf(r).map((x) => x['id'] as string);

    await test('D7-4 qdrant mode: string Fields (top-level or one and) filter; all ops act as eq; others dropped', async () => {
        mock.options.vectorFilterMode = 'qdrant';
        assert.deepEqual(ids(await vs(F('lore_workspace', 'eq', 'w1'))), ['v1', 'v3']);
        assert.deepEqual(ids(await vs(engineAnd([F('lore_workspace', 'eq', 'w1'), F('type', 'eq', 'a')]))), ['v1']);
        assert.deepEqual(ids(await vs(F('lore_workspace', 'ne', 'w1'))), ['v1', 'v3'], 'ne is treated as eq (engine quirk)');
        assert.deepEqual(ids(await vs(F('lore_workspace', 'in', ['w1']))).sort(), ['v1', 'v2', 'v3'], 'non-string values are dropped -> unfiltered');
        assert.deepEqual(ids(await vs({ or: [F('lore_workspace', 'eq', 'w1')] })).sort(), ['v1', 'v2', 'v3'], 'or is dropped');
        assert.deepEqual(ids(await vs({ and: [{ and: [F('lore_workspace', 'eq', 'w1')] }, F('type', 'eq', 'b')] })), ['v3'], 'nested and: only the direct string Field is kept');
    });

    await test('D7-4 ignore mode (Arango): metadata_filter has no effect at all', async () => {
        mock.options.vectorFilterMode = 'ignore';
        assert.deepEqual(ids(await vs(F('lore_workspace', 'eq', 'w1'))).sort(), ['v1', 'v2', 'v3']);
        mock.options.vectorFilterMode = 'qdrant';
    });

    await test('D7-4 none-zilliz mode: only a single top-level Field is honoured', async () => {
        mock.options.vectorFilterMode = 'none-zilliz';
        assert.deepEqual(ids(await vs(F('lore_workspace', 'eq', 'w1'))), ['v1', 'v3']);
        assert.deepEqual(ids(await vs(engineAnd([F('lore_workspace', 'eq', 'w1'), F('type', 'eq', 'a')]))).sort(), ['v1', 'v2', 'v3']);
        mock.options.vectorFilterMode = 'qdrant';
    });

    await test('D7-4 limit is capped at 100; results are ordered by similarity', async () => {
        const rows: J[] = Array.from({ length: 130 }, (_, i) => ({ tag: `bulk${i}`, vector: [1, i / 200] }));
        assert.equal((await http('POST', '/v1/bigvec/bulk', { records: rows })).status, 201);
        const r = await http('POST', '/v1/bigvec/vector/search', { vector: [1, 0], limit: 500 });
        assert.equal(recordsOf(r).length, 100);
        assert.equal(recordsOf(r)[0]!['tag'], 'bulk0');
    });

    await test('D7-4 score key variants', async () => {
        for (const [key, expectKey] of [['score', 'score'], ['distance', 'distance'], ['_distance', '_distance'], ['_score', '_score']] as const) {
            mock.options.scoreKey = key;
            const rec = recordsOf(await vs(F('lore_workspace', 'eq', 'w1')))[0]!;
            assert.equal(typeof rec[expectKey], 'number', `${key}`);
            for (const other of ['score', 'distance', '_distance', '_score']) if (other !== expectKey) assert.equal(other in rec, false, `${key}: stray ${other}`);
        }
        mock.options.scoreKey = 'none';
        const rec = recordsOf(await vs(F('lore_workspace', 'eq', 'w1')))[0]!;
        for (const k of ['score', 'distance', '_distance', '_score']) assert.equal(k in rec, false);
        mock.options.scoreKey = 'score';
    });

    await test('D7-4 vector search never crosses Dataplane workspaces', async () => {
        const r = await http('POST', '/v1/vec/vector/search', { vector: [1, 0] }, KEY_B);
        assert.equal(recordsOf(r).length, 0);
    });

    /* ── 5. keyword search ────────────────────────────────────── */
    await seed('kw', [
        { id: 'k1', lore_workspace: 'w1', text: 'rust engine ownership rules' },
        { id: 'k2', lore_workspace: 'w2', text: 'rust rust rust everywhere' },
        { id: 'k3', lore_workspace: 'w1', text: 'unrelated prose' },
    ]);
    await test('D7-5 keyword search: envelope, ranked _score, ignores a filter key', async () => {
        mock.options.ftsMode = 'ranked';
        const r = await http('POST', '/v1/kw/search', { query: 'rust', fields: ['text'], limit: 10, filter: F('lore_workspace', 'eq', 'w1') });
        assert.equal(r.status, 200);
        assert.equal(r.json['data']['query'], 'rust');
        assert.equal(r.json['data']['collection'], 'kw');
        const recs = r.json['data']['records'] as J[];
        assert.deepEqual(recs.map((x) => x['id']), ['k2', 'k1'], 'filter must be ignored -> w2 row returned, ranked by score');
        assert.ok(recs.every((x) => typeof x['_score'] === 'number'));
        assert.ok((recs[0]!['_score'] as number) >= (recs[1]!['_score'] as number));
    });

    await test('D7-5 keyword substring mode has no _score; limit <= 500; empty query 400', async () => {
        mock.options.ftsMode = 'substring';
        const recs = (await http('POST', '/v1/kw/search', { query: 'rust', fields: ['text'] })).json['data']['records'] as J[];
        assert.equal(recs.length, 2);
        assert.ok(recs.every((x) => !('_score' in x)));
        mock.options.ftsMode = 'ranked';
        const rows: J[] = Array.from({ length: 520 }, (_, i) => ({ id: `w${i}`, text: 'needle' }));
        for (let i = 0; i < rows.length; i += 250) assert.equal((await http('POST', '/v1/kwbig/bulk', { records: rows.slice(i, i + 250) })).status, 201);
        const big = await http('POST', '/v1/kwbig/search', { query: 'needle', fields: ['text'], limit: 9999 });
        assert.equal((big.json['data']['records'] as J[]).length, 500);
        assert.equal((await http('POST', '/v1/kw/search', { query: '   ' })).status, 400);
        assert.equal((await http('POST', '/v1/kw/search', {})).status, 400);
        assert.equal(((await http('POST', '/v1/kw/search', { query: 'rust', fields: ['text'] }, KEY_B)).json['data']['records'] as J[]).length, 0, 'other Dataplane workspace sees nothing');
    });

    /* ── 7. traverse ──────────────────────────────────────────── */
    await test('D7-7 traverse: no filter, vertices with _depth, BFS within one Dataplane workspace', async () => {
        await seed('tv', [{ id: 'a', lore_workspace: 'w1' }, { id: 'b', lore_workspace: 'w1' }, { id: 'c', lore_workspace: 'w1' }, { id: 'z', lore_workspace: 'w2' }]);
        await seed('tv', [{ id: 'a', lore_workspace: 'other-dp-ws' }], KEY_B);
        for (const [from, to] of [['a', 'b'], ['b', 'c'], ['c', 'z']]) {
            assert.equal((await http('POST', '/v1/tv/graph/edge', { from_id: `tv/${from}`, to_id: `tv/${to}`, edge_collection: 'edges', properties: { relation: 'rel' } })).status, 200);
        }
        // an edge in ws-b must never be followed from ws-a
        await http('POST', '/v1/tv/graph/edge', { from_id: 'tv/a', to_id: 'tv/a', edge_collection: 'edges' }, KEY_B);
        const t = await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/a', edge_collection: 'edges', direction: 'out', min_depth: 1, max_depth: 3 });
        assert.equal(t.status, 200);
        const recs = t.json['data']['records'] as J[];
        assert.deepEqual(recs.map((r) => [r['id'], r['_depth']]), [['b', 1], ['c', 2], ['z', 3]]);
        // a traverse `filter` key is ignored — the w2 vertex `z` is still returned
        const f = await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/a', edge_collection: 'edges', direction: 'out', max_depth: 3, filter: F('lore_workspace', 'eq', 'w1') });
        assert.deepEqual((f.json['data']['records'] as J[]).map((r) => r['id']), ['b', 'c', 'z']);
        const both = await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/c', edge_collection: 'edges', direction: 'both', min_depth: 1, max_depth: 1 });
        assert.deepEqual((both.json['data']['records'] as J[]).map((r) => r['id']).sort(), ['b', 'z']);
        const wsB = await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/a', edge_collection: 'edges', direction: 'out', max_depth: 3 }, KEY_B);
        assert.deepEqual(wsB.json['data']['records'], [], 'ws-b only has its own self-edge');
    });

    await test('D7-7 (review A1 #7) traverseVertexShape: bare (engine) | prefixed | key', async () => {
        const ids = async (): Promise<unknown[]> => ((await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/a', edge_collection: 'edges', direction: 'out', max_depth: 1 })).json['data']['records'] as J[]).map((r) => r['id'] ?? r['_key']);
        mock.options.traverseVertexShape = 'prefixed';
        try {
            assert.deepEqual(await ids(), ['tv/b']);
            mock.options.traverseVertexShape = 'key';
            const r = ((await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/a', edge_collection: 'edges', direction: 'out', max_depth: 1 })).json['data']['records'] as J[])[0]!;
            assert.equal('id' in r, false);
            assert.equal(r['_key'], 'b');
        } finally { mock.options.traverseVertexShape = 'bare'; }
        assert.deepEqual(await ids(), ['b']);
    });

    await test('D7-7 traverse without an edge collection is an error envelope', async () => {
        const r = await http('POST', '/v1/tv/graph/traverse', { start_id: 'tv/a', direction: 'out' });
        assert.equal(r.json['success'], false);
        assert.equal(r.json['error']['code'], 'ERR_MISSING_EDGE_COLLECTION');
    });


    /* ── 6. POST /v1/transaction ──────────────────────────────── */
    // A connector only knows the tables created through it (section 9), so the transaction sections
    // provision their tables first; `rawTx` skips that to exercise the missing-relation failure.
    const rawTx = (operations: unknown, key: string | null = KEY_A, extra: Record<string, string> = {}, extraBody: J = {}) =>
        http('POST', '/v1/transaction', { operations, ...extraBody }, key, extra);
    const tx = async (operations: unknown, key: string | null = KEY_A, extra: Record<string, string> = {}, extraBody: J = {}) => {
        if (Array.isArray(operations)) {
            const names = new Set((operations as J[]).map((o) => o?.['collection']).filter((c): c is string => typeof c === 'string'));
            for (const name of names) {
                const r = await http('POST', '/v1/schema', { name, fields: [{ name: 'id', type: 'string', primary_key: true }] }, key);
                assert.equal(r.status, 201, `provision ${name}: ${JSON.stringify(r.json)}`);
            }
        }
        return rawTx(operations, key, extra, extraBody);
    };
    const idsOf = async (c: string, key = KEY_A): Promise<string[]> =>
        ((await http('POST', `/v1/${c}/query`, { filter: 'all', limit: 1000 }, key)).json['records'] as J[]).map((r) => r['id']).sort();

    await test('D7-6 commits every op: create (caller id honoured, NO audit fill), alias, update, delete', async () => {
        const r = await tx([
            { op: 'create', collection: 'txa', fields: { id: 'p1', n: 1 }, as: 'first' },
            { op: 'create', collection: 'txa', fields: { n: 2, parent: '$first.id' } },
            { op: 'bulk_create', collection: 'txa', records: [{ id: 'b1', n: 3 }, { id: 'b2', n: 3 }] },
            { op: 'update', collection: 'txa', filter: F('n', 'eq', 3), fields: { n: 4 } },
            { op: 'delete', collection: 'txa', filter: F('id', 'eq', 'p1') },
        ]);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json['success'], true);
        const d = r.json['data'];
        assert.equal(d['committed'], true);
        assert.equal(typeof d['duration_ms'], 'number');
        assert.equal(d['results'][0]['id'], 'p1');
        assert.equal(d['results'][0]['alias'], 'first');
        assert.deepEqual(d['results'][2]['ids'], ['b1', 'b2'], 'bulk_create in a transaction honours ids (unlike /bulk)');
        assert.deepEqual([d['results'][3]['matched'], d['results'][3]['modified']], [2, 2]);
        assert.equal(d['results'][4]['deleted'], 1);
        const rows = mock.rows('ws-a', 'txa');
        const child = rows.find((x) => x['n'] === 2)!;
        assert.equal(child['parent'], 'p1', '`$alias.id` resolved to the id op 0 created');
        assert.match(String(child['id']), /\S/, 'engine generates an id when none is given');
        assert.equal('created_at' in child, false, 'no audit-field fill on the transaction path');
        assert.deepEqual(rows.map((x) => x['id']).sort(), [child['id'], 'b1', 'b2'].sort());
        assert.equal(rows.find((x) => x['id'] === 'b1')!['n'], 4);
    });

    await test('D7-6 all-or-nothing: a failing op (duplicate id) rolls the earlier ops back, 409 OP_FAILED', async () => {
        await seed('txb', [{ id: 'dup', v: 1 }]);
        const r = await tx([
            { op: 'create', collection: 'txb', fields: { id: 'fresh', v: 2 } },
            { op: 'update', collection: 'txb', filter: F('id', 'eq', 'dup'), fields: { v: 99 } },
            { op: 'create', collection: 'txb', fields: { id: 'dup', v: 3 } },
        ]);
        assert.equal(r.status, 409);
        assert.equal(r.json['error']['code'], 'OP_FAILED');
        // handlers.rs maps a message with "op " + "failed:" to 409; the text is EngineError::Query's Display
        // ("Query error: ...") wrapping postgres.rs's `insert in tx rejected: <PG error>`.
        assert.match(r.json['error']['message'], /^Query error: op 2: create txb failed: Query error: insert in tx rejected: db error: ERROR: duplicate key value violates unique constraint "txb_pkey"$/);
        assert.deepEqual(await idsOf('txb'), ['dup'], 'nothing from the failed transaction persisted');
        assert.equal(mock.rows('ws-a', 'txb')[0]!['v'], 1, 'the update was rolled back too');
    });

    await test('D7-6 update/delete use SQL push-down semantics (starts_with works), unlike update-by-query', async () => {
        await seed('txc', [{ id: 'k#1', v: 1 }, { id: 'k#2', v: 1 }, { id: 'z', v: 1 }]);
        const byQuery = await http('DELETE', '/v1/txc/delete-by-query', { filter: F('id', 'starts_with', 'k#') });
        assert.equal(byQuery.json['data']['deleted'], 0, 'strict in-memory matcher: starts_with is always false');
        const r = await tx([{ op: 'delete', collection: 'txc', filter: F('id', 'starts_with', 'k#') }]);
        assert.equal(r.json['data']['results'][0]['deleted'], 2);
        assert.deepEqual(await idsOf('txc'), ['z']);
    });

    await test('D7-6 validation: 0 ops / >100 ops / >1000 bulk records -> 400 LIMIT_EXCEEDED, bad shape -> 400 INVALID_REQUEST', async () => {
        const e0 = await tx([]);
        assert.deepEqual([e0.status, e0.json['error']['code']], [400, 'LIMIT_EXCEEDED']);
        const many = Array.from({ length: 101 }, (_, i) => ({ op: 'create', collection: 'txd', fields: { id: `m${i}` } }));
        const e1 = await tx(many);
        assert.deepEqual([e1.status, e1.json['error']['code']], [400, 'LIMIT_EXCEEDED']);
        assert.deepEqual(await idsOf('txd'), []);
        const okMax = await tx(many.slice(0, 100));
        assert.equal(okMax.status, 200, '100 ops is the ceiling');
        const e2 = await tx([{ op: 'bulk_create', collection: 'txe', records: Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}` })) }]);
        assert.deepEqual([e2.status, e2.json['error']['code']], [400, 'LIMIT_EXCEEDED']);
        const e3 = await tx([{ op: 'frobnicate', collection: 'txd' }]);
        assert.deepEqual([e3.status, e3.json['error']['code']], [400, 'INVALID_REQUEST']);
        const e4 = await http('POST', '/v1/transaction', { nope: 1 });
        assert.deepEqual([e4.status, e4.json['error']['code']], [400, 'INVALID_REQUEST']);
        const e5 = await tx([{ op: 'create', collection: 'txd', fields: { id: 'a1' }, as: 'Bad-Alias' }]);
        assert.deepEqual([e5.status, e5.json['error']['code']], [400, 'LIMIT_EXCEEDED']);
    });

    await test('D7-6 atomic:false -> 501 UNSUPPORTED_OP; an undeclared `$alias.id` fails the whole transaction', async () => {
        const na = await tx([{ op: 'create', collection: 'txf', fields: { id: 'x' } }], KEY_A, {}, { atomic: false });
        assert.deepEqual([na.status, na.json['error']['code']], [501, 'UNSUPPORTED_OP']);
        const un = await tx([
            { op: 'create', collection: 'txf', fields: { id: 'ok1' } },
            { op: 'create', collection: 'txf', fields: { id: 'ok2', text: '$ghost.id' } },
        ]);
        assert.equal(un.json['success'], false);
        assert.match(un.json['error']['message'], /undeclared alias '\$ghost\.id'/);
        assert.deepEqual(await idsOf('txf'), [], 'ok1 was rolled back');
        // Only the exact `$alias.id` shape is a reference; anything else is plain data.
        const plain = await tx([{ op: 'create', collection: 'txf', fields: { id: 'p', text: 'costs $5.id or $Ghost.id' } }]);
        assert.equal(plain.status, 200);
    });

    await test('D7-6 scoped to the credential workspace: ws-b never sees or alters ws-a rows', async () => {
        await seed('txg', [{ id: 'g1', v: 1 }]);
        const r = await tx([{ op: 'update', collection: 'txg', filter: F('id', 'eq', 'g1'), fields: { v: 2 } }], KEY_B);
        assert.equal(r.json['data']['results'][0]['matched'], 0);
        assert.equal(mock.rows('ws-a', 'txg')[0]!['v'], 1);
        // the same id can exist independently in ws-b (separate workspaces)
        assert.equal((await tx([{ op: 'create', collection: 'txg', fields: { id: 'g1' } }], KEY_B)).status, 200);
    });

    await test('D7-6 Idempotency-Key replays the cached response — errors included — per workspace; empty / >128 chars ignored', async () => {
        const ops = [{ op: 'create', collection: 'txh', fields: { id: 'h1' } }];
        const first = await tx(ops, KEY_A, { 'Idempotency-Key': 'k-ok' });
        assert.equal(first.status, 200);
        await http('DELETE', '/v1/txh/delete-by-query', { filter: { id_eq: 'h1' } }); // the physical id is matched by id_eq only
        const replay = await tx(ops, KEY_A, { 'Idempotency-Key': 'k-ok' });
        assert.deepEqual(replay.json['data']['results'], first.json['data']['results']);
        assert.deepEqual(await idsOf('txh'), [], 'replayed: the create did NOT run again');
        // an error is cached too: the same key replays the failure even though the retry would now succeed
        const bad = [{ op: 'create', collection: 'txh', fields: { id: 'h2' } }, { op: 'create', collection: 'txh', fields: { id: 'h2' } }];
        const e1 = await tx(bad, KEY_A, { 'Idempotency-Key': 'k-bad' });
        assert.equal(e1.status, 409);
        const e2 = await tx(ops, KEY_A, { 'Idempotency-Key': 'k-bad' });
        assert.equal(e2.status, 409, 'replayed failure, not a fresh run');
        assert.equal((await tx(ops, KEY_A, { 'Idempotency-Key': 'k-bad-retry' })).status, 200, 'a NEW key runs');
        // keys are per workspace
        assert.equal((await tx(ops, KEY_B, { 'Idempotency-Key': 'k-ok' })).status, 200);
        // empty / oversize keys are not used for replay
        await tx([{ op: 'delete', collection: 'txh', filter: F('id', 'eq', 'h1') }]);
        const long = 'x'.repeat(129);
        assert.equal((await tx(ops, KEY_A, { 'Idempotency-Key': long })).status, 200);
        await tx([{ op: 'delete', collection: 'txh', filter: F('id', 'eq', 'h1') }]);
        assert.equal((await tx(ops, KEY_A, { 'Idempotency-Key': long })).status, 200, '>128 chars: no replay, runs again');
        assert.ok(mock.requests.some((q) => q.idempotencyKey === 'k-ok'), 'requests log records the key');
    });

    await test('D7-6 options.transactions=false models an engine without the route: plain 404', async () => {
        mock.options.transactions = false;
        try {
            const r = await tx([{ op: 'create', collection: 'txi', fields: { id: 'i' } }]);
            assert.equal(r.status, 404);
            assert.equal(r.json['error']['code'], 'ERR_NOT_FOUND');
            assert.deepEqual(await idsOf('txi'), []);
        } finally { mock.options.transactions = true; }
        assert.equal((await tx([{ op: 'create', collection: 'txi', fields: { id: 'i' } }])).status, 200);
    });

    await test('D7-6 a literal `transaction` route wins over a collection named "transaction" (POST /v1/:c)', async () => {
        const r = await tx([{ op: 'create', collection: 'txj', fields: { id: 'j' } }]);
        assert.equal(r.json['data']['committed'], true);
        assert.equal(mock.snapshot().tenants.find((t) => t.tenantId === 'ws-a')?.collections.some((c) => c.name === 'transaction'), false);
    });

    /* ── 9. per-route connector resolution (review C #1), SDK error shape (#5), old-engine fall-through (#4) ── */
    const withMock = async (o: MockDataplaneOptions, fn: (m: MockDataplane, call: (method: string, path: string, body?: unknown, hdr?: Record<string, string>) => Promise<{ status: number; json: J }>) => Promise<void>): Promise<void> => {
        const m = await startMockDataplane({ apiKeys: { kk: 'wk' }, ...o });
        const call = async (method: string, path: string, body?: unknown, hdr: Record<string, string> = {}) => {
            const res = await fetch(`${m.url}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer kk', ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) });
            const t = await res.text();
            return { status: res.status, json: (t ? JSON.parse(t) : {}) as J };
        };
        try { await fn(m, call); } finally { await m.close(); }
    };
    const tbl = { name: 'conn_t', fields: [{ name: 'id', type: 'string', primary_key: true }, { name: 'text', type: 'string' }] };

    await test('D7-9 DEFAULT_CONNECTOR unset: CRUD -> sqlite, keyword search -> postgresql, transaction -> postgresql, traverse -> surrealdb (handlers.rs:265-277, :5384, :5782, :2898)', async () => {
        await withMock({}, async (m, call) => {
            assert.equal((await call('POST', '/v1/schema', tbl)).status, 201);
            assert.equal((await call('POST', '/v1/conn_t', { id: 'a', text: 'hello apples' })).status, 201);
            const resolved = (path: string) => m.requests.filter((r) => r.path === path).map((r) => r.connector);
            assert.deepEqual(resolved('/v1/schema'), ['sqlite']);
            assert.deepEqual(resolved('/v1/conn_t'), ['sqlite']);
            // the row lives in sqlite only: postgresql never saw the table
            assert.deepEqual(m.connectorsWith('wk', 'conn_t'), ['sqlite']);
            const found = await call('POST', '/v1/conn_t/search', { query: 'apples' });
            assert.equal(found.json['data']['records'].length, 0, 'keyword search ran on postgresql, which has no such table data');
            assert.deepEqual(resolved('/v1/conn_t/search'), ['postgresql']);
            const t = await call('POST', '/v1/transaction', { operations: [{ op: 'create', collection: 'conn_t', fields: { id: 'b' } }] });
            assert.equal(t.status, 409);
            assert.equal(t.json['error']['code'], 'OP_FAILED');
            assert.match(t.json['error']['message'], /relation "conn_t" does not exist/);
            assert.deepEqual(resolved('/v1/transaction'), ['postgresql']);
            await call('POST', '/v1/conn_t/graph/traverse', { start_id: 'a', edge_collection: 'e', direction: 'out' });
            assert.deepEqual(resolved('/v1/conn_t/graph/traverse'), ['surrealdb']);
            assert.throws(() => m.rows('wk', 'conn_t', 'postgresql').length === 0 && (() => { throw new Error('x'); })(), /x/);
        });
    });

    await test('D7-9 an explicit connection (body field, or ?connection= for GET and /v1/transaction) beats DEFAULT_CONNECTOR, which beats the route default', async () => {
        await withMock({ defaultConnector: 'postgresql' }, async (m, call) => {
            await call('POST', '/v1/schema', { ...tbl, connection: 'arangodb' });
            await call('POST', '/v1/conn_t', { id: 'x', text: 't', connection: 'arangodb' });
            assert.deepEqual(m.connectorsWith('wk', 'conn_t'), ['arangodb']);
            assert.deepEqual(m.rows('wk', 'conn_t').map((r) => Object.keys(r).includes('connection')), [false], '`connection` is a request field, never a stored column');
            const g = await call('GET', '/v1/conn_t/x?connection=arangodb');
            assert.equal(g.json['data']['id'], 'x');
            const gMiss = await call('GET', '/v1/conn_t/x');
            assert.equal(gMiss.json['success'], false, 'no connection -> DEFAULT_CONNECTOR (postgresql): not there');
            // body `connection` is NOT read by GET / transaction, and ?connection= is not read by POST bodies
            const t = await call('POST', '/v1/transaction?connection=arangodb', { operations: [{ op: 'create', collection: 'conn_t', fields: { id: 'y' } }] });
            assert.equal(t.status, 200, JSON.stringify(t.json));
            assert.deepEqual(m.rows('wk', 'conn_t', 'arangodb').map((r) => r['id']).sort(), ['x', 'y']);
            assert.equal(m.requests.at(-1)!.connection, 'arangodb');
            assert.equal(m.requests.at(-1)!.connector, 'arangodb');
        });
    });

    await test('D7-9 unknown connector -> 503 ERR_CONNECTOR_NOT_FOUND; /v1/transaction on sqlite -> 501 UNSUPPORTED_CONNECTOR after validation, before any op', async () => {
        await withMock({ connectors: ['sqlite', 'postgresql'] }, async (m, call) => {
            const r = await call('POST', '/v1/schema', { ...tbl, connection: 'surrealdb' });
            assert.deepEqual([r.status, r.json['error']['code']], [503, 'ERR_CONNECTOR_NOT_FOUND']);
            assert.equal(r.json['error']['message'], "Connector 'surrealdb' not available in registry");
            await call('POST', '/v1/schema', { ...tbl, connection: 'sqlite' });
            const ops = [{ op: 'create', collection: 'conn_t', fields: { id: 'z' } }];
            const t = await call('POST', '/v1/transaction?connection=sqlite', { operations: ops });
            assert.deepEqual([t.status, t.json['error']['code']], [501, 'UNSUPPORTED_CONNECTOR']);
            assert.equal(t.json['error']['message'], "Connector 'sqlite' does not support atomic multi-collection writes. Supported in Phase 1: arangodb, postgresql.");
            assert.deepEqual(m.rows('wk', 'conn_t', 'sqlite'), [], 'nothing ran');
            const bad = await call('POST', '/v1/transaction?connection=sqlite', { operations: [] });
            assert.equal(bad.json['error']['code'], 'LIMIT_EXCEEDED', 'validation is answered before the connector is resolved');
            const nc = await call('POST', '/v1/transaction?connection=nope', { operations: ops });
            assert.deepEqual([nc.status, nc.json['error']['code']], [503, 'ERR_CONNECTOR_NOT_FOUND']);
        });
    });

    await test('D7-9 the mock client forwards `connection` where the real SDK does (body vs ?connection=) and raises GroundfloorError-shaped errors only', async () => {
        await withMock({}, async (m) => {
            const c = createMockDataplaneClient(m.url, 'kk');
            await c.createCollection('t', tbl, 'postgresql');
            await c.insert('t', 'conn_t', { id: 'a', text: 'apples' }, 'postgresql');
            await c.get('t', 'conn_t', 'a', 'postgresql');
            await c.getCollectionSchema('t', 'conn_t', 'postgresql');
            await c.query('t', 'conn_t', { filter: 'all' }, 'postgresql');
            await c.count('t', 'conn_t', undefined, 'postgresql');
            await c.search('conn_t', 'apples', { connection: 'postgresql' });
            await c.vector.search('t', 'conn_t', { vector: [1], connection: 'postgresql' }).catch(() => undefined);
            await c.graph.traverse('t', 'conn_t', { startId: 'a', edgeCollection: 'e', direction: 'out', connection: 'postgresql' }).catch(() => undefined);
            await c.transaction('t', [{ op: 'create', collection: 'conn_t', fields: { id: 'b' } }], { connection: 'postgresql' });
            const seen = m.requests.filter((r) => r.path !== '/health');
            assert.equal(seen.length, 10);
            assert.ok(seen.every((r) => r.connector === 'postgresql'), JSON.stringify(seen.map((r) => [r.path, r.connector])));
            const viaQuery = seen.filter((r) => r.method === 'GET' || r.path === '/v1/transaction');
            assert.equal(viaQuery.length, 3);
            assert.ok(viaQuery.every((r) => r.body['connection'] === undefined), 'GET / transaction carry it in the query string, not the body');
            assert.ok(seen.filter((r) => !viaQuery.includes(r)).every((r) => r.body['connection'] === 'postgresql'), 'every other call carries it in the body');
            // error shape: message + statusCode, no `code`, no `status`
            const err = await c.transaction('t', [{ op: 'create', collection: 'conn_t', fields: { id: 'b' } }], { connection: 'postgresql' }).catch((e: unknown) => e as Record<string, unknown>);
            assert.equal((err as { statusCode: number }).statusCode, 409);
            assert.equal('code' in (err as object), false, 'the real GroundfloorError has no `code`');
            assert.equal('status' in (err as object), false, 'nor `status`');
            assert.match(String((err as unknown as Error).message), /^Query error: op 0: create conn_t failed/);
        });
    });

    await test('D7-9 IN_FLIGHT: a concurrent duplicate Idempotency-Key is 409 {code IN_FLIGHT} and NOT cached; the real SDK exposes only the message + 409', async () => {
        await withMock({ defaultConnector: 'postgresql' }, async (m, call) => {
            await call('POST', '/v1/schema', tbl);
            const ops = [{ op: 'create', collection: 'conn_t', fields: { id: 'f1' } }];
            const release = m.holdInFlight('wk', 'k-flight');
            const r = await call('POST', '/v1/transaction', { operations: ops }, { 'Idempotency-Key': 'k-flight' });
            assert.deepEqual([r.status, r.json['error']['code']], [409, 'IN_FLIGHT']);
            assert.match(r.json['error']['message'], /still in flight/);
            release();
            const again = await call('POST', '/v1/transaction', { operations: ops }, { 'Idempotency-Key': 'k-flight' });
            assert.equal(again.status, 200, 'the IN_FLIGHT answer was not cached');
            const c = createMockDataplaneClient(m.url, 'kk');
            const hold = m.holdInFlight('wk', 'k-flight2');
            const e = await c.transaction('t', ops, { idempotencyKey: 'k-flight2' }).catch((x: unknown) => x as Record<string, unknown>);
            hold();
            assert.equal((e as { statusCode: number }).statusCode, 409);
            assert.equal((e as { code?: string }).code, undefined);
            assert.match(String((e as unknown as Error).message), /still in flight/);
        });
    });

    await test("D7-9 transactions:'fallthrough' (old engine): POST /v1/transaction is the single-record create of a collection named \"transaction\" - 201, a record, no `committed`", async () => {
        await withMock({ transactions: 'fallthrough' }, async (m, call) => {
            const r = await call('POST', '/v1/transaction', { operations: [{ op: 'create', collection: 'conn_t', fields: { id: 'q' } }] });
            assert.equal(r.status, 201);
            assert.equal(r.json['committed'], undefined);
            assert.equal(m.rows('wk', 'transaction').length, 1, 'stored as a plain record');
            assert.deepEqual(m.rows('wk', 'conn_t'), [], 'none of the ops ran');
            const c = createMockDataplaneClient(m.url, 'kk');
            const res = await c.transaction('t', [{ op: 'create', collection: 'conn_t', fields: { id: 'q' } }], {});
            assert.equal((res as unknown as { committed?: boolean }).committed, undefined, 'the SDK hands back the record unchanged (data ?? result)');
        });
    });

    /* ── misc: request log / snapshot ─────────────────────────── */
    await test('requests log and snapshot shape', async () => {
        assert.ok(mock.requests.length > 20);
        assert.ok(mock.requests.some((r) => r.workspace === 'ws-b'));
        assert.ok(mock.requests.some((r) => r.workspace === null), 'the 401s are recorded with workspace null');
        const snap = mock.snapshot();
        assert.ok(Array.isArray(snap.tenants));
        assert.ok(snap.tenants.every((t) => typeof t.tenantId === 'string' && t.collections.every((c) => typeof c.count === 'number')));
    });
} finally {
    await mock.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
