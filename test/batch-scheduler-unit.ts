#!/usr/bin/env tsx
/**
 * test/batch-scheduler-unit.ts — A4 unit tests
 *
 * Uses a fake clock to fast-forward without real waits.
 */

import { strict as assert } from 'node:assert';
import {
    BatchIngestionScheduler,
    type SchedulerClock,
} from '../packages/lore/src/engines/batchScheduler.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; },
        );
}

class FakeClock implements SchedulerClock {
    private current = 0;
    private nextHandle = 1;
    /** Map handle → { fireAt, fn } */
    private timers = new Map<number, { fireAt: number; fn: () => void }>();
    now(): number { return this.current; }
    setTimeout(fn: () => void, ms: number): unknown {
        const h = this.nextHandle++;
        this.timers.set(h, { fireAt: this.current + ms, fn });
        return h;
    }
    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }
    /** Advance time, firing any timers whose fireAt is reached. */
    async advance(ms: number): Promise<void> {
        const target = this.current + ms;
        // Fire timers in order until we exhaust those due.
        // A timer's fn may schedule new timers — keep looping until
        // nothing is due.
        while (true) {
            let earliest: { handle: number; fireAt: number; fn: () => void } | null = null;
            for (const [h, t] of this.timers) {
                if (t.fireAt > target) continue;
                if (!earliest || t.fireAt < earliest.fireAt) {
                    earliest = { handle: h, fireAt: t.fireAt, fn: t.fn };
                }
            }
            if (!earliest) break;
            this.current = earliest.fireAt;
            this.timers.delete(earliest.handle);
            earliest.fn();
            // Yield to microtasks — handlers are async.
            await Promise.resolve();
            await Promise.resolve();
        }
        this.current = target;
    }
}

async function main() {
    console.log('batch ingestion scheduler — A4');

    /* ---------- registration ---------- */

    await test('register + listStatus + unregister', () => {
        const s = new BatchIngestionScheduler(new FakeClock());
        s.register({ name: 'gmail', intervalMs: 5000, task: async () => { /* noop */ } });
        const list = s.listStatus();
        assert.equal(list.length, 1);
        assert.equal(list[0].name, 'gmail');
        s.unregister('gmail');
        assert.equal(s.listStatus().length, 0);
    });

    await test('register validates inputs', () => {
        const s = new BatchIngestionScheduler(new FakeClock());
        assert.throws(() => s.register({ name: '', intervalMs: 1, task: async () => { /* noop */ } }), /name/);
        assert.throws(() => s.register({ name: 'x', intervalMs: 0, task: async () => { /* noop */ } }), /intervalMs/);
    });

    await test('register rejects duplicate names', () => {
        const s = new BatchIngestionScheduler(new FakeClock());
        s.register({ name: 'gmail', intervalMs: 1000, task: async () => { /* noop */ } });
        assert.throws(
            () => s.register({ name: 'gmail', intervalMs: 1000, task: async () => { /* noop */ } }),
            /already registered/,
        );
    });

    /* ---------- runOnce ---------- */

    await test('runOnce executes regardless of schedule', async () => {
        const s = new BatchIngestionScheduler(new FakeClock());
        let calls = 0;
        s.register({ name: 'manual', intervalMs: 60000, task: async () => { calls++; } });
        await s.runOnce('manual');
        await s.runOnce('manual');
        assert.equal(calls, 2);
        assert.equal(s.listStatus()[0].runCount, 2);
    });

    await test('runOnce throws for unknown job', async () => {
        const s = new BatchIngestionScheduler(new FakeClock());
        await assert.rejects(() => s.runOnce('nope'), /unknown/);
    });

    /* ---------- start + interval ---------- */

    await test('start + advance: job fires every intervalMs', async () => {
        const clock = new FakeClock();
        const s = new BatchIngestionScheduler(clock);
        let calls = 0;
        s.register({ name: 'gmail', intervalMs: 1000, task: async () => { calls++; } });
        s.start();
        // No fire at t=0.
        assert.equal(calls, 0);
        await clock.advance(2500);
        // At 1000 → fire (1); at 2000 → fire (2). Total 2.
        assert.equal(calls, 2);
        s.stop();
    });

    await test('runOnStart fires immediately + then on interval', async () => {
        const clock = new FakeClock();
        const s = new BatchIngestionScheduler(clock);
        let calls = 0;
        s.register({
            name: 'gmail', intervalMs: 1000, runOnStart: true,
            task: async () => { calls++; },
        });
        s.start();
        await Promise.resolve();
        await Promise.resolve();
        // First call kicked synchronously (sort of — async via void).
        // Yield enough microtasks for it to register.
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.ok(calls >= 1);
    });

    await test('reentrancy: long-running task does not stack', async () => {
        const clock = new FakeClock();
        const s = new BatchIngestionScheduler(clock);
        let calls = 0;
        let resolveLong: (() => void) | null = null;
        s.register({
            name: 'slow', intervalMs: 100,
            task: async () => {
                calls++;
                await new Promise<void>(resolve => { resolveLong = resolve; });
            },
        });
        s.start();
        // Advance beyond 5 intervals while one task is in flight.
        await clock.advance(600);
        // Only one call should have started — the next intervals find isRunning=true and skip.
        assert.equal(calls, 1);
        // Release; drain the microtask chain so executeOnce() finishes
        // and reschedules. Then advance to fire the new interval.
        if (resolveLong) (resolveLong as () => void)();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await clock.advance(200);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.ok(calls >= 2, `further interval should trigger; calls=${calls}`);
        s.stop();
    });

    /* ---------- error tracking ---------- */

    await test('errors are caught + tracked, scheduler keeps running', async () => {
        const clock = new FakeClock();
        const s = new BatchIngestionScheduler(clock);
        let attempts = 0;
        s.register({
            name: 'flaky', intervalMs: 100,
            task: async () => {
                attempts++;
                if (attempts < 3) throw new Error(`fail ${attempts}`);
            },
        });
        s.start();
        await clock.advance(500);
        const status = s.listStatus()[0];
        assert.ok(status.runCount >= 3);
        assert.ok(status.errorCount >= 2);
        assert.ok(status.successCount >= 1);
        assert.equal(status.lastError, undefined, 'lastError cleared on success');
        s.stop();
    });

    /* ---------- stop ---------- */

    await test('stop halts further runs', async () => {
        const clock = new FakeClock();
        const s = new BatchIngestionScheduler(clock);
        let calls = 0;
        s.register({ name: 'gmail', intervalMs: 100, task: async () => { calls++; } });
        s.start();
        await clock.advance(250);
        const before = calls;
        s.stop();
        await clock.advance(1000);
        assert.equal(calls, before, 'no further runs after stop');
    });

    /* ---------- post-start register ---------- */

    await test('register after start schedules the new job too', async () => {
        const clock = new FakeClock();
        const s = new BatchIngestionScheduler(clock);
        s.start();
        let calls = 0;
        s.register({ name: 'late', intervalMs: 50, task: async () => { calls++; } });
        await clock.advance(120);
        assert.ok(calls >= 2);
        s.stop();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
