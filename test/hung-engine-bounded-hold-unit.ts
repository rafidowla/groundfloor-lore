#!/usr/bin/env tsx
/**
 * test/hung-engine-bounded-hold-unit.ts - 3.35.0 (b): a hung ArcadeDB (accepts connections, never
 * answers) must not pin a per-node write lock for minutes or let queued writers wait behind it
 * without bound, and the replicator must not write one identical log line per row per retry.
 *
 * No container: a real TCP server that accepts and never replies stands in for the paused engine,
 * and the REAL ArcadeHttp client (short request timeout) talks to it.
 *
 *   - lock hold on a hung engine <= request timeout + margin (the old code held it for the whole
 *     retry chain: query x3 attempts, then the write, then the settle re-read)
 *   - the hold fails with the existing "[ArcadeHttp] request timeout" error (outcome-unknown shape)
 *   - a writer queued behind a hung holder fails with NodeLockTimeoutError (the existing lock-wait
 *     error) within the wait budget and never runs; the HTTP mapping is 503 node_busy + Retry-After
 *   - a multi-id chunk behind a hung holder fails after ONE wait budget, not one per id
 *   - N repeated failures log ONE line, then a single suppressed-count summary per interval; a new
 *     error class and non-recurring lines are never suppressed
 *   - the replicator, against an unreachable engine, logs once for N pending rows
 *
 * Run: npx tsx test/hung-engine-bounded-hold-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArcadeHttp } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { isArcadeTransientReplayError } from '../packages/lore/src/engines/arcade/arcadeTransientErrors.js';
import { NodeLockTimeoutError, withNodeLock, withNodeLocks } from '../packages/lore/src/core/nodeWriteLock.js';
import { writeNodeBusy } from '../packages/lore/src/mcp/http/helpers.js';
import { LogThrottle } from '../packages/lore/src/outbox/logThrottle.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const TIMEOUT_MS = 400;
const MARGIN_MS = 450;
// Shorter than a hung holder's one request timeout, so a queued writer provably gives up before the holder is released.
const WAIT_MS = 150;
process.env['LORE_NODE_LOCK_WAIT_MS'] = String(WAIT_MS);

// A server that accepts every connection and never answers.
const sockets = new Set<net.Socket>();
const hung = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => undefined); });
await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
const port = (hung.address() as net.AddressInfo).port;
const engine = () => new ArcadeHttp({ user: 'root', pass: 'x' }, `http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });

/** What a node write does on Arcade: read the node, write it, re-read to settle. */
async function hungWrite(http: ArcadeHttp): Promise<Error> {
    for (const step of [() => http.query('db', 'SELECT 1'), () => http.command('db', 'UPDATE x SET y = 1'), () => http.query('db', 'SELECT 1')]) {
        try { await step(); } catch (err) { if (!/request timeout/.test((err as Error).message)) throw err; return err as Error; }
    }
    throw new Error('hung engine answered?');
}

console.log('lock hold on a hung engine');

await test('a write holding the node lock on a hung engine releases it within request timeout + margin, with the timeout error', async () => {
    const http = engine();
    const t0 = Date.now();
    let err: Error | undefined;
    await withNodeLock('ws', 'n1', async () => { err = await hungWrite(http); });
    const held = Date.now() - t0;
    assert.ok(held <= TIMEOUT_MS + MARGIN_MS, `lock held ${held} ms; bound is ${TIMEOUT_MS + MARGIN_MS} ms (old code: >= ${3 * TIMEOUT_MS} ms)`);
    assert.match(err!.message, /\[ArcadeHttp\] request timeout after 400ms/, 'existing timeout error shape');
});

await test('requests after the first timeout inside one hold fail at once (settle re-read cannot add another timeout)', async () => {
    const http = engine();
    await withNodeLock('ws', 'n2', async () => {
        await assert.rejects(http.query('db', 'SELECT 1'), /request timeout/);
        const t = Date.now();
        await assert.rejects(http.command('db', 'UPDATE x SET y = 1'), /request timeout/);
        await assert.rejects(http.query('db', 'SELECT 1'), /request timeout/);
        assert.ok(Date.now() - t < 100, `follow-up requests took ${Date.now() - t} ms`);
    });
});

await test('outside a lock hold nothing changes: a request still waits out its own timeout and queries still retry', async () => {
    const http = engine();
    const t0 = Date.now();
    await assert.rejects(http.query('db', 'SELECT 1'), /request timeout/);
    assert.ok(Date.now() - t0 >= 2 * TIMEOUT_MS, 'query retries outside a hold (unchanged behaviour)');
});

console.log('\nqueued writers');

await test('a writer queued behind a hung holder fails with the lock-wait error within the budget and never runs', async () => {
    const http = engine();
    let ran = false;
    const holder = withNodeLock('ws', 'q1', async () => { await hungWrite(http); });
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    await assert.rejects(withNodeLock('ws', 'q1', async () => { ran = true; }), (e: unknown) => e instanceof NodeLockTimeoutError);
    const waited = Date.now() - t0;
    assert.ok(waited <= WAIT_MS + MARGIN_MS, `queued writer waited ${waited} ms`);
    assert.equal(ran, false, 'the queued write must not run after a timeout');
    await holder;
});

await test('a queued writer still runs when the holder finishes inside the budget (no behaviour change for healthy holders)', async () => {
    const order: string[] = [];
    const a = withNodeLock('ws', 'q2', async () => { await new Promise((r) => setTimeout(r, 50)); order.push('a'); });
    await new Promise((r) => setTimeout(r, 10));
    const b = withNodeLock('ws', 'q2', async () => { order.push('b'); });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a', 'b']);
});

await test('a multi-id chunk behind hung holders fails after ONE wait budget, not one per id', async () => {
    const http = engine();
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const holders = ids.map((id) => withNodeLock('ws', id, async () => { await hungWrite(http); }));
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    await assert.rejects(withNodeLocks('ws', ids, async () => undefined), (e: unknown) => e instanceof NodeLockTimeoutError);
    const waited = Date.now() - t0;
    assert.ok(waited <= WAIT_MS + MARGIN_MS, `chunk waited ${waited} ms (4 ids x one budget each would be 4x)`);
    await Promise.all(holders);
});

await test('HTTP mapping: NodeLockTimeoutError -> 503 node_busy with Retry-After; other errors untouched', () => {
    const seen: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const res = { writeHead: (s: number, h: Record<string, string>) => { seen.status = s; seen.headers = h; }, end: (b: string) => { seen.body = b; } };
    assert.equal(writeNodeBusy(res as never, new NodeLockTimeoutError('ws', 'n', WAIT_MS)), true);
    assert.equal(seen.status, 503);
    assert.ok(seen.headers!['Retry-After']);
    assert.equal(JSON.parse(seen.body!).code, 'node_busy');
    const other: typeof seen = {};
    assert.equal(writeNodeBusy({ writeHead: () => { other.status = 1; }, end: () => undefined } as never, new Error('x')), false);
    assert.equal(other.status, undefined, 'nothing written for another error');
});

console.log('\nlog rate-limiting');

await test('N repeated failures of one class: 1 line, then ONE suppressed-count summary per interval', () => {
    const lines: string[] = [];
    let now = 1_000;
    const t = new LogThrottle((m) => lines.push(m), 60_000, () => now);
    for (let i = 0; i < 50; i++) t.log(`[outbox replicator] entry 0000000${i % 10}-aaaa-bbbb-cccc-00000000000${i % 10} transient failure #${i + 1}, retrying at 2026-10-15T10:00:${String(i).padStart(2, '0')}Z: [ArcadeHttp] request timeout after 30000ms`);
    assert.equal(lines.length, 1, 'first occurrence only');
    now += 30_000; t.flush();
    assert.equal(lines.length, 1, 'no summary before the interval elapses');
    now += 31_000; t.flush();
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /49 similar message\(s\) suppressed/);
    now += 200_000; t.flush();
    assert.equal(lines.length, 2, 'nothing more to summarise');
});

await test('a new error class is never suppressed; neither are non-recurring lines; the first occurrence of a class is never lost', () => {
    const lines: string[] = [];
    const t = new LogThrottle((m) => lines.push(m), 60_000, () => 5_000);
    t.log('[outbox replicator] entry a1b2c3d4-0000-0000-0000-000000000001 transient failure #1, retrying at x: [ArcadeHttp] request timeout after 30000ms');
    t.log('[outbox replicator] entry a1b2c3d4-0000-0000-0000-000000000002 transient failure #1, retrying at y: [ArcadeHttp] request timeout after 30000ms');
    t.log('[outbox replicator] entry a1b2c3d4-0000-0000-0000-000000000003 transient failure #1, retrying at y: connect ECONNREFUSED 127.0.0.1:2480');
    t.log('[outbox replicator] entry a1b2c3d4-0000-0000-0000-000000000004 marked dead: permanent');
    t.log('[outbox replicator] entry a1b2c3d4-0000-0000-0000-000000000005 marked dead: permanent');
    assert.equal(lines.length, 4, `got: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => /ECONNREFUSED/.test(l)), 'new class emitted');
    assert.equal(lines.filter((l) => /marked dead/.test(l)).length, 2, 'dead-letter lines are never throttled');
});

await test('replicator against an unreachable engine: N pending rows, ONE log line for the repeated transient failure (old: one per row per tick)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hung-logs-'));
    const store = new SqliteOutboxStore(dir);
    const logs: string[] = [];
    const substrates: DispatcherSubstrates = { upsertNode: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2480'), { code: 'ECONNREFUSED' }); } };
    const rep = new OutboxReplicator({ store, substrates, log: (m) => logs.push(m), config: { maxAttempts: 3, batchSize: 50 }, transientClassifier: isArcadeTransientReplayError, clock: { now: () => Date.now(), random: () => 0.5 } });
    for (let i = 0; i < 20; i++) {
        await recordHotWrite(store, { workspace: 'ws1', operationKind: 'node.upsert', payload: { id: `n${i}`, type: 'note', label: `n${i}`, content: 'c', tags: [], project: 'p', ecosystem: '*', metadata: '{}' }, operation: 'graph.upsert' });
    }
    for (let tick = 0; tick < 3; tick++) {
        await rep.tickOnce();
        (store as unknown as { db: { prepare(s: string): { run(): void } } }).db.prepare(`UPDATE outbox_entries SET nextAttemptAt = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'`).run();
    }
    const transient = logs.filter((l) => /transient failure/.test(l));
    assert.equal(transient.length, 1, `got ${transient.length} transient lines (old code: 60)`);
    assert.equal(rep.getStats().dead, 0);
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
});

for (const s of sockets) s.destroy();
hung.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
