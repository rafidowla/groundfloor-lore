#!/usr/bin/env tsx
/**
 * test/SP-02-graceful-shutdown-unit.ts — SP-02 graceful-shutdown drain.
 *
 * Pins the contract that the daemon shutdown path AWAITS its ordered
 * drain before exiting, rather than firing process.exit synchronously
 * after fire-and-forget stop() calls (the pre-SP-02 bug).
 *
 * The exit function is injected, so we assert ordering without tearing
 * down the test runner: a fake drain that resolves after a tick, and we
 * verify exit is NOT called until that drain resolves.
 *
 *   T1 — requestShutdown awaits the registered drain before exit
 *   T2 — exit fires exactly once even when SIGINT + SIGTERM both call
 *        requestShutdown (idempotent latch)
 *   T3 — a wedged drain still exits via the hard timeout cap
 *   T4 — scheduleConsistencySweep.stop() awaits an in-flight sweep
 *   T5 — EmbedQueue.drained() resolves only after ALL enqueued jobs
 *        (pending + in-flight) complete, so the shutdown drain (await
 *        drained() THEN stop()) lands every embed — no silent drop
 */

import assert from 'node:assert/strict';

import {
    registerDrain,
    requestShutdown,
    __setExitFnForTests,
    __resetForTests,
} from '../packages/lore/src/mcp/shutdownCoordinator.js';
import { scheduleConsistencySweep } from '../packages/lore/src/diagnostics/sweeper.js';
import { EmbedQueue } from '../packages/lore/src/embed/queue.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}: ${(err as Error).message}`);
    }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main(): Promise<void> {
    console.log('SP-02 — graceful shutdown drain');

    await test('T1 — requestShutdown awaits the registered drain before exit', async () => {
        __resetForTests();
        const events: string[] = [];
        let drainResolved = false;

        registerDrain(async () => {
            // Drain that completes asynchronously (after a tick) — the
            // pre-SP-02 sync exit would fire BEFORE this resolved.
            await tick();
            drainResolved = true;
            events.push('drain-done');
        });
        __setExitFnForTests(() => { events.push('exit'); });

        const p = requestShutdown('test');
        // Before awaiting, neither the drain nor exit should have run.
        assert.equal(drainResolved, false, 'drain must not be synchronous');
        assert.deepEqual(events, [], 'exit must not fire before drain resolves');

        await p;
        assert.equal(drainResolved, true, 'drain must have resolved');
        assert.deepEqual(events, ['drain-done', 'exit'], 'exit must fire AFTER drain completes');
    });

    await test('T2 — exit fires exactly once for SIGINT + SIGTERM racing', async () => {
        __resetForTests();
        let exitCount = 0;
        let drainCount = 0;
        registerDrain(async () => { drainCount++; await tick(); });
        __setExitFnForTests(() => { exitCount++; });

        // Two signals landing in the same tick (SIGINT then SIGTERM).
        const a = requestShutdown('SIGINT');
        const b = requestShutdown('SIGTERM');
        await Promise.all([a, b]);

        assert.equal(drainCount, 1, 'drain must run exactly once');
        assert.equal(exitCount, 1, 'exit must fire exactly once');
    });

    await test('T3 — a wedged drain still exits via the hard timeout cap', async () => {
        __resetForTests();
        let exited = false;
        // A drain that never resolves — must NOT block the exit forever.
        registerDrain(() => new Promise<void>(() => { /* never resolves */ }));
        __setExitFnForTests(() => { exited = true; });

        // The coordinator's timeout is unref()'d (correct for prod: a
        // wedged drain must not keep the daemon's loop alive). In-test we
        // hold a ref'd keepalive so Node doesn't exit before the race
        // resolves on the unref'd timer.
        const keepAlive = setInterval(() => {}, 5);
        try {
            await requestShutdown('test', { timeoutMsCap: 20 });
        } finally {
            clearInterval(keepAlive);
        }
        assert.equal(exited, true, 'exit must fire even if the drain wedges');
    });

    await test('T4 — consistency sweep stop() awaits an in-flight sweep', async () => {
        let sweepDone = false;
        const sched = scheduleConsistencySweep(
            async () => {
                await new Promise<void>((r) => setTimeout(r, 30));
                sweepDone = true;
                // Minimal SweepResult shape — only the fields the logger reads.
                return {
                    report: { hasIssues: false, graphNodeCount: 0, vectorEmbeddingCount: 0 },
                    enqueuedForReEmbed: 0,
                    skippedUnchanged: 0,
                    skippedNonEmbeddable: 0,
                    deletedOrphans: 0,
                    failedOrphanDeletes: 0,
                    observedButSkipped: 0,
                } as unknown as Awaited<ReturnType<Parameters<typeof scheduleConsistencySweep>[0]>>;
            },
            5, // fire almost immediately
        );
        // Let one tick start.
        await new Promise<void>((r) => setTimeout(r, 10));
        await sched.stop();
        assert.equal(sweepDone, true, 'stop() must await the in-flight sweep');
    });

    await test('T5 — EmbedQueue drained() resolves after ALL jobs land, then stop()', async () => {
        const completed: string[] = [];
        // concurrency 2 + 4 jobs → 2 in-flight, 2 pending. The shutdown
        // drain awaits drained() FIRST (queue still running so the
        // pending jobs pump too), THEN stop() — so all 4 must land.
        const q = new EmbedQueue({ concurrency: 2, maxRetries: 0, initialBackoffMs: 1 });
        q.start(async ({ nodeId }) => {
            await new Promise<void>((r) => setTimeout(r, 20));
            completed.push(nodeId);
        });
        for (let i = 0; i < 4; i++) q.enqueue(`n${i}`, `t${i}`);

        await q.drained();
        q.stop();
        assert.equal(completed.length, 4, 'all pending + in-flight jobs must complete before drained() resolves');
    });

    console.log(`\nSP-02: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

// Hold a ref'd keepalive for the whole run. Several components under
// test (consistency sweeper, shutdown-timeout) deliberately unref() their
// timers so they never keep the daemon alive in production; without a
// keepalive Node can exit the test process mid-suite the instant the only
// remaining timers are unref'd ones.
const suiteKeepAlive = setInterval(() => {}, 1000);
void main().finally(() => clearInterval(suiteKeepAlive));
