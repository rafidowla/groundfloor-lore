#!/usr/bin/env tsx
/**
 * cloud-store-batch-unit.ts — cloud parity Slice B item 10 (reworked for review B #1):
 * DataplaneVectorStore.storeBatch is a batch write, not a loop of store(). Dedup ids inside a batch
 * (keep last), ONE scoped existence query per 200 ids, skip-identical (same hash + metadata, not a
 * tombstone) with no embed and no write, then per-row scopedUpsert with bounded concurrency.
 *
 * NOT `/bulk`: the engine ignores the caller id in /bulk (mock-dataplane.ts item 3c), so bulk-written
 * rows would not carry the `lw1_` row key and guardScope would hide them. These tests run on the
 * engine-faithful mock, where a /bulk implementation fails "rows are visible to scoped reads".
 */
import assert from 'node:assert/strict';
import { startCloudFixture, bagOfWordsEmbedder, DP_WORKSPACE, DP_KEY, ORG_ID, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { registryAcceptingAny } from './helpers/workspace-registry.js';
import { WRITE_CONCURRENCY } from '../packages/lore/src/engines/dataplaneVerbatimBatch.js';
import { dataplaneRowKey, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'batch-ws-one';
const W2 = 'batch-ws-two';
const SCOPE_W1: DataplaneScope = { orgId: ORG_ID, loreWorkspace: W1, dataplaneWorkspaceId: DP_WORKSPACE };
const doc = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ id, text, metadata: { type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [], ...extra } });

console.log('cloud parity B item 10: storeBatch');

const fx = await startCloudFixture();
const V = '/v1/lore_verbatim';
const hits = (suffix: string, method = 'POST') => fx.mock.requests.filter((r) => r.method === method && r.path === `${V}${suffix}`);
const rowsOf = (ws: string) => fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_workspace'] === ws);
const mark = () => fx.mock.requests.length;
const since = (m: number) => fx.mock.requests.slice(m);
const writes = (m: number) => since(m).filter((r) => r.method !== 'GET' && !r.path.endsWith('/query') && !r.path.startsWith('/v1/schema'));

try {
    await test('empty batch makes no requests', async () => {
        const m = mark();
        await fx.as(W1, () => fx.vector.storeBatch([]));
        assert.equal(since(m).length, 0);
    });

    await test('new docs: one existence query, per-row writes (never /bulk); rows carry the lw1_ key and are visible to scoped reads', async () => {
        await fx.as(W1, () => fx.vector.storeBatch([])); // warm
        const docs = Array.from({ length: 50 }, (_, i) => doc(`n${i}`, `new doc ${i}`));
        const m = mark();
        await fx.as(W1, () => fx.vector.storeBatch(docs as never));
        const rs = since(m);
        assert.equal(rs.filter((r) => r.path === `${V}/query`).length, 1, 'one scoped existence query');
        assert.equal(rs.filter((r) => r.path === `${V}/bulk`).length, 0, '/bulk ignores the caller id: never used');
        assert.equal(rs.filter((r) => r.method === 'POST' && r.path === V).length, 50, 'one insert per new row');
        const rows = rowsOf(W1).filter((r) => String(r['lore_id']).startsWith('n'));
        assert.equal(rows.length, 50);
        for (const r of rows) {
            assert.equal(r['org_id'], ORG_ID);
            assert.equal(r['lore_workspace'], W1);
            assert.ok(typeof r['content_hash'] === 'string' && r['content_hash'] !== '');
            assert.ok(Array.isArray(r['vector']) && (r['vector'] as unknown[]).length > 0);
            assert.equal(r['id'], dataplaneRowKey(SCOPE_W1, String(r['lore_id'])), 'physical id is the D2 row key');
        }
        // The regression #1 guards: every written row is reachable through the scoped read paths.
        const hashes = await fx.as(W1, () => fx.vector.getContentHashesByIds(docs.map((d) => d.id)));
        assert.equal(hashes.size, 50, 'scoped existence lookup sees every row');
        assert.ok(await fx.as(W1, () => fx.vector.getById('n7')), 'getById (GET by row key + guardScope) sees it');
    });

    await test('the existence query carries the scope filter and never asks for vectors', async () => {
        const q = hits('/query').at(-1)!;
        const f = JSON.stringify(q.body['filter']);
        assert.ok(f.includes(ORG_ID) && f.includes(W1) && f.includes('lore_id'), f);
        assert.ok(Array.isArray(q.body['projection']) && !(q.body['projection'] as string[]).includes('vector'));
    });

    await test('duplicate ids inside one batch keep the LAST occurrence', async () => {
        await fx.as(W1, () => fx.vector.storeBatch([doc('dup', 'first'), doc('dup', 'second'), doc('dup', 'third')] as never));
        const rows = rowsOf(W1).filter((r) => r['lore_id'] === 'dup');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!['text'], 'third');
    });

    await test('re-storing an identical batch is a no-op: no write, no embed', async () => {
        const docs = Array.from({ length: 50 }, (_, i) => doc(`n${i}`, `new doc ${i}`));
        const m = mark();
        await fx.as(W1, () => fx.vector.storeBatch(docs as never));
        assert.equal(writes(m).length, 0, JSON.stringify(writes(m).map((r) => r.path)));
    });

    await test('mixed batch: changed rows are updated in place, new rows inserted, identical rows skipped', async () => {
        const docs = [
            doc('n0', 'new doc 0'),                 // identical -> skip
            doc('n1', 'changed text one'),          // changed text -> update
            doc('n2', 'new doc 2', { label: 'relabelled' }), // metadata-only change -> update
            doc('fresh1', 'fresh one'),             // new
            doc('fresh2', 'fresh two'),             // new
        ];
        const m = mark();
        await fx.as(W1, () => fx.vector.storeBatch(docs as never));
        const w = writes(m);
        assert.equal(w.filter((r) => r.path === `${V}/bulk`).length, 0);
        assert.equal(w.filter((r) => r.method === 'POST' && r.path === V).length, 2, 'only the two new rows are inserted');
        // The two CHANGED existing rows go to /v1/transaction as [snapshot create, canonical update] pairs
        // (item 8); only the two NEW rows take the update-miss + insert path.
        assert.equal(w.filter((r) => r.path === '/v1/transaction').length, 1, 'both changed rows in one transaction');
        assert.equal(w.filter((r) => r.path === `${V}/update-by-query`).length, 2, '2 misses before the inserts');
        const byId = new Map(rowsOf(W1).map((r) => [r['lore_id'], r]));
        assert.equal(byId.get('n1')!['text'], 'changed text one');
        assert.equal(byId.get('n2')!['label'], 'relabelled');
        assert.equal(byId.get('n0')!['text'], 'new doc 0');
        assert.equal(rowsOf(W1).filter((r) => r['lore_id'] === 'n1').length, 1, 'update, not a second row');
        assert.equal(rowsOf(W1).filter((r) => String(r['lore_id']).startsWith('n1#rev')).length, 1, 'the previous content is kept as a snapshot');
    });

    await test('a tombstoned row is never skipped as identical', async () => {
        await fx.as(W1, () => fx.vector.storeBatch([doc('tomb', 'live text')] as never));
        const row = fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').find((r) => r['lore_id'] === 'tomb' && r['lore_workspace'] === W1)!;
        // Overwrite the stored text with a tombstone marker but keep the old hash.
        await fetch(`${fx.mock.url}/v1/lore_verbatim/update-by-query`, {
            method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${DP_KEY}`, 'x-api-key': DP_KEY },
            body: JSON.stringify({ filter: { id_eq: String(row['id']) }, fields: { text: '[TOMBSTONED] gone' }, connection: FIXTURE_CONNECTION }),
        });
        const m = mark();
        await fx.as(W1, () => fx.vector.storeBatch([doc('tomb', 'live text')] as never));
        assert.ok(writes(m).length > 0, 'tombstone must be rewritten');
        assert.equal(rowsOf(W1).find((r) => r['lore_id'] === 'tomb')!['text'], 'live text');
    });

    await test('another Lore workspace with the same ids is written, not skipped, and does not touch W1', async () => {
        const before = JSON.stringify(rowsOf(W1).map((r) => [r['lore_id'], r['text']]).sort());
        const m = mark();
        await fx.as(W2, () => fx.vector.storeBatch([doc('n0', 'new doc 0'), doc('n1', 'w2 text')] as never));
        assert.equal(writes(m).filter((r) => r.method === 'POST' && r.path === V).length, 2);
        assert.equal(rowsOf(W2).length, 2);
        assert.equal(JSON.stringify(rowsOf(W1).map((r) => [r['lore_id'], r['text']]).sort()), before);
    });

    await test('1200 new docs: every row lands, existence lookups chunked at 200 ids, writes never exceed the concurrency bound', async () => {
        const real = connectedClient(fx.mock.url, DP_KEY);
        let inFlight = 0;
        let peak = 0;
        const track = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
            inFlight++; peak = Math.max(peak, inFlight);
            try { return await f(...a); } finally { inFlight--; }
        };
        const client = { ...real, updateByQuery: track(real.updateByQuery.bind(real)), insert: track(real.insert.bind(real)) };
        const store = new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: registryAcceptingAny(), embeddingProvider: bagOfWordsEmbedder() });
        const docs = Array.from({ length: 1200 }, (_, i) => doc(`big${i}`, `bulk doc ${i}`));
        const m = mark();
        await runWithWorkspace({ workspaceId: W1 }, () => store.storeBatch(docs as never));
        assert.equal(since(m).filter((r) => r.path === `${V}/bulk`).length, 0);
        assert.equal(rowsOf(W1).filter((r) => String(r['lore_id']).startsWith('big')).length, 1200);
        assert.equal(since(m).filter((r) => r.path === `${V}/query`).length, 6, 'existence lookups chunked at 200 ids');
        assert.ok(peak > 1 && peak <= WRITE_CONCURRENCY, `peak in-flight writes ${peak} must be in (1, ${WRITE_CONCURRENCY}]`);
        await store.close();
    });

    await test('a failing row write surfaces as a DataplaneVectorStoreError and stops scheduling new writes', async () => {
        const real = connectedClient(fx.mock.url, DP_KEY);
        let inserts = 0;
        const client = { ...real, insert: async () => { inserts++; throw new Error('boom'); } };
        const store = new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: registryAcceptingAny(), embeddingProvider: bagOfWordsEmbedder() });
        const docs = Array.from({ length: 100 }, (_, i) => doc(`fail${i}`, `fail doc ${i}`));
        await assert.rejects(() => runWithWorkspace({ workspaceId: 'fail-ws' }, () => store.storeBatch(docs as never)), /boom/);
        assert.ok(inserts <= WRITE_CONCURRENCY * 2, `stopped early, ${inserts} inserts attempted`);
        await store.close();
    });

    await test('only changed docs are embedded', async () => {
        let embeds = 0;
        const base = bagOfWordsEmbedder();
        const counting = { ...base, embedDocument: async (t: string) => { embeds++; return base.embedDocument(t); }, embedDocumentBatch: undefined } as never;
        const client = connectedClient(fx.mock.url, DP_KEY);
        const store = new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: registryAcceptingAny(), embeddingProvider: counting });
        const run = <T>(fn: () => Promise<T>) => runWithWorkspace({ workspaceId: 'embed-ws' }, fn);
        await run(() => store.storeBatch([doc('e1', 'one'), doc('e2', 'two'), doc('e3', 'three')] as never));
        assert.equal(embeds, 3);
        await run(() => store.storeBatch([doc('e1', 'one'), doc('e2', 'two CHANGED'), doc('e3', 'three')] as never));
        assert.equal(embeds, 4);
        await store.close();
    });

    await test('lost race (engine answers a duplicate PK with 500, not 409): the row exists, so the batch updates it', async () => {
        const real = connectedClient(fx.mock.url, DP_KEY);
        let raced = false;
        const client = {
            ...real,
            insert: async (t: string, c: string, record: Record<string, unknown>, conn?: string) => {
                if (!raced) { // a concurrent writer lands this row key between our update-by-query and our insert
                    raced = true;
                    await real.insert(t, c, { ...record, text: 'raced writer' } as never);
                }
                return real.insert(t, c, record as never, conn);
            },
        };
        const store = new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: registryAcceptingAny(), embeddingProvider: bagOfWordsEmbedder() });
        await runWithWorkspace({ workspaceId: 'race-ws' }, () => store.storeBatch([doc('r1', 'mine one'), doc('r2', 'mine two'), doc('r3', 'mine three')] as never));
        const rows = rowsOf('race-ws');
        assert.equal(rows.length, 3, 'no duplicate rows');
        assert.equal(rows.find((r) => r['lore_id'] === 'r1')!['text'], 'mine one', 'our write wins via the update after the GET found the row');
        await store.close();
    });
} finally {
    await fx.close();
}

console.log(`\n${failed === 0 ? 'all' : `${passed}/${passed + failed}`} ${passed + failed} unit tests ${failed === 0 ? 'passed ✓' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
