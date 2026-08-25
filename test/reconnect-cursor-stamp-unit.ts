#!/usr/bin/env tsx
/**
 * reconnect-cursor-stamp-unit.ts — functional-correctness audit 2026-08-17.
 *
 * Finding: the incremental-reconnect cursor was stamped when the sweep
 * FINISHED (writeCursor used `new Date()` at completion), but the sweep only
 * covers nodes as of when it STARTED. Anything written DURING the sweep got
 * an updatedAt BETWEEN sweep-start and sweep-finish, and the finish-stamped
 * cursor made every future incremental run filter to `updatedAt > finish` —
 * permanently skipping those nodes.
 *
 * Fix: ingestion.ts captures `sweepStartedAt` BEFORE the sweep begins reading
 * and threads it into writeCursor's new `stampedAt` param, so the persisted
 * cursor is <= the sweep's own start time.
 *
 * This test drives the REAL code path — readCursor/writeCursor from
 * engines/reconnectCursor.ts feeding `since` into the real reconnectGraph
 * incremental cutoff (engines/reconnect.ts `t > cutoffMs`) — with a
 * cursor-paginated fake graph and a spy verbatim, per nw4a conventions.
 *
 * Run: npx tsx test/reconnect-cursor-stamp-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { reconnectGraph, type ReconnectableGraph } from '../packages/lore/src/engines/reconnect.js';
import { readCursor, writeCursor } from '../packages/lore/src/engines/reconnectCursor.js';
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { BulkListQuery, BulkListPage } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const stats = { candidatesScanned: 0, embeddingsAdded: 0, embeddingsSkipped: 0, coreEdgesInserted: 0 };

// Fixed timeline: sweep starts at T0, a node is written mid-sweep at T1,
// the sweep finishes at T2. The mid-sweep node is the one the bug lost.
const T0_SWEEP_START = '2026-08-17T10:00:00.000Z';
const T1_MID_SWEEP_WRITE = '2026-08-17T10:00:30.000Z';
const T2_SWEEP_FINISH = '2026-08-17T10:01:00.000Z';

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

function makeNode(id: string, updatedAt: string): FakeNode {
    return {
        id, type: 'lore', label: `node ${id}`, content: `content of ${id}`,
        tags: 'a', project: 'p', ecosystem: 'e', updatedAt, security_scopes: [],
    };
}

/** Cursor-paginated fake graph (same shape as nw4a-reconnect-streaming). */
function makeFakeGraph(nodes: FakeNode[]) {
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
            const hasMore = start + q.limit < sorted.length;
            const last = slice[slice.length - 1];
            return {
                nodes: slice as unknown as Array<Record<string, unknown>>,
                hasMore,
                nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
            };
        },
        async listNodes(): Promise<unknown[]> { return nodes as unknown[]; },
        async addEdge() { /* dryRun — unused */ },
        async pruneInferredLoreEdges() { return 0; },
    };
    // Structural fake: implements the bulkList paging surface reconnect needs.
    return graph as unknown as ReconnectableGraph;
}

/** Spy verbatim: records which node ids reached the embed stage. */
function makeSpyVerbatim() {
    const embedded: string[] = [];
    const store = {
        async initialize() { /* no-op */ },
        async getContentHashesByIds(_ids: string[]) { return new Map<string, string>(); },
        async storeBatch(docs: Array<{ id: string }>) {
            for (const d of docs) embedded.push(d.id);
        },
        async search(_text: string, _limit: number, _filter?: { ecosystem: string }) {
            return [] as Array<{ id: string; score?: number }>;
        },
    };
    // Structural fake: reconnect only touches initialize / hash lookup /
    // storeBatch / search on this path.
    return { verbatim: store as unknown as VerbatimStore, embedded };
}

/** Run the real incremental cutoff against one node, given a cursor value. */
async function incrementalScan(root: string, nodeUpdatedAt: string): Promise<{ scanned: number; embedded: string[] }> {
    const cursor = readCursor(root);
    assert.ok(cursor, 'cursor must exist');
    const node = makeNode('n-mid', nodeUpdatedAt);
    const { verbatim, embedded } = makeSpyVerbatim();
    const r = await reconnectGraph(makeFakeGraph([node]), verbatim, {
        k: 2, minSim: 0.9, dryRun: true, since: cursor.lastReconnectAt,
    });
    return { scanned: r.candidatesScanned, embedded };
}

(async () => {
console.log('reconnect cursor — stamp is sweep-start, not sweep-finish');

await test('writeCursor persists the caller-supplied sweep-start stamp verbatim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cursor-stamp-'));
    try {
        writeCursor(root, 'incremental', stats, T0_SWEEP_START);
        const cursor = readCursor(root);
        assert.equal(cursor?.lastReconnectAt, T0_SWEEP_START);
        assert.ok(
            Date.parse(cursor!.lastReconnectAt) <= Date.parse(T0_SWEEP_START),
            'cursor value must be <= sweep start',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('back-compat: omitting stampedAt still stamps an ISO ~now string (same field/type)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cursor-stamp-'));
    try {
        const before = Date.now();
        writeCursor(root, 'full', stats);
        const after = Date.now();
        const cursor = readCursor(root);
        assert.equal(cursor?.version, 1);
        assert.equal(cursor?.lastReconnectMode, 'full');
        assert.equal(typeof cursor?.lastReconnectAt, 'string');
        const stamped = Date.parse(cursor!.lastReconnectAt);
        assert.ok(Number.isFinite(stamped), 'lastReconnectAt must remain a parseable ISO timestamp');
        assert.ok(stamped >= before && stamped <= after, 'default stamp is wall-clock now');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('fixed: node written DURING the sweep is re-examined by the next incremental run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cursor-stamp-'));
    try {
        // The fixed ingestion route writes the sweep-START stamp.
        writeCursor(root, 'full', stats, T0_SWEEP_START);
        // T1 (mid-sweep write) > T0 (cursor) ⇒ the real cutoff must keep it.
        const r = await incrementalScan(root, T1_MID_SWEEP_WRITE);
        assert.equal(r.scanned, 1, 'mid-sweep node must NOT be excluded by the sweep-start cursor');
        assert.deepEqual(r.embedded, ['lore:n-mid'], 'node must reach the embed stage');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('contrast: a finish-time stamp (the old bug) DOES skip the mid-sweep node', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cursor-stamp-'));
    try {
        // What the old code persisted: completion-time 'now' == T2.
        writeCursor(root, 'full', stats, T2_SWEEP_FINISH);
        // T1 < T2 ⇒ the same real cutoff drops the node — demonstrating why
        // stamping at finish permanently loses mid-sweep writes.
        const r = await incrementalScan(root, T1_MID_SWEEP_WRITE);
        assert.equal(r.scanned, 0, 'finish-time cursor wrongly excludes the mid-sweep node');
        assert.deepEqual(r.embedded, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('cursor stamped at sweep start does not regress older unchanged nodes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cursor-stamp-'));
    try {
        writeCursor(root, 'incremental', stats, T0_SWEEP_START);
        // A node untouched since long before the sweep stays skipped — the
        // incremental fast path still works.
        const r = await incrementalScan(root, '2026-08-10T00:00:00.000Z');
        assert.equal(r.scanned, 0);
        assert.deepEqual(r.embedded, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
