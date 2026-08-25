#!/usr/bin/env tsx
/**
 * sp24-session-lifecycle-unit.ts — SP-24 regression: MCP session lifecycle.
 *
 * Tests:
 *   A. idle sweep — 100 abandoned sessions evicted within 2 sweep cycles
 *   B. hard cap   — registering beyond MAX evicts oldest entries immediately
 *   C. touch      — a touched session is NOT evicted on the next sweep cycle
 *   D. evict      — explicit evict removes session from map and lastSeen
 */

import assert from 'node:assert/strict';
import { createActiveSessionTracker } from '../packages/lore/src/mcp/activeSessions.js';

let passed = 0;
let failed = 0;
const tests: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    tests.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
    })());
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function fakeTransport(id: string): { close: () => void; _id: string } {
    return { close: () => { /* no-op */ }, _id: id };
}

// ── A. Idle sweep evicts 100 abandoned sessions within 2 cycles ───────────────

test('idle sweep — 100 abandoned sessions removed within 2 sweep cycles', async () => {
    const SWEEP_MS = 60;
    const IDLE_MS = 50;
    const tracker = createActiveSessionTracker({
        maxSessions: 200,
        maxIdleMs: IDLE_MS,
        sweepIntervalMs: SWEEP_MS,
    });
    try {
        for (let i = 0; i < 100; i++) {
            const id = `sess-${i}`;
            tracker.map.set(id, fakeTransport(id) as never);
            tracker.touch(id);
        }
        assert.equal(tracker.map.size, 100, 'all 100 registered');

        // Wait longer than idleMs so all sessions are stale, then 2 sweep cycles
        await wait(IDLE_MS + 2 * SWEEP_MS + 30);
        assert.equal(tracker.map.size, 0, `all 100 sessions evicted; remaining: ${tracker.map.size}`);
    } finally {
        clearInterval(tracker.sweepTimer);
    }
});

// ── B. Hard cap evicts oldest when over MAX ───────────────────────────────────

test('hard cap — registering N+1 sessions evicts the oldest within one sweep', async () => {
    const MAX = 5;
    const SWEEP_MS = 50;
    const tracker = createActiveSessionTracker({
        maxSessions: MAX,
        maxIdleMs: 60_000,
        sweepIntervalMs: SWEEP_MS,
    });
    try {
        for (let i = 0; i < MAX + 1; i++) {
            await wait(2); // ensure distinct timestamps
            const id = `cap-${i}`;
            tracker.map.set(id, fakeTransport(id) as never);
            tracker.touch(id);
        }
        // Wait for one sweep cycle to run the cap eviction
        await wait(SWEEP_MS + 30);
        assert.ok(tracker.map.size <= MAX,
            `expected ≤${MAX} sessions after cap sweep, got ${tracker.map.size}`);
        // Oldest (cap-0) should have been evicted
        assert.ok(!tracker.map.has('cap-0'), 'oldest session (cap-0) evicted by cap');
        assert.ok(tracker.map.has(`cap-${MAX}`), 'newest session kept');
    } finally {
        clearInterval(tracker.sweepTimer);
    }
});

// ── C. Touch keeps a session alive past one idle cycle ───────────────────────

test('touch keeps active session alive past idle threshold', async () => {
    // IDLE_MS >> SWEEP_MS so 'alive' can be registered fresh between sweeps
    const IDLE_MS = 200;
    const SWEEP_MS = 60;
    const tracker = createActiveSessionTracker({
        maxSessions: 100,
        maxIdleMs: IDLE_MS,
        sweepIntervalMs: SWEEP_MS,
    });
    try {
        // Register 'dead' at t=0
        tracker.map.set('dead', fakeTransport('dead') as never);
        tracker.touch('dead');

        // Wait until just before 'dead' hits idle threshold, then register 'alive'
        // At t≈(IDLE_MS - 10): 'dead' is almost stale; 'alive' is brand new
        await wait(IDLE_MS - 10);
        tracker.map.set('alive', fakeTransport('alive') as never);
        tracker.touch('alive');

        // Wait for one more sweep cycle — should evict 'dead' (>IDLE_MS idle) but spare 'alive'
        await wait(SWEEP_MS + 30);

        assert.ok(!tracker.map.has('dead'), 'idle session evicted');
        assert.ok(tracker.map.has('alive'), 'freshly-touched session survived');
    } finally {
        clearInterval(tracker.sweepTimer);
    }
});

// ── D. Explicit evict removes session immediately ─────────────────────────────

test('evict immediately removes session from map and lastSeen', () => {
    const tracker = createActiveSessionTracker({ sweepIntervalMs: 60_000 });
    try {
        tracker.map.set('s1', fakeTransport('s1') as never);
        tracker.touch('s1');
        assert.ok(tracker.map.has('s1'), 'session registered');
        tracker.evict('s1');
        assert.ok(!tracker.map.has('s1'), 'session removed by evict');
    } finally {
        clearInterval(tracker.sweepTimer);
    }
});

// ── runner ────────────────────────────────────────────────────────────────────

console.log('\n=== SP-24 session lifecycle unit tests ===\n');
await Promise.all(tests);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
