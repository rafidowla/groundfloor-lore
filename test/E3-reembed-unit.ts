#!/usr/bin/env tsx
/**
 * test/E3-reembed-unit.ts — Sprint E3 unit suite.
 *
 * Pins the two pieces E3 ships:
 *
 *   A. Replicator consolidation — adjacent embed.batch outbox rows
 *      merge into ONE BatchedEmbedder.embedBatch call (1 dispatch per
 *      run; rows mark replicated together; texts arrive in original
 *      sequenceId order). EMBED_BATCH_CONSOLIDATION_CAP bounds the
 *      merged texts.length.
 *
 *   B. Re-embed job — runReEmbedJob enqueues embed.batch outbox rows
 *      from a workspace's existing nodes. Resumable (dry-run path
 *      enqueues nothing; non-dry-run is idempotent via vector upsert
 *      semantics). Workspace required (Sprint L invariant).
 *
 * The tests drive the replicator + runReEmbedJob directly with
 * recording fakes — no live daemon, no real model calls.
 */

import assert from 'node:assert/strict';

import { OutboxReplicator, EMBED_BATCH_CONSOLIDATION_CAP }
    from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type {
    OutboxEntry,
    OutboxReplicationState,
    OutboxStatus,
    OutboxStore,
} from '../packages/lore/src/outbox/types.js';
import { runReEmbedJob } from '../packages/lore/src/embed/reEmbedJob.js';
import type { GraphProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function it(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
}

console.log('Sprint E3 — replicator consolidation + re-embed job');

/* ============================================================
 * Recording fakes
 * ============================================================ */

interface FakeStore extends Partial<OutboxStore> {
    entries: OutboxEntry[];
    statusEvents: Array<{ id: string; status: OutboxStatus }>;
}

function makeFakeStore(initial: OutboxEntry[] = []): FakeStore {
    const entries: OutboxEntry[] = [...initial];
    const statusEvents: Array<{ id: string; status: OutboxStatus }> = [];
    const replState = new Map<string, OutboxReplicationState>();
    const store: FakeStore = {
        entries,
        statusEvents,
        async record(e: OutboxEntry) { entries.push(e); },
        async batchRecord(es: OutboxEntry[]) { for (const e of es) entries.push(e); },
        async markStep() { /* unused */ },
        async markCompleted() { /* unused */ },
        async remove() { /* unused */ },
        async listUnfinished() { return entries.filter((e) => !e.completed); },
        async listWorkspacesWithPending() {
            const out = new Set<string>();
            for (const e of entries) {
                if ((e.status === 'pending' || e.status === 'failed') && e.workspace) {
                    out.add(e.workspace);
                }
            }
            return [...out];
        },
        async listPendingForWorkspace(workspace: string, limit: number) {
            return entries
                .filter((e) => e.workspace === workspace && (e.status === 'pending' || e.status === 'failed'))
                .sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0))
                .slice(0, limit);
        },
        async markEntryStatus(entryId: string, status: OutboxStatus) {
            statusEvents.push({ id: entryId, status });
            const row = entries.find((e) => e.id === entryId);
            if (row) row.status = status;
        },
        async readReplicationState(workspace: string) {
            return replState.get(workspace) ?? { lastReplicatedSeq: 0, updatedAt: new Date().toISOString() };
        },
        async writeReplicationState(workspace: string, state: OutboxReplicationState) {
            replState.set(workspace, state);
        },
    };
    return store;
}

function embedBatchEntry(
    id: string,
    workspace: string,
    sequenceId: number,
    texts: string[],
    targetNodeIds: string[],
): OutboxEntry {
    return {
        id,
        operation: 'embed.batch',
        initiator: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [{ kind: 'embed.batch', status: 'done' }],
        completed: false,
        workspace,
        sequenceId,
        operationKind: 'embed.batch',
        payload: { texts, targetNodeIds },
        status: 'pending',
        attempts: 0,
    };
}

function makeSubstrates(): {
    substrates: DispatcherSubstrates;
    embedCalls: Array<{ count: number }>;
    storeCalls: Array<{ ids: string[]; vectors: number }>;
} {
    const embedCalls: Array<{ count: number }> = [];
    const storeCalls: Array<{ ids: string[]; vectors: number }> = [];
    const fakeEmbedder = {
        async embedBatch(texts: string[]) {
            embedCalls.push({ count: texts.length });
            return texts.map(() => [0.1, 0.2, 0.3]);
        },
        maxBatchSize() { return 256; },
        dimension: 3,
        modelId: 'fake',
    };
    const substrates: DispatcherSubstrates = {
        batchedEmbedder: fakeEmbedder,
        async storeEmbedBatch(payload: { targetNodeIds: string[]; vectors: number[][] }) {
            storeCalls.push({ ids: [...payload.targetNodeIds], vectors: payload.vectors.length });
        },
    } as unknown as DispatcherSubstrates;
    return { substrates, embedCalls, storeCalls };
}

/* ============================================================
 * A. Consolidation
 * ============================================================ */

it('A1 — ticker consolidates 5 adjacent embed.batch rows into ONE model call', async () => {
    const rows: OutboxEntry[] = [];
    for (let i = 0; i < 5; i++) {
        const texts = Array.from({ length: 50 }, (_, j) => `t${i}-${j}`);
        const ids = Array.from({ length: 50 }, (_, j) => `lore:n${i}-${j}`);
        rows.push(embedBatchEntry(`e${i}`, 'wsA', i + 1, texts, ids));
    }
    const store = makeFakeStore(rows);
    const { substrates, embedCalls, storeCalls } = makeSubstrates();
    const replicator = new OutboxReplicator({
        store: store as OutboxStore,
        substrates,
        log: () => undefined,
    });
    const processed = await replicator.tickOnce();
    assert.equal(processed, 5, `expected 5 entries processed, got ${processed}`);
    assert.equal(embedCalls.length, 1, `expected 1 consolidated embedBatch call, got ${embedCalls.length}`);
    assert.equal(embedCalls[0].count, 250, `expected 250 merged texts, got ${embedCalls[0].count}`);
    assert.equal(storeCalls.length, 1, 'expected 1 storeEmbedBatch round-trip');
    assert.equal(storeCalls[0].ids.length, 250);
    // All five rows should be marked replicated.
    const replicated = store.statusEvents.filter((s) => s.status === 'replicated');
    assert.equal(replicated.length, 5, `expected 5 rows marked replicated, got ${replicated.length}`);
});

it('A2 — consolidation respects EMBED_BATCH_CONSOLIDATION_CAP', async () => {
    // Eight rows × 200 texts each = 1600 candidate texts. With cap=1024,
    // the first run stops before exceeding (5 rows × 200 = 1000 fits;
    // 6th row would push to 1200 > 1024 so it starts a second run).
    assert.ok(EMBED_BATCH_CONSOLIDATION_CAP >= 1024, 'cap regression guard');
    const rows: OutboxEntry[] = [];
    for (let i = 0; i < 8; i++) {
        const texts = Array.from({ length: 200 }, (_, j) => `t${i}-${j}`);
        const ids = Array.from({ length: 200 }, (_, j) => `lore:n${i}-${j}`);
        rows.push(embedBatchEntry(`e${i}`, 'wsB', i + 1, texts, ids));
    }
    const store = makeFakeStore(rows);
    const { substrates, embedCalls } = makeSubstrates();
    const replicator = new OutboxReplicator({
        store: store as OutboxStore,
        substrates,
        log: () => undefined,
    });
    await replicator.tickOnce();
    // Two consolidated runs expected: first absorbs 5 rows (1000 texts),
    // second absorbs remaining 3 (600 texts). Both well under cap.
    assert.equal(embedCalls.length, 2,
        `expected 2 consolidated runs given the 1024-text cap, got ${embedCalls.length} (${embedCalls.map((c) => c.count).join(',')})`);
    const total = embedCalls.reduce((s, c) => s + c.count, 0);
    assert.equal(total, 1600, 'every text accounted for across the two runs');
    for (const c of embedCalls) {
        assert.ok(c.count <= EMBED_BATCH_CONSOLIDATION_CAP,
            `run of ${c.count} exceeds cap ${EMBED_BATCH_CONSOLIDATION_CAP}`);
    }
});

it('A3 — non-embed entries between embed.batch rows break the run (preserves O ordering)', async () => {
    const rows: OutboxEntry[] = [
        embedBatchEntry('e1', 'wsC', 1, ['a'], ['lore:a']),
        embedBatchEntry('e2', 'wsC', 2, ['b'], ['lore:b']),
        // node.upsert wedged between — must break the embed run even
        // though both halves are embed.batch.
        {
            id: 'n1', operation: 'node.upsert', initiator: 't',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            steps: [], completed: false, workspace: 'wsC', sequenceId: 3,
            operationKind: 'node.upsert', payload: { node: { id: 'x', type: 't', label: 'x' } },
            status: 'pending', attempts: 0,
        },
        embedBatchEntry('e3', 'wsC', 4, ['c'], ['lore:c']),
    ];
    const store = makeFakeStore(rows);
    const { substrates, embedCalls } = makeSubstrates();
    // node.upsert will fail dispatch (no upsertNode substrate). That's
    // fine — we only assert the embed runs split correctly.
    const replicator = new OutboxReplicator({
        store: store as OutboxStore,
        substrates,
        log: () => undefined,
    });
    await replicator.tickOnce();
    // Two embed runs: {e1,e2} merged → 2 texts; {e3} alone → 1 text.
    // The first call has 2 texts, the third call (after the failing
    // node.upsert) has 1 text. The order of embedCalls is [2, 1].
    assert.equal(embedCalls.length, 2,
        `expected 2 embed calls split by the node.upsert wedge, got ${embedCalls.length}`);
    assert.equal(embedCalls[0].count, 2);
    assert.equal(embedCalls[1].count, 1);
});

/* ============================================================
 * B. Re-embed job
 * ============================================================ */

function makeFakeGraph(nodes: Array<{ id: string; type?: string; label: string; content?: string; tags?: string }>) {
    return {
        async initialize() { /* no-op */ },
        async listNodes(type?: string, tag?: string) {
            return nodes
                .filter((n) => !type || n.type === type)
                .filter((n) => !tag || (n.tags ?? '').toLowerCase().includes(tag.toLowerCase()));
        },
        async close() { /* no-op */ },
    } as unknown as GraphProvider;
}

it('B1 — re-embed enqueues ceil(N/chunkSize) embed.batch outbox rows', async () => {
    const nodes = Array.from({ length: 600 }, (_, i) => ({
        id: `n${i}`, type: 'decision', label: `Node ${i}`, content: `body ${i}`, tags: 'x',
    }));
    const store = makeFakeStore();
    const result = await runReEmbedJob({
        workspace: 'wsR',
        graph: makeFakeGraph(nodes),
        outboxStore: store as OutboxStore,
        chunkSize: 256,
    });
    assert.equal(result.candidates, 600);
    assert.equal(result.rowsPlanned, 3, 'ceil(600/256) = 3');
    assert.equal(result.rowsEnqueued, 3);
    assert.equal(store.entries.length, 3);
    for (const e of store.entries) {
        assert.equal(e.operationKind, 'embed.batch');
        assert.equal(e.workspace, 'wsR');
        const p = e.payload as { texts: string[]; targetNodeIds: string[] };
        assert.ok(Array.isArray(p.texts) && Array.isArray(p.targetNodeIds));
        assert.equal(p.texts.length, p.targetNodeIds.length);
    }
});

it('B2 — --dry-run never enqueues', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
        id: `n${i}`, type: 'decision', label: `Node ${i}`,
    }));
    const store = makeFakeStore();
    const result = await runReEmbedJob({
        workspace: 'wsD',
        graph: makeFakeGraph(nodes),
        outboxStore: store as OutboxStore,
        chunkSize: 4,
        dryRun: true,
    });
    assert.equal(result.candidates, 10);
    assert.equal(result.rowsPlanned, 3, 'ceil(10/4) = 3');
    assert.equal(result.rowsEnqueued, 0, 'dry-run must not enqueue');
    assert.equal(store.entries.length, 0);
});

it('B3 — --type filter narrows candidates', async () => {
    const nodes = [
        { id: 'a', type: 'decision', label: 'A' },
        { id: 'b', type: 'note', label: 'B' },
        { id: 'c', type: 'decision', label: 'C' },
    ];
    const store = makeFakeStore();
    const result = await runReEmbedJob({
        workspace: 'wsT',
        graph: makeFakeGraph(nodes),
        outboxStore: store as OutboxStore,
        type: 'decision',
        chunkSize: 256,
    });
    assert.equal(result.candidates, 2);
    assert.equal(result.rowsEnqueued, 1);
});

it('B4 — workspace required (Sprint L invariant)', async () => {
    const store = makeFakeStore();
    await assert.rejects(
        () => runReEmbedJob({
            workspace: '',
            graph: makeFakeGraph([]),
            outboxStore: store as OutboxStore,
        }),
        /workspace is required/,
    );
});

it('B5 — outbox preserved: enqueued rows have correct shape for replicator drain', async () => {
    // End-to-end smoke: re-embed enqueues rows, then the replicator
    // drains them through the consolidating tick into ONE model call.
    const nodes = Array.from({ length: 100 }, (_, i) => ({
        id: `n${i}`, type: 'decision', label: `Node ${i}`,
    }));
    const store = makeFakeStore();
    await runReEmbedJob({
        workspace: 'wsE2E',
        graph: makeFakeGraph(nodes),
        outboxStore: store as OutboxStore,
        chunkSize: 25, // 4 rows
    });
    // Fix up sequenceIds since FakeStore.record doesn't allocate them.
    let seq = 1;
    for (const e of store.entries) e.sequenceId = seq++;
    const { substrates, embedCalls } = makeSubstrates();
    const replicator = new OutboxReplicator({
        store: store as OutboxStore,
        substrates,
        log: () => undefined,
    });
    const processed = await replicator.tickOnce();
    assert.equal(processed, 4);
    assert.equal(embedCalls.length, 1, 'all four rows consolidated into one model call');
    assert.equal(embedCalls[0].count, 100);
});

it('B6 — re-embed is resumable: re-running enqueues same payload (idempotent via upsert)', async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({
        id: `n${i}`, type: 'decision', label: `Node ${i}`,
    }));
    const store = makeFakeStore();
    const a = await runReEmbedJob({
        workspace: 'wsIdem',
        graph: makeFakeGraph(nodes),
        outboxStore: store as OutboxStore,
        chunkSize: 50,
    });
    const b = await runReEmbedJob({
        workspace: 'wsIdem',
        graph: makeFakeGraph(nodes),
        outboxStore: store as OutboxStore,
        chunkSize: 50,
    });
    assert.equal(a.rowsEnqueued, 1);
    assert.equal(b.rowsEnqueued, 1);
    assert.equal(store.entries.length, 2, 'both runs enqueue — vector upsert handles duplicate ids');
    const idsA = (store.entries[0].payload as { targetNodeIds: string[] }).targetNodeIds.sort();
    const idsB = (store.entries[1].payload as { targetNodeIds: string[] }).targetNodeIds.sort();
    assert.deepEqual(idsA, idsB, 'same node ids on both runs');
});

/* ============================================================
 * Runner
 * ============================================================ */

await Promise.all(pending);
console.log('');
console.log(`E3 unit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
