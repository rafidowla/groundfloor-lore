#!/usr/bin/env tsx
/**
 * test/collections-filter-strict-unit.ts — QA round-3 (2026-09-03, finding A3).
 *
 * `leafFilterZ`/`filterNodeZ` (mcp/tools/collectionsFilterSchema.ts) were the
 * one place round-2's ".strict() the filter schema" fix (collectionsTransaction.ts's
 * `filterZ`) never reached: a plain (non-strict) zod object silently STRIPS an
 * unrecognized key instead of rejecting it. That meant
 * `collection_update`/`collection_delete`/`collection_update_by_query`/
 * `collection_delete_by_query` (and their REST siblings PUT/DELETE
 * /v1/{collection}, PUT .../update-by-query, DELETE .../delete-by-query, which
 * never ran the filter through zod AT ALL) could take a filter like
 * `{eqq:{id:'r1'}, eq:{status:'closed'}}` — caller intent: scope to id 'r1' —
 * silently narrow it to `{eq:{status:'closed'}}` and mutate every row sharing
 * that leaf value, with no error.
 *
 * This file drives all 8 write surfaces (4 MCP tool callbacks via the real
 * `registerCollectionTools` registration, 4 REST routes via a real HTTP
 * server) against a REAL `SqliteTableStorage`, reading row state back with a
 * SECOND `better-sqlite3` connection so a mutation is verified independently
 * of the code under test — same methodology as the QA repro scripts under
 * <scratch>/qa/A3-round3/.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';

import {
    handleCreateCollection,
    registerCollectionTools,
    type SdkCollectionSchema,
} from '../packages/lore/src/mcp/tools/collections.js';
import { tryCollectionsRoutes } from '../packages/lore/src/mcp/http/routes/collections.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { FilterNode } from '../packages/lore/src/engines/collectionStorage.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? err}`); failed++; }
    })());
}

const SDK_SCHEMA: SdkCollectionSchema = {
    name: 'orders',
    fields: [
        { name: 'id', field_type: 'string', primary_key: true, required: true },
        { name: 'amount', field_type: 'integer' },
        { name: 'status', field_type: 'string' },
    ],
};
const SEED = [
    { id: 'r1', amount: 10, status: 'closed' },
    { id: 'r2', amount: 20, status: 'closed' },
    { id: 'r3', amount: 30, status: 'open' },
];

interface Fixture {
    dir: string;
    dbPath: string;
    store: SqliteTableStorage;
    countOnDisk: (where: string) => number;
    cleanup: () => void;
}

async function fixture(): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-filter-strict-'));
    const dbPath = path.join(dir, 'tables.sqlite');
    const store = new SqliteTableStorage(dbPath, path.join(dir, 'schemas.json'));
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('orders', SEED.map(r => ({ ...r })));
    return {
        dir,
        dbPath,
        store,
        countOnDisk: (where: string) => {
            const db = new Database(dbPath, { readonly: true });
            try { return (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE ${where}`).get() as { n: number }).n; }
            finally { db.close(); }
        },
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
    };
}

/* ------------------------------------------------------------------ */
/*  The 3 tricky-filter shapes the finding names                       */
/* ------------------------------------------------------------------ */

const TRICKY: Array<{ label: string; filter: unknown; badKey: string }> = [
    { label: 'typo key alongside a real leaf', filter: { eqq: { id: 'r1' }, eq: { status: 'closed' } }, badKey: 'eqq' },
    { label: 'misspelled operator inside and[]', filter: { and: [{ eqx: { id: 'r1' } }, { eq: { status: 'closed' } }] }, badKey: 'eqx' },
    { label: "miscased key ('EQ' not 'eq')", filter: { EQ: { id: 'r1' } }, badKey: 'EQ' },
];

/* ------------------------------------------------------------------ */
/*  MCP path — real registerCollectionTools registration               */
/* ------------------------------------------------------------------ */

type McpToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function captureRegisteredTools(store: SqliteTableStorage): Record<string, McpToolHandler> {
    const tools: Record<string, McpToolHandler> = {};
    const server = { tool(name: string, _desc: string, _schema: unknown, fn: McpToolHandler) { tools[name] = fn; } };
    registerCollectionTools(server as never, { tableStorage: store });
    return tools;
}

async function mcpAttack(toolName: string, args: Record<string, unknown>, badKey: string, f: Fixture) {
    const tools = captureRegisteredTools(f.store);
    const result = await tools[toolName]!({ collection: 'orders', workspace: 'ws-test', ...args });
    assert.equal(result.isError, true, `${toolName} must return isError:true, got: ${JSON.stringify(result)}`);
    const body = JSON.parse(result.content[0]!.text) as { error?: string; message?: string };
    assert.equal(body.error, 'filter_invalid', `${toolName} error code`);
    assert.match(body.message ?? '', new RegExp(`"${badKey}"`), `${toolName} message must name "${badKey}", got: ${body.message}`);
}

for (const { label, filter, badKey } of TRICKY) {
    test(`collection_update MCP: ${label} -> filter_invalid naming "${badKey}", no row mutated`, async () => {
        const f = await fixture();
        try {
            await mcpAttack('collection_update', { filter, updates: { amount: 999 } }, badKey, f);
            assert.equal(f.countOnDisk('amount = 999'), 0);
        } finally { f.cleanup(); }
    });

    test(`collection_delete MCP: ${label} -> filter_invalid naming "${badKey}", no row deleted`, async () => {
        const f = await fixture();
        try {
            await mcpAttack('collection_delete', { filter }, badKey, f);
            assert.equal(f.countOnDisk('1=1'), 3);
        } finally { f.cleanup(); }
    });

    test(`collection_update_by_query MCP: ${label} -> filter_invalid naming "${badKey}", no row mutated`, async () => {
        const f = await fixture();
        try {
            await mcpAttack('collection_update_by_query', { filter, fields: { amount: 999 } }, badKey, f);
            assert.equal(f.countOnDisk('amount = 999'), 0);
        } finally { f.cleanup(); }
    });

    test(`collection_delete_by_query MCP: ${label} -> filter_invalid naming "${badKey}", no row deleted`, async () => {
        const f = await fixture();
        try {
            await mcpAttack('collection_delete_by_query', { filter }, badKey, f);
            assert.equal(f.countOnDisk('1=1'), 3);
        } finally { f.cleanup(); }
    });
}

/* ------------------------------------------------------------------ */
/*  REST path — real http.Server over tryCollectionsRoutes             */
/* ------------------------------------------------------------------ */

async function startServer(store: SqliteTableStorage) {
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await tryCollectionsRoutes(req, res, url, pathname, { tableStorage: store });
        if (!handled) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
    };
}

async function fetchJson(url: string, init: { method: string; body?: unknown }) {
    const res = await fetch(url, {
        method: init.method,
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: body as { code?: string; message?: string } };
}

async function restAttack(
    method: string,
    urlSuffix: string,
    body: unknown,
    badKey: string,
    f: Fixture,
) {
    const srv = await startServer(f.store);
    try {
        const r = await fetchJson(`${srv.baseUrl}/v1/orders${urlSuffix}`, { method, body });
        assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'filter_invalid');
        assert.match(r.body.message ?? '', new RegExp(`"${badKey}"`), `message must name "${badKey}", got: ${r.body.message}`);
    } finally { await srv.close(); }
}

for (const { label, filter, badKey } of TRICKY) {
    test(`PUT /v1/orders REST: ${label} -> 400 filter_invalid naming "${badKey}", no row mutated`, async () => {
        const f = await fixture();
        try {
            await restAttack('PUT', '', { filter, updates: { amount: 999 } }, badKey, f);
            assert.equal(f.countOnDisk('amount = 999'), 0);
        } finally { f.cleanup(); }
    });

    test(`DELETE /v1/orders REST: ${label} -> 400 filter_invalid naming "${badKey}", no row deleted`, async () => {
        const f = await fixture();
        try {
            await restAttack('DELETE', '', { filter }, badKey, f);
            assert.equal(f.countOnDisk('1=1'), 3);
        } finally { f.cleanup(); }
    });

    test(`PUT /v1/orders/update-by-query REST: ${label} -> 400 filter_invalid naming "${badKey}", no row mutated`, async () => {
        const f = await fixture();
        try {
            await restAttack('PUT', '/update-by-query', { filter, fields: { amount: 999 } }, badKey, f);
            assert.equal(f.countOnDisk('amount = 999'), 0);
        } finally { f.cleanup(); }
    });

    test(`DELETE /v1/orders/delete-by-query REST: ${label} -> 400 filter_invalid naming "${badKey}", no row deleted`, async () => {
        const f = await fixture();
        try {
            await restAttack('DELETE', '/delete-by-query', { filter }, badKey, f);
            assert.equal(f.countOnDisk('1=1'), 3);
        } finally { f.cleanup(); }
    });
}

/* ------------------------------------------------------------------ */
/*  No empty-leaf-after-strip: an all-unrecognized filter is REJECTED,  *
 *  not silently turned into `{}` and refused as merely "all/empty".   */
/* ------------------------------------------------------------------ */

test('collection_update MCP: an entirely-unrecognized filter ({EQQ:{...}}) is filter_invalid, not all_filter_refused', async () => {
    const f = await fixture();
    try {
        const tools = captureRegisteredTools(f.store);
        const result = await tools['collection_update']!({
            collection: 'orders', workspace: 'ws-test',
            filter: { EQQ: { id: 'r1' } }, updates: { amount: 999 },
        });
        assert.equal(result.isError, true);
        const body = JSON.parse(result.content[0]!.text) as { error?: string };
        assert.equal(body.error, 'filter_invalid');
        assert.notEqual(body.error, 'all_filter_refused');
        assert.equal(f.countOnDisk('amount = 999'), 0);
    } finally { f.cleanup(); }
});

test('DELETE /v1/orders REST: an entirely-unrecognized filter ({EQQ:{...}}) is filter_invalid, not all_filter_refused', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'DELETE', body: { filter: { EQQ: { id: 'r1' } } } });
            assert.equal(r.status, 400);
            assert.equal(r.body.code, 'filter_invalid');
            assert.notEqual(r.body.code, 'all_filter_refused');
            assert.equal(f.countOnDisk('1=1'), 3);
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Valid filters are unaffected — every surface still scopes/mutates  *
 *  exactly the intended row.                                          */
/* ------------------------------------------------------------------ */

test('collection_update MCP: a valid scoped filter still updates exactly 1 row', async () => {
    const f = await fixture();
    try {
        const tools = captureRegisteredTools(f.store);
        const result = await tools['collection_update']!({
            collection: 'orders', workspace: 'ws-test',
            filter: { eq: { id: 'r1' } }, updates: { amount: 999 },
        });
        assert.equal(result.isError, undefined);
        assert.equal(f.countOnDisk('amount = 999'), 1);
        assert.equal(f.countOnDisk("id = 'r1' AND amount = 999"), 1);
    } finally { f.cleanup(); }
});

test('collection_delete MCP: a valid scoped filter still deletes exactly 1 row', async () => {
    const f = await fixture();
    try {
        const tools = captureRegisteredTools(f.store);
        const result = await tools['collection_delete']!({
            collection: 'orders', workspace: 'ws-test',
            filter: { eq: { id: 'r1' } },
        });
        assert.equal(result.isError, undefined);
        assert.equal(f.countOnDisk('1=1'), 2);
        assert.equal(f.countOnDisk("id = 'r1'"), 0);
    } finally { f.cleanup(); }
});

test('collection_update_by_query MCP: a valid nested and[] filter still updates exactly 1 row', async () => {
    const f = await fixture();
    try {
        const tools = captureRegisteredTools(f.store);
        const result = await tools['collection_update_by_query']!({
            collection: 'orders', workspace: 'ws-test',
            filter: { and: [{ eq: { id: 'r1' } }, { eq: { status: 'closed' } }] },
            fields: { amount: 999 },
        });
        assert.equal(result.isError, undefined);
        assert.equal(f.countOnDisk('amount = 999'), 1);
    } finally { f.cleanup(); }
});

test('collection_delete_by_query MCP: a valid scoped filter still deletes exactly 1 row', async () => {
    const f = await fixture();
    try {
        const tools = captureRegisteredTools(f.store);
        const result = await tools['collection_delete_by_query']!({
            collection: 'orders', workspace: 'ws-test',
            filter: { eq: { id: 'r1' } },
        });
        assert.equal(result.isError, undefined);
        assert.equal(f.countOnDisk('1=1'), 2);
    } finally { f.cleanup(); }
});

test('PUT /v1/orders REST: a valid scoped filter still updates exactly 1 row', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders`, {
                method: 'PUT', body: { filter: { eq: { id: 'r1' } }, updates: { amount: 999 } },
            });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(f.countOnDisk('amount = 999'), 1);
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

test('DELETE /v1/orders REST: a valid scoped filter still deletes exactly 1 row', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders`, { method: 'DELETE', body: { filter: { eq: { id: 'r1' } } } });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(f.countOnDisk('1=1'), 2);
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

test('PUT /v1/orders/update-by-query REST: a valid and[] filter still updates exactly 1 row', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders/update-by-query`, {
                method: 'PUT',
                body: { filter: { and: [{ eq: { id: 'r1' } }, { eq: { status: 'closed' } }] }, fields: { amount: 999 } },
            });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(f.countOnDisk('amount = 999'), 1);
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

test('DELETE /v1/orders/delete-by-query REST: a valid scoped filter still deletes exactly 1 row', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders/delete-by-query`, {
                method: 'DELETE', body: { filter: { eq: { id: 'r1' } } },
            });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(f.countOnDisk('1=1'), 2);
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Reads (query/count) — lower risk, but the finding asks for the      *
 *  same strict schema on the REST surface for consistency.            */
/* ------------------------------------------------------------------ */

test('POST /v1/orders/query REST: a filter with an unrecognized key is 400 filter_invalid, not silently narrowed', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders/query`, {
                method: 'POST', body: { filter: { eqq: { id: 'r1' }, eq: { status: 'closed' } } },
            });
            assert.equal(r.status, 400, JSON.stringify(r.body));
            assert.equal(r.body.code, 'filter_invalid');
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

test('POST /v1/orders/count REST: a filter with an unrecognized key is 400 filter_invalid, not silently narrowed', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders/count`, {
                method: 'POST', body: { filter: { eqq: { id: 'r1' }, eq: { status: 'closed' } } },
            });
            assert.equal(r.status, 400, JSON.stringify(r.body));
            assert.equal(r.body.code, 'filter_invalid');
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

test('POST /v1/orders/query REST: a valid filter still queries normally', async () => {
    const f = await fixture();
    try {
        const srv = await startServer(f.store);
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/orders/query`, {
                method: 'POST', body: { filter: { eq: { id: 'r1' } } },
            });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal((r.body as unknown as { records: unknown[] }).records.length, 1);
        } finally { await srv.close(); }
    } finally { f.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
