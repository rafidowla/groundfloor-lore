#!/usr/bin/env tsx
/**
 * cloud-isolation-e2e.ts — cloud parity A2 isolation gate.
 *
 * Two Lore workspaces (W1, W2) live in ONE Dataplane workspace (one credential) and use the
 * SAME logical ids. For every read/write surface, W2 must never see W1's data and nothing W2
 * does may change what W1 sees. Vector/keyword search also run with the mock ignoring the
 * pushed-down filter (`vectorFilterMode:'ignore'`) to prove the client-side predicate alone holds.
 */

import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, type CloudFixture } from './helpers/cloud-stores-fixture.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'iso-ws-one';
const W2 = 'iso-ws-two';
const node = (id: string, label: string, content: string, type = 'note', project = 'proj', tags: string[] = ['t']) =>
    ({ id, type, label, content, tags, project, ecosystem: '*', metadata: '{}' });
const ids = (rs: Array<{ id: string }>): string[] => rs.map((r) => r.id).sort();

/** Run `fn` with `new Date()` / `Date.now()` pinned to one instant, so every write inside shares a timestamp. */
async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
    const RealDate = Date;
    const at = RealDate.now();
    class FrozenDate extends RealDate {
        constructor(...args: unknown[]) {
            if (args.length === 0) super(at);
            else super(...(args as [number]));
        }
        static override now(): number { return at; }
    }
    globalThis.Date = FrozenDate as unknown as DateConstructor;
    try { return await fn(); } finally { globalThis.Date = RealDate; }
}

async function seed(fx: CloudFixture): Promise<void> {
    for (const [ws, tag] of [[W1, 'ONE'], [W2, 'TWO']] as const) {
        await fx.as(ws, async () => {
            // Same logical ids in both workspaces.
            await fx.graph.upsertNode(node('shared-1', `${tag} shared one`, `${tag} content zebra`) as never);
            await fx.graph.upsertNode(node('shared-2', `${tag} shared two`, `${tag} content zebra`, 'decision', 'proj-b') as never);
            await fx.graph.upsertNode(node(`only-${tag}`, `${tag} unique`, `${tag} zebra unique`) as never);
            await fx.graph.addEdge({ sourceId: 'shared-1', targetId: 'shared-2', relation: 'links' } as never);
            await fx.graph.addEdge({ sourceId: 'shared-2', targetId: `only-${tag}`, relation: 'links' } as never);
            await fx.vector.store({ id: 'shared-1', text: `${tag} zebra grazing on the savanna`, metadata: { type: 'note', project: 'proj' } });
            await fx.vector.store({ id: `only-${tag}`, text: `${tag} zebra unique savanna`, metadata: { type: 'note', project: 'proj' } });
        });
    }
}

async function suite(vectorFilterMode: 'qdrant' | 'ignore'): Promise<void> {
    console.log(`cloud isolation (vectorFilterMode=${vectorFilterMode})`);
    const fx = await startCloudFixture({ vectorFilterMode, ftsMode: 'ranked' });
    try {
        await seed(fx);

        await test('getById / getNodesByIds: each workspace gets its own row for the shared id', async () => {
            assert.match((await fx.as(W1, () => fx.graph.getNode('shared-1')))!.label, /^ONE/);
            assert.match((await fx.as(W2, () => fx.graph.getNode('shared-1')))!.label, /^TWO/);
            const m = await fx.as(W2, () => fx.graph.getNodesByIds(['shared-1', 'only-ONE', 'only-TWO']));
            assert.deepEqual([...m.keys()].sort(), ['only-TWO', 'shared-1']);
            assert.equal(await fx.as(W2, () => fx.graph.getNode('only-ONE')), null);
        });

        await test('listNodes is scoped (type, project, tag filters too)', async () => {
            assert.deepEqual(ids(await fx.as(W2, () => fx.graph.listNodes()) as never), ['only-TWO', 'shared-1', 'shared-2']);
            assert.deepEqual(ids(await fx.as(W2, () => fx.graph.listNodes('decision')) as never), ['shared-2']);
            assert.deepEqual(ids(await fx.as(W1, () => fx.graph.listNodes(undefined, undefined, 'proj-b')) as never), ['shared-2']);
            for (const n of await fx.as(W2, () => fx.graph.listNodes()) as Array<{ label: string }>) assert.match(n.label, /^TWO/);
        });

        await test('bulkList is scoped and pages within the workspace', async () => {
            const p = await fx.as(W2, () => fx.graph.bulkList({ limit: 2 }));
            const p2 = p.nextCursor ? await fx.as(W2, () => fx.graph.bulkList({ limit: 2, cursor: p.nextCursor })) : { nodes: [] };
            const all = [...p.nodes, ...p2.nodes] as Array<{ id: string; label: string }>;
            assert.deepEqual(ids(all), ['only-TWO', 'shared-1', 'shared-2']);
            for (const n of all) assert.match(n.label, /^TWO/);
        });

        await test('bulkList: rows sharing one timestamp are neither skipped nor repeated across pages', async () => {
            const tied = ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e'];
            try {
                // Same ids in both workspaces, every row stamped with the same instant.
                await withFrozenClock(async () => {
                    for (const [ws, tag] of [[W1, 'ONE'], [W2, 'TWO']] as const) {
                        for (const id of tied) await fx.as(ws, () => fx.graph.upsertNode(node(id, `${tag} ${id}`, `${tag} tied row`) as never));
                    }
                });
                const stamps = new Set(fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => tied.includes(String(r['lore_id']))).map((r) => r['updated_at']));
                assert.equal(stamps.size, 1, 'the tied rows really share one updated_at');

                const seen: Array<{ id: string; label: string }> = [];
                let cursor: { updatedAt: string; id: string } | undefined;
                for (let page = 0; page < 10; page++) {
                    const p = await fx.as(W2, () => fx.graph.bulkList(cursor ? { limit: 2, cursor } : { limit: 2 }));
                    seen.push(...(p.nodes as Array<{ id: string; label: string }>));
                    if (!p.nextCursor) break;
                    cursor = p.nextCursor;
                }
                assert.deepEqual(seen.map((n) => n.id).sort(), [...tied, 'only-TWO', 'shared-1', 'shared-2'].sort());
                assert.equal(new Set(seen.map((n) => n.id)).size, seen.length, 'no row returned twice');
                for (const n of seen) assert.match(n.label, /^TWO/);
            } finally {
                for (const ws of [W1, W2]) for (const id of tied) await fx.as(ws, () => fx.graph.deleteNode(id));
            }
        });

        await test('graph search is scoped', async () => {
            const r = await fx.as(W2, () => fx.graph.search('zebra', 50));
            assert.deepEqual(ids(r as never), ['only-TWO', 'shared-1', 'shared-2']);
            for (const n of r) assert.match(n.label, /^TWO/);
        });

        await test('queryEdges is scoped', async () => {
            const e = await fx.as(W2, () => fx.graph.queryEdges({ limit: 50, offset: 0 }));
            assert.equal(e.length, 2);
            assert.ok(e.every((x) => x.sourceId !== 'only-ONE' && x.targetId !== 'only-ONE'));
            const bySource = await fx.as(W2, () => fx.graph.queryEdges({ source: 'shared-2', limit: 50, offset: 0 }));
            assert.deepEqual(bySource.map((x) => x.targetId), ['only-TWO']);
        });

        await test('traverse is scoped', async () => {
            const r = await fx.as(W2, () => fx.graph.traverse('shared-1', 3));
            assert.deepEqual(ids(r.map((x) => x.node) as never), ['only-TWO', 'shared-2']);
            for (const x of r) assert.match(x.node.label, /^TWO/);
        });

        await test('vector (semantic) search is scoped', async () => {
            const r = await fx.as(W2, () => fx.vector.search('zebra savanna', 50));
            assert.deepEqual(r.map((h) => h.id).sort(), ['only-TWO', 'shared-1']);
            for (const h of r) assert.match(h.text, /^TWO/);
        });

        await test('keyword search is scoped', async () => {
            const r = await fx.as(W2, () => fx.vector.bm25Search('zebra', 50));
            assert.deepEqual(r.hits.map((h) => h.id).sort(), ['only-TWO', 'shared-1']);
            for (const h of r.hits) assert.match(h.text, /^TWO/);
        });

        await test('vector count is per workspace', async () => {
            assert.equal(await fx.as(W1, () => fx.vector.count()), 2);
            assert.equal(await fx.as(W2, () => fx.vector.count()), 2);
        });

        await test('W2 writes never change what W1 sees', async () => {
            const before = JSON.stringify(await fx.as(W1, () => fx.graph.getNode('shared-1')));
            await fx.as(W2, () => fx.graph.upsertNode(node('shared-1', 'TWO REWRITTEN', 'TWO rewritten content') as never));
            await fx.as(W2, () => fx.vector.store({ id: 'shared-1', text: 'TWO rewritten vector', metadata: { type: 'note' } }));
            assert.equal(JSON.stringify(await fx.as(W1, () => fx.graph.getNode('shared-1'))), before);
            assert.match((await fx.as(W1, () => fx.vector.getById('shared-1')))!.text ?? '', /^ONE/);
        });

        await test('W2 delete affects only W2 (graph node, vector row) — W1 rows, edges and traversal intact', async () => {
            assert.equal(await fx.as(W2, () => fx.graph.deleteNode('shared-1')), true);
            await fx.as(W2, () => fx.vector.delete('shared-1'));
            assert.equal(await fx.as(W2, () => fx.graph.getNode('shared-1')), null);
            assert.match((await fx.as(W1, () => fx.graph.getNode('shared-1')))!.label, /^ONE/);
            assert.match((await fx.as(W1, () => fx.vector.getById('shared-1')))!.text ?? '', /^ONE/);
            assert.equal(await fx.as(W1, () => fx.vector.count()), 2);
            assert.deepEqual(ids((await fx.as(W1, () => fx.graph.traverse('shared-1', 3))).map((x) => x.node) as never), ['only-ONE', 'shared-2']);
            assert.equal((await fx.as(W1, () => fx.graph.queryEdges({ limit: 50, offset: 0 }))).length, 2);
        });

        await test('physical rows: one Dataplane workspace, distinct row per (workspace, id), nothing lost', async () => {
            const nodes = fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_id'] === 'shared-2');
            assert.equal(nodes.length, 2);
            assert.equal(new Set(nodes.map((r) => r['id'])).size, 2);
            assert.deepEqual(nodes.map((r) => r['lore_workspace']).sort(), [W1, W2]);
        });

        await test('unbound Lore workspace fails closed on every surface', async () => {
            await assert.rejects(() => fx.graph.getNode('shared-1'), /workspace/i);
            await assert.rejects(() => fx.graph.listNodes(), /workspace/i);
            await assert.rejects(() => fx.graph.search('zebra', 5), /workspace/i);
            await assert.rejects(() => fx.graph.traverse('shared-1', 2), /workspace/i);
            await assert.rejects(() => fx.vector.search('zebra', 5), /workspace/i);
        });
    } finally { await fx.close(); }
}

await suite('qdrant');
await suite('ignore');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
