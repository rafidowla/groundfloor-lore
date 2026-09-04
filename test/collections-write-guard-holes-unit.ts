#!/usr/bin/env tsx
/**
 * test/collections-write-guard-holes-unit.ts — F-COL5 regression suite.
 *
 * The unscoped-write guard (`assertScopedOrAllOptIn` → `isAllFilter` in
 * mcp/tools/collections.ts) treated EVERY `not` node as scoped, on the
 * reasoning that "negating an all-filter matches nothing". That holds for
 * every leaf except one: `in: {field: []}` compiles to the constant FALSE
 * `0 = 1` (engines/whereClause.ts), so `{not:{in:{id:[]}}}` compiles to
 * `WHERE NOT (0 = 1)` — TRUE for every row — and wiped a whole collection
 * through collection_update / collection_delete and their REST routes with
 * no `all: true` and no truncate.
 *
 * This file drives the whole probe table from the 2026-09-03 audit against
 * a REAL SqliteTableStorage (not the in-memory fake — the hole only exists
 * once a filter reaches the SQL compiler), through:
 *   - handleUpdate / handleDelete / handleDeleteByQuery directly, and
 *   - the REST routes PUT /v1/{c}, DELETE /v1/{c}, DELETE /v1/{c}/delete-by-query.
 *
 * It also covers the SQL well-formedness half: an empty leaf inside a
 * boolean node used to emit `()` / `( OR "id" = ?)`.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import {
    handleCreateCollection,
    handleUpdate,
    handleDelete,
    handleDeleteByQuery,
    handleUpdateByQuery,
    classifyFilterScope,
    isAllFilter,
    type SdkCollectionSchema,
} from '../packages/lore/src/mcp/tools/collections.js';
import { MAX_FILTER_NESTING } from '../packages/lore/src/engines/collectionStorage.js';
import { tryCollectionsRoutes } from '../packages/lore/src/mcp/http/routes/collections.js';
import { buildSqliteWhere } from '../packages/lore/src/engines/whereClause.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { FilterNode } from '../packages/lore/src/engines/collectionStorage.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

const SDK_SCHEMA: SdkCollectionSchema = {
    name: 'orders',
    description: 'orders for the write-guard probe',
    fields: [
        { name: 'id', field_type: 'string', primary_key: true, required: true },
        { name: 'amount', field_type: 'integer' },
        { name: 'status', field_type: 'string' },
    ],
};

const SEED = [
    { id: 'r1', amount: 10, status: 'open' },
    { id: 'r2', amount: 20, status: 'open' },
    { id: 'r3', amount: 30, status: 'open' },
];

interface Fixture {
    store: SqliteTableStorage;
    remaining: () => Promise<number>;
    cleanup: () => void;
}

async function fixture(): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcol5-guard-'));
    const store = new SqliteTableStorage(
        path.join(dir, 'tables.sqlite'),
        path.join(dir, 'schemas.json'),
    );
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('orders', SEED.map(r => ({ ...r })));
    return {
        store,
        remaining: () => store.count('orders'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
    };
}

/* ------------------------------------------------------------------ */
/*  The probe table (audit 2026-09-03, finding 3)                      */
/* ------------------------------------------------------------------ */

/**
 * Tautologies BY CONSTRUCTION — they match every row of every table, so a
 * destructive op must refuse them without `all: true`. The three marked
 * HOLE wiped all three seed rows on the pre-fix build.
 */
/**
 * `restCode` — QA round-3 (2026-09-03, finding A3) made the REST mutate
 * routes run the filter through the now-`.strict()` `filterNodeZ` BEFORE the
 * handler's own ALL/INVALID classifier ever sees it (collectionsFilterSchema.ts).
 * An unrecognized top-level key (`foo`/`limit`/`ne` below — none of them are
 * eq/contains/startsWith/gt/gte/lt/lte/in/and/or/not) is now a validation
 * failure caught by that schema first, not a "no scoping key present" ALL
 * classification: REST now answers `filter_invalid` (naming the bad key) for
 * these three shapes specifically, a strictly MORE precise diagnosis than the
 * old `all_filter_refused` — the direct-handler-call tests below (which
 * bypass REST's zod layer entirely, exactly like an MCP call after schema
 * validation) still see the original ALL classification and are unaffected.
 */
const REFUSED_ALL: Array<{ label: string; filter: FilterNode; restCode?: 'all_filter_refused' | 'filter_invalid' }> = [
    { label: '{} (empty leaf)', filter: {} },
    { label: '{eq:{}}', filter: { eq: {} } },
    { label: '{foo:1} (unknown operator key)', filter: { foo: 1 } as unknown as FilterNode, restCode: 'filter_invalid' },
    { label: '{limit:10} (opts leaked into the filter slot)', filter: { limit: 10 } as unknown as FilterNode, restCode: 'filter_invalid' },
    { label: "{ne:{id:'x'}} (unsupported operator)", filter: { ne: { id: 'x' } } as unknown as FilterNode, restCode: 'filter_invalid' },
    // HOLE 1 — `not` over the one constant-false leaf.
    { label: 'HOLE {not:{in:{id:[]}}}', filter: { not: { in: { id: [] } } } },
    // HOLE 2 — same, wrapped in an `and` so the recursion has to reach it.
    { label: 'HOLE {not:{and:[{in:{id:[]}}]}}', filter: { not: { and: [{ in: { id: [] } }] } } },
    // HOLE 3 — one tautological branch makes the whole OR a tautology, even
    // though the sibling branch looks properly scoped.
    {
        label: "HOLE {or:[{eq:{id:'r1'}},{not:{in:{id:[]}}}]}",
        filter: { or: [{ eq: { id: 'r1' } }, { not: { in: { id: [] } } }] },
    },
    // Deeper nesting of the same shape — the classifier must not stop at
    // the first boolean level.
    {
        label: 'HOLE {and:[{or:[{not:{in:{id:[]}}}]}]}',
        filter: { and: [{ or: [{ not: { in: { id: [] } } }] }] },
    },
    // Double negation of an empty leaf: NOT(NOT(TRUE)) is TRUE.
    { label: '{not:{not:{eq:{}}}}', filter: { not: { not: { eq: {} } } } },
];

/**
 * Structurally invalid — the SQL compiler has no rendering for them and
 * throws. Refused at the guard so the caller gets a validation error
 * instead of a 500 that leaks an engine message.
 */
const REFUSED_INVALID: Array<{ label: string; filter: FilterNode }> = [
    { label: '{and:[]}', filter: { and: [] } },
    { label: '{or:[]}', filter: { or: [] } },
    { label: '{not:{and:[]}}', filter: { not: { and: [] } } },
    { label: '{or:[{eq:{id:\'r1\'}},{and:[]}]}', filter: { or: [{ eq: { id: 'r1' } }, { and: [] }] } },
];

/**
 * Contradictions — allowed through the guard (they cannot damage anything)
 * and must compile to valid SQL that touches zero rows.
 */
const ALLOWED_NONE: Array<{ label: string; filter: FilterNode }> = [
    { label: '{in:{id:[]}}', filter: { in: { id: [] } } },
    { label: '{not:{}}', filter: { not: {} } },
    { label: '{not:{eq:{}}}', filter: { not: { eq: {} } } },
    { label: "{and:[{eq:{id:'r1'}},{in:{id:[]}}]}", filter: { and: [{ eq: { id: 'r1' } }, { in: { id: [] } }] } },
];

/**
 * X-allrows (2026-09-03) — these match every seed row, but only because of
 * the DATA in this particular table: `id` happens to have no row called
 * 'nonexistent', and every id happens to sort above 0. The SYNTACTIC
 * classifier (`classifyFilterScope`) still answers SCOPED for all of these —
 * that half of the contract is unchanged, and is asserted directly below.
 * What changed: a cold verifier reproduced this as a live, 100% data-loss
 * hole (claim #3, <SCRATCH>/audit/dataloss/claim3-tautology.ts) — a caller
 * could wipe a whole collection via these exact shapes through
 * collection_delete/collection_update_by_query/delete-by-query/transaction
 * with NO all:true and NO refusal, because nothing downstream of the
 * syntactic classifier ever checked the filter against the table's real
 * data. The storage layer now runs a SECOND, data-aware check (the
 * COUNT(*)-vs-COUNT(*WHERE) comparison in
 * engines/sqliteTableTransaction.ts's `assertNotDataTautology`): a filter
 * that matches every row of a >1-row table is refused exactly like a
 * syntactic ALL filter, unless the caller passes `all: true`. These are no
 * longer "documented-allowed" — they're refused without `all:true` and
 * applied with it, same as an ALL filter.
 */
const DATA_TAUTOLOGY_SCOPED: Array<{ label: string; filter: FilterNode; expected: number }> = [
    { label: "{not:{eq:{id:'nonexistent'}}} — data-dependent", filter: { not: { eq: { id: 'nonexistent' } } }, expected: 3 },
    { label: '{gte:{id:0}} — data-dependent', filter: { gte: { id: 0 } }, expected: 3 },
];

/* ------------------------------------------------------------------ */
/*  Classifier                                                         */
/* ------------------------------------------------------------------ */

console.log('F-COL5 — collection write-guard holes');

test('classifyFilterScope: constant-false leaf makes a leaf NONE and its negation ALL', () => {
    assert.equal(classifyFilterScope({ in: { id: [] } }), 'NONE');
    assert.equal(classifyFilterScope({ not: { in: { id: [] } } }), 'ALL');
    assert.equal(classifyFilterScope({ not: { and: [{ in: { id: [] } }] } }), 'ALL');
    assert.equal(classifyFilterScope({ or: [{ eq: { id: 'r1' } }, { not: { in: { id: [] } } }] }), 'ALL');
});

test('classifyFilterScope: existing ALL/SCOPED answers are unchanged', () => {
    assert.equal(classifyFilterScope(undefined), 'ALL');
    assert.equal(classifyFilterScope({}), 'ALL');
    assert.equal(classifyFilterScope({ eq: {} }), 'ALL');
    assert.equal(classifyFilterScope({ eq: { id: 'a' } }), 'SCOPED');
    assert.equal(classifyFilterScope({ contains: { name: 'x' } }), 'SCOPED');
    assert.equal(classifyFilterScope({ contains: { name: '  ' } }), 'ALL'); // F-COL1
    assert.equal(classifyFilterScope({ and: [{ eq: { status: 'archived' } }, { eq: {} }] }), 'SCOPED');
    assert.equal(classifyFilterScope({ or: [{ eq: {} }] }), 'ALL');
    assert.equal(classifyFilterScope({ not: { eq: {} } }), 'NONE');
});

test('classifyFilterScope: branchless and/or and over-deep nesting are INVALID', () => {
    assert.equal(classifyFilterScope({ and: [] }), 'INVALID');
    assert.equal(classifyFilterScope({ or: [] }), 'INVALID');
    assert.equal(classifyFilterScope({ not: { or: [] } }), 'INVALID');
    // 10 levels of `not` — past MAX_FILTER_NESTING (8), same limit the
    // compiler enforces with filter_too_nested.
    let deep: FilterNode = { eq: { id: 'r1' } };
    for (let i = 0; i < 10; i++) deep = { not: deep };
    assert.equal(classifyFilterScope(deep), 'INVALID');
});

test('isAllFilter still answers the F-COL1/WP2 cases it always did', () => {
    assert.equal(isAllFilter(undefined), true);
    assert.equal(isAllFilter({}), true);
    assert.equal(isAllFilter({ eq: {} }), true);
    assert.equal(isAllFilter({ eq: { id: 'a' } }), false);
    assert.equal(isAllFilter({ or: [{ and: [{ eq: {} }] }] }), true);
    assert.equal(isAllFilter({ not: { eq: {} } }), false);
    // …and now catches the constant-false negation it used to miss.
    assert.equal(isAllFilter({ not: { in: { id: [] } } }), true);
});

/* ------------------------------------------------------------------ */
/*  handleUpdate / handleDelete — real SqliteTableStorage              */
/* ------------------------------------------------------------------ */

for (const { label, filter } of REFUSED_ALL) {
    test(`handleUpdate refuses ${label} and leaves every row intact`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleUpdate({ tableStorage: f.store }, 'orders', filter, { status: 'pwned' }),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 3);
            const rows = await f.store.query('orders');
            assert.ok(rows.every(r => r.status === 'open'), 'no row may be patched');
        } finally { f.cleanup(); }
    });

    test(`handleDelete refuses ${label} and leaves every row intact`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleDelete({ tableStorage: f.store }, 'orders', filter),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });

    test(`handleDeleteByQuery refuses ${label}`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleDeleteByQuery({ tableStorage: f.store }, 'orders', filter),
                /empty\/all filter|use truncate/i,
            );
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });

    // Round-E A3 — refuters flagged handleUpdateByQuery as an untested
    // caller of assertScopedOrAllOptIn (same guard as handleUpdate), so it
    // needs its own coverage of the REFUSED_ALL table, not just handleUpdate.
    test(`handleUpdateByQuery refuses ${label} and leaves every row intact`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleUpdateByQuery({ tableStorage: f.store }, 'orders', filter, { status: 'pwned' }),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 3);
            const rows = await f.store.query('orders');
            assert.ok(rows.every(r => r.status === 'open'), 'no row may be patched');
        } finally { f.cleanup(); }
    });
}

for (const { label, filter } of REFUSED_INVALID) {
    test(`handleUpdate refuses structurally invalid ${label} before the compiler`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleUpdate({ tableStorage: f.store }, 'orders', filter, { status: 'pwned' }),
                /structurally invalid filter/i,
            );
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });

    test(`handleDelete refuses structurally invalid ${label} even with all:true`, async () => {
        const f = await fixture();
        try {
            // all:true is an opt-in to an UNSCOPED delete, not to malformed
            // input — the shape still has no SQL rendering.
            await assert.rejects(
                () => handleDelete({ tableStorage: f.store }, 'orders', filter, true),
                /structurally invalid filter/i,
            );
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });

    // Round-E A3 — same coverage gap as above, for the INVALID table.
    test(`handleUpdateByQuery refuses structurally invalid ${label}`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleUpdateByQuery({ tableStorage: f.store }, 'orders', filter, { status: 'pwned' }),
                /structurally invalid filter/i,
            );
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });
}

/* ------------------------------------------------------------------ */
/*  Round-E A3 regression — INVALID must not be mistaken for ALL       */
/* ------------------------------------------------------------------ */

/**
 * The medium regression QA found in the merged fix: `assertValidFilter`'s
 * INVALID branch reused the ALL branch's "empty/all filter … use
 * collection_truncate to wipe" wording, so a filter that is INVALID only
 * because it nests past MAX_FILTER_NESTING — while still targeting exactly
 * one row — got the all-filter refusal message (and, over REST, the
 * `all_filter_refused` code + truncate advice). That is misleading: this
 * filter is not an all-filter at all, truncate is not the fix, and `all:
 * true` would not help either (the shape still has no SQL rendering).
 */
function nestAnd(depth: number, leaf: FilterNode): FilterNode {
    let f = leaf;
    for (let i = 0; i < depth; i++) f = { and: [f] };
    return f;
}

// One level past MAX_FILTER_NESTING (8), still wrapping a single-row `eq`.
const OVER_NESTED_SCOPED: FilterNode = nestAnd(MAX_FILTER_NESTING + 1, { eq: { id: 'r1' } });

test('classifyFilterScope: an over-nested single-row filter is INVALID, not ALL', () => {
    assert.equal(classifyFilterScope(OVER_NESTED_SCOPED), 'INVALID');
});

test('handleUpdate on an over-nested single-row filter throws a message with no all-filter/truncate advice', async () => {
    const f = await fixture();
    try {
        await assert.rejects(
            () => handleUpdate({ tableStorage: f.store }, 'orders', OVER_NESTED_SCOPED, { amount: 999 }),
            (err: unknown) => {
                const msg = (err as Error).message;
                assert.match(msg, /structurally invalid filter/i);
                assert.doesNotMatch(msg, /empty\/all filter/i);
                assert.doesNotMatch(msg, /truncate/i);
                assert.match(msg, /unrelated to whether the filter matches all rows/i);
                return true;
            },
        );
        assert.equal(await f.remaining(), 3);
        const row = await f.store.getByKey('orders', 'r1');
        assert.equal((row as { amount: number }).amount, 10, 'the targeted row must be untouched');
    } finally { f.cleanup(); }
});

test('REST PUT /v1/orders on an over-nested single-row filter answers 400 filter_invalid, not all_filter_refused', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'PUT',
            body: { filter: OVER_NESTED_SCOPED, updates: { amount: 999 } },
        });
        assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
        const body = r.body as { code: string; message: string };
        assert.equal(body.code, 'filter_invalid');
        assert.doesNotMatch(body.message, /all_filter_refused|empty\/all filter/i);
        assert.doesNotMatch(body.message, /truncate/i);
        assert.equal(await f.remaining(), 3);
        const rows = await f.store.query('orders');
        assert.ok(rows.every(x => x.status === 'open'), 'no row may be patched');
    } finally { await srv.close(); f.cleanup(); }
});

test('REST PUT /v1/orders/update-by-query on an over-nested single-row filter answers 400 filter_invalid', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
            method: 'PUT',
            body: { filter: OVER_NESTED_SCOPED, fields: { amount: 999 } },
        });
        assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
        const body = r.body as { code: string; message: string };
        assert.equal(body.code, 'filter_invalid');
        assert.doesNotMatch(body.message, /all_filter_refused|empty\/all filter/i);
        assert.doesNotMatch(body.message, /truncate/i);
        assert.equal(await f.remaining(), 3);
    } finally { await srv.close(); f.cleanup(); }
});

test('REST DELETE /v1/orders/delete-by-query on an over-nested single-row filter answers 400 filter_invalid', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
            method: 'DELETE',
            body: { filter: OVER_NESTED_SCOPED },
        });
        assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
        const body = r.body as { code: string; message: string };
        assert.equal(body.code, 'filter_invalid');
        assert.doesNotMatch(body.message, /all_filter_refused|empty\/all filter/i);
        assert.doesNotMatch(body.message, /truncate/i);
        assert.equal(await f.remaining(), 3);
    } finally { await srv.close(); f.cleanup(); }
});

test('the ALL shapes still answer 400 all_filter_refused over REST update-by-query', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
            method: 'PUT',
            body: { filter: {}, fields: { amount: 999 } },
        });
        assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'all_filter_refused');
        assert.equal(await f.remaining(), 3);
    } finally { await srv.close(); f.cleanup(); }
});

test('the empty and[]/or[] INVALID shapes still answer 400 filter_invalid over REST', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        for (const filter of [{ and: [] } as FilterNode, { or: [] } as FilterNode]) {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'DELETE', body: { filter } });
            assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal((r.body as { code: string }).code, 'filter_invalid');
        }
        assert.equal(await f.remaining(), 3);
    } finally { await srv.close(); f.cleanup(); }
});

for (const { label, filter } of ALLOWED_NONE) {
    test(`handleDelete passes contradiction ${label} through and deletes 0 rows`, async () => {
        const f = await fixture();
        try {
            const r = await handleDelete({ tableStorage: f.store }, 'orders', filter);
            assert.equal(r.deleted, 0);
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });
}

for (const { label, filter, expected } of DATA_TAUTOLOGY_SCOPED) {
    test(`classifyFilterScope still answers SCOPED for ${label} (syntactic half of the contract is unchanged)`, () => {
        assert.equal(classifyFilterScope(filter), 'SCOPED');
    });

    test(`handleUpdate REFUSES ${label} without all:true (X-allrows: SCOPED-by-construction but ALL-by-data)`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(
                () => handleUpdate({ tableStorage: f.store }, 'orders', filter, { status: 'touched' }),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 3);
            const rows = await f.store.query('orders');
            assert.ok(rows.every(r => r.status === 'open'), 'no row may be patched');
        } finally { f.cleanup(); }
    });

    test(`handleUpdate applies ${label} with all:true`, async () => {
        const f = await fixture();
        try {
            const r = await handleUpdate({ tableStorage: f.store }, 'orders', filter, { status: 'touched' }, true);
            assert.equal(r.updated, expected);
        } finally { f.cleanup(); }
    });
}

test('handleUpdate still performs a genuinely scoped update', async () => {
    const f = await fixture();
    try {
        const r = await handleUpdate({ tableStorage: f.store }, 'orders', { eq: { id: 'r2' } }, { status: 'closed' });
        assert.equal(r.updated, 1);
        assert.equal(await f.remaining(), 3);
    } finally { f.cleanup(); }
});

test('all:true still authorises a real unscoped delete', async () => {
    const f = await fixture();
    try {
        const r = await handleDelete({ tableStorage: f.store }, 'orders', { not: { in: { id: [] } } }, true);
        assert.equal(r.deleted, 3);
        assert.equal(await f.remaining(), 0);
    } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  SQL well-formedness: empty leaf inside a boolean node              */
/* ------------------------------------------------------------------ */

test('an empty leaf inside or/and compiles to valid SQL, not `( OR ...)` / `()`', () => {
    const or = buildSqliteWhere({ or: [{ eq: {} }, { eq: { id: 'r1' } }] });
    assert.equal(or.where, 'WHERE (1 = 1 OR "id" = ?)');
    assert.equal(or.params.length, 1);
    const and = buildSqliteWhere({ and: [{ eq: {} }] });
    assert.equal(and.where, 'WHERE (1 = 1)');
    // `{not:{}}` and `{not:{and:[{eq:{}}]}}` are the same filter and now
    // compile the same way instead of one throwing.
    assert.equal(buildSqliteWhere({ not: {} }).where, 'WHERE NOT (1 = 1)');
    assert.equal(buildSqliteWhere({ not: { and: [{ eq: {} }] } }).where, 'WHERE NOT ((1 = 1))');
    // A bare empty leaf still yields NO where clause — the engine's own
    // update/delete backstop depends on that to refuse an unscoped write.
    assert.equal(buildSqliteWhere({}).where, '');
    assert.equal(buildSqliteWhere({ eq: {} }).where, '');
});

test('all:true + an empty leaf inside `or` executes instead of producing malformed SQL', async () => {
    const f = await fixture();
    try {
        const r = await handleUpdate(
            { tableStorage: f.store }, 'orders',
            { or: [{ eq: {} }, { eq: { id: 'r1' } }] }, { status: 'bulk' }, true,
        );
        assert.equal(r.updated, 3);
        const rows = await f.store.query('orders');
        assert.ok(rows.every(x => x.status === 'bulk'));
    } finally { f.cleanup(); }
});

test('all:true + an empty leaf inside `and` executes instead of producing malformed SQL', async () => {
    const f = await fixture();
    try {
        const r = await handleDelete({ tableStorage: f.store }, 'orders', { and: [{ eq: {} }] }, true);
        assert.equal(r.deleted, 3);
    } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  REST routes — same shapes, same refusals                           */
/* ------------------------------------------------------------------ */

async function startServer(store: SqliteTableStorage): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await tryCollectionsRoutes(req, res, url, pathname, { tableStorage: store });
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'unhandled' }));
        }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
    };
}

async function fetchJson(url: string, init: { method: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
    const res = await fetch(url, {
        method: init.method,
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

/**
 * Round-E A3 — REFUSED_ALL and REFUSED_INVALID used to share one assertion
 * (`code === 'all_filter_refused'`), which is exactly the regression QA
 * found: it could not have caught INVALID silently getting the ALL code,
 * because it demanded that very code. Each table now asserts its OWN code
 * (`all_filter_refused` vs `filter_invalid`), so a future regression that
 * conflates the two fails here again.
 */
function restRefusalSuite(
    tableName: string,
    table: Array<{ label: string; filter: FilterNode; restCode?: 'all_filter_refused' | 'filter_invalid' }>,
    defaultExpectedCode: 'all_filter_refused' | 'filter_invalid',
) {
    for (const { label, filter, restCode } of table) {
        const expectedCode = restCode ?? defaultExpectedCode;
        test(`REST PUT /v1/orders refuses ${tableName} ${label} with 400 ${expectedCode}`, async () => {
            const f = await fixture();
            const srv = await startServer(f.store);
            try {
                const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
                    method: 'PUT',
                    body: { filter, updates: { status: 'pwned' } },
                });
                assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
                assert.equal((r.body as { code: string }).code, expectedCode);
                assert.equal(await f.remaining(), 3);
                const rows = await f.store.query('orders');
                assert.ok(rows.every(x => x.status === 'open'));
            } finally { await srv.close(); f.cleanup(); }
        });

        test(`REST DELETE /v1/orders refuses ${tableName} ${label} with 400 ${expectedCode}`, async () => {
            const f = await fixture();
            const srv = await startServer(f.store);
            try {
                const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'DELETE', body: { filter } });
                assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
                assert.equal((r.body as { code: string }).code, expectedCode);
                assert.equal(await f.remaining(), 3);
            } finally { await srv.close(); f.cleanup(); }
        });

        test(`REST DELETE /v1/orders/delete-by-query refuses ${tableName} ${label} with 400 ${expectedCode}`, async () => {
            const f = await fixture();
            const srv = await startServer(f.store);
            try {
                const r = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
                    method: 'DELETE',
                    body: { filter },
                });
                assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
                assert.equal((r.body as { code: string }).code, expectedCode);
                assert.equal(await f.remaining(), 3);
            } finally { await srv.close(); f.cleanup(); }
        });

        // Round-E A3 — handleUpdateByQuery's REST route (PUT .../update-by-query)
        // is the other coverage gap the refuters noted; drive it through the
        // same HOLE shapes as the other three routes above.
        test(`REST PUT /v1/orders/update-by-query refuses ${tableName} ${label} with 400 ${expectedCode}`, async () => {
            const f = await fixture();
            const srv = await startServer(f.store);
            try {
                const r = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
                    method: 'PUT',
                    body: { filter, fields: { status: 'pwned' } },
                });
                assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
                assert.equal((r.body as { code: string }).code, expectedCode);
                assert.equal(await f.remaining(), 3);
                const rows = await f.store.query('orders');
                assert.ok(rows.every(x => x.status === 'open'));
            } finally { await srv.close(); f.cleanup(); }
        });
    }
}

restRefusalSuite('ALL', REFUSED_ALL, 'all_filter_refused');
restRefusalSuite('INVALID', REFUSED_INVALID, 'filter_invalid');

test('REST DELETE /v1/orders still performs a scoped delete', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'DELETE',
            body: { filter: { eq: { id: 'r1' } } },
        });
        assert.equal(r.status, 200);
        assert.equal((r.body as { deleted: number }).deleted, 1);
        assert.equal(await f.remaining(), 2);
    } finally { await srv.close(); f.cleanup(); }
});

test('REST bare PUT/DELETE /v1/{collection} has no `all` escape hatch — the routes never forward it', async () => {
    // X-allrows (2026-09-03) — the bare PUT/DELETE routes still never read
    // `body.all`, unchanged. That's deliberate, not a gap this fix widens:
    // only update-by-query/delete-by-query/transaction gained the all:true
    // opt-in (see the X-allrows suite below), same as before this fix.
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'DELETE',
            body: { filter: { not: { in: { id: [] } } }, all: true },
        });
        assert.equal(r.status, 400);
        assert.equal(await f.remaining(), 3);
    } finally { await srv.close(); f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  X-allrows (2026-09-03) — second, data-aware layer of the guard      */
/*                                                                      */
/*  claim #3 (re-opened by a cold verifier, reproduced live 100%):     */
/*  {gte:{id:0}}, {lte:{id:huge}}, {not:{eq:{id:-N}}} all classify      */
/*  SCOPED (unchanged — asserted below), but against a real table where */
/*  every row's id happens to satisfy the filter, that SCOPED           */
/*  classification let a caller wipe the whole collection through       */
/*  collection_delete / collection_update_by_query / delete-by-query /  */
/*  transaction with NO all:true and NO refusal. The fix adds a SECOND, */
/*  data-aware check at the storage layer (COUNT(*) vs COUNT(*WHERE) in */
/*  the SAME SQL transaction, engines/sqliteTableTransaction.ts) that    */
/*  refuses a >1-row table whose filter matches every row, unless the   */
/*  caller passes all:true — mirroring on EVERY surface (direct         */
/*  handlers, REST update-by-query/delete-by-query, and                 */
/*  POST /v1/transaction) exactly the escape hatch collection_update/    */
/*  collection_delete already had for the syntactic ALL case.           */
/* ------------------------------------------------------------------ */

const METRICS_SCHEMA: SdkCollectionSchema = {
    name: 'metrics',
    fields: [
        { name: 'id', field_type: 'integer', primary_key: true, required: true },
        { name: 'note', field_type: 'string' },
    ],
};

interface MetricsFixture {
    store: SqliteTableStorage;
    remaining: () => Promise<number>;
    cleanup: () => void;
}

async function metricsFixture(rowCount: number): Promise<MetricsFixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-allrows-metrics-'));
    const store = new SqliteTableStorage(path.join(dir, 'tables.sqlite'), path.join(dir, 'schemas.json'));
    await handleCreateCollection({ tableStorage: store }, METRICS_SCHEMA);
    const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i + 1, note: `row-${i + 1}` }));
    await store.insertBatch('metrics', rows);
    return {
        store,
        remaining: () => store.count('metrics'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
    };
}

/**
 * The exact three shapes claim #3 reproduced live, on a 5-row table.
 * `leaf: false` marks `{not:{eq:...}}` — `collection_transaction`/
 * POST /v1/transaction's filter schema is deliberately leaf-only (no
 * and/or/not; see collectionsTransaction.ts's file header), so that shape
 * is rejected by zod as `filter_invalid` before it ever reaches a
 * transaction op's storage call — a different, pre-existing refusal this
 * fix doesn't touch. The transaction sub-tests below only run for the
 * leaf-compatible shapes.
 */
const ALLROWS_TAUTOLOGIES: Array<{ label: string; filter: FilterNode; leaf: boolean }> = [
    { label: '{gte:{id:0}}', filter: { gte: { id: 0 } }, leaf: true },
    { label: '{lte:{id:999999999}}', filter: { lte: { id: 999999999 } }, leaf: true },
    { label: '{not:{eq:{id:-999999}}}', filter: { not: { eq: { id: -999999 } } }, leaf: false },
];

for (const { label, filter, leaf } of ALLROWS_TAUTOLOGIES) {
    test(`X-allrows classifyFilterScope: ${label} is SCOPED, not ALL (syntactic contract is unchanged)`, () => {
        assert.equal(classifyFilterScope(filter), 'SCOPED');
    });

    /* ---- direct handlers (the 4 MCP-tool-backing functions) ---- */

    test(`X-allrows handleUpdate refuses ${label} on a 5-row table without all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            await assert.rejects(
                () => handleUpdate({ tableStorage: f.store }, 'metrics', filter, { note: 'pwned' }),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 5);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleUpdate applies ${label} on a 5-row table with all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            const r = await handleUpdate({ tableStorage: f.store }, 'metrics', filter, { note: 'ok' }, true);
            assert.equal(r.updated, 5);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleDelete refuses ${label} on a 5-row table without all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            await assert.rejects(
                () => handleDelete({ tableStorage: f.store }, 'metrics', filter),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 5);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleDelete applies ${label} on a 5-row table with all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            const r = await handleDelete({ tableStorage: f.store }, 'metrics', filter, true);
            assert.equal(r.deleted, 5);
            assert.equal(await f.remaining(), 0);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleUpdateByQuery refuses ${label} on a 5-row table without all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            await assert.rejects(
                () => handleUpdateByQuery({ tableStorage: f.store }, 'metrics', filter, { note: 'pwned' }),
                /empty\/all filter/i,
            );
            assert.equal(await f.remaining(), 5);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleUpdateByQuery applies ${label} on a 5-row table with all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            const r = await handleUpdateByQuery({ tableStorage: f.store }, 'metrics', filter, { note: 'ok' }, true);
            assert.equal(r.updated, 5);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleDeleteByQuery refuses ${label} on a 5-row table without all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            await assert.rejects(
                () => handleDeleteByQuery({ tableStorage: f.store }, 'metrics', filter),
                /empty\/all filter|use truncate/i,
            );
            assert.equal(await f.remaining(), 5);
        } finally { f.cleanup(); }
    });

    test(`X-allrows handleDeleteByQuery applies ${label} on a 5-row table with all:true`, async () => {
        const f = await metricsFixture(5);
        try {
            const r = await handleDeleteByQuery({ tableStorage: f.store }, 'metrics', filter, true);
            assert.equal(r.deleted, 5);
            assert.equal(await f.remaining(), 0);
        } finally { f.cleanup(); }
    });

    /* ---- REST bare PUT/DELETE: still no all:true — always refused ---- */

    test(`X-allrows REST PUT /v1/metrics refuses ${label} on a 5-row table (bare route has no all:true escape hatch)`, async () => {
        const f = await metricsFixture(5);
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/metrics`, {
                method: 'PUT',
                body: { filter, updates: { note: 'pwned' } },
            });
            assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal((r.body as { code: string }).code, 'all_filter_refused');
            assert.equal(await f.remaining(), 5);
        } finally { await srv.close(); f.cleanup(); }
    });

    test(`X-allrows REST DELETE /v1/metrics refuses ${label} on a 5-row table (bare route has no all:true escape hatch)`, async () => {
        const f = await metricsFixture(5);
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/metrics`, { method: 'DELETE', body: { filter } });
            assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal((r.body as { code: string }).code, 'all_filter_refused');
            assert.equal(await f.remaining(), 5);
        } finally { await srv.close(); f.cleanup(); }
    });

    /* ---- REST update-by-query / delete-by-query — the live repro surface ---- */

    test(`X-allrows REST PUT /v1/metrics/update-by-query refuses ${label} on a 5-row table without all:true`, async () => {
        const f = await metricsFixture(5);
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/metrics/update-by-query`, {
                method: 'PUT',
                body: { filter, fields: { note: 'pwned' } },
            });
            assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal((r.body as { code: string }).code, 'all_filter_refused');
            assert.equal(await f.remaining(), 5);
        } finally { await srv.close(); f.cleanup(); }
    });

    test(`X-allrows REST PUT /v1/metrics/update-by-query applies ${label} on a 5-row table with all:true`, async () => {
        const f = await metricsFixture(5);
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/metrics/update-by-query`, {
                method: 'PUT',
                body: { filter, fields: { note: 'ok' }, all: true },
            });
            assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal((r.body as { success: boolean; data: { updated: number } }).data.updated, 5);
        } finally { await srv.close(); f.cleanup(); }
    });

    // The EXACT live repro from <SCRATCH>/audit/dataloss/claim3-tautology.ts:
    // DELETE /v1/{c}/delete-by-query never offered an all:true field at all,
    // so this shape wiped the table with status 200 and no refusal, pre-fix.
    test(`X-allrows REST DELETE /v1/metrics/delete-by-query refuses ${label} on a 5-row table without all:true (the live repro)`, async () => {
        const f = await metricsFixture(5);
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/metrics/delete-by-query`, {
                method: 'DELETE',
                body: { filter },
            });
            assert.equal(
                r.status, 400,
                `expected 400, got ${r.status} ${JSON.stringify(r.body)} -- pre-fix this wiped the table with status 200`,
            );
            assert.equal((r.body as { code: string }).code, 'all_filter_refused');
            assert.equal(await f.remaining(), 5, 'the table must survive');
        } finally { await srv.close(); f.cleanup(); }
    });

    test(`X-allrows REST DELETE /v1/metrics/delete-by-query applies ${label} on a 5-row table with all:true`, async () => {
        const f = await metricsFixture(5);
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/metrics/delete-by-query`, {
                method: 'DELETE',
                body: { filter, all: true },
            });
            assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal((r.body as { success: boolean; data: { deleted: number } }).data.deleted, 5);
            assert.equal(await f.remaining(), 0);
        } finally { await srv.close(); f.cleanup(); }
    });

    /* ---- POST /v1/transaction (leaf-compatible shapes only — see `leaf` doc above) ---- */

    if (leaf) {
        test(`X-allrows REST POST /v1/transaction refuses a delete op with ${label} on a 5-row table without all:true`, async () => {
            const f = await metricsFixture(5);
            const srv = await startServer(f.store);
            try {
                const r = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
                    method: 'POST',
                    body: { operations: [{ op: 'delete', collection: 'metrics', filter }] },
                });
                assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
                assert.equal((r.body as { code: string }).code, 'all_filter_refused');
                assert.equal(await f.remaining(), 5);
            } finally { await srv.close(); f.cleanup(); }
        });

        test(`X-allrows REST POST /v1/transaction applies a delete op with ${label} on a 5-row table with all:true`, async () => {
            const f = await metricsFixture(5);
            const srv = await startServer(f.store);
            try {
                const r = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
                    method: 'POST',
                    body: { operations: [{ op: 'delete', collection: 'metrics', filter, all: true }] },
                });
                assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
                assert.equal(await f.remaining(), 0);
            } finally { await srv.close(); f.cleanup(); }
        });
    }
}

/* ---- boundary cases named explicitly by the finding ---- */

test('X-allrows: a filter matching 4 of 5 rows is genuinely scoped and applies without all:true', async () => {
    const f = await metricsFixture(5);
    try {
        const r = await handleDelete({ tableStorage: f.store }, 'metrics', { gte: { id: 2 } });
        assert.equal(r.deleted, 4);
        assert.equal(await f.remaining(), 1);
    } finally { f.cleanup(); }
});

test('X-allrows: a 1-row table matching its one row is legitimately scoped and applies without all:true', async () => {
    const f = await metricsFixture(1);
    try {
        const r = await handleDelete({ tableStorage: f.store }, 'metrics', { gte: { id: 0 } });
        assert.equal(r.deleted, 1);
        assert.equal(await f.remaining(), 0);
    } finally { f.cleanup(); }
});

test('X-allrows: an empty (0-row) table matching a data-tautology filter applies without all:true (nothing to lose)', async () => {
    const f = await metricsFixture(0);
    try {
        const r = await handleDelete({ tableStorage: f.store }, 'metrics', { gte: { id: 0 } });
        assert.equal(r.deleted, 0);
    } finally { f.cleanup(); }
});

test('X-allrows: a legit range that happens to match all rows still applies with all:true', async () => {
    const f = await metricsFixture(5);
    try {
        // {gte:{id:1}} is a normal "id >= 1" range that happens to match every
        // row of THIS 5-row table (ids 1..5) — same data-tautology shape as
        // the ALLROWS_TAUTOLOGIES above, still needs all:true, and all:true
        // still works.
        const r = await handleUpdate({ tableStorage: f.store }, 'metrics', { gte: { id: 1 } }, { note: 'bulk' }, true);
        assert.equal(r.updated, 5);
    } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Round-S fix (2026-09-04) — literal empty filter + all:true          */
/* ------------------------------------------------------------------ */
/**
 * QA smoke finding (round S, <SCRATCH>/audit/smoke-final/07-collections.mjs,
 * 11-schema-delete.mjs) — `DELETE /v1/{c}/delete-by-query` with an EMPTY
 * filter and no `all:true` correctly answered 400 `all_filter_refused`
 * promising "pass all:true to confirm, or use truncate". Setting `all:true`
 * STILL answered 400 `all_filter_refused`, but from a DIFFERENT message —
 * `SqliteTableStorage.delete`'s own hard-coded empty-WHERE guard — which
 * never checked `opts.all` at all. `assertScopedOrAllOptIn`,
 * `handleDeleteByQuery`, and the transaction op guard
 * (collectionsTransaction.ts) all promise `all:true` works for an ALL-scope
 * filter; `classifyFilterScope` treats a bare `{}`/`{eq:{}}` the same as
 * every other ALL shape. Only the storage layer's OWN empty-WHERE branch
 * (engines/sqliteTableTransaction.ts) disagreed by never honoring the flag
 * — every OTHER ALL shape (`{not:{in:{id:[]}}}`, `{and:[{eq:{}}]}`, a
 * data-tautological `{gte:{id:0}}`, …) already worked with `all:true`
 * (see the tests above). Fixed by making the empty-WHERE guard check
 * `opts.all` exactly like `assertNotDataTautology` does one branch down.
 */
for (const { label, filter } of [{ label: '{} (empty leaf)', filter: {} as FilterNode }, { label: '{eq:{}}', filter: { eq: {} } as FilterNode }]) {
    test(`Round-S handleDelete applies literal ${label} with all:true (was refused even with all:true)`, async () => {
        const f = await fixture();
        try {
            const r = await handleDelete({ tableStorage: f.store }, 'orders', filter, true);
            assert.equal(r.deleted, 3);
            assert.equal(await f.remaining(), 0);
        } finally { f.cleanup(); }
    });

    test(`Round-S handleUpdate applies literal ${label} with all:true (was refused even with all:true)`, async () => {
        const f = await fixture();
        try {
            const r = await handleUpdate({ tableStorage: f.store }, 'orders', filter, { status: 'bulk' }, true);
            assert.equal(r.updated, 3);
            const rows = await f.store.query('orders');
            assert.ok(rows.every(x => x.status === 'bulk'));
        } finally { f.cleanup(); }
    });

    test(`Round-S handleDeleteByQuery applies literal ${label} with all:true — the exact live repro`, async () => {
        const f = await fixture();
        try {
            const r = await handleDeleteByQuery({ tableStorage: f.store }, 'orders', filter, true);
            assert.equal(r.deleted, 3);
            assert.equal(await f.remaining(), 0);
        } finally { f.cleanup(); }
    });

    test(`Round-S handleUpdateByQuery applies literal ${label} with all:true`, async () => {
        const f = await fixture();
        try {
            const r = await handleUpdateByQuery({ tableStorage: f.store }, 'orders', filter, { status: 'bulk' }, true);
            assert.equal(r.updated, 3);
        } finally { f.cleanup(); }
    });

    test(`Round-S handleDelete/handleUpdate STILL refuse literal ${label} without all:true`, async () => {
        const f = await fixture();
        try {
            await assert.rejects(() => handleDelete({ tableStorage: f.store }, 'orders', filter), /empty\/all filter/i);
            await assert.rejects(() => handleUpdate({ tableStorage: f.store }, 'orders', filter, { status: 'x' }), /empty\/all filter/i);
            assert.equal(await f.remaining(), 3);
        } finally { f.cleanup(); }
    });
}

test('Round-S REST DELETE /v1/orders/delete-by-query with empty filter + all:true wipes the collection (the exact smoke repro)', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const refused = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
            method: 'DELETE',
            body: { filter: {} },
        });
        assert.equal(refused.status, 400);
        assert.equal((refused.body as { code: string }).code, 'all_filter_refused');
        assert.equal(await f.remaining(), 3);

        const confirmed = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
            method: 'DELETE',
            body: { filter: {}, all: true },
        });
        assert.equal(
            confirmed.status, 200,
            `expected 200, got ${confirmed.status} ${JSON.stringify(confirmed.body)} -- pre-fix this stayed 400 even with all:true`,
        );
        assert.equal((confirmed.body as { success: boolean; data: { deleted: number } }).data.deleted, 3);
        assert.equal(await f.remaining(), 0);
    } finally { await srv.close(); f.cleanup(); }
});

test('Round-S REST PUT /v1/orders/update-by-query with empty filter + all:true updates every row', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const confirmed = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
            method: 'PUT',
            body: { filter: {}, fields: { status: 'bulk' }, all: true },
        });
        assert.equal(confirmed.status, 200, `expected 200, got ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
        assert.equal((confirmed.body as { success: boolean; data: { updated: number } }).data.updated, 3);
    } finally { await srv.close(); f.cleanup(); }
});

test('Round-S REST POST /v1/transaction delete op with empty filter + all:true wipes the collection', async () => {
    const f = await fixture();
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: { operations: [{ op: 'delete', collection: 'orders', filter: {}, all: true }] },
        });
        assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(await f.remaining(), 0);
    } finally { await srv.close(); f.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
