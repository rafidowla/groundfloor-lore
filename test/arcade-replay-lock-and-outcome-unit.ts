#!/usr/bin/env tsx
/**
 * arcade-replay-lock-and-outcome-unit.ts — Lore 3.34.0 slice 1 (Nokshi M1 + M2).
 *
 * M1. The arcade outbox's node replay handlers (upsertNode, deleteNode) take the
 *     per-node lock the request paths take, so a replay can no longer land between a
 *     request's outbox record and its own graph write:
 *       - ifAbsent create   -> no false `already_exists`
 *       - ifRevision write  -> no false `revision_conflict` / `revision_mismatch`
 *       - plain stamped write -> revision r+1, not r+2
 *     The lock key must match what the request path uses (the cell's appId, NOT the
 *     `arcade:<t>:<a>` lane key); the wait is bounded, and on timeout the row goes back
 *     to `pending` (not `failed`, no attempt counted), in order.
 * M2. A write whose outcome cannot be established (client-side timeout = plain Error;
 *     failed read-back) is re-read and, if still unknown, reported `outcome_unknown`
 *     with the current revision; the bulk route does NOT retract its outbox row. Per-item
 *     errors carry a stable `code:` prefix.
 *
 * Real wireArcadeReplicator + ArcadeGraphStore + SqliteOutboxStore + the real bulk route
 * over an in-memory fake of the ArcadeDB HTTP transport (deterministic: awaitable gates,
 * no sleeps, no ArcadeDB, no daemon).
 *
 * Run: npx tsx test/arcade-replay-lock-and-outcome-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// LORE_HOME must be pinned BEFORE any provisioner import resolves loreHomePath().
const LORE_HOME = path.join(os.tmpdir(), `arcade-replay-lock-lorehome-${Date.now().toString(36)}${process.pid.toString(36)}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { cellWorkspace } from '../packages/lore/src/engines/arcade/arcadeRequestContext.js';
import type { BoundArcadeCell } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { openRegistryDb, closeRegistryDb, upsertTenantAppRow } from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { secretRefFor } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { withNodeLock, withNodeLocks, withNodeLockWithin, withNodeLockBudgeted, NodeLockTimeoutError } from '../packages/lore/src/core/nodeWriteLock.js';
import { NodeAlreadyExistsError } from '../packages/lore/src/engines/graphShared/conditionalInsert.js';
import { RevisionConflictError } from '../packages/lore/src/engines/graphShared/revision.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
import { classifyItemWriteError, preReadFailureMessage } from '../packages/lore/src/mcp/http/routes/bulkWriteErrors.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const tmpDirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

/** An awaitable gate: `await g.open` blocks until `g.release()`. */
function gate(): { open: Promise<void>; release: () => void } {
    let release!: () => void;
    const open = new Promise<void>((r) => { release = r; });
    return { open, release };
}

// ── fake ArcadeDB transport ───────────────────────────────────────────────

type Row = Record<string, unknown>;
type CommandDecision = { apply: boolean; error: Error } | undefined;
class FakeArcade {
    nodes = new Map<string, Row>();
    /** Decides, per command, whether to fail it and whether the write still commits first (a lost response). */
    onCommand: ((sql: string, params: Row, fake: FakeArcade) => CommandDecision) | null = null;
    /** Number of upcoming single-row lookups (`... WHERE id = :id LIMIT 1`) that throw. */
    failReads = 0;
    commands: string[] = [];

    private rev(id: string): number { return Number(this.nodes.get(id)?.['revision'] ?? 0) || 0; }
    private put(id: string, assign: Row): void { this.nodes.set(id, { ...(this.nodes.get(id) ?? { id }), ...assign }); }

    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
        this.commands.push(sql.split(' ').slice(0, 3).join(' '));
        const decision = this.onCommand?.(sql, params, this);
        if (decision && !decision.apply) throw decision.error;
        const res = this.apply(sql, params);
        if (decision) throw decision.error;
        return res;
    }
    private apply(sql: string, params: Row): { result: unknown[] } {
        if (/^UPDATE LoreNode SET .* UPSERT WHERE id = :id$/s.test(sql)) {
            const { id, ...rest } = params; this.put(String(id), { ...rest, revision: this.rev(String(id)) + 1 });
            return { result: [{ count: 1 }] };
        }
        if (/^INSERT INTO LoreNode SET /.test(sql)) {
            const id = String(params['id']);
            if (this.nodes.has(id)) throw new ArcadeHttpError(503, 'Duplicated key [' + id + '] found on index LoreNode[id]');
            const revision = /revision = :revision$/.test(sql) ? Number(params['revision']) : 1;
            this.put(id, { ...params, revision });
            return { result: [{ count: 1 }] };
        }
        if (/ WHERE id = :id AND ifnull\(revision, 0\) = :expectedRevision$/.test(sql)) {
            const id = String(params['id']);
            if (this.rev(id) !== params['expectedRevision']) return { result: [{ count: 0 }] };
            const { id: _i, expectedRevision: _e, ...rest } = params;
            this.put(id, { ...rest, revision: this.rev(id) + 1 });
            return { result: [{ count: 1 }] };
        }
        if (/ WHERE id = :id AND ifnull\(revision, 0\) < :revision$/.test(sql)) {
            const id = String(params['id']);
            if (!(this.rev(id) < Number(params['revision']))) return { result: [{ count: 0 }] };
            const { id: _i, ...rest } = params;
            this.put(id, rest);
            return { result: [{ count: 1 }] };
        }
        if (/^DELETE VERTEX FROM LoreNode WHERE id = :id$/.test(sql)) { this.nodes.delete(String(params['id'])); return { result: [] }; }
        return { result: [] }; // DDL and anything this suite does not exercise
    }
    async commandScript(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) {
            if (this.failReads > 0) { this.failReads--; throw new Error('[ArcadeHttp] request timeout after 30000ms'); }
            const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] };
        }
        if (/FROM LoreNode WHERE id IN :ids$/.test(sql)) return { result: (params['ids'] as string[]).filter((i) => this.nodes.has(i)).map((i) => ({ ...this.nodes.get(i)! })) };
        return { result: [] };
    }
}

let current = new FakeArcade();
const realQuery = ArcadeHttp.prototype.query;
const realCommand = ArcadeHttp.prototype.command;
function installTransport(): void {
    ArcadeHttp.prototype.query = (async function (db: string, sql: string, params?: Row) { return current.query(db, sql, params ?? {}); }) as never;
    ArcadeHttp.prototype.command = (async function (db: string, sql: string, params?: Row) { return current.command(db, sql, params ?? {}); }) as never;
}
function uninstallTransport(): void { ArcadeHttp.prototype.query = realQuery; ArcadeHttp.prototype.command = realCommand; }

class NoopEmbedder implements EmbeddingProvider {
    get modelId() { return 'arcade-replay-lock-noop'; }
    get dimension() { return 4; }
    async initialize() { /* never embeds here */ }
    async embed() { return [0, 0, 0, 0]; }
    async embedQuery() { return [0, 0, 0, 0]; }
    async embedDocument() { return [0, 0, 0, 0]; }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => [0, 0, 0, 0]); }
}

const node = (id: string, label = id) => ({ id, type: 'note', label, content: label, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });
const STAMP = '2026-10-13T10:00:00.000Z';

// ── Part A: the replay handlers vs a live request, through the real replicator ──

let seq = 0;
function replayRig(tag: string, nodeLockWaitMs = 40) {
    installTransport();
    current = new FakeArcade();
    const n = ++seq;
    const tenantId = `rl${tag}t${n}`;
    const appId = `rl${tag}a${n}`;
    const registry = openRegistryDb();
    upsertTenantAppRow(registry, {
        tenantId, appId, dbName: `db_${tenantId}_${appId}`, dbUser: 'svc_user', dbPass: 'svc_pass',
        secretRef: secretRefFor(tenantId, appId), status: 'active', createdAt: new Date().toISOString(),
    });
    const store = new SqliteOutboxStore(mkTmp('arl-outbox-'), { retryBaseMs: 20 });
    const wiring = wireArcadeReplicator({ store, embedder: new NoopEmbedder(), nodeLockWaitMs });
    const lane = arcadeCellKey(tenantId, appId);
    const fake = current;
    // The request side: an ArcadeGraphStore over the very same fake rows.
    const graph = new ArcadeGraphStore({ tenantDb: `db_${tenantId}_${appId}`, http: fake as never });
    const record = (operationKind: 'node.upsert' | 'node.delete', payload: Record<string, unknown>) =>
        recordHotWrite(store, { workspace: lane, operationKind, payload, operation: operationKind === 'node.delete' ? 'graph.delete' : 'graph.upsert' });
    const pendingRows = async (): Promise<OutboxEntry[]> => store.listPendingForWorkspace(lane, 100);
    return { appId, lane, store, wiring, fake, graph, record, pendingRows, tick: () => wiring.replicator.tickOnce() };
}

/** Run `request` holding the request-path node lock for (workspace, id); resolves once the lock is held. */
async function holdingLock<T>(workspace: string, id: string, request: () => Promise<T>) {
    const g = gate();
    const held = gate();
    const done = withNodeLock(workspace, id, async () => { held.release(); await g.open; return request(); });
    await held.open;
    return { release: g.release, done };
}

console.log('\nM1. arcade node replay takes the request-path node lock\n');

await test('the replay lock key is the key the request path uses: cellWorkspace(cell), not the lane key', async () => {
    const rig = replayRig('key');
    // What every request path locks on, derived through the real function.
    const requestWorkspace = cellWorkspace({ principal: { appId: rig.appId } } as unknown as BoundArcadeCell);
    assert.equal(requestWorkspace, rig.appId);
    await rig.record('node.upsert', { ...node('k1'), updatedAt: STAMP, revision: 1 });

    // A request holding THAT key blocks the replay (it is deferred, nothing written, row back to pending).
    const held = await holdingLock(requestWorkspace, 'k1', async () => undefined);
    await rig.tick();
    assert.equal(rig.fake.nodes.has('k1'), false, 'replay ran under a held request lock: request and replay lock keys have diverged');
    const rows = await rig.pendingRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.attempts ?? 0, 0, 'a deferred replay burns no attempt');
    held.release(); await held.done;

    // Control: a lock held on the lane key (the wrong key) does not block it, so this test can tell the two apart.
    const wrong = await holdingLock(rig.lane, 'k1', async () => undefined);
    await rig.tick();
    assert.equal(rig.fake.nodes.has('k1'), true, 'a lock on a different key serialises nothing');
    wrong.release(); await wrong.done;
});

await test('ifAbsent: a replay cannot land inside the request, so the create is not refused as already_exists', async () => {
    const rig = replayRig('ifabsent');
    await rig.record('node.upsert', { ...node('a1', 'from request'), ifAbsent: true });
    // The request recorded its row, then (still holding the node lock) is about to write.
    const req = await holdingLock(rig.appId, 'a1', () => rig.graph.insertNodeIfAbsent(node('a1', 'from request')));
    await rig.tick();
    assert.equal(rig.fake.nodes.has('a1'), false, 'the replay must wait for the request (it used to insert first)');
    assert.equal((await rig.pendingRows()).length, 1, 'the row is back to pending');
    req.release();
    const created = await req.done; // pre-fix: NodeAlreadyExistsError
    assert.equal(created.label, 'from request');
    await rig.tick();
    assert.equal((await rig.pendingRows()).length, 0, 'the deferred replay then applies (a no-op over the existing node)');
    assert.equal(rig.fake.nodes.get('a1')!['revision'], 1);
});

await test('ifRevision: a replay cannot bump the revision under the request, so the conditional write is not refused', async () => {
    const rig = replayRig('ifrev');
    rig.fake.nodes.set('r1', { ...node('r1', 'before'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 1 });
    await rig.record('node.upsert', { ...node('r1', 'after'), updatedAt: STAMP, revision: 2 });
    const req = await holdingLock(rig.appId, 'r1', () => rig.graph.upsertNodeAtRevision(node('r1', 'after'), 1, STAMP, true));
    await rig.tick();
    assert.equal(rig.fake.nodes.get('r1')!['revision'], 1, 'the replay must not have written under the request lock');
    req.release();
    const written = await req.done; // pre-fix: RevisionConflictError -> false revision_mismatch
    assert.equal(written.revision, 2);
    await rig.tick();
    assert.equal((await rig.pendingRows()).length, 0);
    assert.equal(rig.fake.nodes.get('r1')!['revision'], 2, 'the replay is gated by the stored revision (no extra bump)');
    assert.equal(rig.fake.nodes.get('r1')!['label'], 'after');
});

await test('plain stamped write lands r+1, not r+2', async () => {
    const rig = replayRig('stamped');
    await rig.record('node.upsert', { ...node('s1', 'v1'), updatedAt: STAMP, revision: 1 });
    const req = await holdingLock(rig.appId, 's1', () => rig.graph.upsertNodeAtRevision(node('s1', 'v1'), 0, STAMP));
    await rig.tick();
    assert.equal(rig.fake.nodes.has('s1'), false);
    req.release();
    assert.equal((await req.done).revision, 1);
    await rig.tick();
    assert.equal(rig.fake.nodes.get('s1')!['revision'], 1, 'pre-fix the replay landed first and the request retried to revision 2');
    assert.equal((await rig.pendingRows()).length, 0);
});

await test('node.delete replay also waits for the request lock', async () => {
    const rig = replayRig('del');
    rig.fake.nodes.set('d1', { ...node('d1'), tags: '[]', revision: 1 });
    await rig.record('node.delete', { id: 'd1' });
    const req = await holdingLock(rig.appId, 'd1', async () => undefined);
    await rig.tick();
    assert.equal(rig.fake.nodes.has('d1'), true, 'the delete replay must wait for the request');
    assert.equal((await rig.pendingRows()).length, 1);
    req.release(); await req.done;
    await rig.tick();
    assert.equal(rig.fake.nodes.has('d1'), false);
    assert.equal((await rig.pendingRows()).length, 0);
});

await test('bounded wait: a stuck node defers only its own rows (kept in order, no attempts burned); other nodes still replay', async () => {
    const rig = replayRig('bounded');
    await rig.record('node.upsert', { ...node('b1', 'first'), updatedAt: STAMP, revision: 1 });
    await rig.record('node.upsert', { ...node('b1', 'second'), updatedAt: '2026-10-13T10:00:01.000Z', revision: 2 });
    await rig.record('node.upsert', { ...node('b2', 'other'), updatedAt: STAMP, revision: 1 });
    const req = await holdingLock(rig.appId, 'b1', async () => undefined); // a request stuck on a slow write
    const processed = await rig.tick();   // returns: the wait is bounded, the tick is not stalled
    assert.equal(rig.fake.nodes.has('b1'), false, 'neither b1 row ran, including the SECOND (order is kept)');
    assert.equal(rig.fake.nodes.get('b2')?.['label'], 'other', 'an unrelated node replayed in the same tick');
    const rows = await rig.pendingRows();
    assert.deepEqual(rows.map((r) => (r.payload as { label: string }).label), ['first', 'second']);
    assert.ok(rows.every((r) => r.status === 'pending' && (r.attempts ?? 0) === 0 && !r.lastError), 'pending, zero attempts, no error: not failed');
    assert.ok(processed >= 0);
    req.release(); await req.done;
    await rig.tick();
    assert.equal((await rig.pendingRows()).length, 0);
    assert.deepEqual([rig.fake.nodes.get('b1')!['label'], rig.fake.nodes.get('b1')!['revision']], ['second', 2], 'applied in order');
});

await test('per-tick budget: a bulk chunk of N held nodes costs one budget of wait, not N x waitMs; a free node still replays; the budget refills next tick', async () => {
    const N = 12, WAIT = 50;
    const rig = replayRig('budget', WAIT);
    const ids = Array.from({ length: N }, (_, i) => `chunk-${String(i).padStart(2, '0')}`);
    for (const id of ids) await rig.record('node.upsert', { ...node(id), updatedAt: STAMP, revision: 1 });
    await rig.record('node.upsert', { ...node('free-node', 'free'), updatedAt: STAMP, revision: 1 }); // recorded AFTER the blocked rows
    // A request holding the whole chunk (what bulkWrite does), stuck on a slow substrate write.
    const g = gate();
    const held = gate();
    const chunk = withNodeLocks(rig.appId, ids, async () => { held.release(); await g.open; });
    await held.open;

    const t0 = Date.now();
    await rig.tick();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < (N * WAIT) / 2, `tick took ${elapsed} ms: lock waits are summed per row (N x waitMs = ${N * WAIT} ms) instead of bounded per tick (~${WAIT} ms)`);
    assert.equal(rig.fake.nodes.get('free-node')?.['label'], 'free', 'a free node replays in the same tick even though the budget is spent');
    for (const id of ids) assert.equal(rig.fake.nodes.has(id), false, `${id} replayed under a held lock`);
    const rows = await rig.pendingRows();
    assert.equal(rows.length, N, 'every blocked row is back to pending');
    assert.ok(rows.every((r) => r.status === 'pending' && (r.attempts ?? 0) === 0 && !r.lastError), 'zero attempts, no error: deferred, not failed');

    // The budget is per tick: a second tick with the chunk still held spends a fresh budget (and still stays bounded).
    const t1 = Date.now();
    await rig.tick();
    assert.ok(Date.now() - t1 < (N * WAIT) / 2);
    assert.equal((await rig.pendingRows()).length, N);

    g.release(); await chunk;
    await rig.tick();
    assert.equal((await rig.pendingRows()).length, 0, 'once the chunk is released every row replays');
    for (const id of ids) assert.equal(rig.fake.nodes.get(id)?.['revision'], 1);
});

await test('withNodeLockBudgeted: an exhausted budget never defers a FREE lock; a held one rejects at once; waits are deducted', async () => {
    const budget = { remainingMs: 0 };
    assert.equal(await withNodeLockBudgeted('ws-b', 'free', budget, async () => 'ran'), 'ran', 'zero budget + free lock must run');
    for (let i = 0; i < 50; i++) assert.equal(await withNodeLockBudgeted('ws-b', `free-${i}`, budget, async () => i), i);

    const g = gate();
    const held = gate();
    const holder = withNodeLock('ws-b', 'busy', async () => { held.release(); await g.open; });
    await held.open;
    const t0 = Date.now();
    await assert.rejects(withNodeLockBudgeted('ws-b', 'busy', budget, async () => 'no'), (e) => e instanceof NodeLockTimeoutError);
    assert.ok(Date.now() - t0 < 20, 'a spent budget rejects without waiting');

    const wait = { remainingMs: 60 };
    await assert.rejects(withNodeLockBudgeted('ws-b', 'busy', wait, async () => 'no'), (e) => e instanceof NodeLockTimeoutError);
    assert.equal(wait.remainingMs, 0, 'a timeout empties the budget');
    g.release(); await holder;

    // A wait that succeeds deducts what it waited.
    const g2 = gate();
    const held2 = gate();
    const holder2 = withNodeLock('ws-b', 'brief', async () => { held2.release(); await g2.open; });
    await held2.open;
    const spend = { remainingMs: 5000 };
    const waiting = withNodeLockBudgeted('ws-b', 'brief', spend, async () => 'got');
    setTimeout(() => g2.release(), 30);
    assert.equal(await waiting, 'got');
    await holder2;
    assert.ok(spend.remainingMs < 5000 && spend.remainingMs > 0, `waited time is deducted (left ${spend.remainingMs})`);
});

await test('withNodeLockWithin: times out while held, never runs fn after abandoning, runs normally when free', async () => {
    const g = gate();
    const held = gate();
    const holder = withNodeLock('ws-w', 'x', async () => { held.release(); await g.open; });
    await held.open;
    let ran = false;
    await assert.rejects(withNodeLockWithin('ws-w', 'x', 20, async () => { ran = true; }), (e) => e instanceof NodeLockTimeoutError && e.id === 'x');
    g.release(); await holder;
    await withNodeLock('ws-w', 'x', async () => undefined); // drain the queue past the abandoned slot
    assert.equal(ran, false, 'an abandoned waiter must never run its fn');
    assert.equal(await withNodeLockWithin('ws-w', 'x', 1000, async () => 7), 7);
});

// ── Part B: the store re-reads after a failed write ──────────────────────────

console.log('\nM2. write outcome (ArcadeGraphStore over the fake transport)\n');

const timeoutErr = () => new Error('[ArcadeHttp] request timeout after 30000ms');
function storeRig() {
    const fake = new FakeArcade();
    return { fake, graph: new ArcadeGraphStore({ tenantDb: 't', http: fake as never }) };
}
const isWrite = (sql: string) => /^(INSERT INTO|UPDATE) LoreNode/.test(sql);

await test('insertNodeIfAbsent: a lost response whose insert committed is our own write', async () => {
    const { fake, graph } = storeRig();
    fake.onCommand = (sql) => (isWrite(sql) ? { apply: true, error: timeoutErr() } : undefined);
    const got = await graph.insertNodeIfAbsent(node('i1'));
    assert.equal(got.id, 'i1');
    assert.equal(fake.nodes.get('i1')!['revision'], 1);
});

await test('insertNodeIfAbsent: timeout, nothing committed -> outcome_unknown (no plain error), current revision null', async () => {
    const { fake, graph } = storeRig();
    fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: timeoutErr() } : undefined);
    await assert.rejects(graph.insertNodeIfAbsent(node('i2')), (e) => e instanceof OutcomeUnknownError && e.currentRevision === null && /^outcome_unknown: /.test(e.message));
});

await test('insertNodeIfAbsent: timeout while a rival created the node -> already_exists', async () => {
    const { fake, graph } = storeRig();
    fake.onCommand = (sql, _p, f) => { if (!isWrite(sql)) return undefined; f.nodes.set('i3', { ...node('i3', 'rival'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 1 }); return { apply: false, error: timeoutErr() }; };
    await assert.rejects(graph.insertNodeIfAbsent(node('i3')), (e) => e instanceof NodeAlreadyExistsError);
});

await test('insertNodeIfAbsent: a server-side refusal that wrote nothing is still the server error', async () => {
    const { fake, graph } = storeRig();
    fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: new ArcadeHttpError(503, 'unavailable') } : undefined);
    await assert.rejects(graph.insertNodeIfAbsent(node('i4')), (e) => e instanceof ArcadeHttpError && e.status === 503);
});

await test('insertNodeIfAbsent: the post-write read-back failing twice is outcome_unknown (the write DID commit); once is retried', async () => {
    const twice = storeRig();
    twice.fake.onCommand = (sql, _p, f) => { if (isWrite(sql)) f.failReads = 2; return undefined; };
    await assert.rejects(twice.graph.insertNodeIfAbsent(node('i5')), (e) => e instanceof OutcomeUnknownError && e.currentRevision === undefined);
    assert.equal(twice.fake.nodes.has('i5'), true, 'the node was written; only the answer is unknown');

    const once = storeRig();
    once.fake.onCommand = (sql, _p, f) => { if (isWrite(sql)) f.failReads = 1; return undefined; };
    assert.equal((await once.graph.insertNodeIfAbsent(node('i6'))).id, 'i6');
});

await test('upsertNodeAtRevision INSERT branch: lost response -> own write; nothing committed -> outcome_unknown; rival -> revision_conflict', async () => {
    const lost = storeRig();
    lost.fake.onCommand = (sql) => (isWrite(sql) ? { apply: true, error: timeoutErr() } : undefined);
    assert.equal((await lost.graph.upsertNodeAtRevision(node('u1'), 0, STAMP)).revision, 1);

    const none = storeRig();
    none.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: timeoutErr() } : undefined);
    await assert.rejects(none.graph.upsertNodeAtRevision(node('u2'), 0, STAMP), (e) => e instanceof OutcomeUnknownError && e.currentRevision === null);

    const rival = storeRig();
    rival.fake.onCommand = (sql, _p, f) => { if (!isWrite(sql)) return undefined; f.nodes.set('u3', { ...node('u3', 'rival'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 1 }); return { apply: false, error: timeoutErr() }; };
    await assert.rejects(rival.graph.upsertNodeAtRevision(node('u3'), 0, STAMP), (e) => e instanceof RevisionConflictError);
});

await test('upsertNodeAtRevision UPDATE branch: lost response -> own write; nothing committed -> outcome_unknown with the revision; rival -> revision_conflict; failed re-read -> outcome_unknown', async () => {
    const seed = (f: FakeArcade, id: string) => f.nodes.set(id, { ...node(id, 'old'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 3 });

    const lost = storeRig(); seed(lost.fake, 'p1');
    lost.fake.onCommand = (sql) => (isWrite(sql) ? { apply: true, error: timeoutErr() } : undefined);
    const got = await lost.graph.upsertNodeAtRevision(node('p1', 'new'), 3, STAMP);
    assert.deepEqual([got.revision, got.label], [4, 'new']);

    const none = storeRig(); seed(none.fake, 'p2');
    none.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: timeoutErr() } : undefined);
    await assert.rejects(none.graph.upsertNodeAtRevision(node('p2', 'new'), 3, STAMP), (e) => e instanceof OutcomeUnknownError && e.currentRevision === 3);
    assert.equal(none.fake.nodes.get('p2')!['label'], 'old', 'nothing was written and nothing compensating was built');

    const rival = storeRig(); seed(rival.fake, 'p3');
    rival.fake.onCommand = (sql, _p, f) => { if (!isWrite(sql)) return undefined; f.nodes.get('p3')!['revision'] = 5; return { apply: false, error: timeoutErr() }; };
    await assert.rejects(rival.graph.upsertNodeAtRevision(node('p3', 'new'), 3, STAMP), (e) => e instanceof RevisionConflictError && e.actual === 5);

    const blind = storeRig(); seed(blind.fake, 'p4');
    blind.fake.onCommand = (sql, _p, f) => { if (!isWrite(sql)) return undefined; f.failReads = 1; return { apply: false, error: timeoutErr() }; };
    await assert.rejects(blind.graph.upsertNodeAtRevision(node('p4', 'new'), 3, STAMP), (e) => e instanceof OutcomeUnknownError && e.currentRevision === undefined);

    const http503 = storeRig(); seed(http503.fake, 'p5');
    http503.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: new ArcadeHttpError(503, 'unavailable') } : undefined);
    await assert.rejects(http503.graph.upsertNodeAtRevision(node('p5', 'new'), 3, STAMP), (e) => e instanceof ArcadeHttpError, 'a refusal with the row unchanged stays the server error');
});


await test('conditional writes retry a busy (502/503/504) refusal that provably wrote nothing; a persistent one stays the server error; conflicts and own writes are never re-applied', async () => {
    const seed = (f: FakeArcade, id: string) => f.nodes.set(id, { ...node(id, 'old'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 3 });
    const busyThen = (n: number, status = 503) => { let writes = 0, left = n; return { hook: (sql: string) => { if (!isWrite(sql)) return undefined; writes++; if (left > 0) { left--; return { apply: false, error: new ArcadeHttpError(status, 'Please retry the operation') }; } return undefined; }, writes: () => writes }; };

    const upd = storeRig(); seed(upd.fake, 'r1'); const u = busyThen(1);
    upd.fake.onCommand = u.hook;
    const got = await upd.graph.upsertNodeAtRevision(node('r1', 'new'), 3, STAMP);
    assert.deepEqual([got.revision, got.label, u.writes()], [4, 'new', 2], 'one refused attempt, one applied write -> revision 4, not 5');

    const ins = storeRig(); const i = busyThen(2, 502);
    ins.fake.onCommand = i.hook;
    assert.equal((await ins.graph.insertNodeIfAbsent(node('r2'))).id, 'r2');
    assert.deepEqual([ins.fake.nodes.get('r2')!['revision'], i.writes()], [1, 3]);

    const stuck = storeRig(); seed(stuck.fake, 'r3'); const s = busyThen(99);
    stuck.fake.onCommand = s.hook;
    await assert.rejects(stuck.graph.upsertNodeAtRevision(node('r3', 'new'), 3, STAMP), (e) => e instanceof ArcadeHttpError && e.status === 503);
    assert.equal(s.writes(), 3, 'bounded: first attempt + QUERY_MAX_RETRIES (2)');
    assert.equal(stuck.fake.nodes.get('r3')!['label'], 'old');

    const rival = storeRig(); seed(rival.fake, 'r4'); let rw = 0;
    rival.fake.onCommand = (sql, _p, f) => { if (!isWrite(sql)) return undefined; rw++; f.nodes.get('r4')!['revision'] = 5; return { apply: false, error: new ArcadeHttpError(503, 'unavailable') }; };
    await assert.rejects(rival.graph.upsertNodeAtRevision(node('r4', 'new'), 3, STAMP), (e) => e instanceof RevisionConflictError && e.actual === 5);
    assert.equal(rw, 1, 'a rival is a conflict, never retried');

    const own = storeRig(); seed(own.fake, 'r5'); let ow = 0;
    own.fake.onCommand = (sql) => { if (!isWrite(sql)) return undefined; ow++; return { apply: true, error: new ArcadeHttpError(504, 'gateway timeout') }; };
    assert.equal((await own.graph.upsertNodeAtRevision(node('r5', 'new'), 3, STAMP)).revision, 4);
    assert.equal(ow, 1, 'a 504 whose write committed is our own write, not re-applied');

    const insRival = storeRig(); let iw = 0;
    insRival.fake.onCommand = (sql, _p, f) => { if (!isWrite(sql)) return undefined; iw++; f.nodes.set('r6', { ...node('r6', 'rival'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 1 }); return { apply: false, error: new ArcadeHttpError(503, 'unavailable') }; };
    await assert.rejects(insRival.graph.insertNodeIfAbsent(node('r6')), (e) => e instanceof NodeAlreadyExistsError);
    assert.equal(iw, 1);
});
// ── Part C: the bulk route ───────────────────────────────────────────────────

console.log('\nM2. bulk route: error codes, and no compensating row on an unknown outcome\n');

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakePost(body: string): IncomingMessage {
    let consumed = false;
    return { method: 'POST', on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); } if (ev === 'end') setImmediate(() => cb()); return this; } } as unknown as IncomingMessage;
}
interface Item { id: string; ok: boolean; error?: string; revision?: number; currentRevision?: number | null }
function bulkRig(tag: string) {
    const fake = new FakeArcade();
    const graph = new ArcadeGraphStore({ tenantDb: 't', http: fake as never });
    const outbox = new FileOutboxStore(mkTmp('arl-bulk-'));
    const ws = `arl-bulk-${tag}`;
    const bulk = async (nodes: Array<Record<string, unknown>>): Promise<Item[]> => {
        const res = fakeRes();
        await tryBulkWriteRoutes(fakePost(JSON.stringify({ workspace: ws, nodes, embed: 'skip' })), res, '/api/nodes/bulk', '/api/nodes/bulk',
            { store: { loreGraph: graph, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: outbox });
        return (JSON.parse(res._body) as { results: Item[] }).results;
    };
    // R3: an outcome-unknown item's row is kept as pending_commit (not claimable until settled against the graph), so list
    // every unfinished row of the workspace, not only the claimable ones.
    const rows = async () => (await outbox.listUnfinished!()).filter((e) => e.workspace === ws && (e.status === 'pending' || e.status === 'pending_commit'));
    return { fake, graph, outbox, bulk, rows };
}
const bnode = (id: string, label = id) => ({ id, type: 'decision', label, content: `content ${label}` });

await test('timeout on a new node, nothing committed: outcome_unknown + currentRevision null; the outbox row stays pending, untouched, no compensating row', async () => {
    const r = bulkRig('unknown-new');
    r.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: timeoutErr() } : undefined);
    const [item] = await r.bulk([bnode('c1')]);
    assert.equal(item!.ok, false);
    assert.match(item!.error!, /^outcome_unknown: /);
    assert.equal(item!.currentRevision, null);
    const rows = await r.rows();
    assert.deepEqual(rows.map((e) => [e.operationKind, (e.payload as { id: string }).id, (e.payload as { revision?: number }).revision]), [['node.upsert', 'c1', 1]],
        'one pending node.upsert row, the original, no node.delete / compensating row');
    assert.equal(rows[0]!.status, 'pending_commit', 'R3: kept NOT claimable - the replicator must not replay a predicted revision whose commit is unknown');
});

await test('timeout on an existing node, nothing committed: outcome_unknown carries the revision found; the original row stays', async () => {
    const r = bulkRig('unknown-existing');
    assert.equal((await r.bulk([bnode('c2', 'v1')]))[0]!.revision, 1);
    r.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: timeoutErr() } : undefined);
    const [item] = await r.bulk([bnode('c2', 'v2')]);
    assert.match(item!.error!, /^outcome_unknown: /);
    assert.equal(item!.currentRevision, 1);
    assert.equal(r.fake.nodes.get('c2')!['label'], 'v1', 'the graph is untouched');
    const labels = (await r.rows()).map((e) => (e.payload as { label?: string }).label);
    assert.ok(labels.includes('v2'), 'the v2 row was NOT retracted: it stays recorded and is settled against the graph');
    assert.equal((await r.rows()).find((e) => (e.payload as { label?: string }).label === 'v2')!.status, 'pending_commit', 'R3: the unknown-outcome row is held pending_commit until settled');
    assert.equal((await r.rows()).filter((e) => e.operationKind !== 'node.upsert').length, 0, 'no compensating row of another kind');
});

await test('a lost response whose write committed is reported ok with its revision', async () => {
    const r = bulkRig('lost');
    r.fake.onCommand = (sql) => (isWrite(sql) ? { apply: true, error: timeoutErr() } : undefined);
    const [item] = await r.bulk([bnode('c3')]);
    assert.deepEqual([item!.ok, item!.revision], [true, 1]);
});

await test('stable code prefixes: arcade_unavailable, arcade_error; already_exists keeps its shape', async () => {
    const r = bulkRig('codes');
    await r.bulk([bnode('c4')]);
    r.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: new ArcadeHttpError(503, 'service unavailable') } : undefined);
    assert.match((await r.bulk([bnode('c4', 'again')]))[0]!.error!, /^arcade_unavailable: /);
    r.fake.onCommand = (sql) => (isWrite(sql) ? { apply: false, error: new ArcadeHttpError(400, 'bad sql') } : undefined);
    assert.match((await r.bulk([bnode('c4', 'again')]))[0]!.error!, /^arcade_error: /);
    r.fake.onCommand = null;
    const res = fakeRes();
    await tryBulkWriteRoutes(fakePost(JSON.stringify({ workspace: 'arl-bulk-codes', nodes: [{ ...bnode('c4'), ifAbsent: true }], embed: 'skip' })), res, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.graph, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox });
    assert.match((JSON.parse(res._body) as { results: Item[] }).results[0]!.error!, /^already_exists: /);
});

await test('a failed read BEFORE the write is coded too (plain and ifRevision items); nothing is written', async () => {
    const r = bulkRig('preread');
    assert.equal((await r.bulk([bnode('c5', 'v1')]))[0]!.revision, 1);
    r.fake.failReads = 1000;
    const commandsBefore = r.fake.commands.length;
    const [plain] = await r.bulk([bnode('c5', 'v2')]);
    const [conditional] = await r.bulk([{ ...bnode('c5', 'v3'), ifRevision: 1 }]);
    r.fake.failReads = 0;
    for (const item of [plain!, conditional!]) {
        assert.equal(item.ok, false);
        assert.match(item.error!, /^timeout: could not read the node before writing: .*; nothing was written$/);
    }
    assert.equal(r.fake.commands.slice(commandsBefore).filter((c) => /^(UPDATE|INSERT|DELETE)/.test(c)).length, 0, 'no write was sent');
    assert.equal(r.fake.nodes.get('c5')!['label'], 'v1');
});

await test('preReadFailureMessage: same code contract as a write failure', () => {
    assert.equal(preReadFailureMessage(new ArcadeHttpError(503, 'down')).split(': ')[0], 'arcade_unavailable');
    assert.equal(preReadFailureMessage(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })), 'arcade_unavailable: could not read the node before writing: connect ECONNREFUSED 127.0.0.1:1; nothing was written');
    assert.equal(preReadFailureMessage(new Error('connect ECONNREFUSED 127.0.0.1:1')), 'write_failed: could not read the node before writing: connect ECONNREFUSED 127.0.0.1:1; nothing was written', 'a bare message without the errno code is not a proven refusal');
    assert.match(preReadFailureMessage(timeoutErr()), /^timeout: could not read the node before writing: /);
});

await test('classifyItemWriteError: every code, and existing prefixes are not doubled', () => {
    const c = (e: unknown) => classifyItemWriteError(e).error;
    assert.match(c(new NodeAlreadyExistsError('x')), /^already_exists: /);
    assert.match(c(new RevisionConflictError('x', 1, 2)), /^revision_conflict: /);
    assert.match(c(new OutcomeUnknownError('x', 4, new Error('boom'))), /^outcome_unknown: /);
    assert.equal(classifyItemWriteError(new OutcomeUnknownError('x', 4, new Error('boom'))).currentRevision, 4);
    assert.equal('currentRevision' in classifyItemWriteError(new OutcomeUnknownError('x', undefined, new Error('boom'))), false, 'unknown revision is omitted, not null');
    assert.match(c(new ArcadeHttpError(502, 'bad gateway')), /^arcade_unavailable: /);
    assert.match(c(new ArcadeHttpError(500, 'boom')), /^arcade_error: /);
    assert.match(c(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2480'), { code: 'ECONNREFUSED' })), /^arcade_unavailable: /);
    assert.match(c(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), /^write_failed: /, 'a reset may follow a sent request');
    assert.match(c(timeoutErr()), /^timeout: /);
    assert.match(c(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })), /^timeout: /);
    assert.equal(c(new Error('boom')), 'write_failed: boom');
    assert.equal(c(new Error('verbatim seed failed: x')), 'write_failed: verbatim seed failed: x');
    assert.equal(c(new Error('precondition_failed: x')), 'precondition_failed: x', 'an already-coded message is kept as is');
});

uninstallTransport();
try { closeRegistryDb(); } catch { /* not opened */ }
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(LORE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
