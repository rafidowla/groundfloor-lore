#!/usr/bin/env tsx
/**
 * test/node-service-unit.ts — TW-7a direct unit tests for core/nodeService.ts.
 *
 * Evidence: test-nodeservice-no-unit-tests
 *
 * nodeService.nodeUpsert() is the transport-agnostic guarded write core
 * shared by MCP store_node and POST /api/node. It has four verbatim
 * fan-out branches and two error-surface fixes from TW-4a. None of these
 * branches had a direct unit test — this file covers them all.
 *
 * Branches under test:
 *   B1. skipEmbed=true  → graph-only write; no verbatim, no autolink.
 *   B2. asyncEmbed=true + embedQueue  → enqueue called; no blocking write.
 *   B3. outboxStore wired  → outbox-first ordering; verbatim.upsert recorded;
 *       on verbatim failure: graph deleted + node.upsert outbox row retracted
 *       (TW-4a rollback invariant).
 *   B4. inline verbatim (verbatim hook, no outbox)  → verbatimStore called;
 *       on failure: graph deleted; error surfaced (TW-4a error signal).
 *
 * Additional scenarios:
 *   S5. Outbox-first ordering proof: node.upsert outbox row recorded BEFORE
 *       targetGraph.upsertNode (durability-first invariant).
 *   S6. Rollback throws when deleteNode fails (incomplete rollback surfaces
 *       as throw rather than clean {ok:false}) — TW-4a error-surface fix.
 *   S7. WAL append fires for active-workspace writes when wired.
 *   S8. Version record fires (non-fatal) when wired.
 *   S9. Autolink fires for active-workspace !skipEmbed when supplied.
 *  S10. No outbox + no verbatim hook → graph-only write succeeds (the
 *       embedded default-write path — TW-4a: if no hooks, must succeed not
 *       swallow a fake failure).
 *
 * Fakes are modelled on tw4a-rollback-orphan-unit.ts and
 * test/dataplane-graph-unit.ts FakeClient patterns.
 */

import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type {
    NodeWriteGraph,
    NodeUpsertArgs,
    NodeUpsertHooks,
} from '../packages/lore/src/core/nodeService.js';
import type { OutboxStore, OutboxEntry } from '../packages/lore/src/outbox/types.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

/* ─── tiny test harness (consistent with every other test/ file) ─────── */

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void>): void {
    pending.push(
        (async () => {
            try {
                await fn();
                console.log(`  ✓ ${name}`);
                passed++;
            } catch (err) {
                console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
                failed++;
            }
        })(),
    );
}

console.log('TW-7a node-service unit — all four verbatim branches + error-surface');

/* ─── shared fakes ───────────────────────────────────────────────────── */

interface FakeGraphState {
    live: Map<string, Record<string, unknown>>;
    upsertOrder: string[];
    deleteOrder: string[];
}

function makeFakeGraph(overrides?: {
    upsertThrows?: Error;
    deleteThrows?: Error;
}): { graph: NodeWriteGraph; state: FakeGraphState } {
    const state: FakeGraphState = {
        live: new Map(),
        upsertOrder: [],
        deleteOrder: [],
    };
    const graph: NodeWriteGraph = {
        async upsertNode(node: Record<string, unknown>) {
            if (overrides?.upsertThrows) throw overrides.upsertThrows;
            const id = String(node.id);
            state.upsertOrder.push(id);
            const stored = {
                ...node,
                type: node.type ?? 'decision',
                label: node.label ?? '',
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                updatedAt: '2026-06-15T00:00:00.000Z',
            } as Record<string, unknown>;
            state.live.set(id, stored);
            return stored as never;
        },
        async deleteNode(id: string) {
            if (overrides?.deleteThrows) throw overrides.deleteThrows;
            state.deleteOrder.push(id);
            state.live.delete(id);
            return undefined;
        },
    };
    return { graph, state };
}

interface FakeOutboxState {
    entries: OutboxEntry[];
    recordOrder: string[];        // operationKind sequence
    removedIds: string[];
}

type OutboxBehaviour = 'normal' | 'fail-verbatim' | 'fail-all';

function makeFakeOutboxStore(behaviour: OutboxBehaviour = 'normal'): {
    store: OutboxStore;
    state: FakeOutboxState;
} {
    let seq = 0;
    const state: FakeOutboxState = {
        entries: [],
        recordOrder: [],
        removedIds: [],
    };
    const store: OutboxStore = {
        async record(entry: OutboxEntry) {
            if (
                behaviour === 'fail-all' ||
                (behaviour === 'fail-verbatim' &&
                    entry.operationKind === 'verbatim.upsert')
            ) {
                throw new Error(
                    `injected outbox record failure for ${entry.operationKind}`,
                );
            }
            state.recordOrder.push(entry.operationKind ?? 'unknown');
            const stored: OutboxEntry = {
                ...entry,
                id: entry.id ?? `fake-entry-${++seq}`,
                sequenceId: seq,
            };
            state.entries.push(stored);
            // OutboxStore.record returns Promise<void> — returning the entry
            // here type-checked only because test/ was outside tsconfig.
        },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove(entryId: string) {
            state.removedIds.push(entryId);
            const idx = state.entries.findIndex((e) => e.id === entryId);
            if (idx >= 0) state.entries.splice(idx, 1);
        },
        async listUnfinished() { return state.entries.slice(); },
    };
    return { store, state };
}

function makeNodeData(id: string): Record<string, unknown> {
    return {
        id,
        type: 'decision',
        label: `label for ${id}`,
        content: `content for ${id}`,
        tags: 'unit-test',
        project: 'test-workspace',
        ecosystem: '*',
    };
}

function baseArgs(id: string, targetGraph: NodeWriteGraph): NodeUpsertArgs {
    return {
        id,
        workspace: 'test-workspace',
        ecosystem: '*',
        nodeData: makeNodeData(id),
        targetGraph,
        initiator: 'test:tw7a',
    };
}

/* ─── B1: skipEmbed branch ───────────────────────────────────────────── */

test('B1 — skipEmbed=true: graph upserted, no verbatim, result ok', async () => {
    const { graph, state } = makeFakeGraph();
    const result = await nodeUpsert(
        { ...baseArgs('b1-node', graph), skipEmbed: true },
        {},
    );
    assert.ok(result.ok === true, 'expected ok=true');
    assert.ok(state.live.has('b1-node'), 'graph node must exist');
    assert.equal(state.upsertOrder.length, 1, 'exactly one graph upsert');
});

test('B1 — skipEmbed=true: embedQueue is NOT called even when supplied', async () => {
    const { graph } = makeFakeGraph();
    let enqueueCount = 0;
    const embedQueue = { enqueue: () => { enqueueCount++; } };
    const result = await nodeUpsert(
        { ...baseArgs('b1-queue', graph), skipEmbed: true, asyncEmbed: true },
        { embedQueue },
    );
    assert.ok(result.ok === true);
    assert.equal(enqueueCount, 0, 'embedQueue must not be called when skipEmbed');
});

/* ─── B2: asyncEmbed + embedQueue branch ─────────────────────────────── */

test('B2 — asyncEmbed=true + embedQueue: enqueue called with node id AND workspace (RC-round4)', async () => {
    const { graph } = makeFakeGraph();
    const enqueued: Array<{ nodeId: string; text: string; workspace?: string }> = [];
    const embedQueue = {
        enqueue(nodeId: string, text: string, workspace?: string) { enqueued.push({ nodeId, text, workspace }); },
    };
    const result = await nodeUpsert(
        { ...baseArgs('b2-node', graph), workspace: 'ws-b', asyncEmbed: true },
        { embedQueue },
    );
    assert.ok(result.ok === true, 'expected ok=true for asyncEmbed path');
    assert.equal(enqueued.length, 1, 'exactly one enqueue call');
    assert.equal(enqueued[0].nodeId, 'b2-node', 'enqueued with correct node id');
    assert.ok(enqueued[0].text.length > 0, 'enqueued text must be non-empty');
    // RC-round4 — the requested workspace MUST be threaded as the 3rd arg so
    // the EmbedQueue executor's resolveStores routes the embed to ws-b's
    // LanceDB, not the boot store. Dropping it was the round-4 embed bug.
    assert.equal(enqueued[0].workspace, 'ws-b', 'requested workspace threaded to enqueue');
});

test('B2 — outbox PRECEDES async_embed when BOTH are wired (RC-round4 durable routing)', async () => {
    // Local multi-app mode wires BOTH outboxStore and embedQueue. asyncEmbed
    // is true (nodeUpsertBatch always sets it). Pre-fix the async branch won
    // and discarded workspace; the fix reorders so the workspace-stamped,
    // durable, per-workspace-replicated outbox path wins.
    const { graph } = makeFakeGraph();
    const { store, state: outboxState } = makeFakeOutboxStore('normal');
    let enqueueCount = 0;
    const embedQueue = { enqueue() { enqueueCount++; } };
    const result = await nodeUpsert(
        { ...baseArgs('b2-both', graph), workspace: 'ws-b', asyncEmbed: true },
        { outboxStore: store, embedQueue },
    );
    assert.ok(result.ok === true, 'expected ok=true');
    assert.equal(enqueueCount, 0, 'async embedQueue must NOT be used when outbox is wired');
    assert.ok(
        outboxState.recordOrder.includes('verbatim.upsert'),
        'verbatim.upsert must be recorded via the durable outbox path',
    );
    // The verbatim outbox row must carry the requested workspace so the
    // replicator resolves ws-b's store.
    const vb = outboxState.entries.find(e => e.operationKind === 'verbatim.upsert');
    assert.ok(vb, 'verbatim.upsert outbox entry exists');
    assert.equal((vb as { workspace?: string }).workspace, 'ws-b', 'outbox row stamped with requested workspace');
});

test('B2 — asyncEmbed without embedQueue falls through to outbox/verbatim branch', async () => {
    const { graph } = makeFakeGraph();
    // asyncEmbed=true but no embedQueue supplied → falls through to outbox path
    // (no outbox either → falls through to inline verbatim → no verbatim hook →
    //  graph-only write, success).
    const result = await nodeUpsert(
        { ...baseArgs('b2-fallthrough', graph), asyncEmbed: true },
        {},
    );
    assert.ok(result.ok === true, 'fallthrough must succeed');
});

/* ─── B3: outbox-routed branch ───────────────────────────────────────── */

test('B3 — outbox-routed: node.upsert recorded before graph upsert (outbox-first)', async () => {
    const { graph, state: graphState } = makeFakeGraph();
    const { store, state: outboxState } = makeFakeOutboxStore('normal');

    // We need to verify the ordering. Record events in a shared timeline.
    const timeline: string[] = [];
    const origUpsert = graph.upsertNode.bind(graph);
    // We instrument via wrapping — safe here since it's a test.
    (graph as { upsertNode: typeof graph.upsertNode }).upsertNode = async (node) => {
        timeline.push('graph.upsert');
        return origUpsert(node);
    };
    const origRecord = store.record.bind(store);
    (store as { record: typeof store.record }).record = async (entry) => {
        timeline.push(`outbox.record:${entry.operationKind}`);
        return origRecord(entry);
    };

    const result = await nodeUpsert(baseArgs('b3-ordering', graph), { outboxStore: store });
    assert.ok(result.ok === true);

    // node.upsert outbox entry must precede the graph upsert (S5 invariant).
    const nodeUpsertIdx = timeline.indexOf('outbox.record:node.upsert');
    const graphUpsertIdx = timeline.indexOf('graph.upsert');
    assert.ok(nodeUpsertIdx >= 0, 'node.upsert outbox record must occur');
    assert.ok(graphUpsertIdx >= 0, 'graph.upsert must occur');
    assert.ok(
        nodeUpsertIdx < graphUpsertIdx,
        `node.upsert outbox row (pos ${nodeUpsertIdx}) must precede graph.upsert (pos ${graphUpsertIdx}) — outbox-first invariant`,
    );

    // verbatim.upsert must also be recorded (after graph upsert).
    const verbatimIdx = timeline.indexOf('outbox.record:verbatim.upsert');
    assert.ok(verbatimIdx > graphUpsertIdx, 'verbatim.upsert must be recorded after graph.upsert');

    void graphState; // suppress unused-var lint
    void outboxState;
});

test('B3 — outbox-routed happy path: both outbox rows written, graph node exists', async () => {
    const { graph, state: graphState } = makeFakeGraph();
    const { store, state: outboxState } = makeFakeOutboxStore('normal');
    const result = await nodeUpsert(baseArgs('b3-happy', graph), { outboxStore: store });
    assert.ok(result.ok === true);
    assert.ok(graphState.live.has('b3-happy'), 'graph node must exist');
    const kinds = outboxState.recordOrder;
    assert.ok(kinds.includes('node.upsert'), 'node.upsert outbox row must be recorded');
    assert.ok(kinds.includes('verbatim.upsert'), 'verbatim.upsert outbox row must be recorded');
});

test('B3 — TW-4a rollback: verbatim outbox failure → graph deleted + node.upsert retracted', async () => {
    const { graph, state: graphState } = makeFakeGraph();
    const { store, state: outboxState } = makeFakeOutboxStore('fail-verbatim');
    const result = await nodeUpsert(baseArgs('b3-rollback', graph), { outboxStore: store });

    // A1: write must report failure (not success-shaped).
    assert.ok(result.ok === false, 'nodeUpsert must return failure');
    assert.equal(
        result.ok === false ? result.code : undefined,
        'verbatim_unavailable',
        'failure code must be verbatim_unavailable',
    );

    // A2: graph node must be gone.
    assert.ok(
        !graphState.live.has('b3-rollback'),
        'graph node must be deleted by rollback',
    );

    // A3: no pending node.upsert outbox row (TW-4a — retraction).
    const pendingNodeUpserts = outboxState.entries.filter(
        (e) => e.operationKind === 'node.upsert',
    );
    assert.equal(
        pendingNodeUpserts.length,
        0,
        `node.upsert outbox row must be retracted after verbatim failure; found ${pendingNodeUpserts.length}`,
    );

    // A4: confirm the retracted entry id is in removedIds.
    assert.ok(outboxState.removedIds.length > 0, 'at least one outbox entry must have been removed');
});

test('B3 — TW-4a rollback: no orphan resurrection after replicator replay', async () => {
    const { graph, state: graphState } = makeFakeGraph();
    const { store, state: outboxState } = makeFakeOutboxStore('fail-verbatim');
    await nodeUpsert(baseArgs('b3-orphan', graph), { outboxStore: store });

    // Simulate the replicator replaying all remaining node.upsert outbox rows.
    for (const e of outboxState.entries) {
        if (e.operationKind === 'node.upsert' && e.payload) {
            await graph.upsertNode(e.payload as Record<string, unknown>);
        }
    }

    assert.ok(
        !graphState.live.has('b3-orphan'),
        'replicator replay must NOT resurrect the rolled-back node (orphan resurrection)',
    );
});

/* ─── B4: inline verbatim (no outbox) branch ─────────────────────────── */

test('B4 — inline verbatim: verbatimStore called with correct id shape', async () => {
    const { graph, state: graphState } = makeFakeGraph();
    const written: Array<{ id: string; text: string }> = [];
    const verbatim = {
        async verbatimStore(write: { id: string; text: string; metadata: Record<string, unknown> }) {
            written.push({ id: write.id, text: write.text });
        },
    };
    const result = await nodeUpsert(baseArgs('b4-inline', graph), { verbatim });
    assert.ok(result.ok === true, 'inline verbatim path must succeed');
    assert.ok(graphState.live.has('b4-inline'), 'graph node must exist');
    assert.equal(written.length, 1, 'exactly one verbatimStore call');
    assert.equal(written[0].id, 'lore:b4-inline', 'verbatim id must be lore:<nodeId>');
    assert.ok(written[0].text.length > 0, 'verbatim text must be non-empty');
});

test('B4 — TW-4a error surface: inline verbatim failure → graph deleted + {ok:false} returned', async () => {
    const { graph, state: graphState } = makeFakeGraph();
    const verbatim = {
        async verbatimStore() {
            throw new Error('injected verbatim store failure');
        },
    };
    const result = await nodeUpsert(baseArgs('b4-fail', graph), { verbatim });

    // TW-4a: error must be surfaced, not swallowed as success.
    assert.ok(result.ok === false, 'verbatim failure must return {ok:false}, not swallow the error');
    assert.equal(
        result.ok === false ? result.code : undefined,
        'verbatim_unavailable',
    );

    // Graph node must be deleted (rollback).
    assert.ok(
        !graphState.live.has('b4-fail'),
        'graph node must be deleted after inline verbatim failure',
    );
});

/* ─── S5: outbox-first ordering (standalone) ─────────────────────────── */

test('S5 — outbox-first: outbox.record fires BEFORE any graph write', async () => {
    const events: string[] = [];
    const id = 's5-order';

    // Graph that records when it is called.
    const graph: NodeWriteGraph = {
        async upsertNode(node: Record<string, unknown>) {
            events.push('graph.upsertNode');
            return {
                ...node,
                type: 'decision',
                label: '',
                project: 'test-workspace',
                ecosystem: '*',
                updatedAt: '2026-06-15T00:00:00.000Z',
            } as never;
        },
        async deleteNode() { return undefined; },
    };

    let seq = 0;
    const store: OutboxStore = {
        async record(entry: OutboxEntry) {
            events.push(`outbox.record:${entry.operationKind}`);
            seq++;
        },
        async markStep() {},
        async markCompleted() {},
        async remove() {},
        async listUnfinished() { return []; },
    };

    await nodeUpsert(baseArgs(id, graph), { outboxStore: store });

    const nodeUpsertIdx = events.indexOf('outbox.record:node.upsert');
    const graphIdx = events.indexOf('graph.upsertNode');
    assert.ok(nodeUpsertIdx >= 0, 'node.upsert outbox event must occur');
    assert.ok(graphIdx >= 0, 'graph.upsertNode event must occur');
    assert.ok(
        nodeUpsertIdx < graphIdx,
        `outbox.record:node.upsert (pos ${nodeUpsertIdx}) must precede graph.upsertNode (pos ${graphIdx})`,
    );
});

/* ─── S6: rollback throws when deleteNode fails (TW-4a error surface) ── */

test('S6 — rollback throws when graph deleteNode itself fails (incomplete rollback)', async () => {
    const deleteError = new Error('injected deleteNode failure');
    const { graph } = makeFakeGraph({ deleteThrows: deleteError });
    const verbatim = {
        async verbatimStore() {
            throw new Error('injected verbatim store failure');
        },
    };

    let threw: Error | null = null;
    try {
        await nodeUpsert(baseArgs('s6-incomplete', graph), { verbatim });
    } catch (err) {
        threw = err as Error;
    }

    // TW-4a: an incomplete rollback MUST throw rather than masking as {ok:false}.
    assert.ok(
        threw !== null,
        'nodeUpsert must THROW when rollback itself fails (incomplete rollback must not be masked)',
    );
    assert.ok(
        threw.message.includes('rollback incomplete') || threw.message.includes('partial state'),
        `expected rollback-incomplete language in thrown message; got: "${threw.message}"`,
    );
});

/* ─── S7: WAL append (active-workspace) ──────────────────────────────── */

test('S7 — WAL append fires for active-workspace writes when wired', async () => {
    const { graph } = makeFakeGraph();
    const walEntries: Array<{ kind: string; payload: unknown }> = [];
    const getWal = () => ({
        append(kind: string, payload: unknown) { walEntries.push({ kind, payload }); },
    });

    await nodeUpsert(
        { ...baseArgs('s7-wal', graph), isActiveWorkspace: true },
        { getWal: getWal as never },
    );

    assert.equal(walEntries.length, 1, 'exactly one WAL append');
    assert.equal(walEntries[0].kind, 'upsert_node', 'WAL entry kind must be upsert_node');
});

test('S7 — WAL append does NOT fire for non-active-workspace writes', async () => {
    const { graph } = makeFakeGraph();
    const walEntries: Array<unknown> = [];
    const getWal = () => ({
        append(...args: unknown[]) { walEntries.push(args); },
    });

    await nodeUpsert(
        { ...baseArgs('s7-nowal', graph), isActiveWorkspace: false },
        { getWal: getWal as never },
    );

    assert.equal(walEntries.length, 0, 'WAL must NOT fire for non-active-workspace');
});

/* ─── S8: version record (non-fatal) ─────────────────────────────────── */

test('S8 — version record fires when versionStore wired', async () => {
    const { graph } = makeFakeGraph();
    const versions: unknown[] = [];
    const versionStore = {
        recordVersion(v: unknown) { versions.push(v); },
    };

    await nodeUpsert(baseArgs('s8-version', graph), { versionStore: versionStore as never });

    assert.equal(versions.length, 1, 'exactly one version record');
    const v = versions[0] as { nodeId: string; operation: string };
    assert.equal(v.nodeId, 's8-version');
    assert.equal(v.operation, 'upsert');
});

test('S8 — version record failure is non-fatal (does not affect ok=true)', async () => {
    const { graph } = makeFakeGraph();
    const versionStore = {
        recordVersion() { throw new Error('injected version store failure'); },
    };

    const result = await nodeUpsert(baseArgs('s8-nonfatal', graph), {
        versionStore: versionStore as never,
    });

    // Non-fatal: write must still succeed.
    assert.ok(result.ok === true, 'version store failure must be non-fatal');
});

/* ─── S9: autolink fires for active-workspace !skipEmbed ─────────────── */

test('S9 — autolink fires for active-workspace, !skipEmbed, when supplied', async () => {
    const { graph } = makeFakeGraph();
    let initializeCalled = false;

    // reconnectOneNode calls verbatim.initialize() as its very first step
    // (reconnect.ts:351). We use that as the probe: if initialize is called,
    // the autolink branch was entered (fire-and-forget). The call will
    // subsequently fail on missing methods — that error is swallowed by
    // nodeUpsert's .catch() handler, so the write still returns ok:true.
    const autolinkVerbatim = {
        async initialize() { initializeCalled = true; throw new Error('stub: no further methods'); },
    };
    const autolinkGraph = {};

    await nodeUpsert(
        { ...baseArgs('s9-autolink', graph), isActiveWorkspace: true },
        // `tracker` is a REQUIRED field on AutolinkHandles precisely so a call
        // site cannot quietly land on the process-global defaultAutolinkTracker
        // (pendingAutolink.ts, property 1). These two sites did exactly that,
        // and nothing caught it because test/ was outside tsconfig's `include`
        // — the compile-time safety net did not cover the place a missed call
        // site is most likely to be written. Named explicitly now.
        { autolink: { graph: autolinkGraph as never, verbatim: autolinkVerbatim as never, tracker: defaultAutolinkTracker } },
    );

    // Give the fire-and-forget promise a tick to start executing.
    await new Promise<void>((r) => setTimeout(r, 50));

    assert.ok(
        initializeCalled,
        'autolink must fire (verbatim.initialize called by reconnectOneNode) for active-workspace !skipEmbed',
    );
});

test('S9 — autolink does NOT fire when skipEmbed=true', async () => {
    const { graph } = makeFakeGraph();
    let reconnectCalled = false;
    const autolinkGraph = {
        async query() { reconnectCalled = true; return { rows: [], columns: [] }; },
    };
    const autolinkVerbatim = { async verbatimStore() { return undefined; }, async verbatimSearch() { return []; } };

    await nodeUpsert(
        { ...baseArgs('s9-skip', graph), skipEmbed: true, isActiveWorkspace: true },
        { autolink: { graph: autolinkGraph as never, verbatim: autolinkVerbatim as never, tracker: defaultAutolinkTracker } },
    );

    await new Promise<void>((r) => setTimeout(r, 50));
    assert.ok(!reconnectCalled, 'autolink must NOT fire when skipEmbed=true');
});

/* ─── S10: no-hook default-write (embedded path without verbatim wired) ─ */

test('S10 — no outbox + no verbatim hook → graph-only write succeeds (embedded default path)', async () => {
    // TW-4a: the old bug swallowed errors in this path and returned success
    // even when the write silently failed. Here we verify the NO-ERROR case
    // (no verbatim hook supplied → skips verbatim, writes graph only → ok).
    const { graph, state } = makeFakeGraph();
    const result = await nodeUpsert(baseArgs('s10-default', graph), {});
    assert.ok(result.ok === true, 'graph-only write must succeed when no verbatim hook supplied');
    assert.ok(state.live.has('s10-default'), 'graph node must exist');
});

/* ─── run ─────────────────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
