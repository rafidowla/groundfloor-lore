#!/usr/bin/env tsx
/**
 * nw1b-pull-cursor-clobber-unit.ts — NW-1b regression test.
 *
 * Bug (corr-push-clobbers-pull-cursor): `sync()` ran push then pull sharing
 * one timestamp marker (`.last-sync`). `pushPendingInner()` stamped
 * `new Date().toISOString()` on push success; the very next `pullRemote()`
 * then read that same marker as `since`. Any remote record updated AFTER
 * the previous sync but BEFORE this push completed had `updated_at < since`
 * and was therefore silently dropped from this pull AND every future pull
 * (cursors only move forward) — silent data loss of teammate changes.
 *
 * Fix (NW-1b): separate the cursors. `.last-sync.push` advances on push
 * acks; `.last-sync.pull` advances on pull acks. Push must NEVER write
 * the pull cursor.
 *
 * Adversarial scenario (the canonical timeline):
 *
 *   t0  — initial state, no cursor.
 *   t1  — pull #1 runs. Adapter returns [].
 *         Pull cursor is stamped t1.
 *   t2  — TEAMMATE updates remote node `n-remote`. updated_at = t2.
 *         (Locally we don't see this yet.)
 *   t3  — local write injected (WAL).
 *   t4  — push runs. Adapter ack ok. Push cursor is stamped t4 (> t2).
 *   t5  — pull #2 runs. The adapter MUST receive a `since` <= t1
 *         (the pull cursor), so the t2 remote update is included.
 *         If the push clobbered the pull cursor, the adapter receives
 *         `since` = t4 and the t2 record is silently skipped.
 *
 * Fails on base (whole-sync `.last-sync` clobber); passes on branch
 * (independent `.last-sync.pull`).
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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nw1b-cursor-'));
}

/**
 * Minimal local-graph stub. SyncEngine.pullRemote duck-types getNode/
 * upsertNode/addEdge. Returns null for getNode so every pulled node is a
 * fresh insert (not a conflict) — that path is enough to drive the cursor.
 */
function makeNoopGraph() {
    const store = new Map<string, LoreNode>();
    return {
        async getNode(id: string): Promise<LoreNode | null> { return store.get(id) ?? null; },
        async upsertNode(n: LoreNode): Promise<void> { store.set(n.id, n); },
        async addEdge(_e: LoreEdge): Promise<void> { /* no-op */ },
        // No markSynced — that's a LocalGraph-only path (see pushPendingInner).
    };
}

/**
 * Programmable adapter. `pullSinceArgs` records every `since` it has been
 * asked for; tests assert on those captured values.
 */
interface ProgAdapter extends SyncAdapter {
    pullSinceArgs: string[];
    nextPullResult: { nodes: LoreNode[]; edges: LoreEdge[] };
}

function makeAdapter(): ProgAdapter {
    const a: ProgAdapter = {
        pullSinceArgs: [],
        nextPullResult: { nodes: [], edges: [] },
        async push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult> {
            return { nodesPushed: nodes.length, edgesPushed: edges.length, failures: 0, errors: [] };
        },
        async pushDeletes(ids: string[]): Promise<SyncResult> {
            return { nodesPushed: ids.length, edgesPushed: 0, failures: 0, errors: [] };
        },
        async pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }> {
            a.pullSinceArgs.push(since);
            return a.nextPullResult;
        },
        async isConnected(): Promise<boolean> { return true; },
        async connect(): Promise<void> { /* no-op */ },
        async disconnect(): Promise<void> { /* no-op */ },
    };
    return a;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

(async () => {
    console.log('NW-1b · push must not clobber the pull cursor');

    // ── core regression: push between two pulls must NOT advance the
    // pull cursor; the 2nd pull's `since` must be the 1st pull's
    // post-pull timestamp, not the (later) post-push timestamp. ──
    await test('push between two pulls does not clobber the pull cursor', async () => {
        const dir = tmpLoreDir();
        const graph = makeNoopGraph();
        const adapter = makeAdapter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);

        // ── pull #1 — remote returns ONE node so the pull cursor advances
        //     to an OBSERVED record timestamp. (TW-4b: an empty pull cycle
        //     no longer wall-clock-stamps the cursor — the only legitimate
        //     advance is to a real record's updatedAt. This regression is
        //     about push-vs-pull cursor separation, so we drive a real
        //     advance here rather than relying on the old wall-clock stamp.) ──
        const remoteTs = '2026-04-15T00:00:00.000Z';
        adapter.nextPullResult = { nodes: [{ id: 'n-remote-1', updatedAt: remoteTs } as LoreNode], edges: [] };
        await engine.pullRemote();
        assert.equal(adapter.pullSinceArgs.length, 1, 'pull #1 happened');
        assert.equal(adapter.pullSinceArgs[0], EPOCH, 'pull #1 sees epoch (no prior pull)');

        const pullCursorAfterFirstPull = fs.readFileSync(path.join(dir, '.last-sync.pull'), 'utf-8').trim();
        assert.ok(pullCursorAfterFirstPull && pullCursorAfterFirstPull !== EPOCH, 'pull cursor advanced');
        assert.equal(pullCursorAfterFirstPull, remoteTs,
            'pull cursor advances to the observed record timestamp, not wall-clock');

        // Force a perceptible wall-clock gap so the post-push timestamp
        // is strictly greater than the post-pull timestamp. Without
        // this, fast machines can produce identical ISO strings and the
        // bug becomes invisible by accident.
        await new Promise(r => setTimeout(r, 25));

        // ── push: WAL one local write, run push. On BASE this clobbers
        //     `.last-sync` with `new Date().toISOString()`. On BRANCH
        //     it writes only `.last-sync.push`. ──
        const wal = engine.getWal();
        wal.append('upsert_node', { id: 'local-only', updatedAt: new Date().toISOString() });
        const pr = await engine.pushPending();
        assert.equal(pr.failures, 0, 'push must succeed');

        const pushCursorAfterPush = fs.readFileSync(path.join(dir, '.last-sync.push'), 'utf-8').trim();
        assert.ok(pushCursorAfterPush > pullCursorAfterFirstPull,
            `push cursor (${pushCursorAfterPush}) must be > pull cursor (${pullCursorAfterFirstPull})`);

        // The pull cursor on disk must NOT have been written by push.
        const pullCursorAfterPush = fs.readFileSync(path.join(dir, '.last-sync.pull'), 'utf-8').trim();
        assert.equal(
            pullCursorAfterPush, pullCursorAfterFirstPull,
            `push must NOT touch .last-sync.pull (was ${pullCursorAfterFirstPull}, now ${pullCursorAfterPush})`,
        );

        // ── pull #2 — adapter MUST receive the pull-cursor `since`, not
        //     the post-push timestamp. This is the behavioural assertion
        //     that fails on base: base passes `pushCursorAfterPush` here. ──
        await new Promise(r => setTimeout(r, 25));
        adapter.nextPullResult = { nodes: [], edges: [] };
        await engine.pullRemote();
        assert.equal(adapter.pullSinceArgs.length, 2, 'pull #2 happened');

        const since2 = adapter.pullSinceArgs[1];
        assert.equal(
            since2, pullCursorAfterFirstPull,
            `pull #2 must use the pull cursor (${pullCursorAfterFirstPull}), not the push cursor (${pushCursorAfterPush}) — got ${since2}`,
        );

        // And concretely: the t2-remote-update would NOT have been skipped.
        // Simulate the bug's data-loss outcome by asserting the adapter
        // would have been asked for everything-since-pull-#1, not
        // everything-since-push.
        assert.ok(since2 < pushCursorAfterPush, 'pull #2 since must be strictly < push cursor');
    });

    // ── boot migration: a legacy `.last-sync` seeds BOTH new cursors. ──
    await test('boot migration: legacy .last-sync seeds both new cursors', async () => {
        const dir = tmpLoreDir();
        const legacy = '2026-04-01T12:00:00.000Z';
        fs.writeFileSync(path.join(dir, '.last-sync'), legacy, 'utf-8');

        const graph = makeNoopGraph();
        const adapter = makeAdapter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new SyncEngine(graph as any, dir, adapter);

        const pushCursor = fs.readFileSync(path.join(dir, '.last-sync.push'), 'utf-8').trim();
        const pullCursor = fs.readFileSync(path.join(dir, '.last-sync.pull'), 'utf-8').trim();
        assert.equal(pushCursor, legacy, 'push cursor seeded from legacy file');
        assert.equal(pullCursor, legacy, 'pull cursor seeded from legacy file');

        // Spec: legacy file is retained for one release window.
        assert.ok(fs.existsSync(path.join(dir, '.last-sync')), 'legacy .last-sync retained');
    });

    // ── boot migration: existing per-direction cursors are NOT overwritten. ──
    await test('boot migration: existing per-direction cursors take precedence over legacy', async () => {
        const dir = tmpLoreDir();
        const legacy = '2026-04-01T12:00:00.000Z';
        const realPush = '2026-05-01T12:00:00.000Z';
        const realPull = '2026-05-02T12:00:00.000Z';
        fs.writeFileSync(path.join(dir, '.last-sync'), legacy, 'utf-8');
        fs.writeFileSync(path.join(dir, '.last-sync.push'), realPush, 'utf-8');
        fs.writeFileSync(path.join(dir, '.last-sync.pull'), realPull, 'utf-8');

        const graph = makeNoopGraph();
        const adapter = makeAdapter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new SyncEngine(graph as any, dir, adapter);

        assert.equal(fs.readFileSync(path.join(dir, '.last-sync.push'), 'utf-8').trim(), realPush);
        assert.equal(fs.readFileSync(path.join(dir, '.last-sync.pull'), 'utf-8').trim(), realPull);
    });

    // ── pull reads .last-sync.pull, not the legacy .last-sync, when both exist. ──
    await test('pull reads .last-sync.pull, ignoring a stale legacy .last-sync', async () => {
        const dir = tmpLoreDir();
        // Stale legacy file simulates a post-push clobber from older code.
        const stale = '2030-01-01T00:00:00.000Z';
        const realPull = '2026-05-02T12:00:00.000Z';
        fs.writeFileSync(path.join(dir, '.last-sync'), stale, 'utf-8');
        fs.writeFileSync(path.join(dir, '.last-sync.push'), stale, 'utf-8');
        fs.writeFileSync(path.join(dir, '.last-sync.pull'), realPull, 'utf-8');

        const graph = makeNoopGraph();
        const adapter = makeAdapter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        adapter.nextPullResult = { nodes: [], edges: [] };
        await engine.pullRemote();
        assert.equal(adapter.pullSinceArgs[0], realPull,
            'pull must read the per-direction cursor, not the legacy file');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
