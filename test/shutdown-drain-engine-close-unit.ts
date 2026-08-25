#!/usr/bin/env tsx
/**
 * test/shutdown-drain-engine-close-unit.ts — the drain must close the boot
 * workspace's graph handle WHATEVER ENGINE it is.
 *
 * Why this exists: `LocalGraphRegistry.disposeAll()` deliberately skips the
 * pinned boot entry ("boot graph closed by the drain"), which makes
 * `buildShutdownDrain` the ONLY thing that closes the boot workspace's handle.
 * It used to gate that close on `deps.graph instanceof LocalGraph`. Once a
 * workspace could declare `graphEngine: 'surreal'`, `createGraph()` began
 * returning a SurrealGraph there — it failed the instanceof, was never closed,
 * and left behind the locked surrealkv directory the registry's own
 * dual-handle comment warns about. Nothing failed loudly; the lock just
 * outlived the process's intent.
 *
 * The fix is a capability probe. These assertions pin all three arms of it:
 *
 *   T1 — a local handle exposing close() is closed (the case that always worked)
 *   T2 — a Surreal-shaped handle is closed     (FAILS on the pre-fix code)
 *   T3 — a cloud handle with no close() is skipped, not crashed on
 *   T4 — a throwing close() is contained, and the drain still completes
 *
 * T2 is the regression guard. Everything else exists so a future "simplify"
 * can't quietly narrow the probe back to one engine or start assuming close()
 * is always present.
 *
 * Deliberately structural: the drain's deps are a loose structural contract,
 * so these fakes are the same shape the daemon passes without dragging a real
 * Kùzu or SurrealDB instance into a unit test.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildShutdownDrain } from '../packages/lore/src/mcp/shutdownDrain.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${(err as Error).message}`);
        failed++;
    }
}

/** The no-op collaborators the drain awaits before it ever reaches the graph.
 *  Every REQUIRED field of ShutdownDrainDeps must be present — the drain runs
 *  them in order and reaches the graph close only at the very end. */
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
    };
}

console.log('\nShutdown drain — closes the boot graph on every local engine\n');

await test('T1: a local handle exposing close() is closed', async () => {
    let closed = false;
    const graph = { close: async () => { closed = true; } };
    await buildShutdownDrain({ ...inertDeps(), graph } as never)('test');
    assert.equal(closed, true, 'drain must close a boot graph that exposes close()');
});

await test('T2: a Surreal-shaped handle is closed — the regression', async () => {
    // Pre-fix this object failed `instanceof LocalGraph` and was skipped
    // entirely, stranding the surrealkv directory lock.
    let closed = false;
    const graph = {
        constructor: { name: 'SurrealGraph' },
        close: async () => { closed = true; },
    };
    await buildShutdownDrain({ ...inertDeps(), graph } as never)('test');
    assert.equal(
        closed,
        true,
        'drain must close a Surreal-backed boot graph — skipping it leaks the surrealkv lock',
    );
});

await test('T3: a cloud handle with no close() is skipped, not crashed on', async () => {
    // DataplaneGraph genuinely has no close(); probing must not invent one.
    const graph = { someOtherMethod: () => undefined };
    await buildShutdownDrain({ ...inertDeps(), graph } as never)('test');
    // Reaching here without throwing IS the assertion.
    assert.ok(true);
});

await test('T4: a throwing close() is contained; the drain still completes', async () => {
    let verbatimClosed = false;
    const graph = { close: async () => { throw new Error('substrate exploded'); } };
    const verbatimStore = { close: async () => { verbatimClosed = true; } };
    // Must not reject — the drain try/catches each step so one bad component
    // cannot strand the others.
    await buildShutdownDrain({ ...inertDeps(), graph, verbatimStore } as never)('test');
    assert.equal(
        verbatimClosed,
        false,
        'verbatimStore is only closed when it is a real VerbatimStore; a bare fake is skipped',
    );
});

await test('T5: a REAL SurrealGraph is closed, and its directory lock released', async () => {
    // T2 proves the probe fires for a Surreal-SHAPED object. This proves the
    // thing that actually matters: a genuine embedded SurrealDB handle is
    // released, so the surrealkv directory can be reopened afterwards. A
    // structural fake cannot demonstrate that — only a real store holds a lock.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-drain-surreal-'));
    try {
        const graph = new SurrealGraph(dir, { workspaceId: 'drain', cacheDisabled: true });
        await graph.initialize();
        await graph.upsertNode({
            id: 'n1', type: 'note', label: 'L', content: 'C',
            tags: '', project: 'p', ecosystem: 'e',
        } as never);

        await buildShutdownDrain({ ...inertDeps(), graph } as never)('test');

        // The proof: a second engine can open the SAME directory. If the drain
        // had skipped close() (the pre-fix behaviour), the lock would still be
        // held and this would fail or hang.
        const reopened = new SurrealGraph(dir, { workspaceId: 'drain', cacheDisabled: true });
        try {
            await reopened.initialize();
            const stats = await reopened.getStats();
            assert.equal(stats.nodeCount, 1, 'reopened store still has the node');
        } finally {
            await reopened.close().catch(() => undefined);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
