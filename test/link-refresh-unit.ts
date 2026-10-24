#!/usr/bin/env tsx
/**
 * test/link-refresh-unit.ts - Loop B: refresh a node's links when its content / vector changes, same cases on
 * SQLite and (when LORE_PG_URL is set) Postgres.
 *
 *   edit         an edit that moves a node drops its old links (valid_to set, row kept) and links the new neighbours
 *   baseline     WITHOUT refresh (linkBatch, Loop A only) the stale links stay live - the gap Loop B closes
 *   asymmetry    a link the OTHER endpoint still wants is kept
 *   foreign      caller / import edges are never invalidated
 *   optout       an opted-out node keeps its links when it is refreshed AND when a neighbour is refreshed; nobody links to it
 *   novector     a node with no stored vector yet is retried, its links untouched
 *   service      refreshOnChange=false leaves stale links live; =true retires them and reports it in stats
 *
 * Run: npx tsx test/link-refresh-unit.ts
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import { LinkService } from '../packages/lore/src/link/linkService.js';
import { SqliteLinkQueue } from '../packages/lore/src/link/sqliteLinkQueue.js';
import { applyLinkOverrides, loadLinkConfig } from '../packages/lore/src/link/linkConfig.js';
import { FP, P, REL, linkEdges, linkEngines, mkTmp, pair, seed, sorted } from './helpers/linkEngines.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const WS = 'ws';
const POL = P('p-test', 0.8, 2);
// a, b, c form one cluster near 0 degrees; d, e another near 200 degrees.
const SPEC: Array<[string, number]> = [['a', 0], ['b', 10], ['c', 20], ['d', 200], ['e', 205]];
const ALL = SPEC.map(([id]) => ({ id }));

const { engines, close } = await linkEngines('refresh');
for (const eng of engines) {
    console.log(`\n${eng.name}`);
    const rig = async (spec = SPEC) => {
        const g = await eng.open();
        const vb = await seed(g, spec);
        const linker = new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), POL, FP);
        await linker.linkBatch(WS, spec.map(([id]) => ({ id })));
        return { g, vb, linker };
    };

    await test('edit: old links get valid_to (row kept), new neighbours are linked, untouched links stay', async () => {
        const { g, vb, linker } = await rig();
        assert.deepEqual(sorted((await linkEdges(g)).keys()), sorted([pair('a', 'b'), pair('a', 'c'), pair('b', 'c'), pair('d', 'e')]));
        vb.set('a', 200); // the content edit moved a next to d and e
        const res = await linker.refreshBatch(WS, [{ id: 'a' }]);
        assert.deepEqual(res.done, ['a']);
        assert.equal(res.invalidated, 2);
        assert.deepEqual(sorted((await linkEdges(g)).keys()), sorted([pair('a', 'd'), pair('a', 'e'), pair('b', 'c'), pair('d', 'e')]));
        const gone = await linkEdges(g, { invalid: true });
        assert.deepEqual(sorted(gone.keys()), sorted([pair('a', 'b'), pair('a', 'c')]), 'soft-invalidated, still readable');
        for (const v of gone.values()) assert.ok(v.validTo, 'valid_to set');
    });

    await test('baseline: Loop A alone leaves the stale links live (this is what refresh fixes)', async () => {
        const { g, vb, linker } = await rig();
        vb.set('a', 200);
        await linker.linkBatch(WS, [{ id: 'a' }]);
        const live = await linkEdges(g);
        assert.ok(live.has(pair('a', 'b')) && live.has(pair('a', 'c')), 'stale a-b / a-c survive without refresh');
        assert.equal((await linkEdges(g, { invalid: true })).size, 0);
    });

    await test('asymmetry: a link the other endpoint still wants is kept', async () => {
        // k=1: p -> q (5 deg away), q -> r (1 deg away), r -> q. p-q is wanted by p only.
        const pol1 = P('p-k1', 0.8, 1);
        const g = await eng.open();
        const spec: Array<[string, number]> = [['p', 0], ['q', 5], ['r', 6]];
        const vb = await seed(g, spec);
        const linker = new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), pol1, FP);
        await linker.linkBatch(WS, spec.map(([id]) => ({ id })));
        assert.deepEqual(sorted((await linkEdges(g)).keys()), sorted([pair('p', 'q'), pair('q', 'r')]));
        const res = await linker.refreshBatch(WS, [{ id: 'q' }]);
        assert.equal(res.invalidated, 0, 'p still wants q');
        assert.ok((await linkEdges(g)).has(pair('p', 'q')));
    });

    await test('foreign: a caller edge on the same pair is never invalidated', async () => {
        const { g, vb, linker } = await rig();
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1 } as never);
        vb.set('a', 200);
        await linker.refreshBatch(WS, [{ id: 'a' }]);
        const live = await linkEdges(g);
        assert.ok(live.has(pair('a', 'b')), 'caller edge a-b survives');
        assert.equal(live.get(pair('a', 'b'))!.origin === 'link_on_arrival', false);
        assert.ok((await linkEdges(g, { invalid: true })).has(pair('a', 'c')), 'the linker-made a-c is retired');
    });

    await test('optout: an opted-out node keeps its links, whether it or a neighbour is refreshed; nobody links to it', async () => {
        const { g, vb, linker } = await rig();
        await g.setLinkOptOuts(['b'], true);
        // (1) b itself is refreshed after moving: skipped, links untouched
        vb.set('b', 200);
        const r1 = await linker.refreshBatch(WS, [{ id: 'b' }]);
        assert.deepEqual(r1.done, ['b']);
        assert.equal(r1.invalidated ?? 0, 0);
        assert.ok((await linkEdges(g)).has(pair('a', 'b')) && (await linkEdges(g)).has(pair('b', 'c')));
        // (2) neighbour a moves away: the a-b link to the opted-out node is left exactly as it is, but a-c goes
        vb.set('a', 200);
        const r2 = await linker.refreshBatch(WS, [{ id: 'a' }]);
        assert.equal(r2.invalidated, 1);
        const live = await linkEdges(g);
        assert.ok(live.has(pair('a', 'b')), 'a-b kept: b opted out');
        assert.ok(!live.has(pair('a', 'c')));
        // (3) no new link is made TO the opted-out node
        assert.ok(![...live.keys()].some((k) => k.includes('b') && !['a|b', 'b|c'].includes(k)));
    });

    await test('novector: a node with no vector yet is retried and its links stay', async () => {
        const { g, vb, linker } = await rig();
        vb.set('a', null);
        const res = await linker.refreshBatch(WS, [{ id: 'a' }]);
        assert.deepEqual(res.retry, [{ id: 'a', reason: 'no_vector' }]);
        assert.deepEqual(res.done, []);
        assert.equal((await linkEdges(g, { invalid: true })).size, 0);
        assert.ok((await linkEdges(g)).has(pair('a', 'b')));
    });

    for (const on of [false, true]) {
        await test(`service: refreshOnChange=${on} ${on ? 'retires' : 'keeps'} stale links after a re-commit`, async () => {
            const g = await eng.open();
            const vb = await seed(g, SPEC);
            const linker = new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), POL, FP);
            const cfg = applyLinkOverrides(loadLinkConfig({}, null), { ...POL, quietMs: 0, yieldMs: 0, refreshOnChange: on });
            const svc = new LinkService({ queue: new SqliteLinkQueue(path.join(mkTmp('lf-q-'), 'q.sqlite')), linker, config: cfg });
            try {
                svc.signal(WS, ALL);
                await svc.flush();
                assert.ok((await linkEdges(g)).has(pair('a', 'b')));
                vb.set('a', 200);
                svc.signal(WS, [{ id: 'a' }]); // the edit's vector commit
                await svc.flush();
                const live = await linkEdges(g);
                assert.equal(live.has(pair('a', 'b')), !on);
                assert.equal(live.has(pair('a', 'd')), true, 'new neighbour linked either way');
                const st = svc.stats();
                assert.equal(st.refreshOnChange, on);
                assert.equal(st.invalidatedTotal, on ? 2 : 0);
            } finally { svc.close(); }
        });
    }
}
await test('config: refreshOnChange is on by default; env 0/off and option false turn it off', () => {
    assert.equal(loadLinkConfig({}, null).refreshOnChange, true);
    assert.equal(loadLinkConfig({ LORE_LINK_REFRESH_ON_CHANGE: '0' } as NodeJS.ProcessEnv, null).refreshOnChange, false);
    assert.equal(loadLinkConfig({ LORE_LINK_REFRESH_ON_CHANGE: 'off' } as NodeJS.ProcessEnv, null).refreshOnChange, false);
    assert.equal(applyLinkOverrides(loadLinkConfig({}, null), { refreshOnChange: false }).refreshOnChange, false);
    assert.equal(loadLinkConfig({}, null).maxLinksPerNode, 0, 'soft cap stays off by default');
});
await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
