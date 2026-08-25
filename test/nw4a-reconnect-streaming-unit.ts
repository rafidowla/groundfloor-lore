#!/usr/bin/env tsx
/**
 * nw4a-reconnect-streaming-unit.ts — NW-4a regression
 * (`perf-reconnect-searchinputs-unbounded`).
 *
 * Proves the streaming reconnect rewrite:
 *
 *   A. The stratified top-K SEARCH runs INSIDE the paging loop (per-page),
 *      not after `} while (cursor)`. We observe call order by recording
 *      every bulkList + search invocation and asserting that the FIRST
 *      `verbatim.search` happens BEFORE the LAST `bulkList` returns. On
 *      base (post-loop search), every search runs after every bulkList.
 *
 *   B. Peak heap during reconnect stays bounded regardless of total
 *      node count. We build a fake graph of 5,000 nodes where each
 *      node carries ~50KB of realistic verbatim text (so the full
 *      corpus is ~250MB). On base, `searchInputs` retains every
 *      `text` across pages → peak heap delta grows with K (≥150MB).
 *      On the branch, `pageSearchInputs` is per-iteration → peak
 *      delta stays well under a 100MB ceiling.
 *
 *      The heap probe runs at the loop midpoint (via an instrumented
 *      `verbatim.search` that takes a `process.memoryUsage()` sample on
 *      every call and tracks the max), so we measure the WORKING-SET
 *      peak during reconnect, not after GC has had time to reclaim.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/nw4a-reconnect-streaming-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { reconnectGraph } from '../packages/lore/src/engines/reconnect.js';
import type { BulkListQuery, BulkListPage } from '../packages/lore/src/providers/types.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nw4a-lore-'));
process.env['LORE_HOME'] = TEST_HOME;

// We need --expose-gc to force the page-boundary collection that proves
// the steady-state per-page working set (instead of waiting on V8's
// opaque heuristic). The npm script sets NODE_OPTIONS=--expose-gc; if
// invoked standalone, self-re-exec via npx tsx so the flag is honored.
if (typeof (globalThis as { gc?: () => void }).gc !== 'function') {
    const res = spawnSync('npx', ['tsx', ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --expose-gc`.trim() },
    });
    process.exit(res.status ?? 1);
}
const gc: () => void = (globalThis as { gc: () => void }).gc;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['NW4A_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

interface FakeNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string;
    project: string;
    ecosystem: string;
    updatedAt: string;
    security_scopes: string[];
}

/** Build a node with a ~`bodyBytes`-sized content body. */
function makeFatNode(i: number, bodyBytes: number): FakeNode {
    // Distinct repeated pattern so V8 cannot intern these into one buffer.
    const seed = `n${i}-${Math.random().toString(36).slice(2)}-`;
    const repeats = Math.max(1, Math.ceil(bodyBytes / seed.length));
    const content = seed.repeat(repeats).slice(0, bodyBytes);
    return {
        id: `n${String(i).padStart(6, '0')}`,
        type: 'lore',
        label: `node ${i}`,
        content,
        tags: 'a,b',
        project: 'p',
        ecosystem: 'e',
        updatedAt: new Date(2_000_000_000_000 - i * 1000).toISOString(),
        security_scopes: [],
    };
}

/** Cursor-paginated fake graph. */
function makeFakeGraph(nodes: FakeNode[], onBulkListPage?: () => void) {
    const calls = { bulkListPages: 0 };
    const sorted = [...nodes].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : (a.id < b.id ? -1 : 1));
    const graph = {
        async bulkList(q: BulkListQuery): Promise<BulkListPage> {
            let start = 0;
            if (q.cursor) {
                const idx = sorted.findIndex((n) =>
                    n.updatedAt === q.cursor!.updatedAt && n.id === q.cursor!.id);
                start = idx >= 0 ? idx + 1 : 0;
            }
            const slice = sorted.slice(start, start + q.limit);
            calls.bulkListPages++;
            const hasMore = start + q.limit < sorted.length;
            const last = slice[slice.length - 1];
            if (onBulkListPage) onBulkListPage();
            return {
                nodes: slice as unknown as Array<Record<string, unknown>>,
                hasMore,
                nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
            };
        },
        async listNodes(): Promise<unknown[]> { return nodes as unknown[]; },
        async addEdge() { /* unused in dryRun */ },
        async pruneInferredLoreEdges() { return 0; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { graph: graph as any, calls };
}

/**
 * Spy verbatim that no-ops embed/search but records call ORDER + heap samples.
 *
 * Heap measurement strategy: every Nth `search` call forces a GC and samples
 * `heapUsed`. We force-GC so the reported delta is the GENUINE live working
 * set (what reconnect actually has rooted), not lazily uncollected garbage
 * from the previous page. Without --expose-gc the bug "looks fixed" because
 * V8 hasn't gotten around to collecting the cross-page residue yet.
 */
function makeProbingVerbatim(baselineHeap: number) {
    const events: Array<'bulkList' | 'search'> = [];
    let peakHeapDelta = 0;
    let searchN = 0;
    const SAMPLE_EVERY = 50;
    const store = {
        async initialize() { /* baseline already captured by caller */ },
        async getById() { return null; },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op — embedding is not what we measure */ },
        async search() {
            events.push('search');
            searchN++;
            if (searchN % SAMPLE_EVERY === 0) {
                gc();
                const cur = process.memoryUsage().heapUsed;
                const delta = cur - baselineHeap;
                if (delta > peakHeapDelta) peakHeapDelta = delta;
            }
            return [];
        },
    };
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store: store as any,
        events,
        peak: () => peakHeapDelta,
        recordBulkList: () => events.push('bulkList'),
    };
}

(async () => {
    console.log('NW-4a — reconnect streams searchInputs per page (bounded peak heap)');

    /* ── A: search runs INTERLEAVED with paging, not after ──────────── */
    await test('A1 — first verbatim.search runs BEFORE last bulkList (interleaved)', async () => {
        const nodes = Array.from({ length: 2500 }, (_, i) => makeFatNode(i, 200));
        gc();
        const probe = makeProbingVerbatim(process.memoryUsage().heapUsed);
        const { graph } = makeFakeGraph(nodes, probe.recordBulkList);

        await reconnectGraph(graph, probe.store, { dryRun: true });

        const firstSearchIdx = probe.events.indexOf('search');
        const lastBulkListIdx = probe.events.lastIndexOf('bulkList');
        assert.ok(firstSearchIdx >= 0, 'reconnect ran at least one search');
        assert.ok(lastBulkListIdx >= 0, 'reconnect ran at least one bulkList');
        assert.ok(firstSearchIdx < lastBulkListIdx,
            `first search must precede last bulkList (interleaved). ` +
            `got firstSearch=${firstSearchIdx} lastBulkList=${lastBulkListIdx} — ` +
            `searches are running AFTER all paging finished (the NW-4a bug)`);
    });

    /* ── B: peak heap delta is bounded by page size, not total nodes ── */
    await test('B1 — peak heap during reconnect ≤100MB regardless of corpus size', async () => {
        // ~5,000 nodes × ~50KB body = ~250MB of total verbatim text.
        // On base (cross-page searchInputs retains every text), peak heap
        // during reconnect grows with K toward ~250MB.
        // On branch (per-page pageSearchInputs), peak heap stays bounded
        // by one page (1000 × 50KB ≈ 50MB) plus baseline overhead.
        const NODE_COUNT = 5_000;
        const BODY_BYTES = 50_000;
        const CEILING_BYTES = 100 * 1024 * 1024;

        const nodes = Array.from({ length: NODE_COUNT }, (_, i) => makeFatNode(i, BODY_BYTES));
        // Pre-build to exclude construction from the measurement window.
        gc();
        // Baseline is post-corpus-build: the source-of-truth ("disk") data is
        // owned by the fake graph (just as it'd be owned by Kùzu+LanceDB in
        // production). Reconnect's job is to STREAM through it; the delta
        // measures the extra working-set reconnect builds on top.
        const baseline = process.memoryUsage().heapUsed;
        const probe = makeProbingVerbatim(baseline);
        const { graph } = makeFakeGraph(nodes, probe.recordBulkList);

        await reconnectGraph(graph, probe.store, { dryRun: true });

        const peakMB = (probe.peak() / 1024 / 1024).toFixed(1);
        const ceilingMB = (CEILING_BYTES / 1024 / 1024).toFixed(0);
        if (process.env['NW4A_DEBUG']) {
            console.error(`    [debug] peak heap delta during reconnect = ${peakMB}MB (ceiling ${ceilingMB}MB)`);
        }
        assert.ok(probe.peak() <= CEILING_BYTES,
            `peak heap delta during reconnect must be ≤${ceilingMB}MB ` +
            `(got ${peakMB}MB — searchInputs is retaining verbatim text across pages, NW-4a bug)`);
    });

    /* ── B2: ceiling is a function of PAGE size, not total nodes ────── */
    await test('B2 — peak heap with 5k nodes ≈ peak with 1k nodes (constant-in-N)', async () => {
        const BODY_BYTES = 50_000;

        const measure = async (count: number) => {
            const ns = Array.from({ length: count }, (_, i) => makeFatNode(i, BODY_BYTES));
            gc();
            const baseline = process.memoryUsage().heapUsed;
            const p = makeProbingVerbatim(baseline);
            const { graph } = makeFakeGraph(ns, p.recordBulkList);
            await reconnectGraph(graph, p.store, { dryRun: true });
            return p.peak();
        };

        const peak1k = await measure(1000);
        const peak5k = await measure(5000);

        if (process.env['NW4A_DEBUG']) {
            console.error(`    [debug] peak 1k=${(peak1k / 1024 / 1024).toFixed(1)}MB, ` +
                `peak 5k=${(peak5k / 1024 / 1024).toFixed(1)}MB`);
        }
        // If reconnect retains text across pages, peak5k ≈ 5× peak1k.
        // Streaming reconnect: peak5k should be within ~3× peak1k
        // (some growth is acceptable — accumulated edges, dist counters).
        // The aggressive bound here documents the constant-in-N property.
        assert.ok(peak5k <= peak1k * 3 + 20 * 1024 * 1024,
            `peak heap must be O(page) not O(N). ` +
            `1k-node peak=${(peak1k / 1024 / 1024).toFixed(1)}MB, ` +
            `5k-node peak=${(peak5k / 1024 / 1024).toFixed(1)}MB — ` +
            `5k peak should not be ≫ 1k peak (NW-4a bug: searchInputs grows with N)`);
    });

    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
