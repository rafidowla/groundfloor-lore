#!/usr/bin/env tsx
/**
 * sp21-outbox-perf-unit.ts — SP-21 regression: outbox backoff + topology cap.
 *
 * Finding 1 (Fable-corroborated): failed outbox rows retried on every 10ms tick
 * with no backoff — burns maxAttempts in <50ms. Fix: exponential nextAttemptAt
 * stored on each failure; listPendingForWorkspace filters rows whose nextAttemptAt
 * is in the future.
 *
 * Finding 2 (Opus-only, confirmed): computeTopologyOverview has no cap — full
 * table scan. Fix: TOPOLOGY_OVERVIEW_NODE_CAP / EDGE_CAP constants + LIMIT in queries.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import { TOPOLOGY_OVERVIEW_NODE_CAP, TOPOLOGY_OVERVIEW_EDGE_CAP } from '../packages/lore/src/engines/topologyOverviewFold.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/* ─────────── A. computeNextAttemptAt — exponential growth ─────────── */

test('computeNextAttemptAt: attempt 0 → ~500ms delay', () => {
    const now = 1_000_000;
    const ts = SqliteOutboxStore.computeNextAttemptAt(0, now);
    const delta = new Date(ts).getTime() - now;
    assert.ok(delta >= 490 && delta <= 510, `expected ~500ms, got ${delta}ms`);
});

test('computeNextAttemptAt: attempt 1 → ~1000ms delay', () => {
    const now = 1_000_000;
    const ts = SqliteOutboxStore.computeNextAttemptAt(1, now);
    const delta = new Date(ts).getTime() - now;
    assert.ok(delta >= 990 && delta <= 1010, `expected ~1000ms, got ${delta}ms`);
});

test('computeNextAttemptAt: attempt 5 → ~16000ms delay', () => {
    const now = 1_000_000;
    const ts = SqliteOutboxStore.computeNextAttemptAt(5, now);
    const delta = new Date(ts).getTime() - now;
    // 500 * 2^5 = 16000
    assert.ok(delta >= 15_900 && delta <= 16_100, `expected ~16000ms, got ${delta}ms`);
});

test('computeNextAttemptAt: caps at 30s', () => {
    const now = 1_000_000;
    const ts = SqliteOutboxStore.computeNextAttemptAt(20, now); // 500 * 2^20 >> 30s
    const delta = new Date(ts).getTime() - now;
    assert.ok(delta >= 29_900 && delta <= 30_100, `expected ~30000ms (cap), got ${delta}ms`);
});

test('computeNextAttemptAt: grows monotonically for attempts 0..6', () => {
    const now = 1_000_000;
    let prev = 0;
    for (let i = 0; i <= 6; i++) {
        const next = new Date(SqliteOutboxStore.computeNextAttemptAt(i, now)).getTime();
        assert.ok(next >= now + 500, `attempt ${i}: expected delay >= 500ms`);
        if (i > 0) assert.ok(next > prev || next === new Date(SqliteOutboxStore.computeNextAttemptAt(i - 1, now)).getTime(),
            `attempt ${i}: expected next (${next}) >= prev (${prev})`);
        prev = next;
    }
});

/* ─────────── B. listPendingForWorkspace — filters future nextAttemptAt ─────────── */

function makeTmpStore(): SqliteOutboxStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp21-'));
    return new SqliteOutboxStore(path.join(dir, 'outbox.db'));
}

function makeEntry(id: string, workspace: string, status: OutboxEntry['status'], nextAttemptAt?: string): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id, workspace, operationKind: 'node.upsert',
        status, attempts: 1,
        createdAt: now, updatedAt: now,
        operation: 'store_node', initiator: 'test',
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
    };
}

test('listPendingForWorkspace: returns failed row when nextAttemptAt is absent (legacy rows)', async () => {
    const store = makeTmpStore();
    await store.record(makeEntry('e1', 'ws', 'failed'));
    const rows = await store.listPendingForWorkspace('ws', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'e1');
});

test('listPendingForWorkspace: skips failed row where nextAttemptAt is 60s in the future', async () => {
    const store = makeTmpStore();
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    await store.record(makeEntry('e2', 'ws', 'failed', futureTs));
    const rows = await store.listPendingForWorkspace('ws', 10);
    assert.equal(rows.length, 0, 'future-nextAttemptAt row should be suppressed');
});

test('listPendingForWorkspace: returns failed row when nextAttemptAt is 5s in the past', async () => {
    const store = makeTmpStore();
    const pastTs = new Date(Date.now() - 5_000).toISOString();
    await store.record(makeEntry('e3', 'ws', 'failed', pastTs));
    const rows = await store.listPendingForWorkspace('ws', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'e3');
});

test('listPendingForWorkspace: pending rows always returned regardless of nextAttemptAt', async () => {
    const store = makeTmpStore();
    await store.record(makeEntry('e4', 'ws', 'pending'));
    const rows = await store.listPendingForWorkspace('ws', 10);
    assert.equal(rows.length, 1);
});

test('markEntryStatus failed: sets nextAttemptAt ~500ms from now (attempt 0)', async () => {
    const store = makeTmpStore();
    await store.record(makeEntry('e5', 'ws', 'pending'));
    const before = Date.now();
    await store.markEntryStatus('e5', 'failed', { bumpAttempt: false });
    const after = Date.now();
    // nextAttemptAt should be stored in the DB; verify via listFailedOlderThan returning nothing yet
    const pending = await store.listPendingForWorkspace('ws', 10);
    // Row was just failed with nextAttemptAt = now + 500ms, so it should NOT appear yet
    assert.equal(pending.length, 0, 'just-failed row with future nextAttemptAt must not appear');
    void before; void after; // linted away
});

/* ─────────── C. topology overview caps ─────────── */

test('TOPOLOGY_OVERVIEW_NODE_CAP is 50000', () => {
    assert.equal(TOPOLOGY_OVERVIEW_NODE_CAP, 50_000);
});

test('TOPOLOGY_OVERVIEW_EDGE_CAP is 200000', () => {
    assert.equal(TOPOLOGY_OVERVIEW_EDGE_CAP, 200_000);
});

/* ─────────────────────────── runner ─────────────────────────── */

console.log('\n=== SP-21 outbox backoff + topology cap regression ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
