#!/usr/bin/env tsx
/**
 * shutdown-drain-sidecar-close-unit.ts — the ordered drain must release the
 * handles that are NOT the boot graph and NOT the boot verbatim store.
 *
 * Two leaks, both of the same shape: something owns a handle, exposes a
 * `close()`, and nothing on the local/embedded teardown path ever calls it.
 * Neither blocks a process exit (better-sqlite3 handles hold no libuv
 * resource, and the verbatim stores are closed by the OS eventually), which is
 * exactly why both survived: a daemon that was about to exit anyway never
 * showed a symptom. An embedding host that opens and closes many instances in
 * one long-lived process does.
 *
 *   L1 — `WorkspaceVerbatimResolver.closeAll()` had ZERO callers anywhere in
 *        the tree, while its own docstring promised "`closeAll()` releases
 *        handles on shutdown". Every workspace the outbox replicator resolved
 *        leaked its LanceDB handle for the life of the host.
 *
 *   L2 — the SQLite sidecars (outbox, aux, versions, pending-ops, tables) were
 *        closed ONLY on the arcade/cloud boot path (mcp/arcadeBoot.ts). A
 *        local or embedded drain left every `.sqlite` / `-wal` / `-shm`
 *        descriptor open — visible in `lsof` on any embedded host, and the
 *        first thing an investigator reasonably (but wrongly) blames when a
 *        host will not exit.
 *
 * What is asserted:
 *   1. `closeAll()` is called, exactly once.
 *   2. Every wired SQLite sidecar is closed.
 *   3. The sidecars close AFTER the boot substrates — they are still writable
 *      by the steps above them, so closing early would be a use-after-close.
 *   4. One store throwing does not strand the others (a second drain pass
 *      hits already-closed better-sqlite3 handles, which throw).
 *   5. `collectSqliteStores` skips handles with no `close()` — FileOutboxStore
 *      and the cloud table-storage stub have none — and binds `this`.
 *
 * Run: npx tsx test/shutdown-drain-sidecar-close-unit.ts
 */

import assert from 'node:assert/strict';

import { buildShutdownDrain, collectSqliteStores } from '../packages/lore/src/mcp/shutdownDrain.js';

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

/** The minimum dep set the drain requires, all no-ops — same shape as
 *  shutdown-drain-engine-close-unit.ts's helper. */
function inertDeps() {
    return {
        syncPoller: { stop: () => undefined },
        outboxReplicator: { stop: async () => undefined },
        embedQueue: { drained: async () => undefined, stop: () => undefined },
        consistencySweeper: { stop: async () => undefined },
        getLoadJobsRunner: () => null,
        authTokenSweeper: { stop: () => undefined },
        stopAllLocalWatchers: () => undefined,
        verbatimStore: null,
        graph: null,
    };
}

console.log('Ordered shutdown drain — sidecar handles are released');

await test('the per-workspace verbatim resolver is closed exactly once', async () => {
    let calls = 0;
    await buildShutdownDrain({
        ...inertDeps(),
        workspaceVerbatimResolver: { closeAll: async () => { calls++; } },
    } as never)('test');
    assert.equal(calls, 1, 'closeAll() must be called once per drain');
});

await test('a throwing resolver does not strand the SQLite sidecars behind it', async () => {
    const closed: string[] = [];
    await buildShutdownDrain({
        ...inertDeps(),
        workspaceVerbatimResolver: { closeAll: async () => { throw new Error('lance is unhappy'); } },
        sqliteStores: [{ name: 'outboxStore', close: () => { closed.push('outboxStore'); } }],
    } as never)('test');
    assert.deepEqual(closed, ['outboxStore'], 'the sidecar step must still run after a resolver failure');
});

await test('every wired SQLite sidecar is closed', async () => {
    const closed: string[] = [];
    const store = (name: string) => ({ name, close: () => { closed.push(name); } });
    await buildShutdownDrain({
        ...inertDeps(),
        sqliteStores: [
            store('outboxStore'), store('auxStore'), store('versionStore'),
            store('pendingOpsStore'), store('tableStorage'),
        ],
    } as never)('test');
    assert.deepEqual(
        closed,
        ['outboxStore', 'auxStore', 'versionStore', 'pendingOpsStore', 'tableStorage'],
        'all five sidecars close, in the order given',
    );
});

await test('sidecars close AFTER the boot graph and verbatim store', async () => {
    const order: string[] = [];
    // A capability-probed graph + a VerbatimStore-shaped object are what step
    // 10 acts on; the sidecar step is 11 and must observe both already closed.
    await buildShutdownDrain({
        ...inertDeps(),
        graph: { close: async () => { order.push('graph'); } },
        workspaceVerbatimResolver: { closeAll: async () => { order.push('resolver'); } },
        sqliteStores: [{ name: 'outboxStore', close: () => { order.push('outboxStore'); } }],
    } as never)('test');
    assert.deepEqual(order, ['resolver', 'graph', 'outboxStore'],
        'resolver (9.7) → boot graph (10) → sidecars (11); a sidecar closed earlier is a use-after-close');
});

await test('one sidecar throwing does not strand the rest', async () => {
    const closed: string[] = [];
    await buildShutdownDrain({
        ...inertDeps(),
        sqliteStores: [
            { name: 'outboxStore', close: () => { throw new Error('The database connection is not open'); } },
            { name: 'auxStore', close: () => { closed.push('auxStore'); } },
        ],
    } as never)('test');
    assert.deepEqual(closed, ['auxStore'],
        'a double-drain hits already-closed better-sqlite3 handles, which throw — the rest must still close');
});

await test('an unwired sidecar set is a no-op, not a crash', async () => {
    await buildShutdownDrain({ ...inertDeps() } as never)('test');
    await buildShutdownDrain({ ...inertDeps(), sqliteStores: [undefined] } as never)('test');
});

await test('collectSqliteStores skips handles with no close() and binds `this`', () => {
    class Fake {
        closed = false;
        close(): void { this.closed = true; }
    }
    const withClose = new Fake();
    const noClose = { notAStore: true };
    const collected = collectSqliteStores({
        outboxStore: withClose,
        tableStorage: noClose,          // cloud stub — no close()
        versionStore: undefined,        // not wired in this mode
    });
    assert.deepEqual(collected.map((s) => s.name), ['outboxStore'],
        'only handles that actually expose close() are collected');
    collected[0]!.close();
    assert.equal(withClose.closed, true, 'close() must be invoked with its own receiver, not detached');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
