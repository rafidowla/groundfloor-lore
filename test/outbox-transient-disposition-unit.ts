#!/usr/bin/env tsx
/**
 * test/outbox-transient-disposition-unit.ts - 3.35.0 (a)/(p): the replicator does not dead-letter
 * acknowledged writes on a TRANSIENT ArcadeDB failure (ConcurrentModification / outage).
 *
 * Real SqliteOutboxStore + real OutboxReplicator, substrate stubs that throw the real Arcade error
 * shapes, the real Arcade classifier injected the way arcadeOutboxWiring does it, and an injected
 * clock for the 24 h ceiling.
 *
 *   - CME x10 then success: `attempts` unchanged, never dead, ends replicated
 *   - unreachable x N: never dead, `attempts` unchanged
 *   - past the ceiling (injected clock): dead, reason 'transient_ceiling', error says so
 *   - a permanent error x maxAttempts: dead 'permanent', exactly as before
 *   - no classifier injected (SQLite / Dataplane): a CME-shaped error is an ordinary counted failure
 *   - restart mid-retry (new store + replicator on the same file) keeps the ceiling start
 *   - unwired / invalid payload dead immediately with their reason; requeueDead clears the bookkeeping
 *   - the verbatim consolidated path and the RA-6 guard (transient rows are 'failed', not 'pending')
 *
 * Run: npx tsx test/outbox-transient-disposition-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { isArcadeTransientReplayError } from '../packages/lore/src/engines/arcade/arcadeTransientErrors.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { transientBackoffMs, makeDispositionEnv } from '../packages/lore/src/outbox/failureDisposition.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxStatus } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-trans-')); dirs.push(d); return d; };

type Db = { prepare(s: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };
const dbOf = (s: object): Db => (s as unknown as { db: Db }).db;
interface RowView { status: OutboxStatus; attempts: number; transientRetries: number; firstTransientAt: string | null; deadReason: string | null; lastError: string | null }
const view = (s: object, id: string): RowView =>
    dbOf(s).prepare('SELECT status, attempts, transientRetries, firstTransientAt, deadReason, lastError FROM outbox_entries WHERE id = ?').get(id) as RowView;
/** Make a failed row eligible again (the test does not wait out the jittered backoff). */
const releaseBackoff = (s: object): void => { dbOf(s).prepare(`UPDATE outbox_entries SET nextAttemptAt = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'`).run(); };

const CME = JSON.stringify({ error: 'Error on transaction commit', detail: 'Concurrent modification on page PageId(file=3,num=1)', exception: 'com.arcadedb.exception.ConcurrentModificationException' });
const cme = (): Error => new ArcadeHttpError(500, CME);
const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2480'), { code: 'ECONNREFUSED' });
const permanent = (): Error => new ArcadeHttpError(500, JSON.stringify({ exception: 'java.lang.NullPointerException', error: 'x' }));

const node = (id: string) => ({ id, type: 'note', label: id, content: id, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });

interface Rig { dir: string; store: SqliteOutboxStore; rep: OutboxReplicator; applied: string[]; logs: string[]; clock: { t: number }; behave: { fn: (id: string) => void } }
function rig(opts: { classify?: boolean; dir?: string; clockT?: number; maxAttempts?: number } = {}): Rig {
    const dir = opts.dir ?? mkTmp();
    const store = new SqliteOutboxStore(dir);
    const applied: string[] = [];
    const logs: string[] = [];
    const behave = { fn: (_id: string) => undefined as void };
    const clock = { t: opts.clockT ?? Date.now() };
    const substrates: DispatcherSubstrates = {
        upsertNode: async (p) => { behave.fn(String(p['id'])); applied.push(String(p['id'])); },
    };
    const rep = new OutboxReplicator({
        store, substrates, log: (m) => logs.push(m),
        config: { maxAttempts: opts.maxAttempts ?? 3, batchSize: 50 },
        transientClassifier: opts.classify === false ? undefined : isArcadeTransientReplayError,
        clock: { now: () => clock.t, random: () => 0.5 },
    });
    return { dir, store, rep, applied, logs, clock, behave };
}
const write = (r: Rig, id: string) => recordHotWrite(r.store, { workspace: 'ws1', operationKind: 'node.upsert', payload: node(id), operation: 'graph.upsert' });

console.log('transient failures are not counted and never dead-letter');

await test('CME x10 then success: attempts unchanged, never dead, ends replicated', async () => {
    const r = rig();
    const row = await write(r, 'n1');
    let n = 0;
    r.behave.fn = () => { if (n++ < 10) throw cme(); };
    for (let i = 0; i < 12; i++) {
        await r.rep.tickOnce();
        const v = view(r.store, row.id);
        assert.notEqual(v.status, 'dead', `tick ${i}`);
        if (v.status === 'failed') { assert.equal(v.attempts, 0, 'attempts must not move on a CME'); releaseBackoff(r.store); }
    }
    const v = view(r.store, row.id);
    assert.equal(v.status, 'replicated');
    assert.equal(v.attempts, 0);
    assert.equal(v.transientRetries, 10);
    assert.deepEqual(r.applied, ['n1']);
    assert.equal(r.rep.getStats().dead, 0);
    assert.equal(r.rep.getStats().transientRetries, 10);
    assert.ok(r.logs.some((l) => /transient failure #1,/.test(l)), 'a transient retry is logged, not silent');
    assert.ok(!r.logs.some((l) => /marked dead/.test(l)));
});

await test('Arcade unreachable x many (maxAttempts=3): never dead', async () => {
    const r = rig();
    const row = await write(r, 'n2');
    r.behave.fn = () => { throw refused(); };
    for (let i = 0; i < 12; i++) { await r.rep.tickOnce(); releaseBackoff(r.store); }
    const v = view(r.store, row.id);
    assert.equal(v.status, 'failed');
    assert.equal(v.attempts, 0);
    assert.equal(v.transientRetries, 12);
    assert.equal(r.rep.getStats().dead, 0);
    // and when ArcadeDB comes back the SAME row replays
    r.behave.fn = () => undefined;
    await r.rep.tickOnce();
    assert.equal(view(r.store, row.id).status, 'replicated');
});

await test('a transient row is "failed" (not "pending"): the RA-6 supersession guard still runs on it', async () => {
    const r = rig();
    const row = await write(r, 'n3');
    r.behave.fn = () => { throw cme(); };
    await r.rep.tickOnce();
    assert.equal(view(r.store, row.id).status, 'failed');
    assert.ok(view(r.store, row.id).firstTransientAt, 'first-transient timestamp persisted');
});

console.log('\nthe transient time ceiling');

await test('past the ceiling (injected clock) the row goes dead with reason transient_ceiling and says why', async () => {
    const r = rig();
    const row = await write(r, 'n4');
    r.behave.fn = () => { throw cme(); };
    await r.rep.tickOnce();                       // first transient failure: firstTransientAt = real now
    assert.equal(view(r.store, row.id).status, 'failed');
    r.clock.t += 24 * 3_600_000 - 60_000;         // just inside the ceiling
    releaseBackoff(r.store);
    await r.rep.tickOnce();
    assert.equal(view(r.store, row.id).status, 'failed', 'still retrying inside the ceiling');
    r.clock.t += 120_000;                         // now beyond 24 h since firstTransientAt
    releaseBackoff(r.store);
    await r.rep.tickOnce();
    const v = view(r.store, row.id);
    assert.equal(v.status, 'dead');
    assert.equal(v.deadReason, 'transient_ceiling');
    assert.match(v.lastError ?? '', /ceiling reached/);
    assert.equal(v.attempts, 0, 'a ceiling death does not pretend attempts were burned');
    assert.equal(r.rep.getStats().dead, 1);
    assert.ok(r.logs.some((l) => /marked dead \(transient_ceiling\)/.test(l)));
});

await test('the ceiling is configurable (transientCeilingMs) and survives a restart (new store + replicator, same file)', async () => {
    const a = rig();
    const row = await write(a, 'n5');
    a.behave.fn = () => { throw refused(); };
    await a.rep.tickOnce();
    const first = view(a.store, row.id).firstTransientAt;
    assert.ok(first);
    a.store.close?.();
    // "restart": fresh objects over the same outbox.sqlite, clock 25 h later
    const b = rig({ dir: a.dir, clockT: Date.parse(first!) + 25 * 3_600_000 });
    b.behave.fn = () => { throw refused(); };
    releaseBackoff(b.store);
    await b.rep.tickOnce();
    const v = view(b.store, row.id);
    assert.equal(v.status, 'dead', 'a restart must not reset the ceiling start');
    assert.equal(v.deadReason, 'transient_ceiling');
    assert.equal(v.firstTransientAt, first);
});

await test('transientCeilingMs from config is honoured', async () => {
    const dir = mkTmp();
    const store = new SqliteOutboxStore(dir);
    let t = Date.now();
    const rep = new OutboxReplicator({
        store, substrates: { upsertNode: async () => { throw cme(); } }, log: () => undefined,
        config: { maxAttempts: 3, transientCeilingMs: 1000 },
        transientClassifier: isArcadeTransientReplayError, clock: { now: () => t, random: () => 0 },
    });
    const row = await recordHotWrite(store, { workspace: 'ws1', operationKind: 'node.upsert', payload: node('n6'), operation: 'graph.upsert' });
    await rep.tickOnce();
    t += 5000; releaseBackoff(store);
    await rep.tickOnce();
    assert.equal(view(store, row.id).status, 'dead');
});

console.log('\nbehaviour that must NOT change');

await test('a permanent error x maxAttempts goes dead exactly as before (reason permanent, attempts counted)', async () => {
    const r = rig({ maxAttempts: 3 });
    const row = await write(r, 'n7');
    r.behave.fn = () => { throw permanent(); };
    for (let i = 0; i < 3; i++) { await r.rep.tickOnce(); releaseBackoff(r.store); }
    const v = view(r.store, row.id);
    assert.equal(v.status, 'dead');
    assert.equal(v.deadReason, 'permanent');
    assert.equal(v.attempts, 3);
    assert.equal(v.transientRetries, 0);
    assert.ok(r.logs.some((l) => /marked dead \(permanent\)/.test(l)));
});

await test('no classifier injected (SQLite / Dataplane lanes): a CME-shaped error is an ordinary counted failure', async () => {
    const r = rig({ classify: false, maxAttempts: 3 });
    const row = await write(r, 'n8');
    r.behave.fn = () => { throw cme(); };
    for (let i = 0; i < 3; i++) { await r.rep.tickOnce(); releaseBackoff(r.store); }
    const v = view(r.store, row.id);
    assert.equal(v.status, 'dead');
    assert.equal(v.deadReason, 'permanent');
    assert.equal(v.transientRetries, 0);
});

await test('an unwired operation kind is dead immediately with reason "unwired"', async () => {
    const r = rig();
    const row = await recordHotWrite(r.store, { workspace: 'ws1', operationKind: 'edge.upsert', payload: { sourceId: 'a', targetId: 'b', relation: 'r' }, operation: 'graph.upsert' } as never);
    await r.rep.tickOnce();
    const v = view(r.store, row.id);
    assert.equal(v.status, 'dead');
    assert.equal(v.deadReason, 'unwired');
});

await test('requeueDead clears the transient bookkeeping so a requeued row gets a fresh ceiling', async () => {
    const r = rig();
    const row = await write(r, 'n9');
    r.behave.fn = () => { throw cme(); };
    await r.rep.tickOnce();
    r.clock.t += 25 * 3_600_000; releaseBackoff(r.store);
    await r.rep.tickOnce();
    assert.equal(view(r.store, row.id).status, 'dead');
    const n = await r.store.requeueDead!({ workspace: 'ws1' });
    assert.equal(n, 1);
    const v = view(r.store, row.id);
    assert.equal(v.status, 'failed');
    assert.equal(v.firstTransientAt, null);
    assert.equal(v.transientRetries, 0);
    assert.equal(v.deadReason, null);
});

console.log('\nbackoff');
await test('transientBackoffMs is full-jitter exponential, capped', () => {
    const env = makeDispositionEnv({ maxAttempts: 5, transientCeilingMs: 1, transientBaseMs: 500, transientCapMs: 60_000 }, undefined, { random: () => 0.999999 });
    assert.ok(transientBackoffMs(0, env) < 500);
    assert.ok(transientBackoffMs(3, env) < 4000 && transientBackoffMs(3, env) >= 3000);
    assert.ok(transientBackoffMs(40, env) < 60_000, 'capped');
    assert.equal(transientBackoffMs(5, makeDispositionEnv({ maxAttempts: 5, transientCeilingMs: 1, transientBaseMs: 500, transientCapMs: 60_000 }, undefined, { random: () => 0 })), 0);
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
