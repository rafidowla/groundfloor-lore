#!/usr/bin/env tsx
/**
 * test/embed-queue-unit.ts — async embed queue (architecture gap #2).
 *
 * Coverage:
 *   - enqueue + start + drain happy path
 *   - bounded concurrency (in-flight never exceeds limit)
 *   - retry-with-backoff on transient failures
 *   - permanent failure surfaces via onPermanentFailure after maxRetries
 *   - stats() reports accurate counts
 *   - drained() resolves only when queue is fully idle
 *   - stop() halts new pumps but lets in-flight finish
 */

import { strict as assert } from 'node:assert';
import { EmbedQueue } from '../packages/lore/src/embed/queue.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('embed queue');

/* ---------- happy path ---------- */

test('enqueue + start drains every job exactly once', async () => {
    const executed: string[] = [];
    const q = new EmbedQueue();
    q.start(async ({ nodeId }) => { executed.push(nodeId); });
    q.enqueue('a', 'text-a');
    q.enqueue('b', 'text-b');
    q.enqueue('c', 'text-c');
    await q.drained();
    assert.deepEqual(executed.sort(), ['a', 'b', 'c']);
    assert.equal(q.stats().completed, 3);
    assert.equal(q.stats().pending, 0);
    assert.equal(q.stats().inFlight, 0);
});

test('jobs enqueued after start are picked up', async () => {
    const executed: string[] = [];
    const q = new EmbedQueue();
    q.start(async ({ nodeId }) => { executed.push(nodeId); });
    q.enqueue('first', 'x');
    await q.drained();
    q.enqueue('second', 'x');
    await q.drained();
    assert.deepEqual(executed, ['first', 'second']);
});

/* ---------- concurrency ---------- */

test('in-flight never exceeds configured concurrency', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const q = new EmbedQueue({ concurrency: 3 });
    q.start(async () => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
    });
    for (let i = 0; i < 20; i++) q.enqueue(`n${i}`, 'x');
    await q.drained();
    assert.ok(maxObserved <= 3, `concurrency cap violated: observed ${maxObserved}`);
    assert.ok(maxObserved >= 2, `concurrency under-utilised: observed ${maxObserved}`);
});

/* ---------- retry ---------- */

test('transient failure retries with backoff up to maxRetries', async () => {
    let attempts = 0;
    const q = new EmbedQueue({ maxRetries: 3, initialBackoffMs: 1 });
    q.start(async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        // succeeds on the 3rd try (initial + 2 retries)
    });
    q.enqueue('flaky', 'x');
    await q.drained();
    assert.equal(attempts, 3);
    assert.equal(q.stats().completed, 1);
    assert.equal(q.stats().permanentlyFailed, 0);
    assert.equal(q.stats().retries, 2);
});

test('permanent failure after maxRetries fires onPermanentFailure', async () => {
    const dead: string[] = [];
    const q = new EmbedQueue({
        maxRetries: 2,
        initialBackoffMs: 1,
        onPermanentFailure: (job) => { dead.push(job.nodeId); },
    });
    q.start(async () => { throw new Error('always down'); });
    q.enqueue('doomed-1', 'x');
    q.enqueue('doomed-2', 'x');
    await q.drained();
    assert.deepEqual(dead.sort(), ['doomed-1', 'doomed-2']);
    assert.equal(q.stats().permanentlyFailed, 2);
    assert.equal(q.stats().completed, 0);
});

/* ---------- drained semantics ---------- */

test('drained() resolves only when both pending and inFlight reach zero', async () => {
    const q = new EmbedQueue({ concurrency: 1 });
    let resolved = false;
    q.start(async () => { await new Promise(r => setTimeout(r, 10)); });
    q.enqueue('slow', 'x');
    const p = q.drained().then(() => { resolved = true; });
    // Immediately: still in flight, must not be resolved.
    await new Promise(r => setTimeout(r, 2));
    assert.equal(resolved, false);
    await p;
    assert.equal(resolved, true);
});

test('drained() on an already-empty queue resolves immediately', async () => {
    const q = new EmbedQueue();
    q.start(async () => { /* unused */ });
    // No enqueue.
    await q.drained();
    // If we got here without hanging, the test passes.
    assert.equal(q.stats().pending, 0);
});

/* ---------- stop ---------- */

test('stop() prevents NEW pump cycles but lets in-flight finish', async () => {
    let finished = 0;
    const q = new EmbedQueue({ concurrency: 1 });
    q.start(async () => {
        await new Promise(r => setTimeout(r, 5));
        finished++;
    });
    q.enqueue('a', 'x');
    q.enqueue('b', 'x');
    // Tiny delay so 'a' kicks off, then stop while 'b' is still pending.
    await new Promise(r => setTimeout(r, 1));
    q.stop();
    // Wait long enough for both to have finished if pump were running.
    await new Promise(r => setTimeout(r, 20));
    assert.equal(finished, 1, 'only the in-flight job (a) ran after stop');
    assert.equal(q.stats().pending, 1, 'b is still queued');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
