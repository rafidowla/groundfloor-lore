#!/usr/bin/env tsx
/**
 * replay-newest-save-unit.ts — 3.26.0: embedded outbox replay leaves a node on
 * its NEWEST queued save.
 *
 * The defect: a `node.delete` row that Lore did not note as applied inline is
 * replayed and removes the node. When two saves of that node were queued
 * behind the delete, the first save's row re-created the node with ITS
 * payload, and the second save's row then found the node present and skipped
 * (replay never overwrites an existing node). The node ended on the older
 * save's content.
 *
 * The fix, pinned here:
 *   - `OutboxStore.newestNodeUpsertAfter(workspace, nodeId, sequenceId)`
 *     (SQLite and file stores) answers "the newest queued save of this node
 *     after this position";
 *   - when a replayed save is about to re-create a missing node, the newest
 *     queued save's payload is written instead, and that newest row decides
 *     whether to write at all (a save of this lifetime whose node the host
 *     removed since is still not resurrected);
 *   - a replayed delete that finds the node present with a save of this
 *     lifetime queued behind it is skipped: the node already holds that write,
 *     and removing it would also drop its relationships;
 *   - without the lookup (a custom store, a row with no position) or when it
 *     fails, the row's own payload is used, as before;
 *   - a newest save that fails to write is never replaced by the older one:
 *     the row fails and retries, and when it can never be written both rows
 *     dead-letter with the node absent (a requeue re-drives them).
 *
 * Part 1 drives the guard with a fake graph. Part 2 checks the store method on
 * both stores. Part 3 boots a real embedded `createLore()` per graph engine.
 *
 * Run: npx tsx test/replay-newest-save-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLore } from '../packages/lore/src/index.js';
import {
    embeddedGuardedGraph, createEmbeddedReplayScope, noteInlineAppliedDelete,
    type EmbeddedReplayScope, type ReplayEntryRef, type NewerSaveLookup,
} from '../packages/lore/src/mcp/embeddedLifecycle.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { NEWEST_NODE_UPSERT_AFTER_SQL, ensureNodeUpsertIdIndex } from '../packages/lore/src/outbox/supersession.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

// ───────────────────────── Part 1 — the guard ─────────────────────────

type Rec = { id: string; label?: string };
class FakeGraph {
    nodes = new Map<string, Rec>();
    upserts: Rec[] = [];
    deletes = 0;
    async getNode(id: string): Promise<Rec | null> { return this.nodes.get(id) ?? null; }
    async upsertNode(n: Rec): Promise<Rec> { this.upserts.push({ ...n }); this.nodes.set(n.id, { ...n }); return n; }
    async deleteNode(id: string): Promise<boolean> { this.deletes++; return this.nodes.delete(id); }
}
interface Guarded {
    replayNodeUpsert(n: Rec, entry?: ReplayEntryRef, newer?: NewerSaveLookup): Promise<Rec | null>;
    replayNodeDelete(id: string, entry?: ReplayEntryRef, newer?: NewerSaveLookup): Promise<boolean>;
}
const guarded = (graph: FakeGraph, scope?: EmbeddedReplayScope): Guarded =>
    embeddedGuardedGraph(graph as never, scope) as unknown as Guarded;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
type QueuedRow = ReplayEntryRef & { payload: Rec };
/** A queued `node.upsert` row, recorded `age` ms ago at position `seq`. */
const saveRow = (rowId: string, seq: number, payload: Rec, over: Partial<ReplayEntryRef> = {}): QueuedRow => ({
    id: rowId, operation: 'graph.upsert', operationKind: 'node.upsert', workspace: 'w',
    sequenceId: seq, createdAt: ago(10_000 - seq * 100), payload, ...over,
});
const delRow = (rowId: string, seq: number): ReplayEntryRef => ({
    id: rowId, operation: 'graph.delete', operationKind: 'node.delete', workspace: 'w', sequenceId: seq, createdAt: ago(10_000 - seq * 100),
});
function bootedScope(preBoot: string[] = []): EmbeddedReplayScope {
    const scope = createEmbeddedReplayScope();
    scope.preBootNodeUpserts = new Set(preBoot);
    return scope;
}
/** The lookup the wiring builds: newest queued save after `after`, counting calls. */
function lookupOver(rows: QueuedRow[], after: ReplayEntryRef): NewerSaveLookup & { calls: number } {
    const fn = (async () => {
        fn.calls++;
        const later = rows.filter((r) => (r.sequenceId as number) > (after.sequenceId as number));
        return later.sort((a, b) => (b.sequenceId as number) - (a.sequenceId as number))[0] ?? null;
    }) as NewerSaveLookup & { calls: number };
    fn.calls = 0;
    return fn;
}

console.log('\nembedded replay: the newest queued save wins (3.26.0)\n');

await test('two saves left unfinished behind a replayed delete → the node ends on the SECOND save', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'second' }); // both saves were applied inline before the crash
    const s1 = saveRow('s1', 2, { id: 'a', label: 'first' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const scope = bootedScope(['s1', 's2']);
    const gg = guarded(g, scope);
    const del = delRow('d', 1);
    assert.equal(await gg.replayNodeDelete('a', del, lookupOver([s1, s2], del)), true, 'the delete is applied (the saves are from before boot)');
    await gg.replayNodeUpsert(s1.payload, s1, lookupOver([s1, s2], s1));
    assert.equal(g.nodes.get('a')?.label, 'second', 'the re-create writes the newest queued save, not the row in hand');
    await gg.replayNodeUpsert(s2.payload, s2, lookupOver([s1, s2], s2));
    assert.equal(g.nodes.get('a')?.label, 'second');
    assert.deepEqual(g.upserts, [{ id: 'a', label: 'second' }], 'exactly one write');
    assert.equal(scope.preBootNodeUpserts!.size, 0, 'both rows left the boot snapshot');
    assert.equal(scope.lastDelete.get('w\u0000a')?.replayRemovedAt, undefined, 'the removal is settled');
});

await test('…and without a lookup the row in hand is written (a store that cannot answer)', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'second' });
    const s1 = saveRow('s1', 2, { id: 'a', label: 'first' });
    const gg = guarded(g, bootedScope(['s1', 's2']));
    await gg.replayNodeDelete('a', delRow('d', 1));
    await gg.replayNodeUpsert(s1.payload, s1);
    assert.equal(g.nodes.get('a')?.label, 'first', 'pre-3.26 behaviour, documented');
});

await test('saves of this lifetime queued behind an un-applied delete → the delete is skipped, the node untouched', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'second' });
    const s1 = saveRow('s1', 2, { id: 'a', label: 'first' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const scope = bootedScope();
    const gg = guarded(g, scope);
    const del = delRow('d', 1);
    assert.equal(await gg.replayNodeDelete('a', del, lookupOver([s1, s2], del)), false);
    assert.equal(g.deletes, 0, 'the node (and its relationships) is not removed');
    await gg.replayNodeUpsert(s1.payload, s1, lookupOver([s1, s2], s1));
    await gg.replayNodeUpsert(s2.payload, s2, lookupOver([s1, s2], s2));
    assert.equal(g.nodes.get('a')?.label, 'second');
    assert.equal(g.upserts.length, 0, 'nothing is rewritten');
    assert.equal(scope.lastDelete.get('w\u0000a')?.sequenceId, 1, 'the delete stays on record');
    assert.equal(scope.lastDelete.get('w\u0000a')?.replayRemovedAt, undefined);
});

await test('a skipped delete still supersedes an OLDER save retried after it', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'second' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const scope = bootedScope(['s0']);
    const gg = guarded(g, scope);
    const del = delRow('d', 2);
    assert.equal(await gg.replayNodeDelete('a', del, lookupOver([s2], del)), false);
    // The host then removes the node; the pre-boot save recorded BEFORE the delete must not bring it back.
    g.nodes.delete('a');
    const s0 = saveRow('s0', 1, { id: 'a', label: 'stale' });
    assert.equal(await gg.replayNodeUpsert(s0.payload, s0, async () => null), null);
    assert.equal(g.nodes.has('a'), false);
});

await test('the delete is NOT skipped when the node is absent (and the outbox is not consulted)', async () => {
    const g = new FakeGraph();
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const del = delRow('d', 1);
    const lookup = lookupOver([s2], del);
    assert.equal(await guarded(g, bootedScope()).replayNodeDelete('a', del, lookup), false);
    assert.equal(g.deletes, 1);
    assert.equal(lookup.calls, 0);
});

await test('the delete is NOT skipped for a newer save from before boot', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'old' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const del = delRow('d', 1);
    assert.equal(await guarded(g, bootedScope(['s2'])).replayNodeDelete('a', del, lookupOver([s2], del)), true);
    assert.equal(g.nodes.has('a'), false);
});

await test('the delete is NOT skipped for a newer save from a producer that does not write inline', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'old' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' }, { operation: 'stream.ingest' });
    const del = delRow('d', 1);
    assert.equal(await guarded(g, bootedScope()).replayNodeDelete('a', del, lookupOver([s2], del)), true);
    assert.equal(g.nodes.has('a'), false, 'the node did not hold that save yet; its row re-creates it');
    await guarded(g, bootedScope()).replayNodeUpsert(s2.payload, s2, async () => null);
    assert.equal(g.nodes.get('a')?.label, 'second');
});

await test('the delete is NOT skipped before replication has a boot snapshot', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const del = delRow('d', 1);
    const lookup = lookupOver([s2], del);
    assert.equal(await guarded(g, createEmbeddedReplayScope()).replayNodeDelete('a', del, lookup), true);
    assert.equal(lookup.calls, 0);
});

await test('a delete applied inline is skipped before any lookup', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'second' });
    const scope = bootedScope();
    const del = delRow('d', 1);
    noteInlineAppliedDelete(scope, del, 'a');
    const lookup = lookupOver([saveRow('s2', 2, { id: 'a', label: 'second' })], del);
    assert.equal(await guarded(g, scope).replayNodeDelete('a', del, lookup), false);
    assert.equal(lookup.calls, 0);
    assert.equal(g.deletes, 0);
});

await test('a pre-boot save with a NEWER save of this lifetime whose node the host removed → stays deleted', async () => {
    const g = new FakeGraph();
    const s1 = saveRow('s1', 1, { id: 'a', label: 'crash-left' });
    const s2 = saveRow('s2', 2, { id: 'a', label: 'live' }); // applied inline, then the host raw-deleted the node
    const scope = bootedScope(['s1']);
    const gg = guarded(g, scope);
    assert.equal(await gg.replayNodeUpsert(s1.payload, s1, lookupOver([s1, s2], s1)), null);
    assert.equal(await gg.replayNodeUpsert(s2.payload, s2, lookupOver([s1, s2], s2)), null);
    assert.equal(g.nodes.has('a'), false, 'crash recovery of the older save must not undo the host delete of the newer one');
    assert.equal(g.upserts.length, 0);
    assert.equal(scope.skippedDeleted, 2);
    assert.equal(scope.preBootNodeUpserts!.size, 0);
});

await test('a pre-boot save with a newer pre-boot save → the newer content, written once', async () => {
    const g = new FakeGraph();
    const s1 = saveRow('s1', 1, { id: 'a', label: 'first' });
    const s2 = saveRow('s2', 2, { id: 'a', label: 'second' });
    const gg = guarded(g, bootedScope(['s1', 's2']));
    await gg.replayNodeUpsert(s1.payload, s1, lookupOver([s1, s2], s1));
    await gg.replayNodeUpsert(s2.payload, s2, lookupOver([s1, s2], s2));
    assert.deepEqual(g.upserts, [{ id: 'a', label: 'second' }]);
});

await test('the outbox is not consulted for a row that would not re-create the node', async () => {
    const g = new FakeGraph();
    const s1 = saveRow('s1', 1, { id: 'a', label: 'live' });
    const lookup = lookupOver([s1, saveRow('s2', 2, { id: 'a', label: 'later' })], s1);
    assert.equal(await guarded(g, bootedScope()).replayNodeUpsert(s1.payload, s1, lookup), null);
    assert.equal(lookup.calls, 0, 'a bulk raw delete must not turn into one outbox scan per row');
    g.nodes.set('b', { id: 'b' });
    const sb = saveRow('sb', 3, { id: 'b' });
    const lookupB = lookupOver([], sb);
    await guarded(g, bootedScope()).replayNodeUpsert(sb.payload, sb, lookupB);
    assert.equal(lookupB.calls, 0, 'nor for a node that already exists');
});

await test('a lookup that throws falls back to the row in hand', async () => {
    const g = new FakeGraph();
    const s1 = saveRow('s1', 1, { id: 'a', label: 'first' });
    const out = await guarded(g, bootedScope(['s1'])).replayNodeUpsert(s1.payload, s1, async () => { throw new Error('outbox busy'); });
    assert.equal(out?.label, 'first');
    g.nodes.set('b', { id: 'b' });
    assert.equal(await guarded(g, bootedScope()).replayNodeDelete('b', delRow('d', 1), async () => { throw new Error('outbox busy'); }), true,
        'and a delete whose lookup fails is applied as before');
});

await test('a lookup that answers with another node\'s row is ignored', async () => {
    const g = new FakeGraph();
    const s1 = saveRow('s1', 1, { id: 'a', label: 'first' });
    const other = saveRow('sx', 2, { id: 'zzz', label: 'someone else' });
    await guarded(g, bootedScope(['s1'])).replayNodeUpsert(s1.payload, s1, async () => other);
    assert.equal(g.nodes.get('a')?.label, 'first');
    assert.equal(g.nodes.has('zzz'), false);
});

await test('a save of this lifetime that landed after the removal still wins over the queue', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'second' });
    const s1 = saveRow('s1', 2, { id: 'a', label: 'first' });
    const s2 = saveRow('s2', 3, { id: 'a', label: 'second' });
    const gg = guarded(g, bootedScope(['s1', 's2']));
    await gg.replayNodeDelete('a', delRow('d', 1), async () => s2);
    g.nodes.set('a', { id: 'a', label: 'third (inline)' }); // the host saves again before the rows replay
    await gg.replayNodeUpsert(s1.payload, s1, async () => s2);
    await gg.replayNodeUpsert(s2.payload, s2, async () => null);
    assert.equal(g.nodes.get('a')?.label, 'third (inline)', 'an existing node is never overwritten by a replay');
    assert.equal(g.upserts.length, 0);
});

/** A graph that refuses to store one payload while `refusing` is set. */
class PoisonGraph extends FakeGraph {
    refused = 0;
    refusing = true;
    constructor(private readonly poisonLabel: string) { super(); }
    override async upsertNode(n: Rec): Promise<Rec> {
        if (this.refusing && n.label === this.poisonLabel) { this.refused++; throw new Error('engine refuses this payload'); }
        return super.upsertNode(n);
    }
}

await test('the newest queued save cannot be written → the row fails and is retried (the older content is NOT written)', async () => {
    // Whatever the row's attempt count: there is no point at which it gives
    // up on the newest save and writes its own (3.26.0 review, choice 6).
    for (const attempts of [undefined, 0, 1, 2, 4, 50]) {
        const g = new PoisonGraph('second');
        const s1 = saveRow('s1', 1, { id: 'a', label: 'first' }, attempts === undefined ? {} : { attempts });
        const s2 = saveRow('s2', 2, { id: 'a', label: 'second' });
        const scope = bootedScope(['s1', 's2']);
        await assert.rejects(() => guarded(g, scope).replayNodeUpsert(s1.payload, s1, async () => s2), /engine refuses/);
        assert.equal(g.nodes.has('a'), false, `attempts=${attempts}: the older save must not be written in its place`);
        assert.equal(g.upserts.length, 0, `attempts=${attempts}: nothing was written`);
        assert.equal(g.refused, 1, `attempts=${attempts}: one write attempt, of the newest save`);
        assert.equal(scope.preBootNodeUpserts!.has('s1'), true, `attempts=${attempts}: the row is not settled, so its retry decides the same way`);
    }
});

await test('a passing failure of the newest save → the node still ends on the newest save, whichever row lands first', async () => {
    // The older row retries after the engine recovered.
    const g = new PoisonGraph('second');
    const s1 = saveRow('s1', 1, { id: 'a', label: 'first' });
    const s2 = saveRow('s2', 2, { id: 'a', label: 'second' });
    const scope = bootedScope(['s1', 's2']);
    const gg = guarded(g, scope);
    await assert.rejects(() => gg.replayNodeUpsert(s1.payload, s1, async () => s2), /engine refuses/);
    g.refusing = false;
    await gg.replayNodeUpsert(s1.payload, { ...s1, attempts: 1 }, async () => s2);
    await gg.replayNodeUpsert(s2.payload, s2, async () => null);
    assert.equal(g.nodes.get('a')?.label, 'second');
    assert.deepEqual(g.upserts.map((u) => u.label), ['second'], 'written once');

    // The newer row is replayed first (the older one is still backing off).
    const g2 = new PoisonGraph('second');
    const scope2 = bootedScope(['s1', 's2']);
    const gg2 = guarded(g2, scope2);
    await assert.rejects(() => gg2.replayNodeUpsert(s1.payload, s1, async () => s2), /engine refuses/);
    g2.refusing = false;
    await gg2.replayNodeUpsert(s2.payload, s2, async () => null);
    assert.equal(g2.nodes.get('a')?.label, 'second', 'the newer row re-creates the node with its own payload');
    await gg2.replayNodeUpsert(s1.payload, { ...s1, attempts: 1 }, async () => s2);
    assert.equal(g2.nodes.get('a')?.label, 'second', 'and the older row then finds the node present and skips');
    assert.deepEqual(g2.upserts.map((u) => u.label), ['second']);
    assert.equal(scope2.preBootNodeUpserts!.size, 0, 'both rows are settled');
});

await test('a newest save that can NEVER be written → both rows keep failing, the node stays absent, and a requeue recovers it', async () => {
    const g = new PoisonGraph('second');
    const s1 = saveRow('s1', 1, { id: 'a', label: 'first' });
    const s2 = saveRow('s2', 2, { id: 'a', label: 'second' });
    const scope = bootedScope(['s1', 's2']);
    const gg = guarded(g, scope);
    // The replicator's whole attempt budget, for both rows (the lookup still
    // answers s2 for s1: a failed row is a queued save).
    for (let attempts = 0; attempts < 5; attempts++) {
        await assert.rejects(() => gg.replayNodeUpsert(s1.payload, { ...s1, attempts }, async () => s2), /engine refuses/);
        await assert.rejects(() => gg.replayNodeUpsert(s2.payload, { ...s2, attempts }, async () => null), /engine refuses/);
    }
    assert.equal(g.nodes.has('a'), false, 'absent, and visibly so (two dead rows), not silently on the older content');
    assert.equal(g.upserts.length, 0);
    assert.deepEqual([...scope.preBootNodeUpserts!].sort(), ['s1', 's2'], 'neither row was settled, so a requeue still re-creates');
    // `lore outbox requeue-dead` after the cause is fixed. s2 is dead until it
    // is requeued too, so the lookup may answer nothing for s1.
    g.refusing = false;
    await gg.replayNodeUpsert(s2.payload, { ...s2, attempts: 0 }, async () => null);
    await gg.replayNodeUpsert(s1.payload, { ...s1, attempts: 0 }, async () => s2);
    assert.equal(g.nodes.get('a')?.label, 'second');
    assert.deepEqual(g.upserts.map((u) => u.label), ['second']);
});

await test('a row whose OWN payload cannot be written keeps failing whatever its attempt count', async () => {
    const g = new PoisonGraph('first');
    const s1 = saveRow('s1', 1, { id: 'a', label: 'first' }, { attempts: 4 });
    await assert.rejects(() => guarded(g, bootedScope(['s1'])).replayNodeUpsert(s1.payload, s1, async () => null), /engine refuses/);
    assert.equal(g.refused, 1, 'written once, not twice');
});

// ───────────────────── Part 2 — the store method ─────────────────────

const dirs: string[] = [];
function mkDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}
type Closable = OutboxStore & { close?: () => void };
const recSave = (store: OutboxStore, ws: string, id: string, label: string) => recordHotWrite(store, {
    workspace: ws, operationKind: 'node.upsert', operation: 'graph.upsert', payload: { id, type: 'note', label },
});

console.log('\noutbox stores — newestNodeUpsertAfter\n');

for (const [name, make] of [
    ['SqliteOutboxStore', (dir: string) => new SqliteOutboxStore(dir, { retryBaseMs: 20 }) as Closable],
    ['FileOutboxStore', (dir: string) => new FileOutboxStore(dir) as Closable],
] as const) {
    await test(`${name}: answers the newest queued save of the node after a position`, async () => {
        const store = make(mkDir('lore-newest-save-'));
        assert.equal(typeof store.newestNodeUpsertAfter, 'function');
        const del = await recordHotWrite(store, { workspace: 'w1', operationKind: 'node.delete', operation: 'graph.delete', payload: { id: 'a' } });
        const s1 = await recSave(store, 'w1', 'a', 'first');
        const other = await recSave(store, 'w1', 'b', 'another node');
        const s2 = await recSave(store, 'w1', 'a', 'second');
        const foreign = await recSave(store, 'w2', 'a', 'another workspace');
        const laterDelete = await recordHotWrite(store, { workspace: 'w1', operationKind: 'node.delete', operation: 'graph.delete', payload: { id: 'a' } });
        for (const e of [del, s1, other, s2, foreign, laterDelete]) assert.equal(typeof e.sequenceId, 'number');

        const afterDel = await store.newestNodeUpsertAfter!('w1', 'a', del.sequenceId!);
        assert.equal(afterDel?.id, s2.id, 'the newest save, not the first one after the position');
        assert.equal((afterDel!.payload as { label: string }).label, 'second');
        assert.equal(afterDel!.operation, 'graph.upsert', 'the row carries what the guard needs to decide');
        assert.equal(afterDel!.sequenceId, s2.sequenceId);
        assert.equal((await store.newestNodeUpsertAfter!('w1', 'a', s1.sequenceId!))?.id, s2.id);
        assert.equal(await store.newestNodeUpsertAfter!('w1', 'a', s2.sequenceId!), null, 'strictly after: a row is not newer than itself');
        assert.equal((await store.newestNodeUpsertAfter!('w1', 'b', 0))?.id, other.id, 'per node');
        assert.equal((await store.newestNodeUpsertAfter!('w2', 'a', 0))?.id, foreign.id, 'per workspace');
        assert.equal(await store.newestNodeUpsertAfter!('w1', 'missing', 0), null);
        assert.equal(await store.newestNodeUpsertAfter!('w3', 'a', 0), null);
        store.close?.();
    });

    await test(`${name}: a dead or already-replayed row is not a queued save; a claimed one still is`, async () => {
        const store = make(mkDir('lore-newest-save-'));
        const s1 = await recSave(store, 'w1', 'a', 'first');
        const s2 = await recSave(store, 'w1', 'a', 'second');
        await store.markEntryStatus!(s2.id, 'dead', { error: 'gave up' });
        assert.equal((await store.newestNodeUpsertAfter!('w1', 'a', 0))?.id, s1.id, 'the dead row is skipped');
        assert.equal(await store.claimForReplication!(s1.id), true);
        assert.equal((await store.newestNodeUpsertAfter!('w1', 'a', 0))?.id, s1.id, 'a row being replayed still counts');
        await store.markEntryStatus!(s1.id, 'replicated');
        assert.equal(await store.newestNodeUpsertAfter!('w1', 'a', 0), null, 'a replayed row is history, not a queued save');
        store.close?.();
    });
}

await test('SqliteOutboxStore: the lookup is served by its own index, created when the store opens', async () => {
    const store = new SqliteOutboxStore(mkDir('lore-newest-save-'), { retryBaseMs: 20 });
    type Db = { prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>> } };
    const db = (store as unknown as { db: Db }).db;
    const indexed = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_outbox_node_upsert_id'").all().length;
    assert.equal(indexed(), 1, 'present before any lookup: no lazy DDL on the replay path');
    for (let i = 0; i < 50; i++) await recSave(store, 'w1', `n${i % 10}`, `save ${i}`);
    assert.equal(((await store.newestNodeUpsertAfter!('w1', 'n3', 0))!.payload as { label: string }).label, 'save 43');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${NEWEST_NODE_UPSERT_AFTER_SQL}`).all('w1', 'n3', 0).map((r) => String(r['detail'])).join(' | ');
    assert.match(plan, /idx_outbox_node_upsert_id/, `the lookup must not scan the workspace's rows: ${plan}`);
    store.close();
});

await test('SqliteOutboxStore: an outbox from before 3.26.0 gets the index on its next open', async () => {
    const dir = mkDir('lore-newest-save-');
    type RawExec = { db: { exec(sql: string): void; prepare(sql: string): { all(): unknown[] } } };
    const first = new SqliteOutboxStore(dir, { retryBaseMs: 20 });
    for (let i = 0; i < 20; i++) await recSave(first, 'w1', `n${i % 4}`, `save ${i}`);
    (first as unknown as RawExec).db.exec('DROP INDEX idx_outbox_node_upsert_id'); // what a 3.25 file looks like
    first.close();
    const second = new SqliteOutboxStore(dir, { retryBaseMs: 20 });
    const raw = (second as unknown as RawExec).db;
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_outbox_node_upsert_id'").all().length, 1);
    assert.equal(((await second.newestNodeUpsertAfter!('w1', 'n1', 0))!.payload as { label: string }).label, 'save 17');
    second.close();
});

await test('SqliteOutboxStore: a damaged payload does not switch the lookup off for its workspace', async () => {
    const dir = mkDir('lore-newest-save-');
    type RawExec = { db: { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>>; run(...p: unknown[]): unknown } } };
    const first = new SqliteOutboxStore(dir, { retryBaseMs: 20 });
    const s1 = await recSave(first, 'w1', 'a', 'first');
    const bad = await recSave(first, 'w1', 'a', 'will be damaged');
    await recSave(first, 'w1', 'a', 'second');
    const badNewest = await recSave(first, 'w1', 'b', 'only save of b, damaged');
    const raw1 = (first as unknown as RawExec).db;
    raw1.exec('DROP INDEX idx_outbox_node_upsert_id'); // what a 3.25 file looks like
    raw1.prepare("UPDATE outbox_entries SET payload = '{not json' WHERE id IN (?, ?)").run(bad.id, badNewest.id);
    first.close();
    const second = new SqliteOutboxStore(dir, { retryBaseMs: 20 }); // must not throw
    const raw2 = (second as unknown as RawExec).db;
    assert.equal(raw2.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_outbox_node_upsert_id'").all().length, 1, 'the index is built over the damaged rows');
    assert.equal(((await second.newestNodeUpsertAfter!('w1', 'a', 0))!.payload as { label: string }).label, 'second', 'the same workspace and node still answer');
    assert.equal(((await second.newestNodeUpsertAfter!('w1', 'a', s1.sequenceId!))!.payload as { label: string }).label, 'second');
    assert.equal(await second.newestNodeUpsertAfter!('w1', 'b', 0), null, 'a damaged row is never returned as a save');
    const plan = raw2.prepare(`EXPLAIN QUERY PLAN ${NEWEST_NODE_UPSERT_AFTER_SQL}`).all('w1', 'a', 0).map((r) => String(r['detail'])).join(' | ');
    assert.match(plan, /idx_outbox_node_upsert_id/, `still served by the index: ${plan}`);
    assert.equal((await recSave(second, 'w1', 'a', 'third')).status, 'pending', 'and the store still records');
    assert.equal(((await second.newestNodeUpsertAfter!('w1', 'a', 0))!.payload as { label: string }).label, 'third');
    second.close();
});

await test('SqliteOutboxStore: a damaged replicated row does not make the same-key (RA-6) lookup throw', async () => {
    const dir = mkDir('lore-newest-save-');
    type RawExec = { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } };
    const store = new SqliteOutboxStore(dir, { retryBaseMs: 20 });
    const s1 = await recSave(store, 'w1', 'a', 'first');
    const bad = await recSave(store, 'w1', 'a', 'will be damaged');
    const good = await recSave(store, 'w1', 'a', 'replicated later');
    const db = (store as unknown as RawExec).db;
    db.prepare("UPDATE outbox_entries SET payload = '{not json', status = 'replicated' WHERE id = ?").run(bad.id);
    assert.equal(await store.hasNewerReplicatedForKey('w1', 'node', 'a', s1.sequenceId!), false, 'the damaged row matches no key');
    db.prepare("UPDATE outbox_entries SET status = 'replicated' WHERE id = ?").run(good.id);
    assert.equal(await store.hasNewerReplicatedForKey('w1', 'node', 'a', s1.sequenceId!), true, 'a readable newer row still supersedes');
    db.prepare("UPDATE outbox_entries SET operationKind = 'edge.upsert' WHERE id = ?").run(bad.id);
    assert.equal(await store.hasNewerReplicatedForKey('w1', 'edge', 'a\u0000b\u0000r', 0), false, 'the edge family key is guarded too');
    store.close();
});

await test('ensureNodeUpsertIdIndex reports a failed build instead of throwing', () => {
    assert.equal(ensureNodeUpsertIdIndex({ exec: () => { throw new Error('database is locked'); } }), false);
    let ran = '';
    assert.equal(ensureNodeUpsertIdIndex({ exec: (sql: string) => { ran = sql; } }), true);
    assert.match(ran, /CREATE INDEX IF NOT EXISTS idx_outbox_node_upsert_id/);
});

// ───────────────────── Part 3 — a real embedded instance ─────────────────────

const WS = 'default';
type Lore = Awaited<ReturnType<typeof createLore>>;
type TickingReplicator = { stop(): Promise<void>; tickOnce(): Promise<number> };
type RawDb = { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } };
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

function seedHome(engine: 'sqlite' | 'surreal'): string {
    const home = mkDir(`lore-newest-save-${engine}-`);
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-02T00:00:00.000Z', graphEngine: engine }],
    }, null, 2));
    return home;
}
async function boot(home: string): Promise<Lore> {
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
    await (lore._daemon.outboxWiring.replicator as unknown as TickingReplicator).stop();
    return lore;
}
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
const nodeData = (id: string, label: string): Record<string, unknown> =>
    ({ id, type: 'note', label, content: `${label} body for ${id}`, tags: '', project: WS, ecosystem: '*', metadata: '{}' });
const save = (lore: Lore, id: string, label: string) =>
    lore.nodeUpsert({ id, workspace: WS, ecosystem: '*', skipEmbed: true, nodeData: nodeData(id, label) });
const read = (lore: Lore, id: string) => lore.store.storageClient.getNode(id, { workspace: WS });
type RawGraph = {
    deleteNode(id: string): Promise<boolean>;
    addEdge(e: { sourceId: string; targetId: string; relation: string }): Promise<void>;
    queryEdges(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<unknown[]>;
};
const outboxDirOf = (lore: Lore): string => path.dirname((outboxOf(lore) as unknown as { dbPath: string }).dbPath);
const raw = (lore: Lore): RawGraph => lore.store.storageClient.rawGraph() as unknown as RawGraph;
/** An un-noted delete: recorded in the outbox by a producer that does not tell the replay guard. */
const recordUnnotedDelete = (store: OutboxStore, id: string) =>
    recordHotWrite(store, { workspace: WS, operationKind: 'node.delete', operation: 'graph.delete', payload: { id } });

for (const engine of ['sqlite', 'surreal'] as const) {
    console.log(`\nembedded createLore — ${engine} graph\n`);
    const home = seedHome(engine);
    let lore = await boot(home);
    await test(`[${engine}] the embedded outbox store answers the newest-save lookup`, () => {
        assert.equal(typeof outboxOf(lore).newestNodeUpsertAfter, 'function');
    });

    await test(`[${engine}] crash with a delete and two saves unfinished → the node ends on the second save`, async () => {
        assert.ok((await save(lore, 'crashy', 'original')).ok);
        await drain(lore);
        // The previous process: delete (not noted), save "first", save
        // "second" — every graph write landed, no row was replayed.
        await raw(lore).deleteNode('crashy');
        await recordUnnotedDelete(outboxOf(lore), 'crashy');
        assert.ok((await save(lore, 'crashy', 'first')).ok);
        assert.ok((await save(lore, 'crashy', 'second')).ok);
        assert.deepEqual((await pendingRows(lore)).map((e) => e.operationKind), ['node.delete', 'node.upsert', 'node.upsert']);
        const outboxDir = outboxDirOf(lore);
        await lore.dispose('crash-sim');
        // Hold the three rows back so the restarted replicator cannot replay
        // them before the test has looked at the boot snapshot.
        const store = new SqliteOutboxStore(outboxDir);
        const left = await store.listPendingForWorkspace(WS, 100);
        assert.deepEqual(left.map((e) => e.operationKind), ['node.delete', 'node.upsert', 'node.upsert'], 'the rows survive the shutdown unfinished');
        (store as unknown as RawDb).db.prepare("UPDATE outbox_entries SET nextAttemptAt = ? WHERE status = 'pending'").run(FAR_FUTURE);
        store.close();
        lore = await boot(home);
        assert.equal(lore._daemon.replayScope!.preBootNodeUpserts?.size, 2, 'both saves are in the boot snapshot');
        assert.equal((await read(lore, 'crashy'))?.label, 'second');
        (outboxOf(lore) as unknown as RawDb).db.prepare('UPDATE outbox_entries SET nextAttemptAt = NULL').run();
        await drain(lore);
        const node = await read(lore, 'crashy');
        assert.ok(node, 'the node exists after the replay');
        assert.equal(node!.label, 'second', 'the newest save is the node\'s content');
        assert.equal(node!.content, 'second body for crashy');
    });

    await test(`[${engine}] delete and two saves all in this lifetime → the node and its relationships are untouched`, async () => {
        assert.ok((await save(lore, 'anchor', 'anchor')).ok);
        assert.ok((await save(lore, 'lively', 'original')).ok);
        await drain(lore);
        await raw(lore).deleteNode('lively');
        await recordUnnotedDelete(outboxOf(lore), 'lively');
        assert.ok((await save(lore, 'lively', 'first')).ok);
        assert.ok((await save(lore, 'lively', 'second')).ok);
        await raw(lore).addEdge({ sourceId: 'lively', targetId: 'anchor', relation: 'RELATES_TO' });
        await drain(lore);
        assert.equal((await read(lore, 'lively'))?.label, 'second');
        const edges = await raw(lore).queryEdges({ source: 'lively', limit: 10, offset: 0 });
        assert.equal(edges.length, 1, 'the replayed delete did not drop the relationship added since');
        assert.equal(lore._daemon.replayScope!.lastDelete.get(`${WS}\u0000lively`)?.replayRemovedAt, undefined);
    });

    await test(`[${engine}] crash-left save + a newer save the host then raw-deleted → stays deleted`, async () => {
        const outboxDir = outboxDirOf(lore);
        await lore.dispose('crash-sim');
        const store = new SqliteOutboxStore(outboxDir);
        const parked = await recordHotWrite(store, {
            workspace: WS, operationKind: 'node.upsert', operation: 'graph.upsert', initiator: 'lib:nodeUpsert', payload: nodeData('gone', 'crash-left'),
        });
        (store as unknown as RawDb).db.prepare('UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?').run(FAR_FUTURE, parked.id);
        store.close();
        lore = await boot(home);
        assert.equal(lore._daemon.replayScope!.preBootNodeUpserts?.has(parked.id), true);
        assert.ok((await save(lore, 'gone', 'live')).ok);
        assert.equal(await raw(lore).deleteNode('gone'), true);
        (outboxOf(lore) as unknown as RawDb).db.prepare('UPDATE outbox_entries SET nextAttemptAt = NULL WHERE id = ?').run(parked.id);
        await drain(lore);
        assert.equal(await read(lore, 'gone'), null, 'crash recovery of the older save must not bring back a node the host deleted after a newer save');
    });

    await test(`[${engine}] dispose() clean`, async () => { await lore.dispose('done'); });
}

// The emergency JSON outbox backend answers the same lookup. (Its rows cannot
// be held back across a restart, so this is the same-lifetime sequence.)
{
    console.log('\nembedded createLore — sqlite graph, LORE_OUTBOX_BACKEND=json\n');
    const home = seedHome('sqlite');
    process.env['LORE_OUTBOX_BACKEND'] = 'json';
    let lore: Lore | undefined;
    try {
        lore = await boot(home);
        const booted = lore;
        await test('[json outbox] delete and two saves in this lifetime → the second save, relationships kept', async () => {
            assert.equal(outboxOf(booted).constructor.name, 'FileOutboxStore');
            assert.ok((await save(booted, 'anchor', 'anchor')).ok);
            assert.ok((await save(booted, 'lively', 'original')).ok);
            await drain(booted);
            await raw(booted).deleteNode('lively');
            await recordUnnotedDelete(outboxOf(booted), 'lively');
            assert.ok((await save(booted, 'lively', 'first')).ok);
            assert.ok((await save(booted, 'lively', 'second')).ok);
            await raw(booted).addEdge({ sourceId: 'lively', targetId: 'anchor', relation: 'RELATES_TO' });
            await drain(booted);
            assert.equal((await read(booted, 'lively'))?.label, 'second');
            assert.equal((await raw(booted).queryEdges({ source: 'lively', limit: 10, offset: 0 })).length, 1);
        });
    } finally {
        delete process.env['LORE_OUTBOX_BACKEND'];
        try { await lore?.dispose('done'); } catch { /* already disposed */ }
    }
}

for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
