#!/usr/bin/env tsx
/**
 * test/link-queue-unit.ts - link-on-arrival: the durable queue, link selection and the worker loop.
 *
 *   queue     enqueue is idempotent (one row per workspace+node), claim/complete/retry, redo while claimed,
 *             restart resets claimed rows (replay), a re-run of the same signal links nothing twice,
 *             failed rows are parked after maxAttempts and re-armed by a fresh signal
 *   select    threshold, top-k, self/history/alias rows dropped, dedup, near-duplicates reported, sorted pair
 *   service   signal never throws or waits, quiet period + starvation guard, busy probe, seal/drain,
 *             stats lag, a crash mid-batch is replayed by the next process, the outbox is never touched
 *
 * Run: npx tsx test/link-queue-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteLinkQueue } from '../packages/lore/src/link/sqliteLinkQueue.js';
import { selectLinks, nodeIdOfRow } from '../packages/lore/src/link/selectLinks.js';
import { LinkService } from '../packages/lore/src/link/linkService.js';
import { signalCommitted } from '../packages/lore/src/link/signalCommitted.js';
import { LINK_DEFAULTS, isLinkOnArrivalEnabled, loadLinkConfig, type LinkRuntimeConfig } from '../packages/lore/src/link/linkConfig.js';
import type { LinkBatchResult, Linker, LinkItem } from '../packages/lore/src/link/linkTypes.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const tmpFile = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'link-q-')); dirs.push(d); return path.join(d, 'link-queue.sqlite'); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const item = (id: string, ecosystem?: string): LinkItem => ({ id, ...(ecosystem ? { ecosystem } : {}) });

const FAST: LinkRuntimeConfig = { ...LINK_DEFAULTS, quietMs: 0, maxDelayMs: 0, yieldMs: 0, batchSize: 4, maxAttempts: 3 };

class RecordingLinker implements Linker {
    calls: Array<{ workspace: string; ids: string[] }> = [];
    failFirst = 0;
    missingVector = new Set<string>();
    gate: Promise<void> | null = null;
    async linkBatch(workspace: string, items: LinkItem[]): Promise<LinkBatchResult> {
        if (this.gate) await this.gate;
        if (this.failFirst > 0) { this.failFirst--; throw new Error('boom'); }
        this.calls.push({ workspace, ids: items.map((i) => i.id) });
        const out: LinkBatchResult = { done: [], retry: [], edgesWritten: items.length, keptExisting: 0, skippedMissingEndpoint: 0, duplicates: [] };
        for (const it of items) {
            if (this.missingVector.has(it.id)) out.retry.push({ id: it.id, reason: 'no_vector' }); else out.done.push(it.id);
        }
        return out;
    }
}

// ───────────────────────── queue ─────────────────────────
console.log('\nqueue');

await test('enqueue is idempotent: the same node signalled twice is one row', () => {
    const q = new SqliteLinkQueue(tmpFile());
    q.enqueue('ws', [item('a'), item('b')], 1000);
    q.enqueue('ws', [item('a')], 2000);
    assert.deepEqual(q.counts(), { ready: 2, claimed: 0, failed: 0 });
    q.enqueue('other', [item('a')], 3000);
    assert.equal(q.counts().ready, 3, 'same id in another workspace is a distinct row');
    q.close();
});

await test('claim returns oldest first, marks rows claimed, never hands out a row twice', () => {
    const q = new SqliteLinkQueue(tmpFile());
    q.enqueue('ws', [item('b')], 2000); q.enqueue('ws', [item('a')], 1000); q.enqueue('ws', [item('c')], 3000);
    const c1 = q.claim(2, 0);
    assert.deepEqual(c1.rows.map((r) => r.nodeId), ['a', 'b']);
    const c2 = q.claim(10, 0);
    assert.deepEqual(c2.rows.map((r) => r.nodeId), ['c']);
    assert.deepEqual(q.counts(), { ready: 0, claimed: 3, failed: 0 });
    assert.equal(q.oldestPendingAt(), 1000, 'claimed rows still count as pending for lag');
    q.close();
});

await test('complete removes the row and counts it; completing twice (replay) is a no-op', () => {
    const q = new SqliteLinkQueue(tmpFile());
    q.enqueue('ws', [item('a')], 1);
    const c = q.claim(5, 0);
    assert.equal(q.complete(c.token, [{ workspace: 'ws', nodeId: 'a' }]), 1);
    assert.equal(q.complete(c.token, [{ workspace: 'ws', nodeId: 'a' }]), 0);
    assert.deepEqual(q.counts(), { ready: 0, claimed: 0, failed: 0 });
    assert.equal(q.totals().linked, 1, 'counted once');
    q.close();
});

await test('a fresh vector for a node that is mid-link re-queues it after the in-flight batch completes (redo)', () => {
    const q = new SqliteLinkQueue(tmpFile());
    q.enqueue('ws', [item('a')], 1);
    const c = q.claim(5, 0);
    q.enqueue('ws', [item('a')], 5); // re-embedded while claimed
    assert.equal(q.counts().claimed, 1);
    q.complete(c.token, [{ workspace: 'ws', nodeId: 'a' }]);
    assert.deepEqual(q.counts(), { ready: 1, claimed: 0, failed: 0 }, 'not lost: linked again against the new vector');
    q.close();
});

await test('durability: reopening the file resets claimed rows to ready and keeps everything queued', () => {
    const f = tmpFile();
    const q1 = new SqliteLinkQueue(f);
    q1.enqueue('ws', [item('a'), item('b'), item('c')], 10);
    q1.claim(2, 0); // process dies holding a and b
    q1.close();
    const q2 = new SqliteLinkQueue(f);
    assert.deepEqual(q2.counts(), { ready: 3, claimed: 0, failed: 0 });
    assert.equal(q2.oldestPendingAt(), 10, 'commit time survives the restart, so lag stays honest');
    q2.close();
});

await test('retry parks a row as failed after maxAttempts and a fresh signal re-arms it', () => {
    const q = new SqliteLinkQueue(tmpFile());
    q.enqueue('ws', [item('a')], 1);
    for (let i = 0; i < 3; i++) {
        const c = q.claim(1, 0);
        const r = q.retry(c.token, [{ workspace: 'ws', nodeId: 'a', reason: 'no_vector' }], 3);
        assert.equal(r.failed, i === 2 ? 1 : 0);
    }
    assert.deepEqual(q.counts(), { ready: 0, claimed: 0, failed: 1 });
    assert.equal(q.claim(5, 0).rows.length, 0, 'failed rows are not retried forever');
    assert.equal(q.totals().failed, 1);
    q.enqueue('ws', [item('a')], 9);
    assert.deepEqual(q.counts(), { ready: 1, claimed: 0, failed: 0 });
    assert.equal(q.claim(1, 0).rows[0]!.attempts, 0, 'attempts reset');
    q.close();
});

await test('duplicate candidates are upserted per (workspace, a, b) and listed best first', () => {
    const q = new SqliteLinkQueue(tmpFile());
    q.addDuplicates('ws', [{ a: 'a', b: 'b', score: 0.96 }, { a: 'a', b: 'c', score: 0.99 }], 1);
    q.addDuplicates('ws', [{ a: 'a', b: 'b', score: 0.97 }], 2);
    const l = q.listDuplicates('ws', 10);
    assert.deepEqual(l.map((d) => [d.a, d.b, d.score]), [['a', 'c', 0.99], ['a', 'b', 0.97]]);
    assert.deepEqual(q.listDuplicates('nope', 10), []);
    q.close();
});

// ───────────────────────── select ─────────────────────────
console.log('\nselect');
const POL = { minSim: 0.7, k: 3, dupSim: 0.95, policyVersion: 't' };

await test('threshold and top-k: only hits >= minSim, best k, as sorted (lo, hi) pairs', () => {
    const sel = selectLinks('m', [
        { id: 'lore:a', score: 0.9 }, { id: 'lore:b', score: 0.8 }, { id: 'lore:c', score: 0.75 },
        { id: 'lore:d', score: 0.72 }, { id: 'lore:e', score: 0.6 },
    ], POL);
    assert.deepEqual(sel.edges.map((e) => [e.sourceId, e.targetId, e.confidenceScore]), [['a', 'm', 0.9], ['b', 'm', 0.8], ['c', 'm', 0.75]]);
    assert.ok(sel.edges.every((e) => e.relation === 'semantic_neighbor'));
    assert.deepEqual(selectLinks('m', [{ id: 'lore:z', score: 0.7 }], POL).edges.map((e) => e.targetId), ['z'], 'boundary is inclusive');
    assert.equal(selectLinks('m', [{ id: 'lore:z', score: Number.NaN }], POL).edges.length, 0);
});

await test('self, history rows, question-alias rows, non-lore ids and duplicates of one node never produce an edge', () => {
    const sel = selectLinks('m', [
        { id: 'lore:m', score: 1 }, { id: 'lore:a#rev3', score: 0.9 }, { id: 'lore:a#q0', score: 0.95 },
        { id: 'chunk:x', score: 0.99 }, { id: 'lore:b', score: 0.8 }, { id: 'lore:b', score: 0.79 },
    ], POL);
    assert.deepEqual(sel.edges.map((e) => `${e.sourceId}-${e.targetId}`), ['b-m']);
    assert.equal(nodeIdOfRow('lore:a#q12'), null);
    assert.equal(nodeIdOfRow('lore:'), null);
    assert.equal(nodeIdOfRow('lore:abc'), 'abc');
});

await test('near-duplicates are linked AND reported as supersession candidates', () => {
    const sel = selectLinks('m', [{ id: 'lore:a', score: 0.97 }, { id: 'lore:b', score: 0.8 }], POL);
    assert.equal(sel.edges.length, 2);
    assert.deepEqual(sel.duplicates, [{ a: 'a', b: 'm', score: 0.97 }]);
});

await test('selection is deterministic on ties', () => {
    const hits = [{ id: 'lore:q', score: 0.8 }, { id: 'lore:p', score: 0.8 }, { id: 'lore:r', score: 0.8 }];
    const a = selectLinks('m', hits, { ...POL, k: 2 }).edges.map((e) => e.sourceId);
    const b = selectLinks('m', [...hits].reverse(), { ...POL, k: 2 }).edges.map((e) => e.sourceId);
    assert.deepEqual(a, b);
});

await test('config: flag is off unless explicitly on; env overrides are range-checked', () => {
    assert.equal(isLinkOnArrivalEnabled({}), false);
    assert.equal(isLinkOnArrivalEnabled({ LORE_LINK_ON_ARRIVAL: '0' }), false);
    assert.equal(isLinkOnArrivalEnabled({ LORE_LINK_ON_ARRIVAL: 'on' }), true);
    assert.equal(loadLinkConfig({ LORE_LINK_MIN_SIM: '0.8' }).minSim, 0.8);
    assert.equal(loadLinkConfig({ LORE_LINK_MIN_SIM: '7' }).minSim, LINK_DEFAULTS.minSim, 'out of range falls back');
    assert.equal(loadLinkConfig({ LORE_LINK_K: 'x' }).k, LINK_DEFAULTS.k);
});

// ───────────────────────── service ─────────────────────────
console.log('\nservice');

await test('signalCommitted is a no-op without a signaler/workspace and drops history and alias rows', () => {
    const seen: string[] = [];
    const sig = { signal: (_w: string, items: ReadonlyArray<LinkItem>) => { seen.push(...items.map((i) => i.id)); } };
    signalCommitted(null, 'ws', [{ id: 'lore:a' }]);
    signalCommitted(sig, undefined, [{ id: 'lore:a' }]);
    assert.deepEqual(seen, []);
    signalCommitted(sig, 'ws', [{ id: 'lore:a' }, { id: 'lore:a#rev2' }, { id: 'lore:a#q1' }, { id: 'lore:b', ecosystem: 'eco' }]);
    assert.deepEqual(seen, ['a', 'b']);
});

await test('signal returns immediately, never throws, and a worker links the queue in claim-size batches', async () => {
    const linker = new RecordingLinker();
    const svc = new LinkService({ queue: new SqliteLinkQueue(tmpFile()), linker, config: FAST });
    const t0 = Date.now();
    svc.signal('ws', ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id)));
    assert.ok(Date.now() - t0 < 50, 'caller does not wait');
    await svc.flush();
    assert.deepEqual(linker.calls.map((c) => c.ids.length), [4, 2], 'batchSize 4');
    const s = svc.stats();
    assert.equal(s.linkedTotal, 6);
    assert.equal(s.queue.ready + s.queue.claimed, 0);
    assert.equal(s.lagMs, 0, 'caught up');
    assert.ok(s.recentLagMs && s.recentLagMs.samples === 6);
    svc.close();
});

await test('a failing batch is retried, not lost; persistent no_vector parks as failed after maxAttempts', async () => {
    const linker = new RecordingLinker();
    linker.failFirst = 1;
    linker.missingVector.add('bad');
    const svc = new LinkService({ queue: new SqliteLinkQueue(tmpFile()), linker, config: FAST });
    svc.signal('ws', [item('ok'), item('bad')]);
    await svc.flush(50);
    const s = svc.stats();
    assert.equal(s.linkedTotal, 1, 'ok linked after one retry');
    assert.deepEqual(s.queue, { ready: 0, claimed: 0, failed: 1 }, 'bad is parked, visible');
    assert.equal(s.failedTotal, 1);
    svc.close();
});

await test('replay is idempotent: a process that died mid-batch is resumed by the next one, linking each node once', async () => {
    const f = tmpFile();
    const q1 = new SqliteLinkQueue(f);
    q1.enqueue('ws', [item('a'), item('b'), item('c')], 100);
    q1.claim(3, 0); // crash: claimed, never completed
    q1.close();
    const linker = new RecordingLinker();
    const svc = new LinkService({ queue: new SqliteLinkQueue(f), linker, config: FAST });
    svc.start();
    await svc.flush();
    assert.deepEqual(linker.calls.flatMap((c) => c.ids).sort(), ['a', 'b', 'c']);
    svc.signal('ws', [item('a')]); // the same arrival signalled again after replay
    await svc.flush();
    assert.equal(svc.stats().queue.ready, 0);
    svc.close();
});

await test('quiet period: nothing runs while arrivals keep coming; the starvation guard still bounds the wait', async () => {
    const linker = new RecordingLinker();
    const svc = new LinkService({ queue: new SqliteLinkQueue(tmpFile()), linker, config: { ...FAST, quietMs: 120, maxDelayMs: 400 } });
    svc.signal('ws', [item('a')]);
    await sleep(60);
    svc.signal('ws', [item('b')]);
    await sleep(60);
    assert.equal(linker.calls.length, 0, 'still inside the quiet period');
    await sleep(250);
    assert.equal(linker.calls.length, 1, 'ran after the quiet period');
    assert.deepEqual(linker.calls[0]!.ids.sort(), ['a', 'b']);
    svc.close();
});

await test('isBusy defers the worker (bounded by maxDelayMs)', async () => {
    const linker = new RecordingLinker();
    let busy = true;
    const svc = new LinkService({ queue: new SqliteLinkQueue(tmpFile()), linker, config: { ...FAST, quietMs: 30, maxDelayMs: 100_000 }, isBusy: () => busy });
    svc.signal('ws', [item('a')]);
    await sleep(200);
    assert.equal(linker.calls.length, 0, 'ingestion in flight: link work waits');
    busy = false;
    await sleep(150);
    assert.equal(linker.calls.length, 1);
    svc.close();
});

await test('seal stops new work, drain awaits the in-flight batch, queued rows stay durable for the next start', async () => {
    const f = tmpFile();
    const linker = new RecordingLinker();
    let release!: () => void;
    linker.gate = new Promise<void>((r) => { release = r; });
    const svc = new LinkService({ queue: new SqliteLinkQueue(f), linker, config: { ...FAST, batchSize: 1 } });
    svc.signal('ws', [item('a'), item('b')]);
    await sleep(40); // worker is now inside linkBatch(a)
    const drained = svc.drain(2000);
    release();
    assert.equal((await drained).timedOut, false);
    svc.signal('ws', [item('z')]); // sealed: ignored, no throw
    assert.equal(linker.calls.length, 1, 'only the in-flight batch finished');
    svc.close();
    const q = new SqliteLinkQueue(f);
    assert.equal(q.counts().ready, 1, 'b is still queued for the next start');
    q.close();
});

await test('drain reports timeout instead of hanging when a batch never finishes', async () => {
    const linker = new RecordingLinker();
    linker.gate = new Promise<void>(() => undefined);
    const svc = new LinkService({ queue: new SqliteLinkQueue(tmpFile()), linker, config: FAST });
    svc.signal('ws', [item('a')]);
    await sleep(40);
    const keepAlive = setTimeout(() => undefined, 5000); // drain's own timer is unref'd by design
    try { assert.equal((await svc.drain(80)).timedOut, true); } finally { clearTimeout(keepAlive); }
});

await test('the link queue is its own file: no outbox table is created and no outbox file is touched', () => {
    const f = tmpFile();
    const q = new SqliteLinkQueue(f);
    q.enqueue('ws', [item('a')], 1);
    q.close();
    assert.equal(path.basename(f), 'link-queue.sqlite');
    assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => /outbox/i.test(n)), []);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
