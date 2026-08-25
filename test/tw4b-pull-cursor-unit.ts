#!/usr/bin/env tsx
/**
 * tw4b-pull-cursor-unit.ts — TW-4b regression tests for the pull cursor.
 *
 * Two silent-data-loss bugs in engines/syncEngine.ts (pullRemote):
 *
 *   (corr-pull-cursor-stall-edge-only-page) — `maxUpdatedAtInPage` was advanced
 *     ONLY by `node.updatedAt`; edges never moved it. A FULL page (>= the
 *     full-page threshold) containing ONLY edges therefore left the cursor
 *     unchanged while `pageRecords >= threshold`: neither break condition fired,
 *     so the loop re-issued `pull(since)` with the IDENTICAL `since` up to
 *     PULL_MAX_PAGES times (re-applying the same edges), then exited and stamped
 *     `new Date().toISOString()` as the cursor — jumping to NOW and permanently
 *     skipping every remote record after that page.
 *
 *   (corr-pull-empty-cycle-stamps-wallclock) — the post-loop path stamped
 *     `new Date().toISOString()` whenever `sinceForPage` had not changed from
 *     the on-disk cursor (e.g. an empty pull cycle). Wall-clock stamping skips
 *     anything that landed on the remote with `updated_at < now` but
 *     `updated_at > last cursor`.
 *
 * Fix (TW-4b):
 *   - advance the page cursor from BOTH nodes AND edges (edges may carry
 *     updatedAt/createdAt; read them defensively).
 *   - if a FULL page did NOT advance the cursor: break and surface an error —
 *     never loop, never wall-clock-stamp.
 *   - on an empty (or otherwise non-advancing) pull, leave the on-disk cursor
 *     exactly where it was — never wall-clock-stamp.
 *
 * Test 1 FAILS on base: edge-only full page never advances the cursor, so the
 *   2nd pull re-issues the same `since` (no progress). PASSES on branch: the
 *   cursor advances past the edge page and the 2nd pull makes progress.
 *
 * Test 2 FAILS on base: an empty pull cycle wall-clock-stamps the cursor.
 *   PASSES on branch: the cursor is left unchanged.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SyncEngine,
    type SyncAdapter,
    type SyncResult,
} from '../packages/lore/src/engines/syncEngine.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function tmpLoreDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tw4b-cursor-'));
}

const EPOCH = '1970-01-01T00:00:00.000Z';
// Must match PULL_PAGE_FULL_THRESHOLD in syncEngine.ts.
const PAGE_FULL = 1000;

/**
 * Minimal local-graph stub. pullRemote duck-types getNode/upsertNode/addEdge.
 * getNode returns null so pulled nodes are fresh inserts (not conflicts).
 */
function makeNoopGraph() {
    const store = new Map<string, LoreNode>();
    return {
        async getNode(id: string): Promise<LoreNode | null> { return store.get(id) ?? null; },
        async upsertNode(n: LoreNode): Promise<void> { store.set(n.id, n); },
        async addEdge(_e: LoreEdge): Promise<void> { /* no-op: success */ },
    };
}

/** Programmable adapter that records every `since` it is queried with. */
interface ProgAdapter extends SyncAdapter {
    pullSinceArgs: string[];
    /** Maps a `since` value to the page returned for it. Falls back to empty. */
    pageFor: (since: string) => { nodes: LoreNode[]; edges: LoreEdge[] };
}

function makeAdapter(pageFor: ProgAdapter['pageFor']): ProgAdapter {
    const a: ProgAdapter = {
        pullSinceArgs: [],
        pageFor,
        async push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult> {
            return { nodesPushed: nodes.length, edgesPushed: edges.length, failures: 0, errors: [] };
        },
        async pushDeletes(ids: string[]): Promise<SyncResult> {
            return { nodesPushed: ids.length, edgesPushed: 0, failures: 0, errors: [] };
        },
        async pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }> {
            a.pullSinceArgs.push(since);
            return a.pageFor(since);
        },
        async isConnected(): Promise<boolean> { return true; },
        async connect(): Promise<void> { /* no-op */ },
        async disconnect(): Promise<void> { /* no-op */ },
    };
    return a;
}

(async () => {
    console.log('TW-4b · pull cursor must advance past edge-only pages and never wall-clock-stamp');

    // ── Test 1: a FULL page of ONLY edges must advance the cursor; the next
    //    pull must make progress (different, later `since`). ──
    await test('edge-only full page advances the cursor; next pull makes progress', async () => {
        const dir = tmpLoreDir();
        const graph = makeNoopGraph();

        // A full page (>= threshold) of edges only. Each edge carries an
        // updatedAt timestamp; the max is `maxEdgeTs`.
        const baseMs = Date.parse('2026-05-01T00:00:00.000Z');
        const edges: LoreEdge[] = [];
        for (let i = 0; i < PAGE_FULL; i++) {
            edges.push({
                sourceId: `s-${i}`,
                targetId: `t-${i}`,
                relation: 'rel',
                // Adapters may attach a timestamp to the wire shape; TW-4b
                // reads it defensively to advance the cursor.
                updatedAt: new Date(baseMs + i * 1000).toISOString(),
            } as LoreEdge & { updatedAt: string });
        }
        const maxEdgeTs = new Date(baseMs + (PAGE_FULL - 1) * 1000).toISOString();

        const adapter = makeAdapter((since: string) => {
            // First page (since=EPOCH): the full edge-only batch.
            // Any later `since`: empty (caught up).
            if (since === EPOCH) return { nodes: [], edges };
            return { nodes: [], edges: [] };
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const r = await engine.pullRemote();

        // The cursor MUST have advanced past the edge page (to the max edge
        // timestamp), so the in-invocation second page query used that ts and
        // came back empty — no infinite re-fetch of the same `since`.
        // On BASE: the cursor never moved off EPOCH, the full page kept
        // re-firing the SAME `since`, so EPOCH appears repeatedly.
        const epochQueries = adapter.pullSinceArgs.filter(s => s === EPOCH).length;
        assert.equal(epochQueries, 1,
            `the edge-only page must be fetched ONCE, not re-fetched with the same since (got ${epochQueries} EPOCH queries; all=${JSON.stringify(adapter.pullSinceArgs)})`);

        // The follow-up page MUST have used the advanced cursor (max edge ts),
        // i.e. real progress was made.
        assert.ok(adapter.pullSinceArgs.includes(maxEdgeTs),
            `a follow-up pull must use the advanced cursor ${maxEdgeTs} (got ${JSON.stringify(adapter.pullSinceArgs)})`);

        // The on-disk cursor MUST be the OBSERVED edge timestamp, never
        // wall-clock (which on base would be NOW, jumping past records).
        const cursorOnDisk = fs.readFileSync(path.join(dir, '.last-sync.pull'), 'utf-8').trim();
        assert.equal(cursorOnDisk, maxEdgeTs,
            `pull cursor must be the observed edge timestamp ${maxEdgeTs}, not wall-clock (got ${cursorOnDisk})`);

        // And no stall error on a page that legitimately advanced.
        assert.equal(r.error, undefined, `clean edge-only pull must not surface an error (got ${JSON.stringify(r)})`);
        assert.equal(r.edgesPulled, PAGE_FULL, 'all edges applied');
    });

    // ── Test 1b: a FULL page that genuinely cannot advance (edges with NO
    //    timestamp) must surface a stall error and must NOT wall-clock-stamp
    //    or loop forever. ──
    await test('non-advancing full page surfaces a stall error, never wall-clock-stamps', async () => {
        const dir = tmpLoreDir();
        const graph = makeNoopGraph();

        const edges: LoreEdge[] = [];
        for (let i = 0; i < PAGE_FULL; i++) {
            edges.push({ sourceId: `s-${i}`, targetId: `t-${i}`, relation: 'rel' });
        }
        // Always returns the same full, non-advanceable page.
        const adapter = makeAdapter(() => ({ nodes: [], edges }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const r = await engine.pullRemote();

        // Must NOT have looped PULL_MAX_PAGES times re-fetching the same page;
        // it should break after the first non-advancing full page.
        assert.equal(adapter.pullSinceArgs.length, 1,
            `must not loop re-fetching a non-advancing page (got ${adapter.pullSinceArgs.length} queries)`);

        // Must surface a stall error rather than silently succeeding.
        assert.ok(r.error !== undefined && /stall/i.test(r.error),
            `non-advancing full page must surface a stall error (got ${JSON.stringify(r)})`);

        // Cursor must NOT have been wall-clock-stamped: either absent or EPOCH.
        const cursorPath = path.join(dir, '.last-sync.pull');
        const cursorOnDisk = fs.existsSync(cursorPath) ? fs.readFileSync(cursorPath, 'utf-8').trim() : '';
        assert.ok(!cursorOnDisk || cursorOnDisk === EPOCH,
            `cursor must NOT advance (no wall-clock stamp) on a stall (got ${cursorOnDisk})`);
    });

    // ── Test 2: an empty pull cycle must leave the cursor UNCHANGED — never
    //    stamp wall-clock. ──
    await test('empty pull cycle leaves the cursor unchanged (no wall-clock stamp)', async () => {
        const dir = tmpLoreDir();
        // Seed a real prior pull cursor so we can detect any unwanted change.
        const priorCursor = '2026-03-01T00:00:00.000Z';
        fs.writeFileSync(path.join(dir, '.last-sync.pull'), priorCursor, 'utf-8');

        const graph = makeNoopGraph();
        const adapter = makeAdapter(() => ({ nodes: [], edges: [] }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        await engine.pullRemote();

        const cursorOnDisk = fs.readFileSync(path.join(dir, '.last-sync.pull'), 'utf-8').trim();
        assert.equal(cursorOnDisk, priorCursor,
            `empty pull must leave the cursor at ${priorCursor}, not wall-clock-stamp it (got ${cursorOnDisk})`);

        // The adapter was queried with the prior cursor (not a clobbered value).
        assert.equal(adapter.pullSinceArgs[0], priorCursor,
            `pull must query from the prior cursor (got ${adapter.pullSinceArgs[0]})`);
    });

    // ── Test 2b: empty pull on a FRESH dir must not create a wall-clock cursor. ──
    await test('empty pull on a fresh dir does not wall-clock-stamp the cursor', async () => {
        const dir = tmpLoreDir();
        const graph = makeNoopGraph();
        const adapter = makeAdapter(() => ({ nodes: [], edges: [] }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        await engine.pullRemote();

        const cursorPath = path.join(dir, '.last-sync.pull');
        const cursorOnDisk = fs.existsSync(cursorPath) ? fs.readFileSync(cursorPath, 'utf-8').trim() : '';
        assert.ok(!cursorOnDisk || cursorOnDisk === EPOCH,
            `empty pull on a fresh dir must not write a wall-clock cursor (got ${cursorOnDisk})`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
