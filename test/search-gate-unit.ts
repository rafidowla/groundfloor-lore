#!/usr/bin/env tsx
/**
 * test/search-gate-unit.ts — the SearchGate admission-control primitive.
 *
 * Verifies the concurrency semantics that protect the native search engines:
 * bounded concurrent reads, exclusive build drains + blocks reads, overload
 * shedding, no deadlock under the fire-and-forget build pattern, and FIFO
 * fairness (a queued build is never starved by a read stream).
 */

import assert from 'node:assert/strict';
import { SearchGate, SearchOverloadError } from '../packages/lore/src/engines/searchGate.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/** A controllable async task: resolves only when release() is called. */
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

console.log('SearchGate — admission control for the native search engines');

test('bounds concurrent reads to maxConcurrent', async () => {
    const gate = new SearchGate({ maxConcurrent: 2, maxQueue: 100 });
    let active = 0, peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const runs = gates.map((g) => gate.read(async () => { active++; peak = Math.max(peak, active); await g.promise; active--; }));
    await tick();
    assert.equal(peak, 2, `at most 2 reads should run at once, saw ${peak}`);
    assert.equal(active, 2, 'exactly 2 in flight while others queue');
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    assert.equal(peak, 2, 'peak concurrency never exceeded the cap across the whole run');
});

test('exclusive() drains in-flight reads then blocks new reads', async () => {
    const gate = new SearchGate({ maxConcurrent: 3, maxQueue: 100 });
    const r1 = deferred();
    let readDone = false;
    const readP = gate.read(async () => { await r1.promise; readDone = true; });
    await tick();
    let exclusiveRan = false;
    const exP = gate.exclusive(async () => { exclusiveRan = true; assert.ok(readDone, 'exclusive must not start until in-flight reads finished'); });
    await tick();
    assert.equal(exclusiveRan, false, 'exclusive must wait for the in-flight read');
    // A read requested WHILE exclusive is pending must not jump ahead.
    let laterReadRan = false;
    const laterP = gate.read(async () => { laterReadRan = true; assert.ok(exclusiveRan, 'a read queued behind the build must wait for it'); });
    await tick();
    assert.equal(laterReadRan, false, 'new read is blocked while the build is pending/running');
    r1.resolve();                 // let the first read finish → exclusive can run
    await exP;
    assert.ok(exclusiveRan, 'exclusive ran once reads drained');
    await laterP;
    assert.ok(laterReadRan, 'the queued read ran after the build released');
});

test('overload valve: rejects reads past maxQueue with SearchOverloadError', async () => {
    const gate = new SearchGate({ maxConcurrent: 1, maxQueue: 0 });
    const g = deferred();
    const running = gate.read(async () => { await g.promise; }); // holds the only permit
    await tick();
    await assert.rejects(gate.read(async () => { /* never */ }), (e: Error) => e instanceof SearchOverloadError && (e as SearchOverloadError).code === 'search_overloaded');
    g.resolve();
    await running;
    // After it drains, a new read succeeds again.
    assert.equal(await gate.read(async () => 42), 42, 'gate recovers after load sheds');
});

test('no deadlock: a read that fire-and-forgets an exclusive build completes, then the build runs', async () => {
    const gate = new SearchGate({ maxConcurrent: 2, maxQueue: 100 });
    let buildRan = false;
    // Mirror verbatimStore: inside a read, `void gate.exclusive(build)` (NOT awaited).
    await gate.read(async () => {
        void gate.exclusive(async () => { buildRan = true; });
        // the read finishes here and releases its permit
    });
    // Give the queued exclusive a chance to run now that the read released.
    for (let i = 0; i < 10 && !buildRan; i++) await tick();
    assert.ok(buildRan, 'the fire-and-forget build must run after the triggering read releases (no deadlock)');
});

test('FIFO fairness: a queued exclusive is not starved by a steady read stream', async () => {
    const gate = new SearchGate({ maxConcurrent: 2, maxQueue: 1000 });
    // Saturate with 2 slow reads.
    const s1 = deferred(), s2 = deferred();
    const sat = [gate.read(async () => { await s1.promise; }), gate.read(async () => { await s2.promise; })];
    await tick();
    let buildRan = false;
    const exP = gate.exclusive(async () => { buildRan = true; });
    await tick();
    // Now keep firing reads — they must queue BEHIND the pending exclusive, not starve it.
    const laterReads: Array<Promise<void>> = [];
    const laters = [deferred(), deferred()];
    for (const l of laters) laterReads.push(gate.read(async () => { await l.promise; }));
    await tick();
    assert.equal(buildRan, false, 'build still pending while the 2 original reads hold permits');
    // Release the two saturating reads → the exclusive (next in FIFO) must run, NOT the later reads.
    s1.resolve(); s2.resolve();
    await exP;
    assert.ok(buildRan, 'exclusive ran as soon as the original reads drained (not starved by later reads)');
    laters.forEach((l) => l.resolve());
    await Promise.all(laterReads);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
