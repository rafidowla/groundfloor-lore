#!/usr/bin/env tsx
/**
 * embedded-delete-replay-unit.ts — 3.26.0: an embedded host's delete is not
 * undone by outbox replay (Atlas 0.3.8 ask).
 *
 * The defect: `nodeUpsert` writes the graph inline AND records a `node.upsert`
 * outbox row. In embedded mode the replay of that row goes through
 * `embeddedGuardedGraph`, which treated "row replayed, node missing" as crash
 * recovery and re-created the node. A host that hard-deleted through
 * `storageClient.rawGraph().deleteNode()` therefore saw the node come back on
 * the next replicator tick, on both graph engines.
 *
 * The fix, pinned here:
 *   - the guard re-creates a missing node only for a row that pre-dates this
 *     process's start-up (real crash recovery); a row written in this lifetime
 *     had its graph write applied inline, so a missing node means "deleted";
 *   - `LoreInstance.nodeDelete()` is the supported hard delete: it records
 *     `node.delete`, removes the node, tombstones its verbatim row, appends the
 *     WAL entry and writes one audit row;
 *   - a save → nodeDelete → save of the same id keeps the node (the delete
 *     row's replay must not remove the later save);
 *   - a node a replayed delete removed is re-created by the replay of an
 *     upsert row recorded after that delete and before the removal;
 *   - a save recorded BEFORE a delete never re-creates the node, even when its
 *     row pre-dates start-up (crash recovery must not undo a later delete).
 *
 * Part 1 drives the guard with a fake graph. Part 2 boots a real embedded
 * `createLore()` per graph engine on a throwaway home; the background
 * replicator loop is stopped so every replay is an explicit `tickOnce()`.
 *
 * Run: npx tsx test/embedded-delete-replay-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import {
    embeddedGuardedGraph, createEmbeddedReplayScope, noteInlineAppliedDelete, shouldRecreateMissingNode, MAX_TRACKED,
    type EmbeddedReplayScope, type ReplayEntryRef,
} from '../packages/lore/src/mcp/embeddedLifecycle.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

// ───────────────────────── Part 1 — the guard ─────────────────────────

type Rec = { id: string; label?: string };
class FakeGraph {
    nodes = new Map<string, Rec>();
    upserts = 0;
    failNextUpsert = false;
    async getNode(id: string): Promise<Rec | null> { return this.nodes.get(id) ?? null; }
    async upsertNode(n: Rec): Promise<Rec> {
        if (this.failNextUpsert) { this.failNextUpsert = false; throw new Error('graph busy'); }
        this.upserts++; this.nodes.set(n.id, { ...n }); return n;
    }
    async deleteNode(id: string): Promise<boolean> { return this.nodes.delete(id); }
}
interface Guarded {
    upsertNode(n: Rec): Promise<Rec | null>;
    replayNodeUpsert(n: Rec, entry?: ReplayEntryRef): Promise<Rec | null>;
    replayNodeDelete(id: string, entry?: ReplayEntryRef): Promise<boolean>;
}
function guarded(graph: FakeGraph, scope?: EmbeddedReplayScope): Guarded {
    return embeddedGuardedGraph(graph as never, scope) as unknown as Guarded;
}
const row = (id: string, over: Partial<ReplayEntryRef> = {}): ReplayEntryRef => ({
    id, operation: 'graph.upsert', operationKind: 'node.upsert', workspace: 'w', createdAt: new Date().toISOString(), ...over,
});
const delRow = (id: string, over: Partial<ReplayEntryRef> = {}): ReplayEntryRef =>
    row(id, { operation: 'node.delete', operationKind: 'node.delete', ...over });
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
/** A scope whose boot recovery has run and found `preBoot` unfinished rows. */
function bootedScope(preBoot: string[] = []): EmbeddedReplayScope {
    const scope = createEmbeddedReplayScope();
    scope.preBootNodeUpserts = new Set(preBoot);
    return scope;
}

console.log('\nembedded replay guard (3.26.0)\n');

await test('an existing node is never overwritten by a replay', async () => {
    const g = new FakeGraph();
    g.nodes.set('a', { id: 'a', label: 'live' });
    const out = await guarded(g, bootedScope()).replayNodeUpsert({ id: 'a', label: 'stale' }, row('r1'));
    assert.equal(out?.label, 'live');
    assert.equal(g.upserts, 0);
});

await test('missing node + row written in this lifetime → NOT re-created (the host deleted it)', async () => {
    const g = new FakeGraph();
    const scope = bootedScope();
    const out = await guarded(g, scope).replayNodeUpsert({ id: 'a' }, row('r1'));
    assert.equal(out, null);
    assert.equal(g.nodes.has('a'), false, 'the deleted node must stay deleted');
    assert.equal(scope.skippedDeleted, 1);
});

await test('missing node + row that pre-dates boot → re-created (crash recovery)', async () => {
    const g = new FakeGraph();
    await guarded(g, bootedScope(['r-old'])).replayNodeUpsert({ id: 'a', label: 'recovered' }, row('r-old'));
    assert.equal(g.nodes.get('a')?.label, 'recovered');
});

await test('missing node + a row from a producer that does not write inline → re-created', async () => {
    const g = new FakeGraph();
    await guarded(g, bootedScope()).replayNodeUpsert({ id: 'a' }, row('r1', { operation: 'stream.ingest' }));
    assert.equal(g.nodes.has('a'), true, 'the outbox row is the only copy of that write');
});

await test('no snapshot (recovery could not list the outbox) → the pre-3.26 behaviour: re-create', async () => {
    const g = new FakeGraph();
    await guarded(g, createEmbeddedReplayScope()).replayNodeUpsert({ id: 'a' }, row('r1'));
    assert.equal(g.nodes.has('a'), true);
    assert.equal(shouldRecreateMissingNode(undefined, row('r1')), true, 'no scope at all → re-create');
    assert.equal(shouldRecreateMissingNode(bootedScope(), undefined), true, 'no row reference → re-create');
});

await test('the plain upsertNode on the guard keeps its create-if-absent contract', async () => {
    const g = new FakeGraph();
    await guarded(g, bootedScope()).upsertNode({ id: 'a' });
    assert.equal(g.nodes.has('a'), true);
});

await test('a delete applied inline by nodeDelete is not replayed over a later save', async () => {
    const g = new FakeGraph();
    const scope = bootedScope();
    const gg = guarded(g, scope);
    // save (inline) → nodeDelete (inline, noted) → save again (inline).
    g.nodes.set('a', { id: 'a', label: 'second' });
    const del = delRow('del-row', { sequenceId: 2 });
    noteInlineAppliedDelete(scope, del, 'a');
    await gg.replayNodeUpsert({ id: 'a', label: 'first' }, row('up-1', { sequenceId: 1 }));
    const removed = await gg.replayNodeDelete('a', del);
    await gg.replayNodeUpsert({ id: 'a', label: 'second' }, row('up-2', { sequenceId: 3 }));
    assert.equal(removed, false, 'the redundant delete replay is skipped');
    assert.equal(g.nodes.get('a')?.label, 'second', 'the later save survives');
    assert.equal(scope.inlineAppliedDeletes.size, 0, 'the note is consumed by the replay');
});

await test('a replayed delete that removes a node lets the save recorded AFTER that delete re-create it', async () => {
    const g = new FakeGraph();
    const scope = bootedScope();
    const gg = guarded(g, scope);
    // delete recorded (and applied inline, un-noted) → save again → both rows replay.
    g.nodes.set('a', { id: 'a', label: 'second' });
    const upsertRow = row('up-2', { sequenceId: 2, createdAt: ago(1000) });
    assert.equal(await gg.replayNodeDelete('a', delRow('del-old', { sequenceId: 1, createdAt: ago(2000) })), true);
    assert.equal(g.nodes.has('a'), false);
    // The save is the newer write and was recorded before the replay removed the node.
    await gg.replayNodeUpsert({ id: 'a', label: 'second' }, upsertRow);
    assert.equal(g.nodes.get('a')?.label, 'second');
    assert.equal(scope.lastDelete.get('w\u0000a')?.replayRemovedAt, undefined, 'the removal is settled once the node is back');
});

await test('a transient failure of that re-create does not lose the node: the retry restores it', async () => {
    const g = new FakeGraph();
    const scope = bootedScope();
    const gg = guarded(g, scope);
    g.nodes.set('a', { id: 'a', label: 'second' });
    const upsertRow = row('up-2', { sequenceId: 2, createdAt: ago(1000) });
    await gg.replayNodeDelete('a', delRow('del-old', { sequenceId: 1, createdAt: ago(2000) }));
    g.failNextUpsert = true;
    await assert.rejects(() => gg.replayNodeUpsert({ id: 'a', label: 'second' }, upsertRow), /graph busy/);
    assert.equal(g.nodes.has('a'), false);
    await gg.replayNodeUpsert({ id: 'a', label: 'second' }, upsertRow);
    assert.equal(g.nodes.get('a')?.label, 'second', 'the retried row must still re-create the node');
});

await test('a pre-boot save recorded BEFORE an inline delete is not replayed over it (never-written node)', async () => {
    const g = new FakeGraph();
    const scope = bootedScope(['r-old']);
    const gg = guarded(g, scope);
    // Crash left r-old unfinished; after start-up the host calls nodeDelete
    // before the replicator reaches r-old. The node was never written.
    const del = delRow('del-row', { sequenceId: 6 });
    noteInlineAppliedDelete(scope, del, 'a');
    assert.equal(await gg.replayNodeUpsert({ id: 'a', label: 'stale' }, row('r-old', { sequenceId: 5 })), null);
    assert.equal(await gg.replayNodeDelete('a', del), false);
    assert.equal(g.nodes.has('a'), false, 'crash recovery must not undo a delete made after start-up');
    assert.equal(scope.skippedDeleted, 1);
    assert.equal(scope.preBootNodeUpserts!.size, 0, 'a replayed row leaves the snapshot');
});

await test('…and the same holds when rows carry no sequence (ordered by record time)', async () => {
    const g = new FakeGraph();
    const scope = bootedScope(['r-old']);
    const gg = guarded(g, scope);
    noteInlineAppliedDelete(scope, delRow('del-row', { createdAt: ago(0) }), 'a');
    assert.equal(await gg.replayNodeUpsert({ id: 'a' }, row('r-old', { createdAt: ago(60_000) })), null);
    assert.equal(g.nodes.has('a'), false);
});

await test('a pre-boot save recorded AFTER the newest delete still recovers the node', async () => {
    const g = new FakeGraph();
    const scope = bootedScope(['r-new']);
    const gg = guarded(g, scope);
    // A replayed (un-noted) delete found nothing to remove; the later save's
    // graph write was lost in the crash, so its row is the only copy.
    assert.equal(await gg.replayNodeDelete('a', delRow('del-old', { sequenceId: 4, createdAt: ago(5000) })), false);
    await gg.replayNodeUpsert({ id: 'a', label: 'recovered' }, row('r-new', { sequenceId: 5, createdAt: ago(4000) }));
    assert.equal(g.nodes.get('a')?.label, 'recovered');
});

await test('an older save retried after a replayed delete is not replayed over it', async () => {
    const g = new FakeGraph();
    const scope = bootedScope(['r-old']);
    const gg = guarded(g, scope);
    g.nodes.set('a', { id: 'a', label: 'v1' });
    // r-old (seq 1) failed and is in back-off; the delete (seq 2) replays first.
    assert.equal(await gg.replayNodeDelete('a', delRow('del', { sequenceId: 2, createdAt: ago(1000) })), true);
    assert.equal(await gg.replayNodeUpsert({ id: 'a', label: 'v1' }, row('r-old', { sequenceId: 1, createdAt: ago(2000) })), null);
    assert.equal(g.nodes.has('a'), false, 'the delete is the newer operation');
});

await test('the tracking collections are bounded', () => {
    const scope = bootedScope();
    for (let i = 0; i < MAX_TRACKED + 50; i++) noteInlineAppliedDelete(scope, delRow(`d${i}`, { sequenceId: i }), `n${i}`);
    assert.equal(scope.inlineAppliedDeletes.size, MAX_TRACKED);
    assert.equal(scope.lastDelete.size, MAX_TRACKED);
    assert.equal(scope.lastDelete.has('w\u0000n0'), false, 'the oldest mark is dropped first');
    assert.equal(scope.lastDelete.has(`w\u0000n${MAX_TRACKED + 49}`), true);
});

await test('…but an upsert row recorded AFTER that removal follows the normal rule', async () => {
    const g = new FakeGraph();
    const scope = bootedScope();
    const gg = guarded(g, scope);
    g.nodes.set('a', { id: 'a' });
    await gg.replayNodeDelete('a', delRow('del-old'));
    // The host saves again (inline) and then deletes raw; that save's row is newer than the removal.
    const later = row('up-3', { createdAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(await gg.replayNodeUpsert({ id: 'a' }, later), null);
    assert.equal(g.nodes.has('a'), false);
});

await test('replay-delete tracking is per workspace', async () => {
    const g = new FakeGraph();
    const scope = bootedScope();
    const gg = guarded(g, scope);
    g.nodes.set('a', { id: 'a' });
    await gg.replayNodeDelete('a', row('del', { operationKind: 'node.delete', operation: 'node.delete', workspace: 'w1' }));
    const old = new Date(Date.now() - 1000).toISOString();
    assert.equal(await gg.replayNodeUpsert({ id: 'a' }, row('up', { workspace: 'w2', createdAt: old })), null,
        'a removal in w1 says nothing about w2');
});

await test('noteInlineAppliedDelete is a no-op until replication has started', () => {
    const scope = createEmbeddedReplayScope();
    noteInlineAppliedDelete(scope, delRow('x'), 'a');
    assert.equal(scope.inlineAppliedDeletes.size, 0);
    assert.equal(scope.lastDelete.size, 0);
});

// ───────────────────── Part 2 — a real embedded instance ─────────────────────

const homes: string[] = [];
function seedHome(engine: 'sqlite' | 'surreal'): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-del-replay-${engine}-`));
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

async function boot(home: string): Promise<Lore> {
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
    // Every replay below is an explicit tick: stop the background loop.
    await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();
    return lore;
}
async function pendingRows(lore: Lore): Promise<OutboxEntry[]> {
    return lore._daemon.outboxWiring.store.listPendingForWorkspace!(WS, 1000);
}
async function drain(lore: Lore): Promise<void> {
    const r = lore._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
    for (let i = 0; i < 40; i++) {
        if ((await pendingRows(lore)).length === 0) return;
        await r.tickOnce();
    }
    assert.fail(`outbox did not drain: ${JSON.stringify((await pendingRows(lore)).map((e) => [e.operationKind, e.status, e.lastError]))}`);
}
const save = (lore: Lore, id: string, label: string, embed = false) => lore.nodeUpsert({
    id, workspace: WS, ecosystem: '*', skipEmbed: !embed,
    nodeData: { id, type: 'note', label, content: `${label} body for ${id}`, tags: '', project: WS, ecosystem: '*', metadata: '{}' },
});
const read = (lore: Lore, id: string) => lore.store.storageClient.getNode(id, { workspace: WS });
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
type RawDb = { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } };
const outboxDirOf = (lore: Lore): string =>
    path.dirname((lore._daemon.outboxWiring.store as unknown as { dbPath: string }).dbPath);
/** Stop the instance and leave an unfinished `node.upsert` row behind, as a
 *  crash between the outbox commit and the graph write does. `parked` holds the
 *  row back (a future retry time) so the test decides when it is replayed. */
async function crashWithPendingSave(lore: Lore, home: string, payload: Record<string, unknown>, parked: boolean): Promise<{ lore: Lore; rowId: string }> {
    const outboxDir = outboxDirOf(lore);
    await lore.dispose('crash-sim');
    const store = new SqliteOutboxStore(outboxDir);
    const entry = await recordHotWrite(store, {
        workspace: WS, operationKind: 'node.upsert', operation: 'graph.upsert', initiator: 'lib:nodeUpsert', payload,
    });
    if (parked) (store as unknown as RawDb).db.prepare('UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?').run(FAR_FUTURE, entry.id);
    store.close();
    return { lore: await boot(home), rowId: entry.id };
}
function releaseRow(lore: Lore, rowId: string): void {
    (lore._daemon.outboxWiring.store as unknown as RawDb).db.prepare('UPDATE outbox_entries SET nextAttemptAt = NULL WHERE id = ?').run(rowId);
}
type AuditRow = { toolName: string; result: string; args?: { nodeId?: string } };
/** The audit row lands shortly after the call returns (AuditLog writes off the
 *  caller's tick), so look the row up by node id and give it a moment. */
async function auditRow(home: string, nodeId: string, result: string): Promise<AuditRow | undefined> {
    const p = path.join(home, 'audit.jsonl');
    for (let i = 0; i < 40; i++) {
        const rows: AuditRow[] = fs.existsSync(p)
            ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            : [];
        const hit = rows.find((r) => r.toolName === 'lib:nodeDelete' && r.args?.nodeId === nodeId && r.result === result);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
}

for (const engine of ['sqlite', 'surreal'] as const) {
    console.log(`\nembedded createLore — ${engine} graph\n`);
    const home = seedHome(engine);
    let lore = await boot(home);
    let upsertPayload: Record<string, unknown> | undefined;

    await test(`[${engine}] save → raw graph delete → replay: the node is NOT resurrected`, async () => {
        const res = await save(lore, 'raw-del', 'first');
        assert.ok(res.ok, JSON.stringify(res));
        const rowsBefore = (await pendingRows(lore)).filter((e) => e.operationKind === 'node.upsert');
        assert.equal(rowsBefore.length, 1, 'the save left its node.upsert row pending (the precondition of the defect)');
        upsertPayload = rowsBefore[0]!.payload;
        assert.equal(await lore.store.storageClient.rawGraph().deleteNode('raw-del'), true);
        await drain(lore);
        assert.equal(await read(lore, 'raw-del'), null, 'replay must not bring a host-deleted node back');
    });

    await test(`[${engine}] nodeDelete: removes the node, records node.delete, audits, survives replay`, async () => {
        assert.ok((await save(lore, 'api-del', 'doomed')).ok);
        await drain(lore);
        const out = await lore.nodeDelete({ id: 'api-del', workspace: WS });
        assert.deepEqual(out, { deleted: true, verbatimWarning: undefined });
        assert.equal(await read(lore, 'api-del'), null);
        const rows = await pendingRows(lore);
        const del = rows.find((e) => e.operationKind === 'node.delete');
        assert.ok(del, 'a node.delete row is recorded');
        assert.equal(del!.initiator, 'lib:nodeDelete');
        assert.deepEqual(del!.payload, { id: 'api-del' });
        assert.ok(rows.some((e) => e.operationKind === 'verbatim.tombstone'), 'the verbatim tombstone is recorded too');
        assert.ok(await auditRow(home, 'api-del', 'success'), 'one lib:nodeDelete audit row for the delete');
        await drain(lore);
        assert.equal(await read(lore, 'api-del'), null);
    });

    await test(`[${engine}] nodeDelete with a save still pending in the outbox: not resurrected`, async () => {
        assert.ok((await save(lore, 'pending-del', 'doomed')).ok);
        assert.ok((await pendingRows(lore)).some((e) => e.operationKind === 'node.upsert'));
        assert.equal((await lore.nodeDelete({ id: 'pending-del', workspace: WS })).deleted, true);
        await drain(lore);
        assert.equal(await read(lore, 'pending-del'), null);
    });

    await test(`[${engine}] save → nodeDelete → save again (same id): the second save survives replay`, async () => {
        assert.ok((await save(lore, 'reborn', 'first')).ok);
        assert.equal((await lore.nodeDelete({ id: 'reborn', workspace: WS })).deleted, true);
        assert.ok((await save(lore, 'reborn', 'second')).ok);
        await drain(lore);
        const node = await read(lore, 'reborn');
        assert.ok(node, 'the re-saved node must still exist after the delete row replayed');
        assert.equal(node!.label, 'second');
    });

    await test(`[${engine}] nodeDelete of an unknown id → deleted:false; bad arguments are refused and audited`, async () => {
        assert.deepEqual(await lore.nodeDelete({ id: 'never-existed', workspace: WS }), { deleted: false });
        await assert.rejects(() => lore.nodeDelete({ id: '', workspace: WS }), /id is required/);
        await assert.rejects(() => lore.nodeDelete({ id: 'x', workspace: '' }), /workspace is required/);
        assert.ok(await auditRow(home, 'x', 'error'), 'a refused delete is audited as an error');
        await drain(lore);
    });

    await test(`[${engine}] nodeDelete tombstones the node's verbatim row`, async () => {
        assert.ok((await save(lore, 'with-text', 'zanzibar pangolin marker', true)).ok);
        await lore.awaitEmbeds();
        await drain(lore);
        const verbatim = await lore._daemon.getVerbatimResolver()!.getOrOpen(WS) as unknown as {
            getById(id: string): Promise<{ text?: string } | null>;
        };
        const before = await verbatim.getById('lore:with-text');
        assert.ok(before?.text && !before.text.startsWith('[TOMBSTONED'), 'the verbatim row exists before the delete');
        const out = await lore.nodeDelete({ id: 'with-text', workspace: WS });
        assert.equal(out.deleted, true);
        assert.equal(out.verbatimWarning, undefined);
        await drain(lore);
        const after = await verbatim.getById('lore:with-text');
        assert.ok(after?.text?.startsWith('[TOMBSTONED'), `verbatim row must be tombstoned (got ${JSON.stringify(after?.text)?.slice(0, 80)})`);
        assert.equal(await read(lore, 'with-text'), null);
    });

    await test(`[${engine}] a row that pre-dates start-up still recovers a missing node (crash recovery)`, async () => {
        assert.ok(upsertPayload, 'payload captured by the first case');
        // "Crash" between the outbox commit and the graph write: the row is
        // durable, the node never reached the graph.
        ({ lore } = await crashWithPendingSave(lore, home, { ...upsertPayload!, id: 'crash-recovered', label: 'recovered' }, false));
        await drain(lore);
        const node = await read(lore, 'crash-recovered');
        assert.ok(node, 'the pre-boot row must re-create the node it describes');
        assert.equal(node!.label, 'recovered');
        assert.equal(lore._daemon.replayScope!.preBootNodeUpserts?.size, 0, 'a recovered row leaves the boot snapshot');
    });

    await test(`[${engine}] crash-left save + nodeDelete after start-up (node never written): stays deleted`, async () => {
        let rowId: string;
        ({ lore, rowId } = await crashWithPendingSave(lore, home, { ...upsertPayload!, id: 'f1-never', label: 'stale' }, true));
        assert.equal(lore._daemon.replayScope!.preBootNodeUpserts?.has(rowId), true, 'the row is in the boot snapshot');
        assert.deepEqual(await lore.nodeDelete({ id: 'f1-never', workspace: WS }), { deleted: false });
        releaseRow(lore, rowId);
        await drain(lore);
        assert.equal(await read(lore, 'f1-never'), null, 'crash recovery must not create a node the host deleted after start-up');
    });

    await test(`[${engine}] crash-left save + nodeDelete after start-up (node exists): stays deleted`, async () => {
        assert.ok((await save(lore, 'f1-exists', 'live')).ok);
        await drain(lore);
        let rowId: string;
        ({ lore, rowId } = await crashWithPendingSave(lore, home, { ...upsertPayload!, id: 'f1-exists', label: 'stale' }, true));
        assert.equal((await lore.nodeDelete({ id: 'f1-exists', workspace: WS })).deleted, true);
        releaseRow(lore, rowId);
        await drain(lore);
        assert.equal(await read(lore, 'f1-exists'), null, 'the older save must not be replayed over the delete');
    });

    await test(`[${engine}] crash-left save + nodeDelete + save again: the new content is kept`, async () => {
        let rowId: string;
        ({ lore, rowId } = await crashWithPendingSave(lore, home, { ...upsertPayload!, id: 'f1-reborn', label: 'stale' }, true));
        assert.deepEqual(await lore.nodeDelete({ id: 'f1-reborn', workspace: WS }), { deleted: false });
        assert.ok((await save(lore, 'f1-reborn', 'fresh')).ok);
        releaseRow(lore, rowId);
        await drain(lore);
        assert.equal((await read(lore, 'f1-reborn'))?.label, 'fresh');
    });

    await test(`[${engine}] a node.delete row replayed through the guard does not lose a later save`, async () => {
        assert.ok((await save(lore, 'unnoted', 'first')).ok);
        await drain(lore);
        // A delete Lore applied inline without telling the guard (the rollback
        // of a failed write records one like this), then a new save.
        await lore.store.storageClient.rawGraph().deleteNode('unnoted');
        await recordHotWrite(lore._daemon.outboxWiring.store, {
            workspace: WS, operationKind: 'node.delete', payload: { id: 'unnoted' }, operation: 'graph.delete',
        });
        assert.ok((await save(lore, 'unnoted', 'second')).ok);
        await drain(lore);
        assert.equal((await read(lore, 'unnoted'))?.label, 'second', 'the replayed delete removed the node; the later save put it back');
    });

    await test(`[${engine}] MCP delete_node in embedded mode: a later save of the same id survives replay`, async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const mcpServer = lore.createMcpServer();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'delete-replay-test', version: '0.0.1' });
        await client.connect(clientTransport);
        assert.ok((await save(lore, 'mcp-del', 'first')).ok);
        const res = await client.callTool({ name: 'delete_node', arguments: { id: 'mcp-del', workspace: WS } });
        assert.notEqual(res.isError, true, JSON.stringify(res.content));
        assert.equal(await read(lore, 'mcp-del'), null);
        assert.ok((await save(lore, 'mcp-del', 'second')).ok);
        await drain(lore);
        assert.equal((await read(lore, 'mcp-del'))?.label, 'second');
        // The redundant delete replay was skipped, not applied and then repaired.
        assert.equal(lore._daemon.replayScope!.lastDelete.get(`${WS}\u0000mcp-del`)?.replayRemovedAt, undefined);
        assert.equal(lore._daemon.replayScope!.inlineAppliedDeletes.size, 0, 'every note was consumed by its replay');
        await client.close();
    });

    await test(`[${engine}] nodeDelete on a workspace this instance does not know`, async () => {
        let outcome: string;
        try { outcome = JSON.stringify(await lore.nodeDelete({ id: 'x', workspace: 'no-such-workspace' })); }
        catch (err) { outcome = `throws: ${(err as Error).message}`; }
        console.log(`    · unknown workspace → ${outcome}`);
        assert.match(outcome, /^throws: /, 'documented: rejects for an unknown workspace');
    });

    await test(`[${engine}] dispose() clean`, async () => { await lore.dispose('done'); });
}

for (const home of homes) {
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
