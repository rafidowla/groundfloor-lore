#!/usr/bin/env tsx
/**
 * test/O6-self-heal-unit.ts — Sprint O6 unit tests.
 *
 * Validates the replicator's self-heal path + dispatcher's
 * `verifyApplied` shim, without spinning a daemon or LocalGraph/LanceDB.
 *
 * Coverage:
 *
 *   T1  — `verifyApplied(node.upsert)` returns true when hasNode hook
 *         confirms substrate has the node
 *   T2  — `verifyApplied(node.upsert)` returns false when hook returns
 *         false (substrate missing)
 *   T3  — `verifyApplied(node.delete)` returns true when hook says
 *         node ABSENT (delete confirmed)
 *   T4  — `verifyApplied(edge.upsert)` checks (src, tgt, relation)
 *   T5  — `verifyApplied(verbatim.upsert)` checks hasVerbatim hook
 *   T6  — `verifyApplied(embed.batch)` returns true only when every
 *         targetNodeId has a vector
 *   T7  — `verifyApplied` never throws — a hook that throws returns
 *         { verified: false, reason: 'verifier-threw:*' }
 *   T8  — `verifyApplied(sync.vector.mirror)` returns false with
 *         reason 'kind-not-self-healable'
 *   T9  — replicator.runSelfHealSweep flips a verified 'failed' row to
 *         'replicated' and bumps selfHealed counter
 *   T10 — replicator.runSelfHealSweep leaves an unverified 'failed'
 *         row alone (no attempts bump, status unchanged)
 *   T11 — grace period: a row whose failedAt is fresher than grace is
 *         NOT examined (uses default grace=5000)
 *   T12 — graceMsOverride=0 ignores the grace window (tests can
 *         self-heal immediately)
 *   T13 — cadence: back-to-back tickOnce() runs self-heal at most once
 *         per selfHealIntervalMs (force=false respects gate)
 *   T14 — dryRun=true reports recovered count but does NOT mutate
 *   T15 — workspace filter is respected by the underlying store call
 *   T16 — 2026-08-10 regression: wireOutbox's REAL `hasEdge` substrate
 *         (not a hand-fed fake) returns TRUE for an edge that exists on a
 *         Surreal-SHAPED graph handle — i.e. one that implements
 *         `queryEdges` (the portable, LoreGraphHandle contract) but NOT
 *         the Kùzu-only `getGraphContext()` escape hatch. Before the fix,
 *         `hasEdge` reached for `getGraphContext()` unconditionally and
 *         returned false whenever it was absent, so self-heal could never
 *         confirm a real edge on a non-Kùzu (e.g. SurrealDB-backed)
 *         workspace.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { verifyApplied, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { OutboxReplicator, DEFAULT_REPLICATOR_CONFIG } from '../packages/lore/src/outbox/replicator.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type {
    OutboxEntry, OutboxStore, OutboxStatus, OutboxReplicationState,
} from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
            passed++;
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${name}: ${(err as Error).message}`);
        }
    })());
}

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id: 'e1', operation: 'op', initiator: 'test',
        createdAt: now, updatedAt: now, steps: [], completed: false,
        workspace: 'default', operationKind: 'node.upsert',
        payload: { id: 'n1' }, status: 'failed', attempts: 1,
        failedAt: new Date(Date.now() - 60_000).toISOString(),
        sequenceId: 1, ...over,
    };
}

console.log('Sprint O6 self-heal unit tests');

// ---- T1..T8: verifyApplied dispatch table ---------------------------

test('T1 verifyApplied(node.upsert) returns verified=true when hasNode=true', async () => {
    const subs: DispatcherSubstrates = { hasNode: async () => true };
    const r = await verifyApplied(entry({ operationKind: 'node.upsert', payload: { id: 'n1' } }), subs);
    assert.equal(r.verified, true);
    assert.equal(r.reason, 'substrate-has-node');
});

test('T2 verifyApplied(node.upsert) returns verified=false when hasNode=false', async () => {
    const subs: DispatcherSubstrates = { hasNode: async () => false };
    const r = await verifyApplied(entry({ operationKind: 'node.upsert' }), subs);
    assert.equal(r.verified, false);
    assert.equal(r.reason, 'substrate-missing-node');
});

test('T3 verifyApplied(node.delete) returns verified=true when node ABSENT', async () => {
    const subs: DispatcherSubstrates = { hasNode: async () => false };
    const r = await verifyApplied(entry({ operationKind: 'node.delete', payload: { id: 'n1' } }), subs);
    assert.equal(r.verified, true);
    assert.equal(r.reason, 'substrate-confirms-deleted');
});

test('T4 verifyApplied(edge.upsert) passes (src, tgt, relation) triple', async () => {
    let seen: { sourceId: string; targetId: string; relation: string } | null = null;
    const subs: DispatcherSubstrates = {
        hasEdge: async (p) => { seen = p; return true; },
    };
    const r = await verifyApplied(entry({
        operationKind: 'edge.upsert',
        // 2.2 (2026-08-17): bidirectional DEFAULTS to true and probes BOTH
        // directions — pin this row to one-directional so the test keeps
        // asserting the single-triple probe contract. The bidirectional
        // probe pair is covered by the cluster-2 regression test
        // (test/outbox-durability-cluster2-unit.ts).
        payload: { sourceId: 'a', targetId: 'b', relation: 'rel', bidirectional: false },
    }), subs);
    assert.equal(r.verified, true);
    assert.deepEqual(seen, { sourceId: 'a', targetId: 'b', relation: 'rel' });
});

test('T5 verifyApplied(verbatim.upsert) checks hasVerbatim hook', async () => {
    const subs: DispatcherSubstrates = { hasVerbatim: async (id) => id === 'good' };
    const ok = await verifyApplied(entry({ operationKind: 'verbatim.upsert', payload: { id: 'good' } }), subs);
    const bad = await verifyApplied(entry({ operationKind: 'verbatim.upsert', payload: { id: 'bad' } }), subs);
    assert.equal(ok.verified, true);
    assert.equal(bad.verified, false);
});

test('T6 verifyApplied(embed.batch) requires every targetNodeId present', async () => {
    const present = new Set(['a', 'b']);
    const subs: DispatcherSubstrates = {
        hasEmbeddings: async (ids) => ids.every((x) => present.has(x)),
    };
    const ok = await verifyApplied(entry({
        operationKind: 'embed.batch',
        payload: { texts: ['x', 'y'], targetNodeIds: ['a', 'b'] },
    }), subs);
    const miss = await verifyApplied(entry({
        operationKind: 'embed.batch',
        payload: { texts: ['x', 'y'], targetNodeIds: ['a', 'c'] },
    }), subs);
    assert.equal(ok.verified, true);
    assert.equal(miss.verified, false);
});

test('T7 verifyApplied never throws — hook error → verified=false', async () => {
    const subs: DispatcherSubstrates = {
        hasNode: async () => { throw new Error('boom'); },
    };
    const r = await verifyApplied(entry({ operationKind: 'node.upsert' }), subs);
    assert.equal(r.verified, false);
    assert.match(r.reason, /^verifier-threw:/);
});

test('T8 verifyApplied(sync.vector.mirror) returns kind-not-self-healable', async () => {
    const r = await verifyApplied(entry({ operationKind: 'sync.vector.mirror', payload: {} }), {});
    assert.equal(r.verified, false);
    assert.equal(r.reason, 'kind-not-self-healable');
});

// ---- T9..T15: replicator.runSelfHealSweep ---------------------------

class FakeStore implements OutboxStore {
    rows: OutboxEntry[] = [];
    listFailedCalls: Array<{ olderThanMs: number; workspace: string | null | undefined }> = [];

    async record(): Promise<void> { /* unused */ }
    async markStep(): Promise<void> { /* unused */ }
    async markCompleted(): Promise<void> { /* unused */ }
    async remove(): Promise<void> { /* unused */ }
    async listUnfinished(): Promise<OutboxEntry[]> { return this.rows; }
    async listPendingForWorkspace(): Promise<OutboxEntry[]> { return []; }
    async listWorkspacesWithPending(): Promise<string[]> { return []; }
    async markEntryStatus(id: string, status: OutboxStatus): Promise<void> {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.status = status;
    }
    async readReplicationState(): Promise<OutboxReplicationState> {
        return { lastReplicatedSeq: 0, updatedAt: new Date(0).toISOString() };
    }
    async writeReplicationState(): Promise<void> { /* unused */ }
    async listFailedOlderThan(
        olderThanMs: number,
        opts?: { workspace?: string | null; limit?: number },
    ): Promise<OutboxEntry[]> {
        this.listFailedCalls.push({ olderThanMs, workspace: opts?.workspace });
        const cutoff = Date.now() - olderThanMs;
        return this.rows.filter((r) => {
            if (r.status !== 'failed' && r.status !== 'dead') return false;
            if (opts?.workspace !== null && opts?.workspace !== undefined && r.workspace !== opts.workspace) return false;
            const fa = Date.parse(r.failedAt ?? r.updatedAt);
            return Number.isFinite(fa) && fa <= cutoff;
        });
    }
}

function makeReplicator(store: OutboxStore, subs: DispatcherSubstrates, cfgOver: Partial<typeof DEFAULT_REPLICATOR_CONFIG> = {}): OutboxReplicator {
    return new OutboxReplicator({
        store, substrates: subs, config: cfgOver,
        log: () => undefined,
    });
}

test('T9 runSelfHealSweep flips verified failed row to replicated', async () => {
    const store = new FakeStore();
    store.rows.push(entry({ id: 'a', status: 'failed' }));
    const rep = makeReplicator(store, { hasNode: async () => true });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 1);
    assert.equal(report.examined, 1);
    assert.equal(store.rows[0].status, 'replicated');
    assert.equal(rep.getStats().selfHealed, 1);
});

test('T10 runSelfHealSweep leaves unverified row alone (no status change)', async () => {
    const store = new FakeStore();
    store.rows.push(entry({ id: 'a', status: 'failed' }));
    const rep = makeReplicator(store, { hasNode: async () => false });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 0);
    assert.equal(report.leftFailed, 1);
    assert.equal(store.rows[0].status, 'failed');
});

test('T11 grace period: fresh failedAt NOT examined under default grace', async () => {
    const store = new FakeStore();
    const fresh = new Date(Date.now() - 1000).toISOString(); // 1s ago, under 5s default
    store.rows.push(entry({ id: 'a', status: 'failed', failedAt: fresh }));
    const rep = makeReplicator(store, { hasNode: async () => true });
    const report = await rep.runSelfHealSweep({ force: true });
    // Default grace = 5000ms — store filter excludes the fresh row.
    assert.equal(report.examined, 0);
    assert.equal(store.rows[0].status, 'failed');
});

test('T12 graceMsOverride=0 sweeps even fresh rows', async () => {
    const store = new FakeStore();
    const fresh = new Date(Date.now() - 100).toISOString();
    store.rows.push(entry({ id: 'a', status: 'failed', failedAt: fresh }));
    const rep = makeReplicator(store, { hasNode: async () => true });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.examined, 1);
    assert.equal(report.recovered, 1);
});

test('T13 cadence: back-to-back force=false runs sweep only once per interval', async () => {
    const store = new FakeStore();
    store.rows.push(entry({ id: 'a', status: 'failed' }));
    const rep = makeReplicator(store, { hasNode: async () => true }, {
        selfHealIntervalMs: 60_000, selfHealGraceMs: 0,
    });
    const r1 = await rep.runSelfHealSweep({ force: false });
    const r2 = await rep.runSelfHealSweep({ force: false });
    assert.equal(r1.examined, 1);
    assert.equal(r2.examined, 0, 'second call should hit cadence gate');
});

test('T14 dryRun=true reports recovered but does NOT mutate', async () => {
    const store = new FakeStore();
    store.rows.push(entry({ id: 'a', status: 'failed' }));
    const rep = makeReplicator(store, { hasNode: async () => true });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0, dryRun: true });
    assert.equal(report.recovered, 1);
    assert.equal(report.dryRun, true);
    assert.equal(store.rows[0].status, 'failed', 'dry-run must not mutate');
    assert.equal(rep.getStats().selfHealed, 0, 'dry-run must not bump selfHealed');
});

test('T15 workspace filter threads through to store', async () => {
    const store = new FakeStore();
    store.rows.push(entry({ id: 'a', workspace: 'ws1', status: 'failed' }));
    store.rows.push(entry({ id: 'b', workspace: 'ws2', status: 'failed' }));
    const rep = makeReplicator(store, { hasNode: async () => true });
    await rep.runSelfHealSweep({ force: true, graceMsOverride: 0, workspace: 'ws1' });
    assert.ok(store.listFailedCalls.length > 0);
    assert.equal(store.listFailedCalls[0].workspace, 'ws1');
});

// ---- T16: 2026-08-10 regression — wireOutbox's REAL hasEdge on a --------
// Surreal-SHAPED graph handle (queryEdges present, getGraphContext absent)

/**
 * A graph handle shaped like `SurrealGraph`: it implements `queryEdges`
 * (the portable `LoreGraphHandle` contract every engine has) but
 * deliberately has NO `getGraphContext` — the Kùzu-only escape hatch the
 * pre-fix `hasEdge` unconditionally reached for. Filter semantics mirror
 * `graphEdges.queryEdges` / `surrealGraphAggregates.queryEdges`: exact
 * match on source id, target id, and relation.
 */
function fakeSurrealShapedGraph() {
    const edges: Array<{ sourceId: string; targetId: string; relation: string }> = [];
    return {
        edges,
        async upsertNode() { /* unused by this test */ },
        async addEdge(e: { sourceId: string; targetId: string; relation: string }) { edges.push(e); },
        async deleteNode() { return true; },
        async deleteEdge() { return 0; },
        async getNode() { return null; },
        async queryEdges(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }) {
            return edges
                .filter((e) =>
                    (!q.source || e.sourceId === q.source)
                    && (!q.target || e.targetId === q.target)
                    && (!q.relation || e.relation === q.relation))
                .slice(q.offset, q.offset + q.limit)
                .map((e) => ({ ...e, confidence: 'extracted' as const, confidenceScore: 1.0 }));
        },
        // Deliberately absent: getGraphContext.
    };
}

test('T16 wireOutbox hasEdge returns TRUE via queryEdges on a Surreal-shaped handle (no getGraphContext) [2026-08-10 regression]', async () => {
    const graph = fakeSurrealShapedGraph();
    graph.edges.push({ sourceId: 'a', targetId: 'b', relation: 'rel' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-o6-hasedge-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
    });
    const subs = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    assert.equal(typeof subs.hasEdge, 'function', 'hasEdge must be wired when getGraph is supplied');
    const found = await subs.hasEdge!({ sourceId: 'a', targetId: 'b', relation: 'rel' });
    assert.equal(found, true, 'hasEdge must detect an existing edge via queryEdges, not getGraphContext');
    const missingRelation = await subs.hasEdge!({ sourceId: 'a', targetId: 'b', relation: 'no-such-relation' });
    assert.equal(missingRelation, false);
    const missingTarget = await subs.hasEdge!({ sourceId: 'a', targetId: 'zzz', relation: 'rel' });
    assert.equal(missingTarget, false);
});

test('T17 1.3 regression: a throwing substrate probe does NOT self-heal-confirm a delete', async () => {
    // A graph whose getNode throws — a transient Kùzu error during a self-heal
    // sweep. Pre-fix, wireOutbox's hasNode swallowed the error into `false`,
    // which the node.delete verifier read as "confirmed absent" and marked the
    // failed delete 'replicated' (permanent loss of a delete that never ran).
    const throwingGraph = {
        async getNode() { throw new Error('simulated transient graph error'); },
        async queryEdges() { throw new Error('simulated transient graph error'); },
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-o6-throw-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => throwingGraph as never,
    });
    const subs = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;

    // The hook must now PROPAGATE the error, not swallow it into `false`.
    await assert.rejects(() => subs.hasNode!('n1'), /simulated transient graph error/);

    // End-to-end: a failed node.delete must stay failed, not be "recovered".
    const store = new FakeStore();
    store.rows.push(entry({ id: 'del1', status: 'failed', operationKind: 'node.delete', payload: { id: 'n1' } }));
    const rep = makeReplicator(store, { hasNode: subs.hasNode });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 0, 'delete must NOT be self-heal-confirmed when the probe errors');
    assert.equal(store.rows[0].status, 'failed', 'delete row stays failed');
});


await Promise.all(pending);

console.log('');
console.log(`passed:  ${passed}`);
console.log(`failed:  ${failed}`);
if (failed > 0) process.exit(1);
console.log('OK');
