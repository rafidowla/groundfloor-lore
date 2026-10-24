#!/usr/bin/env tsx
/**
 * test/link-rebuild-resume-unit.ts - Loop C is a checkpointed diff job: a crash mid-rebuild resumes from the
 * checkpoint and ends in exactly the state an uninterrupted run reaches. Same cases on SQLite and (when
 * LORE_PG_URL is set) Postgres.
 *
 *   crash        process dies after a batch's edges are written but BEFORE its cursor is saved (every possible batch):
 *                a new instance on the same checkpoint file resumes after the last saved cursor, repeats no earlier
 *                batch, and the live + soft-invalidated edge sets (and their stamps) equal an uninterrupted run
 *   no-delete    while a run is mid-way, nothing was deleted or cleared up front (old links still live or soft-invalidated)
 *   optout       an opted-out node keeps its links, gets none, in an uninterrupted AND a crashed+resumed run
 *
 * Run: npx tsx test/link-rebuild-resume-unit.ts
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { StoredVectorLinker, type ComputedLinks } from '../packages/lore/src/link/storedVectorLinker.js';
import { LinkRebuilder, type RebuildSubstrate } from '../packages/lore/src/link/linkRebuilder.js';
import { SqliteRebuildStore, type RebuildState, type RebuildStateStore } from '../packages/lore/src/link/linkRebuildStore.js';
import { FP, P, linkEdges, linkEngines, mkTmp, seed, sorted, type G } from './helpers/linkEngines.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const WS = 'ws';
const P_OLD = P('p-old', 0.5, 4), P_NEW = P('p-new', 0.8, 2);
const SPEC: Array<[string, number]> = [['a', 0], ['b', 10], ['c', 20], ['d', 30], ['e', 40], ['f', 90], ['g', 100], ['h', 200]];
const BATCH = 2;

/** A checkpoint store that "kills the process" on the Nth write: that put and every later one throws. */
class CrashStore implements RebuildStateStore {
    puts = 0;
    constructor(private readonly inner: SqliteRebuildStore, private readonly crashAtPut: number) {}
    get(w: string): RebuildState | null { return this.inner.get(w); }
    put(s: RebuildState): void { if (++this.puts >= this.crashAtPut) throw new Error('simulated crash'); this.inner.put(s); }
    list(): RebuildState[] { return this.inner.list(); }
    close(): void { this.inner.close(); }
}

const { engines, close } = await linkEngines('resume');
for (const eng of engines) {
    console.log(`\n${eng.name}`);

    /** A graph linked under the OLD policy, plus a rebuilder factory targeting the NEW one. */
    const build = async (optOut: string[] = []) => {
        const g: G = await eng.open();
        const vb = await seed(g, SPEC);
        const mk = (pol = P_NEW) => new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), pol, FP);
        await mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        if (optOut.length) await g.setLinkOptOuts(optOut, true);
        const file = path.join(mkTmp('lrr-st-'), 'q.sqlite');
        const batches: string[][] = [];
        const rebuilder = (store: RebuildStateStore) => {
            const linker = mk();
            const sub: RebuildSubstrate = {
                openHandles: (w) => linker.openHandles(w),
                computeLinks: (w, ids): Promise<ComputedLinks | null> => { batches.push([...ids]); return linker.computeLinks(w, ids); },
                currentStamp: () => linker.currentStamp(),
                writeInferred: (w, gr, e) => linker.writeInferred(w, gr, e),
            };
            return new LinkRebuilder({ store, substrate: sub, batchSize: BATCH, yieldMs: 0, maxWaitMs: 100, isBusy: () => false, onError: () => {} });
        };
        const snapshot = async () => {
            const live = await linkEdges(g), gone = await linkEdges(g, { invalid: true });
            return {
                live: [...live].map(([k, v]) => `${k}:${v.origin}:${v.score.toFixed(5)}`).sort(),
                gone: sorted(gone.keys()),
            };
        };
        return { g, file, batches, rebuilder, snapshot, linkEdgeKeys: async () => sorted((await linkEdges(g)).keys()) };
    };
    const runToEnd = async (rb: LinkRebuilder) => { await rb.start(WS); await rb.whenIdle(WS); };

    // Reference: one uninterrupted run.
    const ref = await build();
    await runToEnd(ref.rebuilder(new SqliteRebuildStore(ref.file)));
    const refSnap = await ref.snapshot();
    const nBatches = Math.ceil(SPEC.length / BATCH);

    await test('precondition: the rebuild changes something (otherwise the comparison proves nothing)', async () => {
        const before = await build();
        const snap = await before.snapshot();
        assert.notDeepEqual(snap, refSnap);
        assert.ok(refSnap.gone.length > 0, 'some old links were soft-invalidated');
    });

    // puts: 1 = start(), 2 = run() total, then one per batch. Crash at put (2 + n) = batch n written, its cursor NOT saved.
    for (let n = 1; n <= nBatches; n++) {
        await test(`crash after batch ${n}'s edges are written, before its cursor is saved: resume == uninterrupted run`, async () => {
            const w = await build();
            const crashed = new CrashStore(new SqliteRebuildStore(w.file), 2 + n);
            const rb1 = w.rebuilder(crashed);
            await rb1.start(WS); await rb1.whenIdle(WS);
            const mid = crashed.get(WS)!;
            assert.equal(mid.status, 'running', 'checkpoint still says running (the process never got to record a failure)');
            assert.equal(mid.cursor, n === 1 ? null : SPEC[(n - 1) * BATCH - 1]![0], 'cursor = end of the last fully checkpointed batch');
            crashed.close();

            w.batches.length = 0;
            const store2 = new SqliteRebuildStore(w.file);
            const rb2 = w.rebuilder(store2);
            rb2.resumeAll();                       // what the service does at startup
            await rb2.whenIdle(WS);
            const end = store2.get(WS)!;
            assert.equal(end.status, 'done');
            assert.equal(end.done, SPEC.length);
            const redone = w.batches.flat();
            const already = new Set(SPEC.slice(0, (n - 1) * BATCH).map(([id]) => id));
            assert.ok(redone.length > 0 && redone.every((id) => !already.has(id)), 'no batch before the checkpoint is repeated');
            assert.deepEqual(await w.snapshot(), refSnap, 'same live and invalidated edges, same scores, as an uninterrupted run');
            store2.close();
        });
    }

    await test('no up-front clearing: mid-run every pre-existing link is still readable (live or soft-invalidated)', async () => {
        const w = await build();
        const before = sorted((await linkEdges(w.g)).keys());
        const crashed = new CrashStore(new SqliteRebuildStore(w.file), 2 + 2);   // dies after batch 2
        const rb = w.rebuilder(crashed);
        await rb.start(WS); await rb.whenIdle(WS);
        const live = await linkEdges(w.g), gone = await linkEdges(w.g, { invalid: true });
        for (const k of before) assert.ok(live.has(k) || gone.has(k), `${k} still stored`);
        assert.ok(live.size > 0, 'links keep serving reads while the rebuild is partial');
        crashed.close();
    });

    await test('opt-out honoured in every run shape: links of an opted-out node untouched, none added; crash+resume == uninterrupted', async () => {
        const OUT = 'c';
        const refO = await build([OUT]);
        const oldC = [...(await linkEdges(refO.g)).entries()].filter(([k]) => k.split('|').includes(OUT));
        assert.ok(oldC.length > 0, 'precondition: c had links under the old policy');
        await runToEnd(refO.rebuilder(new SqliteRebuildStore(refO.file)));
        const refOSnap = await refO.snapshot();
        const afterC = [...(await linkEdges(refO.g)).entries()].filter(([k]) => k.split('|').includes(OUT));
        assert.deepEqual(afterC, oldC, 'c links: same pairs, same stamps and scores (not refreshed, not invalidated, none added)');
        assert.equal([...(await linkEdges(refO.g, { invalid: true })).keys()].some((k) => k.split('|').includes(OUT)), false);

        const w = await build([OUT]);
        const crashed = new CrashStore(new SqliteRebuildStore(w.file), 2 + 2);
        const rb1 = w.rebuilder(crashed);
        await rb1.start(WS); await rb1.whenIdle(WS);
        crashed.close();
        const store2 = new SqliteRebuildStore(w.file);
        const rb2 = w.rebuilder(store2);
        rb2.resumeAll(); await rb2.whenIdle(WS);
        assert.deepEqual(await w.snapshot(), refOSnap);
        store2.close();
    });
}
await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
