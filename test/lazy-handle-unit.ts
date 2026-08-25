#!/usr/bin/env tsx
/**
 * test/lazy-handle-unit.ts — LazyHandle (architecture gap #7).
 *
 * Coverage:
 *   - constructs on first get(), reuses on subsequent get()
 *   - closes after idle timeout, re-opens on next get()
 *   - closeNow() forces immediate close
 *   - constructor failure surfaces; next get() retries
 *   - concurrent get() calls during open share the single construction
 *   - close failure is logged but doesn't throw to caller
 *   - stats reflect open/close counts accurately
 */

import { strict as assert } from 'node:assert';
import { LazyHandle } from '../packages/lore/src/engines/lazyHandle.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('lazy handle');

test('constructs lazily on first get; reuses afterward', async () => {
    let constructs = 0;
    const h = new LazyHandle<{ value: number }>({
        open: async () => { constructs++; return { value: 42 }; },
        close: () => { /* */ },
    });
    assert.equal(constructs, 0, 'no construction before get()');
    const a = await h.get();
    assert.equal(a.value, 42);
    assert.equal(constructs, 1);
    const b = await h.get();
    assert.equal(b, a, 'same instance reused');
    assert.equal(constructs, 1, 'no second construction');
});

test('closes after idle timeout; re-opens on next get', async () => {
    let constructs = 0;
    let closes = 0;
    const h = new LazyHandle<number>({
        open: async () => { constructs++; return constructs; },
        close: () => { closes++; },
        idleTimeoutMs: 20,
    });
    const a = await h.get();
    assert.equal(a, 1);
    // Wait past the idle timer.
    await new Promise(r => setTimeout(r, 35));
    assert.equal(closes, 1, 'idle close fired');
    assert.equal(h.stats().open, false);
    // Next get → re-open.
    const b = await h.get();
    assert.equal(b, 2);
    assert.equal(constructs, 2);
});

test('closeNow forces immediate close even before idle elapses', async () => {
    let closes = 0;
    const h = new LazyHandle<string>({
        open: async () => 'r',
        close: () => { closes++; },
        idleTimeoutMs: 60_000, // would not fire during the test
    });
    await h.get();
    await h.closeNow();
    assert.equal(closes, 1);
    assert.equal(h.stats().open, false);
    // closeNow on already-closed is safe (no double close).
    await h.closeNow();
    assert.equal(closes, 1);
});

test('constructor failure surfaces; next get() retries', async () => {
    let attempts = 0;
    const h = new LazyHandle<string>({
        open: async () => {
            attempts++;
            if (attempts === 1) throw new Error('first try fails');
            return 'ok';
        },
        close: () => { /* */ },
    });
    await assert.rejects(h.get(), /first try fails/);
    const r = await h.get();
    assert.equal(r, 'ok');
    assert.equal(attempts, 2);
});

test('concurrent get() during open shares one construction', async () => {
    let constructs = 0;
    const h = new LazyHandle<number>({
        open: async () => {
            constructs++;
            await new Promise(r => setTimeout(r, 10));
            return 7;
        },
        close: () => { /* */ },
    });
    const [a, b, c] = await Promise.all([h.get(), h.get(), h.get()]);
    assert.equal(a, 7);
    assert.equal(b, 7);
    assert.equal(c, 7);
    assert.equal(constructs, 1, 'all three get() calls shared the single construction');
});

test('close failure is logged but does not throw to caller', async () => {
    const h = new LazyHandle<string>({
        open: async () => 'r',
        close: () => { throw new Error('cleanup failed'); },
    });
    await h.get();
    // Should NOT throw.
    await h.closeNow();
    // Handle is still considered closed even after throw.
    assert.equal(h.stats().open, false);
});

test('stats reflect open/close counts', async () => {
    const h = new LazyHandle<number>({
        open: async () => 1,
        close: () => { /* */ },
        idleTimeoutMs: 10,
    });
    assert.equal(h.stats().opens, 0);
    await h.get();
    assert.equal(h.stats().opens, 1);
    await h.closeNow();
    assert.equal(h.stats().closes, 1);
    await h.get();
    assert.equal(h.stats().opens, 2);
    await h.closeNow();
    assert.equal(h.stats().closes, 2);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
