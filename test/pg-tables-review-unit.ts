#!/usr/bin/env tsx
/**
 * test/pg-tables-review-unit.ts - the review queue on PostgresTableStorage (Tables, Wave D lane d3).
 *
 *   queue      needs_review rows and below-threshold rows, filters (table / field / document / confidence), cursor
 *              pagination, per-workspace threshold, workspace isolation
 *   confirm    new reviewed row supersedes the extractor row (never updated in place, never deleted), idempotent,
 *              two reviewers -> one winner + a clear conflict
 *   correct    new value row, plan/read sees it, primary-key correction refused, history keeps every version
 *   sqlite     tableReviewFor() says "not supported" with a typed error
 *
 * Throwaway database `lore_gate_tbl_review` on the LORE_PG_URL server (skips with a printed reason when unset).
 * Run: npx tsx test/pg-tables-review-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { tableReviewFor, TableReviewError, DEFAULT_REVIEW_THRESHOLD } from '../packages/lore/src/query/tableReview.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_review';
const WS = 'pg-gate-review-a';
const WS2 = 'pg-gate-review-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-review: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
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

await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

const LEASES: TableSchema = { name: 'leases', columns: [
    { name: 'id', type: 'string', primary: true }, { name: 'tenant', type: 'string' }, { name: 'rent', type: 'money' }, { name: 'term', type: 'integer' }] };
const prov = (doc: string, confidence: number, needsReview: boolean | undefined = undefined): Record<string, unknown> =>
    ({ sourceDocumentId: doc, sourcePage: 2, verifiedQuote: 'q', confidence, ...(needsReview === undefined ? {} : { needsReview }), extractor: 'ai-api/1', contract: 'B/1', extractedAt: '2026-10-01T00:00:00Z' });

try {
    const t = await PostgresTableStorage.open(WS, pool);
    const other = await PostgresTableStorage.open(WS2, pool);
    await t.createTable(LEASES);
    await other.createTable(LEASES);
    const api = t.reviewApi();
    const otherApi = other.reviewApi();

    // l1: flagged; l2: confident (0.95); l3: unflagged but low confidence (0.5); l4: flagged, other document; l5: no provenance
    await t.insert('leases', { id: 'l1', tenant: 'Acme', rent: { amount: '1000.00', currency: 'USD' }, term: 12 }, { provenance: { tenant: prov('doc-1', 0.9, true), rent: prov('doc-1', 0.95), term: prov('doc-1', 0.99) } });
    await t.insert('leases', { id: 'l2', tenant: 'Beta', term: 24 }, { provenance: { tenant: prov('doc-2', 0.95) } });
    await t.insert('leases', { id: 'l3', tenant: 'Gamma', term: 36 }, { provenance: { tenant: prov('doc-2', 0.5, false), term: prov('doc-2', 0.6) } });
    await t.insert('leases', { id: 'l4', tenant: 'Delta' }, { provenance: { tenant: prov('doc-3', 0.97, true) } });
    await t.insert('leases', { id: 'l5', tenant: 'Eps', term: 5 });
    await other.insert('leases', { id: 'x1', tenant: 'Other' }, { provenance: { tenant: prov('doc-9', 0.1, true) } });

    const keys = (items: Array<{ rowKey: unknown; field: string }>): string[] => items.map(i => `${i.rowKey}.${i.field}`).sort();

    console.log('\nqueue');
    await test('default threshold is 0.8; queue = flagged OR below threshold; confident and provenance-less values are not in it', async () => {
        assert.equal(DEFAULT_REVIEW_THRESHOLD, 0.8);
        assert.equal((await api.getSettings()).reviewConfidenceThreshold, 0.8);
        const page = await api.listQueue();
        assert.equal(page.threshold, 0.8);
        assert.deepEqual(keys(page.items), ['l1.tenant', 'l3.tenant', 'l3.term', 'l4.tenant']);
        const l3 = page.items.find(i => i.rowKey === 'l3' && i.field === 'tenant')!;
        assert.equal(l3.reason, 'low_confidence');
        assert.equal(l3.value, 'Gamma');
        assert.equal(l3.table, 'leases');
        assert.equal(l3.provenance.sourceDocumentId, 'doc-2');
        assert.equal(page.items.find(i => i.rowKey === 'l1')!.reason, 'flagged');
        assert.equal(await api.countQueue(), 4);
    });
    await test('filters: table, field, source document, maxConfidence', async () => {
        assert.deepEqual(keys((await api.listQueue({ table: 'leases', field: 'tenant' })).items), ['l1.tenant', 'l3.tenant', 'l4.tenant']);
        assert.deepEqual(keys((await api.listQueue({ field: 'term' })).items), ['l3.term']);
        assert.deepEqual(keys((await api.listQueue({ sourceDocumentId: 'doc-2' })).items), ['l3.tenant', 'l3.term']);
        assert.deepEqual(keys((await api.listQueue({ maxConfidence: 0.6 })).items), ['l3.tenant']);
        assert.equal(await api.countQueue({ sourceDocumentId: 'nope' }), 0);
        assert.equal(await code(api.listQueue({ table: 'nope' })), 'invalid_argument');
    });
    await test('cursor pagination walks every item exactly once, in a stable order', async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
            const p = await api.listQueue({ limit: 1, ...(cursor ? { cursor } : {}) });
            seen.push(...p.items.map(i => i.valueId));
            cursor = p.nextCursor ?? undefined; pages++;
        } while (cursor && pages < 10);
        assert.equal(pages, 4);
        assert.equal(new Set(seen).size, 4);
        assert.equal(await code(api.listQueue({ cursor: 'garbage' })), 'invalid_argument');
        assert.equal(await code(api.listQueue({ limit: 0 })), 'invalid_argument');
    });
    await test('the per-workspace threshold changes the queue; it is validated and does not leak to another workspace', async () => {
        await api.setReviewConfidenceThreshold(0.96, 'ops');
        assert.deepEqual(keys((await api.listQueue()).items), ['l1.rent', 'l1.tenant', 'l2.tenant', 'l3.tenant', 'l3.term', 'l4.tenant']);
        assert.equal((await otherApi.getSettings()).reviewConfidenceThreshold, 0.8);
        await api.setReviewConfidenceThreshold(0, 'ops');
        assert.deepEqual(keys((await api.listQueue()).items), ['l1.tenant', 'l4.tenant'], 'threshold 0 leaves only explicitly flagged values');
        assert.equal(await code(api.setReviewConfidenceThreshold(1.5)), 'invalid_argument');
        assert.equal(await code(api.setReviewConfidenceThreshold(Number.NaN)), 'invalid_argument');
        await api.setReviewConfidenceThreshold(0.8, 'ops');
        assert.equal((await api.getSettings()).reviewConfidenceThreshold, 0.8);
    });
    await test('workspace isolation: each workspace sees only its own queue, and cannot review the other\'s value id', async () => {
        assert.deepEqual(keys((await otherApi.listQueue()).items), ['x1.tenant']);
        const mine = (await api.listQueue()).items[0]!;
        assert.equal(await code(otherApi.confirm({ valueId: mine.valueId, reviewer: 'eve' })), 'not_found');
        assert.equal(await code(api.confirm({ valueId: '999999999', reviewer: 'eve' })), 'not_found');
        assert.equal(await code(api.confirm({ valueId: 'abc', reviewer: 'eve' })), 'invalid_argument');
    });

    console.log('\nconfirm');
    const l1 = (await api.listQueue({ field: 'tenant', sourceDocumentId: 'doc-1' })).items[0]!;
    let confirmed: Awaited<ReturnType<typeof api.confirm>>;
    await test('confirm writes a NEW reviewed value row and supersedes the extractor row; nothing is updated in place or deleted', async () => {
        const before = Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value WHERE workspace_id = $1`, [WS]))[0]!.c);
        confirmed = await api.confirm({ valueId: l1.valueId, reviewer: 'alice' });
        assert.equal(confirmed.idempotent, false);
        assert.equal(confirmed.supersededValueId, l1.valueId);
        assert.notEqual(confirmed.valueId, l1.valueId);
        assert.equal(Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value WHERE workspace_id = $1`, [WS]))[0]!.c), before + 1);
        const old = (await q<Record<string, unknown>>(`SELECT * FROM lore_entity_value WHERE value_id = $1`, [l1.valueId]))[0]!;
        assert.notEqual(old['superseded_at'], null, 'extractor row is closed, not deleted');
        assert.equal(old['needs_review'], true, 'extractor row is untouched');
        assert.equal(old['reviewed_by'], null);
        const nu = (await q<Record<string, unknown>>(`SELECT * FROM lore_entity_value WHERE value_id = $1`, [confirmed.valueId]))[0]!;
        assert.equal(nu['superseded_at'], null);
        assert.equal(nu['reviewed_by'], 'alice');
        assert.notEqual(nu['reviewed_at'], null);
        assert.equal(nu['needs_review'], false);
        assert.equal(String(nu['supersedes_value_id']), l1.valueId);
        assert.equal(nu['source_document_id'], 'doc-1');
        assert.equal(Number(nu['confidence']), 0.9, 'original confidence is kept');
        const row = await t.getByKey('leases', 'l1', { provenance: true });
        assert.equal(row!['tenant'], 'Acme');
        const pv = (row!['_provenance'] as Record<string, { reviewedBy: string }>)['tenant']!;
        assert.equal(pv.reviewedBy, 'alice');
    });
    await test('a reviewed value leaves the queue and does not re-flag even when its confidence is below the threshold', async () => {
        assert.deepEqual(keys((await api.listQueue()).items), ['l3.tenant', 'l3.term', 'l4.tenant']);
        const l3 = (await api.listQueue({ field: 'term' })).items[0]!;
        await api.confirm({ valueId: l3.valueId, reviewer: 'alice' });
        assert.deepEqual(keys((await api.listQueue()).items), ['l3.tenant', 'l4.tenant']);
    });
    await test('confirm is idempotent for the same reviewer (same outcome, nothing written)', async () => {
        const n = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c;
        const again = await api.confirm({ valueId: l1.valueId, reviewer: 'alice' });
        assert.equal(again.idempotent, true);
        assert.equal(again.valueId, confirmed.valueId);
        assert.equal(again.supersededValueId, l1.valueId);
        const againCurrent = await api.confirm({ valueId: confirmed.valueId, reviewer: 'alice' });
        assert.equal(againCurrent.idempotent, true);
        assert.equal((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c, n);
    });
    await test('a second reviewer on an already-reviewed value gets a clear conflict, and the first review stands', async () => {
        assert.equal(await code(api.confirm({ valueId: l1.valueId, reviewer: 'bob' })), 'conflict');
        assert.equal(await code(api.correct({ valueId: l1.valueId, reviewer: 'bob', value: 'Acme Ltd' })), 'conflict');
        assert.equal((await t.getByKey('leases', 'l1'))!['tenant'], 'Acme');
    });
    await test('concurrent reviewers on one value: exactly one winner, the others get a conflict, one new row', async () => {
        const target = (await api.listQueue({ field: 'tenant', sourceDocumentId: 'doc-3' })).items[0]!;
        const reviewers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
        const results = await Promise.allSettled(reviewers.map(r => api.confirm({ valueId: target.valueId, reviewer: r })));
        const ok = results.filter(r => r.status === 'fulfilled');
        const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        assert.equal(ok.length, 1, `winners: ${ok.length}`);
        for (const b of bad) assert.equal((b.reason as TableReviewError).code, 'conflict');
        const n = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value WHERE supersedes_value_id = $1`, [target.valueId]))[0]!.c;
        assert.equal(Number(n), 1);
    });

    console.log('\ncorrect');
    await test('correct writes a new value with the reviewer, the read path sees it, and the history keeps every version', async () => {
        const l3 = (await api.listQueue({ field: 'tenant' })).items.find(i => i.rowKey === 'l3')!;
        const out = await api.correct({ valueId: l3.valueId, reviewer: 'carol', value: 'Gamma Holdings', verifiedQuote: 'Gamma Holdings Ltd', sourcePage: 4 });
        assert.equal(out.action, 'correct');
        assert.equal(out.idempotent, false);
        const row = await t.getByKey('leases', 'l3', { provenance: true });
        assert.equal(row!['tenant'], 'Gamma Holdings');
        const pv = (row!['_provenance'] as Record<string, Record<string, unknown>>)['tenant']!;
        assert.equal(pv['reviewedBy'], 'carol');
        assert.equal(pv['sourceDocumentId'], 'doc-2');
        assert.equal(pv['sourcePage'], 4);
        assert.equal(pv['verifiedQuote'], 'Gamma Holdings Ltd');
        assert.equal(pv['needsReview'], false);
        const hist = await q<{ v_text: string | null; superseded_at: Date | null }>(
            `SELECT v_text, superseded_at FROM lore_entity_value WHERE entity_id = (SELECT entity_id FROM lore_entity_value WHERE value_id = $1) AND field_id = (SELECT field_id FROM lore_entity_value WHERE value_id = $1) ORDER BY value_id`, [l3.valueId]);
        assert.deepEqual(hist.map(h => h.v_text), ['Gamma', 'Gamma Holdings']);
        assert.notEqual(hist[0]!.superseded_at, null);
        assert.equal(hist[1]!.superseded_at, null);
        // the same correction again is idempotent for the same reviewer, a different value is a conflict
        assert.equal((await api.correct({ valueId: l3.valueId, reviewer: 'carol', value: 'Gamma Holdings' })).idempotent, true);
        assert.equal(await code(api.correct({ valueId: l3.valueId, reviewer: 'carol', value: 'Other' })), 'conflict');
    });
    await test('typed values: a money correction is validated and stored exactly; a bad value is refused and nothing is written', async () => {
        const row = (await q<{ value_id: string }>(`SELECT v.value_id FROM lore_entity_value v JOIN lore_field_def f USING (field_id) WHERE v.workspace_id = $1 AND f.name = 'rent' AND v.superseded_at IS NULL`, [WS]))[0]!;
        await api.setReviewConfidenceThreshold(0.99, 'ops');
        const item = (await api.listQueue({ field: 'rent' })).items[0]!;
        assert.equal(item.valueId, row.value_id);
        const n = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c;
        assert.equal(await code(api.correct({ valueId: item.valueId, reviewer: 'dan', value: 'not money' })).catch(e => String(e)), 'invalid_argument');
        assert.equal((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c, n);
        await api.correct({ valueId: item.valueId, reviewer: 'dan', value: { amount: '1250.50', currency: 'usd' } });
        assert.deepEqual((await t.getByKey('leases', 'l1'))!['rent'], { amount: '1250.50', currency: 'USD' });
        await api.setReviewConfidenceThreshold(0.8, 'ops');
    });
    await test('primary-key values and null corrections are refused', async () => {
        const l4 = (await api.listQueue({ field: 'tenant' })).items.find(i => i.rowKey === 'l4');
        if (l4) {
            assert.equal(await code(api.correct({ valueId: l4.valueId, reviewer: 'x', value: null })), 'invalid_argument');
        }
        const pk = (await q<{ value_id: string }>(`SELECT v.value_id FROM lore_entity_value v JOIN lore_field_def f USING (field_id) WHERE v.workspace_id = $1 AND f.name = 'id' AND v.superseded_at IS NULL LIMIT 1`, [WS]))[0];
        if (pk) assert.equal(await code(api.correct({ valueId: pk.value_id, reviewer: 'x', value: 'zzz' })), 'invalid_argument');
        assert.equal(await code(api.correct({ valueId: '1', reviewer: '', value: 'a' })), 'invalid_argument');
    });
    await test('the other workspace\'s queue is untouched by all of this', async () => {
        assert.deepEqual(keys((await otherApi.listQueue()).items), ['x1.tenant']);
        assert.equal((await other.getByKey('leases', 'x1', { provenance: true }))!['tenant'], 'Other');
    });

    console.log('\nsqlite');
    await test('SQLite table storage gets a typed not_supported error, not an empty queue', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-review-sqlite-'));
        const sq = new SqliteTableStorage(path.join(dir, 'tables.sqlite'));
        try {
            const c = await code(tableReviewFor(sq));
            assert.equal(c, 'not_supported');
            const viaPg = await tableReviewFor(t);
            assert.equal((await viaPg.getSettings()).reviewConfidenceThreshold, 0.8);
        } finally { (sq as unknown as { close?: () => void }).close?.(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
