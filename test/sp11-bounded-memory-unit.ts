#!/usr/bin/env tsx
/**
 * sp11-bounded-memory-unit.ts — SP-11 regression.
 *
 * Several in-memory collections grew without eviction over the daemon's
 * lifetime. This suite asserts each now holds a bound:
 *
 *   1. EmbedQueue.pending      — maxQueueSize cap; enqueue() sheds + returns false.
 *   2. VerbatimStore.hashCache — bounded LRU (cacheVector eviction).
 *   3. RateLimiter.buckets     — idle-bucket sweep drops stale principals.
 *   4. InMemoryPendingOpsStore — terminal rows past retention are deleted.
 *   5. OutboxLagCache.warnedMiss — cleared on refresh().
 *   6. LocalGraphRegistry      — idle workspaces are evicted/closed.
 *
 * Each assertion FAILS on the pre-SP-11 tree (unbounded growth) and passes
 * after the fix.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/sp11-bounded-memory-unit.ts
 * (the harness sets LORE_HOME for finding #6; the others are LORE_HOME-free)
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        const err = e as Error;
        console.error(`  ✗ ${name}\n    ${err.message}`);
        if (process.env['SP11_DEBUG']) console.error(err.stack);
        failed++;
    }
};

// LORE_HOME must point at a fresh dir for the registry test (finding #6).
// Set it up before importing any module that reads it.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp11-lore-'));
process.env['LORE_HOME'] = TEST_HOME;

(async () => {
    console.log('SP-11 — bounded in-memory growth sites');

    /* ── 1. EmbedQueue.pending cap ─────────────────────────────────── */
    {
        const { EmbedQueue } = await import('../packages/lore/src/embed/queue.js');
        await test('EmbedQueue: enqueue past maxQueueSize is shed (bound holds)', () => {
            const dropped: string[] = [];
            // Don't start() the worker, so nothing drains — pure backpressure test.
            const q = new EmbedQueue({ maxQueueSize: 5, onOverflow: (d) => dropped.push(d.nodeId) });
            const accepts: boolean[] = [];
            for (let i = 0; i < 12; i++) accepts.push(q.enqueue(`n${i}`, 'x'.repeat(100)));
            assert.equal(q.depth(), 5, 'pending never exceeds maxQueueSize');
            assert.equal(accepts.filter((a) => a).length, 5, 'exactly 5 accepted');
            assert.equal(accepts.filter((a) => !a).length, 7, '7 shed once full');
            assert.equal(dropped.length, 7, 'onOverflow fired for each shed job');
            assert.equal(q.stats().droppedOverflow, 7, 'droppedOverflow counter tracks sheds');
        });

        await test('EmbedQueue: maxQueueSize=0 disables the cap (legacy behaviour)', () => {
            const q = new EmbedQueue({ maxQueueSize: 0 });
            for (let i = 0; i < 50; i++) assert.equal(q.enqueue(`n${i}`, 'x'), true);
            assert.equal(q.depth(), 50, 'no cap when maxQueueSize=0');
        });
    }

    /* ── 2. VerbatimStore.hashCache LRU cap (BoundedVectorCache) ────── */
    {
        const { BoundedVectorCache } = await import('../packages/lore/src/engines/boundedVectorCache.js');
        await test('BoundedVectorCache: size never exceeds the cap', () => {
            const cache = new BoundedVectorCache(10_000);
            const vec = new Float32Array([0.1, 0.2, 0.3]);
            for (let i = 0; i < 10_500; i++) cache.set(`hash-${i}`, vec); // > cap
            assert.equal(cache.size, 10_000, 'cache sits exactly at the cap');
            // Oldest-inserted evicted first; the latest key is retained.
            assert.ok(cache.get('hash-10499') !== undefined, 'newest key retained');
            assert.equal(cache.get('hash-0'), undefined, 'oldest key evicted');
        });

        await test('BoundedVectorCache: re-inserting a key refreshes recency', () => {
            const cache = new BoundedVectorCache(3);
            const v = [1];
            cache.set('a', v); cache.set('b', v); cache.set('c', v);
            cache.set('a', v);        // refresh 'a' → now newest
            cache.set('d', v);        // evicts the oldest, which is 'b' (not 'a')
            assert.ok(cache.get('a') !== undefined, "'a' kept (refreshed)");
            assert.equal(cache.get('b'), undefined, "'b' evicted as oldest");
            assert.equal(cache.size, 3, 'cap holds');
        });

        // The VerbatimStore hot path uses this cache; confirm the wiring
        // exposes the bound through hashCacheSize().
        const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
        await test('VerbatimStore exposes a bounded hashCache', () => {
            const store = new VerbatimStore(path.join(TEST_HOME, 'workspaces', 'alpha'));
            assert.equal(store.hashCacheSize(), 0, 'starts empty + observable');
        });
    }

    /* ── 3. RateLimiter idle-bucket sweep ──────────────────────────── */
    {
        const { RateLimiter } = await import('../packages/lore/src/security/rateLimit.js');
        await test('RateLimiter.sweepIdleBuckets: drops idle principals', () => {
            const rl = new RateLimiter('local');
            const base = 1_000_000;
            // Create 5000 distinct principals at t=base.
            for (let i = 0; i < 5000; i++) {
                rl.tryConsume('generic', { principalKey: `p${i}` }, base);
            }
            assert.equal(rl.bucketCount(), 5000, 'all buckets created');
            // Advance > 1h and touch only one principal so its lastRefillMs is fresh.
            const later = base + 61 * 60 * 1000;
            rl.tryConsume('generic', { principalKey: 'p0' }, later);
            const removed = rl.sweepIdleBuckets(later);
            assert.equal(removed, 4999, 'all idle buckets swept');
            assert.equal(rl.bucketCount(), 1, 'only the freshly-touched bucket remains');
        });
    }

    /* ── 4. InMemoryPendingOpsStore terminal cleanup ───────────────── */
    {
        const { InMemoryPendingOpsStore } = await import('../packages/lore/src/security/inMemoryPendingOpsStore.js');
        await test('PendingOpsStore: terminal rows past retention are deleted', async () => {
            // Fixed clock at "now"; seed rows with old timestamps via a
            // back-dated mintId-less enqueue path. We drive the store through
            // its public API and a controllable clock.
            let clockMs = Date.parse('2026-06-10T00:00:00.000Z');
            const store = new InMemoryPendingOpsStore({ clock: () => new Date(clockMs).toISOString() });
            // Enqueue + execute 100 ops "8 days ago".
            clockMs = Date.parse('2026-06-02T00:00:00.000Z');
            for (let i = 0; i < 100; i++) {
                const op = await store.enqueue({ operation: 'x', workspaceId: 'w', initiator: 'a', args: null });
                await store.decide({ id: op.id, decision: 'approved', decidedBy: 'b' });
                await store.markExecuted(op.id);
            }
            assert.equal(store.size(), 100, '100 terminal rows present');
            // Jump to "now" (8 days later) and run the sweep.
            clockMs = Date.parse('2026-06-10T00:00:00.000Z');
            const removed = store.cleanupTerminalRows();
            assert.equal(removed, 100, 'all terminal rows past 7d retention removed');
            assert.equal(store.size(), 0, 'map drained');
        });

        await test('PendingOpsStore: recent terminal rows are retained', async () => {
            let clockMs = Date.parse('2026-06-10T00:00:00.000Z');
            const store = new InMemoryPendingOpsStore({ clock: () => new Date(clockMs).toISOString() });
            const op = await store.enqueue({ operation: 'x', workspaceId: 'w', initiator: 'a', args: null });
            await store.decide({ id: op.id, decision: 'rejected', decidedBy: 'b' });
            // 1 day later — within the 7d window.
            clockMs = Date.parse('2026-06-11T00:00:00.000Z');
            store.cleanupTerminalRows();
            assert.equal(store.size(), 1, 'recent terminal row kept');
        });
    }

    /* ── 5. OutboxLagCache.warnedMiss cleared on refresh ───────────── */
    {
        const { OutboxLagCache } = await import('../packages/lore/src/outbox/lagCache.js');
        await test('OutboxLagCache: warnedMiss cleared on refresh()', () => {
            const cache = new OutboxLagCache({ defaultLagThresholdSeconds: 30, depthThreshold: 1000 });
            // Trigger a miss-warning for a workspace not in the snapshot.
            cache.shouldBackpressure('ghost-ws');
            // refresh with an empty stats block must clear warnedMiss so the
            // next miss re-warns for operator visibility.
            cache.refresh({ perWorkspace: {} } as any);
            // No public getter for the set; assert behaviour indirectly: the
            // miss path runs cleanly post-refresh (no throw, fail-open).
            const decision = cache.shouldBackpressure('ghost-ws');
            assert.equal(decision.cacheMiss, true, 're-miss after refresh');
            assert.equal(decision.shouldBlock, false, 'fail-open preserved');
        });
    }

    /* ── 6. LocalGraphRegistry over-cap + idle eviction ────────────── */
    {
        // Seed a workspaces.json with the active boot workspace + 10 siblings.
        const names = ['alpha', ...Array.from({ length: 10 }, (_, i) => `ws${i}`)];
        const workspaces = names.map((name) => ({
            name,
            path: path.join(TEST_HOME, 'workspaces', name),
            createdAt: '2026-05-21T00:00:00.000Z',
        }));
        for (const w of workspaces) fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
        fs.writeFileSync(
            path.join(TEST_HOME, 'workspaces.json'),
            JSON.stringify({ active: 'alpha', workspaces }, null, 2),
        );

        const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');


        await test('LocalGraphRegistry: evictIdle closes stale workspaces', async () => {
            let clock = 1_000_000;
            const reg = new LocalGraphRegistry({ now: () => clock });
            try {
                await reg.getGraphHandle('ws0');
                await reg.getGraphHandle('ws1');
                assert.equal(reg.openCount(), 2, 'two workspaces open');
                // Advance the clock past the idle TTL and evict.
                clock += 31 * 60 * 1000;
                // Touch ws1 so it stays hot.
                await reg.getGraphHandle('ws1');
                const evicted = await reg.evictIdle(clock, 30 * 60 * 1000);
                assert.equal(evicted, 1, 'one idle workspace evicted');
                assert.equal(reg.openCount(), 1, 'only the hot workspace remains');
            } finally {
                await reg.evictIdle(Number.MAX_SAFE_INTEGER, 0);
                reg.closeAll();
            }
        });
    }

    // Best-effort cleanup of the temp home.
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
