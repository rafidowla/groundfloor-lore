#!/usr/bin/env tsx
/**
 * test/link-rebuild-parity-unit.ts - the link rebuild throughput changes (lane e3) must not change WHICH links it makes.
 *
 * A full rebuild runs on the same seeded corpus (real SQLite engines and, when LORE_PG_URL names a throwaway server,
 * real Postgres engines) with the pre-e3 behaviour and then with each speed-up switched on cumulatively:
 *   legacy -> + narrow kNN rows -> + batched row reads -> + reuse of computed sets -> + prefetch (= production)
 * and asserts the identical final edge set (endpoints, scores within SCORE_EPS, provenance, invalidations) and identical
 * counters. The corpus has opt-outs, scope + ecosystem confinement, tombstoned nodes, an unembedded node, foreign-origin
 * edges and edges the new policy must remove (see test/helpers/linkRebuildWorld.ts).
 *
 * Run: npx tsx test/link-rebuild-parity-unit.ts
 */
import assert from 'node:assert/strict';
import { LEGACY_TUNING, FAST_TUNING, type RebuildTuning } from '../packages/lore/src/link/linkTuning.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './helpers/testPostgres.js';
import { P_NEW, P_OLD, cleanupTmps, counters, edgeSnapshot, engines, makeRebuilder, runToEnd, seedWorld, type EdgeRow } from './helpers/linkRebuildWorld.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const SCORE_EPS = 1e-5;

const VARIANTS: Array<[string, Partial<RebuildTuning>]> = [
    ['narrow kNN rows', { ...LEGACY_TUNING, narrowRows: true }],
    ['+ batched row reads', { ...LEGACY_TUNING, narrowRows: true, batchLookups: true }],
    ['+ reuse of computed sets', { ...LEGACY_TUNING, narrowRows: true, batchLookups: true, reuseComputed: true }],
    ['+ prefetch (all on)', FAST_TUNING],
];

function sameEdges(a: EdgeRow[], b: EdgeRow[], label: string): void {
    assert.deepEqual(a.map((e) => [e.key, e.origin, e.policy, e.fp, e.invalidated]), b.map((e) => [e.key, e.origin, e.policy, e.fp, e.invalidated]), `${label}: same edges / provenance / invalidations`);
    for (const [i, e] of a.entries()) assert.ok(Math.abs(e.score - b[i]!.score) <= SCORE_EPS, `${label}: score of ${e.key} (${e.score} vs ${b[i]!.score})`);
}

const gatePool = await createGatePool('link-rebuild-parity');
if (gatePool) await cleanupGateWorkspaces(gatePool);

for (const eng of engines(gatePool)) {
    console.log(`\n${eng.name}`);
    for (const batchSize of [4, 17]) {
        const run = async (tuning: Partial<RebuildTuning>) => {
            const w = await eng.open();
            await seedWorld(w);
            if (tuning.prefetch) {
                // Make the edge read slower than the next batch's (parallel) compute, so the prefetched set is in the reuse window deterministically.
                const read = w.g.queryEdges.bind(w.g);
                (w.g as { queryEdges: unknown }).queryEdges = async (q: Parameters<typeof read>[0]) => { await new Promise((r) => setTimeout(r, 25)); return read(q); };
            }
            const before = await edgeSnapshot(w);
            const rb = makeRebuilder(w, P_NEW, { tuning, batchSize });
            const state = await runToEnd(rb);
            const out = { before, after: await edgeSnapshot(w), state, stats: rb.stats() };
            await w.close();
            return out;
        };
        const legacy = await run(LEGACY_TUNING);

        await test(`batch ${batchSize}: the corpus really exercises every branch (so the parity below means something)`, () => {
            const c = counters(legacy.state);
            assert.equal(legacy.state.status, 'done');
            for (const k of ['inserted', 'refreshed', 'invalidated', 'keptForeign', 'skippedNoVector', 'skippedOptOut'] as const) assert.ok(c[k]! > 0, `${k} = ${c[k]}`);
            assert.ok(legacy.after.some((e) => e.invalidated), 'edges removed by the new policy');
            assert.ok(legacy.after.some((e) => e.origin === 'caller') && legacy.after.some((e) => e.origin === 'import'), 'foreign edges survive');
            assert.ok(legacy.before.every((e) => e.policy === 'p-old' || e.origin !== 'link_on_arrival'), 'precondition: old-policy links');
            assert.equal(legacy.stats.reusedComputes, 0);
        });

        for (const [name, tuning] of VARIANTS) {
            await test(`batch ${batchSize}: ${name} -> identical final edges and counters`, async () => {
                const r = await run(tuning);
                sameEdges(r.before, legacy.before, 'seed state');
                sameEdges(r.after, legacy.after, name);
                assert.deepEqual(counters(r.state), counters(legacy.state), `${name}: counters`);
                assert.equal(r.state.status, 'done');
                if (tuning.reuseComputed && tuning.prefetch && batchSize === 17) assert.ok(r.stats.reusedComputes > 0, 'the reuse path was exercised');
                if (!tuning.reuseComputed) assert.equal(r.stats.reusedComputes, 0);
            });
        }
    }

    await test('a second run on the finished workspace writes nothing (counters: all unchanged), with every speed-up on', async () => {
        const w = await eng.open();
        await seedWorld(w);
        await runToEnd(makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: 6 }));
        const first = await edgeSnapshot(w);
        const s2 = await runToEnd(makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: 6 }));
        assert.deepEqual([s2.inserted, s2.refreshed, s2.invalidated], [0, 0, 0]);
        sameEdges(await edgeSnapshot(w), first, 'second run');
        await w.close();
    });
    void P_OLD;
}

cleanupTmps();
if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
