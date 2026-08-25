#!/usr/bin/env tsx
/**
 * test/nw1e-lance-table-pool-drain-unit.ts — NW-1e regression unit
 * (Lance pool half).
 *
 * Closes audit finding `conc-close-does-not-drain-inflight-reads`.
 *
 * What this pins down
 * ───────────────────
 * Before NW-1e, `LanceTablePool.close()` closed every pooled native
 * handle WITHOUT awaiting in-flight borrows from `withTable`. A
 * long-running query that had acquired its Table could have it closed
 * beneath it → native use-after-close.
 *
 * The fix: the pool exposes `drain(timeoutMs)` that stops issuing new
 * borrows, awaits in-flight borrows to return, then closes natives.
 * `close()` calls `drain()` first; `VerbatimStore.close()` chains
 * through pool.close() before nulling its Table handles.
 *
 * (The original NW-1e finding also covered `KuzuConnectionPool`; that
 * pool was retired with the Kùzu engine removal. The shared pool
 * plumbing — `poolLimits` / `nativePoolSafetyNet` — remains and is
 * exercised here through the Lance pool.)
 *
 * Adversarial setup
 * ─────────────────
 * Use a fake Table factory so we can simulate a deliberately slow
 * query holding a borrow open for a fixed window. Race conditions are
 * deterministic this way (no jitter dependency).
 *
 *   1. acquire a borrow → start a "long-running query" that won't
 *      finish for 200ms;
 *   2. call pool.close() in parallel — it must NOT return before the
 *      borrow is released;
 *   3. NO close() is invoked on the borrowed native handle until after
 *      release;
 *   4. the in-flight fn() observes its native handle as still-open and
 *      returns a valid result.
 *
 * On base (no drain), close() resolves immediately and the fake native
 * handle gets close() called while the borrower still has it — the test
 * detects this via a `closedWhileBorrowed` flag and fails.
 *
 * Also verifies:
 *   - drain() timeout returns the still-outstanding count and logs a
 *     warning (no daemon crash);
 *   - release-to-waiter hand-off keeps inFlight accounting balanced;
 *   - the shared DEFAULT_POOL_DRAIN_TIMEOUT_MS default is the
 *     documented 5s.
 */

import { strict as assert } from 'node:assert';

import { LanceTablePool } from '../packages/lore/src/engines/lanceTablePool.js';
import { DEFAULT_POOL_DRAIN_TIMEOUT_MS } from '../packages/lore/src/engines/poolLimits.js';
import type { Connection, Table } from '@lancedb/lancedb';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

interface FakeTable {
    id: number;
    closed: boolean;
    closedAt: number;
    close(): void;
    checkoutLatest(): Promise<void>;
}

function makeFakeLanceConnection(tableCount: number): {
    // Unchecked cast: the pool only touches connection.openTable(name);
    // the fake stands in for the native @lancedb Connection a real
    // VerbatimStore would pass.
    connection: Connection;
    tables: FakeTable[];
} {
    const tables: FakeTable[] = [];
    let nextId = 0;
    const openTable = async (_name: string): Promise<Table> => {
        const t: FakeTable = {
            id: nextId++,
            closed: false,
            closedAt: 0,
            close() { this.closed = true; this.closedAt = Date.now(); },
            async checkoutLatest() { /* no-op */ },
        };
        tables.push(t);
        return t as unknown as Table;
    };
    // The pool only calls connection.openTable(name).
    void tableCount;
    return { connection: { openTable } as unknown as Connection, tables };
}
async function sleep(ms: number): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    setTimeout(resolve, ms);
    return promise;
}

console.log('NW-1e · LanceTablePool close drains in-flight reads — no native use-after-close');

async function run() {
    await test('LanceTablePool.close() awaits in-flight withTable() before closing native', async () => {
        const { connection, tables } = makeFakeLanceConnection(2);
        const pool = new LanceTablePool(connection, 'fake-table', 2);
        await pool.initialize();
        assert.equal(tables.length, 2);

        let borrowReleasedAt = 0;
        let closedWhileBorrowed = false;
        let queryResult: number | null = null;

        const borrow = pool.withTable(async (table) => {
            const t = table as unknown as FakeTable;
            await sleep(200);
            if (t.closed) closedWhileBorrowed = true;
            queryResult = 99;
            borrowReleasedAt = Date.now();
            return queryResult;
        }, false /* skip checkoutLatest — our fake is a no-op anyway */);

        await sleep(10);

        const closeStart = Date.now();
        await pool.close();
        const closeElapsed = Date.now() - closeStart;

        const result = await borrow;
        assert.equal(result, 99);
        assert.equal(closedWhileBorrowed, false, 'native table must NOT have been close()d while borrowed');
        assert.ok(
            closeElapsed >= 150,
            `LanceTablePool.close() should have awaited the in-flight borrow; took ${closeElapsed}ms`,
        );
        for (const t of tables) {
            assert.equal(t.closed, true);
            assert.ok(
                t.closedAt >= borrowReleasedAt,
                `fake table ${t.id} closed at ${t.closedAt} BEFORE borrow released at ${borrowReleasedAt}`,
            );
        }
    });

    await test('LanceTablePool.drain() timeout returns outstanding count, no crash', async () => {
        const { connection } = makeFakeLanceConnection(1);
        const pool = new LanceTablePool(connection, 'fake-table', 1);
        await pool.initialize();
        const held = await pool.acquire();
        assert.equal(pool.inFlightCount(), 1);
        const outstanding = await pool.drain(50);
        assert.equal(outstanding, 1);
        pool.release(held);
    });

    await test('LanceTablePool: release-to-waiter hand-off keeps inFlight balanced', async () => {
        const { connection } = makeFakeLanceConnection(1);
        const pool = new LanceTablePool(connection, 'fake-table', 1);
        await pool.initialize();
        const a = await pool.acquire();
        assert.equal(pool.inFlightCount(), 1);
        const waiterPromise = pool.acquire();
        pool.release(a);
        const b = await waiterPromise;
        assert.equal(pool.inFlightCount(), 1);
        pool.release(b);
        assert.equal(pool.inFlightCount(), 0);
        await pool.close();
    });

    // ────────────────────────────────────────────────────────────
    // Constant sanity — the shared poolLimits default drain timeout
    // is exported and matches the documented 5s ballpark that
    // LanceTablePool.drain()/close() fall back to.
    // ────────────────────────────────────────────────────────────
    await test('DEFAULT_POOL_DRAIN_TIMEOUT_MS export exists and is the documented 5s', async () => {
        assert.equal(DEFAULT_POOL_DRAIN_TIMEOUT_MS, 5000);
    });
}

run().then(() => {
    console.log(`\nNW-1e · ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
});
