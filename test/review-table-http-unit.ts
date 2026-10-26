#!/usr/bin/env tsx
/**
 * test/review-table-http-unit.ts - /api/table-review/* through a REAL http.Server on an ephemeral port running the
 * production dispatcher, tokens minted through the real registry, REAL Postgres table storage built by the production
 * factory (createStorageClient + LocalGraphRegistry over a workspaces.json).
 *
 *   read token   queue/settings/aliases/unresolved ok, 403 on confirm/correct/alias add/remove
 *   write token  403 on every act route (write does not imply review)
 *   review token confirm/correct/alias add/remove work and the effect is visible through the library API + executePlan
 *   workspace A token cannot see or act on workspace B; a foreign value id inside its own workspace is 404
 *   SQLite workspace => 404 table_review_unavailable; bounds (limit, cursor, ids, body size) enforced; no SQL in errors
 *
 * Throwaway database `lore_gate_tbl_review_http`; skips with a printed reason when LORE_PG_URL is unset.
 *   LORE_PG_URL=postgres://... LORE_MODEL_SERVER=0 npx tsx test/review-table-http-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { gateDbUrl } from './helpers/testPostgres.js';
import { setupReviewHome, startReviewHttp } from './helpers/reviewHttp.js';

const DB = 'lore_gate_tbl_review_http';
const gate = gateDbUrl();
if (!gate) { console.log('SKIP review-table-http: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

const home = setupReviewHome('lore-review-table-');
const WS_A = 'pg-gate-rhttp-a', WS_B = 'pg-gate-rhttp-b', WS_SQ = 'pg-gate-rhttp-sq';
const wsPath = (n: string): string => path.join(home, 'workspaces', n);
for (const n of [WS_A, WS_B, WS_SQ]) fs.mkdirSync(path.join(wsPath(n), '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1, active: WS_A,
    workspaces: [
        { name: WS_A, path: wsPath(WS_A), graphEngine: 'postgres' }, { name: WS_B, path: wsPath(WS_B), graphEngine: 'postgres' },
        { name: WS_SQ, path: wsPath(WS_SQ), graphEngine: 'sqlite' },
    ],
}));

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const prevPg = process.env['LORE_PG_URL'];
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
process.env['LORE_PG_URL'] = dbUrl.toString();
const { createStorageClient } = await import('../packages/lore/src/mcp/storageBundle.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { closeSharedPostgresPool } = await import('../packages/lore/src/engines/postgres/postgresPoolOwner.js');
const { executePlan } = await import('../packages/lore/src/query/executePlan.js');
const { tableReviewFor } = await import('../packages/lore/src/query/tableReview.js');
type ITableStorage = import('../packages/lore/src/contracts/tables.js').ITableStorage;

const fakeGraph = { listNodes: async () => [] } as never;
const fakeVerbatim = { bulkUpsertPrebuiltRows: () => undefined, handleCount: () => 0, tombstone: () => undefined } as never;
const prov = (confidence: number, needsReview?: boolean): Record<string, unknown> =>
    ({ sourceDocumentId: 'lease-001.pdf', sourcePage: 2, verifiedQuote: 'Tenant: Acme', confidence, ...(needsReview === undefined ? {} : { needsReview }), extractor: 'ai-api/1', contract: 'B/1', extractedAt: '2026-10-01T00:00:00Z' });
const LEASES = { name: 'leases', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'tenant', type: 'string' }, { name: 'rent', type: 'integer' }] };

const registry = new LocalGraphRegistry({ autoEvict: false, home });
const open: ITableStorage[] = [];
let srv: Awaited<ReturnType<typeof startReviewHttp>> | null = null;
try {
    const bundleStore: any = await createStorageClient(fakeGraph, fakeVerbatim, 'local', wsPath(WS_A), { workspace: WS_A, home });
    const tsA: ITableStorage = bundleStore.tableStorage; open.push(tsA);
    const tsB = await registry.tableStorageFor(WS_B);
    const ins = (t: any, row: unknown, p: unknown) => t.insert('leases', row, { provenance: p });
    await tsA.createTable(LEASES as never);
    await ins(tsA, { id: 'a', tenant: 'Acme', rent: 1000 }, { tenant: prov(0.95), rent: prov(0.9, true) });
    await ins(tsA, { id: 'b', tenant: 'Beta Corp', rent: 2000 }, { tenant: prov(0.4) });
    await ins(tsA, { id: 'c', tenant: 'Clean', rent: 5 }, { tenant: prov(0.99) });
    await tsB.createTable(LEASES as never);
    await ins(tsB, { id: 'x', tenant: 'Other Co', rent: 7 }, { tenant: prov(0.2) });
    const rvA = await tableReviewFor(tsA);
    const rvB = await tableReviewFor(tsB);
    const queueA = (await rvA.listQueue()).items;
    const bValueId = (await rvB.listQueue()).items[0]!.valueId;
    const find = (rowKey: string, field: string) => queueA.find((i) => i.rowKey === rowKey && i.field === field)!;

    srv = await startReviewHttp({ home, store: bundleStore, graphRegistry: registry, activeWorkspace: WS_A });
    const s = srv;
    const reader = s.mint(WS_A, ['read']);
    const writer = s.mint(WS_A, ['read', 'write']);
    const reviewer = s.mint(WS_A, ['read', 'review']);
    const bToken = s.mint(WS_B, ['read', 'review']);
    const sqToken = s.mint(WS_SQ, ['read', 'review']);
    const q = (p: string, ws = WS_A) => `${p}${p.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(ws)}`;
    const plan = { steps: [{ op: 'filter', type: 'leases', where: [] }, { op: 'order', by: [{ alias: 'leases', field: 'id' }] }] };
    const NOW = new Date('2026-06-01T12:00:00.000Z');

    console.log('\nreview-table-http\n');

    await test('read token: settings, queue (filtered + paged), aliases, unresolved', async () => {
        const st = await s.call(reader, 'GET', q('/api/table-review/settings'));
        assert.equal(st.status, 200, st.text); assert.equal(st.json.settings.reviewConfidenceThreshold, 0.8); assert.equal(st.json.workspace, WS_A);
        const all = await s.call(reader, 'GET', q('/api/table-review/queue'));
        assert.equal(all.status, 200, all.text);
        assert.deepEqual(all.json.items.map((i: any) => `${i.rowKey}.${i.field}`).sort(), ['a.rent', 'b.tenant']);
        const p1 = await s.call(reader, 'GET', q('/api/table-review/queue?limit=1&table=leases'));
        assert.equal(p1.json.items.length, 1);
        const cursor = p1.json.nextCursor ?? p1.json.cursor;
        assert.ok(cursor, `a cursor is returned for the next page: ${p1.text}`);
        const p2 = await s.call(reader, 'GET', q(`/api/table-review/queue?limit=1&cursor=${encodeURIComponent(cursor)}`));
        assert.equal(p2.status, 200, p2.text); assert.equal(p2.json.items.length, 1);
        assert.notEqual(p2.json.items[0].valueId, p1.json.items[0].valueId);
        const lowOnly = await s.call(reader, 'GET', q('/api/table-review/queue?maxConfidence=0.5'));
        assert.deepEqual(lowOnly.json.items.map((i: any) => `${i.rowKey}.${i.field}`), ['b.tenant']);
        assert.equal((await s.call(reader, 'GET', q('/api/table-review/aliases'))).status, 200);
        const un = await s.call(reader, 'GET', q('/api/table-review/unresolved?table=leases&field=tenant'));
        assert.equal(un.status, 200, un.text); assert.ok(un.json.items.length >= 1);
    });
    await test('read token (and read+write) cannot confirm, correct, add or remove an alias: 403, nothing changed', async () => {
        const v = find('b', 'tenant').valueId;
        for (const tok of [reader, writer]) {
            for (const [m, p, b] of [
                ['POST', '/api/table-review/confirm', { valueId: v }], ['POST', '/api/table-review/correct', { valueId: v, value: 'Beta Corporation' }],
                ['POST', '/api/table-review/aliases', { table: 'leases', field: 'tenant', canonical: 'Acme', alias: 'ACME Inc' }],
                ['DELETE', '/api/table-review/aliases/1', undefined],
            ] as const) {
                const r = await s.call(tok, m, q(p), b);
                assert.equal(r.status, 403, `${m} ${p}: ${r.text}`);
            }
        }
        assert.equal((await rvA.listQueue()).items.length, 2);
        assert.equal((await rvA.listAliases({})).items.filter((i: any) => !i.isCanonical).length, 0);
    });
    await test('the threshold is read-only over HTTP (no PUT/POST route)', async () => {
        for (const m of ['PUT', 'POST', 'PATCH']) assert.ok([404, 405].includes((await s.call(reviewer, m, q('/api/table-review/settings'), {})).status), m);
        assert.equal((await rvA.getSettings()).reviewConfidenceThreshold, 0.8);
    });
    await test('workspace B token cannot read or act on workspace A; its own workspace never shows A rows; A value id is 404 there', async () => {
        for (const [m, p, b] of [
            ['GET', '/api/table-review/queue', undefined], ['GET', '/api/table-review/settings', undefined], ['GET', '/api/table-review/aliases', undefined],
            ['POST', '/api/table-review/confirm', { valueId: find('b', 'tenant').valueId }], ['DELETE', '/api/table-review/aliases/1', undefined],
        ] as const) assert.equal((await s.call(bToken, m, q(p, WS_A), b)).status, 403, `${m} ${p}`);
        const own = await s.call(bToken, 'GET', q('/api/table-review/queue', WS_B));
        assert.equal(own.status, 200, own.text); assert.deepEqual(own.json.items.map((i: any) => i.rowKey), ['x']);
        const foreign = await s.call(bToken, 'POST', q('/api/table-review/confirm', WS_B), { valueId: find('b', 'tenant').valueId });
        assert.equal(foreign.status, 404, foreign.text);
        const foreignCorrect = await s.call(bToken, 'POST', q('/api/table-review/correct', WS_B), { valueId: find('b', 'tenant').valueId, value: 'HIJACK' });
        assert.equal(foreignCorrect.status, 404);
        assert.equal((await rvA.listQueue()).items.length, 2, 'A is untouched');
        // and the other direction: A's reviewer cannot touch B's value
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/confirm', WS_B), { valueId: bValueId })).status, 403);
        assert.equal((await rvB.listQueue()).items.length, 1);
    });
    await test('bounds: limit, cursor, maxConfidence, ids, missing fields, bad JSON, body size, unknown value id', async () => {
        for (const [p, st] of [
            ['/api/table-review/queue?limit=100000', 400], ['/api/table-review/queue?limit=0', 400], ['/api/table-review/queue?limit=abc', 400],
            ['/api/table-review/queue?maxConfidence=7', 400], ['/api/table-review/queue?maxConfidence=x', 400],
            ['/api/table-review/queue?cursor=' + 'z'.repeat(2000), 400], ['/api/table-review/queue?cursor=not-a-cursor', 400],
            ['/api/table-review/queue?table=' + 't'.repeat(2000), 400], ['/api/table-review/unresolved', 400], ['/api/table-review/aliases?includeRemoved=maybe', 400],
        ] as const) { const r = await s.call(reader, 'GET', q(p)); assert.equal(r.status, st, `${p}: ${r.text}`); }
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/confirm'), { valueId: "1; DROP TABLE x" })).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/confirm'), {})).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/correct'), { valueId: '1' })).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/correct'), { valueId: '1', value: 'x', sourcePage: -3 })).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/aliases'), { table: 'leases' })).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/confirm'), undefined, '{oops')).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/confirm'), { valueId: '1', pad: 'p'.repeat(200 * 1024) })).status, 413);
        assert.equal((await s.call(reviewer, 'POST', q('/api/table-review/confirm'), { workspace: WS_B, valueId: '1' })).status, 400, 'query/body workspace mismatch');
        assert.equal((await s.call(reviewer, 'DELETE', q('/api/table-review/aliases/abc'))).status, 400);
        const unknown = await s.call(reviewer, 'POST', q('/api/table-review/confirm'), { valueId: '999999999' });
        assert.equal(unknown.status, 404, unknown.text);
        assert.equal((await rvA.listQueue()).items.length, 2, 'no rejected call changed anything');
    });
    await test('errors carry no stack, SQL or paths', async () => {
        const rs = await Promise.all([
            s.call(reviewer, 'POST', q('/api/table-review/confirm'), { valueId: '999999999' }), s.call(reader, 'GET', q('/api/table-review/queue?cursor=not-a-cursor')),
            s.call(bToken, 'GET', q('/api/table-review/queue', WS_A)), s.call(reviewer, 'DELETE', q('/api/table-review/aliases/999999')),
        ]);
        for (const r of rs) assert.doesNotMatch(r.text, /\n\s+at |\.(ts|js):\d+|SELECT |INSERT |UPDATE |FROM |relation "|node_modules|\/Users\/|postgres:\/\//i, r.text);
    });
    await test('review token: correct one value and confirm another; the library API and executePlan reflect both', async () => {
        const tenantB = find('b', 'tenant'), rentA = find('a', 'rent');
        const c = await s.call(reviewer, 'POST', q('/api/table-review/correct'), { valueId: tenantB.valueId, value: 'Beta Corporation', verifiedQuote: 'Tenant: Beta Corporation' });
        assert.equal(c.status, 200, c.text);
        const ok = await s.call(reviewer, 'POST', q('/api/table-review/confirm'), { valueId: rentA.valueId });
        assert.equal(ok.status, 200, ok.text);
        assert.equal((await rvA.listQueue()).items.length, 0);
        const r: any = await executePlan(tsA, WS_A, plan, { now: NOW });
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.rows.map((x: any) => x.values['leases.tenant']), ['Acme', 'Beta Corporation', 'Clean']);
        assert.deepEqual(r.review, { threshold: 0.8, unreviewedRows: 0, totalRows: 3 });
        const again = await s.call(reviewer, 'POST', q('/api/table-review/confirm'), { valueId: rentA.valueId });
        assert.equal(again.status, 200, again.text); assert.equal(again.json.outcome.idempotent, true);
        assert.equal((await s.call(reader, 'GET', q('/api/table-review/queue'))).json.items.length, 0);
    });
    await test('review token: add an alias (201), repeat is idempotent (200), list shows it, DELETE soft-removes it', async () => {
        const body = { table: 'leases', field: 'tenant', canonical: 'Beta Corporation', alias: 'Beta Corp' };
        const add = await s.call(reviewer, 'POST', q('/api/table-review/aliases'), body);
        assert.equal(add.status, 201, add.text);
        const aliasId = String(add.json.record.aliasId);
        assert.match(aliasId, /^\d+$/, add.text);
        const rep = await s.call(reviewer, 'POST', q('/api/table-review/aliases'), body);
        assert.equal(rep.status, 200, rep.text);
        const spellings = async (opts: object) => (await rvA.listAliases(opts as never)).items.filter((i: any) => !i.isCanonical);
        assert.equal((await spellings({})).length, 1);
        const widened: any = await executePlan(tsA, WS_A, { steps: [{ op: 'filter', type: 'leases', where: [{ field: 'tenant', op: 'eq', value: 'Beta Corp' }] }] }, { now: NOW });
        assert.deepEqual(widened.rows.map((x: any) => x.values['leases.tenant']), ['Beta Corporation']);
        const del = await s.call(reviewer, 'DELETE', q(`/api/table-review/aliases/${aliasId}`));
        assert.equal(del.status, 200, del.text);
        assert.equal((await spellings({})).length, 0);
        assert.equal((await spellings({ includeRemoved: true })).length, 1, 'soft removal keeps the row');
        assert.equal((await s.call(reader, 'GET', q('/api/table-review/aliases?includeRemoved=true'))).json.items.filter((i: any) => !i.isCanonical).length, 1);
        // B cannot remove A's alias even by id inside its own workspace
        assert.equal((await s.call(bToken, 'DELETE', q(`/api/table-review/aliases/${aliasId}`, WS_B))).status, 404);
    });
    await test('a SQLite table-storage workspace answers 404 table_review_unavailable (view and act)', async () => {
        const g = await s.call(sqToken, 'GET', q('/api/table-review/queue', WS_SQ));
        assert.equal(g.status, 404, g.text); assert.equal(g.json.code, 'table_review_unavailable');
        const a = await s.call(sqToken, 'POST', q('/api/table-review/confirm', WS_SQ), { valueId: '1' });
        assert.equal(a.status, 404, a.text); assert.equal(a.json.code, 'table_review_unavailable');
    });
    await test('no token => 401; unknown route under the prefix falls through (404), not a crash', async () => {
        assert.equal((await fetch(`${s.base}${q('/api/table-review/queue')}`)).status, 401);
        assert.equal((await s.call(reader, 'GET', q('/api/table-review/nope'))).status, 404);
    });
} finally {
    await srv?.close();
    for (const t of open) await (t as unknown as { close?: () => Promise<void> | void }).close?.();
    await registry.disposeAll();
    await closeSharedPostgresPool();
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    if (prevPg === undefined) delete process.env['LORE_PG_URL']; else process.env['LORE_PG_URL'] = prevPg;
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
