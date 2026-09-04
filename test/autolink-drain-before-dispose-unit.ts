#!/usr/bin/env tsx
/**
 * test/autolink-drain-before-dispose-unit.ts — the ingest-time autolink hook
 * must be DRAINED by the shutdown drain before substrate handles close.
 *
 * The bug: `nodeService.nodeUpsert` fired `reconnectOneNode` with a bare
 * `void` — untracked fire-and-forget. A caller that wrote a burst of nodes
 * with autolink enabled and then called `dispose()` (exactly what
 * benchmarks/longmemeval/src/writeMosaicQuestion.ts does) raced them: the
 * drain closed the legacy graph engine + LanceDB at step 10 while reconnect writes were still in
 * flight, those writes threw against closed handles, and `reconnectOneNode`'s
 * own `catch { }` swallowed them. Semantic edges silently missing, no signal
 * to the caller that anything was dropped.
 *
 * Same class as L-008 (test/v1-migration-reconnect-await-unit.ts) — but the
 * fix CANNOT be the same. migrateV1Sqlite is a batch import and could simply
 * `await Promise.allSettled(...)` inline. nodeUpsert is the trickle-ingest
 * write path, where awaiting would put an ONNX embed + vector search on every
 * synchronous node write — the exact regression bulkIngest.ts exists to avoid
 * ("autolink fires N extra ONNX searches"). So the hook stays async and the
 * DRAIN learns to wait, mirroring `awaitBackgroundReconnect()` (shutdownDrain
 * step 8) and `embedQueue.drained()` (step 5).
 *
 * T1 is the guard against "fixing" this by awaiting inline — it pins that the
 * write path still returns while the hook is in flight. T2/T3 are the actual
 * regression: nothing is in flight once the drain resolves, and the graph
 * close happens strictly AFTER the autolink work finished.
 *
 * ─── Round 2 (adversarial review of the fix above) ───────────────────────
 *
 * The first cut of the drain had three real defects, pinned by T6–T11:
 *
 *   T6/T7 — `awaitPendingAutolinks()` was an UNBOUNDED `while (pending.size)`
 *           loop. Its docstring claimed "the shutdown coordinator's hard
 *           timeout is the backstop", which is FALSE for the embedded path:
 *           `mcp/lifecycle.ts` `makeDispose` deliberately never enters the
 *           coordinator (its own comment says so). One autolink wedged behind
 *           SearchGate therefore hung `dispose()` FOREVER — in exactly the
 *           deployment mode the original bug was reported in.
 *
 *   T8/T9 — nothing stopped an already-in-flight write from registering a NEW
 *           autolink AFTER the drain step had run empty, so it was dropped
 *           when the graph closed moments later. Registration is synchronous
 *           with the call, so the fix is a SEAL at the top of the drain: a
 *           late write skips the best-effort hook entirely rather than
 *           starting work nobody will wait for. Its own graph + verbatim
 *           writes are untouched.
 *
 *  T10/T11 — the tracker was MODULE-GLOBAL, so one Lore instance's stuck
 *            autolink could hold a DIFFERENT instance's dispose() open. It is
 *            now an object on the StorageBundle (one per createLore()), and
 *            the drain waits only on the tracker it was handed.
 */

import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { NodeWriteGraph, NodeUpsertArgs } from '../packages/lore/src/core/nodeService.js';
import { buildShutdownDrain } from '../packages/lore/src/mcp/shutdownDrain.js';
import {
    awaitPendingAutolinks,
    defaultAutolinkTracker,
    pendingAutolinkCount,
    trackPendingAutolink,
    PendingAutolinkTracker,
} from '../packages/lore/src/engines/pendingAutolink.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    // Ref'd keepalive for the duration of each case. The drain deadlines under
    // test are deliberately `unref`'d (a shutdown timer must never hold a
    // host's event loop open — same convention as shutdownDrain step 5 and
    // shutdownCoordinator), so in a test process where nothing else is pending
    // Node would exit BEFORE the deadline fires and report a phantom
    // "unsettled top-level await" instead of the real result.
    const keepAlive = setInterval(() => { /* hold the loop */ }, 50);
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    finally { clearInterval(keepAlive); }
}

/* ─── fakes ──────────────────────────────────────────────────────────── */

function makeFakeGraph(): NodeWriteGraph {
    return {
        async upsertNode() { /* graph write always succeeds here */ },
        async deleteNode() { return true; },
    } as unknown as NodeWriteGraph;
}

function baseArgs(id: string, targetGraph: NodeWriteGraph): NodeUpsertArgs {
    return {
        id,
        workspace: 'test-workspace',
        ecosystem: '*',
        nodeData: { id, type: 'decision', label: `label ${id}`, content: `content for ${id}` },
        targetGraph,
        initiator: 'test:autolink-drain',
        isActiveWorkspace: true,
    } as unknown as NodeUpsertArgs;
}

/**
 * Recording autolink verbatim store. Each hook's store()/search() takes a real
 * wall-clock delay LONGER than the rest of the drain's inert steps, so if the
 * drain did not wait for them the post-drain snapshot would catch them still
 * in flight (inFlight > 0, completed < N). Mirrors the fake in
 * v1-migration-reconnect-await-unit.ts.
 */
const HOOK_DELAY_MS = 250;
interface FakeVerbatim {
    inFlight: number;
    storeCompleted: number;
    searchCompleted: number;
}
function makeFakeVerbatim(events?: string[]): FakeVerbatim & Record<string, unknown> {
    const fake = {
        inFlight: 0,
        storeCompleted: 0,
        searchCompleted: 0,
        async initialize(): Promise<void> { /* no-op */ },
        async store(): Promise<void> {
            fake.inFlight++;
            await new Promise<void>((r) => setTimeout(r, HOOK_DELAY_MS));
            fake.storeCompleted++;
            fake.inFlight--;
        },
        async search(): Promise<Array<{ id: string; score: number }>> {
            fake.inFlight++;
            await new Promise<void>((r) => setTimeout(r, HOOK_DELAY_MS));
            fake.searchCompleted++;
            fake.inFlight--;
            events?.push('autolink-settled');
            return [];
        },
    };
    return fake as unknown as FakeVerbatim & Record<string, unknown>;
}

/** Every REQUIRED ShutdownDrainDeps field, all inert — the drain runs them in
 *  order and only then reaches the autolink wait + graph close. `tracker` is
 *  handed in via the `store` bundle slot, exactly as server.ts does it, so the
 *  drain waits on THIS instance's registry and not a process-global one. */
function inertDeps(tracker?: PendingAutolinkTracker) {
    return {
        syncPoller: { stop: () => undefined },
        outboxReplicator: { stop: async () => undefined },
        embedQueue: { drained: async () => undefined, stop: () => undefined },
        consistencySweeper: { stop: async () => undefined },
        getLoadJobsRunner: () => null,
        authTokenSweeper: { stop: () => undefined },
        stopAllLocalWatchers: () => undefined,
        verbatimStore: null,
        graph: null,
        ...(tracker ? { store: { autolinkTracker: tracker } } : {}),
    };
}

/** Fire N autolinking upserts against `tracker`. Returns once every WRITE has
 *  returned — the hooks themselves are deliberately still in flight. */
async function writeBurst(n: number, verbatim: unknown, tracker: PendingAutolinkTracker): Promise<void> {
    const graph = makeFakeGraph();
    for (let i = 0; i < n; i++) {
        await nodeUpsert(
            baseArgs(`burst-${i}`, graph),
            { autolink: { graph: {} as never, verbatim: verbatim as never, tracker } },
        );
    }
}

console.log('\nAutolink drain — dispose() must not race in-flight reconnect writes\n');

const BURST = 3;

await test('T1: the write path does NOT block on autolink (perf property preserved)', async () => {
    const tracker = new PendingAutolinkTracker();
    const verbatim = makeFakeVerbatim();
    await writeBurst(BURST, verbatim, tracker);
    // Snapshot SYNCHRONOUSLY — no intervening await. If someone "fixed" this
    // by awaiting reconnectOneNode inline, the hooks would already be finished
    // here and this assertion would fail, flagging the perf regression.
    // 2026-08-17 (3.1 skipStore): the hook no longer calls verbatim.store()
    // (nodeService's outbox row is the single canonical writer), so async-ness
    // is pinned on the hook's remaining async work — the neighbour search.
    assert.equal(verbatim.searchCompleted, 0, 'autolink must still be async — writes must not await it');
    assert.ok(tracker.count() > 0, 'in-flight autolinks must be TRACKED, not fire-and-forget');
    await tracker.drain();
});

await test('T2: after the shutdown drain, NO autolink hook is still in flight', async () => {
    const tracker = new PendingAutolinkTracker();
    const verbatim = makeFakeVerbatim();
    await writeBurst(BURST, verbatim, tracker);

    await buildShutdownDrain(inertDeps(tracker) as never)('test');

    // Snapshot SYNCHRONOUSLY right after the drain resolves. Pre-fix, the
    // drain never waited, so these hooks were still pending here.
    const snap = {
        inFlight: verbatim.inFlight,
        storeCompleted: verbatim.storeCompleted,
        searchCompleted: verbatim.searchCompleted,
    };
    assert.equal(snap.inFlight, 0, `inFlight=${snap.inFlight} (autolink writes still racing close())`);
    // 2026-08-17 (functional-correctness 3.1): the hook now runs with
    // skipStore=true — nodeService's own outbox verbatim.upsert row is the
    // single canonical writer, so the autolink hook no longer calls
    // verbatim.store() at all (it only searches for neighbours). Expecting
    // store() here would mean the duplicate-writer race is back.
    assert.equal(snap.storeCompleted, 0, `storeCompleted=${snap.storeCompleted} — the hook must NOT write the canonical row (skipStore)`);
    assert.equal(snap.searchCompleted, BURST, `searchCompleted=${snap.searchCompleted}, expected ${BURST}`);
    assert.equal(tracker.count(), 0, 'tracker must be empty after the drain');
});

await test('T3: graph.close() happens AFTER autolink work settles (the real bug)', async () => {
    // The use-after-close race in one ordering assertion: every autolink must
    // have settled before the drain closes the graph handle it writes to.
    const tracker = new PendingAutolinkTracker();
    const events: string[] = [];
    const verbatim = makeFakeVerbatim(events);
    await writeBurst(BURST, verbatim, tracker);

    const graph = { close: async () => { events.push('graph-closed'); } };
    await buildShutdownDrain({ ...inertDeps(tracker), graph } as never)('test');

    assert.ok(events.includes('graph-closed'), 'drain must close the graph');
    const closeIdx = events.indexOf('graph-closed');
    const settledBeforeClose = events.slice(0, closeIdx).filter((e) => e === 'autolink-settled').length;
    assert.equal(
        settledBeforeClose, BURST,
        `only ${settledBeforeClose}/${BURST} autolinks settled before graph.close() — the rest would write to a closed handle`,
    );
});

await test('T4: awaitPendingAutolinks() is a no-op when nothing is in flight', async () => {
    assert.equal(pendingAutolinkCount(), 0, 'precondition: tracker idle');
    const started = Date.now();
    await awaitPendingAutolinks();
    assert.ok(Date.now() - started < HOOK_DELAY_MS, 'idle drain must return immediately');
});

await test('T5: a REJECTING autolink still drains (cannot wedge the drain)', async () => {
    // reconnectOneNode failures are best-effort and already logged by
    // nodeService's .catch(). The tracker must never turn one into an
    // unhandled rejection or a hung drain.
    let rejected = false;
    trackPendingAutolink(
        (async () => {
            await new Promise<void>((r) => setTimeout(r, 50));
            rejected = true;
            throw new Error('injected autolink failure');
        })(),
    );
    assert.equal(pendingAutolinkCount(), 1, 'rejecting hook is tracked');
    await awaitPendingAutolinks();
    assert.ok(rejected, 'the rejecting hook actually ran');
    assert.equal(pendingAutolinkCount(), 0, 'a rejected hook must still be cleared from the tracker');
});

/* ─── Round 2 ─────────────────────────────────────────────────────────── */

/** A hook that NEVER settles — a SearchGate permit that is never granted, a
 *  wedged native read. Deliberately not `unref`able: if the drain waits on it
 *  without a deadline, the process hangs and the test times out. */
function stuckHook(): Promise<never> {
    return new Promise<never>(() => { /* intentionally never settles */ });
}

/**
 * Race `p` against a hang-detector. The detector timer is deliberately NOT
 * `unref`'d: the drain's own deadline IS unref'd (same convention as
 * shutdownDrain step 5 / shutdownCoordinator — a shutdown timer must never
 * hold a host's event loop open), so with nothing else pending Node would
 * exit before that deadline could fire and the test would report a phantom
 * "unsettled top-level await" instead of a result. The ref'd detector keeps
 * the loop alive exactly long enough to observe the real outcome.
 */
async function withHangDetector<T>(p: Promise<T>, ms: number): Promise<T | 'hung'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<'hung'>((r) => { timer = setTimeout(() => r('hung'), ms); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

await test('T6: a STUCK autolink cannot hang dispose() — the drain is bounded', async () => {
    // THE hang. Pre-fix awaitPendingAutolinks() was `while (pending.size > 0)`
    // with no deadline, and the embedded dispose() path (lifecycle.makeDispose)
    // has no outer timeout either, so this never returned.
    const tracker = new PendingAutolinkTracker();
    tracker.track(stuckHook());

    const started = Date.now();
    const outcome = await withHangDetector(tracker.drain(120).then(() => 'drained' as const), 3000);
    assert.equal(outcome, 'drained', 'drain() must return on its own deadline, not hang');
    assert.ok(Date.now() - started < 2000, 'must return at roughly the deadline, not much later');
});

await test('T7: a timed-out drain REPORTS what it abandoned (no silent loss)', async () => {
    const tracker = new PendingAutolinkTracker();
    tracker.track(stuckHook());
    tracker.track(stuckHook());
    const outcome = await withHangDetector(tracker.drain(80), 3000);
    assert.notEqual(outcome, 'hung', 'drain() must honour its deadline');
    assert.equal((outcome as { timedOut: boolean }).timedOut, true, 'must report the timeout');
    assert.equal(
        (outcome as { abandoned: number }).abandoned, 2,
        'must report HOW MANY hooks were abandoned so the log is actionable',
    );
});

await test('T8: the full shutdown drain completes even with a wedged autolink', async () => {
    // End-to-end: the wedged hook must not stop the drain from reaching
    // step 10 and closing the graph. A shutdown that never finishes is worse
    // than a lost inferred edge (which `reconnect` can rebuild).
    const tracker = new PendingAutolinkTracker();
    tracker.track(stuckHook());
    let closed = false;
    const graph = { close: async () => { closed = true; } };

    const outcome = await withHangDetector(
        buildShutdownDrain({
            ...inertDeps(tracker), graph, autolinkDrainTimeoutMs: 120,
        } as never)('test').then(() => 'drained' as const),
        5000,
    );
    assert.equal(outcome, 'drained', 'dispose() hung on a stuck autolink');
    assert.equal(closed, true, 'the drain must still close substrate handles after giving up on the autolink');
});

await test('T9: the drain SEALS the tracker, so a late write starts no new autolink', async () => {
    // The register-after-drain race: an already-in-flight write (unawaited
    // embedded store(), or an HTTP request server.close() is letting finish)
    // could register a NEW autolink after step 8.5 ran empty — and it then
    // wrote into handles step 10 closed moments later.
    const tracker = new PendingAutolinkTracker();
    const verbatim = makeFakeVerbatim();

    await buildShutdownDrain(inertDeps(tracker) as never)('test');
    assert.equal(tracker.isSealed(), true, 'the drain must seal the tracker');

    // A write landing AFTER the drain — the racing writer.
    await writeBurst(1, verbatim, tracker);
    assert.equal(tracker.count(), 0, 'a post-drain write must not register an undrainable autolink');
    assert.equal(verbatim.storeCompleted, 0, 'and must not start the doomed reconnect at all');
});

await test('T10: sealing does NOT abandon autolinks registered before the drain', async () => {
    // The seal must not become an excuse to drop work that WAS in flight —
    // otherwise it "fixes" the race by throwing away the thing being raced.
    const tracker = new PendingAutolinkTracker();
    const verbatim = makeFakeVerbatim();
    await writeBurst(BURST, verbatim, tracker);
    await buildShutdownDrain(inertDeps(tracker) as never)('test');
    assert.equal(verbatim.searchCompleted, BURST, 'pre-drain autolinks must still be awaited to completion');
});

await test('T11: one instance\'s stuck autolink cannot hold ANOTHER instance\'s dispose', async () => {
    // The tracker used to be module-global, so two createLore() instances in
    // one process shared it and A's dispose() waited on B's hooks.
    const instanceA = new PendingAutolinkTracker();
    const instanceB = new PendingAutolinkTracker();
    instanceB.track(stuckHook());          // B is wedged.

    const verbatim = makeFakeVerbatim();
    await writeBurst(1, verbatim, instanceA);

    const started = Date.now();
    // A's drain uses A's OWN deadline; if it were waiting on the global set it
    // would sit here for the full timeout instead of ~HOOK_DELAY_MS.
    await buildShutdownDrain({ ...inertDeps(instanceA), autolinkDrainTimeoutMs: 4000 } as never)('test');
    const elapsed = Date.now() - started;

    assert.equal(verbatim.searchCompleted, 1, "A's own autolink must still be drained");
    assert.ok(elapsed < 2000, `A's dispose waited ${elapsed}ms — it is still coupled to B's stuck work`);
    assert.equal(instanceB.isSealed(), false, "A's drain must not seal B");
    assert.equal(instanceB.count(), 1, "B's pending work must be untouched by A's drain");
});

await test('T12: with no bundle, the drain falls back to the process-wide tracker', async () => {
    // Hand-built dep sets (and any not-yet-threaded caller) register against
    // `defaultAutolinkTracker`; the drain must still wait on it rather than
    // silently waiting on nothing.
    defaultAutolinkTracker.unsealForTests();
    let done = false;
    trackPendingAutolink((async () => {
        await new Promise<void>((r) => setTimeout(r, 60));
        done = true;
    })());
    await buildShutdownDrain(inertDeps() as never)('test');
    assert.equal(done, true, 'the default tracker must be drained when no bundle tracker is supplied');
    assert.equal(defaultAutolinkTracker.isSealed(), true, 'and sealed, same as an instance tracker');
    defaultAutolinkTracker.unsealForTests();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
