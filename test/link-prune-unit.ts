#!/usr/bin/env tsx
/**
 * test/link-prune-unit.ts - the soft per-node link cap + background prune. Same cases on SQLite and (when
 * LORE_PG_URL is set) Postgres.
 *
 *   enforce     a hub over the cap keeps its C strongest link_on_arrival edges; the rest get valid_to (rows kept)
 *   scope       caller / import / legacy edges are neither counted nor evicted
 *   protect     an edge that is the peer's strongest (or only) link is never evicted: the cap cannot isolate a node
 *   optout      an opted-out node keeps every link, and nobody evicts an edge to it
 *   disabled    cap 0 (default): nothing happens, markDirty is a no-op
 *   resume      a pass stopped midway (busy) continues from its saved cursor in a NEW pruner; same final state as one pass
 *   dirty       a write racing a pass keeps the workspace dirty; a clean pass clears it; sweep only visits dirty workspaces
 *   service     Loop A on a clustered set exceeds the cap; with the cap on and prune(ws) it is enforced, off it is not
 *
 * Run: npx tsx test/link-prune-unit.ts
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import { LinkService } from '../packages/lore/src/link/linkService.js';
import { LinkPruner } from '../packages/lore/src/link/linkPruner.js';
import { SqlitePruneStore } from '../packages/lore/src/link/linkPruneStore.js';
import { SqliteLinkQueue } from '../packages/lore/src/link/sqliteLinkQueue.js';
import { applyLinkOverrides, loadLinkConfig } from '../packages/lore/src/link/linkConfig.js';
import { FP, P, REL, linkEdges, linkEngines, mkTmp, node, pair, seed, sorted, type G } from './helpers/linkEngines.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const WS = 'ws';
const STAMP = { origin: 'link_on_arrival', policyVersion: 'p-test', modelFingerprint: FP } as const;

const { engines, close } = await linkEngines('prune');
for (const eng of engines) {
    console.log(`\n${eng.name}`);

    /** Build a graph from explicit (a, b, score, origin) edges - the prune only reads the graph, no vectors. */
    const world = async (nodes: string[], edges: Array<[string, string, number, string?]>) => {
        const g: G = await eng.open();
        for (const id of nodes) await g.upsertNode(node(id));
        const inferred = edges.filter(([, , , o]) => !o).map(([a, b, s]) => ({ sourceId: a < b ? a : b, targetId: a < b ? b : a, relation: REL, confidenceScore: s, provenance: STAMP }));
        if (inferred.length) await g.addInferredEdgesBatch(inferred);
        for (const [a, b, s, o] of edges.filter((e) => e[3])) await g.addEdge({ sourceId: a, targetId: b, relation: REL, confidence: 'extracted', confidenceScore: s, provenance: { origin: o } } as never);
        return g;
    };
    const mkPruner = (g: G, cap: number, o: { batchSize?: number; isBusy?: () => boolean; file?: string } = {}) => {
        const file = o.file ?? path.join(mkTmp('lp-st-'), 'q.sqlite');
        const store = new SqlitePruneStore(file);
        return { file, store, pruner: new LinkPruner({ store, resolveHandles: async () => ({ graph: g as never, verbatim: {} as never }), cap: () => cap, batchSize: o.batchSize ?? 10, ...(o.isBusy ? { isBusy: o.isBusy } : {}), onError: (m) => { throw new Error(m); } }) };
    };
    const degree = async (g: G, id: string): Promise<number> => [...(await linkEdges(g)).keys()].filter((k) => k.split('|').includes(id)).length;
    // Spokes s1..s4 each have a stronger private partner (t1..t4), so a weak hub edge is never their strongest.
    const star = (extra: Array<[string, string, number, string?]> = []): [string[], Array<[string, string, number, string?]>] => [
        ['H', 's1', 's2', 's3', 's4', 't1', 't2', 't3', 't4', ...extra.flatMap(([a, b]) => [a, b])],
        [['H', 's1', 0.99], ['H', 's2', 0.95], ['H', 's3', 0.92], ['H', 's4', 0.90],
            ['s1', 't1', 0.999], ['s2', 't2', 0.999], ['s3', 't3', 0.999], ['s4', 't4', 0.999], ...extra],
    ];
    const uniq = (a: string[]): string[] => [...new Set(a)];

    await test('enforce: hub keeps its 2 strongest links, the rest get valid_to (rows kept); other edges untouched', async () => {
        const [nodes, edges] = star();
        const g = await world(uniq(nodes), edges);
        const { pruner } = mkPruner(g, 2);
        const before = await linkEdges(g);
        assert.equal(await degree(g, 'H'), 4);
        const r = await pruner.prune(WS);
        assert.deepEqual([r.evicted, r.nodesTrimmed, r.complete], [2, 1, true]);
        const live = await linkEdges(g), gone = await linkEdges(g, { invalid: true });
        assert.equal(await degree(g, 'H'), 2);
        assert.deepEqual(sorted(gone.keys()), [pair('H', 's3'), pair('H', 's4')], 'weakest evicted, soft (still readable)');
        for (const v of gone.values()) assert.ok(v.validTo);
        for (const k of [pair('H', 's1'), pair('H', 's2'), pair('s1', 't1'), pair('s4', 't4')]) assert.ok(live.has(k), `${k} kept`);
        assert.equal(live.size, before.size - 2);
        assert.equal((await pruner.prune(WS)).evicted, 0, 'second pass is a no-op');
    });

    await test('disabled (cap 0): nothing evicted, markDirty is a no-op', async () => {
        const [nodes, edges] = star();
        const g = await world(uniq(nodes), edges);
        const { pruner, store } = mkPruner(g, 0);
        pruner.markDirty(WS);
        assert.equal(store.list().length, 0);
        assert.deepEqual(await pruner.prune(WS), { evicted: 0, nodesTrimmed: 0, complete: true });
        assert.equal(await degree(g, 'H'), 4);
    });

    await test('scope: caller / import / legacy edges are not counted and never evicted', async () => {
        const [nodes, edges] = star([['H', 'c1', 0.1, 'caller'], ['H', 'c2', 0.1, 'import']]);
        const g = await world(uniq(nodes), edges);
        const { pruner } = mkPruner(g, 2);
        await pruner.prune(WS);
        const live = await linkEdges(g);
        assert.ok(live.has(pair('H', 'c1')) && live.has(pair('H', 'c2')), 'foreign edges survive');
        assert.equal([...live].filter(([k, v]) => k.split('|').includes('H') && v.origin === 'link_on_arrival').length, 2, 'only linker edges counted against the cap');
    });

    await test("protect: an edge that is the peer's strongest / only link is never evicted", async () => {
        // s5 is only linked to H, weakest edge: over the cap but protected. s1..s3 each have a stronger private partner.
        const g = await world(['H', 's1', 's2', 's3', 's5', 't1', 't2', 't3'], [['H', 's1', 0.99], ['H', 's2', 0.95], ['H', 's3', 0.92], ['H', 's5', 0.85], ['s1', 't1', 0.999], ['s2', 't2', 0.999], ['s3', 't3', 0.999]]);
        const { pruner } = mkPruner(g, 2);
        await pruner.prune(WS);
        const live = await linkEdges(g);
        assert.ok(live.has(pair('H', 's5')), 's5 keeps its only link (hub stays above the cap)');
        assert.ok(live.has(pair('H', 's1')) && live.has(pair('H', 's2')));
        assert.ok(!live.has(pair('H', 's3')), 'the unprotected extra is evicted');
        for (const id of ['s1', 's2', 's3', 's5']) assert.ok(await degree(g, id) >= 1, `${id} not isolated`);
    });

    await test('optout: an opted-out hub keeps all links; an edge to an opted-out peer is never evicted', async () => {
        const [nodes, edges] = star();
        const g1 = await world(uniq(nodes), edges);
        await g1.setLinkOptOuts(['H'], true);
        await mkPruner(g1, 2).pruner.prune(WS);
        assert.equal(await degree(g1, 'H'), 4, 'opted-out hub untouched');

        const g2 = await world(uniq(nodes), edges);
        await g2.setLinkOptOuts(['s4'], true);
        await mkPruner(g2, 2).pruner.prune(WS);
        const live = await linkEdges(g2);
        assert.ok(live.has(pair('H', 's4')), 'edge to an opted-out peer kept');
        assert.ok(!live.has(pair('H', 's3')), 'ordinary weak edge still evicted');
    });

    await test('resume: a pass stopped after one batch continues from its cursor in a NEW pruner and ends where one pass does', async () => {
        const hubs = ['H1', 'H2', 'H3', 'H4'];
        const nodes = [...hubs, ...hubs.flatMap((h) => [`${h}a`, `${h}b`, `${h}c`, `${h}x`])];
        const edges: Array<[string, string, number]> = hubs.flatMap((h) => [
            [h, `${h}a`, 0.99], [h, `${h}b`, 0.95], [h, `${h}c`, 0.92], [`${h}a`, `${h}x`, 0.999], [`${h}b`, `${h}x`, 0.999], [`${h}c`, `${h}x`, 0.999],
        ] as Array<[string, string, number]>);
        const one = await world(nodes, edges);
        const refRes = await mkPruner(one, 2, { batchSize: 10 }).pruner.prune(WS);
        const refSnap = sorted((await linkEdges(one)).keys());

        const g = await world(nodes, edges);
        let busy = true;
        const a = mkPruner(g, 2, { batchSize: 1, isBusy: () => busy });
        const r1 = await a.pruner.prune(WS);
        assert.equal(r1.complete, false, 'stopped after one batch');
        assert.equal(r1.nodesTrimmed, 1);
        const mid = a.store.get(WS)!;
        assert.ok(mid.cursor !== null, 'cursor checkpointed');
        a.store.close();
        busy = false;
        const b = mkPruner(g, 2, { batchSize: 1, file: a.file });
        const r2 = await b.pruner.prune(WS);
        assert.equal(r2.complete, true);
        assert.equal(r1.evicted + r2.evicted, refRes.evicted);
        assert.deepEqual(sorted((await linkEdges(g)).keys()), refSnap);
        const end = b.store.get(WS)!;
        assert.deepEqual([end.cursor, end.evicted, end.passes], [null, refRes.evicted, 1]);
    });

    await test('dirty: markDirty creates the row; a clean pass clears it; a write racing the pass keeps it; sweep visits only dirty workspaces', async () => {
        const [nodes, edges] = star();
        const g = await world(uniq(nodes), edges);
        const f = mkPruner(g, 2);
        assert.deepEqual(f.pruner.dirtyWorkspaces(), []);
        f.pruner.markDirty('ws-a');
        assert.deepEqual(f.pruner.dirtyWorkspaces(), ['ws-a']);
        const s = await f.pruner.sweep();
        assert.deepEqual([s.evicted, s.complete], [2, true]);
        assert.deepEqual(f.pruner.dirtyWorkspaces(), [], 'clean pass clears dirty');
        assert.equal((await f.pruner.sweep()).evicted, 0, 'nothing dirty: nothing visited');

        // race: a write lands while the pass runs
        const race = mkPruner(g, 2);
        let fired = false;
        // the write lands after the pass has started scanning (inside the first over-cap query)
        const slow = Object.create(g, { linkNodesOverCap: { value: async (...a: Parameters<G['linkNodesOverCap']>) => { if (!fired) { fired = true; racing.markDirty('ws-b'); } return g.linkNodesOverCap(...a); } } });
        const racing = new LinkPruner({ store: race.store, cap: () => 2, batchSize: 10, resolveHandles: async () => ({ graph: slow as never, verbatim: {} as never }) });
        racing.markDirty('ws-b');
        await racing.prune('ws-b');
        assert.equal(race.store.get('ws-b')!.dirty, true, 'dirty stays set: the pass started before the last write');
        await racing.prune('ws-b');
        assert.equal(race.store.get('ws-b')!.dirty, false);
    });

    for (const capOn of [false, true]) {
        await test(`service: clustered set over a cap of 2 - cap ${capOn ? 'on' : 'off'} ${capOn ? 'enforces it' : 'leaves it above'}`, async () => {
            const spec: Array<[string, number]> = [['a', 0], ['b', 5], ['c', 10], ['d', 15], ['e', 20]];
            const g: G = await eng.open();
            const vb = await seed(g, spec);
            const linker = new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), P('p-test', 0.8, 5), FP);
            const cfg = applyLinkOverrides(loadLinkConfig({}, null), { minSim: 0.8, k: 5, quietMs: 0, yieldMs: 0, maxLinksPerNode: capOn ? 2 : 0 });
            const file = path.join(mkTmp('lp-svc-'), 'q.sqlite');
            const pruner = new LinkPruner({ store: new SqlitePruneStore(file), resolveHandles: async () => ({ graph: g as never, verbatim: vb as never }), cap: () => cfg.maxLinksPerNode, batchSize: 10 });
            const svc = new LinkService({ queue: new SqliteLinkQueue(file), linker, config: cfg, pruner, resolveGraph: async () => g as never });
            try {
                svc.signal(WS, spec.map(([id]) => ({ id })));
                await svc.flush();
                assert.equal((await linkEdges(g)).size, 10, 'k=5 over 5 mutually similar nodes: every pair linked');
                assert.equal(svc.stats().prune?.dirtyWorkspaces, capOn ? 1 : 0, 'link writes mark the workspace dirty only when a cap is set');
                const r = await svc.prune(WS);
                const live = await linkEdges(g), gone = await linkEdges(g, { invalid: true });
                if (!capOn) {
                    assert.equal(r.evicted, 0);
                    assert.equal(live.size, 10);
                    return;
                }
                assert.ok(r.evicted > 0 && gone.size === r.evicted, 'extras soft-invalidated');
                for (const v of gone.values()) assert.ok(v.validTo);
                // Invariant: a node above the cap only holds edges beyond it that are the peer's strongest link.
                const score = (k: string) => live.get(k)!.score;
                for (const [id] of spec) {
                    const mine = [...live.keys()].filter((k) => k.split('|').includes(id)).sort((x, y) => score(y) - score(x) || (x < y ? -1 : 1));
                    assert.ok(mine.length >= 1, `${id} not isolated`);
                    for (const k of mine.slice(2)) {
                        const peer = k.split('|').find((x) => x !== id)!;
                        const theirs = [...live.keys()].filter((kk) => kk.split('|').includes(peer)).sort((x, y) => score(y) - score(x) || (x < y ? -1 : 1));
                        assert.equal(theirs[0], k, `${id}'s edge ${k} above the cap must be ${peer}'s strongest`);
                    }
                }
                assert.equal(svc.stats().prune?.evictedTotal, r.evicted);
                assert.equal(svc.stats().prune?.dirtyWorkspaces, 0);
            } finally { svc.close(); }
        });
    }
}
await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
