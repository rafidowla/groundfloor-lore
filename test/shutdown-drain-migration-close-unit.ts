#!/usr/bin/env tsx
/**
 * test/shutdown-drain-migration-close-unit.ts — MigrationsStore's native
 * SQLite handle is actually released, and the ordered drain reaches it.
 *
 * The 3.20.0 native-handle audit found every long-lived native handle type
 * had a close test EXCEPT this one: `MigrationsStore`, closed via
 * `migrationWiring.close()` in step 3 of `buildShutdownDrain`
 * (mcp/shutdownDrain.ts). The close IS reached in production — nothing was
 * leaking — but nothing asserted it, and `MigrationsStore.close()` itself
 * lacked the try/catch every other SQLite sidecar (`LoadJobsStore.close()`,
 * `daemonWiring.close()`'s own wrapping of `store.close()`) uses to make a
 * double-close a no-op instead of a thrown "database connection is not open".
 *
 * Two things pinned here:
 *
 *   T1 — a REAL MigrationsStore on a temp dir: close() actually closes the
 *        better-sqlite3 handle (a query after close throws), and a SECOND
 *        close() does not throw (the idempotency fix in migration/store.ts).
 *   T2 — the drain's structural contract: `buildShutdownDrain` calls
 *        `migrationWiring.close()` exactly once, using the same inert-deps +
 *        stub shape as shutdown-drain-sidecar-close-unit.ts /
 *        shutdown-drain-engine-close-unit.ts.
 *
 * Run: npx tsx test/shutdown-drain-migration-close-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MigrationsStore } from '../packages/lore/src/migration/store.js';
import { buildShutdownDrain } from '../packages/lore/src/mcp/shutdownDrain.js';

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

function tmpLoreDir(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-migrations-close-${label}-`));
}

/** Same shape as shutdown-drain-sidecar-close-unit.ts / -engine-close-unit.ts's
 *  helper — the minimum REQUIRED dep set the drain needs before it ever
 *  reaches step 3 (migrationWiring.close()). */
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

console.log('\nMigrationsStore close — native handle release + drain wiring\n');

await test('T1a: close() actually releases the better-sqlite3 handle', () => {
    const dir = tmpLoreDir('t1a');
    const store = new MigrationsStore(dir);
    // Sanity: the store is usable before close.
    store.insertPending({
        id: 'm1', kind: 'add_table', substrate: 'sqlite', target: 'outbox',
        workspace: 'default', phase: 'additive', paramsJson: '{}',
    });
    assert.ok(store.get('m1'), 'store must be queryable before close()');

    store.close();

    assert.throws(
        () => store.list(),
        /database connection is not open|The database connection is not open/i,
        'a query after close() must fail against a closed native handle — the handle was actually released',
    );
});

await test('T1b: a second close() does not throw (idempotent, matches LoadJobsStore.close())', () => {
    const dir = tmpLoreDir('t1b');
    const store = new MigrationsStore(dir);
    store.close();
    assert.doesNotThrow(() => store.close(), 'double-close must be a no-op, not a thrown error');
});

await test('T2: buildShutdownDrain calls migrationWiring.close() exactly once', async () => {
    let calls = 0;
    await buildShutdownDrain({
        ...inertDeps(),
        migrationWiring: { close: () => { calls++; } },
    } as never)('test');
    assert.equal(calls, 1, 'the drain must close migrationWiring exactly once');
});

await test('T3: a throwing migrationWiring.close() does not strand the rest of the drain', async () => {
    const closedAfter: string[] = [];
    await buildShutdownDrain({
        ...inertDeps(),
        migrationWiring: { close: () => { throw new Error('migrations sqlite is unhappy'); } },
        sqliteStores: [{ name: 'outboxStore', close: () => { closedAfter.push('outboxStore'); } }],
    } as never)('test');
    assert.deepEqual(
        closedAfter,
        ['outboxStore'],
        'a throwing migrationWiring.close() must not stop later drain steps (outbox replicator stop, sidecar closes) from running',
    );
});

await test('T4: an unwired migrationWiring is a no-op, not a crash', async () => {
    await buildShutdownDrain({ ...inertDeps() } as never)('test');
    assert.ok(true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
