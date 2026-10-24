#!/usr/bin/env tsx
/**
 * test/ingestion-tickloop-unit.ts - the ingestion scheduler: non-overlap, error resilience, bounded stop.
 * The final loop is started and deliberately never stopped: if its timers were not unref'd this script
 * would hang instead of exiting.
 */
import assert from 'node:assert/strict';
import { TickLoop } from '../packages/lore/src/ingestion/tickLoop.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(5); } }

await test('a slow task never overlaps itself, even when its run is longer than its interval', async () => {
    let active = 0; let maxActive = 0; let runs = 0;
    const l = new TickLoop({ jitter: 0 });
    l.add({ name: 'slow', intervalMs: 5, run: async () => { active++; maxActive = Math.max(maxActive, active); runs++; await sleep(40); active--; } });
    l.start();
    await until(() => runs >= 3);
    assert.equal(maxActive, 1);
    assert.equal(await l.stop(500), true);
});

await test('tickNow joins a run already in flight instead of starting a second', async () => {
    let runs = 0; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const l = new TickLoop({ jitter: 0 });
    l.add({ name: 't', intervalMs: 60_000, run: async () => { runs++; await gate; } });
    const a = l.tickNow('t'); const b = l.tickNow('t');
    await sleep(20); assert.equal(runs, 1);
    release(); await Promise.all([a, b]);
    await l.tickNow('t'); assert.equal(runs, 2);
    await l.stop();
});

await test('a failing task is reported by class only and keeps running; a throwing reporter does not break the loop', async () => {
    const seen: Array<[string, string]> = []; let runs = 0; let other = 0;
    const l = new TickLoop({ jitter: 0, onError: (t, c) => { seen.push([t, c]); throw new Error('reporter bug'); } });
    l.add({ name: 'bad', intervalMs: 5, run: async () => { runs++; throw new RangeError('secret-looking detail: postgres://u:p@h/db'); } });
    l.add({ name: 'good', intervalMs: 5, run: async () => { other++; } });
    l.start();
    await until(() => runs >= 3 && other >= 3);
    assert.ok(seen.length >= 3); assert.deepEqual(seen[0], ['bad', 'RangeError']);
    assert.ok(!JSON.stringify(seen).includes('postgres://'), 'the error message never reaches the reporter');
    await l.stop(200);
});

await test('stop waits for an in-flight run but only up to the deadline, and stops re-arming', async () => {
    let runs = 0; let finished = false;
    const l = new TickLoop({ jitter: 0 });
    l.add({ name: 'long', intervalMs: 5, run: async () => { runs++; await sleep(300); finished = true; } });
    l.start(); await until(() => runs === 1);
    const t0 = Date.now();
    assert.equal(await l.stop(40), false, 'timed out waiting');
    assert.ok(Date.now() - t0 < 250, 'returned at the deadline, not after the run');
    await sleep(400);
    assert.equal(finished, true); assert.equal(runs, 1, 'no new run after stop');
    const l2 = new TickLoop({ jitter: 0 }); let r2 = 0;
    l2.add({ name: 'q', intervalMs: 5, run: async () => { r2++; await sleep(30); } });
    l2.start(); await until(() => r2 === 1);
    assert.equal(await l2.stop(500), true, 'drains when the run finishes in time');
});

await test('duplicate task names are refused; tasks added after start are armed', async () => {
    const l = new TickLoop({ jitter: 0 }); l.add({ name: 'a', intervalMs: 1000, run: async () => undefined });
    assert.throws(() => l.add({ name: 'a', intervalMs: 1000, run: async () => undefined }));
    l.start(); let n = 0; l.add({ name: 'late', intervalMs: 5, run: async () => { n++; } });
    await until(() => n >= 2); await l.stop();
});

// Deliberately never stopped (see header): proves the timers are unref'd.
const forever = new TickLoop(); forever.add({ name: 'never-stopped', intervalMs: 20, run: async () => undefined }); forever.start();

console.log(`ingestion-tickloop: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
