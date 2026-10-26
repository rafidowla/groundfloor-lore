#!/usr/bin/env tsx
/**
 * test/link-rebuild-flow-unit.ts - the run loop of the link rebuild after the throughput work (lane e3):
 *   - stop mid-run + resume with prefetch in flight = same links and counters as one uninterrupted run (real SQLite / Postgres engines)
 *   - a prefetch that fails, a cancel with a prefetch in flight: nothing is left running, nothing is unhandled, the cursor is right
 *   - a prefetch is dropped when the host turned busy; a dropped prefetch is awaited (nothing in flight after seal / close)
 *   - isBusy gets the workspace, may be async, and a throwing probe counts as busy
 *   - idle-aware yield (idle value / busy value / capped / default)
 *   - config: LORE_LINK_REBUILD_IDLE_YIELD_MS default, override, clamp
 *   - REAL PATH: createLinkService (the same factory every host uses) + the admin route, env-configured, against a twin legacy run
 *
 * Run: npx tsx test/link-rebuild-flow-unit.ts
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { LEGACY_TUNING, FAST_TUNING } from '../packages/lore/src/link/linkTuning.js';
import { ComputedWindow } from '../packages/lore/src/link/linkDiff.js';
import { LINK_DEFAULTS, loadLinkConfig } from '../packages/lore/src/link/linkConfig.js';
import { createLinkService } from '../packages/lore/src/link/createLinkService.js';
import { tryLinkRebuildRoutes } from '../packages/lore/src/mcp/http/routes/linkRebuild.js';
import type { RebuildSubstrate } from '../packages/lore/src/link/linkRebuilder.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './helpers/testPostgres.js';
import { N, P_NEW, WS, cleanupTmps, counters, edgeSnapshot, engines, ids, makeRebuilder, mkTmp, runToEnd, seedWorld, type EdgeRow, type World } from './helpers/linkRebuildWorld.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const SCORE_EPS = 1e-5;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const shape = (e: EdgeRow[]): string[] => e.map((x) => `${x.key}|${x.origin}|${x.invalidated}`);
function sameEdges(a: EdgeRow[], b: EdgeRow[], label: string, withStamp = true): void {
    assert.deepEqual(withStamp ? a.map((e) => [e.key, e.origin, e.policy, e.fp, e.invalidated]) : shape(a), withStamp ? b.map((e) => [e.key, e.origin, e.policy, e.fp, e.invalidated]) : shape(b), `${label}: edges`);
    for (const [i, e] of a.entries()) assert.ok(Math.abs(e.score - b[i]!.score) <= SCORE_EPS, `${label}: score of ${e.key}`);
}

/** A substrate wrapper recording every computeLinks call, with hooks to act on call number n. */
function spy(onCall?: (n: number, ids: string[]) => void | Promise<void>) {
    const log = { started: 0, settled: 0, calls: [] as string[][] };
    const wrap = (s: RebuildSubstrate): RebuildSubstrate => ({
        ...s,
        openHandles: (w) => s.openHandles(w), currentStamp: () => s.currentStamp(), writeInferred: (w, g, e) => s.writeInferred(w, g, e),
        computeLinks: async (w, batch) => {
            const n = ++log.started; log.calls.push(batch);
            try { await onCall?.(n, batch); return await s.computeLinks(w, batch); } finally { log.settled++; }
        },
    });
    return { log, wrap };
}

const gatePool = await createGatePool('link-rebuild-flow');
if (gatePool) await cleanupGateWorkspaces(gatePool);
const BATCH = 5;
const BATCHES = Math.ceil(N / BATCH);
const refReused = new Map<string, number>();

for (const eng of engines(gatePool)) {
    console.log(`\n${eng.name}`);
    const fresh = async (): Promise<World> => { const w = await eng.open(); await seedWorld(w); return w; };

    const refW = await fresh();
    const refRb = makeRebuilder(refW, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH });
    const ref = await runToEnd(refRb);
    const refEdges = await edgeSnapshot(refW);
    refReused.set(eng.name, refRb.stats().reusedComputes);
    await refW.close();
    assert.equal(ref.status, 'done');

    for (const sealAt of [1, 2, 4]) {
        await test(`stop (seal) at compute #${sealAt} with a prefetch in flight, then resume in a new instance: same links, same counters, no batch twice`, async () => {
            const w = await fresh();
            const file = path.join(mkTmp('lrf-st-'), 'q.sqlite');
            let rb1!: ReturnType<typeof makeRebuilder>;
            const s1 = spy((n) => { if (n === sealAt) rb1.seal(); });
            rb1 = makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH, file, wrap: s1.wrap });
            await rb1.start(WS); await rb1.whenIdle(WS);
            const mid = rb1.status(WS)!;
            assert.equal(mid.status, 'running', 'a sealed run keeps a resumable checkpoint');
            assert.ok(mid.done > 0 && mid.done < N, `stopped mid-run (done ${mid.done})`);
            assert.equal(mid.cursor, ids[mid.done - 1], 'the cursor is the last id of the last COMPLETED batch (the prefetched batch is not counted)');
            assert.equal(s1.log.started, s1.log.settled, 'no compute left running');
            rb1.close();

            const rb2 = makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH, file });
            const started = await rb2.start(WS);
            assert.equal(started.resumed, true);
            await rb2.whenIdle(WS);
            const end = rb2.status(WS)!;
            assert.equal(end.status, 'done');
            assert.deepEqual(counters(end), counters(ref), 'counters equal the uninterrupted run (a repeated batch would inflate them)');
            sameEdges(await edgeSnapshot(w), refEdges, 'resumed vs uninterrupted');
            rb2.close(); await w.close();
        });
    }

    await test('a prefetch that fails: the run fails with that error and the cursor of the last completed batch; a later start resumes and finishes', async () => {
        const w = await fresh();
        const file = path.join(mkTmp('lrf-st-'), 'q.sqlite');
        const second = ids.slice(BATCH, 2 * BATCH).join();
        const s1 = spy((_n, b) => { if (b.join() === second) throw new Error('boom-prefetch'); });
        const rb1 = makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH, file, wrap: s1.wrap });
        await rb1.start(WS); await rb1.whenIdle(WS);
        const bad = rb1.status(WS)!;
        assert.equal(bad.status, 'failed');
        assert.equal(bad.lastError, 'boom-prefetch');
        assert.equal(bad.done, BATCH, 'batch 1 completed, batch 2 (whose prefetch failed) did not');
        assert.equal(bad.cursor, ids[BATCH - 1]);
        assert.equal(s1.log.started, s1.log.settled);
        rb1.close();
        const rb2 = makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH, file });
        assert.equal((await rb2.start(WS)).resumed, true);
        await rb2.whenIdle(WS);
        assert.equal(rb2.status(WS)!.status, 'done');
        assert.deepEqual(counters(rb2.status(WS)!), counters(ref));
        sameEdges(await edgeSnapshot(w), refEdges, 'after failure + resume');
        rb2.close(); await w.close();
    });

    await test('cancel with a prefetch in flight: cancelled, every started compute settled, cursor = last completed batch', async () => {
        const w = await fresh();
        let rb!: ReturnType<typeof makeRebuilder>;
        const s = spy((n) => { if (n === 2) rb.cancel(WS); });
        rb = makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH, wrap: s.wrap });
        const st = await runToEnd(rb);
        assert.equal(st.status, 'cancelled');
        assert.ok(st.done >= BATCH && st.done < N);
        assert.equal(st.cursor, ids[st.done - 1]);
        assert.equal(s.log.started, s.log.settled);
        rb.close(); await w.close();
    });

    await test('a prefetch is dropped (recomputed) when the host turned busy; the result is unchanged', async () => {
        const w = await fresh();
        let busy = false; let polls = 0;
        const s = spy((n) => { if (n === 2) busy = true; });
        const rb = makeRebuilder(w, P_NEW, {
            tuning: FAST_TUNING, batchSize: BATCH, wrap: s.wrap, isBusy: () => busy, maxWaitMs: 1000,
            sleep: async (ms) => { if (ms === 50 && ++polls >= 2) busy = false; },
        });
        const st = await runToEnd(rb);
        assert.equal(st.status, 'done');
        assert.ok(rb.stats().busyWaits >= 1);
        assert.ok(s.log.started > BATCHES, `the stale prefetch was recomputed (${s.log.started} computes for ${BATCHES} batches)`);
        assert.deepEqual(counters(st), counters(ref));
        sameEdges(await edgeSnapshot(w), refEdges, 'busy mid-run');
        rb.close(); await w.close();
    });

    await test('a prefetch dropped for a busy host is still awaited: after a seal, run() returns only when every started compute has settled', async () => {
        const w = await fresh();
        let busy = false; let polls = 0; let inFlight = 0; let maxInFlight = 0;
        let rb!: ReturnType<typeof makeRebuilder>;
        const second = ids.slice(BATCH, 2 * BATCH).join(); let seen2 = 0;
        const s = spy(async (_n, b) => {
            if (b.join() !== second) return;
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                if (++seen2 === 1) { busy = true; await sleep(250); }   // the prefetch of batch 2: still running when the host's busy wait ends
                else rb.seal();                                         // the recompute of batch 2: stop the run right after it
            } finally { inFlight--; }
        });
        rb = makeRebuilder(w, P_NEW, {
            tuning: FAST_TUNING, batchSize: BATCH, wrap: s.wrap, isBusy: () => busy, maxWaitMs: 1000,
            sleep: async (ms) => { if (ms === 50 && ++polls >= 1) busy = false; },
        });
        await rb.start(WS); await rb.whenIdle(WS);
        assert.equal(rb.status(WS)!.status, 'running', 'sealed mid-run');
        assert.ok(rb.stats().busyWaits >= 1, 'the busy path was taken (the prefetch was dropped)');
        assert.equal(s.log.started, s.log.settled, `every compute settled when run() returned (${s.log.started} started, ${s.log.settled} settled)`);
        assert.equal(inFlight, 0, 'nothing in flight after the run ended');
        assert.equal(maxInFlight, 1, 'a dropped prefetch never overlaps the recompute that replaced it (maxInFlight of batch-2 computes)');
        const d = await rb.drain(1000); assert.equal(d.timedOut, false);
        rb.close(); await w.close();
    });

    await test('the reuse window gets each computed batch exactly once (so it really holds 3 generations, prefetched set included)', async () => {
        const w = await fresh();
        const orig = ComputedWindow.prototype.add; let adds = 0;
        ComputedWindow.prototype.add = function (this: ComputedWindow, ...a: Parameters<ComputedWindow['add']>) { adds++; return orig.apply(this, a); };
        try {
            const rb = makeRebuilder(w, P_NEW, { tuning: FAST_TUNING, batchSize: BATCH });
            assert.equal((await runToEnd(rb)).status, 'done');
            assert.equal(adds, BATCHES, `${adds} window adds for ${BATCHES} batches`);
            rb.close();
        } finally { ComputedWindow.prototype.add = orig; }
        await w.close();
    });

    await test('isBusy receives the workspace and may be async; a probe that throws counts as busy (never idle)', async () => {
        const w = await fresh();
        const seen = new Set<string>(); let calls = 0;
        const rb = makeRebuilder(w, P_NEW, {
            tuning: FAST_TUNING, batchSize: BATCH, maxWaitMs: 1000, sleep: async () => undefined,
            isBusy: async (ws) => { seen.add(ws); await sleep(0); if (++calls <= 2) throw new Error('probe down'); return false; },
        });
        const st = await runToEnd(rb);
        assert.equal(st.status, 'done');
        assert.deepEqual([...seen], [WS]);
        assert.ok(rb.stats().busyWaits >= 1, 'the throwing probe was treated as busy');
        assert.deepEqual(counters(st), counters(ref));
        rb.close(); await w.close();
    });

    await test('legacy (all speed-ups off) computes exactly once per batch, in order, and never reuses', async () => {
        const w = await fresh();
        const s = spy();
        const rb = makeRebuilder(w, P_NEW, { tuning: LEGACY_TUNING, batchSize: BATCH, wrap: s.wrap });
        const st = await runToEnd(rb);
        assert.equal(st.status, 'done');
        assert.equal(rb.stats().reusedComputes, 0);
        for (let b = 0; b < BATCHES; b++) {
            const want = ids.slice(b * BATCH, (b + 1) * BATCH).join();
            assert.equal(s.log.calls.filter((c) => c.join() === want).length, 1, `batch ${b} computed once`);
        }
        sameEdges(await edgeSnapshot(w), refEdges, 'legacy');
        rb.close(); await w.close();
    });
}

console.log('\nidle-aware yield (fake sleep)');
{
    const eng = engines(null)[0]!;
    const yields = async (o: { busy: boolean; yieldMs: number; idleYieldMs?: number }): Promise<number[]> => {
        const w = await eng.open(); await seedWorld(w);
        const slept: number[] = [];
        const rb = makeRebuilder(w, P_NEW, { batchSize: BATCH, yieldMs: o.yieldMs, idleYieldMs: o.idleYieldMs, isBusy: () => o.busy, maxWaitMs: 100, sleep: async (ms) => { slept.push(ms); } });
        const st = await runToEnd(rb);
        assert.equal(st.status, 'done');
        rb.close(); await w.close();
        return slept.filter((ms) => ms !== 50);
    };
    await test('idle host: the idle value is slept between batches (one per gap)', async () => {
        const s = await yields({ busy: false, yieldMs: 200, idleYieldMs: 10 });
        assert.deepEqual(s, Array(BATCHES - 1).fill(10));
    });
    await test('busy host: the full yield is slept, the idle shortcut is not used', async () => {
        const s = await yields({ busy: true, yieldMs: 200, idleYieldMs: 10 });
        assert.deepEqual(s, Array(BATCHES - 1).fill(200));
    });
    await test('the idle value is capped at the yield; unset = the yield (old behaviour)', async () => {
        assert.deepEqual(await yields({ busy: false, yieldMs: 200, idleYieldMs: 500 }), Array(BATCHES - 1).fill(200));
        assert.deepEqual(await yields({ busy: false, yieldMs: 200 }), Array(BATCHES - 1).fill(200));
    });
    await test('idle yield 0 sleeps nothing between batches', async () => {
        assert.deepEqual(await yields({ busy: false, yieldMs: 200, idleYieldMs: 0 }), []);
    });
}

console.log('\nconfig');
await test('LORE_LINK_REBUILD_IDLE_YIELD_MS: default 10, env override, range [0, 60000], out-of-range / junk falls back', () => {
    assert.equal(LINK_DEFAULTS.rebuildIdleYieldMs, 10);
    assert.equal(loadLinkConfig({}).rebuildIdleYieldMs, 10);
    assert.equal(loadLinkConfig({ LORE_LINK_REBUILD_IDLE_YIELD_MS: '0' }).rebuildIdleYieldMs, 0);
    assert.equal(loadLinkConfig({ LORE_LINK_REBUILD_IDLE_YIELD_MS: '75' }).rebuildIdleYieldMs, 75);
    assert.equal(loadLinkConfig({ LORE_LINK_REBUILD_IDLE_YIELD_MS: '60000' }).rebuildIdleYieldMs, 60_000);
    for (const bad of ['999999', '-1', 'abc']) assert.equal(loadLinkConfig({ LORE_LINK_REBUILD_IDLE_YIELD_MS: bad }).rebuildIdleYieldMs, 10, `out of range / junk ${bad} falls back to the default`);
});

console.log('\nreal path: createLinkService + admin route (env-configured)');
for (const eng of engines(gatePool)) {
    await test(`${eng.name}: LORE_LINK_REBUILD_IDLE_YIELD_MS reaches the live rebuilder (a 5 s busy-yield does not slow an idle host) and the links equal a legacy twin`, async () => {
        const w = await eng.open(); await seedWorld(w);
        const twin = await eng.open(); await seedWorld(twin);
        const twinState = await runToEnd(makeRebuilder(twin, P_NEW, { tuning: LEGACY_TUNING, batchSize: BATCH }));
        const twinEdges = await edgeSnapshot(twin);
        await twin.close();

        const svc = createLinkService({
            loreDir: mkTmp('lrf-svc-'),
            env: { LORE_LINK_ON_ARRIVAL: '1', LORE_LINK_MIN_SIM: '0.8', LORE_LINK_K: '2', LORE_LINK_POLICY_VERSION: 'p-new', LORE_LINK_REBUILD_BATCH_SIZE: String(BATCH), LORE_LINK_REBUILD_YIELD_MS: '5000', LORE_LINK_REBUILD_IDLE_YIELD_MS: '0' },
            resolveHandles: async () => ({ graph: w.g as never, verbatim: w.vb as never }),
            embeddingProvider: { modelId: 'fp', dtype: 'test' } as never,
        })!;
        const call = async (method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> => {
            const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {} }) as never;
            let status = 0; let text = '';
            const res = { writeHead: (s: number) => { status = s; }, end: (t?: string) => { text = t ?? ''; }, setHeader: () => undefined, headersSent: false } as never;
            assert.equal(await tryLinkRebuildRoutes(req, res, url, url.split('?')[0]!, { linkService: svc, deploymentMode: 'local', dataplane: null }), true);
            return { status, json: text ? JSON.parse(text) : null };
        };
        const t0 = Date.now();
        assert.equal((await call('POST', '/api/admin/link-rebuild', { workspace: WS })).status, 202);
        for (let i = 0; i < 400 && svc.rebuildStatus(WS)?.status === 'running'; i++) await sleep(25);
        const took = Date.now() - t0;
        const st = (await call('GET', `/api/admin/link-rebuild?workspace=${WS}`)).json.rebuild;
        assert.equal(st.status, 'done');
        assert.ok(took < 8000, `finished in ${took} ms: with 9 batches the 5000 ms busy-yield was not applied to the idle host`);
        for (const k of ['total', 'done', 'inserted', 'invalidated', 'keptForeign', 'skippedNoVector', 'skippedOptOut'] as const) assert.equal(st[k], twinState[k], `counter ${k}`);
        sameEdges(await edgeSnapshot(w), twinEdges, 'service vs legacy twin', false);
        assert.equal(svc.stats().rebuild!.reusedComputes, refReused.get(eng.name), 'the live service reuses exactly as a direct run does (same data, same batch size)');
        assert.equal(svc.stats().rebuild!.busyWaits, 0, 'an idle host (no queue backlog, no host probe) is never waited for');
        svc.close(); await w.close();
    });
}

assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map(String).join('; ')}`);
cleanupTmps();
if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 && unhandled.length === 0 ? 0 : 1);
