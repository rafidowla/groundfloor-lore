#!/usr/bin/env tsx
/**
 * test/verbatim-close-releases-natives-unit.ts — STEP2-CLOSE-PATH-DESIGN.md (a).
 *
 * `VerbatimStore.close()` now calls the native LanceDB `Table.close()` /
 * `Connection.close()` instead of merely dereferencing `this.table`/`this.db`
 * (engines/verbatimStore.ts, engines/verbatimWriteGate.ts). These assertions
 * pin the contract that makes that safe:
 *
 *   1. close() calls Table.close() and Connection.close() exactly once each.
 *   2. close() is idempotent — a second call neither throws nor double-closes.
 *   3. a write in flight when close() starts completes (its "table" work) BEFORE
 *      the natives close — driven with a manually-held writeGate + a deferred,
 *      so the ordering is asserted, not assumed.
 *   4. the write-drain timeout path (owner decision 1) proceeds without closing
 *      natives, rather than hanging or throwing — this.table/this.db are still
 *      dereferenced (3.19.1 behaviour), the store just doesn't release the
 *      native handles that round.
 *
 * Real LanceDB natives are never constructed here — `this.table`/`this.db` are
 * stubbed directly (the same technique test/nw4b-bm25-cache-singleflight-unit.ts
 * and test/sw20-stream-reconnect-unit.ts already use), since TypeScript
 * `private` is a compile-time guard only and every field is a plain property
 * at runtime.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-verbatim-close-'));
}

/** A store with `initialized`/`table`/`db` stubbed directly — no real
 *  LanceDB connection is ever opened. `closeLsmWriters` is present (feature
 *  detected) so the LsmWriteSpec-flush step exercises its real code path. */
function fakeOpenStore(dir: string): {
    store: VerbatimStore;
    tableCloseCount: () => number;
    dbCloseCount: () => number;
} {
    const store = new VerbatimStore(dir);
    let tableCloses = 0;
    let dbCloses = 0;
    const fakeTable = {
        closeLsmWriters: async () => undefined,
        close: () => { tableCloses++; },
    };
    const fakeDb = {
        close: () => { dbCloses++; },
    };
    (store as any).initialized = true;
    (store as any).table = fakeTable;
    (store as any).db = fakeDb;
    return { store, tableCloseCount: () => tableCloses, dbCloseCount: () => dbCloses };
}

console.log('\nVerbatimStore.close() — releases LanceDB natives\n');

await test('close() calls Table.close() and Connection.close() exactly once each', async () => {
    const dir = tmpDir();
    try {
        const { store, tableCloseCount, dbCloseCount } = fakeOpenStore(dir);
        await store.close();
        assert.equal(tableCloseCount(), 1, 'Table.close() must be called exactly once');
        assert.equal(dbCloseCount(), 1, 'Connection.close() must be called exactly once');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('close() is idempotent — a second call neither throws nor double-closes', async () => {
    const dir = tmpDir();
    try {
        const { store, tableCloseCount, dbCloseCount } = fakeOpenStore(dir);
        await store.close();
        await store.close(); // must not throw
        assert.equal(tableCloseCount(), 1, 'a second close() must not re-close the native table');
        assert.equal(dbCloseCount(), 1, 'a second close() must not re-close the native connection');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('a write in flight when close() starts completes before the natives close', async () => {
    const dir = tmpDir();
    try {
        const { store, tableCloseCount } = fakeOpenStore(dir);
        const gate = (store as any).writeGate as { enter(): void; exit(): void };
        gate.enter(); // simulate an in-flight table-touching call, held open
        const closePromise = store.close();
        // Yield the event loop a few times — close() is now awaiting drain().
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
        assert.equal(tableCloseCount(), 0, 'natives must NOT close while a write is still in flight');
        gate.exit(); // the "in-flight write" finishes
        await closePromise;
        assert.equal(tableCloseCount(), 1, 'natives close once the in-flight write completes');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('write-drain timeout: natives stay open this round, proceeds without hanging or throwing', async () => {
    const dir = tmpDir();
    try {
        const { store, tableCloseCount, dbCloseCount } = fakeOpenStore(dir);
        // Force the drain path to report a timeout without waiting out the
        // real 5s default — the gate's own timeout behaviour is independently
        // covered by unit-testing VerbatimWriteGate.drain() directly.
        (store as any).writeGate.drain = async () => false;
        await store.close(); // must resolve, not hang or throw
        assert.equal(tableCloseCount(), 0, 'a drain timeout must NOT close the native table this round');
        assert.equal(dbCloseCount(), 0, 'a drain timeout must NOT close the native connection this round');
        // Owner decision 1: worst case == 3.19.1 — the handles are still
        // dereferenced so the JS objects are eligible for GC.
        assert.equal((store as any).table, null, 'this.table is still dereferenced on a drain timeout');
        assert.equal((store as any).db, null, 'this.db is still dereferenced on a drain timeout');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('F1 (Opus review): close() -> initialize() -> close() closes the REOPENED natives again', async () => {
    // Opus F1: nativesClosed was never reset, so a reopen after close() left
    // every LATER close() early-returning at the guard -- the reopened
    // db/table/read pool were never closed, a regression vs 3.19.1 (which at
    // least re-closed/dereferenced on every call). Uses a REAL store (not the
    // stubbed fakeOpenStore() above) because the fix lives in the real
    // initialize() -- spies wrap the real native handles' close() after each
    // open, mirroring the technique test/nw4b-bm25-cache-singleflight-unit.ts
    // and test/sw20-stream-reconnect-unit.ts already use.
    const dir = tmpDir();
    try {
        const embedder: EmbeddingProvider = {
            modelId: 'f1-fake', dimension: 8,
            async initialize() {}, async embed() { return [0, 0, 0, 0, 0, 0, 0, 0]; },
            async embedDocument() { return [0, 0, 0, 0, 0, 0, 0, 0]; },
            async embedQuery() { return [0, 0, 0, 0, 0, 0, 0, 0]; },
        };
        const store = new VerbatimStore(dir, embedder);
        await store.initialize();
        await store.store({ id: 'n1', text: 'hello', metadata: { type: 'note' } }); // ensure a real table exists

        const spyClose = (obj: { close: () => void }) => {
            let calls = 0;
            const orig = obj.close.bind(obj);
            obj.close = () => { calls++; orig(); };
            return () => calls;
        };

        const tableCalls1 = spyClose((store as any).table);
        const dbCalls1 = spyClose((store as any).db);
        await store.close();
        assert.equal(tableCalls1(), 1, 'first close() closes the table');
        assert.equal(dbCalls1(), 1, 'first close() closes the connection');

        await store.initialize(); // reopen
        assert.equal((store as any).nativesClosed, false, 'initialize() must reset the idempotent-close guard on a fresh connect');

        const tableCalls2 = spyClose((store as any).table);
        const dbCalls2 = spyClose((store as any).db);
        await store.close();
        assert.equal(tableCalls2(), 1, 'close() after reopen must close the NEW table -- not early-return at a stale guard');
        assert.equal(dbCalls2(), 1, 'close() after reopen must close the NEW connection');

        await store.close(); // still idempotent after the reopen-close
        assert.equal(tableCalls2(), 1, 'a second close() after the reopen-close is still a no-op');
        assert.equal(dbCalls2(), 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('LORE_VERBATIM_NATIVE_CLOSE=0 restores the 3.19.1 dereference-only close', async () => {
    const dir = tmpDir();
    const prior = process.env.LORE_VERBATIM_NATIVE_CLOSE;
    process.env.LORE_VERBATIM_NATIVE_CLOSE = '0';
    try {
        const { store, tableCloseCount, dbCloseCount } = fakeOpenStore(dir);
        await store.close();
        assert.equal(tableCloseCount(), 0, 'kill switch off: Table.close() must not be called');
        assert.equal(dbCloseCount(), 0, 'kill switch off: Connection.close() must not be called');
        assert.equal((store as any).table, null, 'dereference-only close still nulls this.table');
        assert.equal((store as any).db, null, 'dereference-only close still nulls this.db');
    } finally {
        if (prior === undefined) delete process.env.LORE_VERBATIM_NATIVE_CLOSE;
        else process.env.LORE_VERBATIM_NATIVE_CLOSE = prior;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
