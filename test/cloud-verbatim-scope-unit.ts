#!/usr/bin/env tsx
/**
 * cloud-verbatim-scope-unit.ts — cloud parity A2 item 2 (security-critical).
 *
 * Verbatim ids are not content hashes: memory-backed rows use the memory's id
 * (`lore:<nodeId>`) and the store tool accepts caller-supplied ids. Many Lore
 * workspaces share ONE Dataplane workspace, and the engine's `id` is the only primary
 * key, so the same logical id in two Lore workspaces must map to two distinct physical
 * rows (D2 row key = sha256(org, workspace, id)) and every operation must be scoped.
 */

import assert from 'node:assert/strict';
import { startCloudFixture, DP_KEY, DP_WORKSPACE, ORG_ID, type CloudFixture, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { dataplaneRowKey, scopeRowFields } from '../packages/lore/src/engines/dataplaneScopeFilter.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'lore-ws-one';
const W2 = 'lore-ws-two';
const NODE_ID = 'lore:node-42'; // memory-backed form
const CUSTOM = 'caller-supplied-id';
const scope = (ws: string) => ({ orgId: ORG_ID, loreWorkspace: ws, dataplaneWorkspaceId: DP_WORKSPACE });
const rows = (fx: CloudFixture) => fx.mock.rows(DP_WORKSPACE, 'lore_verbatim');

async function run(vectorFilterMode: 'qdrant' | 'ignore'): Promise<void> {
    console.log(`cloud verbatim scope (vectorFilterMode=${vectorFilterMode})`);
    const fx = await startCloudFixture({ vectorFilterMode });
    try {
        await fx.as(W1, async () => {
            await fx.vector.store({ id: NODE_ID, text: 'workspace one memory about apples', metadata: { type: 'note' } });
            await fx.vector.store({ id: CUSTOM, text: 'workspace one custom about apples', metadata: { type: 'note' } });
        });
        await fx.as(W2, async () => {
            await fx.vector.store({ id: NODE_ID, text: 'workspace two memory about apples', metadata: { type: 'note' } });
            await fx.vector.store({ id: CUSTOM, text: 'workspace two custom about apples', metadata: { type: 'note' } });
        });

        await test('same logical id in two Lore workspaces -> two physical rows, neither overwrites the other', async () => {
            const all = rows(fx);
            assert.equal(all.length, 4);
            assert.equal(new Set(all.map((r) => r['id'])).size, 4, 'physical ids must be distinct');
            for (const ws of [W1, W2]) {
                for (const lid of [NODE_ID, CUSTOM]) {
                    const r = all.find((x) => x['id'] === dataplaneRowKey(scope(ws), lid));
                    assert.ok(r, `${ws}/${lid} row missing`);
                    assert.equal(r!['lore_workspace'], ws);
                    assert.equal(r!['lore_id'], lid);
                    assert.equal(r!['org_id'], ORG_ID);
                    assert.match(String(r!['text']), ws === W1 ? /workspace one/ : /workspace two/);
                }
            }
        });

        await test('semantic search is scoped and returns each workspace its own row for the shared id', async () => {
            const r2 = await fx.as(W2, () => fx.vector.search('apples', 20));
            assert.deepEqual(r2.map((h) => h.id).sort(), [CUSTOM, NODE_ID].sort());
            for (const h of r2) assert.match(h.text, /workspace two/);
            const r1 = await fx.as(W1, () => fx.vector.search('apples', 20));
            for (const h of r1) assert.match(h.text, /workspace one/);
            assert.equal(r1.length, 2);
        });

        await test('getById is scoped: own row only; an id held only by the other workspace is null', async () => {
            const own = await fx.as(W2, () => fx.vector.getById(NODE_ID));
            assert.match(own?.text ?? '', /workspace two/);
            await fx.as(W1, () => fx.vector.store({ id: 'only-w1', text: 'exclusive to one', metadata: {} }));
            assert.equal(await fx.as(W2, () => fx.vector.getById('only-w1')), null);
            assert.match((await fx.as(W1, () => fx.vector.getById('only-w1')))?.text ?? '', /exclusive/);
        });

        await test('re-storing an id in one workspace is idempotent (one row) and touches nothing else', async () => {
            const before = rows(fx).length;
            await fx.as(W2, () => fx.vector.store({ id: NODE_ID, text: 'workspace two memory REVISED', metadata: { type: 'note' } }));
            await fx.as(W2, () => fx.vector.store({ id: NODE_ID, text: 'workspace two memory REVISED', metadata: { type: 'note' } }));
            // A CHANGED re-store keeps the previous content as one `<id>#rev<ts>` snapshot (item 8), as
            // the local store does; never a duplicate canonical row.
            assert.equal(rows(fx).length, before + 1, 'one snapshot row, no duplicate canonical row');
            assert.equal(rows(fx).filter((x) => x['lore_id'] === NODE_ID && x['lore_workspace'] === W2).length, 1);
            const w1 = rows(fx).find((x) => x['id'] === dataplaneRowKey(scope(W1), NODE_ID))!;
            assert.match(String(w1['text']), /workspace one memory about apples/, 'W1 row must be untouched');
            const w2 = rows(fx).find((x) => x['id'] === dataplaneRowKey(scope(W2), NODE_ID))!;
            assert.match(String(w2['text']), /REVISED/);
        });

        await test('count is per Lore workspace', async () => {
            assert.equal(await fx.as(W1, () => fx.vector.count()), 3); // node, custom, only-w1
            assert.equal(await fx.as(W2, () => fx.vector.count()), 3); // + W2's snapshot of the revised id (count includes history, like local)
        });

        await test('planted foreign-workspace row (buggy writer) is never surfaced to W2 on any read path', async () => {
            const raw = connectedClient(fx.mock.url, DP_KEY);
            // A row that claims W1 but carries W2's row key for the id, plus a W1 row with a W1 key.
            await raw.insert(DP_WORKSPACE, 'lore_verbatim', {
                ...scopeRowFields(scope(W1), 'planted'),
                id: dataplaneRowKey(scope(W2), 'planted'), // wrong key for W1 -> also fails the key check
                vector: new Array<number>(16).fill(1), text: 'apples PLANTED foreign row',
            });
            const hits = await fx.as(W2, () => fx.vector.search('apples planted', 50));
            assert.ok(!hits.some((h) => h.id === 'planted'), 'planted row leaked into vector search');
            const bm = await fx.as(W2, () => fx.vector.bm25Search('planted', 50));
            assert.ok(!bm.hits.some((h) => h.id === 'planted'), 'planted row leaked into keyword search');
            assert.equal(await fx.as(W2, () => fx.vector.getById('planted')), null);
            assert.equal(await fx.as(W2, () => fx.vector.count()), 3, 'count excludes the planted row');
        });

        await test('delete (a tombstone) affects only the caller workspace row for a shared id', async () => {
            await fx.as(W2, () => fx.vector.delete(NODE_ID));
            assert.match((await fx.as(W2, () => fx.vector.getById(NODE_ID)))?.text ?? '', /^\[TOMBSTONED /);
            assert.equal((await fx.as(W2, () => fx.vector.search('apples', 20))).filter((h) => h.id === NODE_ID).length, 0, 'tombstoned row is hidden from search');
            assert.match((await fx.as(W1, () => fx.vector.getById(NODE_ID)))?.text ?? '', /workspace one memory/);
            const hits = await fx.as(W1, () => fx.vector.search('apples', 20));
            assert.ok(hits.some((h) => h.id === NODE_ID), 'W1 row must survive W2 delete');
            // Deleting an id W2 does not own is a no-op for W1's data (and so is a hard delete).
            await fx.as(W2, () => fx.vector.delete('only-w1'));
            await fx.as(W2, () => fx.vector.physicalDelete('only-w1'));
            assert.match((await fx.as(W1, () => fx.vector.getById('only-w1')))?.text ?? '', /exclusive/);
        });

        await test('getContentHashesByIds / listIds never expose another workspace (stubs today; Slice B)', async () => {
            const h = await fx.as(W2, () => fx.vector.getContentHashesByIds([CUSTOM, 'only-w1']));
            assert.ok(!h.has('only-w1'));
            const ids = await fx.as(W2, () => fx.vector.listIds());
            assert.ok(!ids.includes('only-w1'));
        });

        await test('missing Lore workspace -> fail closed: store throws and writes nothing; reads return nothing', async () => {
            const before = rows(fx).length;
            await assert.rejects(() => fx.vector.store({ id: 'orphan', text: 'no workspace', metadata: {} }), /workspace/i);
            assert.equal(rows(fx).length, before);
            await assert.rejects(() => fx.vector.search('apples', 5), /workspace/i);
            assert.equal(await fx.vector.getById(CUSTOM), null);
            assert.equal(await fx.vector.count(), 0);
            await assert.rejects(() => fx.vector.delete(CUSTOM), /workspace/i); // like local, a failed tombstone is loud and changes nothing
            await assert.rejects(() => fx.vector.physicalDelete(CUSTOM), /workspace/i);
            assert.equal(rows(fx).length, before);
        });
    } finally { await fx.close(); }
}

await run('qdrant');
await run('ignore');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
