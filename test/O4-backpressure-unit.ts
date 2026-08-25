#!/usr/bin/env tsx
/**
 * test/O4-backpressure-unit.ts — Sprint O4 unit tests.
 *
 * Validates the per-workspace backpressure path without spinning a
 * daemon. Covers:
 *
 *   T1 — lag cache returns 503 decision when injected lag > threshold
 *   T2 — per-workspace isolation: A over threshold, B under — only A
 *        is blocked
 *   T3 — per-workspace threshold override respected
 *   T4 — cache refresh from aggregateStats() updates lag values
 *   T5 — cache miss → fail-open (shouldBlock=false, cacheMiss=true)
 *   T6 — depth threshold also triggers backpressure
 *   T7 — writeOutboxBackpressure helper writes the canonical 503 shape
 *        + Retry-After header
 *   T8 — checkOutboxBackpressure short-circuits when cache says block
 *   T9 — lag check overhead <1ms in steady state (1000 hits, avg < 1ms)
 *  T10 — replicator refreshLagCache() pulls from store.aggregateStats()
 *        on each tick (integration with replicator)
 */

import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';

import { OutboxLagCache, DEFAULT_LAG_THRESHOLD_SECONDS, DEFAULT_DEPTH_THRESHOLD } from '../packages/lore/src/outbox/lagCache.js';
import {
    writeOutboxBackpressure,
    checkOutboxBackpressure,
} from '../packages/lore/src/mcp/http/helpers.js';
import {
    OUTBOX_BACKPRESSURE_CODE,
    OUTBOX_BACKPRESSURE_HEADER,
    OUTBOX_BACKPRESSURE_STATUS,
} from '../packages/lore/src/mcp/http/middleware.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { OutboxAggregateStats } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void): void {
    void Promise.resolve(fn()).then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (err: Error) => { failed++; console.error(`  ✗ ${name}: ${err.message}`); },
    );
}

interface FakeRes {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
    writeHead(status: number, headers?: Record<string, string>): FakeRes;
    end(body?: string): void;
}

function fakeRes(): ServerResponse & FakeRes {
    const r: FakeRes = {
        _status: 0,
        _headers: {},
        _body: '',
        writeHead(status: number, headers?: Record<string, string>) {
            this._status = status;
            if (headers) Object.assign(this._headers, headers);
            return this;
        },
        end(body?: string) { this._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & FakeRes;
}

console.log('Sprint O4 backpressure unit tests');

// ---- T1 — lag > threshold blocks ----
test('T1 lag-cache: injected lag > threshold blocks the workspace', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    cache.testInject('ws-slow', 60, 5);
    const d = cache.shouldBackpressure('ws-slow');
    assert.equal(d.shouldBlock, true, 'should block at lag=60s > threshold=30s');
    assert.equal(d.currentLagSeconds, 60);
    assert.equal(d.thresholdSeconds, 30);
    assert.equal(d.outboxDepth, 5);
    assert.equal(d.cacheMiss, false);
});

// ---- T2 — per-workspace isolation ----
test('T2 per-workspace isolation: A blocked, B passes', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    cache.testInject('ws-A', 60, 100);
    cache.testInject('ws-B', 1, 1);
    const a = cache.shouldBackpressure('ws-A');
    const b = cache.shouldBackpressure('ws-B');
    assert.equal(a.shouldBlock, true, 'A over threshold must block');
    assert.equal(b.shouldBlock, false, 'B under threshold must pass');
});

// ---- T3 — per-workspace threshold override ----
test('T3 per-workspace threshold override respected', () => {
    const overrides: Record<string, number> = { 'slow-but-ok': 120 };
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
        thresholdResolver: (ws) => overrides[ws] ?? 30,
    });
    cache.testInject('slow-but-ok', 90, 10);
    cache.testInject('strict', 90, 10);
    const ok = cache.shouldBackpressure('slow-but-ok');
    const strict = cache.shouldBackpressure('strict');
    assert.equal(ok.shouldBlock, false, '90s under override 120s — must not block');
    assert.equal(ok.thresholdSeconds, 120);
    assert.equal(strict.shouldBlock, true, '90s over default 30s — must block');
    assert.equal(strict.thresholdSeconds, 30);
});

// ---- T4 — refresh from aggregateStats ----
test('T4 refresh from aggregateStats updates lag values', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    const stats1: OutboxAggregateStats = {
        depth: 1,
        lagSeconds: 5,
        dead: 0,
        perWorkspace: {
            'wsA': { depth: 1, lagSeconds: 5, dead: 0 },
        },
    };
    cache.refresh(stats1);
    assert.equal(cache.shouldBackpressure('wsA').currentLagSeconds, 5);
    const stats2: OutboxAggregateStats = {
        depth: 100,
        lagSeconds: 200,
        dead: 0,
        perWorkspace: {
            'wsA': { depth: 100, lagSeconds: 200, dead: 0 },
        },
    };
    cache.refresh(stats2);
    const d = cache.shouldBackpressure('wsA');
    assert.equal(d.currentLagSeconds, 200);
    assert.equal(d.shouldBlock, true);
    // After draining (depth=0), the snapshot for that workspace
    // must reflect the cleared state.
    cache.refresh({ depth: 0, lagSeconds: 0, dead: 0, perWorkspace: {} });
    const drained = cache.shouldBackpressure('wsA');
    assert.equal(drained.cacheMiss, true, 'workspace dropped from perWorkspace → cache miss after refresh');
});

// ---- T5 — cache miss → fail-open ----
test('T5 cache miss → fail-open (no block, cacheMiss=true)', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    const d = cache.shouldBackpressure('brand-new-workspace');
    assert.equal(d.shouldBlock, false, 'cache miss must NOT block');
    assert.equal(d.cacheMiss, true);
});

// ---- T6 — depth threshold ----
test('T6 depth > threshold triggers backpressure even when lag is low', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 100,
    });
    cache.testInject('wsX', 1, 500); // lag fine, depth over
    const d = cache.shouldBackpressure('wsX');
    assert.equal(d.shouldBlock, true);
    assert.equal(d.outboxDepth, 500);
    assert.equal(d.depthThreshold, 100);
});

// ---- T7 — writeOutboxBackpressure shape ----
test('T7 writeOutboxBackpressure writes canonical 503 + Retry-After', () => {
    const res = fakeRes();
    writeOutboxBackpressure(res, 'wsA', 75, 30, 200);
    assert.equal(res._status, OUTBOX_BACKPRESSURE_STATUS);
    assert.equal(res._status, 503);
    assert.ok(res._headers[OUTBOX_BACKPRESSURE_HEADER], 'Retry-After header present');
    // 75 - 30 + 1 = 46
    assert.equal(res._headers['Retry-After'], '46');
    const body = JSON.parse(res._body);
    // Wave 5: canonical {code, message, ...extras} envelope (was {error, ...}).
    assert.equal(body.code, OUTBOX_BACKPRESSURE_CODE);
    assert.equal(body.code, 'outbox_lag');
    assert.equal(typeof body.message, 'string');
    assert.equal(body.workspace, 'wsA');
    assert.equal(body.currentLagSeconds, 75);
    assert.equal(body.thresholdSeconds, 30);
    assert.equal(body.outboxDepth, 200);
});

// ---- T8 — checkOutboxBackpressure short-circuits ----
test('T8 checkOutboxBackpressure short-circuits when cache says block', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    cache.testInject('wsHot', 60, 10);
    const res = fakeRes();
    const blocked = checkOutboxBackpressure(res, 'wsHot', cache);
    assert.equal(blocked, true);
    assert.equal(res._status, 503);
    // Healthy workspace passes through.
    cache.testInject('wsCool', 1, 1);
    const res2 = fakeRes();
    const passed2 = checkOutboxBackpressure(res2, 'wsCool', cache);
    assert.equal(passed2, false);
    assert.equal(res2._status, 0, 'no response written when allowed');
    // Undefined cache also passes through (test/cloud wiring).
    const res3 = fakeRes();
    assert.equal(checkOutboxBackpressure(res3, 'anything', undefined), false);
});

// ---- T9 — perf: <1ms in steady state ----
test('T9 lag check overhead <1ms in steady state (1000 hits)', () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    for (let i = 0; i < 10; i++) {
        cache.testInject(`ws-${i}`, Math.floor(Math.random() * 20), Math.floor(Math.random() * 100));
    }
    // Warm up.
    for (let i = 0; i < 1000; i++) cache.shouldBackpressure(`ws-${i % 10}`);
    const start = process.hrtime.bigint();
    const N = 1000;
    for (let i = 0; i < N; i++) cache.shouldBackpressure(`ws-${i % 10}`);
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const avgUs = elapsedNs / N / 1000;
    // Sub-millisecond contract; we're aiming for << 1ms — typical
    // micro-benchmark on modern hardware shows ~1-3 µs per call.
    assert.ok(avgUs < 1000, `avg ${avgUs.toFixed(2)} µs per check should be < 1000 µs`);
});

// ---- T10 — replicator refreshes cache from store.aggregateStats ----
test('T10 replicator.tickOnce refreshes lag cache from store.aggregateStats', async () => {
    const cache = new OutboxLagCache({
        defaultLagThresholdSeconds: 30,
        depthThreshold: 10000,
    });
    // Minimal store stub satisfying the replicator's universal-write
    // method contract + aggregateStats provider.
    const fakeStats: OutboxAggregateStats = {
        depth: 3,
        lagSeconds: 90,
        dead: 0,
        perWorkspace: {
            'replicated-ws': { depth: 3, lagSeconds: 90, dead: 0 },
        },
    };
    const store = {
        listWorkspacesWithPending: async () => [],
        listPendingForWorkspace: async () => [],
        markEntryStatus: async () => undefined,
        readReplicationState: async () => ({ lastReplicatedSeq: 0, updatedAt: '' }),
        writeReplicationState: async () => undefined,
        record: async () => undefined,
        markStep: async () => undefined,
        markCompleted: async () => undefined,
        remove: async () => undefined,
        listUnfinished: async () => [],
        aggregateStats: async () => fakeStats,
    };
    const replicator = new OutboxReplicator({
        store: store as never,
        substrates: {} as never,
        lagCache: cache,
        log: () => undefined,
    });
    await replicator.tickOnce();
    const d = cache.shouldBackpressure('replicated-ws');
    assert.equal(d.currentLagSeconds, 90);
    assert.equal(d.shouldBlock, true);
});

// ---- T11 — env defaults ----
test('T11 default thresholds match documented defaults (30s / 10000)', () => {
    assert.equal(DEFAULT_LAG_THRESHOLD_SECONDS, 30);
    assert.equal(DEFAULT_DEPTH_THRESHOLD, 10000);
});

// Drain.
await new Promise<void>((resolve) => setTimeout(resolve, 100));

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('');
console.log(`OK: ${passed} O4 backpressure tests pass.`);
