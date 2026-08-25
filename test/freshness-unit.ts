#!/usr/bin/env tsx
/**
 * test/freshness-unit.ts
 *
 * Regression + unit tests for the Freshness Sprint:
 *   - freshnessEngine.ts  (computeFreshness, sweepFreshness, readFreshnessTtl)
 *   - localSourceWatcher.ts (start/stop, debounce, extension filtering)
 *
 * Coverage:
 *   Happy path   — fresh/stale/never-synced counts correct
 *   Unhappy path — empty graph, all-never-synced, all-fresh, all-stale
 *   Adversarial  — NaN syncedAt, null syncedAt, future timestamps, huge TTL,
 *                  TTL=0 (should not accept), LORE_FRESHNESS_TTL_HOURS override
 *   Watcher      — start/stop lifecycle, extension filtering, ignored files
 *   Regression   — sweepFreshness with IFreshnessGraph fake, staleNodeIds cap
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
    computeFreshness,
    sweepFreshness,
    readFreshnessTtl,
    type FreshnessReport,
    type IFreshnessGraph,
} from '../packages/lore/src/engines/freshnessEngine.js';
import { LocalSourceWatcher } from '../packages/lore/src/engines/localSourceWatcher.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

/* ─── harness ──────────────────────────────────────────────────── */

let passed = 0; let failed = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
    pending.push(Promise.resolve().then(async () => {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
            failed++;
        }
    }));
}

/* ─── helpers ──────────────────────────────────────────────────── */

const FIXED_NOW = new Date('2026-01-01T12:00:00Z').getTime();
const HOUR_MS = 3_600_000;

function makeNode(overrides: Partial<LoreNode> = {}): LoreNode {
    return {
        id: `node-${Math.random().toString(36).slice(2, 8)}`,
        type: 'note',
        label: 'test',
        content: 'test content',
        tags: '',
        project: 'test',
        ecosystem: '',
        metadata: null,
        createdAt: new Date(FIXED_NOW).toISOString(),
        updatedAt: new Date(FIXED_NOW).toISOString(),
        syncedAt: null,
        stale: false,
        ...overrides,
    } as LoreNode;
}

function freshNode(hoursAgo = 1): LoreNode {
    return makeNode({ syncedAt: new Date(FIXED_NOW - hoursAgo * HOUR_MS).toISOString() });
}

function staleNode(hoursAgo = 48): LoreNode {
    return makeNode({ syncedAt: new Date(FIXED_NOW - hoursAgo * HOUR_MS).toISOString() });
}

/**
 * neverSyncedNode — simulates a local node that has never been synced
 * AND hasn't been updated recently (updatedAt 48h ago). With the locally-
 * fresh fallback introduced in the wishlist, a node with a recent updatedAt
 * would count as fresh. Setting an old updatedAt ensures this helper still
 * lands in the neverSyncedNodes bucket, which is what most existing tests check.
 */
function neverSyncedNode(): LoreNode {
    return makeNode({ syncedAt: null, updatedAt: new Date(FIXED_NOW - 48 * HOUR_MS).toISOString() });
}

function fakeGraph(nodes: LoreNode[]): IFreshnessGraph {
    return {
        listNodes: async () => nodes,
    };
}

/* ═══════════════════════════════════════════════════════════════════
   readFreshnessTtl
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── readFreshnessTtl ───');

test('readFreshnessTtl: no override, no env → 24', () => {
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
    assert.equal(readFreshnessTtl(), 24);
});

test('readFreshnessTtl: explicit override wins over env', () => {
    process.env.LORE_FRESHNESS_TTL_HOURS = '48';
    assert.equal(readFreshnessTtl(12), 12);
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
});

test('readFreshnessTtl: env var used when no override', () => {
    process.env.LORE_FRESHNESS_TTL_HOURS = '6';
    assert.equal(readFreshnessTtl(), 6);
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
});

test('readFreshnessTtl: invalid env var falls back to 24', () => {
    process.env.LORE_FRESHNESS_TTL_HOURS = 'banana';
    assert.equal(readFreshnessTtl(), 24);
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
});

test('readFreshnessTtl: negative env var falls back to 24', () => {
    process.env.LORE_FRESHNESS_TTL_HOURS = '-5';
    assert.equal(readFreshnessTtl(), 24);
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
});

test('readFreshnessTtl: zero env var falls back to 24', () => {
    process.env.LORE_FRESHNESS_TTL_HOURS = '0';
    assert.equal(readFreshnessTtl(), 24);
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
});

/* ═══════════════════════════════════════════════════════════════════
   computeFreshness — happy path
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── computeFreshness — happy path ───');

test('empty graph → all zeroes, 100% fresh', () => {
    const r = computeFreshness([], 'ws', 24, FIXED_NOW);
    assert.equal(r.totalNodes, 0);
    assert.equal(r.freshNodes, 0);
    assert.equal(r.staleNodes, 0);
    assert.equal(r.neverSyncedNodes, 0);
    assert.equal(r.freshnessPercent, 100);
    assert.equal(r.oldestSyncedAt, null);
    assert.equal(r.newestSyncedAt, null);
    assert.deepEqual(r.staleNodeIds, []);
});

test('single fresh node → 100% fresh', () => {
    const r = computeFreshness([freshNode(1)], 'ws', 24, FIXED_NOW);
    assert.equal(r.totalNodes, 1);
    assert.equal(r.freshNodes, 1);
    assert.equal(r.staleNodes, 0);
    assert.equal(r.freshnessPercent, 100);
});

test('single stale node → 0% fresh, staleNodeIds populated', () => {
    const n = staleNode(48);
    const r = computeFreshness([n], 'ws', 24, FIXED_NOW);
    assert.equal(r.freshNodes, 0);
    assert.equal(r.staleNodes, 1);
    assert.equal(r.freshnessPercent, 0);
    assert.equal(r.staleNodeIds.length, 1);
    assert.equal(r.staleNodeIds[0], n.id);
});

test('single never-synced node → neverSyncedNodes=1, 100% fresh (no penalty)', () => {
    const r = computeFreshness([neverSyncedNode()], 'ws', 24, FIXED_NOW);
    assert.equal(r.neverSyncedNodes, 1);
    assert.equal(r.staleNodes, 0);
    assert.equal(r.freshnessPercent, 100);
});

test('mixed: 2 fresh + 1 stale + 1 never-synced', () => {
    const nodes = [freshNode(1), freshNode(2), staleNode(48), neverSyncedNode()];
    const r = computeFreshness(nodes, 'ws', 24, FIXED_NOW);
    assert.equal(r.totalNodes, 4);
    assert.equal(r.freshNodes, 2);
    assert.equal(r.staleNodes, 1);
    assert.equal(r.neverSyncedNodes, 1);
    // freshnessPercent = 2/3 = 67%
    assert.ok(r.freshnessPercent >= 66 && r.freshnessPercent <= 67,
        `expected ~67%, got ${r.freshnessPercent}`);
});

test('all never-synced → 100% fresh (no penalty for never-synced workspace)', () => {
    const nodes = [neverSyncedNode(), neverSyncedNode(), neverSyncedNode()];
    const r = computeFreshness(nodes, 'ws', 24, FIXED_NOW);
    assert.equal(r.neverSyncedNodes, 3);
    assert.equal(r.freshnessPercent, 100);
});

test('oldestSyncedAt < newestSyncedAt for mixed synced nodes', () => {
    const old = makeNode({ syncedAt: new Date(FIXED_NOW - 72 * HOUR_MS).toISOString() });
    const recent = makeNode({ syncedAt: new Date(FIXED_NOW - 1 * HOUR_MS).toISOString() });
    const r = computeFreshness([old, recent], 'ws', 24, FIXED_NOW);
    assert.ok(r.oldestSyncedAt !== null && r.newestSyncedAt !== null);
    assert.ok(r.oldestSyncedAt! < r.newestSyncedAt!, 'oldest should be earlier than newest');
});

test('report carries workspace and ttlHours verbatim', () => {
    const r = computeFreshness([], 'my-workspace', 12, FIXED_NOW);
    assert.equal(r.workspace, 'my-workspace');
    assert.equal(r.ttlHours, 12);
});

test('generatedAt reflects nowMs parameter', () => {
    const r = computeFreshness([], 'ws', 24, FIXED_NOW);
    assert.equal(r.generatedAt, new Date(FIXED_NOW).toISOString());
});

/* ═══════════════════════════════════════════════════════════════════
   computeFreshness — boundary / TTL precision
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── computeFreshness — TTL boundary ───');

test('node exactly at TTL boundary → fresh (not stale)', () => {
    // syncedAt exactly 24h ago, TTL=24h → ageMs == thresholdMs → NOT > threshold
    const n = makeNode({ syncedAt: new Date(FIXED_NOW - 24 * HOUR_MS).toISOString() });
    const r = computeFreshness([n], 'ws', 24, FIXED_NOW);
    assert.equal(r.freshNodes, 1);
    assert.equal(r.staleNodes, 0);
});

test('node 1ms past TTL → stale', () => {
    const n = makeNode({ syncedAt: new Date(FIXED_NOW - 24 * HOUR_MS - 1).toISOString() });
    const r = computeFreshness([n], 'ws', 24, FIXED_NOW);
    assert.equal(r.staleNodes, 1);
});

test('TTL=1h classifies 59-min-old node as fresh', () => {
    const n = freshNode(0.983); // ~59 min ago
    const r = computeFreshness([n], 'ws', 1, FIXED_NOW);
    assert.equal(r.freshNodes, 1);
});

test('TTL=1h classifies 61-min-old node as stale', () => {
    const n = freshNode(1.017); // ~61 min ago
    const r = computeFreshness([n], 'ws', 1, FIXED_NOW);
    assert.equal(r.staleNodes, 1);
});

/* ═══════════════════════════════════════════════════════════════════
   computeFreshness — adversarial inputs
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── computeFreshness — adversarial ───');

test('NaN syncedAt treated as never-synced', () => {
    const n = makeNode({ syncedAt: 'not-a-date' as unknown as string });
    const r = computeFreshness([n], 'ws', 24, FIXED_NOW);
    assert.equal(r.neverSyncedNodes, 1);
    assert.equal(r.staleNodes, 0);
});

test('empty string syncedAt treated as never-synced', () => {
    // Empty syncedAt + old updatedAt → genuinely stale local node → neverSynced.
    const n = makeNode({ syncedAt: '' as unknown as string, updatedAt: new Date(FIXED_NOW - 48 * HOUR_MS).toISOString() });
    const r = computeFreshness([n], 'ws', 24, FIXED_NOW);
    assert.equal(r.neverSyncedNodes, 1);
});

test('future syncedAt (clock skew) → fresh (ageMs < 0 clamped to 0 or treated as fresh)', () => {
    // syncedAt 1 hour in the future
    const n = makeNode({ syncedAt: new Date(FIXED_NOW + HOUR_MS).toISOString() });
    const r = computeFreshness([n], 'ws', 24, FIXED_NOW);
    // ageMs would be negative; node is not stale
    assert.equal(r.staleNodes, 0);
    assert.equal(r.neverSyncedNodes, 0);
});

test('staleNodeIds capped at 100 when more than 100 stale nodes', () => {
    const nodes = Array.from({ length: 200 }, () => staleNode(999));
    const r = computeFreshness(nodes, 'ws', 24, FIXED_NOW);
    assert.equal(r.staleNodes, 200);
    assert.equal(r.staleNodeIds.length, 100, 'staleNodeIds should be capped at 100');
});

test('all fresh → staleNodeIds is empty', () => {
    const nodes = [freshNode(1), freshNode(2), freshNode(3)];
    const r = computeFreshness(nodes, 'ws', 24, FIXED_NOW);
    assert.deepEqual(r.staleNodeIds, []);
});

test('freshnessPercent is 0 when all synced nodes are stale', () => {
    const nodes = [staleNode(48), staleNode(72)];
    const r = computeFreshness(nodes, 'ws', 24, FIXED_NOW);
    assert.equal(r.freshnessPercent, 0);
});

test('freshnessPercent is always integer (Math.round applied)', () => {
    // 1 fresh + 2 stale → 1/3 = 33.33... → should round to 33
    const nodes = [freshNode(1), staleNode(48), staleNode(48)];
    const r = computeFreshness(nodes, 'ws', 24, FIXED_NOW);
    assert.equal(r.freshnessPercent, Math.round(r.freshnessPercent),
        'freshnessPercent should be an integer');
    assert.equal(r.freshnessPercent, 33);
});

/* ═══════════════════════════════════════════════════════════════════
   sweepFreshness — integration with IFreshnessGraph
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── sweepFreshness — integration ───');

test('sweepFreshness: calls listNodes and returns report', async () => {
    const nodes = [freshNode(1), staleNode(48)];
    const graph = fakeGraph(nodes);
    const r = await sweepFreshness(graph, 'ws', 24, FIXED_NOW);
    assert.equal(r.totalNodes, 2);
    assert.equal(r.freshNodes, 1);
    assert.equal(r.staleNodes, 1);
});

test('sweepFreshness: empty graph returns 100% fresh', async () => {
    const r = await sweepFreshness(fakeGraph([]), 'ws', 24, FIXED_NOW);
    assert.equal(r.freshnessPercent, 100);
    assert.equal(r.totalNodes, 0);
});

test('sweepFreshness: uses LORE_FRESHNESS_TTL_HOURS when no override', async () => {
    process.env.LORE_FRESHNESS_TTL_HOURS = '1';
    const n = freshNode(0.5); // 30 min ago — fresh under 1h TTL
    const r = await sweepFreshness(fakeGraph([n]), 'ws', undefined, FIXED_NOW);
    delete process.env.LORE_FRESHNESS_TTL_HOURS;
    assert.equal(r.ttlHours, 1);
    assert.equal(r.freshNodes, 1);
});

test('sweepFreshness: uses listNodes without type/tag filters', async () => {
    let calledWith: unknown[] | null = null;
    const graph: IFreshnessGraph = {
        listNodes: async (...args: unknown[]) => { calledWith = args; return []; },
    };
    await sweepFreshness(graph, 'ws', 24, FIXED_NOW);
    assert.ok(calledWith !== null, 'listNodes should have been called');
    // First two args (type, tag) should be undefined
    assert.equal(calledWith![0], undefined);
    assert.equal(calledWith![1], undefined);
});

/* ═══════════════════════════════════════════════════════════════════
   LocalSourceWatcher — lifecycle
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── LocalSourceWatcher — lifecycle ───');

test('watcher starts idle when LORE_WATCH_PATHS is unset', () => {
    delete process.env.LORE_WATCH_PATHS;
    const w = new LocalSourceWatcher();
    w.start(() => { /* noop */ });
    assert.equal(w.isRunning, true); // running but idle
    assert.equal(w.watcherCount, 0);
    w.stop();
});

test('start() is idempotent — second call is a no-op', () => {
    const w = new LocalSourceWatcher();
    w.start(() => {});
    w.start(() => {}); // should not throw or create duplicate watchers
    assert.equal(w.watcherCount, 0); // no paths configured
    w.stop();
});

test('stop() resets running state', async () => {
    const w = new LocalSourceWatcher();
    w.start(() => {});
    await w.stop();
    assert.equal(w.isRunning, false);
    assert.equal(w.watcherCount, 0);
});

test('watcher skips non-existent paths gracefully', () => {
    const w = new LocalSourceWatcher();
    // Should not throw
    w.start(() => {}, ['/this/path/does/not/exist/ever']);
    assert.equal(w.watcherCount, 0);
    w.stop();
});

test('watcher creates handle for existing directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
    try {
        const w = new LocalSourceWatcher();
        w.start(() => {}, [tmpDir]);
        assert.equal(w.watcherCount, 1);
        w.stop();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('readWatchPaths: splits colon-separated env var', () => {
    process.env.LORE_WATCH_PATHS = '/a:/b:/c';
    const paths = LocalSourceWatcher.readWatchPaths();
    assert.deepEqual(paths, ['/a', '/b', '/c']);
    delete process.env.LORE_WATCH_PATHS;
});

test('readWatchPaths: empty env var returns empty array', () => {
    process.env.LORE_WATCH_PATHS = '';
    assert.deepEqual(LocalSourceWatcher.readWatchPaths(), []);
    delete process.env.LORE_WATCH_PATHS;
});

test('readExtensions: default includes md, txt, rst', () => {
    delete process.env.LORE_WATCH_EXTENSIONS;
    const ext = LocalSourceWatcher.readExtensions();
    assert.ok(ext.has('md'));
    assert.ok(ext.has('txt'));
    assert.ok(ext.has('rst'));
});

test('readExtensions: custom override via env var', () => {
    process.env.LORE_WATCH_EXTENSIONS = 'yaml,json';
    const ext = LocalSourceWatcher.readExtensions();
    assert.ok(ext.has('yaml'));
    assert.ok(ext.has('json'));
    assert.ok(!ext.has('md'));
    delete process.env.LORE_WATCH_EXTENSIONS;
});

/* ═══════════════════════════════════════════════════════════════════
   LocalSourceWatcher — file-change detection (integration)
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── LocalSourceWatcher — file events ───');

test('watcher fires callback for .md file creation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
    try {
        const changed: string[] = [];
        const w = new LocalSourceWatcher();
        w.start((p) => changed.push(p), [tmpDir], 100 /* fast debounce for test */);

        // Allow fs.watch to stabilize before writing (macOS kqueue needs ~100ms)
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Write a markdown file
        const mdFile = path.join(tmpDir, 'test.md');
        fs.writeFileSync(mdFile, '# hello');

        // Wait for debounce + propagation
        await new Promise((resolve) => setTimeout(resolve, 500));
        await w.stop();

        assert.ok(changed.length > 0, 'expected at least one change event');
        assert.ok(changed.some((p) => p.endsWith('test.md')), `expected test.md in events, got ${JSON.stringify(changed)}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('watcher does NOT fire for .swp (vim swap) files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
    try {
        const changed: string[] = [];
        const w = new LocalSourceWatcher();
        w.start((p) => changed.push(p), [tmpDir], 100);

        fs.writeFileSync(path.join(tmpDir, '.test.md.swp'), 'swap');

        await new Promise((resolve) => setTimeout(resolve, 350));
        await w.stop();

        assert.equal(changed.length, 0, `swap files should not trigger callback, got ${JSON.stringify(changed)}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('watcher does NOT fire for .js files (not in default extensions)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
    try {
        const changed: string[] = [];
        const w = new LocalSourceWatcher();
        w.start((p) => changed.push(p), [tmpDir], 100);

        fs.writeFileSync(path.join(tmpDir, 'index.js'), 'console.log("hi")');

        await new Promise((resolve) => setTimeout(resolve, 350));
        await w.stop();

        assert.equal(changed.length, 0, `JS files should not trigger callback by default`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('debounce collapses rapid writes to single callback', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
    try {
        const changed: string[] = [];
        const w = new LocalSourceWatcher();
        w.start((p) => changed.push(p), [tmpDir], 300 /* 300ms debounce */);

        // Write the same file 5 times in rapid succession
        const mdFile = path.join(tmpDir, 'rapid.md');
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(mdFile, `write #${i}`);
            await new Promise((r) => setTimeout(r, 30));
        }

        // Wait for debounce to settle
        await new Promise((resolve) => setTimeout(resolve, 700));
        await w.stop();

        // Should have 1 or very few events (debounced), not 5
        const mdEvents = changed.filter((p) => p.endsWith('rapid.md'));
        assert.ok(mdEvents.length <= 2, `expected ≤2 events after debounce, got ${mdEvents.length}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/* ─── summary ──────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n─── Freshness Sprint: ${passed}/${passed + failed} passed ───`);
if (failed > 0) process.exit(1);
