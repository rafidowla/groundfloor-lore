#!/usr/bin/env tsx
/**
 * test/tw4a-rollback-orphan-unit.ts — TW-4a adversarial rollback test.
 *
 * Evidence: corr-rollback-defeated-by-orphan-node-upsert-row,
 *           corr-embedded-default-write-no-error-signal.
 *
 * The bug (base):
 *   In the outbox-routed write path, nodeUpsert records a `node.upsert`
 *   outbox row BEFORE the substrate write, then records a `verbatim.upsert`
 *   row. If the verbatim record FAILS, the old code deleted the graph node
 *   and returned `{ ok: false }` claiming "NO partial state" — but it left
 *   the `node.upsert` outbox row pending. A subsequent replicator tick
 *   re-applies that row (dispatcher case 'node.upsert'), recreating the
 *   graph node with NO verbatim companion: a resurrected graph-only orphan.
 *
 * The fix (branch):
 *   On verbatim-record failure nodeUpsert retracts BOTH traces — it deletes
 *   the graph node AND removes the `node.upsert` outbox row via
 *   OutboxStore.remove — so a replay can never resurrect the node.
 *
 * Strategy:
 *   Drive core/nodeService.nodeUpsert directly (no daemon) with:
 *     - a recording fake graph (tracks live node ids; upsert + delete),
 *     - a recording fake OutboxStore whose `record` THROWS for the
 *       verbatim.upsert row (injects the verbatim-record failure) and
 *       implements `remove` so the retraction is observable,
 *     - a tiny replay() that walks the outbox the way the real replicator
 *       does for `node.upsert` entries and re-applies them to the graph.
 *
 *   Assertions (this is the fails-on-base / passes-on-branch invariant):
 *     A1  nodeUpsert reports failure (no success-shaped result).
 *     A2  the graph node does NOT exist after the failed write.
 *     A3  there is NO pending `node.upsert` outbox row for that id.
 *     A4  draining the replicator does NOT resurrect the node (the orphan
 *         test): on base, the leftover node.upsert row replays and the
 *         node reappears → A4 (and A3) fail.
 */

import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { NodeWriteGraph } from '../packages/lore/src/core/nodeService.js';
import type { OutboxStore, OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('TW-4a rollback orphan — verbatim failure must retract the node.upsert outbox row');

/* ---------- recording fake graph ---------- */

function makeFakeGraph() {
    // Live graph rows keyed by id. upsertNode adds, deleteNode removes.
    const live = new Map<string, Record<string, unknown>>();
    const graph: NodeWriteGraph = {
        async upsertNode(node: Record<string, unknown>) {
            const id = String(node.id);
            const stored = {
                ...node,
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                updatedAt: '2026-06-15T00:00:00.000Z',
            } as Record<string, unknown>;
            live.set(id, stored);
            // Shape mirrors LoreNode enough for nodeService's metadata reads.
            return stored as never;
        },
        async deleteNode(id: string) {
            live.delete(id);
            return undefined;
        },
    };
    return { graph, live };
}

/* ---------- recording fake OutboxStore that fails on verbatim.upsert ---------- */

function makeFailingOutboxStore() {
    const entries: OutboxEntry[] = [];
    let removed = 0;
    const store: OutboxStore = {
        async record(entry: OutboxEntry) {
            // Inject the verbatim-record failure: the verbatim.upsert append
            // throws, exactly as a LanceDB/outbox fault would at runtime.
            if (entry.operationKind === 'verbatim.upsert') {
                throw new Error('injected verbatim.upsert outbox record failure');
            }
            entries.push(entry);
        },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove(entryId: string) {
            const i = entries.findIndex((e) => e.id === entryId);
            if (i >= 0) { entries.splice(i, 1); removed++; }
        },
        async listUnfinished() { return entries.slice(); },
    };
    return { store, entries, removedCount: () => removed };
}

/** Pending node.upsert entries for `id` still sitting in the outbox. */
function pendingNodeUpserts(entries: OutboxEntry[], id: string): OutboxEntry[] {
    return entries.filter(
        (e) => e.operationKind === 'node.upsert' && (e.payload as { id?: string } | undefined)?.id === id,
    );
}

/**
 * Minimal stand-in for the replicator's node.upsert dispatch: walk the
 * outbox and re-apply every pending node.upsert to the graph. This is what
 * resurrects the orphan on base — if the rollback left the row behind.
 */
async function drainReplicator(entries: OutboxEntry[], graph: NodeWriteGraph): Promise<void> {
    for (const e of entries) {
        if (e.operationKind === 'node.upsert' && e.payload) {
            await graph.upsertNode(e.payload as Record<string, unknown>);
        }
    }
}

/* ---------- the adversarial test ---------- */

test('verbatim outbox failure → graph node deleted, node.upsert row retracted, no resurrection', async () => {
    const id = 'tw4a-orphan-1';
    const { graph, live } = makeFakeGraph();
    const { store, entries } = makeFailingOutboxStore();

    const nodeData: Record<string, unknown> = {
        id,
        type: 'decision',
        label: 'TW-4a orphan fixture',
        content: 'verbatim record will be injected to fail',
        tags: 'tw4a',
        project: 'tw4a-fixture',
        ecosystem: '*',
    };

    let result: Awaited<ReturnType<typeof nodeUpsert>> | undefined;
    let threw: Error | null = null;
    try {
        result = await nodeUpsert(
            {
                id,
                workspace: 'tw4a-fixture',
                ecosystem: '*',
                nodeData,
                targetGraph: graph,
                initiator: 'test:tw4a',
            },
            { outboxStore: store },
        );
    } catch (err) {
        // Acceptable: an incomplete rollback surfaces as a throw. Here the
        // rollback DOES succeed, so we expect a clean {ok:false} instead.
        threw = err as Error;
    }

    // A1 — the write must NOT report success.
    assert.ok(!threw, `rollback should complete cleanly here, not throw: ${threw?.message}`);
    assert.ok(result && result.ok === false, 'nodeUpsert must return a failure result, not a success-shaped one');

    // A2 — the graph node must not exist after the failed write.
    assert.equal(live.has(id), false, 'graph node must be deleted by rollback');

    // A3 — NO pending node.upsert outbox row for this id (the TW-4a fix).
    assert.equal(
        pendingNodeUpserts(entries, id).length,
        0,
        `node.upsert outbox row must be retracted on verbatim failure; found ${pendingNodeUpserts(entries, id).length} pending`,
    );

    // A4 — draining the replicator must NOT resurrect the node. On base the
    // leftover node.upsert row replays here and the orphan reappears.
    await drainReplicator(entries, graph);
    assert.equal(
        live.has(id),
        false,
        'replicator drain resurrected a graph-only orphan — the node.upsert outbox row was not retracted',
    );
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
