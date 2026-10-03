#!/usr/bin/env tsx
/**
 * cloud-verbatim-history-unit.ts — cloud parity Slice C item 8 (D6 as amended by R3), verbatim half:
 * the cloud verbatim store keeps revision history like the local VerbatimStore.
 *
 *   - a CHANGED re-store snapshots the previous content under `<id>#rev<ISO ts>`; an identical one does not;
 *   - tombstone(id, reason) snapshots, then marks the canonical row `[TOMBSTONED …]`; no-op when absent /
 *     already tombstoned / given a history id;
 *   - getHistory(id) = canonical first, then snapshots newest first, with isTombstone / isCanonical;
 *   - search()/bm25Search() hide history + tombstones; search({includeHistory:true}) shows them;
 *   - the change and its snapshot travel in ONE /v1/transaction when the route exists;
 *   - another Lore workspace never sees this workspace's history, even for the same logical id;
 *   - a legacy lore_verbatim collection WITHOUT revision_state still behaves (state is derived from the
 *     row's id/text; the column is neither written nor pushed down).
 * Runs on the engine-faithful mock.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, DP_KEY, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { isRevisionHistoryId } from '../packages/lore/src/engines/verbatimHistory.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WA = 'hist-ws-a';
const WB = 'hist-ws-b';
const meta = (extra: Record<string, unknown> = {}) =>
    ({ type: 'note', label: 'l', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [], ...extra });
const doc = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, metadata: meta(extra) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('cloud parity C item 8: verbatim history');

async function withFixture(
    mockOpts: Parameters<typeof startCloudFixture>[0],
    fn: (fx: Awaited<ReturnType<typeof startCloudFixture>>) => Promise<void>,
): Promise<void> {
    const fx = await startCloudFixture(mockOpts);
    try { await fn(fx); } finally { await fx.close(); }
}
const rowsOf = (fx: Awaited<ReturnType<typeof startCloudFixture>>, ws: string) =>
    fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_workspace'] === ws);

await withFixture({}, async (fx) => {
    await test('a changed re-store snapshots the previous content under <id>#rev<ts> (one transaction)', async () => {
        await fx.as(WA, () => fx.vector.store(doc('lore:a1', 'first version text')));
        assert.equal(rowsOf(fx, WA).length, 1, 'a brand-new row has no history');
        const txBefore = fx.mock.requests.filter((r) => r.path === '/v1/transaction').length;
        await fx.as(WA, () => fx.vector.store(doc('lore:a1', 'second version text')));
        const rows = rowsOf(fx, WA);
        assert.equal(rows.length, 2);
        const hist = rows.find((r) => isRevisionHistoryId(String(r['lore_id'])))!;
        assert.ok(hist, 'a history row exists');
        assert.ok(String(hist['lore_id']).startsWith('lore:a1#rev'));
        assert.equal(hist['text'], 'first version text', 'the snapshot holds the PREVIOUS content');
        assert.ok(Array.isArray(hist['vector']) && (hist['vector'] as unknown[]).length > 0, 'the snapshot keeps its vector');
        assert.equal(hist['org_id'], rows.find((r) => r['lore_id'] === 'lore:a1')!['org_id']);
        assert.equal(hist['lore_workspace'], WA);
        const canon = rows.find((r) => r['lore_id'] === 'lore:a1')!;
        assert.equal(canon['text'], 'second version text');
        const txs = fx.mock.requests.filter((r) => r.path === '/v1/transaction').length - txBefore;
        assert.equal(txs, 1, 'change + snapshot are ONE transaction');
    });

    await test('an identical re-store does not snapshot', async () => {
        const before = rowsOf(fx, WA).length;
        await fx.as(WA, () => fx.vector.store(doc('lore:a1', 'second version text')));
        assert.equal(rowsOf(fx, WA).length, before);
    });

    await test('getHistory: canonical first, then snapshots newest first; flags set', async () => {
        await sleep(5);
        await fx.as(WA, () => fx.vector.store(doc('lore:a1', 'third version text')));
        const h = await fx.as(WA, () => fx.vector.getHistory('lore:a1'));
        assert.equal(h.length, 3);
        assert.equal(h[0]!.id, 'lore:a1');
        assert.equal(h[0]!.isCanonical, true);
        assert.equal(h[0]!.text, 'third version text');
        assert.equal(h[0]!.isTombstone, false);
        assert.deepEqual(h.slice(1).map((x) => x.text), ['second version text', 'first version text']);
        assert.ok(h.slice(1).every((x) => !x.isCanonical && isRevisionHistoryId(x.id)));
        assert.ok(h[1]!.id.localeCompare(h[2]!.id) > 0, 'newest snapshot first');
        assert.deepEqual(await fx.as(WA, () => fx.vector.getHistory('lore:never-stored')), []);
    });

    await test('tombstone snapshots, marks the canonical row, and is a no-op the second time / for history ids / absent ids', async () => {
        await fx.as(WA, () => fx.vector.store(doc('lore:t1', 'doomed content')));
        await fx.as(WA, () => fx.vector.tombstone('lore:t1', 'obsolete'));
        let h = await fx.as(WA, () => fx.vector.getHistory('lore:t1'));
        assert.equal(h.length, 2);
        assert.equal(h[0]!.isTombstone, true);
        assert.ok(h[0]!.text.startsWith('[TOMBSTONED '), h[0]!.text);
        assert.ok(h[0]!.text.includes('reason: obsolete') && h[0]!.text.includes('doomed content'));
        assert.equal(h[1]!.text, 'doomed content');
        assert.equal(h[1]!.isTombstone, false);
        await fx.as(WA, () => fx.vector.tombstone('lore:t1', 'again'));
        assert.equal((await fx.as(WA, () => fx.vector.getHistory('lore:t1'))).length, 2, 'already tombstoned: no new snapshot');
        await fx.as(WA, () => fx.vector.tombstone(h[1]!.id, 'x'));
        assert.equal((await fx.as(WA, () => fx.vector.getHistory('lore:t1'))).length, 2, 'a history id is never tombstoned');
        const n = rowsOf(fx, WA).length;
        await fx.as(WA, () => fx.vector.tombstone('lore:absent', 'x'));
        assert.equal(rowsOf(fx, WA).length, n, 'absent id: nothing written');
        // a re-store of the same original content brings it back (tombstone is never "identical")
        await fx.as(WA, () => fx.vector.store(doc('lore:t1', 'doomed content')));
        h = await fx.as(WA, () => fx.vector.getHistory('lore:t1'));
        assert.equal(h[0]!.isTombstone, false);
        assert.equal(h[0]!.text, 'doomed content');
        assert.equal(h.length, 3, 'the tombstone itself was snapshotted');
    });

    await test('search hides history + tombstones; includeHistory shows them', async () => {
        await fx.as(WA, () => fx.vector.store(doc('lore:s1', 'zebra stripes original')));
        await fx.as(WA, () => fx.vector.store(doc('lore:s1', 'zebra stripes revised')));
        await fx.as(WA, () => fx.vector.store(doc('lore:s2', 'zebra gone soon')));
        await fx.as(WA, () => fx.vector.tombstone('lore:s2', 'r'));
        const plain = await fx.as(WA, () => fx.vector.search('zebra stripes', 20));
        const ids = plain.map((r) => r.id);
        assert.ok(ids.includes('lore:s1'));
        assert.ok(!ids.some((i) => isRevisionHistoryId(i)), `history leaked: ${ids.join(',')}`);
        assert.ok(!ids.includes('lore:s2'), 'a tombstoned canonical row is hidden');
        assert.ok(plain.every((r) => !r.text.startsWith('[TOMBSTONED')));
        const withHist = await fx.as(WA, () => fx.vector.search('zebra stripes', 20, undefined, { includeHistory: true }));
        const hids = withHist.map((r) => r.id);
        assert.ok(hids.some((i) => i.startsWith('lore:s1#rev')), 'snapshot visible with includeHistory');
        assert.ok(hids.includes('lore:s2'), 'tombstone visible with includeHistory');
    });

    await test('bm25Search hides history rows', async () => {
        const res = await fx.as(WA, () => fx.vector.bm25Search('zebra', 20));
        assert.ok(!res.hits.some((h) => isRevisionHistoryId(h.id)));
    });

    await test('workspace B cannot read workspace A history, even for the same logical id', async () => {
        assert.deepEqual(await fx.as(WB, () => fx.vector.getHistory('lore:a1')), []);
        await fx.as(WB, () => fx.vector.store(doc('lore:a1', 'b only v1')));
        await fx.as(WB, () => fx.vector.store(doc('lore:a1', 'b only v2')));
        const hb = await fx.as(WB, () => fx.vector.getHistory('lore:a1'));
        assert.deepEqual(hb.map((x) => x.text).sort(), ['b only v1', 'b only v2']);
        const ha = await fx.as(WA, () => fx.vector.getHistory('lore:a1'));
        assert.ok(ha.every((x) => !x.text.startsWith('b only')), 'A never sees B rows');
        await fx.as(WB, () => fx.vector.tombstone('lore:a1', 'b-only'));
        assert.ok((await fx.as(WA, () => fx.vector.getHistory('lore:a1'))).every((x) => !x.isTombstone), "B's tombstone does not touch A");
        const bSearch = await fx.as(WB, () => fx.vector.search('third version', 20, undefined, { includeHistory: true }));
        assert.ok(bSearch.every((r) => !r.text.includes('third version')), "B's includeHistory search sees none of A's rows");
    });

    await test('storeBatch snapshots changed existing rows and writes new ones plainly', async () => {
        await fx.as(WA, () => fx.vector.storeBatch([doc('lore:b1', 'batch one v1'), doc('lore:b2', 'batch two v1')] as never));
        assert.equal((await fx.as(WA, () => fx.vector.getHistory('lore:b1'))).length, 1);
        await fx.as(WA, () => fx.vector.storeBatch([doc('lore:b1', 'batch one v2'), doc('lore:b2', 'batch two v1'), doc('lore:b3', 'batch three v1')] as never));
        const h1 = await fx.as(WA, () => fx.vector.getHistory('lore:b1'));
        assert.deepEqual(h1.map((x) => x.text), ['batch one v2', 'batch one v1']);
        assert.equal((await fx.as(WA, () => fx.vector.getHistory('lore:b2'))).length, 1, 'unchanged: no snapshot');
        assert.equal((await fx.as(WA, () => fx.vector.getHistory('lore:b3'))).length, 1, 'new: no snapshot');
    });
});

await withFixture({}, async (fx) => {
    await test('legacy collection without revision_state: history still works from id/text, the column is never written', async () => {
        const c = connectedClient(fx.mock.url, DP_KEY);
        await c.createCollection(DP_WORKSPACE, {
            name: 'lore_verbatim',
            fields: [
                { name: 'id', field_type: 'string', primary_key: true, required: true },
                { name: 'vector', field_type: 'vector', dimension: 16, required: true },
                { name: 'text', field_type: 'string' }, { name: 'type', field_type: 'string' }, { name: 'label', field_type: 'string' },
                { name: 'tags', field_type: 'string' }, { name: 'project', field_type: 'string' }, { name: 'ecosystem', field_type: 'string' },
                { name: 'updated_at', field_type: 'string' }, { name: 'security_scopes', field_type: 'string' }, { name: 'content_hash', field_type: 'string' },
                { name: 'org_id', field_type: 'string', required: true }, { name: 'lore_workspace', field_type: 'string', required: true }, { name: 'lore_id', field_type: 'string', required: true },
            ],
            indexes: [{ name: 'scope_key', fields: ['org_id', 'lore_workspace', 'lore_id'], unique: true }],
        } as never);
        await fx.as(WA, () => fx.vector.store(doc('lore:l1', 'legacy yak one')));
        await fx.as(WA, () => fx.vector.store(doc('lore:l1', 'legacy yak two')));
        await fx.as(WA, () => fx.vector.tombstone('lore:l1', 'old'));
        const rows = rowsOf(fx, WA);
        assert.ok(rows.every((r) => !('revision_state' in r)), 'revision_state is not written to a collection that does not declare it');
        const h = await fx.as(WA, () => fx.vector.getHistory('lore:l1'));
        assert.equal(h.length, 3);
        assert.equal(h[0]!.isTombstone, true);
        const res = await fx.as(WA, () => fx.vector.search('legacy yak', 10));
        assert.equal(res.length, 0, 'history + tombstone hidden by the client predicate');
        const all = await fx.as(WA, () => fx.vector.search('legacy yak', 10, undefined, { includeHistory: true }));
        assert.ok(all.length >= 2);
    });
});

await withFixture({ transactions: false }, async (fx) => {
    await test('route absent: change then snapshot as separate writes; same results', async () => {
        await fx.as(WA, () => fx.vector.store(doc('lore:n1', 'no tx one')));
        await fx.as(WA, () => fx.vector.store(doc('lore:n1', 'no tx two')));
        const h = await fx.as(WA, () => fx.vector.getHistory('lore:n1'));
        assert.deepEqual(h.map((x) => x.text), ['no tx two', 'no tx one']);
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
