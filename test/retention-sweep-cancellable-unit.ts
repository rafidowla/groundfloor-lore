#!/usr/bin/env tsx
/**
 * retention-sweep-cancellable-unit.ts — the daily retention sweep must be
 * cancellable, and the drain must cancel it.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `scheduleRetentionSweep` armed its daily `setInterval` INSIDE the bootstrap
 * callback and never returned that handle. Once the bootstrap had fired (60 s
 * after boot by default), the daily timer was uncancellable by construction —
 * nothing in the process could reach it, and `RetentionScheduler` exposed only
 * `bootstrapTimer`, which by then had already fired and was useless.
 *
 * That matters because the sweep RE-OPENS substrates: `runRetentionSweepAll-
 * Workspaces` (mcp/daemonTimers.ts) resolves each workspace through
 * `registry.getGraphHandle(ws)` and `resolver.getOrOpen(ws)`. The ordered drain
 * closes exactly those handles. And the drain is not run only at process death
 * — `/api/workspaces/switch` and `/api/daemon/restart` run it and the daemon
 * carries on — so a later fire resurrected a graph and a LanceDB handle per
 * workspace, and could leave two live handles on one surrealkv directory.
 *
 * Sibling of the access-tracker resurrection (see
 * test/access-tracker-no-resurrect-unit.ts); found by auditing every
 * `setInterval` in `src` for "can the drain actually stop this, and does it
 * touch a substrate?". Daemon-only in practice, since `startsDaemonTimers`
 * gates the arming — it is NOT the embedded-host hang, and its timer is
 * unref'd so it never held a process open.
 *
 * Run: npx tsx test/retention-sweep-cancellable-unit.ts
 */

import assert from 'node:assert/strict';

// Timings are read at module load, so they must be set BEFORE the import.
process.env['LORE_RETENTION_FIRST_FIRE_MS'] = '30';
process.env['LORE_RETENTION_INTERVAL_MS'] = '30';

const { scheduleRetentionSweep, stopAllRetentionSweeps } =
    await import('../packages/lore/src/mcp/retentionScheduler.js');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => { setTimeout(resolve, ms); });

console.log('Retention sweep — cancellable, and cancelled by the drain');

await test('the sweep fires on its own schedule when left alone (control)', async () => {
    let fires = 0;
    const s = scheduleRetentionSweep(async () => { fires++; });
    try {
        await sleep(150);
        assert.ok(fires >= 2, `expected the bootstrap + at least one interval fire, got ${fires}`);
    } finally {
        s.stop();
    }
});

await test('stop() cancels the DAILY timer, not just the bootstrap', async () => {
    let fires = 0;
    const s = scheduleRetentionSweep(async () => { fires++; });
    await sleep(100);                 // let the bootstrap fire and arm the interval
    const atStop = fires;
    assert.ok(atStop >= 1, 'bootstrap must have fired, else this asserts nothing');
    s.stop();
    await sleep(150);
    assert.equal(fires, atStop,
        'the daily interval kept firing after stop() — its handle is unreachable again '
        + '(it must be held outside the bootstrap callback)');
});

await test('stop() before the bootstrap fires prevents the sweep entirely', async () => {
    let fires = 0;
    const s = scheduleRetentionSweep(async () => { fires++; });
    s.stop();                         // cancelled in the arming window
    await sleep(150);
    assert.equal(fires, 0, 'a scheduler stopped before its first fire must never run');
});

await test('stopAllRetentionSweeps cancels every armed scheduler (what the drain calls)', async () => {
    let a = 0;
    let b = 0;
    scheduleRetentionSweep(async () => { a++; });
    scheduleRetentionSweep(async () => { b++; });
    await sleep(100);
    assert.ok(a >= 1 && b >= 1, 'both must have fired, else this asserts nothing');
    const atStop = [a, b];
    stopAllRetentionSweeps();
    await sleep(150);
    assert.deepEqual([a, b], atStop, 'the drain must silence every armed sweep, not just one');
});

await test('stop() is idempotent and a stopped scheduler is dropped from the registry', async () => {
    let fires = 0;
    const s = scheduleRetentionSweep(async () => { fires++; });
    s.stop();
    s.stop();                          // must not throw
    stopAllRetentionSweeps();          // must not re-stop or throw
    await sleep(80);
    assert.equal(fires, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
