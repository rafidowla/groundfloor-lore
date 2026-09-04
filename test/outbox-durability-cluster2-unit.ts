#!/usr/bin/env tsx
/**
 * test/outbox-durability-cluster2-unit.ts — regression tests for the
 * 2026-08-17 functional-correctness audit, cluster 2: "the outbox /
 * durability layer doesn't fully capture or correctly verify every side
 * effect of an operation".
 *
 * Findings covered (docs/audit/REMEDIATION-PLAN-2026-08-17-functional-correctness.md):
 *
 *   2.1  nodeUpsert's graph-write failure left its node.upsert outbox row
 *        un-retracted → the replicator later created the "failed" node with
 *        NO verbatim row (invisible to semantic recall). Fixed by routing a
 *        step-2 throw through rollbackPartialWrite (the same retraction the
 *        step-3 verbatim-failure path uses).
 *        Tests drive the REAL nodeUpsert (core/nodeService.ts) against a
 *        REAL SqliteOutboxStore, mirroring the audit's live repro shape
 *        (concurrent writes, a subset rejected with transaction conflicts).
 *
 *   2.2  dispatcher case 'edge.upsert' ignored payload.bidirectional
 *        (default TRUE on both the MCP tool and the REST route) and replayed
 *        only the forward direction; verifyApplied then confirmed the
 *        half-applied edge 'substrate-has-edge'. Fixed: dispatch writes both
 *        directions when bidirectional !== false, and the verifier probes
 *        both directions. Tests drive the REAL dispatch()/verifyApplied()
 *        and the REAL OutboxReplicator.tickOnce() replay path — the audit's
 *        RAN-AND-OBSERVED harness shape.
 *
 *   2.3  MCP delete_edge recorded NO edge.delete outbox row (its REST twin
 *        does), so a pending edge.upsert from a recent store_edge was never
 *        superseded and the replicator RESURRECTED the deleted edge after
 *        delete_edge had already returned success. Fixed: delete_edge now
 *        records the same edge.delete row DELETE /api/edge records. Test
 *        drives the REAL MCP tool handlers (captured-handler stub, the
 *        repo's established pattern) over a REAL SurrealGraph (embedded
 *        SurrealDB) + REAL SqliteOutboxStore + REAL OutboxReplicator — the
 *        audit's exact store_edge → delete_edge → replicator-tick repro.
 *
 *   2.4  self-heal's verifyApplied probed EXISTENCE, not content, so a dead
 *        row carrying a real edit (node.upsert / verbatim.upsert /
 *        verbatim.upsert.batch / embed.batch) was flipped to 'replicated'
 *        while the substrate still held the OLD content. Fixed with content
 *        witnesses: payload content fields vs the stored node, and
 *        contentHash vs the stored verbatim row. Tests drive the REAL
 *        SqliteOutboxStore + OutboxReplicator.runSelfHealSweep — the audit's
 *        RAN-AND-OBSERVED harness.
 *
 *   MED  store_edge returned isError(edge_endpoint_missing) but its
 *        already-recorded edge.upsert row stayed pending and was retried, so
 *        the 'failed' edge silently appeared once the endpoint node was
 *        later created. Fixed: the row is retracted (removeIfPending, with a
 *        compensating edge.delete when the replicator already claimed it).
 *
 *   M11  (cluster-1 finding, landed here by agreement — wiring.ts is this
 *        cluster's file): wireOutbox's storeEmbedBatch swallowed a THROWN
 *        graph.getNode into `null` and skipped the row as if the node were
 *        deleted, while the outbox row was still marked replicated. Fixed:
 *        a getNode throw now propagates so the row is retried; only a clean
 *        null skips.
 *
 * Run:  npx tsx test/outbox-durability-cluster2-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { SqliteOutboxStore as SqliteOutboxStoreT } from '../packages/lore/src/outbox/sqliteStore.js';

// LORE_HOME MUST be a fresh dir before any import that transitively loads
// config/workspaces.ts evaluates CONTROL_FILE (supersede-rest-edge-unit.ts
// pattern). That ordering constraint is why the VALUE imports below are
// dynamic — a static import would evaluate the module graph before the env
// assignment on this line runs.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster2-outbox-'));
process.env['LORE_HOME'] = TEST_HOME;

const WS = 'ws-c2';
const WS2 = 'ws-c2b';
for (const w of [WS, WS2]) {
    fs.mkdirSync(path.join(TEST_HOME, 'workspaces', w, '.lore'), { recursive: true });
}
fs.writeFileSync(
    path.join(TEST_HOME, 'workspaces.json'),
    JSON.stringify({
        active: WS,
        workspaces: [WS, WS2].map((w) => ({
            name: w,
            path: path.join(TEST_HOME, 'workspaces', w),
            createdAt: '2026-08-17T00:00:00.000Z',
            graphEngine: 'surreal' as const,
        })),
    }, null, 2),
);

const { nodeUpsert } = await import('../packages/lore/src/core/nodeService.js');
const { dispatch, verifyApplied } = await import('../packages/lore/src/outbox/dispatcher.js');
const { OutboxReplicator } = await import('../packages/lore/src/outbox/replicator.js');
const { SqliteOutboxStore } = await import('../packages/lore/src/outbox/sqliteStore.js');
const { recordHotWrite } = await import('../packages/lore/src/outbox/hotLane.js');
const { wireOutbox } = await import('../packages/lore/src/outbox/wiring.js');
const { computeContentHash } = await import('../packages/lore/src/engines/contentHash.js');
const { withTransactionConflictRetry } = await import('../packages/lore/src/engines/transactionConflictRetry.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerStoreEdgeTool } = await import('../packages/lore/src/mcp/tools/memory/storeEdge.js');
const { registerDeleteEdgeTool } = await import('../packages/lore/src/mcp/tools/memory/deleteEdge.js');

// ── runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); }
    })());
}

const tmpDirs: string[] = [TEST_HOME];
function newStore(): SqliteOutboxStoreT {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster2-outbox-store-'));
    tmpDirs.push(d);
    return new SqliteOutboxStore(d, { retryBaseMs: 500 });
}

const NOW = '2026-08-17T00:00:00.000Z';
function baseEntry(over: Partial<OutboxEntry> & { id: string }): OutboxEntry {
    return {
        id: over.id,
        operation: over.operation ?? String(over.operationKind ?? 'op'),
        initiator: over.initiator ?? 'test:cluster2',
        createdAt: over.createdAt ?? NOW,
        updatedAt: over.updatedAt ?? NOW,
        steps: over.steps ?? [],
        completed: over.completed ?? false,
        workspace: over.workspace,
        operationKind: over.operationKind,
        payload: over.payload,
        status: over.status ?? 'pending',
        attempts: over.attempts ?? 0,
        sequenceId: over.sequenceId,
    };
}

/** A directed-edge fake substrate — the dispatcher-level RAN-AND-OBSERVED
 *  harness from the 2.2 finding. */
function fakeEdgeSubstrate(opts?: { failOnSource?: string }) {
    const edges = new Set<string>();
    const key = (s: string, t: string, r: string) => `${s}|${t}|${r}`;
    const substrates: DispatcherSubstrates = {
        async addEdge(p) {
            const s = String(p['sourceId']);
            if (opts?.failOnSource && s === opts.failOnSource) {
                throw new Error(`simulated SurrealDB write-write conflict on ${s}`);
            }
            edges.add(key(s, String(p['targetId']), String(p['relation'])));
        },
        async hasEdge({ sourceId, targetId, relation }) {
            return edges.has(key(sourceId, targetId, relation));
        },
    };
    return { edges, key, substrates };
}

/** The exact payload shape the MCP tool + REST route record (storeEdge.ts /
 *  edges.ts / bulkWrite.ts), bidirectional defaulting to TRUE. */
function routeEdgePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        sourceId: 'n1', targetId: 'n2', relation: 'depends_on',
        confidence: 'extracted', confidenceScore: 1, bidirectional: true,
        ...over,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 2.1 — graph-write failure retracts the node.upsert outbox row
// ════════════════════════════════════════════════════════════════════════════

function fakeWriteGraph(failIds: Set<string>) {
    const upserted: string[] = [];
    const deleted: string[] = [];
    const graph = {
        async upsertNode(n: Record<string, unknown>) {
            const id = String(n['id']);
            if (failIds.has(id)) {
                throw new Error('simulated SurrealDB transaction conflict: write-write conflict on LoreNode');
            }
            upserted.push(id);
            return { ...n, createdAt: NOW, updatedAt: NOW, syncedAt: null };
        },
        async deleteNode(id: string) { deleted.push(id); return true; },
        async getNode() { return null; },
    };
    return { graph, upserted, deleted };
}

function nodeArgs(id: string, graph: never, ws = 'ws1') {
    return {
        id,
        workspace: ws,
        ecosystem: '*',
        nodeData: {
            id, type: 'note', label: id, content: `pangolin marker ${id}`,
            project: ws, ecosystem: '*', security_scopes: [],
        },
        targetGraph: graph,
        initiator: 'test:2.1',
    };
}

test('2.1a graph-write failure retracts the node.upsert outbox row (no replay, no orphan)', async () => {
    const outbox = newStore();
    const fg = fakeWriteGraph(new Set(['y-1']));
    // The REAL production write path — nodeUpsert with the outbox wired.
    await assert.rejects(
        nodeUpsert(nodeArgs('y-1', fg.graph as never), { outboxStore: outbox }),
        /transaction conflict/,
        'the original graph error must propagate to the caller',
    );
    // The partial graph row is cleaned up and the outbox row is RETRACTED —
    // pre-fix the row stayed pending and the replicator created the node
    // later with no verbatim row.
    assert.deepEqual(fg.deleted, ['y-1'], 'rollback must delete the (partial) graph node');
    assert.equal((await outbox.listUnfinished()).length, 0,
        'the node.upsert outbox row must be retracted when the graph write fails');

    // A replicator pass now applies NOTHING for y-1 — pre-fix it replayed the
    // stranded row and created the graph-only orphan.
    let replayed = 0;
    const rep = new OutboxReplicator({
        store: outbox,
        substrates: { upsertNode: async () => { replayed++; } },
        config: { selfHealGraceMs: 0 },
        log: () => undefined,
    });
    await rep.tickOnce();
    assert.equal(replayed, 0, 'replicator must not replay the retracted row');
});

test('2.1b concurrent mixed-success burst (the audit repro shape): failed ids leave NO replayable row', async () => {
    const outbox = newStore();
    const failIds = new Set(['y-2', 'y-4', 'y-6']);
    const fg = fakeWriteGraph(failIds);
    const ids = ['y-1', 'y-2', 'y-3', 'y-4', 'y-5', 'y-6'];
    const results = await Promise.allSettled(
        ids.map((id) => nodeUpsert(nodeArgs(id, fg.graph as never), { outboxStore: outbox })),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 3, `expected 3 conflict rejections, got ${rejected.length}`);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 3);

    const unfinished = await outbox.listUnfinished();
    for (const id of failIds) {
        assert.ok(
            !unfinished.some((e) => (e.payload as Record<string, unknown> | undefined)?.['id'] === id),
            `failed id ${id} must leave NO outbox row behind (pre-fix it replayed into a graph-only orphan)`,
        );
    }
    // Successful writes keep their durability rows (node.upsert + verbatim.upsert each).
    for (const id of ['y-1', 'y-3', 'y-5']) {
        const rows = unfinished.filter((e) => (e.payload as Record<string, unknown> | undefined)?.['id'] === id
            || (e.payload as Record<string, unknown> | undefined)?.['id'] === `lore:${id}`);
        assert.equal(rows.length, 2, `successful id ${id} must keep its node.upsert + verbatim.upsert rows`);
    }
});

test('2.1c success path is unchanged: no rollback, rows stay pending for the replicator', async () => {
    const outbox = newStore();
    const fg = fakeWriteGraph(new Set());
    const r = await nodeUpsert(nodeArgs('ok-1', fg.graph as never), { outboxStore: outbox });
    assert.equal(r.ok, true);
    assert.deepEqual(fg.deleted, [], 'no deleteNode on the success path');
    assert.equal((await outbox.listUnfinished()).length, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// 2.2 — edge.upsert replay respects bidirectional; verifyApplied probes both
// ════════════════════════════════════════════════════════════════════════════

test('2.2a dispatch(edge.upsert, bidirectional:true) writes BOTH directions (RAN-AND-OBSERVED shape)', async () => {
    const { edges, key, substrates } = fakeEdgeSubstrate();
    await dispatch(
        baseEntry({ id: 'e1', operationKind: 'edge.upsert', workspace: 'ws', payload: routeEdgePayload() }),
        substrates,
    );
    assert.ok(edges.has(key('n1', 'n2', 'depends_on')), 'forward direction must land');
    assert.ok(edges.has(key('n2', 'n1', 'depends_on')), 'reverse direction must land (pre-fix: only forward)');
});

test('2.2b dispatch(edge.upsert) with NO bidirectional field (legacy row) defaults to both directions', async () => {
    const { edges, key, substrates } = fakeEdgeSubstrate();
    const payload = routeEdgePayload();
    delete payload['bidirectional'];
    await dispatch(
        baseEntry({ id: 'e1', operationKind: 'edge.upsert', workspace: 'ws', payload }),
        substrates,
    );
    assert.ok(edges.has(key('n1', 'n2', 'depends_on')));
    assert.ok(edges.has(key('n2', 'n1', 'depends_on')),
        'routes default bidirectional to true — a fieldless legacy row replays the write the route made');
});

test('2.2c dispatch(edge.upsert, bidirectional:false) writes ONLY the forward direction', async () => {
    const { edges, key, substrates } = fakeEdgeSubstrate();
    await dispatch(
        baseEntry({ id: 'e1', operationKind: 'edge.upsert', workspace: 'ws', payload: routeEdgePayload({ bidirectional: false }) }),
        substrates,
    );
    assert.ok(edges.has(key('n1', 'n2', 'depends_on')));
    assert.ok(!edges.has(key('n2', 'n1', 'depends_on')));
});

test('2.2d reverse-write failure leaves the row failing (retryable) and the retry converges idempotently', async () => {
    const { edges, key, substrates } = fakeEdgeSubstrate({ failOnSource: 'n2' });
    const entry = baseEntry({ id: 'e1', operationKind: 'edge.upsert', workspace: 'ws', payload: routeEdgePayload() });
    // The second (reverse) addEdge throws — the documented SurrealDB
    // write-conflict failure mode from the finding. dispatch must REJECT so
    // the replicator keeps the row pending instead of marking a half-applied
    // edge done.
    await assert.rejects(dispatch(entry, substrates), /write-write conflict/);
    assert.ok(edges.has(key('n1', 'n2', 'depends_on')), 'forward direction landed before the failure');
    assert.ok(!edges.has(key('n2', 'n1', 'depends_on')), 'reverse direction did not land');

    // Retry with the conflict cleared: reverse lands, forward is not duplicated.
    const healed = fakeEdgeSubstrate();
    for (const e of edges) healed.edges.add(e);
    await dispatch(entry, healed.substrates);
    assert.ok(healed.edges.has(key('n2', 'n1', 'depends_on')), 'retry must create the reverse direction');
    assert.equal([...healed.edges].filter((e) => e === key('n1', 'n2', 'depends_on')).length, 1);
});

test('2.2e verifyApplied(edge.upsert, bidirectional) requires BOTH directions before reporting substrate-has-edge', async () => {
    const { edges, key, substrates } = fakeEdgeSubstrate();
    const entry = baseEntry({ id: 'e1', operationKind: 'edge.upsert', workspace: 'ws', payload: routeEdgePayload() });

    // Half-applied (the pre-fix replay result): forward only.
    edges.add(key('n1', 'n2', 'depends_on'));
    const half = await verifyApplied(entry, substrates);
    assert.equal(half.verified, false, 'a half-applied bidirectional edge must NOT verify');
    assert.equal(half.reason, 'substrate-missing-reverse-edge');

    edges.add(key('n2', 'n1', 'depends_on'));
    const full = await verifyApplied(entry, substrates);
    assert.equal(full.verified, true);
    assert.equal(full.reason, 'substrate-has-edge');
});

test('2.2f verifyApplied(edge.upsert, bidirectional:false) probes only the forward triple', async () => {
    const { edges, key, substrates } = fakeEdgeSubstrate();
    edges.add(key('n1', 'n2', 'depends_on'));
    const r = await verifyApplied(
        baseEntry({ id: 'e1', operationKind: 'edge.upsert', workspace: 'ws', payload: routeEdgePayload({ bidirectional: false }) }),
        substrates,
    );
    assert.equal(r.verified, true);
});

test('2.2g full replicator replay of the route-recorded row creates BOTH directions', async () => {
    const outbox = newStore();
    await recordHotWrite(outbox, {
        workspace: 'ws',
        operationKind: 'edge.upsert',
        payload: routeEdgePayload(),
        initiator: 'http:POST /api/edge',
        operation: 'edge.upsert',
    });
    const { edges, key, substrates } = fakeEdgeSubstrate();
    const rep = new OutboxReplicator({
        store: outbox, substrates,
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 },
        log: () => undefined,
    });
    await rep.tickOnce();
    assert.ok(edges.has(key('n1', 'n2', 'depends_on')), 'replay must land forward');
    assert.ok(edges.has(key('n2', 'n1', 'depends_on')), 'replay must land reverse (the 2.2 hole)');
});

// ════════════════════════════════════════════════════════════════════════════
// 2.4 — self-heal content witnesses (existence is not proof an UPDATE landed)
// ════════════════════════════════════════════════════════════════════════════

/** In-memory graph + verbatim substrates with BOTH existence probes and the
 *  new content-witness probes, as wireOutbox now wires them in production. */
function fakeContentSubstrates() {
    const graph = new Map<string, Record<string, unknown>>();
    const verbatim = new Map<string, { contentHash?: string; text?: string }>();
    const substrates: DispatcherSubstrates = {
        async hasNode(id) { return graph.has(id); },
        async getNode(id) { return graph.get(id) ?? null; },
        async hasVerbatim(id) { return verbatim.has(id); },
        async getVerbatim(id) { return verbatim.get(id) ?? null; },
        async hasEmbeddings(ids) { return ids.every((id) => verbatim.has(id)); },
    };
    return { graph, verbatim, substrates };
}

async function plantFailedRow(
    store: SqliteOutboxStoreT,
    over: Partial<OutboxEntry> & { id: string },
): Promise<void> {
    await store.record(baseEntry(over));
    // Simulate a row that exhausted its in-tick retries. 'failed' rows past
    // the grace window are what the ROUTINE self-heal sweep examines
    // (post-cluster-5b: 'dead' rows are only swept when the operator passes
    // includeDead — see 2.4a for the composed dead-row case).
    await store.markEntryStatus(over.id, 'failed', { error: 'simulated write-write conflict' });
}

/** The audit's exact terminal state: DEAD after maxAttempts. Routine sweeps
 *  skip these post-5b; the operator drain path (includeDead) still verifies
 *  them through the same verifyApplied content witnesses. */
async function plantDeadRow(
    store: SqliteOutboxStoreT,
    over: Partial<OutboxEntry> & { id: string },
): Promise<void> {
    await store.record(baseEntry(over));
    await store.markEntryStatus(over.id, 'dead', { error: 'simulated write-write conflict' });
}

function newSweepReplicator(store: SqliteOutboxStoreT, substrates: DispatcherSubstrates) {
    return new OutboxReplicator({
        store, substrates,
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 },
        log: () => undefined,
    });
}

test('2.4a dead node.upsert carrying an UNAPPLIED edit is NOT existence-healed (RAN-AND-OBSERVED repro)', async () => {
    const store = newStore();
    const { graph, substrates } = fakeContentSubstrates();
    // node-A already exists in the graph with OLD content — the audit's setup.
    graph.set('node-A', { id: 'node-A', type: 'note', label: 'A', content: 'v1', project: 'ws1', ecosystem: '*' });
    await plantDeadRow(store, {
        id: 'dead-node', operationKind: 'node.upsert', workspace: 'ws1',
        payload: { id: 'node-A', type: 'note', label: 'A', content: 'v2-IMPORTANT-EDIT', project: 'ws1', ecosystem: '*' },
    });

    const rep = newSweepReplicator(store, substrates);
    // Post-cluster-5b: the ROUTINE sweep no longer examines dead rows at all
    // (they wait for the operator drain path) — the audit's "dead-letter
    // queue emptied by the routine sweep" scenario is closed at the gate.
    const routine = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(routine.examined, 0, 'routine sweep must skip dead rows (cluster-5b includeDead gate)');

    // The operator drain path (includeDead) still runs the verifier — and
    // the content witness blocks the heal because the edit never landed.
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0, includeDead: true });
    assert.equal(report.examined, 1);
    assert.equal(report.recovered, 0, 'stale-content row must NOT be flipped to replicated');
    assert.equal(report.leftFailed, 1);
    assert.equal(report.details[0]!.reason, 'substrate-content-stale');
    assert.equal(report.details[0]!.verified, false);
    const row = (await store.listUnfinished()).find((r) => r.id === 'dead-node');
    assert.equal(row?.status, 'dead', 'row stays dead (operator-visible) instead of being silently healed');

    // Control: once the substrate genuinely holds the edit, the sweep heals.
    graph.set('node-A', { id: 'node-A', type: 'note', label: 'A', content: 'v2-IMPORTANT-EDIT', project: 'ws1', ecosystem: '*' });
    const report2 = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0, includeDead: true });
    assert.equal(report2.recovered, 1, 'a row whose content DID land still heals');
    assert.equal(report2.details[0]!.reason, 'substrate-content-matches');
});

test('2.4b dead verbatim.upsert over an existing row is content-checked via contentHash', async () => {
    const store = newStore();
    const { verbatim, substrates } = fakeContentSubstrates();
    verbatim.set('lore:v1', { text: 'OLD TEXT', contentHash: computeContentHash('OLD TEXT') });
    await plantFailedRow(store, {
        id: 'dead-verb', operationKind: 'verbatim.upsert', workspace: 'ws1',
        payload: { id: 'lore:v1', text: 'BRAND NEW TEXT', metadata: { contentHash: computeContentHash('BRAND NEW TEXT') } },
    });

    const rep = newSweepReplicator(store, substrates);
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 0, 'verbatim row holding OLD TEXT must not heal the BRAND NEW TEXT write');
    assert.equal(report.details[0]!.reason, 'substrate-content-stale');

    verbatim.set('lore:v1', { text: 'BRAND NEW TEXT', contentHash: computeContentHash('BRAND NEW TEXT') });
    const report2 = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report2.recovered, 1);
});

test('2.4c verbatim.upsert.batch: every content-bearing item must match', async () => {
    const store = newStore();
    const { verbatim, substrates } = fakeContentSubstrates();
    verbatim.set('lore:b1', { text: 'NEW1', contentHash: computeContentHash('NEW1') });
    verbatim.set('lore:b2', { text: 'OLD2', contentHash: computeContentHash('OLD2') });
    await plantFailedRow(store, {
        id: 'dead-batch', operationKind: 'verbatim.upsert.batch', workspace: 'ws1',
        payload: {
            items: [
                { id: 'lore:b1', text: 'NEW1', metadata: { contentHash: computeContentHash('NEW1') } },
                { id: 'lore:b2', text: 'NEW2', metadata: { contentHash: computeContentHash('NEW2') } },
            ],
        },
    });

    const rep = newSweepReplicator(store, substrates);
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 0, 'one stale item (b2 = OLD2) must block the heal');
    assert.equal(report.details[0]!.reason, 'substrate-content-stale');

    verbatim.set('lore:b2', { text: 'NEW2', contentHash: computeContentHash('NEW2') });
    const report2 = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report2.recovered, 1);
});

test('2.4d embed.batch: a failed re-embed is not confirmed by the STALE vector it was meant to replace', async () => {
    const store = newStore();
    const { verbatim, substrates } = fakeContentSubstrates();
    // The stale pre-re-embed row (old embedding-model content).
    verbatim.set('lore:e1', { text: 'node text', contentHash: computeContentHash('node text') });
    await plantFailedRow(store, {
        id: 'dead-embed', operationKind: 'embed.batch', workspace: 'ws1',
        payload: { texts: ['node text — re-embedded body'], targetNodeIds: ['lore:e1'] },
    });

    const rep = newSweepReplicator(store, substrates);
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 0,
        'hasEmbeddings-style existence must not confirm a re-embed whose content never landed');
    assert.equal(report.details[0]!.reason, 'substrate-content-stale');

    verbatim.set('lore:e1', { text: 'node text — re-embedded body', contentHash: computeContentHash('node text — re-embedded body') });
    const report2 = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report2.recovered, 1);
});

test('2.4e creates still heal (identity-only payloads keep the existence witness)', async () => {
    const store = newStore();
    const { graph, substrates } = fakeContentSubstrates();
    graph.set('n-new', { id: 'n-new' });
    await plantFailedRow(store, {
        id: 'dead-create', operationKind: 'node.upsert', workspace: 'ws1',
        payload: { id: 'n-new' }, // no content fields → existence is sound
    });
    const rep = newSweepReplicator(store, substrates);
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 1);
    assert.equal(report.details[0]!.reason, 'substrate-has-node');
});

test('2.4f content-bearing payload + no witness hook wired → fails LOUD, never existence-heals', async () => {
    const store = newStore();
    const { graph } = fakeContentSubstrates();
    graph.set('node-A', { id: 'node-A', content: 'v2-IMPORTANT-EDIT' });
    await plantFailedRow(store, {
        id: 'dead-nowitness', operationKind: 'node.upsert', workspace: 'ws1',
        payload: { id: 'node-A', content: 'v2-IMPORTANT-EDIT' },
    });
    // Only the legacy existence probe wired (pre-2.4 wiring shape).
    const rep = newSweepReplicator(store, { hasNode: async () => true });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 0, 'without a content witness the row must stay dead, not existence-heal');
    assert.equal(report.details[0]!.reason, 'content-witness-unwired');
});

test('2.4g production wiring: wireOutbox routes getNode/getVerbatim to the ROW\'s workspace', async () => {
    // sp-f3 pattern — reach the substrate closures through the replicator the
    // same object production uses.
    const bootGraph = {
        seen: [] as string[],
        async getNode(id: string) { this.seen.push(id); return null; },
        async upsertNode() {}, async addEdge() {}, async deleteNode() { return true; },
        async queryEdges() { return []; },
    };
    const bGraph = {
        seen: [] as string[],
        async getNode(id: string) { this.seen.push(id); return { id, content: 'B-content' }; },
        async upsertNode() {}, async addEdge() {}, async deleteNode() { return true; },
        async queryEdges() { return []; },
    };
    const bootVerbatim = {
        seen: [] as string[],
        async getById(id: string) { this.seen.push(id); return null; },
        async store() {}, async storeBatch() {}, async physicalDelete() {},
    };
    const bVerbatim = {
        seen: [] as string[],
        async getById(id: string) { this.seen.push(id); return { contentHash: 'h', text: 't' }; },
        async store() {}, async storeBatch() {}, async physicalDelete() {},
    };
    const wiring = wireOutbox({
        loreDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cluster2-wiring-')),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => bootGraph as never,
        getVerbatim: () => bootVerbatim as never,
        getGraphForWorkspace: () => (ws: string) => (ws === 'B' ? Promise.resolve(bGraph as never) : Promise.reject(new Error(`no graph for ${ws}`))),
        getVerbatimForWorkspace: () => (ws: string) => (ws === 'B' ? Promise.resolve(bVerbatim as never) : Promise.reject(new Error(`no verbatim for ${ws}`))),
    });
    const subs = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    assert.equal(typeof subs.getNode, 'function', 'production wiring must wire the node content witness');
    assert.equal(typeof subs.getVerbatim, 'function', 'production wiring must wire the verbatim content witness');

    const node = await subs.getNode!('nx', 'B');
    assert.deepEqual(bGraph.seen, ['nx'], 'witness must probe workspace B, not boot');
    assert.deepEqual(bootGraph.seen, []);
    assert.equal(node?.['content'], 'B-content');

    const row = await subs.getVerbatim!('lore:nx', 'B');
    assert.deepEqual(bVerbatim.seen, ['lore:nx']);
    assert.deepEqual(bootVerbatim.seen, []);
    assert.equal(row?.contentHash, 'h');
});

// ════════════════════════════════════════════════════════════════════════════
// M11 (cluster-1, landed here by agreement) — storeEmbedBatch: a THROWN
// getNode is not "node deleted"
// ════════════════════════════════════════════════════════════════════════════

function m11Wiring(getNodeImpl: (id: string) => Promise<Record<string, unknown> | null>) {
    const written: Array<Array<Record<string, unknown>>> = [];
    const verbatim = {
        async bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>) { written.push(rows); },
        async store() {}, async storeBatch() {}, async physicalDelete() {},
        async getById() { return null; },
    };
    const graph = {
        getNode: getNodeImpl,
        async upsertNode() {}, async addEdge() {}, async deleteNode() { return true; },
        async queryEdges() { return []; },
    };
    const provider = {
        dimension: 2,
        modelId: 'm11-fake',
        async embedDocument(_text: string) { return [0.1, 0.2]; },
    };
    const wiring = wireOutbox({
        loreDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cluster2-m11-')),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => verbatim as never,
        getEmbedder: () => provider as never,
    });
    const subs = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    return { subs, written };
}

test('M11a embed.batch with a THROWING graph.getNode rejects (row retried) — the embed is NOT silently dropped', async () => {
    const { subs, written } = m11Wiring(async () => { throw new Error('simulated transient graph read error'); });
    const entry = baseEntry({
        id: 'emb-1', operationKind: 'embed.batch', workspace: 'ws',
        payload: { texts: ['body'], targetNodeIds: ['lore:m1'] },
    });
    await assert.rejects(dispatch(entry, subs), /getNode/,
        'a transient read error must fail the dispatch so the replicator retries the row');
    assert.equal(written.length, 0, 'no partial verbatim write may land');
});

test('M11b embed.batch with a CLEANLY-missing node still skips (no orphan vectors) and succeeds', async () => {
    const { subs, written } = m11Wiring(async () => null);
    const entry = baseEntry({
        id: 'emb-2', operationKind: 'embed.batch', workspace: 'ws',
        payload: { texts: ['body'], targetNodeIds: ['lore:m1'] },
    });
    await dispatch(entry, subs); // must NOT reject — deleted node is a legitimate skip
    assert.equal(written.length, 0, 'deleted node → no vector row written');
});

// ════════════════════════════════════════════════════════════════════════════
// 2.3 + MED — real MCP tool surface over a real SurrealDB graph + real outbox
// ════════════════════════════════════════════════════════════════════════════

interface ToolBag {
    [name: string]: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }>;
}

function parseToolJson(r: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

const registry = new LocalGraphRegistry();
// getGraphHandle, not getOrOpen: getOrOpen was the legacy-engine-only
// substrate accessor and would open a legacy-engine database no matter
// what the workspace declares. getGraphHandle resolves the declared
// engine (surreal, above)
// and is exactly what the MCP tools' resolveTargetGraph uses too.
const graph = await registry.getGraphHandle(WS);

const fakeVerbatim = {
    async count() { return 0; },
    async search() { return []; },
    async bm25Search() { return []; },
    async store() {},
    async delete() {},
};
const storeBundle = {
    loreGraph: graph,
    loreVerbatim: fakeVerbatim,
    sessionCache: { pushNode: () => undefined },
};
async function seedNode(id: string): Promise<void> {
    // Production NEVER calls the raw handle write unwrapped (see the
    // withTransactionConflictRetry convention across MCP tools / REST routes
    // / CLI; historically a no-op on the legacy engine, where writes
    // serialized internally). Under
    // SurrealDB's optimistic concurrency, concurrent tests seeding on the
    // one shared graph must follow the same convention.
    await withTransactionConflictRetry(() => graph.upsertNode({
        id, type: 'decision', label: id, content: `seed ${id}`, tags: [],
        project: WS, ecosystem: '*', metadata: '{}',
    }));
}

function makeTools(outboxStore: unknown): ToolBag {
    const tools: ToolBag = {};
    const stubServer = {
        tool: (name: string, ...rest: unknown[]) => {
            const handler = rest[rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as ToolBag[string];
        },
    };
    const deps = {
        store: storeBundle,
        graphRegistry: registry,
        detectedScope: { workspace: WS, ecosystem: '*' },
        auditLog: { log: () => undefined },
        getWal: () => ({ append: () => undefined }),
        outboxStore,
        edgeRelations: ['depends_on', 'related_to'],
        edgeRelationsEnum: z.enum(['depends_on', 'related_to']),
    };
    registerStoreEdgeTool(stubServer as never, deps as never);
    registerDeleteEdgeTool(stubServer as never, deps as never);
    return tools;
}

/** Replicator whose substrates are the REAL graph — the exact replay path
 *  the idle poll / boot recovery drive. */
function graphBoundReplicator(outbox: SqliteOutboxStoreT) {
    return new OutboxReplicator({
        store: outbox,
        substrates: {
            addEdge: async (p) => { await graph.addEdge(p as never); },
            deleteEdge: async (p) => { await graph.deleteEdge(p.sourceId, p.targetId, p.relation); },
        },
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 },
        log: () => undefined,
    });
}

async function forwardEdgeCount(): Promise<number> {
    return (await graph.queryEdges({ source: 'dA', target: 'dB', relation: 'depends_on', limit: 10, offset: 0 })).length;
}

test('2.3 MCP delete_edge records edge.delete; the replicator does NOT resurrect the deleted edge', async () => {
    // The audit's exact repro shape: store_edge → delete_edge → replicator run.
    const outbox = newStore();
    const tools = makeTools(outbox);
    await seedNode('dA');
    await seedNode('dB');

    const storeRes = parseToolJson(await tools['store_edge']!({
        sourceId: 'dA', targetId: 'dB', relation: 'depends_on', workspace: WS,
    }));
    assert.equal(storeRes['success'], true, `store_edge failed: ${JSON.stringify(storeRes)}`);
    assert.equal(await forwardEdgeCount(), 1, 't0: edge present after store_edge');

    const delRes = parseToolJson(await tools['delete_edge']!({
        source_id: 'dA', target_id: 'dB', relation: 'depends_on', workspace: WS,
    }));
    assert.equal(delRes['success'], true, `delete_edge failed: ${JSON.stringify(delRes)}`);
    assert.equal(delRes['deleted'], 1);
    assert.equal(await forwardEdgeCount(), 0, 't1: edge gone after delete_edge');

    // The fix: an edge.delete outbox row matching the REST route's shape.
    const unfinished = await outbox.listUnfinished();
    const delRow = unfinished.find((e) => e.operationKind === 'edge.delete');
    assert.ok(delRow, 'delete_edge must record an edge.delete outbox row (pre-fix: none — the pending upsert resurrected the edge)');
    assert.equal(delRow.initiator, 'mcp:delete_edge');
    assert.deepEqual(
        delRow.payload,
        { sourceId: 'dA', targetId: 'dB', relation: 'depends_on' },
        'edge.delete payload must match the REST route shape exactly',
    );
    assert.equal(delRow.workspace, WS);

    // t2: the replicator runs (idle poll / boot recovery). Pre-fix the
    // pending edge.upsert replayed and the edge came back; now the recorded
    // edge.delete supersedes/follows it and the edge stays deleted.
    const rep = graphBoundReplicator(outbox);
    await rep.tickOnce();
    await rep.tickOnce();
    assert.equal(await forwardEdgeCount(), 0,
        't2: the deleted edge must STAY deleted after the replicator replays the pending rows');
});

test('MED-a store_edge with a missing endpoint retracts its edge.upsert row — the edge never appears later', async () => {
    const outbox = newStore();
    const tools = makeTools(outbox);
    await seedNode('eA');
    // NOTE: 'eMissing' deliberately does not exist — the real engine's
    // addEdge throws edge_endpoint_missing.

    const res = await tools['store_edge']!({
        sourceId: 'eA', targetId: 'eMissing', relation: 'depends_on', workspace: WS,
    });
    assert.equal(res.isError, true, 'endpoint-missing must surface as a tool error');
    assert.match(res.content[0]!.text, /edge_endpoint_missing/);

    // The recorded outbox row must be RETRACTED, not left for the replicator.
    const unfinished = await outbox.listUnfinished();
    assert.ok(
        !unfinished.some((e) => e.operationKind === 'edge.upsert'),
        `the edge.upsert row must be retracted when the caller was told the write failed; unfinished=${JSON.stringify(unfinished.map((e) => e.operationKind))}`,
    );

    // The finding's exact follow-through: the endpoint node is created LATER,
    // the replicator runs — the 'failed' edge must NOT silently appear.
    await seedNode('eMissing');
    const rep = graphBoundReplicator(outbox);
    await rep.tickOnce();
    const count = (await graph.queryEdges({ source: 'eA', target: 'eMissing', relation: 'depends_on', limit: 10, offset: 0 })).length;
    assert.equal(count, 0, 'the endpoint-missing edge must never materialize via outbox retry');
});

test('MED-b when the replicator already claimed the row, store_edge records a compensating edge.delete', async () => {
    // Stub store whose removeIfPending reports "already claimed" (the C-R2-03
    // race branch) — drives the REAL MCP tool handler.
    const recorded: OutboxEntry[] = [];
    const claimedStore = {
        async record(e: OutboxEntry) { recorded.push(e); },
        async markStep() {}, async markCompleted() {},
        async remove() { /* unconditional fallback — unused here */ },
        async removeIfPending() { return false; },
        async listUnfinished() { return recorded; },
    };
    const tools = makeTools(claimedStore);
    await seedNode('cA');

    const res = await tools['store_edge']!({
        sourceId: 'cA', targetId: 'cMissing', relation: 'depends_on', workspace: WS,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /edge_endpoint_missing/);

    const kinds = recorded.map((e) => e.operationKind);
    assert.deepEqual(kinds, ['edge.upsert', 'edge.delete'],
        `a claimed upsert row must be compensated by a later edge.delete; got ${JSON.stringify(kinds)}`);
    const comp = recorded[1]!;
    assert.deepEqual(comp.payload, { sourceId: 'cA', targetId: 'cMissing', relation: 'depends_on' });
    assert.equal(comp.workspace, WS);
});

test('MED-c store_edge success path records no retraction (control)', async () => {
    const outbox = newStore();
    const tools = makeTools(outbox);
    await seedNode('sA');
    await seedNode('sB');
    const res = parseToolJson(await tools['store_edge']!({
        sourceId: 'sA', targetId: 'sB', relation: 'related_to', workspace: WS,
    }));
    assert.equal(res['success'], true, `store_edge failed: ${JSON.stringify(res)}`);
    const unfinished = await outbox.listUnfinished();
    assert.equal(unfinished.filter((e) => e.operationKind === 'edge.upsert').length, 1);
    assert.equal(unfinished.filter((e) => e.operationKind === 'edge.delete').length, 0);
});

// ── run + report ─────────────────────────────────────────────────────────────

await Promise.all(pending);

console.log('');
console.log(`passed:  ${passed}`);
console.log(`failed:  ${failed}`);

// Close the REAL SurrealDB handle before closeAll()'s reference-drop: an open
// SurrealGraph holds the event loop (the legacy engine's native handles did
// not), and the
// all-pass path has no process.exit — without a true close the suite would
// hang on success. Mirrors test/surreal-crash-recovery-unit.ts teardown.
try { await graph.close(); } catch { /* non-fatal */ }
try { registry.closeAll(); } catch { /* non-fatal */ }
for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* non-fatal */ }
}
if (failed > 0) process.exit(1);
console.log('OK');
