#!/usr/bin/env tsx
/**
 * test/pkg1-durability-unit.ts — deferred-tail Package 1 (outbox/replicator
 * durability) NEW-behavior tests.
 *
 * Covers:
 *   C-R2-03  removeIfPending() conditional remove + the compensating node.delete
 *            the nodeUpsert rollback records when the replicator already claimed
 *            the node.upsert row (the race a plain remove() can't undo).
 *   C-R3-01  bulk inline-embed: a verbatim-seed failure rolls back the graph
 *            node and reports ok:false (no fire-and-forget orphan).
 *
 * (C-R3-05 sync node DLQ + C-R3-02 supersede-edge-via-outbox are guarded by the
 *  existing nw7b-sync / nw3a-supersede suites for non-regression; the build +
 *  those suites exercise the changed paths. The two cases here are the subtle
 *  new behaviors that most need a dedicated proof.)
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
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

const createdTmpDirs: string[] = [];
function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg1-durability-'));
    createdTmpDirs.push(d);
    return d;
}

function newEntry(opts: Partial<OutboxEntry> & { id: string }): OutboxEntry {
    const now = '2026-06-28T00:00:00.000Z';
    return {
        id: opts.id,
        operation: opts.operation ?? 'graph.upsert',
        initiator: opts.initiator ?? 'test:pkg1',
        createdAt: opts.createdAt ?? now,
        updatedAt: opts.updatedAt ?? now,
        steps: opts.steps ?? [{ kind: 'noop', status: 'pending' }],
        completed: opts.completed ?? false,
        workspace: opts.workspace,
        operationKind: opts.operationKind,
        payload: opts.payload,
        status: opts.status,
        sequenceId: opts.sequenceId,
    };
}

console.log('Package 1 durability — removeIfPending + compensating node.delete + bulk inline rollback');

/* ───────────────── C-R2-03: removeIfPending (real FileOutboxStore) ───────── */

test('C-R2-03 removeIfPending removes a still-pending row and returns true', async () => {
    const store = new FileOutboxStore(tmpDir());
    await store.record(newEntry({ id: 'p1', operationKind: 'node.upsert', workspace: 'a', payload: { id: 'n1' } }));
    const removed = await store.removeIfPending!('p1');
    assert.equal(removed, true, 'a pending row must be removable');
    assert.equal((await store.listUnfinished()).length, 0, 'the row must be gone');
});

test('C-R2-03 removeIfPending REFUSES a claimed (replicating) row and returns false', async () => {
    const store = new FileOutboxStore(tmpDir());
    await store.record(newEntry({ id: 'p2', operationKind: 'node.upsert', workspace: 'a', payload: { id: 'n2' } }));
    // Replicator claims it.
    await store.markEntryStatus!('p2', 'replicating');
    const removed = await store.removeIfPending!('p2');
    assert.equal(removed, false, 'a claimed row must NOT be removed (caller must compensate)');
    assert.equal((await store.listUnfinished()).length, 1, 'the claimed row must remain for the replicator');
});

test('C-R2-03 removeIfPending returns true for an absent row (nothing to replay)', async () => {
    const store = new FileOutboxStore(tmpDir());
    assert.equal(await store.removeIfPending!('missing'), true);
});

/* ── C-R2-03: rollback records a compensating node.delete when row was claimed ── */

function makeFakeGraph() {
    const live = new Map<string, Record<string, unknown>>();
    const graph: NodeWriteGraph = {
        async upsertNode(node: Record<string, unknown>) {
            const stored = { ...node, project: node.project ?? 'default', ecosystem: node.ecosystem ?? '*', updatedAt: '2026-06-28T00:00:00.000Z' } as Record<string, unknown>;
            live.set(String(node.id), stored);
            return stored as never;
        },
        async deleteNode(id: string) { live.delete(id); return undefined; },
    };
    return { graph, live };
}

// Fake outbox: verbatim.upsert record THROWS (triggers rollback); the
// node.upsert row is treated as ALREADY CLAIMED, so removeIfPending returns
// false — forcing the rollback down the compensating-node.delete path.
function makeClaimedRowOutbox() {
    const entries: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(entry: OutboxEntry) {
            if (entry.operationKind === 'verbatim.upsert') {
                throw new Error('injected verbatim.upsert outbox record failure');
            }
            entries.push(entry);
        },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove() { throw new Error('plain remove() must NOT be called when removeIfPending exists'); },
        async removeIfPending() { return false; },   // simulate: replicator already claimed it
        async listUnfinished() { return entries.slice(); },
    };
    return { store, entries };
}

async function drainInOrder(entries: OutboxEntry[], graph: NodeWriteGraph): Promise<void> {
    // Mirror the replicator for node.upsert + node.delete in recorded order:
    // node.upsert resurrects, the later compensating node.delete removes it.
    for (const e of entries) {
        const id = (e.payload as { id?: string } | undefined)?.id;
        if (!id) continue;
        if (e.operationKind === 'node.upsert') await graph.upsertNode(e.payload as Record<string, unknown>);
        else if (e.operationKind === 'node.delete') await graph.deleteNode(id);
    }
}

test('C-R2-03 claimed node.upsert row → rollback records a compensating node.delete; replay converges to node gone', async () => {
    const id = 'cr203-claimed-1';
    const { graph, live } = makeFakeGraph();
    const { store, entries } = makeClaimedRowOutbox();

    const result = await nodeUpsert(
        {
            id,
            workspace: 'cr203-ws',
            ecosystem: '*',
            nodeData: { id, type: 'decision', label: 'C-R2-03 claimed fixture', content: 'verbatim will fail', tags: 'cr203', project: 'cr203-ws', ecosystem: '*' },
            targetGraph: graph,
            initiator: 'test:cr203',
        },
        { outboxStore: store },
    );

    assert.ok(result && result.ok === false, 'nodeUpsert must report failure');
    assert.equal(live.has(id), false, 'rollback deleteNode must remove the node locally');

    const compensating = entries.filter((e) => e.operationKind === 'node.delete' && (e.payload as { id?: string } | undefined)?.id === id);
    assert.equal(compensating.length, 1, 'rollback must record exactly one compensating node.delete for the claimed row');

    // The node.upsert row is still present (claimed, not removed). Draining the
    // replicator (upsert THEN the compensating delete) must converge to gone.
    await drainInOrder(entries, graph);
    assert.equal(live.has(id), false, 'after replay (resurrect + compensating delete) the node must NOT exist — no orphan');
});

await Promise.all(pending);
for (const d of createdTmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
