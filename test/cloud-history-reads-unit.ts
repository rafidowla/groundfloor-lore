#!/usr/bin/env tsx
/**
 * cloud-history-reads-unit.ts — cloud parity Slice C review #7 and #11.
 *
 *   #7  readVerbatimHistory must not silently truncate: past its page budget it THROWS (like the
 *       version-store scan), never returns a partial history. getVersions pages newest-first and
 *       stops at `limit`, so a node with a long history is answered from the first page(s).
 *   #11 incrementWriteCount used to be a read-modify-write that lost concurrent increments; it now
 *       recounts the changeset's write rows (like addChangesetWrite), so concurrent callers converge.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, ORG_ID, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { scopeRowFields } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { readVerbatimHistory } from '../packages/lore/src/engines/dataplaneVerbatimHistoryReads.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'reads-ws';
const scope = { orgId: ORG_ID, dataplaneWorkspaceId: DP_WORKSPACE, loreWorkspace: WS } as never;
const pad = (n: number, w = 6) => String(n).padStart(w, '0');

console.log('cloud parity C review #7 / #11: history reads and write counts');
const fx = await startCloudFixture();
/** Seed rows with their own `id` (the engine's /bulk ignores a caller id, so use single creates). */
const seed = async (coll: string, rows: Array<Record<string, unknown>>): Promise<void> => {
    for (const r of rows) await fx.rawClient.insert(DP_WORKSPACE, coll, r);
};
const vecRows = () => fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_workspace'] === WS);

try {
    await fx.as(WS, () => fx.vector.store({ id: 'lore:h1', text: 'seed', metadata: { type: 'note', label: 'l', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [] } } as never));
    // 25 snapshot rows of lore:h1 (a direct writer; the shape buildSnapshotGroup produces)
    await seed('lore_verbatim', Array.from({ length: 25 }, (_, i) => ({
        ...scopeRowFields(scope, `lore:h1#rev2026-09-01T00:00:${pad(i, 2)}.000Z`),
        text: `old ${i}`, vector: new Array(16).fill(0), updated_at: '2026-09-01T00:00:00.000Z',
    })));

    await test('getHistory returns every snapshot when the history fits the page budget', async () => {
        const h = await readVerbatimHistory(fx.rawClient as never, scope, 'lore_verbatim', FIXTURE_CONNECTION, 'lore:h1', { pageSize: 10, maxPages: 3 });
        assert.equal(h.length, 26, 'canonical + 25 snapshots');
        assert.equal(h[0]!.isCanonical, true);
    });
    await test('getHistory THROWS when the history exceeds the page budget (no silent truncation)', async () => {
        await assert.rejects(
            readVerbatimHistory(fx.rawClient as never, scope, 'lore_verbatim', FIXTURE_CONNECTION, 'lore:h1', { pageSize: 10, maxPages: 2 }),
            /history.*exceed|exceeded/i,
        );
    });
    await test('the store getHistory still answers with the default budget', async () => {
        const h = await fx.as(WS, () => fx.vector.getHistory('lore:h1'));
        assert.equal(h.length, 26);
        assert.equal(vecRows().length, 26);
    });

    // ---- getVersions paging ------------------------------------------------------------------
    const N = 1200;
    await seed('lore_version', Array.from({ length: N }, (_, i) => ({
        ...scopeRowFields(scope, `v-${pad(i)}`),
        kind: 'node_version', node_id: 'big', timestamp: `2026-09-01T00:${pad(Math.floor(i / 60), 2)}:${pad(i % 60, 2)}.000Z`,
        principal: 'p', operation: 'upsert', new_state: JSON.stringify({ label: `l${i}` }), compacted: i >= N - 3, // the 3 newest are compacted
    })));
    const queriesAfter = (n: number) => fx.mock.requests.slice(n).filter((r) => r.path.includes('lore_version') && /query/.test(r.path));
    await test('getVersions(limit) answers a long history from the first page, newest first, skipping compacted rows', async () => {
        const mark = fx.mock.requests.length;
        const vs = await fx.as(WS, async () => fx.graph.versions.getVersions('big', WS, 5));
        assert.equal(vs.length, 5);
        assert.deepEqual(vs.map((v) => v.versionId), [`v-${pad(N - 4)}`, `v-${pad(N - 5)}`, `v-${pad(N - 6)}`, `v-${pad(N - 7)}`, `v-${pad(N - 8)}`]);
        assert.ok(queriesAfter(mark).length <= 1, `expected one page, saw ${queriesAfter(mark).length} query requests`);
    });
    await test('getVersions with a limit larger than the history returns all live rows', async () => {
        const vs = await fx.as(WS, async () => fx.graph.versions.getVersions('big', WS, 5000));
        assert.equal(vs.length, N - 3);
        assert.ok(vs.every((v, i) => i === 0 || vs[i - 1]!.timestamp >= v.timestamp), 'newest first');
    });

    // ---- #11 ------------------------------------------------------------------------------------
    await test('concurrent writers and incrementWriteCount leave write_count equal to the real number of writes', async () => {
        const versions = fx.graph.versions;
        const cs = await fx.as(WS, async () => versions.createChangeset(WS));
        await Promise.all(Array.from({ length: 6 }, (_, i) => fx.as(WS, async () => versions.addChangesetWrite(cs, 'upsert', { i }))));
        await Promise.all(Array.from({ length: 8 }, () => fx.as(WS, async () => versions.incrementWriteCount(cs))));
        const row = await fx.as(WS, async () => versions.getChangeset(cs));
        const writes = await fx.as(WS, async () => versions.getChangesetWrites(cs));
        assert.equal(writes.length, 6);
        assert.equal(row?.writeCount, 6, 'increments must not drift away from the actual write rows');
    });
} finally {
    await fx.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
