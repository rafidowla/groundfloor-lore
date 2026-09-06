#!/usr/bin/env tsx
/**
 * access-tracker-no-resurrect-unit.ts — a CLOSED graph store must stay closed.
 *
 * ── The defect (regression, 3.18.0) ─────────────────────────────────────────
 *
 * `ef5a2d09` restored the access-time coldness signal by adding
 * `SurrealGraph.stampAccessTimes`, whose first line was `await
 * this.initialize()`. That method is driven by `engines/accessTracker.ts`, a
 * background flush timer that **no drain ever stopped** — the tracker registry
 * was a WeakMap nobody could walk, and `ensureAccessTracker`'s own comment
 * recorded "neither drain calls tracker.stop()" as a known gap.
 *
 * So the timer kept firing after its graph was closed, and `initialize()`
 * cheerfully RE-OPENED the surrealkv store from a background tick. That new
 * engine had no owner and was never closed, and an open surrealkv engine holds
 * the libuv loop open — so the host process could never exit.
 *
 * It was invisible in every way that matters. Every assertion passed. Every
 * `close()` resolved. `process._getActiveHandles()` was EMPTY (it does not
 * report native NAPI resources), and so was `getActiveResourcesInfo()`. The
 * only external symptom was an embedding host's test process that finished its
 * work and then sat forever, and `lsof` showing WAL/sstable descriptors for
 * workspaces that had already been closed.
 *
 * Bisected to `ef5a2d09` against a real embedding consumer's suite; the
 * end-to-end pin lives in test/embedded-abandoned-dispose-exit-unit.ts. THIS
 * test pins the two mechanisms directly, so a failure names the cause instead
 * of just reporting "the process did not exit".
 *
 *   1. `stampAccessTimes` refuses to initialize: on a graph that is not
 *      currently open it drops its batch instead of re-opening. Note this is
 *      NOT a `closed` flag — a flush that passed such a check while the store
 *      was open would still reach `initialize()` after `close()`. Refusing to
 *      open at all is what removes the window rather than narrowing it.
 *   2. close() is not a one-way door: a DELIBERATE `initialize()` re-opens and
 *      stamping resumes, which the registry and restore paths rely on.
 *   3. `stopAllAccessTrackers()` stops what `ensureAccessTracker` started, and
 *      its final flush lands on a still-open graph (stamps preserved, which is
 *      why the drain stops trackers BEFORE closing substrates).
 *
 * Run: npx tsx test/access-tracker-no-resurrect-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { ensureAccessTracker, stopAllAccessTrackers } from '../packages/lore/src/engines/accessTracker.js';

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

const dirs: string[] = [];
function freshDir(tag: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `lore-noresurrect-${tag}-`));
    dirs.push(d);
    return d;
}

async function seeded(tag: string): Promise<{ graph: SurrealGraph; dir: string }> {
    const dir = freshDir(tag);
    const graph = new SurrealGraph(dir, { workspaceId: 'resurrect-ws' });
    await graph.initialize();
    await graph.upsertNode({
        id: 'n1', type: 'decision', label: 'n1', content: 'body',
        tags: ['t'], project: 'p', ecosystem: '*', metadata: '{}',
    });
    return { graph, dir };
}

console.log('Access tracker — a closed store is never resurrected');

await test('stampAccessTimes on a CLOSED graph drops the batch instead of re-opening', async () => {
    const { graph } = await seeded('closed');
    await graph.close();
    const stamped = await (graph as unknown as {
        stampAccessTimes(e: Array<{ id: string; accessedAt: string }>): Promise<number>;
    }).stampAccessTimes([{ id: 'n1', accessedAt: new Date().toISOString() }]);
    assert.equal(stamped, 0, 'a closed store must stamp nothing — anything else means it re-opened');
    // If it HAD re-opened, this second close would have a live connection to
    // tear down and the store would be left locked for the assertion below.
    await graph.close();
});

await test('close() is not a one-way door — a deliberate initialize() re-opens and stamping resumes', async () => {
    const { graph } = await seeded('reopen');
    await graph.close();
    await graph.initialize();               // explicit, owner-driven: allowed
    const stamped = await (graph as unknown as {
        stampAccessTimes(e: Array<{ id: string; accessedAt: string }>): Promise<number>;
    }).stampAccessTimes([{ id: 'n1', accessedAt: new Date().toISOString() }]);
    assert.equal(stamped, 1, 'after a deliberate re-open the stamp must land again');
    await graph.close();
});

await test('stopAllAccessTrackers stops what ensureAccessTracker started', async () => {
    const { graph } = await seeded('stopall');
    try {
        const tracker = ensureAccessTracker(graph);
        assert.ok(tracker, 'SurrealGraph exposes stampAccessTimes, so a tracker must be created');
        tracker.touch(['n1'], 'retrieval');
        assert.equal(tracker.pendingCount(), 1, 'the touch is accumulated, not written inline');

        // The drain's step 8.7 — runs while the graph is still OPEN, so the
        // final flush lands rather than hitting the closed-store guard.
        await stopAllAccessTrackers();
        assert.equal(tracker.pendingCount(), 0, 'stop() must flush the accumulator, not discard it');

        const row = await graph.getNode('n1') as { lastAccessedAt?: unknown } | null;
        assert.ok(row, 'node still present');
        assert.ok(row.lastAccessedAt, 'the stamp actually landed on the still-open graph');
    } finally {
        await graph.close();
    }
});

await test('a tracker whose graph was closed first flushes nothing and throws nothing', async () => {
    const { graph } = await seeded('closed-first');
    const tracker = ensureAccessTracker(graph);
    assert.ok(tracker);
    tracker.touch(['n1'], 'retrieval');
    await graph.close();                    // the drain skipped the tracker
    await stopAllAccessTrackers();          // ...and it is stopped afterwards
    assert.equal(tracker.pendingCount(), 0, 'the accumulator is drained either way');
    // The point: no throw, and no re-open. A second close finds nothing live.
    await graph.close();
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
