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
import type {
    ITableStorage,
    Row,
    TableSchema,
} from '../packages/lore/src/contracts/tables.js';
import type { Filter, FindOptions } from '../packages/lore/src/engines/collectionStorage.js';

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

    async createTable(schema: TableSchema): Promise<void> {
        this.schemas.set(schema.name, schema);
        if (!this.rows.has(schema.name)) this.rows.set(schema.name, new Map());
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
    async query(table: string, filter?: Filter, opts?: FindOptions): Promise<Row[]> {
        const tbl = this.rows.get(table) ?? new Map();
        let out = Array.from(tbl.values());
        if (filter?.eq) {
            for (const [k, v] of Object.entries(filter.eq)) {
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
    async update(table: string, filter: Filter, patch: Partial<Row>): Promise<number> {
        const matches = await this.query(table, filter);
        for (const r of matches) Object.assign(r, patch);
        return matches.length;
    }
    async delete(table: string, filter: Filter): Promise<number> {
        const matches = await this.query(table, filter);
        const tbl = this.rows.get(table)!;
        const pkCol = this.schemas.get(table)?.columns.find(c => c.primary)?.name;
        for (const r of matches) tbl.delete(pkCol ? r[pkCol] : JSON.stringify(r));
        return matches.length;
    }
    async count(table: string, filter?: Filter): Promise<number> {
        return (await this.query(table, filter)).length;
    }
    async truncate(table: string): Promise<number> {
        const tbl = this.rows.get(table) ?? new Map();
        const n = tbl.size;
        tbl.clear();
        return n;
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
// better-sqlite3 throws 'UNIQUE constraint failed: <t>.<c>' and Kùzu a
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

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
