#!/usr/bin/env tsx
/**
 * rest-adversarial-unit.ts — RC2 audit (2026-05-17) Phase 1.
 *
 * Each test pins down a finding from the live-daemon adversarial probe
 * that produced an HTTP 500 (crash leak) or 200 (silent acceptance) on
 * input that should have been rejected at the route boundary:
 *
 *   1. /v1//count           — empty collection segment must 404
 *   2. /v1/cre%2F..         — slashy collection name must 400
 *   3. /v1/{unknown}/count  — unknown collection must 404 (not 500 with
 *                             SqliteTableStorage internal message)
 *   4. /api/node POST       — non-string id/type/label must 400 (not
 *                             500 "p.trim is not a function")
 *   5. /api/config PATCH    — array/scalar body must 400 (not silently
 *                             coerced by configManager.patch)
 *   6. /api/orphan POST     — bogus `decision` string must 400 (not
 *                             silently fall through to 'reenabled')
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryCollectionsRoutes } from '../packages/lore/src/mcp/http/routes/collections.js';
import { tryConfigRoutes } from '../packages/lore/src/mcp/http/routes/config.js';
import { tryAdminRoutes } from '../packages/lore/src/mcp/http/routes/admin.js';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';
import type {
    ITableStorage,
    Row,
    TableOp,
    TableOpResult,
    TableSchema,
    TableSchemaSummary,
} from '../packages/lore/src/contracts/tables.js';
import type { Filter, FilterNode, FindOptions } from '../packages/lore/src/engines/collectionStorage.js';

/* ---------- minimal in-memory ITableStorage ---------- */

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
    async listTables(): Promise<TableSchemaSummary[]> {
        return Array.from(this.schemas.values()).map((schema) => ({
            name: schema.name,
            columns: schema.columns,
            primaryKey: schema.columns.find(c => c.primary)?.name ?? '',
            rowCount: this.rows.get(schema.name)?.size ?? 0,
        }));
    }
    private requireSchema(table: string, op: string): TableSchema {
        const s = this.schemas.get(table);
        if (!s) throw new Error(`FakeTableStorage.${op}: unknown table '${table}' (createTable first)`);
        return s;
    }
    async insert(table: string, row: Row): Promise<void> {
        this.requireSchema(table, 'insert');
        const tbl = this.rows.get(table)!;
        const pkCol = this.schemas.get(table)!.columns.find(c => c.primary)?.name;
        const key = pkCol ? row[pkCol] : JSON.stringify(row);
        tbl.set(key, { ...row });
    }
    async insertBatch(table: string, rows: Row[]): Promise<void> {
        for (const r of rows) await this.insert(table, r);
    }
    async query(table: string, _filter?: FilterNode, _opts?: FindOptions): Promise<Row[]> {
        this.requireSchema(table, 'query');
        return Array.from(this.rows.get(table)!.values());
    }
    async getByKey<T extends Row = Row>(table: string, key: unknown): Promise<T | null> {
        this.requireSchema(table, 'getByKey');
        return (this.rows.get(table)!.get(key) as T) ?? null;
    }
    async update(table: string, _filter: FilterNode, _patch: Partial<Row>): Promise<number> {
        this.requireSchema(table, 'update');
        return 0;
    }
    async delete(table: string, _filter: FilterNode): Promise<number> {
        this.requireSchema(table, 'delete');
        return 0;
    }
    async count(table: string, _filter?: FilterNode): Promise<number> {
        this.requireSchema(table, 'count');
        return this.rows.get(table)!.size;
    }
    async truncate(table: string): Promise<number> {
        this.requireSchema(table, 'truncate');
        const n = this.rows.get(table)!.size;
        this.rows.get(table)!.clear();
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
        try {
            for (const op of ops) {
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
                    if (await this.getByKey(op.collection, key)) {
                        await this.update(op.collection, { eq: { [pk!]: key } }, op.row);
                    } else {
                        await this.insert(op.collection, op.row);
                    }
                    results.push({ op: 'upsert', collection: op.collection, key });
                }
            }
            return results;
        } catch (error) {
            this.rows = before;
            throw error;
        }
    }
}

/* ---------- /v1 routes — run against a real http.Server ---------- */

async function startCollectionsServer(deps: { tableStorage: ITableStorage }): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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

/* ---------- /api/* routes — drive handlers directly ---------- */

function fakeReq(method: string, body: string): IncomingMessage {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req = {
        method,
        on(event: string, h: (...args: unknown[]) => void) {
            (handlers[event] ||= []).push(h);
            if (event === 'end') {
                setImmediate(() => {
                    (handlers['data'] ?? []).forEach((h2) => h2(Buffer.from(body)));
                    (handlers['end'] ?? []).forEach((h2) => h2());
                });
            }
            return this;
        },
    };
    return req as unknown as IncomingMessage;
}
type CapturedRes = ServerResponse & { _status: number; _body: string; _done: Promise<void> };
function fakeRes(): CapturedRes {
    let resolveDone!: () => void;
    const doneP = new Promise<void>((r) => { resolveDone = r; });
    const r = {
        _status: 0, _body: '', _done: doneP,
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; resolveDone(); },
    };
    return r as unknown as CapturedRes;
}

function orphanDeps(): Parameters<typeof tryConfigRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: {} as never,
        configManager: {
            read: () => ({ plugins: ['cre'] } as unknown as Record<string, unknown>),
            patch: (next: Record<string, unknown>) => next as unknown as Record<string, unknown>,
        } as never,
        pluginRegistry: {
            resolveOrphan: () => ({ plugins: [] }),
            getOrphanState: () => ({ orphans: [], blocking: false }),
        } as never,
    } as never;
}

function adminDeps(): Parameters<typeof tryAdminRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        pluginRegistry: {} as never,
        consentManager: {} as never,
        retentionSweeper: {} as never,
        archiveSink: {} as never,
        mcpClientRuntime: {} as never,
        connectorRegistry: {} as never,
        auditLog: { log: () => undefined } as never,
    } as never;
}

function searchDepsCapturingMax(): {
    deps: Parameters<typeof trySearchRoutes>[4];
    seen: { searchN?: number; verbatimN?: number };
} {
    const seen: { searchN?: number; verbatimN?: number } = {};
    const stubGraph = {
        search: async (_q: string, n: number) => { seen.searchN = n; return []; },
        listNodes: async () => [],
        getNode: async () => null,
    };
    const stubVerbatim = {
        count: async () => 0,
        search: async (_q: string, n: number) => { seen.verbatimN = n; return []; },
    };
    return {
        seen,
        deps: {
            deploymentMode: 'local',
            dataplane: null,
            store: {
                loreGraph: stubGraph,
                loreVerbatim: stubVerbatim,
                storageClient: {
                    verbatimCount: async () => 0,
                    verbatimSearch: async (_q: string, _n: number) => [],
                } as never,
            } as never,
            detectedScope: { workspace: 'test', ecosystem: 'test' },
        } as never,
    };
}

function configPatchDeps(): Parameters<typeof tryConfigRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: { reconfigureCache: () => undefined } } as never,
        configManager: {
            read: () => ({ llmProvider: 'ollama' } as unknown as Record<string, unknown>),
            patch: (next: Record<string, unknown>) => ({ llmProvider: 'ollama', ...next }) as unknown as Record<string, unknown>,
        } as never,
        pluginRegistry: {} as never,
    } as never;
}

/* ---------- /api/node POST — minimal local stubs for the upsert path ---------- */
// The route deps shape is large; we lift the relevant fix-path checks
// by exercising the route file via a slim deps stub and verifying that
// the new 400-validation short-circuit fires *before* any graph call.

async function postNodeWith(body: unknown): Promise<{ status: number; body: string }> {
    const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
    const res = fakeRes();
    const calls: string[] = [];
    const stub = {
        deploymentMode: 'local' as const,
        dataplane: null,
        store: {
            loreGraph: {
                upsertNode: async () => { calls.push('upsertNode'); throw new Error('upsertNode should not be reached'); },
            },
            loreVerbatim: { store: async () => undefined },
        } as never,
        loreHome: '/tmp/lore-rest-adv',
        pluginRegistry: {} as never,
    } as unknown as Parameters<typeof tryNodesRoutes>[4];
    await tryNodesRoutes(
        fakeReq('POST', JSON.stringify(body)),
        res,
        '/api/node',
        '/api/node',
        stub,
    );
    await res._done;
    assert.equal(calls.length, 0, 'upsertNode must not be called for invalid input');
    return { status: res._status, body: res._body };
}

/* ---------- runner ---------- */

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('rest-adversarial-unit (RC2 audit Phase 1)');
    console.log('\n/v1 collection routing');

    await test('/v1//count → 404 unknown_v1_path (empty segment, not insert into "count")', async () => {
        const srv = await startCollectionsServer({ tableStorage: new FakeTableStorage() });
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1//count`, { method: 'POST', body: {} });
            assert.equal(r.status, 404);
            assert.equal((r.body as { code: string }).code, 'unknown_v1_path');
        } finally { await srv.close(); }
    });

    await test('/v1/cre%2F../count → 400 invalid_collection_name (path-y name)', async () => {
        const srv = await startCollectionsServer({ tableStorage: new FakeTableStorage() });
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/cre%2F../count`, { method: 'POST', body: {} });
            assert.equal(r.status, 400);
            assert.equal((r.body as { code: string }).code, 'invalid_collection_name');
        } finally { await srv.close(); }
    });

    await test('/v1/{unknown}/count → 404 collection_not_found (not 500 with sqlite leak)', async () => {
        const srv = await startCollectionsServer({ tableStorage: new FakeTableStorage() });
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/nonexistent_xyz/count`, { method: 'POST', body: { filter: {} } });
            assert.equal(r.status, 404);
            const b = r.body as { code: string; message: string };
            assert.equal(b.code, 'collection_not_found');
            assert.doesNotMatch(b.message, /FakeTableStorage|createTable/);
        } finally { await srv.close(); }
    });

    await test('/v1/{unknown}/query → 404 collection_not_found', async () => {
        const srv = await startCollectionsServer({ tableStorage: new FakeTableStorage() });
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/nope_xyz/query`, { method: 'POST', body: {} });
            assert.equal(r.status, 404);
            assert.equal((r.body as { code: string }).code, 'collection_not_found');
        } finally { await srv.close(); }
    });

    await test('/v1/cre_tenant/count (existing collection) → 200', async () => {
        const store = new FakeTableStorage();
        await store.createTable({ name: 'cre_tenant', columns: [{ name: 'id', type: 'string', primary: true }] });
        const srv = await startCollectionsServer({ tableStorage: store });
        try {
            const r = await fetchJson(`${srv.baseUrl}/v1/cre_tenant/count`, { method: 'POST', body: {} });
            assert.equal(r.status, 200);
        } finally { await srv.close(); }
    });

    console.log('\n/api/node POST type confusion');

    await test('label as array → 400 (not 500 crash from .trim)', async () => {
        const r = await postNodeWith({ id: 'x', type: 'note', label: ['a', 'b'] });
        assert.equal(r.status, 400);
        assert.match(r.body, /must be strings/);
    });

    await test('id as object → 400', async () => {
        const r = await postNodeWith({ id: { nested: true }, type: 'note', label: 'x' });
        assert.equal(r.status, 400);
        assert.match(r.body, /must be strings/);
    });

    await test('body as array → 400 (not destructured as if object)', async () => {
        const r = await postNodeWith([1, 2, 3]);
        assert.equal(r.status, 400);
        assert.match(r.body, /must be a JSON object/);
    });

    console.log('\n/api/orphan POST decision-enum validation');

    await test('decision="deletealldata" → 400 (was silently mapped to reenabled)', async () => {
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'foo', decision: 'deletealldata' })),
            res, '/api/orphan', '/api/orphan', orphanDeps(),
        );
        await res._done;
        assert.equal(res._status, 400);
        assert.match(res._body, /decision must be one of/);
    });

    await test('decision="reenable" (valid) → 200', async () => {
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'foo', decision: 'reenable' })),
            res, '/api/orphan', '/api/orphan', orphanDeps(),
        );
        await res._done;
        assert.equal(res._status, 200);
    });

    await test('legacy plugin field still accepted (back-compat) → 200', async () => {
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ plugin: 'foo', decision: 'keep' })),
            res, '/api/orphan', '/api/orphan', orphanDeps(),
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string };
        assert.equal(out.resolved, 'foo');
    });

    console.log('\n/api/config PATCH non-object rejection');

    await test('body = [1,2,3] → 400 (was coerced)', async () => {
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('PATCH', JSON.stringify([1, 2, 3])),
            res, '/api/config', '/api/config', configPatchDeps(),
        );
        await res._done;
        assert.equal(res._status, 400);
        assert.match(res._body, /must be a JSON object/);
    });

    await test('body = true → 400', async () => {
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('PATCH', 'true'),
            res, '/api/config', '/api/config', configPatchDeps(),
        );
        await res._done;
        assert.equal(res._status, 400);
    });

    await test('body = {plugins: ["cre"]} (valid) → 200', async () => {
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('PATCH', JSON.stringify({ plugins: ['cre'] })),
            res, '/api/config', '/api/config', configPatchDeps(),
        );
        await res._done;
        assert.equal(res._status, 200);
    });

    console.log('\n/api/connectors/filesystem/paths PATCH — non-string filter');

    // RC2 audit: ingestion-root saver wrote to disk; sandbox LORE_HOME
    // for these tests so they cannot leak state into the real Lore
    // home or pick up its existing roots.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rest-adv-'));
    const prevHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = tmpHome;
    try {
        await test('roots=[null,"/tmp"] → 400 (no longer silently drops null)', async () => {
            const res = fakeRes();
            await tryAdminRoutes(
                fakeReq('PATCH', JSON.stringify({ roots: [null, '/tmp'] })),
                res, '/api/connectors/filesystem/paths', '/api/connectors/filesystem/paths', adminDeps(),
            );
            await res._done;
            assert.equal(res._status, 400);
            assert.match(res._body, /roots\[0\] must be a non-empty string/);
        });

        await test('roots=[42,"/tmp"] → 400', async () => {
            const res = fakeRes();
            await tryAdminRoutes(
                fakeReq('PATCH', JSON.stringify({ roots: [42, '/tmp'] })),
                res, '/api/connectors/filesystem/paths', '/api/connectors/filesystem/paths', adminDeps(),
            );
            await res._done;
            assert.equal(res._status, 400);
        });

        // NW-1a: "/tmp" used to be accepted as a valid root (this test
        // originally asserted 200). After the isWatchRootSafe guard is
        // applied to the PATCH route, only paths strictly under the user's
        // home are accepted. Use ~/lore-rest-adv-keep to exercise the
        // success path.
        const homeDir = os.homedir();
        const okRoot = path.join(homeDir, 'lore-rest-adv-keep');
        await test('roots=[<under-home>] (all strings, valid) → 200', async () => {
            const res = fakeRes();
            await tryAdminRoutes(
                fakeReq('PATCH', JSON.stringify({ roots: [okRoot] })),
                res, '/api/connectors/filesystem/paths', '/api/connectors/filesystem/paths', adminDeps(),
            );
            await res._done;
            assert.equal(res._status, 200);
        });
    } finally {
        if (prevHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }

    console.log('\n/api/recall — max clamp');

    await test('max=99999 → clamped to 100 (was unbounded)', async () => {
        const { deps, seen } = searchDepsCapturingMax();
        const res = fakeRes();
        await trySearchRoutes(
            fakeReq('GET', ''),
            res,
            '/api/recall?topic=t&max=99999&workspace=dev',
            '/api/recall',
            deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        assert.equal(seen.searchN, 100, 'graph.search should see clamped max');
    });

    await test('max=-1 → falls back to default (8)', async () => {
        const { deps, seen } = searchDepsCapturingMax();
        const res = fakeRes();
        await trySearchRoutes(
            fakeReq('GET', ''),
            res,
            '/api/recall?topic=t&max=-1&workspace=dev',
            '/api/recall',
            deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        assert.equal(seen.searchN, 8);
    });

    await test('max=abc → falls back to default (8)', async () => {
        const { deps, seen } = searchDepsCapturingMax();
        const res = fakeRes();
        await trySearchRoutes(
            fakeReq('GET', ''),
            res,
            '/api/recall?topic=t&max=abc&workspace=dev',
            '/api/recall',
            deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        assert.equal(seen.searchN, 8);
    });

    console.log('\nbody-reader size cap (DoS guard)');

    // RC2 audit (2026-05-17) Phase 1: ~26 inline `req.on('data')`
    // handlers across the route family had no size cap, exposing a
    // bearer-gated DoS surface (a glitching client looping uploads, a
    // misconfigured Loom dispatch, etc.). The bounded helper caps every
    // route at MAX_BODY_BYTES (10 MB) and returns 413 cleanly.
    await test('/v1/{collection} POST 12 MB body → 413, not OOM', async () => {
        const srv = await startCollectionsServer({ tableStorage: new FakeTableStorage() });
        try {
            const huge = 'A'.repeat(12 * 1024 * 1024);
            const r = await fetch(`${srv.baseUrl}/v1/cre_tenant`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: 'x', blob: huge }),
            });
            assert.equal(r.status, 413, 'oversize must surface as 413, not 200 or 500');
            const body = await r.json() as { code?: string };
            assert.equal(body.code, 'payload_too_large');
        } finally { await srv.close(); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
