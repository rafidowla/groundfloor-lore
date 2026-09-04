#!/usr/bin/env tsx
/**
 * test/collections-routes-unit.ts — Phase 2 item 5 tests.
 *
 * Verifies each `/v1/{collection}` REST route end-to-end against an
 * in-memory ITableStorage stub: URL parsing, HTTP method routing,
 * status codes, JSON body shapes. Auth/Host/Origin enforcement is
 * upstream of this file (httpAuth.ts) and tested separately.
 *
 * Uses raw IncomingMessage / ServerResponse stand-ins built on
 * Node's http module so we can drive the route through realistic
 * stream events without spinning up a real server.
 */

import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { tryCollectionsRoutes } from '../packages/lore/src/mcp/http/routes/collections.js';
import {
    DEFAULT_SCHEMA_LIST_LIMIT,
    MAX_SCHEMA_LIST_LIMIT,
} from '../packages/lore/src/mcp/tools/collections.js';
import type {
    ITableStorage,
    JoinQuery,
    ListTablesOptions,
    Row,
    TableOp,
    TableOpResult,
    TableSchema,
    TableSchemaSummary,
} from '../packages/lore/src/contracts/tables.js';
import type { Filter, FilterNode, FindOptions } from '../packages/lore/src/engines/collectionStorage.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/* ---------- in-memory ITableStorage (same shape as collections-tools-unit) ---------- */

class FakeTableStorage implements ITableStorage {
    public schemas = new Map<string, TableSchema>();
    private rows = new Map<string, Map<unknown, Row>>();

    capabilities() {
        return {
            join: false,
            caseSensitiveContains: false,
            extractedJsonFields: false,
            additiveSchemaEvolution: false,
        };
    }
    async createTable(schema: TableSchema): Promise<void> {
        this.schemas.set(schema.name, schema);
        if (!this.rows.has(schema.name)) this.rows.set(schema.name, new Map());
    }
    async listTables(opts: ListTablesOptions = {}): Promise<TableSchemaSummary[]> {
        // Mirrors SqliteTableStorage.listTables (incl. the B3 round E2
        // keyset fix): name-sorted for stable pagination, `after`
        // (keyset, `n > after`) takes precedence over `offset` (raw
        // position, unstable under concurrent creates), limit slices
        // BEFORE any counting, withCounts (default true, matching the
        // original unpaginated behavior) gates whether rowCount is
        // computed at all.
        const { offset = 0, limit, withCounts = true, after } = opts;
        const names = Array.from(this.schemas.keys()).sort();
        const start = after !== undefined ? names.findIndex((n) => n > after) : offset;
        const sliceStart = start === -1 ? names.length : start;
        const pageNames = limit === undefined ? names.slice(sliceStart) : names.slice(sliceStart, sliceStart + limit);
        return pageNames.map((name) => {
            const schema = this.schemas.get(name)!;
            return {
                name: schema.name,
                columns: schema.columns,
                primaryKey: schema.columns.find(c => c.primary)?.name ?? '',
                rowCount: withCounts ? (this.rows.get(schema.name)?.size ?? 0) : undefined,
            };
        });
    }
    async insert(table: string, row: Row): Promise<void> {
        const tbl = this.rows.get(table) ?? new Map();
        const pkCol = this.schemas.get(table)?.columns.find(c => c.primary)?.name;
        const key = pkCol ? row[pkCol] : JSON.stringify(row);
        if (tbl.has(key)) throw new Error(`duplicate primary key: ${key}`);
        tbl.set(key, { ...row });
        this.rows.set(table, tbl);
    }
    async insertBatch(table: string, rows: Row[]): Promise<void> {
        for (const r of rows) await this.insert(table, r);
    }
    async query(table: string, filter?: FilterNode, opts?: FindOptions): Promise<Row[]> {
        const tbl = this.rows.get(table) ?? new Map();
        let out = Array.from(tbl.values());
        const eq = filter && 'eq' in filter ? (filter as { eq?: Record<string, unknown> }).eq : undefined;
        if (eq) {
            for (const [k, v] of Object.entries(eq)) {
                out = out.filter(r => r[k] === v);
            }
        }
        if (opts?.limit) out = out.slice(0, opts.limit);
        return out;
    }
    async getByKey<T extends Row = Row>(table: string, key: unknown): Promise<T | null> {
        const r = this.rows.get(table)?.get(key);
        return (r as T) ?? null;
    }
    async update(table: string, filter: FilterNode, patch: Partial<Row>): Promise<number> {
        const matches = await this.query(table, filter);
        for (const r of matches) Object.assign(r, patch);
        return matches.length;
    }
    async delete(table: string, filter: FilterNode): Promise<number> {
        const matches = await this.query(table, filter);
        const tbl = this.rows.get(table)!;
        const pkCol = this.schemas.get(table)?.columns.find(c => c.primary)?.name;
        for (const r of matches) tbl.delete(pkCol ? r[pkCol] : JSON.stringify(r));
        return matches.length;
    }
    async count(table: string, filter?: FilterNode): Promise<number> {
        return (await this.query(table, filter)).length;
    }
    async truncate(table: string): Promise<number> {
        const tbl = this.rows.get(table) ?? new Map();
        const n = tbl.size;
        tbl.clear();
        return n;
    }
    async runTransaction(ops: TableOp[]): Promise<TableOpResult[]> {
        const before = new Map(
            [...this.rows].map(([table, rows]) => [
                table,
                new Map([...rows].map(([key, row]) => [key, { ...row }])),
            ]),
        );
        const results: TableOpResult[] = [];
        let failedOpIndex = -1;
        try {
            for (let i = 0; i < ops.length; i++) {
                failedOpIndex = i;
                const op = ops[i]!;
                if (op.op === 'insert') {
                    await this.insert(op.collection, op.row);
                    const pk = this.schemas.get(op.collection)?.columns.find(c => c.primary)?.name;
                    results.push({ op: 'insert', collection: op.collection, key: pk ? op.row[pk] : undefined });
                } else if (op.op === 'update') {
                    results.push({ op: 'update', collection: op.collection, count: await this.update(op.collection, op.filter, op.patch) });
                } else if (op.op === 'delete') {
                    results.push({ op: 'delete', collection: op.collection, count: await this.delete(op.collection, op.filter) });
                } else {
                    const pk = this.schemas.get(op.collection)?.columns.find(c => c.primary)?.name;
                    const key = pk ? op.row[pk] : undefined;
                    const current = await this.getByKey(op.collection, key);
                    if (current) await this.update(op.collection, { eq: { [pk!]: key } }, op.row);
                    else await this.insert(op.collection, op.row);
                    results.push({ op: 'upsert', collection: op.collection, key });
                }
            }
            return results;
        } catch (error) {
            this.rows = before;
            (error as Error & { failedOpIndex: number }).failedOpIndex = failedOpIndex;
            throw error;
        }
    }
    async joinMany(query: JoinQuery): Promise<Row[]> {
        return [{ from: query.from, hops: query.join.length }];
    }
}

/**
 * startServer — bring up a real http.Server that delegates every
 * request to `tryCollectionsRoutes`. Keeps the test honest about
 * stream semantics, header writes, and parsing without hand-mocking
 * IncomingMessage. Returns the base URL.
 */
async function startServer(deps: { tableStorage: ITableStorage }): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await tryCollectionsRoutes(req, res, url, pathname, deps);
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'unhandled', message: 'no route matched' }));
        }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
    };
}

async function fetchJson(url: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
    const res = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

const SDK_SCHEMA = {
    name: 'orders',
    description: 'orders for the SDK smoke test',
    fields: [
        { name: 'id', field_type: 'string' as const, primary_key: true, required: true },
        { name: 'amount', field_type: 'integer' as const },
        { name: 'status', field_type: 'string' as const },
    ],
};

console.log('collections REST routes — Phase 2 item 5');

test('POST /v1/transaction is routed before the collection catch-all', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'insert', collection: 'orders', row: { id: 't1', amount: 10, status: 'open' } },
                    { op: 'update', collection: 'orders', filter: { eq: { id: 't1' } }, patch: { status: 'closed' } },
                ],
            },
        });
        assert.equal(result.status, 200);
        assert.equal((result.body as { results: unknown[] }).results.length, 2);
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/t1`);
        assert.equal((row.body as { status: string }).status, 'closed');
    } finally { await srv.close(); }
});

test('POST /v1/transaction reports the failed operation and applies nothing', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'insert', collection: 'orders', row: { id: 'rollback-me', amount: 10 } },
                    { op: 'insert', collection: 'orders', row: { id: 'rollback-me', amount: 20 } },
                ],
            },
        });
        assert.equal(result.status, 409);
        const body = result.body as { failed_op_index: number; reason: string };
        assert.equal(body.failed_op_index, 1);
        assert.equal(body.reason, 'duplicate_primary_key');
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/rollback-me`);
        assert.equal(row.status, 404);
    } finally { await srv.close(); }
});

/*
 * B2 (QA finding, 2026-09-03) — collection_transaction / POST /v1/transaction
 * bypassed collectionRowValidation.ts entirely: a wrong-typed value or an
 * unknown column was silently coerced/stored instead of rejected like
 * collection_insert/update/bulk_insert/update_by_query. These tests fail
 * against the pre-fix handleTransaction (no schema/filter validation before
 * runTransaction) and pass once handleTransaction pre-validates every op.
 */
test('POST /v1/transaction: string into an integer column -> 400 invalid_row naming op index + field, nothing applied', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'insert', collection: 'orders', row: { id: 'tx-bad-type', amount: '42', status: 'open' } },
                ],
            },
        });
        assert.equal(result.status, 400);
        const body = result.body as { code: string; failed_op_index: number; table: string; field: string };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.failed_op_index, 0);
        assert.equal(body.table, 'orders');
        assert.equal(body.field, 'amount');
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/tx-bad-type`);
        assert.equal(row.status, 404); // nothing applied
    } finally { await srv.close(); }
});

test('POST /v1/transaction: unknown column -> 400 invalid_row naming op index + field, nothing applied', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'insert', collection: 'orders', row: { id: 'tx-bad-col', bogus_field: 1 } },
                ],
            },
        });
        assert.equal(result.status, 400);
        const body = result.body as { code: string; failed_op_index: number; table: string; field: string };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.failed_op_index, 0);
        assert.equal(body.table, 'orders');
        assert.equal(body.field, 'bogus_field');
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/tx-bad-col`);
        assert.equal(row.status, 404); // nothing applied
    } finally { await srv.close(); }
});

test('POST /v1/transaction: a fully valid transaction still returns 200', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'insert', collection: 'orders', row: { id: 'tx-valid', amount: 42, status: 'open' } },
                ],
            },
        });
        assert.equal(result.status, 200);
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/tx-valid`);
        assert.equal(row.status, 200);
        assert.equal((row.body as { amount: number }).amount, 42);
    } finally { await srv.close(); }
});

test('POST /v1/transaction: an empty/all filter on an update op is refused (400), nothing applied', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'tx-scope-1', amount: 1, status: 'open' } });
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'update', collection: 'orders', filter: {}, patch: { status: 'closed' } },
                ],
            },
        });
        assert.equal(result.status, 400);
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/tx-scope-1`);
        assert.equal((row.body as { status: string }).status, 'open'); // nothing applied
    } finally { await srv.close(); }
});

test('POST /v1/transaction: an empty/all filter on a delete op is refused (400), nothing applied', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'tx-scope-2', amount: 1, status: 'open' } });
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'delete', collection: 'orders', filter: {} },
                ],
            },
        });
        assert.equal(result.status, 400);
        const row = await fetchJson(`${srv.baseUrl}/v1/orders/tx-scope-2`);
        assert.equal(row.status, 200); // nothing applied
    } finally { await srv.close(); }
});

/*
 * QA follow-up (2026-09-03) — malformed JSON on POST /v1/{collection} and
 * /bulk fell through classifyStorageErr's 500 fallback (insert_failed /
 * bulk_insert_failed) instead of a clean 400.
 */
test('POST /v1/{collection} with truncated JSON body -> 400 invalid_json_body', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const res = await fetch(`${srv.baseUrl}/v1/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"id":"x"',
        });
        const body = await res.json() as { code: string };
        assert.equal(res.status, 400);
        assert.equal(body.code, 'invalid_json_body');
    } finally { await srv.close(); }
});

test('POST /v1/{collection}/bulk with a trailing-comma JSON body -> 400 invalid_json_body', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const res = await fetch(`${srv.baseUrl}/v1/orders/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"records":[{"id":"x",}]}',
        });
        const body = await res.json() as { code: string };
        assert.equal(res.status, 400);
        assert.equal(body.code, 'invalid_json_body');
    } finally { await srv.close(); }
});

/*
 * Coordinator finding (2026-09-03, round E2 addendum) — POST /v1/transaction
 * did not check `readJsonBody`'s "invalid JSON body:" errors or
 * `isPayloadTooLarge` before falling through to `describeTransactionFailure`'s
 * generic `transaction_failed` branch, unlike every sibling /v1/{collection}
 * route (classifyStorageErr, routes/collections.ts). Malformed JSON lost the
 * parse detail; an oversized body answered 400 instead of 413.
 */
test('POST /v1/transaction with a truncated JSON body -> 400 invalid_json_body', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const res = await fetch(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"operations":[',
        });
        const body = await res.json() as { code: string };
        assert.equal(res.status, 400);
        assert.equal(body.code, 'invalid_json_body');
    } finally { await srv.close(); }
});

/*
 * A3 round-2 (QA finding, 2026-09-03) — filterZ (collectionsTransaction.ts)
 * used to silently STRIP an unrecognized `and`/`or`/`not` key instead of
 * rejecting it (zod's default non-strict behavior), so a filter combining a
 * scoping `and` with a broader leaf ran with the `and` dropped — matching
 * every row sharing that leaf value instead of the one row the caller
 * scoped to. `filterZ` is now `.strict()`, so the whole op is rejected
 * before anything is applied.
 */
test('POST /v1/transaction: a nested and/or filter on an update op is REJECTED (400 filter_invalid), nothing applied', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'r1', amount: 10, status: 'closed' } });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'r2', amount: 20, status: 'closed' } });
        // Caller intent: update ONLY r1, expressed as an `and` combining a
        // scoping id-eq with the shared status-eq.
        const trickyFilter = { and: [{ eq: { id: 'r1' } }], eq: { status: 'closed' } };
        const result = await fetchJson(`${srv.baseUrl}/v1/transaction`, {
            method: 'POST',
            body: {
                operations: [
                    { op: 'update', collection: 'orders', filter: trickyFilter, patch: { amount: 999 } },
                ],
            },
        });
        assert.equal(result.status, 400);
        const body = result.body as { code: string; failed_op_index: number; message: string };
        assert.equal(body.code, 'filter_invalid');
        assert.equal(body.failed_op_index, 0);
        assert.match(body.message, /"and"/);
        const r1 = await fetchJson(`${srv.baseUrl}/v1/orders/r1`);
        const r2 = await fetchJson(`${srv.baseUrl}/v1/orders/r2`);
        assert.equal((r1.body as { amount: number }).amount, 10); // nothing applied
        assert.equal((r2.body as { amount: number }).amount, 20);
    } finally { await srv.close(); }
});

/*
 * QA follow-up (2026-09-03) — PUT /v1/{collection} and
 * PUT /v1/{collection}/update-by-query dropped classifyStorageErr's
 * `extras`, so an invalid_row 400 lacked table/field (insert/bulk already
 * included them).
 */
test('PUT /v1/{collection} with an invalid patch field carries table/field extras', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'put-bad', amount: 1, status: 'open' } });
        const result = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'PUT',
            body: { filter: { eq: { id: 'put-bad' } }, updates: { amount: 'not-a-number' } },
        });
        assert.equal(result.status, 400);
        const body = result.body as { code: string; table?: string; field?: string };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.table, 'orders');
        assert.equal(body.field, 'amount');
    } finally { await srv.close(); }
});

test('PUT /v1/{collection}/update-by-query with an unknown field carries table/field extras', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'put-uq-bad', amount: 1, status: 'open' } });
        const result = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
            method: 'PUT',
            body: { filter: { eq: { id: 'put-uq-bad' } }, fields: { unknownField: 1 } },
        });
        assert.equal(result.status, 400);
        const body = result.body as { code: string; table?: string; field?: string };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.table, 'orders');
        assert.equal(body.field, 'unknownField');
    } finally { await srv.close(); }
});

/*
 * QA follow-up (2026-09-03) — SqliteTableStorage.requireSchema throws a
 * DIFFERENT message ("table 'X' exists in the DB but its schema is not
 * cached...") than "unknown table 'X'" when a table physically exists but
 * schemas.json was deleted/lost before a restart. classifyStorageErr's
 * `unknownMatch` regex never matched that message, so it fell through to
 * a 500 (get_failed/delete_failed) leaking no useful detail. It should be
 * a clean 404 collection_not_found — the API can't currently reach the
 * collection either way.
 */
test('GET /v1/{collection}/{id} maps a schema-not-cached storage error to 404 collection_not_found', async () => {
    class SchemaNotCachedStore extends FakeTableStorage {
        async getByKey<T extends Row = Row>(): Promise<T | null> {
            throw new Error(
                "SqliteTableStorage.get: table 'orders' exists in the DB but its "
                + 'schema is not cached. Likely cause: schemas.json was deleted or '
                + 'an upgrade dropped it. Re-declare the table via createTable() with '
                + 'the original schema to restore access — data is preserved.',
            );
        }
    }
    const srv = await startServer({ tableStorage: new SchemaNotCachedStore() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/some-id`);
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'collection_not_found');
    } finally { await srv.close(); }
});

test('DELETE /v1/{collection}/{id} maps a schema-not-cached storage error to 404 collection_not_found', async () => {
    class SchemaNotCachedStore extends FakeTableStorage {
        async delete(): Promise<number> {
            throw new Error(
                "SqliteTableStorage.delete: table 'orders' exists in the DB but its "
                + 'schema is not cached. Likely cause: schemas.json was deleted or '
                + 'an upgrade dropped it. Re-declare the table via createTable() with '
                + 'the original schema to restore access — data is preserved.',
            );
        }
    }
    const srv = await startServer({ tableStorage: new SchemaNotCachedStore() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/some-id`, { method: 'DELETE' });
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'collection_not_found');
    } finally { await srv.close(); }
});

test('POST /v1/query is routed before treating query as a collection', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const result = await fetchJson(`${srv.baseUrl}/v1/query`, {
            method: 'POST',
            body: {
                from: 'orders',
                join: [{ collection: 'customers', on: { from: 'customer_id', to: 'id' }, type: 'inner' }],
            },
        });
        assert.equal(result.status, 200);
        assert.equal((result.body as { records: Array<{ from: string }> }).records[0]?.from, 'orders');
    } finally { await srv.close(); }
});

/* ---------- meta routes ---------- */

test('POST /v1/schema does not leak the raw storage error on failure (audit 2026-06-25)', async () => {
    const SECRET = 'sqlite3: I/O error opening /Users/secret/path/knowledge.db';
    class ThrowingStore extends FakeTableStorage {
        async createTable(): Promise<void> { throw new Error(SECRET); }
    }
    const srv = await startServer({ tableStorage: new ThrowingStore() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        assert.equal(r.status, 500);
        assert.equal((r.body as { code: string }).code, 'create_collection_failed');
        assert.equal((r.body as { message: string }).message, 'internal storage error');
        assert.ok(!JSON.stringify(r.body).includes('secret'), 'raw engine error/path must not leak to the client');
    } finally { await srv.close(); }
});

test('POST /v1/schema returns 201 + the schema', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        assert.equal(r.status, 201);
        assert.equal((r.body as { name: string }).name, 'orders');
        // Translation actually happened in the store.
        assert.ok(store.schemas.has('orders'));
        assert.equal(store.schemas.get('orders')?.columns[0].primary, true);
    } finally { await srv.close(); }
});

test('POST /v1/schema returns 400 for malformed body', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: { name: 'x' } });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_schema');
    } finally { await srv.close(); }
});

/**
 * Round-S fix (2026-09-04, finding 1) — QA smoke
 * (<SCRATCH>/audit/smoke-final/07-collections.mjs,
 * 11-schema-delete.mjs): `POST /v1/schema` with
 * `fields:[{name:'id',type:'text',primary_key:true},...]` (SDK's field
 * key is `field_type`, not `type`; `'text'` isn't in COLUMN_TYPE_ENUM
 * either) used to 201, echoing the caller's own malformed body back. The
 * field's `type` silently became `undefined` (never persisted), `GET
 * /v1/schema` then listed the field with no type, and every subsequent
 * `POST /v1/{collection}` insert 400'd with the confusing "expected type
 * 'undefined' for column 'id'". The route now validates against the same
 * zod schema `collection_create` already used, so this never reaches 201.
 */
test('POST /v1/schema rejects a field using `type` instead of `field_type` — never 201s (live repro)', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`, {
            method: 'POST',
            body: {
                name: 'smoke_final_coll',
                fields: [
                    { name: 'id', type: 'text', primary_key: true },
                    { name: 'val', type: 'text' },
                ],
            },
        });
        assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)} -- pre-fix this was 201`);
        assert.equal((r.body as { code: string }).code, 'invalid_schema');
        assert.ok(!store.schemas.has('smoke_final_coll'), 'the malformed schema must never be persisted');
        const list = await fetchJson(`${srv.baseUrl}/v1/schema`);
        const names = (list.body as { schemas: Array<{ name: string }> }).schemas.map(s => s.name);
        assert.ok(!names.includes('smoke_final_coll'), 'GET /v1/schema must not list the never-created collection');
    } finally { await srv.close(); }
});

test('POST /v1/schema rejects `field_type: "text"` (not in COLUMN_TYPE_ENUM) and names the accepted types', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`, {
            method: 'POST',
            body: { name: 'bad_type', fields: [{ name: 'id', field_type: 'text', primary_key: true }] },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_schema');
        const message = (r.body as { message: string }).message;
        assert.ok(message.includes('string'), 'the accepted-type list must be in the message');
    } finally { await srv.close(); }
});

test('POST /v1/schema with a correct field_type still 201s and every insert works (no regression)', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        const created = await fetchJson(`${srv.baseUrl}/v1/schema`, {
            method: 'POST',
            body: { name: 'good_coll', fields: [{ name: 'id', field_type: 'string', primary_key: true }] },
        });
        assert.equal(created.status, 201);
        const inserted = await fetchJson(`${srv.baseUrl}/v1/good_coll`, { method: 'POST', body: { id: 'r1' } });
        assert.equal(inserted.status, 201, `expected 201, got ${inserted.status} ${JSON.stringify(inserted.body)}`);
    } finally { await srv.close(); }
});

test('GET /v1/schema/{name} returns the SDK schema', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        const r = await fetchJson(`${srv.baseUrl}/v1/schema/orders`);
        assert.equal(r.status, 200);
        const schema = r.body as { name: string; fields: Array<{ field_type: string; primary_key?: boolean }> };
        assert.equal(schema.name, 'orders');
        assert.equal(schema.fields[0].primary_key, true);
        assert.equal(schema.fields[0].field_type, 'string');
    } finally { await srv.close(); }
});

test('GET /v1/schema/{name} returns 404 for unknown', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema/nope`);
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'collection_not_found');
    } finally { await srv.close(); }
});

/* ---------- GET /v1/schema (finding #7, 2026-09-03) ---------- */

test('GET /v1/schema returns 200 with an empty list when nothing has been created', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`);
        assert.equal(r.status, 200);
        assert.deepEqual((r.body as { schemas: unknown[] }).schemas, []);
    } finally { await srv.close(); }
});

test('GET /v1/schema lists both collections, SDK-shaped, after two creates', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        const CUSTOMERS_SCHEMA = {
            name: 'customers',
            fields: [
                { name: 'id', field_type: 'string' as const, primary_key: true, required: true },
                { name: 'email', field_type: 'string' as const },
            ],
        };
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: CUSTOMERS_SCHEMA });

        const r = await fetchJson(`${srv.baseUrl}/v1/schema`);
        assert.equal(r.status, 200);
        const { schemas } = r.body as { schemas: Array<{ name: string; fields: Array<{ name: string; field_type: string; primary_key?: boolean }> }> };
        assert.equal(schemas.length, 2);
        const byName = new Map(schemas.map(s => [s.name, s]));
        assert.ok(byName.has('orders'));
        assert.ok(byName.has('customers'));
        assert.equal(byName.get('orders')!.fields[0].primary_key, true);
        assert.equal(byName.get('customers')!.fields[0].field_type, 'string');
    } finally { await srv.close(); }
});

/* ---------- GET /v1/schema pagination (finding B3, round E, 2026-09-03) ----------
 * Original finding #7 fix had no pagination and no way to skip the
 * per-table COUNT(*) fan-out. These prove the fix end-to-end over HTTP:
 * a 250-collection workspace's default call is capped with a cursor,
 * the cursor can be followed to enumerate every collection exactly
 * once, and ?withCounts= controls whether rowCount is computed. */

async function createManyCollections(baseUrl: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        // Zero-padded names sort predictably (t0000, t0001, ...) so
        // "first page" / "next page" assertions below are deterministic.
        await fetchJson(`${baseUrl}/v1/schema`, {
            method: 'POST',
            body: {
                name: `t${String(i).padStart(4, '0')}`,
                fields: [{ name: 'id', field_type: 'string' as const, primary_key: true }],
            },
        });
    }
}

test('GET /v1/schema: default call on 250 collections returns DEFAULT_SCHEMA_LIST_LIMIT + a cursor', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await createManyCollections(srv.baseUrl, 250);
        const r = await fetchJson(`${srv.baseUrl}/v1/schema`);
        assert.equal(r.status, 200);
        const { schemas, nextCursor } = r.body as { schemas: Array<{ name: string }>; nextCursor?: string };
        assert.equal(schemas.length, DEFAULT_SCHEMA_LIST_LIMIT);
        assert.equal(schemas[0]!.name, 't0000');
        assert.ok(typeof nextCursor === 'string' && nextCursor.length > 0);
    } finally { await srv.close(); }
});

test('GET /v1/schema: following ?cursor= enumerates all 250 collections exactly once, then stops', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await createManyCollections(srv.baseUrl, 250);
        const seen: string[] = [];
        let cursor: string | undefined;
        let iterations = 0;
        do {
            const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
            const r = await fetchJson(`${srv.baseUrl}/v1/schema${qs}`);
            assert.equal(r.status, 200);
            const { schemas, nextCursor } = r.body as { schemas: Array<{ name: string }>; nextCursor?: string };
            for (const s of schemas) seen.push(s.name);
            cursor = nextCursor;
            iterations++;
            assert.ok(iterations <= 10, 'pagination did not terminate within a sane number of pages');
        } while (cursor !== undefined);

        assert.equal(seen.length, 250);
        assert.equal(new Set(seen).size, 250, 'no collection should appear twice across pages');
        assert.equal(iterations, 3); // 100 + 100 + 50, ceil(250/100)
    } finally { await srv.close(); }
});

test('GET /v1/schema: withCounts omitted (default) has no rowCount field', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'o1', amount: 5, status: 'new' } });

        const r = await fetchJson(`${srv.baseUrl}/v1/schema`);
        assert.equal(r.status, 200);
        const { schemas } = r.body as { schemas: Array<Record<string, unknown>> };
        assert.equal(schemas.length, 1);
        assert.equal('rowCount' in schemas[0]!, false);
    } finally { await srv.close(); }
});

test('GET /v1/schema?withCounts=true includes rowCount', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'o1', amount: 5, status: 'new' } });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'o2', amount: 7, status: 'new' } });

        const r = await fetchJson(`${srv.baseUrl}/v1/schema?withCounts=true`);
        assert.equal(r.status, 200);
        const { schemas } = r.body as { schemas: Array<{ rowCount?: number }> };
        assert.equal(schemas.length, 1);
        assert.equal(schemas[0]!.rowCount, 2);
    } finally { await srv.close(); }
});

test('GET /v1/schema?limit= is clamped to MAX_SCHEMA_LIST_LIMIT', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await createManyCollections(srv.baseUrl, 5);
        const r = await fetchJson(`${srv.baseUrl}/v1/schema?limit=${MAX_SCHEMA_LIST_LIMIT + 500}`);
        assert.equal(r.status, 200);
        const { schemas, nextCursor } = r.body as { schemas: unknown[]; nextCursor?: string };
        assert.equal(schemas.length, 5);
        assert.equal(nextCursor, undefined);
    } finally { await srv.close(); }
});

/* ---------- GET /v1/schema keyset cursor (finding B3, round E2, 2026-09-03) ----------
 * The round-E fix's ?cursor= encoded a raw numeric offset, but the
 * underlying name-sorted list is re-derived fresh on every request — a
 * collection created between two page fetches, whose name sorts before
 * the boundary, shifts every later name's position by one, so the
 * boundary entry came back twice. The fix switches ?cursor= to a
 * keyset (last-returned name, `n > lastName`), which doesn't move when
 * something is created elsewhere in the set. */

test('GET /v1/schema: creating a collection before the page boundary mid-walk causes no duplicates and no skips', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await createManyCollections(srv.baseUrl, 25); // t0000..t0024

        const r1 = await fetchJson(`${srv.baseUrl}/v1/schema?limit=10`);
        assert.equal(r1.status, 200);
        const page1 = r1.body as { schemas: Array<{ name: string }>; nextCursor?: string };
        assert.equal(page1.schemas.length, 10);
        assert.equal(page1.schemas[9]!.name, 't0009');
        assert.ok(page1.nextCursor);

        // Sorts before every existing "t..." name and before the
        // just-returned boundary entry ("t0009") — the shape that
        // triggered the duplicate under the old offset-based cursor.
        await fetchJson(`${srv.baseUrl}/v1/schema`, {
            method: 'POST',
            body: { name: 'aaa_inserted_before_boundary', fields: [{ name: 'id', field_type: 'string' as const, primary_key: true }] },
        });

        const seen: string[] = [...page1.schemas.map(s => s.name)];
        let cursor: string | undefined = page1.nextCursor;
        let iterations = 1;
        while (cursor !== undefined) {
            const qs = `?limit=10&cursor=${encodeURIComponent(cursor)}`;
            const r = await fetchJson(`${srv.baseUrl}/v1/schema${qs}`);
            assert.equal(r.status, 200);
            const page = r.body as { schemas: Array<{ name: string }>; nextCursor?: string };
            for (const s of page.schemas) seen.push(s.name);
            cursor = page.nextCursor;
            iterations++;
            assert.ok(iterations <= 10, 'pagination did not terminate within a sane number of pages');
        }

        const tTableSeen = seen.filter(n => n.startsWith('t0'));
        assert.equal(tTableSeen.length, 25, `expected all 25 pre-existing collections exactly once, got: ${JSON.stringify(tTableSeen)}`);
        assert.equal(new Set(tTableSeen).size, 25, 'no pre-existing collection should appear twice across pages');
        assert.ok(tTableSeen.includes('t0010'), 't0010 must not be skipped');
        assert.equal(seen.filter(n => n === 't0009').length, 1, 't0009 (the page1/page2 boundary) must not be duplicated');
    } finally { await srv.close(); }
});

test('GET /v1/schema: a collection created after the page boundary appears exactly once', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await createManyCollections(srv.baseUrl, 25); // t0000..t0024

        const r1 = await fetchJson(`${srv.baseUrl}/v1/schema?limit=10`);
        const page1 = r1.body as { schemas: Array<{ name: string }>; nextCursor?: string };
        assert.ok(page1.nextCursor);

        // Sorts after every existing name, so it lands at the very end of the walk.
        await fetchJson(`${srv.baseUrl}/v1/schema`, {
            method: 'POST',
            body: { name: 'zzz_inserted_after_boundary', fields: [{ name: 'id', field_type: 'string' as const, primary_key: true }] },
        });

        const seen: string[] = [...page1.schemas.map(s => s.name)];
        let cursor: string | undefined = page1.nextCursor;
        let iterations = 1;
        while (cursor !== undefined) {
            const qs = `?limit=10&cursor=${encodeURIComponent(cursor)}`;
            const r = await fetchJson(`${srv.baseUrl}/v1/schema${qs}`);
            const page = r.body as { schemas: Array<{ name: string }>; nextCursor?: string };
            for (const s of page.schemas) seen.push(s.name);
            cursor = page.nextCursor;
            iterations++;
            assert.ok(iterations <= 10, 'pagination did not terminate within a sane number of pages');
        }

        assert.equal(seen.filter(n => n === 'zzz_inserted_after_boundary').length, 1,
            'a collection created after the boundary must appear exactly once in the rest of the walk');
    } finally { await srv.close(); }
});

test('GET /v1/schema: an old-style numeric-offset ?cursor= is treated as malformed and ignored', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await createManyCollections(srv.baseUrl, 5); // t0000..t0004

        // Shape produced by the pre-round-E2 encoder (`{offset: number}`,
        // no `after` field) — must not 500, and must not be honored as a
        // position; falls back to ?offset= (0, since none is given here)
        // exactly like garbage/truncated base64url does.
        const oldStyleCursor = Buffer.from(JSON.stringify({ offset: 2 }), 'utf8').toString('base64url');

        const r = await fetchJson(`${srv.baseUrl}/v1/schema?cursor=${encodeURIComponent(oldStyleCursor)}`);
        assert.equal(r.status, 200);
        const { schemas } = r.body as { schemas: Array<{ name: string }> };
        assert.equal(schemas.length, 5, 'old-style cursor should fall back to offset 0, returning the full set');
        assert.equal(schemas[0]!.name, 't0000');
    } finally { await srv.close(); }
});

/* ---------- CRUD routes ---------- */

test('POST /v1/{collection} inserts a row and returns 201', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'POST',
            body: { id: 'o1', amount: 100, status: 'open' },
        });
        assert.equal(r.status, 201);
        assert.equal((r.body as { id: string }).id, 'o1');
    } finally { await srv.close(); }
});

test('POST /v1/{collection} returns 409 on duplicate key (PK collision)', async () => {
    // RC2 audit (2026-05-17): classifyStorageErr maps "duplicate primary
    // key" → 409 duplicate_primary_key. Before the audit this surfaced
    // as a 500 insert_failed, which is wrong — PK collision is a client
    // conflict, not a server error.
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'o1' } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'o1' } });
        assert.equal(r.status, 409);
        assert.equal((r.body as { code: string }).code, 'duplicate_primary_key');
    } finally { await srv.close(); }
});

test('GET /v1/{collection}/{id} returns the row', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'o1', amount: 100 } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/o1`);
        assert.equal(r.status, 200);
        assert.equal((r.body as { amount: number }).amount, 100);
    } finally { await srv.close(); }
});

test('GET /v1/{collection}/{id} returns 404 when row absent', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/nope`);
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'row_not_found');
    } finally { await srv.close(); }
});

// F-DEL8 — the SDK/docs (DATAPLANE_INTEGRATION.md) and the Python SDK have
// always expected DELETE /v1/{collection}/{id} to delete-by-primary-key
// (the mirror of the GET-by-id route above); only the filter-body form
// (DELETE /v1/{collection}) and /delete-by-query existed, so this shape
// used to 405 ("method DELETE not allowed on /v1/orders/del1").
test('DELETE /v1/{collection}/{id} deletes by primary key and returns {deleted}', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'del1', amount: 5 } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/del1`, { method: 'DELETE' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal((r.body as { deleted: number }).deleted, 1);
        // Same response shape as the filter-delete route above ({ deleted }).
        const get = await fetchJson(`${srv.baseUrl}/v1/orders/del1`);
        assert.equal(get.status, 404, 'row must be gone after DELETE by id');
    } finally { await srv.close(); }
});

test('DELETE /v1/{collection}/{id} returns 404 when the row is absent', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/nope`, { method: 'DELETE' });
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'row_not_found');
    } finally { await srv.close(); }
});

test('POST /v1/{collection}/query returns {records, total_count, has_more}', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        for (const id of ['a', 'b', 'c']) {
            await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id, amount: 1, status: 'open' } });
        }
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/query`, {
            method: 'POST',
            body: { filter: { eq: { status: 'open' } } },
        });
        assert.equal(r.status, 200);
        const result = r.body as { records: unknown[]; total_count: number; has_more: boolean };
        assert.equal(result.records.length, 3);
        assert.equal(result.total_count, 3);
    } finally { await srv.close(); }
});

test('PUT /v1/{collection} updates rows and returns {updated}', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'u1', status: 'open' } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'PUT',
            body: { filter: { eq: { id: 'u1' } }, updates: { status: 'closed' } },
        });
        assert.equal(r.status, 200);
        assert.equal((r.body as { updated: number }).updated, 1);
    } finally { await srv.close(); }
});

test('PUT /v1/{collection} returns 400 on missing filter/updates', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'PUT', body: { filter: { eq: {} } } });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_update_body');
    } finally { await srv.close(); }
});

test('DELETE /v1/{collection} removes rows and returns {deleted}', async () => {
    const store = new FakeTableStorage();
    const srv = await startServer({ tableStorage: store });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'd1', status: 'closed' } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
            method: 'DELETE',
            body: { filter: { eq: { id: 'd1' } } },
        });
        assert.equal(r.status, 200);
        assert.equal((r.body as { deleted: number }).deleted, 1);
        // Verify it's gone
        const get = await fetchJson(`${srv.baseUrl}/v1/orders/d1`);
        assert.equal(get.status, 404);
    } finally { await srv.close(); }
});

test('Unknown method on /v1/{collection} returns 405', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'PATCH' });
        assert.equal(r.status, 405);
        assert.equal((r.body as { code: string }).code, 'method_not_allowed');
    } finally { await srv.close(); }
});

/* ---------- Phase 2.5 bulk variants ---------- */

async function seedOrders(srv: { baseUrl: string }) {
    await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
}

test('POST /v1/{collection}/bulk inserts many rows and returns {success, data}', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/bulk`, {
            method: 'POST',
            body: { records: [
                { id: 'o1', amount: 1 },
                { id: 'o2', amount: 2 },
                { id: 'o3', amount: 3 },
            ]},
        });
        assert.equal(r.status, 201);
        const body = r.body as { success: boolean; data: { inserted: number; ids: string[]; total_requested: number } };
        assert.equal(body.success, true);
        assert.equal(body.data.inserted, 3);
        assert.equal(body.data.total_requested, 3);
        assert.deepEqual(body.data.ids, ['o1', 'o2', 'o3']);
    } finally { await srv.close(); }
});

test('POST /v1/{collection}/bulk returns 400 on missing records', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/bulk`, { method: 'POST', body: {} });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_bulk_body');
    } finally { await srv.close(); }
});

test('POST /v1/{collection}/count returns {success, data: {count, collection}}', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders/bulk`, {
            method: 'POST', body: { records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/count`, { method: 'POST', body: {} });
        assert.equal(r.status, 200);
        const body = r.body as { success: boolean; data: { count: number; collection: string } };
        assert.equal(body.data.count, 3);
        assert.equal(body.data.collection, 'orders');
    } finally { await srv.close(); }
});

test('PUT /v1/{collection}/update-by-query returns {success, data: {updated, collection}}', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'u1', status: 'open' } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
            method: 'PUT',
            body: { filter: { eq: { id: 'u1' } }, fields: { status: 'closed' } },
        });
        assert.equal(r.status, 200);
        const body = r.body as { success: boolean; data: { updated: number; collection: string } };
        assert.equal(body.data.updated, 1);
    } finally { await srv.close(); }
});

test('PUT /v1/{collection}/update-by-query returns 400 on missing fields', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
            method: 'PUT',
            body: { filter: { eq: { id: 'u1' } } },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_update_by_query_body');
    } finally { await srv.close(); }
});

test('DELETE /v1/{collection}/delete-by-query returns {success, data: {deleted, collection}}', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id: 'd1', status: 'closed' } });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
            method: 'DELETE',
            body: { filter: { eq: { id: 'd1' } } },
        });
        assert.equal(r.status, 200);
        const body = r.body as { success: boolean; data: { deleted: number } };
        assert.equal(body.data.deleted, 1);
    } finally { await srv.close(); }
});

test('DELETE /v1/{collection}/delete-by-query refuses all-filter with 400', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
            method: 'DELETE',
            body: { filter: {} },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'all_filter_refused');
    } finally { await srv.close(); }
});

test('POST /v1/{collection}/truncate wipes all rows and returns {success, data: {truncated, deleted}}', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedOrders(srv);
        await fetchJson(`${srv.baseUrl}/v1/orders/bulk`, {
            method: 'POST', body: { records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        });
        const r = await fetchJson(`${srv.baseUrl}/v1/orders/truncate`, { method: 'POST', body: {} });
        assert.equal(r.status, 200);
        const body = r.body as { success: boolean; data: { truncated: boolean; deleted: number } };
        assert.equal(body.data.truncated, true);
        assert.equal(body.data.deleted, 3);
        // confirm empty
        const after = await fetchJson(`${srv.baseUrl}/v1/orders/count`, { method: 'POST', body: {} });
        assert.equal((after.body as { data: { count: number } }).data.count, 0);
    } finally { await srv.close(); }
});

/* ---------- R4 #9 — real backend dup-PK / NOT NULL messages ---------- */
// better-sqlite3 throws 'UNIQUE constraint failed: <t>.<c>' and the legacy graph engine a
// 'duplicated primary key' runtime exception — NOT the engine-agnostic
// 'duplicate primary key' the old classifier matched. Those fell through to a
// 500 that leaked the raw text. Verify the broadened mapping + no leak.
class RealMsgStorage extends FakeTableStorage {
    override async insert(table: string, row: Row): Promise<void> {
        if (row.id === 'dup') throw new Error('UNIQUE constraint failed: orders.id');
        if (row.id === 'nullreq') throw new Error('NOT NULL constraint failed: orders.amount');
        if (row.id === 'boom') throw new Error('SQLITE_CORRUPT: database disk image is malformed at /Users/secret/path');
        return super.insert(table, row);
    }
}
async function postOrder(id: string) {
    const srv = await startServer({ tableStorage: new RealMsgStorage() });
    try {
        await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: SDK_SCHEMA });
        return await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'POST', body: { id } });
    } finally { await srv.close(); }
}
test('R4#9 UNIQUE constraint failed (better-sqlite3) → 409, no raw detail leaked', async () => {
    const r = await postOrder('dup');
    assert.equal(r.status, 409);
    assert.equal((r.body as { code: string }).code, 'duplicate_primary_key');
    assert.ok(!JSON.stringify(r.body).includes('orders.id'), 'raw SQLite column detail must not leak');
});
test('R4#9 NOT NULL constraint failed → 400 missing_required_field', async () => {
    const r = await postOrder('nullreq');
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'missing_required_field');
});
test('R4#9 generic storage error → 500 with no raw internal text leaked', async () => {
    const r = await postOrder('boom');
    assert.equal(r.status, 500);
    const body = JSON.stringify(r.body);
    assert.ok(!body.includes('/Users/secret/path') && !body.includes('disk image is malformed'), 'raw engine text must not leak');
});

/* ---------- F6 (2026-09-03 audit): invalid rows rejected with 400, not 500 ---------- */
// Before this fix every one of these was a 500 insert_failed/bulk_insert_failed
// (or, for the numeric string, a silently-corrupted 201) because validation
// happened only deep inside SqliteTableStorage, whose plain Errors don't match
// classifyStorageErr's regexes. Now collectionRowValidation.ts rejects them at
// the boundary, before ITableStorage.insert is ever called.

const VALIDATION_SCHEMA = {
    name: 'accounts',
    fields: [
        { name: 'id', field_type: 'string' as const, primary_key: true, required: true },
        { name: 'name', field_type: 'string' as const },
        { name: 'age', field_type: 'integer' as const },
        { name: 'active', field_type: 'boolean' as const },
    ],
};

async function seedAccounts(srv: { baseUrl: string }) {
    await fetchJson(`${srv.baseUrl}/v1/schema`, { method: 'POST', body: VALIDATION_SCHEMA });
}

test('POST /v1/{collection} rejects an unknown field with 400 naming table + field', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, {
            method: 'POST',
            body: { id: 'a1', bogus: 'x' },
        });
        assert.equal(r.status, 400);
        const body = r.body as { code: string; field?: string; table?: string };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.field, 'bogus');
        assert.equal(body.table, 'accounts');
        // Confirm it was never stored.
        const get = await fetchJson(`${srv.baseUrl}/v1/accounts/a1`);
        assert.equal(get.status, 404);
    } finally { await srv.close(); }
});

test('POST /v1/{collection} rejects a wrong-typed boolean with 400', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, {
            method: 'POST',
            body: { id: 'a2', active: 'maybe' },
        });
        assert.equal(r.status, 400);
        const body = r.body as { code: string; field?: string };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.field, 'active');
    } finally { await srv.close(); }
});

test('POST /v1/{collection} rejects an object into a declared string column with 400', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, {
            method: 'POST',
            body: { id: 'a3', name: { first: 'x' } },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_row');
        assert.equal((r.body as { field?: string }).field, 'name');
    } finally { await srv.close(); }
});

test('POST /v1/{collection} rejects an array into a declared integer column with 400', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, {
            method: 'POST',
            body: { id: 'a4', age: [1, 2, 3] },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_row');
        assert.equal((r.body as { field?: string }).field, 'age');
    } finally { await srv.close(); }
});

test('POST /v1/{collection} rejects an empty row with 400', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, { method: 'POST', body: {} });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_row');
        assert.equal((r.body as { table?: string }).table, 'accounts');
    } finally { await srv.close(); }
});

test('POST /v1/{collection} rejects a numeric string into an integer column with 400 (reject, not coerce)', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, {
            method: 'POST',
            body: { id: 'a5', age: '5' },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_row');
        assert.equal((r.body as { field?: string }).field, 'age');
    } finally { await srv.close(); }
});

test('POST /v1/{collection} still inserts a fully valid row as 201', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts`, {
            method: 'POST',
            body: { id: 'ok1', name: 'Ada', age: 30, active: true },
        });
        assert.equal(r.status, 201);
        assert.equal((r.body as { id: string }).id, 'ok1');
    } finally { await srv.close(); }
});

test('POST /v1/{collection}/bulk rejects a bad row with 400 naming its index + field, inserting nothing', async () => {
    const srv = await startServer({ tableStorage: new FakeTableStorage() });
    try {
        await seedAccounts(srv);
        const r = await fetchJson(`${srv.baseUrl}/v1/accounts/bulk`, {
            method: 'POST',
            body: { records: [
                { id: 'b1', name: 'ok' },
                { id: 'b2', bogus: true },
                { id: 'b3', name: 'also ok' },
            ] },
        });
        assert.equal(r.status, 400);
        const body = r.body as { code: string; field?: string; row_index?: number };
        assert.equal(body.code, 'invalid_row');
        assert.equal(body.field, 'bogus');
        assert.equal(body.row_index, 1);
        // Pre-validation runs before any insert — row 0 must not have landed.
        const get = await fetchJson(`${srv.baseUrl}/v1/accounts/b1`);
        assert.equal(get.status, 404);
    } finally { await srv.close(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
