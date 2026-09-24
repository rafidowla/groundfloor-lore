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
import fs from 'node:fs';

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

await test('every wired SQLite sidecar is closed (including loadJobsStore)', async () => {
    const closed: string[] = [];
    const store = (name: string) => ({ name, close: () => { closed.push(name); } });
    await buildShutdownDrain({
        ...inertDeps(),
        sqliteStores: [
            store('outboxStore'), store('auxStore'), store('versionStore'),
            store('pendingOpsStore'), store('tableStorage'), store('loadJobsStore'),
        ],
    } as never)('test');
    assert.deepEqual(
        closed,
        ['outboxStore', 'auxStore', 'versionStore', 'pendingOpsStore', 'tableStorage', 'loadJobsStore'],
        'all six sidecars close, in the order given',
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

await test('structural: every SQLite sidecar server.ts constructs is in BOTH collectSqliteStores() call sets', () => {
    // (b) STEP2-CLOSE-PATH-DESIGN.md — loadJobsStore joined the close set
    // (L1/L2's own point: two drain call sites, daemon + arcade/cloud, MUST
    // pass the SAME set, or a store closed on one boot path leaks on the
    // other). This scans server.ts's actual source instead of trusting a
    // hand-maintained list, so the NEXT sidecar someone constructs cannot be
    // silently forgotten from one (or both) call sites the way loadJobsStore
    // was.
    //
    // Heuristic: every local binding built via `new XStore(...)`,
    // `XStore.open(...)`, or `createXStore(...)` — the three constructor
    // shapes every sqlite sidecar in this file already uses — must appear as
    // a bare identifier or object-key inside EVERY `collectSqliteStores({...})`
    // call found in the file. `tableStorage` is the one sidecar that does not
    // follow the *Store naming convention (it hangs off the storage bundle as
    // `store.tableStorage` / `d.store.tableStorage`) — allowlisted explicitly
    // below rather than silently widening the naming heuristic.
    const serverPath = new URL('../packages/lore/src/mcp/server.ts', import.meta.url);
    const src = fs.readFileSync(serverPath, 'utf-8');

    // Known *Store constructions that are NOT sqlite/native-handle-backed —
    // no close() is needed and none is wired. Ratchet this list DOWN, never
    // widen it as a shortcut past a real miss (same discipline as
    // D021_UNDEFINED_TARGET_ALLOWLIST in scripts/test-arch.mjs).
    const KNOWN_NON_SQLITE_STORES = new Set([
        'workspaceQuotaStore', // InMemoryWorkspaceQuotaStore — process-memory only
        'feedbackStore',       // FeedbackStore — append-only JSONL file, no persistent handle
    ]);

    const constructedStores = new Set<string>();
    for (const m of src.matchAll(/\b(\w*Store)\s*=\s*(?:new\s+\w+Store\(|\w+Store\.open\(|create\w*Store\()/g)) {
        if (!KNOWN_NON_SQLITE_STORES.has(m[1]!)) constructedStores.add(m[1]!);
    }
    assert.ok(constructedStores.size >= 4, `sanity: expected several *Store constructions in server.ts, found ${constructedStores.size}`);
    assert.ok(constructedStores.has('loadJobsStore'), 'sanity: the scan itself must find loadJobsStore’s construction');

    const NON_STORE_SUFFIX_SIDECARS = ['tableStorage']; // see comment above

    const callSites = [...src.matchAll(/collectSqliteStores\(\{([^}]*)\}\)/gs)];
    assert.ok(callSites.length >= 2, `expected at least 2 collectSqliteStores() call sites, found ${callSites.length}`);

    for (const [siteIndex, call] of callSites.entries()) {
        const argsText = call[1]!;
        for (const name of [...constructedStores, ...NON_STORE_SUFFIX_SIDECARS]) {
            assert.ok(
                new RegExp(`\\b${name}\\b`).test(argsText),
                `collectSqliteStores() call site #${siteIndex + 1} is missing "${name}" — ` +
                'a sidecar constructed in server.ts is not wired into this drain’s close set',
            );
        }
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
