#!/usr/bin/env tsx
/**
 * test/O5-crash-recovery-integration.ts — Sprint O5 closure proof.
 *
 * Validates the foundation principle of Sprint O: a crash mid-fanout
 * does NOT lose writes AND does NOT produce duplicates. Drives the
 * SQLite outbox + OutboxReplicator end-to-end across a simulated
 * process boundary (drop the replicator + the store handle, then
 * recreate both from the same on-disk SQLite file).
 *
 * Why in-process rather than spawning a real daemon:
 *   The spec allows either approach ("kill -9 the daemon" OR
 *   "use an in-process test harness like other tests"). In-process is
 *   strictly more deterministic — no race between "daemon ready"
 *   probes and replicator tick scheduling. The crash-boundary is
 *   modelled by dropping the in-memory replicator + store and
 *   re-opening the SQLite file from disk, which is exactly what the
 *   daemon does at boot.
 *
 * Scenario:
 *   1. Open SqliteOutboxStore at a fresh tempdir.
 *   2. Batch-record 100 'node.upsert' entries in workspace 'w'.
 *      → outbox has 100 pending, sequenceId 1..100.
 *   3. Construct OutboxReplicator R1 with a substrate that:
 *        - records (id → count) into a Map (proves idempotency:
 *          count must stay at 1 even if replay re-fires).
 *        - succeeds for every call.
 *      Call tickOnce() ONCE: replicator processes the whole batch
 *      (batchSize defaults to 100), marks rows replicated, advances
 *      the cursor to 100. To get a TRUE mid-fanout crash, we instead
 *      configure R1 with batchSize=40 + a substrate that throws
 *      after the 40th call so the replicator stops mid-batch with
 *      ~40 rows replicated, the rest still pending. The
 *      lastReplicatedSeq cursor will reflect the highest sequenceId
 *      that was successfully marked.
 *   4. "Crash": drop R1, .close() the store handle (releases SQLite
 *      WAL → simulates the daemon process exiting cleanly enough
 *      that the on-disk file is consistent; this is the worst case
 *      for an unclean kill because the WAL would be replayed on
 *      reopen anyway).
 *   5. "Restart": new SqliteOutboxStore at the same dir, new
 *      OutboxReplicator R2 with a substrate that:
 *        - increments the SAME id→count map.
 *        - succeeds for every call.
 *      Call tickOnce() until listWorkspacesWithPending() is empty.
 *   6. Assertions:
 *        - every id 1..100 appears in the map with count === 1
 *          (no duplicate substrate calls)
 *        - all 100 rows have status 'replicated' on disk
 *        - lastReplicatedSeq cursor === 100
 *        - replicator stats: R2.replicated >= rows R2 actually
 *          processed (not the full 100; R1 already did some)
 *
 * Determinism: zero timers, zero background loops. We call
 * tickOnce() explicitly. The crash boundary is a synchronous handle
 * drop + reopen. Five consecutive runs of this test produce
 * identical output.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}\n${(err as Error).stack}`); failed++; }
    })());
}

function mkTmp(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-O5-crash-'));
    return {
        dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

const WS = 'w';
const TOTAL = 100;

function makeEntries(start: number, count: number): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    const now = new Date().toISOString();
    for (let i = 0; i < count; i++) {
        const id = `crash-${start + i}`;
        out.push({
            id,
            operation: 'node.upsert',
            initiator: 'human:test',
            createdAt: now,
            updatedAt: now,
            steps: [],
            completed: false,
            workspace: WS,
            operationKind: 'node.upsert',
            payload: { id, type: 'decision', label: id },
            status: 'pending',
            attempts: 0,
        });
    }
    return out;
}

function silentLog(_m: string): void { /* swallow replicator stderr noise */ }

console.log('Sprint O5 — crash recovery integration');

test('crash mid-fanout: replicator resumes from lastReplicatedSequenceId, every row lands exactly once', async () => {
    const t = mkTmp();
    try {
        // id -> count of substrate-side upsert calls. Idempotent MERGE
        // means count should be 1 for every id even if recovery replays.
        const calls = new Map<string, number>();

        // ===== Phase 1: write 100 rows =====
        const store1 = new SqliteOutboxStore(t.dir);
        await store1.batchRecord(makeEntries(1, TOTAL));

        // Sanity: 100 pending rows, sequenceIds 1..100.
        const pendingBatch = await store1.listPendingForWorkspace!(WS, 1000);
        assert.equal(pendingBatch.length, TOTAL, `expected ${TOTAL} pending, got ${pendingBatch.length}`);
        const seqs = pendingBatch.map(e => e.sequenceId!).sort((a, b) => a - b);
        assert.deepEqual(seqs, Array.from({ length: TOTAL }, (_, i) => i + 1));

        // ===== Phase 2: R1 processes ~40 rows then "crashes" =====
        // Substrate fails on the 41st call so R1 marks the first 40
        // replicated + advances the cursor to 40 + marks the 41st
        // 'failed' (attempt 1 of 5), then we drop everything.
        let r1Calls = 0;
        const subFlaky: DispatcherSubstrates = {
            upsertNode: async (payload) => {
                r1Calls++;
                if (r1Calls > 40) {
                    throw new Error('SIMULATED_CRASH after 40 substrate calls');
                }
                const id = (payload as { id: string }).id;
                calls.set(id, (calls.get(id) ?? 0) + 1);
            },
        };
        const r1 = new OutboxReplicator({
            store: store1,
            substrates: subFlaky,
            // batchSize >= TOTAL so a single tick walks the whole batch;
            // mid-batch failure is what triggers the crash boundary.
            config: { batchSize: TOTAL, maxAttempts: 5 },
            log: silentLog,
        });
        await r1.tickOnce();

        // After the tick: 40 succeeded, 60 remain pending OR failed
        // (the 41st is 'failed' with attempts=1; rows 42..100 stayed
        // 'pending' because the tick aborted further processing for
        // this workspace after marking the failure — actually the
        // current replicator continues to the next row in the batch
        // because each replicateOne() catches its own error. So 41..100
        // all get attempted; the substrate throws for all of them and
        // they end up 'failed' with attempts=1. The cursor still
        // advances only by *successful* writes, so it sits at seq 40).
        const cursor1 = await store1.readReplicationState!(WS);
        assert.equal(cursor1.lastReplicatedSeq, 40,
            `expected cursor at 40 after R1 crash, got ${cursor1.lastReplicatedSeq}`);
        assert.equal(r1.getStats().replicated, 40);
        assert.ok(r1.getStats().failures >= 60,
            `expected >=60 failures, got ${r1.getStats().failures}`);

        // Drop the in-memory replicator + close the store. This is the
        // simulated process boundary — next phase reopens the file
        // from disk just like the daemon does at boot.
        await r1.stop();
        store1.close();

        // ===== Phase 3: R2 reopens, resumes from cursor, drains =====
        const store2 = new SqliteOutboxStore(t.dir);

        // Confirm the cursor survived the close/reopen.
        const cursorOnReboot = await store2.readReplicationState!(WS);
        assert.equal(cursorOnReboot.lastReplicatedSeq, 40,
            `cursor should persist across reopen; got ${cursorOnReboot.lastReplicatedSeq}`);

        const subHappy: DispatcherSubstrates = {
            upsertNode: async (payload) => {
                const id = (payload as { id: string }).id;
                calls.set(id, (calls.get(id) ?? 0) + 1);
            },
        };
        const r2 = new OutboxReplicator({
            store: store2,
            substrates: subHappy,
            config: { batchSize: 100, maxAttempts: 5 },
            log: silentLog,
        });

        // Drain: tickOnce in a loop until no workspaces have pending
        // work. Bounded so a regression cannot loop forever.
        let drainTicks = 0;
        while (drainTicks < 20) {
            const remaining = await store2.listWorkspacesWithPending!();
            if (remaining.length === 0) break;
            await r2.tickOnce();
            drainTicks++;
        }
        assert.ok(drainTicks < 20, `replicator failed to drain in 20 ticks`);

        // ===== Phase 4: assertions =====

        // Every id processed exactly once (idempotency held — the
        // cursor + entry-level status='replicated' filter prevented
        // R2 from re-firing the first 40).
        assert.equal(calls.size, TOTAL,
            `expected ${TOTAL} distinct ids called, got ${calls.size}`);
        for (let i = 1; i <= TOTAL; i++) {
            const id = `crash-${i}`;
            const c = calls.get(id);
            assert.equal(c, 1,
                `id ${id} was called ${c} times (must be exactly 1 — idempotency / no-duplicates contract violated)`);
        }

        // Cursor advanced all the way.
        const finalCursor = await store2.readReplicationState!(WS);
        assert.equal(finalCursor.lastReplicatedSeq, TOTAL,
            `final cursor should equal ${TOTAL}, got ${finalCursor.lastReplicatedSeq}`);

        // No pending rows anywhere.
        const finalPending = await store2.listPendingForWorkspace!(WS, 1000);
        assert.equal(finalPending.length, 0,
            `expected 0 pending after drain, got ${finalPending.length}`);

        // R2 processed exactly 60 rows (TOTAL - 40 done in R1).
        assert.equal(r2.getStats().replicated, TOTAL - 40,
            `R2 should have replicated 60, got ${r2.getStats().replicated}`);

        await r2.stop();
        store2.close();
    } finally { t.cleanup(); }
});

test('5x consecutive runs are deterministic (no flakiness)', async () => {
    // Re-run the core scenario 5 times in-process. Any flake (timing
    // race, cursor desync, batch ordering instability) shows up here.
    for (let run = 1; run <= 5; run++) {
        const t = mkTmp();
        try {
            const calls = new Map<string, number>();

            const store1 = new SqliteOutboxStore(t.dir);
            await store1.batchRecord(makeEntries(1, TOTAL));

            let r1Calls = 0;
            const r1 = new OutboxReplicator({
                store: store1,
                substrates: {
                    upsertNode: async (payload) => {
                        r1Calls++;
                        if (r1Calls > 40) throw new Error('crash');
                        const id = (payload as { id: string }).id;
                        calls.set(id, (calls.get(id) ?? 0) + 1);
                    },
                },
                config: { batchSize: TOTAL, maxAttempts: 5 },
                log: silentLog,
            });
            await r1.tickOnce();
            await r1.stop();
            store1.close();

            const store2 = new SqliteOutboxStore(t.dir);
            const r2 = new OutboxReplicator({
                store: store2,
                substrates: {
                    upsertNode: async (payload) => {
                        const id = (payload as { id: string }).id;
                        calls.set(id, (calls.get(id) ?? 0) + 1);
                    },
                },
                config: { batchSize: 100, maxAttempts: 5 },
                log: silentLog,
            });
            let ticks = 0;
            while (ticks < 20) {
                const w = await store2.listWorkspacesWithPending!();
                if (w.length === 0) break;
                await r2.tickOnce();
                ticks++;
            }

            assert.equal(calls.size, TOTAL,
                `run ${run}: distinct ids ${calls.size} (expected ${TOTAL})`);
            for (let i = 1; i <= TOTAL; i++) {
                assert.equal(calls.get(`crash-${i}`), 1,
                    `run ${run}: id crash-${i} count was ${calls.get(`crash-${i}`)} (must be 1)`);
            }
            const c = await store2.readReplicationState!(WS);
            assert.equal(c.lastReplicatedSeq, TOTAL,
                `run ${run}: final cursor ${c.lastReplicatedSeq}`);

            await r2.stop();
            store2.close();
        } finally { t.cleanup(); }
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
