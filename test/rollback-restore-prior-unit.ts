#!/usr/bin/env tsx
/**
 * rollback-restore-prior-unit.ts — 3.26.0: a failed UPDATE puts the previous
 * node back instead of deleting it.
 *
 * The defect: `nodeUpsert` writes the graph, then records the verbatim row.
 * When either step failed, `rollbackPartialWrite` called `deleteNode(id)`
 * unconditionally. That is right for a node the failed write created, and
 * wrong for an update: the caller was told "the write failed" and the memory
 * that existed before the call was gone.
 *
 * The fix, pinned here:
 *   - the save path reads the node under the node lock before writing it;
 *     when that read fails the save is rejected before anything is written;
 *   - a rollback restores that previous node: its content fields, plus every
 *     lifecycle field the failed write carried (so nothing it set survives,
 *     and a field it never touched is not written back over a concurrent
 *     lock-free change such as a supersede). Only a node the failed write
 *     created is deleted;
 *   - a node removed while the write was in flight is not brought back;
 *   - when the failed `node.upsert` row was already claimed by the replicator,
 *     the compensating row is a `node.upsert` of the previous state when the
 *     node is kept, a `node.delete` when it is not;
 *   - a graph without `getNode` (minimal fakes) keeps the pre-3.26 delete.
 *
 * Part 1 drives `nodeUpsert` with fakes. Part 2 boots a real embedded
 * `createLore()` per graph engine on a throwaway home and fails the
 * `verbatim.upsert` outbox record.
 *
 * Run: npx tsx test/rollback-restore-prior-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLore } from '../packages/lore/src/index.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { NodeUpsertArgs, NodeWriteGraph } from '../packages/lore/src/core/nodeService.js';
import { restorePayload } from '../packages/lore/src/core/nodeServiceVerbatim.js';
import { nodeV2Columns } from '../packages/lore/src/engines/dataplaneNodeShape.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

// ───────────────────────── Part 1 — fakes ─────────────────────────

type Stored = Record<string, unknown>;
interface GraphOpts {
    /** Throw from upsertNode: 'before' any change, or 'after' the row landed. */
    failUpsert?: 'before' | 'after';
    /** getNode throws on this call number (1 = the pre-write read). */
    failGetOnCall?: number;
    /** The restoring upsert (2nd call) throws. */
    failRestore?: boolean;
    /** The restoring upsert / the undo delete hits this many transaction conflicts first. */
    restoreConflicts?: number;
    deleteConflicts?: number;
    withoutGetNode?: boolean;
}
function fakeGraph(opts: GraphOpts = {}) {
    const state = { live: new Map<string, Stored>(), upserts: [] as Stored[], deletes: [] as string[], gets: 0, conflicts: 0 };
    let failUpsert = opts.failUpsert;
    let restoreConflicts = opts.restoreConflicts ?? 0, deleteConflicts = opts.deleteConflicts ?? 0;
    const graph: NodeWriteGraph = {
        async upsertNode(node: Stored) {
            if (failUpsert === 'before') { failUpsert = undefined; throw new Error('graph busy (nothing written)'); }
            if (opts.failRestore && state.upserts.length >= 1) throw new Error('restore refused');
            if (state.upserts.length >= 1 && restoreConflicts > 0) { restoreConflicts--; state.conflicts++; throw new Error('Transaction conflict: retry the write'); }
            state.upserts.push({ ...node });
            // Engine merge semantics: a field the caller omits keeps its stored value.
            const merged = { ...(state.live.get(String(node.id)) ?? {}), ...node, updatedAt: `t${state.upserts.length}` };
            state.live.set(String(node.id), merged);
            if (failUpsert === 'after') { failUpsert = undefined; throw new Error('graph write half-applied'); }
            return merged as never;
        },
        async deleteNode(id: string) {
            if (deleteConflicts > 0) { deleteConflicts--; state.conflicts++; throw new Error('Transaction conflict: retry the write'); }
            state.deletes.push(id);
            return state.live.delete(id);
        },
    };
    if (!opts.withoutGetNode) {
        graph.getNode = async (id: string) => {
            state.gets++;
            if (opts.failGetOnCall === state.gets) throw new Error('graph read failed');
            const n = state.live.get(id);
            return n ? ({ ...n } as unknown as LoreNode) : null;
        };
    }
    return { graph, state };
}

interface OutboxOpts {
    failVerbatim?: boolean; claimed?: boolean; withoutRemoveIfPending?: boolean;
    /** Runs when the verbatim record is attempted: the graph write has landed, the lock is still held. */
    whileWriting?: () => void;
}
function fakeOutbox(opts: OutboxOpts = {}) {
    const state = { entries: [] as OutboxEntry[], removed: [] as string[] };
    let seq = 0;
    const store: OutboxStore = {
        async record(entry: OutboxEntry) {
            if (entry.operationKind === 'verbatim.upsert') opts.whileWriting?.();
            if (opts.failVerbatim && entry.operationKind === 'verbatim.upsert') throw new Error('injected: outbox full');
            state.entries.push({ ...entry, sequenceId: ++seq });
        },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove(entryId: string) {
            state.removed.push(entryId);
            state.entries = state.entries.filter((e) => e.id !== entryId);
        },
        async listUnfinished() { return state.entries.slice(); },
    };
    if (!opts.withoutRemoveIfPending) {
        store.removeIfPending = async (entryId: string) => {
            if (opts.claimed) return false;
            state.removed.push(entryId);
            state.entries = state.entries.filter((e) => e.id !== entryId);
            return true;
        };
    }
    return { store, state };
}

const PRIOR: Stored = {
    id: 'n1', type: 'decision', label: 'original label', content: 'original content', tags: ['keep'],
    project: 'ws', ecosystem: '*', metadata: { a: 1 }, security_scopes: ['team-a'],
    status: 'active', classification: 'strategic', language: 'en', validFrom: '2026-01-01T00:00:00.000Z',
    updatedAt: 't0',
};
function args(graph: NodeWriteGraph, id = 'n1', over: Partial<NodeUpsertArgs> = {}): NodeUpsertArgs {
    return {
        id, workspace: 'ws', ecosystem: '*', targetGraph: graph, initiator: 'test:rollback',
        nodeData: { id, type: 'decision', label: 'NEW label', content: 'NEW content', tags: 'new', project: 'ws', ecosystem: '*', stale: true, validUntil: '2027-01-01T00:00:00.000Z' },
        ...over,
    };
}
const kinds = (entries: OutboxEntry[]): string[] => entries.map((e) => String(e.operationKind));

console.log('\nfailed write: restore the previous node (3.26.0)\n');

await test('verbatim record fails on an UPDATE → the previous node is put back, not deleted', async () => {
    const { graph, state } = fakeGraph();
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox({ failVerbatim: true });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.deepEqual(state.deletes, [], 'an existing node must never be deleted by the rollback');
    const now = state.live.get('n1')!;
    assert.equal(now.label, 'original label');
    assert.equal(now.content, 'original content');
    assert.deepEqual(now.tags, ['keep']);
    assert.deepEqual(now.security_scopes, ['team-a']);
    assert.equal(now.classification, 'strategic');
    assert.equal(now.stale, false, 'a flag the failed write set must not survive the restore');
    assert.equal(now.validUntil, '', 'a field the failed write set must be cleared by the restore');
    assert.deepEqual(kinds(ob.entries), [], 'the failed write leaves no outbox row behind');
});

await test('verbatim record fails on a CREATE → the node the write created is deleted (unchanged)', async () => {
    const { graph, state } = fakeGraph();
    const { store, state: ob } = fakeOutbox({ failVerbatim: true });
    const res = await nodeUpsert(args(graph, 'fresh'), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.deepEqual(state.deletes, ['fresh']);
    assert.equal(state.live.has('fresh'), false);
    assert.deepEqual(kinds(ob.entries), []);
});

await test('graph write throws after landing on an UPDATE → restored', async () => {
    const { graph, state } = fakeGraph({ failUpsert: 'after' });
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox();
    await assert.rejects(() => nodeUpsert(args(graph), { outboxStore: store }), /half-applied/);
    assert.deepEqual(state.deletes, []);
    assert.equal(state.live.get('n1')!.label, 'original label');
    assert.equal(state.live.get('n1')!.content, 'original content');
    assert.deepEqual(kinds(ob.entries), []);
});

await test('graph write throws before changing anything → the node keeps its content (rewritten once)', async () => {
    // Whether a throwing write changed the node cannot be told from a read (the
    // local engines answer getNode from a cache a failed write does not
    // refresh), so the restore always runs; an untouched node only gets a new
    // updatedAt.
    const { graph, state } = fakeGraph({ failUpsert: 'before' });
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox();
    await assert.rejects(() => nodeUpsert(args(graph), { outboxStore: store }), /nothing written/);
    assert.deepEqual(state.deletes, []);
    assert.equal(state.upserts.length, 1, 'one restoring write');
    const { updatedAt: _u, ...now } = state.live.get('n1')!;
    const { updatedAt: _p, ...prior } = PRIOR;
    assert.deepEqual(now, { ...prior, stale: false, validUntil: '' });
    assert.deepEqual(kinds(ob.entries), []);
});

await test('graph write throws on a CREATE → nothing is left behind', async () => {
    const { graph, state } = fakeGraph({ failUpsert: 'after' });
    const { store, state: ob } = fakeOutbox();
    await assert.rejects(() => nodeUpsert(args(graph, 'fresh'), { outboxStore: store }), /half-applied/);
    assert.equal(state.live.has('fresh'), false);
    assert.deepEqual(kinds(ob.entries), []);
});

await test('row already claimed, UPDATE → compensating node.upsert of the previous state', async () => {
    const { graph, state } = fakeGraph();
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox({ failVerbatim: true, claimed: true });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.equal(state.live.get('n1')!.label, 'original label');
    assert.deepEqual(kinds(ob.entries), ['node.upsert', 'node.upsert'], 'the claimed row stays; a compensating save follows it');
    const comp = ob.entries[1]!;
    assert.equal(comp.operation, 'graph.upsert');
    assert.deepEqual(comp.payload, restorePayload(PRIOR as unknown as LoreNode, { stale: true, validUntil: 'x', security_scopes: [] }),
        'the previous content, plus the lifecycle fields the failed write carried');
    assert.equal('status' in (comp.payload as Stored), false, 'a field the failed write never carried is not written back');
    assert.equal((comp.payload as Stored).label, 'original label');
    // Replaying both rows in order ends on the previous state.
    for (const e of ob.entries) await graph.upsertNode(e.payload as Stored);
    assert.equal(state.live.get('n1')!.label, 'original label');
    assert.equal(state.live.get('n1')!.stale, false);
});

await test('row already claimed, CREATE → compensating node.delete (unchanged)', async () => {
    const { graph, state } = fakeGraph();
    const { store, state: ob } = fakeOutbox({ failVerbatim: true, claimed: true });
    const res = await nodeUpsert(args(graph, 'fresh'), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.equal(state.live.has('fresh'), false);
    assert.deepEqual(kinds(ob.entries), ['node.upsert', 'node.delete']);
    assert.deepEqual(ob.entries[1]!.payload, { id: 'fresh' });
});

await test('previous state unreadable → the save is rejected before anything is written', async () => {
    const { graph, state } = fakeGraph({ failGetOnCall: 1 });
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox();
    await assert.rejects(() => nodeUpsert(args(graph), { outboxStore: store }), /could not read the current state[\s\S]*graph read failed[\s\S]*nothing was written/);
    assert.equal(state.upserts.length, 0, 'a write that could not be undone is not attempted');
    assert.deepEqual(state.deletes, []);
    assert.deepEqual(state.live.get('n1'), PRIOR, 'content and access scopes are exactly as they were');
    assert.deepEqual(kinds(ob.entries), [], 'and no outbox row was recorded');
});

await test('a supersede that lands while the write is in flight is not undone by the restore', async () => {
    // supersedeNode takes no node lock: it can stamp the old node between this
    // save's pre-write read and its rollback.
    const { graph, state } = fakeGraph();
    state.live.set('n1', { ...PRIOR });
    const supersede = () => Object.assign(state.live.get('n1')!, { status: 'superseded', supersededBy: 'n2', supersededAt: '2026-10-02T00:00:00.000Z', supersededReason: 'replaced' });
    const { store } = fakeOutbox({ failVerbatim: true, whileWriting: supersede });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false);
    const now = state.live.get('n1')!;
    assert.equal(now.content, 'original content', 'the failed write is undone');
    assert.equal(now.stale, false);
    assert.equal(now.status, 'superseded', 'the concurrent supersede survives');
    assert.equal(now.supersededBy, 'n2');
    assert.equal(now.supersededReason, 'replaced');
});

await test('a node deleted while the write is in flight is not brought back', async () => {
    // Host raw-graph deletes and the boot-time ephemeral prune take no node lock.
    const { graph, state } = fakeGraph();
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox({ failVerbatim: true, claimed: true, whileWriting: () => { state.live.delete('n1'); } });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.equal(state.live.has('n1'), false, 'the rollback does not re-create it');
    assert.equal(state.upserts.length, 1, 'only the failed write itself');
    assert.deepEqual(kinds(ob.entries), ['node.upsert', 'node.delete'], 'and the claimed row is compensated by a delete, not a save');
});

await test('the restore itself fails → rollback reported incomplete', async () => {
    const { graph, state } = fakeGraph({ failRestore: true });
    state.live.set('n1', { ...PRIOR });
    const { store } = fakeOutbox({ failVerbatim: true });
    await assert.rejects(() => nodeUpsert(args(graph), { outboxStore: store }), /rollback incomplete[\s\S]*restore refused/);
    assert.deepEqual(state.deletes, []);
});

await test('the restore hits a transaction conflict → it is retried, and the node is put back', async () => {
    const { graph, state } = fakeGraph({ restoreConflicts: 2 });
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox({ failVerbatim: true });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false, 'the save still failed (its verbatim record did)');
    assert.equal(state.conflicts, 2, 'both conflicts were hit');
    assert.equal(state.live.get('n1')!.label, 'original label', 'and the restore landed on the third try');
    assert.equal(state.live.get('n1')!.content, 'original content');
    assert.deepEqual(state.deletes, []);
    assert.deepEqual(kinds(ob.entries), [], 'the pending row is retracted; nothing is left queued');
});

await test('the undo of a failed CREATE hits a transaction conflict → the delete is retried', async () => {
    const { graph, state } = fakeGraph({ deleteConflicts: 1 });
    const { store } = fakeOutbox({ failVerbatim: true });
    const res = await nodeUpsert(args(graph, 'fresh'), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.equal(state.conflicts, 1);
    assert.deepEqual(state.deletes, ['fresh']);
    assert.equal(state.live.has('fresh'), false, 'nothing is left behind');
});

await test('a restore error that is not a conflict is not retried', async () => {
    const { graph, state } = fakeGraph({ failRestore: true });
    state.live.set('n1', { ...PRIOR });
    const { store } = fakeOutbox({ failVerbatim: true });
    await assert.rejects(() => nodeUpsert(args(graph), { outboxStore: store }), /rollback incomplete/);
    assert.equal(state.upserts.length, 1, 'the failed write only: one restore attempt, which threw before recording');
});

await test('a graph without getNode keeps the pre-3.26 behaviour (delete)', async () => {
    const { graph, state } = fakeGraph({ withoutGetNode: true });
    state.live.set('n1', { ...PRIOR });
    const { store } = fakeOutbox({ failVerbatim: true });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.deepEqual(state.deletes, ['n1']);
});

await test('a store without removeIfPending still retracts the row and restores the node', async () => {
    const { graph, state } = fakeGraph();
    state.live.set('n1', { ...PRIOR });
    const { store, state: ob } = fakeOutbox({ failVerbatim: true, withoutRemoveIfPending: true });
    const res = await nodeUpsert(args(graph), { outboxStore: store });
    assert.equal(res.ok, false);
    assert.equal(state.live.get('n1')!.label, 'original label');
    assert.deepEqual(kinds(ob.entries), []);
});

await test('the pre-write read still supplies the stored access scopes when the caller omits them', async () => {
    const { graph, state } = fakeGraph();
    state.live.set('n1', { ...PRIOR });
    const { store } = fakeOutbox();
    const res = await nodeUpsert(args(graph, 'n1', { skipEmbed: true }), { outboxStore: store });
    assert.equal(res.ok, true);
    assert.deepEqual(state.upserts[0]!.security_scopes, ['team-a']);
    assert.equal(state.gets, 1, 'one read per save, under the lock');
});

await test('restorePayload limits the lifecycle fields to those the failed write carried', () => {
    const prior = { ...PRIOR, status: 'superseded', supersededBy: 'n2', ttl_ms: 5000 } as unknown as LoreNode;
    const p = restorePayload(prior, { id: 'n1', label: 'x', stale: true, ttl_ms: 1, status: null, classification: undefined });
    assert.deepEqual(Object.keys(p).sort(), ['content', 'ecosystem', 'id', 'label', 'metadata', 'project', 'stale', 'tags', 'ttl_ms', 'type']);
    assert.equal(p.stale, false);
    assert.equal(p.ttl_ms, 5000);
    assert.equal(p.label, 'original label', 'content fields are always restored: the local engines overwrite them on every save');
    assert.deepEqual(p.tags, ['keep']);
    assert.deepEqual(p.metadata, { a: 1 });
    assert.equal(restorePayload({ id: 'x', type: 'note', label: 'l', project: 'p', ecosystem: '*' } as unknown as LoreNode, {}).metadata, '{}', 'an absent metadata is restored as empty, not kept from the failed write');
});

await test('restorePayload reaches every lifecycle column the cloud engine keeps when omitted', () => {
    // Dataplane writes a v2 column only when the payload carries a value of the
    // right type; a column the restore leaves out would keep the failed write's value.
    const bare = restorePayload({ id: 'x', type: 'note', label: 'l', project: 'p', ecosystem: '*' } as unknown as LoreNode);
    const cols = nodeV2Columns(bare as never, false, '2026-10-02T00:00:00.000Z');
    for (const c of ['metadata', 'valid_from', 'valid_until', 'status', 'classification', 'classification_expires_at',
        'superseded_by', 'superseded_at', 'superseded_reason', 'stale', 'ephemeral', 'ttl_ms',
        'success_count', 'failure_count', 'partial_count', 'confirmation_score', 'evidence', 'anchor_stale', 'anchor_stale_since', 'anchors']) {
        assert.ok(c in cols, `${c} must be written by a full restore`);
    }
    assert.equal(typeof bare['language'], 'string');
});

await test('restorePayload names every lifecycle field explicitly', () => {
    const p = restorePayload({ id: 'x', type: 'note', label: 'l', project: 'p', ecosystem: '*' } as unknown as LoreNode);
    for (const k of ['content', 'tags', 'security_scopes', 'language', 'ephemeral', 'ttl_ms', 'stale', 'status', 'classification',
        'anchor_stale', 'anchor_stale_since', 'validFrom', 'validUntil', 'supersededBy', 'supersededAt', 'supersededReason']) {
        assert.notEqual(p[k], undefined, `${k} must be explicit so the engine does not keep the failed write's value`);
    }
});

// ───────────────────── Part 2 — a real embedded instance ─────────────────────

const homes: string[] = [];
function seedHome(engine: 'sqlite' | 'surreal'): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-rollback-restore-${engine}-`));
    homes.push(home);
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-02T00:00:00.000Z', graphEngine: engine }],
    }, null, 2));
    return home;
}
const WS = 'default';
type Lore = Awaited<ReturnType<typeof createLore>>;
type TickingReplicator = { stop(): Promise<void>; tickOnce(): Promise<number> };
const outboxOf = (lore: Lore): OutboxStore => lore._daemon.outboxWiring.store as OutboxStore;
const pendingRows = (lore: Lore): Promise<OutboxEntry[]> => outboxOf(lore).listPendingForWorkspace!(WS, 1000);
async function drain(lore: Lore): Promise<void> {
    const r = lore._daemon.outboxWiring.replicator as unknown as TickingReplicator;
    for (let i = 0; i < 40; i++) {
        if ((await pendingRows(lore)).length === 0) return;
        await r.tickOnce();
    }
    assert.fail(`outbox did not drain: ${JSON.stringify((await pendingRows(lore)).map((e) => [e.operationKind, e.status, e.lastError]))}`);
}
const read = (lore: Lore, id: string) => lore.store.storageClient.getNode(id, { workspace: WS });
const SEED = (id: string) => ({
    id, type: 'decision', label: 'original label', content: 'original content', tags: 'alpha,beta',
    project: WS, ecosystem: '*', metadata: JSON.stringify({ origin: 'test', n: 1 }),
    status: 'active', classification: 'strategic', language: 'en', validFrom: '2026-01-01T00:00:00.000Z',
});
const REPLACE = (id: string) => ({
    id, type: 'decision', label: 'REPLACED', content: 'replaced content', tags: 'gamma',
    project: WS, ecosystem: '*', metadata: JSON.stringify({ origin: 'failed write' }),
    stale: true, classification: 'tactical', validUntil: '2027-01-01T00:00:00.000Z',
});
async function seedNode(lore: Lore, id: string): Promise<unknown> {
    const first = await lore.nodeUpsert({ id, workspace: WS, ecosystem: '*', skipEmbed: true, nodeData: SEED(id) });
    assert.ok(first.ok, JSON.stringify(first));
    await drain(lore);
    const before = await read(lore, id);
    assert.ok(before);
    return before;
}
/** Everything a reader sees except the write time and counters a rewrite re-stamps. */
function comparable(node: unknown): Record<string, unknown> {
    const { updatedAt: _u, version: _v, ...rest } = node as Record<string, unknown>;
    return rest;
}
/** Make every `verbatim.upsert` outbox record fail until the returned function is called. */
function failVerbatimRecords(lore: Lore): () => void {
    const store = outboxOf(lore);
    const record = store.record.bind(store);
    const batch = store.batchRecord?.bind(store);
    store.record = async (e: OutboxEntry) => {
        if (e.operationKind === 'verbatim.upsert') throw new Error('injected: outbox full');
        return record(e);
    };
    if (batch) {
        store.batchRecord = async (es: OutboxEntry[]) => {
            if (es.some((e) => e.operationKind === 'verbatim.upsert')) throw new Error('injected: outbox full');
            return batch(es);
        };
    }
    return () => { store.record = record; if (batch) store.batchRecord = batch; };
}

for (const engine of ['sqlite', 'surreal'] as const) {
    console.log(`\nembedded createLore — ${engine} graph\n`);
    const home = seedHome(engine);
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
    await (lore._daemon.outboxWiring.replicator as unknown as TickingReplicator).stop();

    await test(`[${engine}] a failed update leaves the memory exactly as it was`, async () => {
        const first = await lore.nodeUpsert({
            id: 'keep-me', workspace: WS, ecosystem: '*', skipEmbed: true,
            nodeData: {
                id: 'keep-me', type: 'decision', label: 'original label', content: 'original content', tags: 'alpha,beta',
                project: WS, ecosystem: '*', metadata: JSON.stringify({ origin: 'test', n: 1 }),
                status: 'active', classification: 'strategic', language: 'en', validFrom: '2026-01-01T00:00:00.000Z',
            },
        });
        assert.ok(first.ok, JSON.stringify(first));
        await drain(lore);
        const before = await read(lore, 'keep-me');
        assert.ok(before);

        const restore = failVerbatimRecords(lore);
        let res: { ok: boolean };
        try {
            res = await lore.nodeUpsert({
                id: 'keep-me', workspace: WS, ecosystem: '*',
                nodeData: {
                    id: 'keep-me', type: 'decision', label: 'REPLACED', content: 'replaced content', tags: 'gamma',
                    project: WS, ecosystem: '*', metadata: JSON.stringify({ origin: 'failed write' }),
                    stale: true, classification: 'tactical', validUntil: '2027-01-01T00:00:00.000Z',
                },
            });
        } finally { restore(); }
        assert.equal(res.ok, false, 'the update must report failure');

        const after = await read(lore, 'keep-me');
        assert.ok(after, 'the memory that existed before the failed update must still exist');
        assert.deepEqual(comparable(after), comparable(before));
        assert.equal((await pendingRows(lore)).filter((e) => e.operationKind === 'node.upsert').length, 0, 'the failed write left no save row');
        await drain(lore);
        assert.deepEqual(comparable(await read(lore, 'keep-me')), comparable(before), 'and a replay does not change it');
    });

    await test(`[${engine}] a graph write that lands and then throws is undone`, async () => {
        const before = await seedNode(lore, 'half-applied');
        type RawGraph = { upsertNode(n: unknown): Promise<unknown> };
        const graph = lore.store.storageClient.rawGraph() as unknown as RawGraph;
        const original = graph.upsertNode;
        let thrown = 0;
        graph.upsertNode = async function (this: RawGraph, n: unknown) {
            const out = await original.call(this, n);
            if (thrown++ === 0) throw new Error('injected: connection lost after the write landed');
            return out;
        };
        try {
            await assert.rejects(() => lore.nodeUpsert({ id: 'half-applied', workspace: WS, ecosystem: '*', nodeData: REPLACE('half-applied') }), /connection lost/);
        } finally { graph.upsertNode = original; }
        assert.equal(thrown, 2, 'the failed write, then the restore');
        assert.deepEqual(comparable(await read(lore, 'half-applied')), comparable(before));
        assert.equal((await pendingRows(lore)).length, 0, 'no row left to replay');
    });

    await test(`[${engine}] a failed update whose row the replicator already claimed → the replay ends on the previous node`, async () => {
        const before = await seedNode(lore, 'claimed');
        const store = outboxOf(lore);
        const removeIfPending = store.removeIfPending;
        store.removeIfPending = async () => false;
        const restore = failVerbatimRecords(lore);
        let res: { ok: boolean };
        try {
            res = await lore.nodeUpsert({ id: 'claimed', workspace: WS, ecosystem: '*', nodeData: REPLACE('claimed') });
        } finally { restore(); store.removeIfPending = removeIfPending; }
        assert.equal(res.ok, false);
        assert.deepEqual(comparable(await read(lore, 'claimed')), comparable(before));
        const rows = (await pendingRows(lore)).filter((e) => (e.payload as { id?: unknown })?.id === 'claimed');
        assert.deepEqual(rows.map((e) => e.operationKind), ['node.upsert', 'node.upsert'], 'the claimed row and a compensating save');
        await drain(lore);
        const end = await read(lore, 'claimed');
        assert.ok(end, 'the replay must not delete the node');
        assert.deepEqual(comparable(end), comparable(before));
    });

    await test(`[${engine}] a failed create leaves nothing behind`, async () => {
        const restore = failVerbatimRecords(lore);
        let res: { ok: boolean };
        try {
            res = await lore.nodeUpsert({
                id: 'never-was', workspace: WS, ecosystem: '*',
                nodeData: { id: 'never-was', type: 'note', label: 'x', content: 'y', tags: '', project: WS, ecosystem: '*', metadata: '{}' },
            });
        } finally { restore(); }
        assert.equal(res.ok, false);
        assert.equal(await read(lore, 'never-was'), null);
        await drain(lore);
        assert.equal(await read(lore, 'never-was'), null);
    });

    await test(`[${engine}] the memory can be updated normally afterwards`, async () => {
        const res = await lore.nodeUpsert({
            id: 'keep-me', workspace: WS, ecosystem: '*', skipEmbed: true,
            nodeData: { id: 'keep-me', type: 'decision', label: 'second label', content: 'second content', tags: 'alpha', project: WS, ecosystem: '*', metadata: '{}' },
        });
        assert.ok(res.ok, JSON.stringify(res));
        await drain(lore);
        assert.equal((await read(lore, 'keep-me'))!.label, 'second label');
    });

    await lore.dispose('test-done');
}

for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
