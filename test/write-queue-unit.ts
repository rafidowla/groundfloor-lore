#!/usr/bin/env tsx
/**
 * test/write-queue-unit.ts — WriteQueue (architecture gaps #4 + #5).
 *
 * Coverage:
 *   - FIFO ordering
 *   - serial execution (inFlight never exceeds 1)
 *   - failure doesn't poison the queue (next task runs normally)
 *   - drained() resolves only when queued AND inFlight are zero
 *   - maxDepth rejects at enqueue time, bumps `rejected` counter
 *   - executor's return value is propagated to the caller's promise
 *   - stats() reports accurate counts
 */

import { strict as assert } from 'node:assert';
import { WriteQueue } from '../packages/lore/src/engines/writeQueue.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('write queue');

test('FIFO ordering — tasks execute in the order they were enqueued', async () => {
    const order: string[] = [];
    const q = new WriteQueue();
    const promises = [
        q.enqueue('a', async () => { await new Promise(r => setTimeout(r, 5)); order.push('a'); }),
        q.enqueue('b', async () => { order.push('b'); }),
        q.enqueue('c', async () => { order.push('c'); }),
    ];
    await Promise.all(promises);
    assert.deepEqual(order, ['a', 'b', 'c']);
});

test('serial execution — inFlight never exceeds 1 even under concurrent enqueue', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const q = new WriteQueue();
    const promises = Array.from({ length: 10 }, (_, i) => q.enqueue(`t${i}`, async () => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise(r => setTimeout(r, 2));
        inFlight--;
    }));
    await Promise.all(promises);
    assert.equal(maxObserved, 1, 'serialised correctly');
});

test('a failing task does NOT poison subsequent tasks', async () => {
    const q = new WriteQueue();
    const goodRan: string[] = [];
    const failingPromise = q.enqueue('bad', async () => { throw new Error('intentional'); })
        .catch(err => err.message);
    const okPromise = q.enqueue('good', async () => { goodRan.push('good'); return 42; });

    const errMsg = await failingPromise;
    const result = await okPromise;
    assert.equal(errMsg, 'intentional');
    assert.equal(result, 42, 'good task still ran and returned its value');
    assert.deepEqual(goodRan, ['good']);

    const stats = q.stats();
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 1);
});

test('drained() resolves only when both queued and inFlight reach zero', async () => {
    const q = new WriteQueue();
    let resolved = false;
    void q.enqueue('slow', async () => { await new Promise(r => setTimeout(r, 10)); });
    const drainedPromise = q.drained().then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 2));
    assert.equal(resolved, false, 'still in flight');
    await drainedPromise;
    assert.equal(resolved, true);
});

test('maxDepth rejects enqueue and increments rejected counter', async () => {
    const q = new WriteQueue({ maxDepth: 2 });
    // Park one in flight + one queued = depth 2.
    const blocker = q.enqueue('a', async () => { await new Promise(r => setTimeout(r, 50)); });
    const queued = q.enqueue('b', async () => { /* */ });

    await assert.rejects(
        q.enqueue('c', async () => { /* */ }),
        /maxDepth 2 exceeded/,
    );
    assert.equal(q.stats().rejected, 1);
    await Promise.all([blocker, queued]);
});

test('enqueue propagates the executor return value', async () => {
    const q = new WriteQueue();
    const result = await q.enqueue('x', async () => ({ hello: 'world' }));
    assert.deepEqual(result, { hello: 'world' });
});

test('stats() reports completed + failed across multiple tasks', async () => {
    const q = new WriteQueue();
    await Promise.all([
        q.enqueue('1', async () => 1),
        q.enqueue('2', async () => 2),
        q.enqueue('3', async () => { throw new Error('boom'); }).catch(() => null),
        q.enqueue('4', async () => 4),
    ]);
    const s = q.stats();
    assert.equal(s.completed, 3);
    assert.equal(s.failed, 1);
});

test('peekLabels reflects FIFO order of currently-queued tasks', async () => {
    const q = new WriteQueue();
    // Block on a slow one so the rest queue up.
    const blocker = q.enqueue('blocker', async () => { await new Promise(r => setTimeout(r, 20)); });
    void q.enqueue('one', async () => { /* */ });
    void q.enqueue('two', async () => { /* */ });
    void q.enqueue('three', async () => { /* */ });
    // Give the blocker a tick to start, leaving 'one','two','three' queued.
    await new Promise(r => setTimeout(r, 2));
    assert.deepEqual(q.peekLabels(), ['one', 'two', 'three']);
    await blocker;
    await q.drained();
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
