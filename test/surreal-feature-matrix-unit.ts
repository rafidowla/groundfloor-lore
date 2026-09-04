#!/usr/bin/env tsx
/**
 * surreal-feature-matrix-unit.ts — the Phase-2b accelerations, one flag at a
 * time (docs/SURREALDB_BUILD_PLAN.md follow-up).
 *
 * Two optional accelerations were added to make `getStats` and `search` faster.
 * They are NOT equivalent in risk, and this file is where that difference is
 * made explicit and permanent:
 *
 *   - `countView` (DEFAULT OFF as of 2026-08-21) returns identical numbers
 *     to the live GROUP BY it replaces under SERIAL writes — through
 *     inserts, type changes, deletes, project scoping, and an empty graph,
 *     all pinned below. Under CONCURRENT writers sharing one (project, type)
 *     group it does NOT: surrealdb-core 3.0.2's view-maintenance can commit
 *     a lost update, so the count silently drifts low forever while the
 *     underlying rows are all correct. That's why it flipped from default-on
 *     to opt-in — see the dedicated concurrency test below.
 *   - `fts` (DEFAULT OFF) is a deliberate BEHAVIOUR change: whole-word
 *     matching instead of substring. The divergence is asserted here as a
 *     KNOWN SET rather than described in prose, so (a) nobody enables it
 *     believing it is free, and (b) if a future SurrealDB changes the
 *     semantics again, this test says so.
 *
 * Rollback is asserted too: each flag off restores the previous behaviour
 * exactly, so backing out is an env var and not a revert.
 *
 * Run: npx tsx test/surreal-feature-matrix-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { resolveSurrealFeatures } from '../packages/lore/src/engines/surreal/surrealConnection.js';
import { withTransactionConflictRetry } from '../packages/lore/src/engines/transactionConflictRetry.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

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

/** Engine on a throwaway dir with an explicit feature set (never via env). */
async function withGraph(
    features: { countView?: boolean; fts?: boolean },
    fn: (g: SurrealGraph) => Promise<void>,
): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-flags-'));
    const graph = new SurrealGraph(dir, { workspaceId: 'flags', cacheDisabled: true, features });
    try {
        await graph.initialize();
        await fn(graph);
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Kappa header ${id}`,
        content: `Content about kappa authentication for ${id}`,
        tags: ['alpha'],
        project: 'p0',
        ecosystem: 'e',
        metadata: '{}',
        ...over,
    };
}

/** Seed the same corpus into a graph regardless of which flags are on. */
async function seed(g: SurrealGraph): Promise<void> {
    await g.upsertNode(node('d1', { type: 'decision', project: 'p0' }));
    await g.upsertNode(node('d2', { type: 'decision', project: 'p1' }));
    await g.upsertNode(node('c1', { type: 'convention', project: 'p0' }));
    await g.upsertNode(node('c2', { type: 'convention', project: 'p1' }));
    await g.upsertNode(node('n1', { type: 'note', project: 'p0' }));
    await g.addEdge({ sourceId: 'd1', targetId: 'c1', relation: 'intra-p0' });
    await g.addEdge({ sourceId: 'd1', targetId: 'd2', relation: 'cross-project' });
}

console.log('SurrealGraph — feature flag matrix');

/* ─── flag resolution ────────────────────────────────────────────── */

await test('countView, fts, and indexes all default OFF', () => {
    const d = resolveSurrealFeatures({});
    assert.equal(d.countView, false, 'a correctness-risk acceleration is never on by default');
    assert.equal(d.fts, false, 'a behaviour change is never on by default');
    assert.equal(d.indexes, false);
});

await test('every flag is individually overridable from the environment', () => {
    assert.equal(resolveSurrealFeatures({ LORE_SURREAL_COUNT_VIEW: '1' }).countView, true, 'opt-in path');
    assert.equal(resolveSurrealFeatures({ LORE_SURREAL_FTS: '1' }).fts, true);
    assert.equal(resolveSurrealFeatures({ LORE_SURREAL_DEFINE_INDEXES: '1' }).indexes, true);
    // Anything that is not the exact opt-in value leaves the default alone —
    // a typo must not silently enable a correctness-risk acceleration.
    assert.equal(resolveSurrealFeatures({ LORE_SURREAL_COUNT_VIEW: 'true' }).countView, false);
    assert.equal(resolveSurrealFeatures({ LORE_SURREAL_FTS: 'true' }).fts, false);
});

await test('the engine reports which accelerations are actually live', async () => {
    await withGraph({ countView: true, fts: false }, async (g) => {
        assert.equal(g.features?.countView, true);
        assert.equal(g.features?.fts, false);
    });
});

/* ─── countView: identical numbers, or it is worthless ───────────── */

/** The same assertions run against both flag settings and must agree. */
async function assertStats(g: SurrealGraph, expected: {
    nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number>;
}): Promise<void> {
    assert.deepEqual(await g.getStats(), expected);
}

await test('countView ON/OFF return IDENTICAL stats on the same corpus', async () => {
    const results: Array<{ nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number> }> = [];
    for (const countView of [false, true]) {
        await withGraph({ countView }, async (g) => {
            await seed(g);
            results.push(await g.getStats());
        });
    }
    assert.deepEqual(results[0], results[1], 'the view must not change a single number');
    assert.deepEqual(results[1], {
        nodeCount: 5, edgeCount: 2,
        typeBreakdown: { decision: 2, convention: 2, note: 1 },
    });
});

await test('countView ON/OFF return IDENTICAL project-scoped stats', async () => {
    const results: Record<string, unknown[]> = { off: [], on: [] };
    for (const countView of [false, true]) {
        await withGraph({ countView }, async (g) => {
            await seed(g);
            for (const project of ['p0', 'p1', 'missing']) {
                results[countView ? 'on' : 'off']!.push(await g.getStats(project));
            }
        });
    }
    assert.deepEqual(results['off'], results['on']);
    // Sanity on the scoped numbers themselves: only the intra-p0 edge counts.
    assert.deepEqual(results['on']![0], {
        nodeCount: 3, edgeCount: 1,
        typeBreakdown: { decision: 1, convention: 1, note: 1 },
    });
});

await test('countView tracks INSERTS', async () => {
    await withGraph({ countView: true }, async (g) => {
        await seed(g);
        await g.upsertNode(node('new1', { type: 'architecture', project: 'p0' }));
        await assertStats(g, {
            nodeCount: 6, edgeCount: 2,
            typeBreakdown: { decision: 2, convention: 2, note: 1, architecture: 1 },
        });
    });
});

await test('countView tracks a TYPE CHANGE (the group key moving)', async () => {
    await withGraph({ countView: true }, async (g) => {
        await seed(g);
        await g.upsertNode(node('n1', { type: 'architecture', project: 'p0' }));
        await assertStats(g, {
            nodeCount: 5, edgeCount: 2,
            typeBreakdown: { decision: 2, convention: 2, architecture: 1 },
        });
    });
});

await test('countView tracks a PROJECT CHANGE (the other group key)', async () => {
    await withGraph({ countView: true }, async (g) => {
        await seed(g);
        await g.upsertNode(node('n1', { type: 'note', project: 'p1' }));
        assert.deepEqual((await g.getStats('p0')).nodeCount, 2, 'p0 loses the node');
        assert.deepEqual((await g.getStats('p1')).nodeCount, 3, 'p1 gains it');
    });
});

await test('countView tracks DELETES, including the last member of a group', async () => {
    await withGraph({ countView: true }, async (g) => {
        await seed(g);
        await g.deleteNode('n1');   // the only 'note'
        await assertStats(g, {
            nodeCount: 4, edgeCount: 2,
            typeBreakdown: { decision: 2, convention: 2 },
        });
        // Deleting a node WITH edges exercises the engine's edge-then-node
        // sequence, which is the shape that panicked an edge-count view.
        await g.deleteNode('d1');
        await assertStats(g, {
            nodeCount: 3, edgeCount: 0,
            typeBreakdown: { decision: 1, convention: 2 },
        });
    });
});

await test('countView tracks a PRUNE loop (deleteNode called repeatedly)', async () => {
    await withGraph({ countView: true }, async (g) => {
        await seed(g);
        await g.upsertNode(node('e1', { type: 'note', ephemeral: true, ttl_ms: 1 }));
        await g.upsertNode(node('e2', { type: 'note', ephemeral: true, ttl_ms: 1 }));
        await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
        assert.equal(await g.pruneEphemeralNodes(), 2);
        await assertStats(g, {
            nodeCount: 5, edgeCount: 2,
            typeBreakdown: { decision: 2, convention: 2, note: 1 },
        });
    });
});

await test('countView on an EMPTY graph returns zeroes, not a missing view', async () => {
    await withGraph({ countView: true }, async (g) => {
        await assertStats(g, { nodeCount: 0, edgeCount: 0, typeBreakdown: {} });
    });
});

await test('countView BACKFILLS when enabled on a store that already has data', async () => {
    // The trap this guards: a view that only counts writes made AFTER it was
    // defined would under-report forever on an existing workspace, silently.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-backfill-'));
    try {
        const before = new SurrealGraph(dir, { cacheDisabled: true, features: { countView: false } });
        await before.initialize();
        await seed(before);
        const expected = await before.getStats();
        await before.close();

        const after = new SurrealGraph(dir, { cacheDisabled: true, features: { countView: true } });
        await after.initialize();
        assert.deepEqual(await after.getStats(), expected,
            'enabling the view on an existing store must see the data already there');
        await after.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('countView ROLLBACK: turning it off on a store that has one still works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-rollback-'));
    try {
        const withView = new SurrealGraph(dir, { cacheDisabled: true, features: { countView: true } });
        await withView.initialize();
        await seed(withView);
        const expected = await withView.getStats();
        await withView.close();

        // The view stays on disk; the engine simply stops reading it. Backing
        // the flag out must not require dropping anything.
        const without = new SurrealGraph(dir, { cacheDisabled: true, features: { countView: false } });
        await without.initialize();
        assert.deepEqual(await without.getStats(), expected);
        await without.upsertNode(node('post-rollback', { type: 'note' }));
        assert.equal((await without.getStats()).nodeCount, 6, 'writes still work with the view present but unused');
        await without.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('countView UNDER CONCURRENCY: the view can silently undercount even though every write lands (why this flag defaults OFF)', async () => {
    // Reproduces the legacy-removal Phase-3f-adjacent finding (2026-08-21):
    // runBulkIngest against a fresh SurrealGraph at default concurrency
    // looked like an ~80% write-loss bug. It wasn't -- every node landed.
    // The `node_counts` view's own maintained count silently undercounted
    // because all N nodes here share one (project, type) group, and
    // surrealdb-core 3.0.2's view-maintenance transactions can commit with a
    // lost update under concurrent writers to that shared group. This test
    // pins the SAFETY property the OFF default protects -- a live read is
    // always correct under the same load -- without asserting the race
    // itself must reproduce on every run (that would make the test flaky).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-countview-race-'));
    try {
        const N = 300;
        const g = new SurrealGraph(dir, { workspaceId: 'race', cacheDisabled: true, features: { countView: true } });
        await g.initialize();
        // All N nodes share one (project, type) group -- the exact shape
        // that races on the view's maintained count under concurrency.
        await Promise.all(Array.from({ length: N }, (_, i) =>
            withTransactionConflictRetry(() =>
                g.upsertNode(node(`race-${i}`, { type: 'note', project: 'race-project' })))));
        const viewed = await g.getStats('race-project');
        await g.close();

        if (viewed.nodeCount !== N) {
            console.log(`    (documented defect observed: view reported ${viewed.nodeCount}/${N} under ` +
                'concurrency -- not a new bug, not asserted on here, see SurrealFeatures.countView)');
        }

        // Ground truth, reopening the SAME store with the view unread: every
        // node genuinely landed regardless of what the view said.
        const g2 = new SurrealGraph(dir, { workspaceId: 'race', cacheDisabled: true, features: { countView: false } });
        await g2.initialize();
        assert.equal((await g2.getStats('race-project')).nodeCount, N,
            'the live GROUP BY (countView OFF, the default) is always correct under the same concurrent load');
        await g2.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ─── fts: the divergence, pinned as a known set ─────────────────── */

await test('fts OFF (default): substring search matches, as it does on the legacy graph engine', async () => {
    await withGraph({ fts: false }, async (g) => {
        await seed(g);
        assert.ok((await g.search('kapp', 50)).length > 0, 'prefix matches');
        assert.ok((await g.search('eader', 50)).length > 0, 'mid-word matches');
        assert.ok((await g.search('uthentication', 50)).length > 0, 'mid-word in content matches');
    });
});

await test('fts ON: whole words still match (the acceleration works)', async () => {
    await withGraph({ fts: true }, async (g) => {
        await seed(g);
        assert.ok((await g.search('kappa', 50)).length > 0, 'whole word in label');
        assert.ok((await g.search('authentication', 50)).length > 0, 'whole word in content');
        assert.ok((await g.search('KAPPA', 50)).length > 0, 'still case-insensitive');
    });
});

await test('fts ON: KNOWN DIVERGENCE — substring queries return NOTHING', async () => {
    // Not a bug report: this is the documented cost of the flag, asserted so
    // it cannot be enabled by someone who has not seen it. If a future
    // SurrealDB starts matching substrings, this test fails and the trade-off
    // needs re-evaluating.
    await withGraph({ fts: true }, async (g) => {
        await seed(g);
        for (const query of ['kapp', 'eader', 'uthentication', 'kappa head']) {
            assert.deepEqual(await g.search(query, 50), [],
                `'${query}' is expected to miss under full-text matching`);
        }
    });
});

await test('fts ON: tag matching is UNCHANGED (exact membership, still indexed by hand)', async () => {
    await withGraph({ fts: true }, async (g) => {
        await g.upsertNode(node('tagged', { label: 'nothing', content: 'nothing', tags: ['billing'] }));
        assert.deepEqual((await g.search('billing', 50)).map((n) => n.id), ['tagged'],
            'the exact-tag branch survives the FTS path');
        assert.deepEqual(await g.search('billin', 50), [], 'and stays exact, not prefix');
    });
});

await test('fts ON: scope filters and excludeHidden still apply to FTS candidates', async () => {
    await withGraph({ fts: true }, async (g) => {
        await seed(g);
        const scoped = await g.search('kappa', 50, 'p0');
        assert.ok(scoped.length > 0);
        assert.ok(scoped.every((n) => n.project === 'p0'), 'project scope holds on the FTS path');

        await g.supersedeNode('d1', 'd2', 'test');
        const visible = await g.search('kappa', 50, '*', '*', true);
        assert.equal(visible.some((n) => n.id === 'd1'), false, 'excludeHidden holds on the FTS path');
    });
});

await test('fts ON: ordering still comes from the SHARED ranker', async () => {
    await withGraph({ fts: true }, async (g) => {
        // Same relevance rules as the default path: label+content beats
        // label-only. FTS only chooses candidates; it never orders them.
        await g.upsertNode(node('both', { label: 'widget registry', content: 'the widget lives here' }));
        await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
        await g.upsertNode(node('label-only', { label: 'widget index', content: 'nothing relevant' }));
        const hits = await g.search('widget', 50);
        assert.deepEqual(hits.map((n) => n.id), ['both', 'label-only'],
            'relevance desc wins over the newer updatedAt, exactly as without FTS');
    });
});

/* ─── the index lock — why neither index flag can be defaulted on ── */

/**
 * Both index-based flags hit the SAME upstream defect, and it is worse than
 * the "process won't exit" symptom recorded in Phase 1: the leaked handle
 * holds the store's DIRECTORY LOCK, so the workspace cannot be reopened in the
 * process that opened it. That is the exact property that disqualified
 * `rocksdb://` as a backend, and it applies here to `surrealkv://` the moment
 * any DEFINE INDEX runs.
 *
 * Consequence: an index-accelerated workspace is usable only by a ONE-SHOT
 * process (a benchmark, a migration). The daemon reopens workspaces
 * (LocalGraphRegistry), so it cannot use either flag today.
 *
 * Asserted, not just written down, so a future @surrealdb/node that fixes it
 * turns these tests red and tells us the flags can be promoted.
 */
async function assertReopenBlocked(features: { fts?: boolean; indexes?: boolean }, label: string): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-idxlock-'));
    const previousBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    const previousTimeout = process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
    // Keep it quick: the outcome is identical at 2s and at the 15s default.
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = '1500';
    process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = '500';
    try {
        const first = new SurrealGraph(dir, { cacheDisabled: true, features });
        await first.initialize();
        await first.upsertNode(node('x'));
        await first.close();

        const second = new SurrealGraph(dir, { cacheDisabled: true, features });
        const startedAt = Date.now();
        await assert.rejects(
            () => second.initialize(),
            /Failed to open embedded SurrealDB \(surrealkv\) after \d+ attempt/,
            `${label}: a blocked reopen must raise, not hang`,
        );
        assert.ok(Date.now() - startedAt < 10_000, `${label}: the budget is enforced`);
        await second.close().catch(() => undefined);
    } finally {
        if (previousBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = previousBudget;
        if (previousTimeout === undefined) delete process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
        else process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = previousTimeout;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

await test('fts ON: KNOWN DEFECT — the workspace cannot be reopened in-process', async () => {
    await assertReopenBlocked({ fts: true }, 'fts');
});

await test('indexes ON: KNOWN DEFECT — same directory-lock retention', async () => {
    await assertReopenBlocked({ indexes: true }, 'indexes');
});

await test('countView ON: reopen is UNAFFECTED (a view is not an index)', async () => {
    // The control for the two cases above: even opted in, countView must
    // not inherit the index directory-lock defect. If this ever fails, the
    // count view is even less viable than the correctness risk already made it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-viewlock-'));
    try {
        for (let cycle = 0; cycle < 3; cycle++) {
            const g = new SurrealGraph(dir, { cacheDisabled: true, features: { countView: true } });
            await g.initialize();
            await g.upsertNode(node(`cycle-${cycle}`, { type: 'note' }));
            assert.equal((await g.getStats()).nodeCount, cycle + 1, 'counts survive each reopen');
            await g.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
