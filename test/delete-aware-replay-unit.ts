#!/usr/bin/env tsx
/**
 * delete-aware-replay-unit.ts - Lore 3.34.0 slice 2 (Nokshi must-fix 3, delete-aware replay).
 *
 * The rule (outbox/deleteAwareReplay.ts, enforced by the shared OutboxReplicator): an UPSERT row of
 * ANY status is skipped as dead when the same entity has a LATER delete row that is pending,
 * replicating or replicated. A failed or dead delete does not count. A later re-create is untouched.
 * It lives in the shared outbox layer, so it is proved on both lanes:
 *   - the SQLite lane: the real wireOutbox replicator over a real SqliteGraph;
 *   - the arcade lane: the real wireArcadeReplicator over an in-memory fake of the ArcadeDB transport.
 * Plus the three families (node / edge / verbatim), isolation, fail-open and the lock requirement on
 * the arcade `deleteNode` replay.
 *
 * Run: npx tsx test/delete-aware-replay-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LORE_HOME = path.join(os.tmpdir(), `delete-aware-lorehome-${Date.now().toString(36)}${process.pid.toString(36)}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { openRegistryDb, closeRegistryDb, upsertTenantAppRow } from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { secretRefFor } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { isSupersededByLaterDelete } from '../packages/lore/src/outbox/deleteAwareReplay.js';
import { SUPERSEDED_DEAD_ERROR } from '../packages/lore/src/outbox/supersession.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { withNodeLock } from '../packages/lore/src/core/nodeWriteLock.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry, OutboxStatus } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const tmpDirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Db = { prepare(s: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };
const dbOf = (s: object): Db => (s as unknown as { db: Db }).db;
const statusOf = (s: object, id: string): OutboxStatus | undefined =>
    (dbOf(s).prepare('SELECT status FROM outbox_entries WHERE id = ?').get(id) as { status: OutboxStatus } | undefined)?.status;
const errorOf = (s: object, id: string): string | undefined =>
    (dbOf(s).prepare('SELECT lastError FROM outbox_entries WHERE id = ?').get(id) as { lastError?: string } | undefined)?.lastError;
const setStatus = (s: SqliteOutboxStore, id: string, st: OutboxStatus): Promise<unknown> => s.markEntryStatus(id, st, st === 'failed' || st === 'dead' ? { error: 'injected' } : undefined) as Promise<unknown>;
/** A failed row with an elapsed backoff, as a retry would see it. */
async function failRetryable(s: SqliteOutboxStore, id: string): Promise<void> {
    await s.markEntryStatus(id, 'failed', { error: 'injected transient failure', bumpAttempt: true });
    dbOf(s).prepare('UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
}

const node = (id: string, label = id) => ({ id, type: 'note', label, content: label, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });

// ── Part A: SQLite lane (real wireOutbox + real SqliteGraph) ──────────────

function sqliteLane(tag: string) {
    const ws = `da-${tag}`;
    const graph = new SqliteGraph(mkTmp('da-sqlite-graph-'), { workspaceId: ws });
    const wiring = wireOutbox({ loreDir: mkTmp('da-sqlite-outbox-'), getSyncEngine: () => ({}) as never, getGraph: () => graph as never });
    const store = wiring.store as SqliteOutboxStore;
    const rec = (kind: 'node.upsert' | 'node.delete', payload: Record<string, unknown>) =>
        recordHotWrite(store, { workspace: ws, operationKind: kind, payload, operation: kind === 'node.delete' ? 'graph.delete' : 'graph.upsert' });
    return { ws, graph, store, wiring, rec, tick: () => wiring.replicator.tickOnce() };
}

console.log('\nSQLite lane: a stale upsert never resurrects a later-deleted node\n');

await test('pending upsert (seq 1) + pending delete (seq 2): replay leaves the node deleted; the upsert row is dead', async () => {
    const l = sqliteLane('pp');
    const up = await l.rec('node.upsert', node('x1'));
    const del = await l.rec('node.delete', { id: 'x1' });
    assert.ok((up.sequenceId ?? 0) < (del.sequenceId ?? 0));
    await l.tick();
    assert.equal(await l.graph.getNode('x1'), null, 'the stale upsert must not recreate the node');
    assert.equal(statusOf(l.store, up.id), 'dead');
    assert.equal(errorOf(l.store, up.id), SUPERSEDED_DEAD_ERROR);
    assert.equal(statusOf(l.store, del.id), 'replicated');
});
await test('the node existed, then upsert(stale) + delete: the delete wins', async () => {
    const l = sqliteLane('live');
    await l.graph.upsertNode(node('x2', 'v0'));
    const up = await l.rec('node.upsert', node('x2', 'v1'));
    await l.rec('node.delete', { id: 'x2' });
    await l.tick();
    assert.equal(await l.graph.getNode('x2'), null);
    assert.equal(statusOf(l.store, up.id), 'dead');
});
await test('failed upsert (retryable) + pending delete: the retry does not resurrect', async () => {
    const l = sqliteLane('fp');
    const up = await l.rec('node.upsert', node('x3'));
    await failRetryable(l.store, up.id);
    await l.rec('node.delete', { id: 'x3' });
    await l.tick();
    assert.equal(await l.graph.getNode('x3'), null);
    assert.equal(statusOf(l.store, up.id), 'dead');
});
await test('upsert, delete, then a re-create (seq 3): only the stale upsert is skipped; the final state is the re-create', async () => {
    const l = sqliteLane('re');
    const up1 = await l.rec('node.upsert', node('x4', 'first'));
    await l.rec('node.delete', { id: 'x4' });
    const up3 = await l.rec('node.upsert', node('x4', 'recreated'));
    await l.tick();
    assert.equal(statusOf(l.store, up1.id), 'dead');
    assert.equal(statusOf(l.store, up3.id), 'replicated');
    assert.equal((await l.graph.getNode('x4'))?.label, 'recreated');
});
await test('a FAILED delete does not supersede: the earlier upsert still applies', async () => {
    const l = sqliteLane('fd');
    const up = await l.rec('node.upsert', node('x5'));
    const del = await l.rec('node.delete', { id: 'x5' });
    await setStatus(l.store, del.id, 'failed');
    dbOf(l.store).prepare('UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?').run('2999-01-01T00:00:00.000Z', del.id);
    await l.tick();
    assert.equal(statusOf(l.store, up.id), 'replicated');
    assert.ok(await l.graph.getNode('x5'), 'a delete that may never apply cannot cancel the upsert');
});
await test('a DEAD delete does not supersede either', async () => {
    const l = sqliteLane('dd');
    const up = await l.rec('node.upsert', node('x6'));
    const del = await l.rec('node.delete', { id: 'x6' });
    await setStatus(l.store, del.id, 'dead');
    await l.tick();
    assert.equal(statusOf(l.store, up.id), 'replicated');
    assert.ok(await l.graph.getNode('x6'));
});
await test('a replicating or replicated delete (as left by another tick) supersedes', async () => {
    for (const st of ['replicating', 'replicated'] as const) {
        const l = sqliteLane('st' + st);
        const up = await l.rec('node.upsert', node('x7'));
        const del = await l.rec('node.delete', { id: 'x7' });
        await setStatus(l.store, del.id, st);
        assert.equal(await l.store.hasNewerDeleteForKey(l.ws, 'node', 'x7', up.sequenceId!), true, st);
    }
});
await test('isolation: a delete of another id or in another workspace does not supersede', async () => {
    const l = sqliteLane('iso');
    const up = await l.rec('node.upsert', node('keep'));
    await l.rec('node.delete', { id: 'other-id' });
    const foreign = await recordHotWrite(l.store, { workspace: 'da-other-ws', operationKind: 'node.delete', payload: { id: 'keep' }, operation: 'graph.delete' });
    assert.equal(await l.store.hasNewerDeleteForKey(l.ws, 'node', 'keep', up.sequenceId!), false);
    await setStatus(l.store, foreign.id, 'dead'); // this lane has one boot graph; keep the foreign row out of the replay
    await l.tick();
    assert.ok(await l.graph.getNode('keep'));
});
await test('an EARLIER delete does not supersede a later upsert (ordering is by sequenceId)', async () => {
    const l = sqliteLane('ord');
    await l.rec('node.delete', { id: 'x8' });
    const up = await l.rec('node.upsert', node('x8'));
    assert.equal(await l.store.hasNewerDeleteForKey(l.ws, 'node', 'x8', up.sequenceId!), false);
    await l.tick();
    assert.ok(await l.graph.getNode('x8'));
});

console.log('\nFamilies and fail-open\n');

function substrateHarness(store: SqliteOutboxStore) {
    const applied: string[] = [];
    const substrates: DispatcherSubstrates = {
        async addEdge(p) { applied.push(`edge.upsert:${String(p['sourceId'])}`); },
        async deleteEdge(p) { applied.push(`edge.delete:${p.sourceId}`); },
        async upsertVerbatim(p) { applied.push(`verbatim.upsert:${String(p['id'])}`); },
        async tombstoneVerbatim(id) { applied.push(`verbatim.tombstone:${id}`); },
    };
    return { applied, rep: new OutboxReplicator({ store, substrates, config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 }, log: () => undefined }) };
}
await test('edge family: edge.upsert then edge.delete on the same triple: the upsert is dead, the delete applies', async () => {
    const store = new SqliteOutboxStore(mkTmp('da-edge-'), { retryBaseMs: 20 });
    const { applied, rep } = substrateHarness(store);
    const edge = { sourceId: 'A', targetId: 'B', relation: 'r' };
    const up = await recordHotWrite(store, { workspace: 'da-edge', operationKind: 'edge.upsert', payload: { ...edge, confidence: 'extracted' }, operation: 'graph.addEdge' });
    await recordHotWrite(store, { workspace: 'da-edge', operationKind: 'edge.delete', payload: edge, operation: 'graph.deleteEdge' });
    await rep.tickOnce();
    assert.deepEqual(applied, ['edge.delete:A']);
    assert.equal(statusOf(store, up.id), 'dead');
});
await test('verbatim family: verbatim.upsert then verbatim.tombstone: the upsert is dead (text is not resurrected)', async () => {
    const store = new SqliteOutboxStore(mkTmp('da-verb-'), { retryBaseMs: 20 });
    const { applied, rep } = substrateHarness(store);
    const up = await recordHotWrite(store, { workspace: 'da-verb', operationKind: 'verbatim.upsert', payload: { id: 'lore:V', text: 't' }, operation: 'verbatim.upsert' });
    await recordHotWrite(store, { workspace: 'da-verb', operationKind: 'verbatim.tombstone', payload: { id: 'lore:V' }, operation: 'verbatim.tombstone' });
    await rep.tickOnce();
    assert.deepEqual(applied, ['verbatim.tombstone:lore:V']);
    assert.equal(statusOf(store, up.id), 'dead');
});
await test('family scoping: a node.delete does not supersede an edge or verbatim upsert with the same key string', async () => {
    const store = new SqliteOutboxStore(mkTmp('da-fam-'), { retryBaseMs: 20 });
    const up = await recordHotWrite(store, { workspace: 'da-fam', operationKind: 'verbatim.upsert', payload: { id: 'lore:K', text: 't' }, operation: 'verbatim.upsert' });
    await recordHotWrite(store, { workspace: 'da-fam', operationKind: 'node.delete', payload: { id: 'lore:K' }, operation: 'graph.delete' });
    assert.equal(await store.hasNewerDeleteForKey('da-fam', 'verbatim', 'lore:K', up.sequenceId!), false);
});
await test('fail-open: a store without the probe, or one that throws, never blocks a replay', async () => {
    const entry = { id: 'e', operationKind: 'node.upsert', workspace: 'w', payload: { id: 'X' }, sequenceId: 1 } as unknown as OutboxEntry;
    const logs: string[] = [];
    assert.equal(await isSupersededByLaterDelete(new FileOutboxStore(mkTmp('da-file-')), entry, (m) => logs.push(m)), false);
    assert.equal(await isSupersededByLaterDelete({ hasNewerDeleteForKey: async () => { throw new Error('db gone'); } }, entry, (m) => logs.push(m)), false);
    assert.ok(logs.some((m) => /db gone/.test(m)), 'a probe failure is logged, not thrown');
    const notUpsert = { ...entry, operationKind: 'node.delete' } as OutboxEntry;
    assert.equal(await isSupersededByLaterDelete({ hasNewerDeleteForKey: async () => true }, notUpsert, () => undefined), false, 'only upserts are ever skipped');
    assert.equal(await isSupersededByLaterDelete({ hasNewerDeleteForKey: async () => true }, entry, () => undefined), true);
});

// ── Part B: arcade lane (real wireArcadeReplicator over a fake transport) ─

type Row = Record<string, unknown>;
class FakeArcade {
    nodes = new Map<string, Row>();
    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (/^UPDATE LoreNode SET .* UPSERT WHERE id = :id$/s.test(sql)) {
            const { id, ...rest } = params; this.nodes.set(String(id), { ...(this.nodes.get(String(id)) ?? { id }), ...rest, revision: Number(this.nodes.get(String(id))?.['revision'] ?? 0) + 1 });
            return { result: [{ count: 1 }] };
        }
        if (/^INSERT INTO LoreNode SET /.test(sql)) {
            const id = String(params['id']);
            if (this.nodes.has(id)) throw new ArcadeHttpError(503, 'Duplicated key');
            this.nodes.set(id, { ...params, revision: 1 });
            return { result: [{ count: 1 }] };
        }
        if (/^DELETE VERTEX FROM LoreNode WHERE id = :id$/.test(sql)) { this.nodes.delete(String(params['id'])); return { result: [] }; }
        return { result: [] };
    }
    async commandScript(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] }; }
        if (/FROM LoreNode WHERE id IN :ids$/.test(sql)) return { result: (params['ids'] as string[]).filter((i) => this.nodes.has(i)).map((i) => ({ ...this.nodes.get(i)! })) };
        return { result: [] };
    }
}
let current = new FakeArcade();
const realQuery = ArcadeHttp.prototype.query, realCommand = ArcadeHttp.prototype.command;
ArcadeHttp.prototype.query = (async function (db: string, sql: string, params?: Row) { return current.query(db, sql, params ?? {}); }) as never;
ArcadeHttp.prototype.command = (async function (db: string, sql: string, params?: Row) { return current.command(db, sql, params ?? {}); }) as never;
class NoopEmbedder implements EmbeddingProvider {
    get modelId() { return 'da-noop'; } get dimension() { return 4; }
    async initialize() { /* none */ }
    async embed() { return [0, 0, 0, 0]; } async embedQuery() { return [0, 0, 0, 0]; } async embedDocument() { return [0, 0, 0, 0]; }
    async embedDocumentBatch(t: string[]) { return t.map(() => [0, 0, 0, 0]); }
}
let seq = 0;
function arcadeLane(tag: string, nodeLockWaitMs = 40) {
    current = new FakeArcade();
    const n = ++seq, tenantId = `da${tag}t${n}`, appId = `da${tag}a${n}`;
    upsertTenantAppRow(openRegistryDb(), {
        tenantId, appId, dbName: `db_${tenantId}_${appId}`, dbUser: 'svc_user', dbPass: 'svc_pass',
        secretRef: secretRefFor(tenantId, appId), status: 'active', createdAt: new Date().toISOString(),
    });
    const store = new SqliteOutboxStore(mkTmp('da-arcade-outbox-'), { retryBaseMs: 20 });
    const wiring = wireArcadeReplicator({ store, embedder: new NoopEmbedder(), nodeLockWaitMs });
    const lane = arcadeCellKey(tenantId, appId);
    const rec = (kind: 'node.upsert' | 'node.delete', payload: Record<string, unknown>) =>
        recordHotWrite(store, { workspace: lane, operationKind: kind, payload, operation: kind === 'node.delete' ? 'graph.delete' : 'graph.upsert' });
    return { appId, lane, store, fake: current, rec, tick: () => wiring.replicator.tickOnce() };
}

console.log('\nArcade lane: the same rule through wireArcadeReplicator\n');

await test('pending upsert + pending delete: the node is never created; the upsert row is dead; the delete applies', async () => {
    const l = arcadeLane('pp');
    const up = await l.rec('node.upsert', { ...node('a1'), updatedAt: '2026-10-13T10:00:00.000Z', revision: 1 });
    const del = await l.rec('node.delete', { id: 'a1' });
    await l.tick();
    assert.equal(l.fake.nodes.has('a1'), false, 'no resurrection');
    assert.equal(statusOf(l.store, up.id), 'dead');
    assert.equal(statusOf(l.store, del.id), 'replicated');
});
await test('failed upsert + pending delete: the retry does not resurrect', async () => {
    const l = arcadeLane('fp');
    const up = await l.rec('node.upsert', { ...node('a2'), updatedAt: '2026-10-13T10:00:00.000Z', revision: 1 });
    await failRetryable(l.store, up.id);
    await l.rec('node.delete', { id: 'a2' });
    await l.tick();
    assert.equal(l.fake.nodes.has('a2'), false);
    assert.equal(statusOf(l.store, up.id), 'dead');
});
await test('upsert, delete, re-create: only the stale upsert is skipped', async () => {
    const l = arcadeLane('re');
    const u1 = await l.rec('node.upsert', { ...node('a3', 'first'), updatedAt: '2026-10-13T10:00:00.000Z', revision: 1 });
    await l.rec('node.delete', { id: 'a3' });
    const u3 = await l.rec('node.upsert', { ...node('a3', 'recreated'), updatedAt: '2026-10-13T10:00:02.000Z', revision: 1 });
    await l.tick();
    assert.equal(statusOf(l.store, u1.id), 'dead');
    assert.equal(statusOf(l.store, u3.id), 'replicated');
    assert.equal(l.fake.nodes.get('a3')?.['label'], 'recreated');
});
await test('a failed delete does not supersede on the arcade lane either', async () => {
    const l = arcadeLane('fd');
    const up = await l.rec('node.upsert', { ...node('a4'), updatedAt: '2026-10-13T10:00:00.000Z', revision: 1 });
    const del = await l.rec('node.delete', { id: 'a4' });
    await setStatus(l.store, del.id, 'dead');
    await l.tick();
    assert.equal(statusOf(l.store, up.id), 'replicated');
    assert.equal(l.fake.nodes.has('a4'), true);
});
await test('the arcade deleteNode replay takes the node lock (keyed on the cell appId): a held request lock defers it, nothing is deleted, no attempt is burned', async () => {
    const l = arcadeLane('lock');
    l.fake.nodes.set('a5', { ...node('a5'), tags: '[]', revision: 1 });
    await l.rec('node.delete', { id: 'a5' });
    let release!: () => void; let held!: () => void;
    const heldP = new Promise<void>((r) => { held = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withNodeLock(l.appId, 'a5', async () => { held(); await gate; });
    await heldP;
    await l.tick();
    assert.equal(l.fake.nodes.has('a5'), true, 'the delete replay ran under a held request lock');
    const rows = await l.store.listPendingForWorkspace(l.lane, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.attempts ?? 0, 0);
    release(); await holder;
    await l.tick();
    assert.equal(l.fake.nodes.has('a5'), false);
});

ArcadeHttp.prototype.query = realQuery;
ArcadeHttp.prototype.command = realCommand;
closeRegistryDb();
await sleep(10);
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
