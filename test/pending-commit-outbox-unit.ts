#!/usr/bin/env tsx
/**
 * test/pending-commit-outbox-unit.ts - 3.35.0 (R3): the outbox `pending_commit` row state.
 *
 * A node write that records its outbox row BEFORE its graph commit records it `pending_commit`
 * (invisible to the replicator), flips it ready right after a successful commit, retracts it on a
 * definite failure, and leaves it for the settle sweep on an outcome-unknown commit or a crash.
 *
 *   store      pending_commit is not claimed / listed for replication, counted apart in stats, retractable;
 *              SQLite and JSON stores behave the same
 *   writes     nodeUpsert (revision path and non-revision path), POST /api/nodes/bulk (batch branch and
 *              per-item branch): pending_commit while the graph write runs, ready after, retracted on failure,
 *              left pending_commit on outcome-unknown
 *   settle     committed -> ready; never committed (older than the grace) -> retracted; younger -> waits;
 *              graph unreachable -> stays pending_commit, then settles; no-revision payloads judged by content
 *   restart    new store + replicator on the same file settle what the previous process left behind
 *   migration  an outbox file from before this change opens with every existing row ready, nothing lost
 *
 * Run: npx tsx test/pending-commit-outbox-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { recordHotWrite, commitHotRows } from '../packages/lore/src/outbox/hotLane.js';
import { cellOutboxStore } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { settlePendingCommits } from '../packages/lore/src/outbox/pendingCommit.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.env['LORE_PENDING_COMMIT_SWEEP_MS'] = '0';

const WS = 'pc-ws';
const nodeInput = (id: string, label = id) => ({ id, type: 'note', label, content: `content ${label}`, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });
const payloadOf = (id: string, revision?: number) => ({ ...nodeInput(id), ...(revision !== undefined ? { revision } : {}) });

type Kind = 'sqlite' | 'file';
const openStore = (kind: Kind, dir: string): OutboxStore => (kind === 'sqlite' ? new SqliteOutboxStore(dir) : new FileOutboxStore(dir));
const rowsOf = async (s: OutboxStore, id?: string): Promise<OutboxEntry[]> =>
    (await s.listUnfinished()).filter((e) => e.operationKind === 'node.upsert' && (id === undefined || (e.payload as { id?: string }).id === id));
const statusOf = async (s: OutboxStore, id: string): Promise<string[]> => (await rowsOf(s, id)).map((e) => String(e.status));
const claimable = async (s: OutboxStore, ws = WS): Promise<string[]> => (await s.listPendingForWorkspace!(ws, 1000)).map((e) => (e.payload as { id: string }).id);
const pendingCommitRow = (s: OutboxStore, id: string, extra: Record<string, unknown> = {}) =>
    recordHotWrite(s, { workspace: WS, operationKind: 'node.upsert', payload: { ...payloadOf(id, 1), ...extra }, operation: 'graph.upsert', pendingCommit: true });

/** A graph handle that runs `onWrite` just before the revision-aware node write, optionally hiding capabilities. */
function spyGraph(graph: SqliteGraph, opts: { onWrite?: () => Promise<void> | void; failWith?: () => Error; hide?: string[] } = {}): any {
    const hide = new Set(opts.hide ?? []);
    return new Proxy(graph as object, {
        get(t, p) {
            if (typeof p === 'string' && hide.has(p)) return undefined;
            const v = (t as any)[p];
            if (typeof p === 'string' && (p === 'upsertNodeAtRevision' || p === 'upsertNode' || p === 'bulkUpsertNodes')) {
                return async (...a: unknown[]) => {
                    await opts.onWrite?.();
                    if (opts.failWith) throw opts.failWith();
                    return v.apply(t, a);
                };
            }
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}
const newGraph = async (): Promise<SqliteGraph> => { const g = new SqliteGraph(mkTmp('pc-g-'), { workspaceId: WS }); await g.initialize(); return g; };
const upsertArgs = (graph: unknown, id: string, label = id) => ({ id, workspace: WS, ecosystem: '*', initiator: 'pc-test', skipEmbed: true, targetGraph: graph, nodeData: nodeInput(id, label) });

for (const kind of ['sqlite', 'file'] as const) {
    console.log(`\nstore: ${kind}`);

    await test('a pending_commit row is not claimable or listed for replication, and is counted apart in stats', async () => {
        const s = openStore(kind, mkTmp('pc-s-'));
        await pendingCommitRow(s, 'a');
        await recordHotWrite(s, { workspace: WS, operationKind: 'node.upsert', payload: payloadOf('ready'), operation: 'graph.upsert' });
        assert.deepEqual(await claimable(s), ['ready'], 'only the ready row is offered to the replicator');
        assert.deepEqual(await s.listWorkspacesWithPending!(), [WS]);
        const stats = (await s.statsByWorkspace!())[WS]!;
        assert.equal(stats.pendingCommit, 1);
        assert.equal(stats.depth, 1, 'depth counts only the ready row');
        assert.equal(stats.dead, 0, 'never counted dead');
        const agg = await s.aggregateStats!();
        assert.equal(agg.pendingCommit, 1);
        assert.equal(agg.depth, 1);
        assert.deepEqual((await statusOf(s, 'a')), ['pending_commit']);
    });

    await test('markCommitted flips ready (claimable, depth moves); flipping twice or a ready row is a no-op', async () => {
        const s = openStore(kind, mkTmp('pc-s-'));
        const e = await pendingCommitRow(s, 'a');
        assert.equal(await s.markCommitted!([e.id]), 1);
        assert.deepEqual(await claimable(s), ['a']);
        assert.equal(await s.markCommitted!([e.id]), 0);
        const stats = (await s.statsByWorkspace!())[WS]!;
        assert.equal(stats.pendingCommit ?? 0, 0);
        assert.equal(stats.depth, 1);
    });

    await test('removeIfPending retracts a pending_commit row', async () => {
        const s = openStore(kind, mkTmp('pc-s-'));
        const e = await pendingCommitRow(s, 'a');
        assert.equal(await s.removeIfPending!(e.id), true);
        assert.deepEqual(await rowsOf(s), []);
    });

    await test('survives a reopen as pending_commit (the file records the state)', async () => {
        const dir = mkTmp('pc-s-');
        const a = openStore(kind, dir);
        await pendingCommitRow(a, 'a');
        (a as { close?: () => void }).close?.();
        const b = openStore(kind, dir);
        assert.deepEqual(await statusOf(b, 'a'), ['pending_commit']);
        assert.deepEqual(await claimable(b), []);
    });
}

console.log('\nwrite paths');

for (const kind of ['sqlite', 'file'] as const) {
    await test(`nodeUpsert (revision path, ${kind}): pending_commit while the graph writes, ready after, payload revision = stored`, async () => {
        const store = openStore(kind, mkTmp('pc-o-'));
        const graph = await newGraph();
        const seen: string[][] = [];
        const g = spyGraph(graph, { onWrite: async () => { seen.push(await statusOf(store, 'n1')); } });
        const out = await nodeUpsert(upsertArgs(g, 'n1') as never, { outboxStore: store } as never);
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.deepEqual(seen, [['pending_commit']], 'the row existed, not replayable, before the commit');
        const rows = await rowsOf(store, 'n1');
        assert.deepEqual(rows.map((r) => r.status), ['pending']);
        assert.equal((rows[0]!.payload as { revision: number }).revision, (await graph.getNode('n1'))!.revision);
        assert.deepEqual(await claimable(store), ['n1']);
    });
}

await test('nodeUpsert (revision path): a definite graph failure retracts the row - nothing is left to replay', async () => {
    const store = openStore('sqlite', mkTmp('pc-o-'));
    const graph = await newGraph();
    const g = spyGraph(graph, { failWith: () => new Error('constraint violated') });
    await assert.rejects(nodeUpsert(upsertArgs(g, 'n2') as never, { outboxStore: store } as never), /constraint violated/);
    assert.deepEqual(await rowsOf(store), [], 'row retracted');
    assert.deepEqual(await claimable(store), []);
    assert.equal(await graph.getNode('n2'), null);
});

await test('nodeUpsert (revision path): an outcome-unknown commit leaves the row pending_commit (not replayed, not retracted)', async () => {
    const store = openStore('sqlite', mkTmp('pc-o-'));
    const graph = await newGraph();
    const g = spyGraph(graph, { failWith: () => new OutcomeUnknownError('n3', undefined, new Error('request timeout')) });
    await assert.rejects(nodeUpsert(upsertArgs(g, 'n3') as never, { outboxStore: store } as never), /outcome_unknown/);
    assert.deepEqual(await statusOf(store, 'n3'), ['pending_commit']);
    assert.deepEqual(await claimable(store), [], 'the replicator must not claim an unsettled commit');
});

await test('nodeUpsert (non-revision path): pending_commit while the graph writes, ready after; failure retracts; unknown stays', async () => {
    const hide = ['upsertNodeAtRevision', 'replayNodeAtRevision'];
    const store = openStore('sqlite', mkTmp('pc-o-'));
    const graph = await newGraph();
    const seen: string[][] = [];
    const ok = spyGraph(graph, { hide, onWrite: async () => { seen.push(await statusOf(store, 'p1')); } });
    assert.equal((await nodeUpsert(upsertArgs(ok, 'p1') as never, { outboxStore: store } as never)).ok, true);
    assert.deepEqual(seen, [['pending_commit']]);
    assert.deepEqual(await statusOf(store, 'p1'), ['pending']);

    const bad = spyGraph(graph, { hide, failWith: () => new Error('disk full') });
    await assert.rejects(nodeUpsert(upsertArgs(bad, 'p2') as never, { outboxStore: store } as never), /disk full/);
    assert.deepEqual(await statusOf(store, 'p2'), [], 'definite failure retracted');

    const unknown = spyGraph(graph, { hide, failWith: () => new OutcomeUnknownError('p3', undefined, new Error('timeout')) });
    await assert.rejects(nodeUpsert(upsertArgs(unknown, 'p3') as never, { outboxStore: store } as never), /outcome_unknown/);
    assert.deepEqual(await statusOf(store, 'p3'), ['pending_commit']);
});

// ---- POST /api/nodes/bulk ----
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakeReq(body: string): IncomingMessage {
    let consumed = false;
    return { method: 'POST', on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && !consumed) { consumed = true; cb(Buffer.from(body)); } if (ev === 'end') setImmediate(() => cb()); return this; } } as unknown as IncomingMessage;
}
async function bulk(graph: unknown, outbox: OutboxStore, nodes: Array<Record<string, unknown>>): Promise<{ results: Array<{ id: string; ok: boolean; error?: string }> }> {
    const res = fakeRes();
    await tryBulkWriteRoutes(fakeReq(JSON.stringify({ workspace: WS, nodes, embed: 'skip' })), res, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: graph, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: outbox });
    return JSON.parse(res._body);
}
const bulkNode = (id: string) => ({ id, type: 'decision', label: id, content: `content ${id}` });

for (const [branch, hide] of [['batch (local engine)', []], ['per-item (Arcade-style, no bulk primitive)', ['bulkListProjected', 'queryEdges', 'bulkUpsertNodes']]] as const) {
    await test(`bulk ${branch}: pending_commit during the write, ready after; a failed chunk is retracted`, async () => {
        const store = openStore('sqlite', mkTmp('pc-b-'));
        const graph = await newGraph();
        const seen: string[][] = [];
        const ok = spyGraph(graph, { hide: [...hide], onWrite: async () => { seen.push([...(await statusOf(store, 'b1')), ...(await statusOf(store, 'b2'))]); } });
        const r = await bulk(ok, store, [bulkNode('b1'), bulkNode('b2')]);
        assert.deepEqual(r.results.map((x) => x.ok), [true, true], JSON.stringify(r));
        // The per-item branch flips each id as its own commit lands, so later writes may see earlier ids already ready.
        assert.ok(seen.length > 0 && seen[0]!.length === 2 && seen[0]!.every((x) => x === 'pending_commit'), `during the first write: ${JSON.stringify(seen)}`);
        assert.ok(seen.every((s) => s.includes('pending_commit')), `an id is pending_commit until its own commit: ${JSON.stringify(seen)}`);
        assert.deepEqual([...(await statusOf(store, 'b1')), ...(await statusOf(store, 'b2'))], ['pending', 'pending'], 'flipped ready after the commit');
        assert.deepEqual((await claimable(store)).sort(), ['b1', 'b2']);

        const bad = spyGraph(graph, { hide: [...hide], failWith: () => new Error('write failed') });
        const failed = await bulk(bad, store, [bulkNode('b3')]);
        assert.equal(failed.results[0]!.ok, false);
        assert.deepEqual(await statusOf(store, 'b3'), [], 'definite failure: row retracted, nothing replays');
    });
}

console.log('\nsettle');

await test('committed (graph revision >= row) -> ready; never committed and old -> retracted; young -> waits', async () => {
    const store = openStore('sqlite', mkTmp('pc-t-'));
    const graph = await newGraph();
    await graph.upsertNode(nodeInput('c1') as never); // revision 1
    await pendingCommitRow(store, 'c1');              // row revision 1: the commit landed
    await pendingCommitRow(store, 'c2');              // never in the graph
    const now = Date.now();
    const r1 = await settlePendingCommits({ store, getNode: (id) => graph.getNode(id) as never, graceMs: 60_000, now: () => now });
    assert.deepEqual([r1.flipped, r1.retracted, r1.waiting], [1, 0, 1], 'c2 is younger than the grace: wait');
    const r2 = await settlePendingCommits({ store, getNode: (id) => graph.getNode(id) as never, graceMs: 60_000, now: () => now + 61_000 });
    assert.deepEqual([r2.flipped, r2.retracted, r2.waiting], [0, 1, 0]);
    assert.deepEqual(await statusOf(store, 'c1'), ['pending']);
    assert.deepEqual(await statusOf(store, 'c2'), [], 'retracted (the response is sent only after the commit, so it was never acknowledged)');
});

await test('graph unreachable: rows stay pending_commit (never flipped blindly), then settle when it is back', async () => {
    const store = openStore('sqlite', mkTmp('pc-t-'));
    const graph = await newGraph();
    await graph.upsertNode(nodeInput('d1') as never);
    await pendingCommitRow(store, 'd1');
    await pendingCommitRow(store, 'd2');
    let down = true;
    const getNode = async (id: string) => { if (down) throw new Error('connect ECONNREFUSED'); return graph.getNode(id) as never; };
    const far = Date.now() + 3_600_000;
    const r = await settlePendingCommits({ store, getNode, graceMs: 0, now: () => far });
    assert.equal(r.unreachable, 2);
    assert.deepEqual([...(await statusOf(store, 'd1')), ...(await statusOf(store, 'd2'))], ['pending_commit', 'pending_commit']);
    down = false;
    const r2 = await settlePendingCommits({ store, getNode, graceMs: 0, now: () => far });
    assert.deepEqual([r2.flipped, r2.retracted], [1, 1]);
});

await test('a payload with no revision is judged by content: equal stored content = committed', async () => {
    const store = openStore('sqlite', mkTmp('pc-t-'));
    const graph = await newGraph();
    await graph.upsertNode(nodeInput('e1', 'same') as never);
    await recordHotWrite(store, { workspace: WS, operationKind: 'node.upsert', payload: nodeInput('e1', 'same'), operation: 'graph.upsert', pendingCommit: true });
    await recordHotWrite(store, { workspace: WS, operationKind: 'node.upsert', payload: nodeInput('e1', 'different'), operation: 'graph.upsert', pendingCommit: true });
    const r = await settlePendingCommits({ store, getNode: (id) => graph.getNode(id) as never, graceMs: 0, now: () => Date.now() + 1 });
    assert.deepEqual([r.flipped, r.retracted], [1, 1]);
});

await test('a failed flip is harmless: the row stays pending_commit and the sweep settles it', async () => {
    const store = openStore('sqlite', mkTmp('pc-t-'));
    const e = await pendingCommitRow(store, 'f1');
    const broken = Object.assign(Object.create(store), { markCommitted: async () => { throw new Error('disk i/o error'); } }) as OutboxStore;
    const orig = console.error; console.error = () => undefined;
    try { await commitHotRows(broken, [e.id]); } finally { console.error = orig; }
    assert.deepEqual(await statusOf(store, 'f1'), ['pending_commit']);
});

console.log('\nrestart recovery (new store + replicator on the same file)');

async function restartRig(dir: string, getNode?: DispatcherSubstrates['getNode']) {
    const store = new SqliteOutboxStore(dir);
    const applied: string[] = [];
    const logs: string[] = [];
    const substrates: DispatcherSubstrates = { upsertNode: async (p) => { applied.push(String(p['id'])); }, ...(getNode ? { getNode } : {}) };
    const rep = new OutboxReplicator({ store, substrates, log: (m) => logs.push(m), config: { maxAttempts: 3, batchSize: 50 } });
    return { store, rep, applied, logs };
}

await test('crash between record and commit, then restart: committed -> replicated; never committed -> retracted and nothing replays', async () => {
    process.env['LORE_PENDING_COMMIT_GRACE_MS'] = '0';
    const dir = mkTmp('pc-r-');
    const graph = await newGraph();
    // the previous process: two rows recorded pending_commit, then it died. Only c-committed reached the graph.
    const before = new SqliteOutboxStore(dir);
    await graph.upsertNode(nodeInput('c-committed') as never);
    await pendingCommitRow(before, 'c-committed');
    await pendingCommitRow(before, 'c-lost');
    before.close();
    const { store, rep, applied } = await restartRig(dir, async (id) => graph.getNode(id) as never);
    await rep.tickOnce();
    assert.deepEqual(await statusOf(store, 'c-lost'), [], 'never committed: retracted');
    for (let i = 0; i < 5 && applied.length === 0; i++) await rep.tickOnce();
    assert.deepEqual(applied, ['c-committed'], 'the committed row replays (revision-guarded, idempotent); the lost one never does');
    assert.equal(rep.getStats().dead, 0);
    delete process.env['LORE_PENDING_COMMIT_GRACE_MS'];
});

await test('crash, restart with the graph DOWN: rows stay pending_commit and are not replayed; they settle once it is back', async () => {
    process.env['LORE_PENDING_COMMIT_GRACE_MS'] = '0';
    const dir = mkTmp('pc-r-');
    const graph = await newGraph();
    await graph.upsertNode(nodeInput('g-committed') as never);
    const before = new SqliteOutboxStore(dir);
    await pendingCommitRow(before, 'g-committed');
    await pendingCommitRow(before, 'g-lost');
    before.close();
    let down = true;
    const { store, rep, applied, logs } = await restartRig(dir, async (id) => { if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:2480'); return graph.getNode(id) as never; });
    await rep.tickOnce();
    assert.deepEqual([...(await statusOf(store, 'g-committed')), ...(await statusOf(store, 'g-lost'))], ['pending_commit', 'pending_commit']);
    assert.deepEqual(applied, [], 'nothing replayed while the commit state is unknown');
    assert.ok(logs.some((l) => /graph unreachable/.test(l)));
    down = false;
    const deadline = Date.now() + 8_000; // the sweep backs off after an unreachable graph
    while (Date.now() < deadline && (await rowsOf(store)).some((r) => r.status === 'pending_commit')) { await rep.tickOnce(); await new Promise((r) => setTimeout(r, 100)); }
    assert.deepEqual(await statusOf(store, 'g-lost'), [], 'retracted once the graph answered');
    assert.ok(!(await rowsOf(store)).some((r) => r.status === 'pending_commit'), 'every pending_commit row settled');
    delete process.env['LORE_PENDING_COMMIT_GRACE_MS'];
});

await test('a pending_commit row younger than the grace is left alone by the replicator sweep (a live writer may still flip it)', async () => {
    delete process.env['LORE_PENDING_COMMIT_GRACE_MS']; // default 60 s
    const dir = mkTmp('pc-r-');
    const graph = await newGraph();
    const seed = new SqliteOutboxStore(dir);
    await pendingCommitRow(seed, 'y1');
    seed.close();
    const { store, rep, applied } = await restartRig(dir, async (id) => graph.getNode(id) as never);
    await rep.tickOnce(); await rep.tickOnce();
    assert.deepEqual(await statusOf(store, 'y1'), ['pending_commit']);
    assert.deepEqual(applied, []);
});

console.log('\nmigration');

await test('an outbox file from before this change opens: every existing row is ready and nothing is lost', async () => {
    const dir = mkTmp('pc-m-');
    // The pre-change schema: no firstTransientAt / transientRetries / deadReason columns, status values pending/replicating/failed/replicated/dead only.
    const db = new Database(path.join(dir, 'outbox.sqlite'));
    db.exec(`CREATE TABLE outbox_entries (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, sequenceId INTEGER NOT NULL, operationKind TEXT NOT NULL, payload TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      replicatedAt TEXT, failedAt TEXT, nextAttemptAt TEXT, steps TEXT, operation TEXT NOT NULL, initiator TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE outbox_replication_state (workspace TEXT PRIMARY KEY, lastReplicatedSeq INTEGER NOT NULL, updatedAt TEXT NOT NULL);`);
    const ins = db.prepare(`INSERT INTO outbox_entries (id, workspace, sequenceId, operationKind, payload, status, createdAt, updatedAt, steps, operation, initiator, completed) VALUES (?, ?, ?, 'node.upsert', ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '[]', 'graph.upsert', 'old-build', 0)`);
    const states = ['pending', 'pending', 'failed', 'replicating', 'dead'];
    states.forEach((st, i) => ins.run(`old-${i}`, WS, i + 1, JSON.stringify(payloadOf(`old${i}`)), st));
    db.close();

    const store = new SqliteOutboxStore(dir);
    const all = await store.listUnfinished();
    assert.equal(all.length, states.length, 'no row lost');
    assert.deepEqual(all.map((e) => e.status).sort(), [...states].sort(), 'no existing row changed state; none is pending_commit');
    assert.deepEqual((await claimable(store)).sort(), ['old0', 'old1', 'old2'], 'existing pending/failed rows are ready (claimable) as before');
    const stats = (await store.statsByWorkspace!())[WS]!;
    assert.equal(stats.pendingCommit ?? 0, 0);
    assert.equal(stats.dead, 1);
    // and the migrated file takes pending_commit rows
    const e = await pendingCommitRow(store, 'new1');
    assert.equal((await store.statsByWorkspace!())[WS]!.pendingCommit, 1);
    await store.markCommitted!([e.id]);
    assert.equal((await claimable(store)).includes('new1'), true);
});

await test('a replicator tick claims only ready rows: pending_commit is skipped, flipped is applied', async () => {
    const store = new SqliteOutboxStore(mkTmp('pc-c-'));
    const applied: string[] = [];
    const rep = new OutboxReplicator({ store, substrates: { upsertNode: async (p) => { applied.push(String(p['id'])); } }, log: () => undefined, config: { maxAttempts: 3, batchSize: 50 } });
    const e = await pendingCommitRow(store, 'k1');
    await rep.tickOnce(); await rep.tickOnce();
    assert.deepEqual(applied, [], 'not claimed while pending_commit');
    await store.markCommitted!([e.id]);
    await rep.tickOnce();
    assert.deepEqual(applied, ['k1']);
});

await test('the Arcade lane wrapper keeps pending_commit: row recorded pending_commit under the cell key, flipped through the wrapper', async () => {
    const real = new SqliteOutboxStore(mkTmp('pc-lane-'));
    const lane = cellOutboxStore(real, 'arcade:t1:a1');
    const e = await recordHotWrite(lane, { workspace: 'ignored', operationKind: 'node.upsert', payload: payloadOf('lane1', 1), operation: 'graph.upsert', pendingCommit: true });
    const row = (await real.listUnfinished!()).find((r) => r.id === e!.id)!;
    assert.equal(row.status, 'pending_commit', 'a wrapper that hides markCommitted silently downgrades the row to plain pending');
    assert.equal(row.workspace, 'arcade:t1:a1');
    assert.deepEqual(await claimable(real, 'arcade:t1:a1'), []);
    await commitHotRows(lane, [e!.id]);
    assert.deepEqual(await claimable(real, 'arcade:t1:a1'), ['lane1']);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
