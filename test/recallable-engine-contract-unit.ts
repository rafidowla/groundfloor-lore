#!/usr/bin/env tsx
/**
 * test/recallable-engine-contract-unit.ts - 3.34.0 slice 3b (N5): ONE contract for the
 * "is it recallable yet?" capability, run against every engine that claims it.
 *
 *   sqlite        REAL SqliteVerbatimStore (temp dir) + REAL SqliteOutboxStore (stored == searchable)
 *   arcade (fake) REAL SqliteOutboxStore as the lane + a fake vector index with replication-to-index LAG
 *                 (the outbox row replicated but the index not answering yet => pending/awaiting_index)
 *   dataplane     REAL DataplaneVectorStore class: no embedding-presence read => explicit not_supported
 *
 * Contract cases (each engine that implements it): not_found for ids outside the workspace; pending
 * then recallable; a timeout is a STATUS, never an error; dead-lettered embeds settle as embed_failed;
 * all-before-now uses a high-water mark snapshotted at request time; the number of index checks is
 * bounded (no tight polling); the lag cache wakes the waiter on the replicator tick.
 *
 * Run: npx tsx test/recallable-engine-contract-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { OutboxLagCache } from '../packages/lore/src/outbox/lagCache.js';
import { awaitRecallable, recallableSupport, type RecallableDeps } from '../packages/lore/src/core/recallableWaiter.js';
import type { OutboxStore } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider, RecallableResult, RecallableNotSupported } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? String(e)}`); failed++; }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dirs: string[] = [];
function tmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
}

const WS = 'ws-a';
// waitForRefresh's timer is unref'd (a daemon must not be held open by it); keep this process alive for the test.
const keepAlive = setInterval(() => undefined, 1000);
const FAST = { initialMs: 20, capMs: 60, minGapMs: 20 };
const ok = (r: RecallableResult | RecallableNotSupported): RecallableResult => {
    assert.equal(r.supported, true, `expected supported result, got ${JSON.stringify(r)}`);
    return r as RecallableResult;
};

class FixedEmbedder implements EmbeddingProvider {
    readonly dimension = 4;
    readonly modelId = 'recallable-contract-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedDocument(_t?: string): Promise<number[]> { return [0.5, 0.5, 0.5, 0.5]; }
}

/** What an engine harness must offer so the same cases run against it. */
interface Harness {
    label: string;
    deps(): Omit<RecallableDeps, 'pacing'>;
    /** Write the node's outbox row (queued) and create the node in the graph. */
    queue(id: string): Promise<void>;
    /** The replicator applied the row AND the index answers for it (arcade: after `lagMs`). */
    embed(id: string): Promise<void>;
    /** The embed worker gave up on the row. */
    kill(id: string): Promise<void>;
    /** Number of index probes made so far, and the ids each asked about. */
    probeCalls(): string[][];
    /** A node that lives in ANOTHER workspace (same engine, different store). */
    foreign(id: string): Promise<void>;
    close(): void;
}

function graphStub(): { nodes: Set<string>; getNodesByIds(ids: string[]): Promise<Map<string, unknown>> } {
    const nodes = new Set<string>();
    return { nodes, async getNodesByIds(ids) { return new Map(ids.filter((i) => nodes.has(i)).map((i) => [i, { id: i }])); } };
}

async function queueRow(outbox: OutboxStore, ws: string, id: string): Promise<string> {
    const e = await recordHotWrite(outbox, { workspace: ws, operationKind: 'verbatim.upsert', payload: { id: `lore:${id}`, text: id }, operation: 'verbatim.upsert' });
    return e.id;
}

async function sqliteHarness(): Promise<Harness> {
    const store = new SqliteVerbatimStore(tmp('rc-sqlite-'), new FixedEmbedder());
    await store.initialize();
    const other = new SqliteVerbatimStore(tmp('rc-sqlite-other-'), new FixedEmbedder());
    await other.initialize();
    const outbox = new SqliteOutboxStore(tmp('rc-outbox-'));
    const graph = graphStub();
    const rows = new Map<string, string>();
    const calls: string[][] = [];
    const vector = {
        getVectors: async (ids: string[]) => { calls.push(ids); return store.getVectors(ids); },
    };
    return {
        label: 'sqlite',
        deps: () => ({ vector, graph, outbox, workspace: WS }),
        async queue(id) { graph.nodes.add(id); rows.set(id, await queueRow(outbox, WS, id)); },
        async embed(id) {
            await store.store({ id: `lore:${id}`, text: `text ${id}`, metadata: { type: 'note' } });
            const row = rows.get(id);
            if (row) await outbox.markEntryStatus!(row, 'replicated');
        },
        async kill(id) { await outbox.markEntryStatus!(rows.get(id)!, 'dead'); },
        probeCalls: () => calls,
        async foreign(id) { await other.store({ id: `lore:${id}`, text: 'foreign', metadata: { type: 'note' } }); },
        close() { outbox.close(); },
    };
}

async function arcadeFakeHarness(lagMs = 150): Promise<Harness> {
    const outbox = new SqliteOutboxStore(tmp('rc-arcade-outbox-'));
    const graph = graphStub();
    const indexed = new Set<string>();
    const foreignIndexed = new Set<string>(); // another workspace's cell: never visible through this handle
    const rows = new Map<string, string>();
    const calls: string[][] = [];
    const vector = {
        indexedIds: async (ids: string[]) => { calls.push(ids); return new Set(ids.filter((i) => indexed.has(i))); },
    };
    return {
        label: `arcade-fake(lag ${lagMs}ms)`,
        deps: () => ({ vector, graph, outbox, workspace: WS }),
        async queue(id) { graph.nodes.add(id); rows.set(id, await queueRow(outbox, WS, id)); },
        async embed(id) {
            await outbox.markEntryStatus!(rows.get(id)!, 'replicated'); // replicated NOW ...
            setTimeout(() => indexed.add(`lore:${id}`), lagMs);          // ... the index answers lagMs later
            if (lagMs === 0) indexed.add(`lore:${id}`);
        },
        async kill(id) { await outbox.markEntryStatus!(rows.get(id)!, 'dead'); },
        probeCalls: () => calls,
        async foreign(id) { foreignIndexed.add(`lore:${id}`); },
        close() { outbox.close(); },
    };
}

const engines: Array<[string, () => Promise<Harness>]> = [
    ['sqlite', sqliteHarness],
    ['arcade-fake', () => arcadeFakeHarness(150)],
];

for (const [name, make] of engines) {
    console.log(`\n${name}`);

    await test(`${name}: an id that does not exist, or lives in another workspace, is not_found`, async () => {
        const h = await make();
        await h.queue('mine');
        await h.embed('mine');
        await h.foreign('theirs');
        const r = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { ids: ['mine', 'theirs', 'never-existed'], timeoutMs: 2000 }));
        const by = new Map(r.ids!.map((s) => [s.id, s.status]));
        assert.equal(by.get('theirs'), 'not_found', 'an id from another workspace must be indistinguishable from a missing one');
        assert.equal(by.get('never-existed'), 'not_found');
        assert.equal(by.get('mine'), 'recallable');
        assert.equal(r.ready, false);
        assert.equal(r.timedOut, false, 'not_found settles immediately - nothing to wait for');
        assert.deepEqual(r.counts, { recallable: 1, pending: 0, notFound: 2 });
        h.close();
    });

    await test(`${name}: queued id is pending (queued) at timeout 0, then recallable once embedded`, async () => {
        const h = await make();
        await h.queue('n1');
        const early = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { ids: ['n1'], timeoutMs: 0 }));
        assert.equal(early.ready, false);
        assert.equal(early.timedOut, true);
        assert.deepEqual(early.ids, [{ id: 'n1', status: 'pending', reason: 'queued' }]);
        setTimeout(() => { void h.embed('n1'); }, 60);
        const t0 = Date.now();
        const late = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { ids: ['n1'], timeoutMs: 5000 }));
        assert.equal(late.ready, true);
        assert.equal(late.timedOut, false);
        assert.deepEqual(late.ids, [{ id: 'n1', status: 'recallable' }]);
        assert.ok(Date.now() - t0 < 3000, 'returns as soon as it is recallable, not at the timeout');
        h.close();
    });

    await test(`${name}: a timeout is a status (ready:false, timedOut:true), never a thrown error`, async () => {
        const h = await make();
        await h.queue('slow');
        const t0 = Date.now();
        const r = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { ids: ['slow'], timeoutMs: 250 }));
        assert.equal(r.ready, false);
        assert.equal(r.timedOut, true);
        assert.equal(r.ids![0]!.status, 'pending');
        const waited = Date.now() - t0;
        assert.ok(waited >= 200 && waited < 2000, `waited ${waited}ms for a 250ms timeout`);
        h.close();
    });

    await test(`${name}: a dead-lettered embed is pending(embed_failed) and returns without waiting out the timeout`, async () => {
        const h = await make();
        await h.queue('dead1');
        await h.kill('dead1');
        const t0 = Date.now();
        const r = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { ids: ['dead1'], timeoutMs: 5000 }));
        assert.deepEqual(r.ids, [{ id: 'dead1', status: 'pending', reason: 'embed_failed' }]);
        assert.equal(r.ready, false);
        assert.ok(Date.now() - t0 < 1500, 'embed_failed cannot be fixed by waiting');
        h.close();
    });

    await test(`${name}: index probes are bounded - one batched check for many ready ids, a handful while waiting`, async () => {
        const h = await make();
        const ids = Array.from({ length: 60 }, (_, i) => `b${i}`);
        for (const id of ids) { await h.queue(id); await h.embed(id); }
        await sleep(250); // let the arcade fake's index catch up
        const quick = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { ids, timeoutMs: 2000 }));
        assert.equal(quick.ready, true);
        assert.equal(quick.indexChecks, 1, 'all ready ids are answered by ONE batched probe');
        assert.equal(h.probeCalls().length, 1);

        await h.queue('stuck');
        const before = h.probeCalls().length;
        const waiting = ok(await awaitRecallable({ ...h.deps(), pacing: { initialMs: 50, capMs: 200, minGapMs: 50 } }, { ids: ['stuck'], timeoutMs: 1000 }));
        assert.equal(waiting.timedOut, true);
        // The first round asks the index; later rounds skip ids whose outbox row is still queued.
        assert.equal(h.probeCalls().length - before, 1, 'a still-queued id is not probed again after round 1');
        assert.ok(waiting.indexChecks <= 1);
        h.close();
    });

    await test(`${name}: every-round work is paced - never faster than minGapMs`, async () => {
        const h = await make();
        await h.queue('p1');
        await h.embed('p1');
        // Make the index appear later than the outbox so rounds keep happening (arcade); sqlite is instant.
        let rounds = 0;
        const deps = h.deps();
        const spy = { ...deps, outbox: { ...deps.outbox!, embedStatesForNodes: async (w: string, ids: string[]) => { rounds++; return deps.outbox!.embedStatesForNodes!(w, ids); } } };
        await awaitRecallable({ ...spy, pacing: { initialMs: 5, capMs: 5, minGapMs: 100 } }, { ids: ['p1', 'q-missing-forever'], timeoutMs: 450 });
        assert.ok(rounds <= 6, `with minGapMs=100 over 450ms there can be at most ~5 rounds, saw ${rounds}`);
        h.close();
    });

    await test(`${name}: all-before-now waits for the snapshot only - rows queued afterwards do not move the goalposts`, async () => {
        const h = await make();
        await h.queue('a1'); await h.queue('a2');
        const p = awaitRecallable({ ...h.deps(), pacing: FAST }, { allBeforeNow: true, timeoutMs: 5000 });
        await sleep(40);
        await h.queue('late'); // queued AFTER the request snapshot; never embedded in this test
        await h.embed('a1'); await h.embed('a2');
        const r = ok(await p);
        assert.equal(r.mode, 'all_before_now');
        assert.equal(r.ready, true, 'late row is after the high-water mark');
        assert.equal(r.timedOut, false);
        assert.equal(r.queuedRemaining, 0);
        assert.ok((r.highWaterSequenceId ?? 0) >= 2);
        assert.ok((r.sampled ?? 0) >= 1);
        // A fresh snapshot now includes the late row, which is still queued => not ready within the timeout.
        const r2 = ok(await awaitRecallable({ ...h.deps(), pacing: FAST }, { allBeforeNow: true, timeoutMs: 150 }));
        assert.equal(r2.ready, false);
        assert.equal(r2.timedOut, true);
        assert.equal(r2.queuedRemaining, 1);
        h.close();
    });
}

console.log('\nsqlite-specific');
await test('sqlite: a vector that is already stored is recallable even though the outbox row is still pending (local sync write path)', async () => {
    const store = new SqliteVerbatimStore(tmp('rc-sqlite-sync-'), new FixedEmbedder());
    await store.initialize();
    await store.store({ id: 'lore:sync1', text: 'x', metadata: { type: 'note' } });
    const g = graphStub();
    g.nodes.add('sync1');
    const outbox = new SqliteOutboxStore(tmp('rc-outbox-sync-'));
    await queueRow(outbox, WS, 'sync1'); // stays 'pending', exactly what the local sync write path leaves behind
    const r = ok(await awaitRecallable({ vector: store, graph: g, outbox, workspace: WS, pacing: FAST }, { ids: ['sync1'], timeoutMs: 1000 }));
    assert.deepEqual(r.ids, [{ id: 'sync1', status: 'recallable' }]);
    assert.equal(r.indexChecks, 1);
    outbox.close();
});

await test('file outbox store answers the same queries (embedStatesForNodes / embedBacklog parity)', async () => {
    const dir = tmp('rc-file-outbox-');
    const outbox = new FileOutboxStore(dir);
    const sq = new SqliteOutboxStore(tmp('rc-sq-parity-'));
    for (const ob of [outbox as OutboxStore, sq as OutboxStore]) {
        const a = await queueRow(ob, WS, 'x');
        await queueRow(ob, WS, 'y');
        await ob.markEntryStatus!(a, 'replicated');
        const states = await ob.embedStatesForNodes!(WS, ['x', 'y', 'z']);
        assert.equal(states.get('x'), 'replicated');
        assert.equal(states.get('y'), 'queued');
        assert.equal(states.has('z'), false);
        const none = await ob.embedBacklog!(WS, null, 0);
        assert.equal(none.highWaterSequenceId, 2);
        const bl = await ob.embedBacklog!(WS, 2, 5);
        assert.equal(bl.queued, 1);
        assert.deepEqual(bl.sampleNodeIds, ['x']);
        // another workspace's lane is invisible
        assert.equal((await ob.embedStatesForNodes!('other-ws', ['x'])).size, 0);
    }
    sq.close();
});

console.log('\ndataplane');
await test('dataplane: no embedding-presence read => explicit not_supported (never a guess, never a hang)', async () => {
    const store = new DataplaneVectorStore({
        connection: {} as never, client: {} as never, dataplaneWorkspaceId: 'dp', orgId: 'org',
        workspaceRegistry: { has: () => true } as never, embeddingProvider: new FixedEmbedder(),
    });
    const sup = recallableSupport({ vector: store as never });
    assert.ok(sup && sup.code === 'not_supported');
    const t0 = Date.now();
    const r = await awaitRecallable({ vector: store as never, workspace: WS }, { ids: ['a'], timeoutMs: 60_000 });
    assert.equal(r.supported, false);
    assert.equal((r as RecallableNotSupported).code, 'not_supported');
    assert.ok(Date.now() - t0 < 500, 'answers immediately');
});

await test('all-before-now without outbox position support => not_supported (explicit list form still works)', async () => {
    const r = await awaitRecallable({ vector: { indexedIds: async () => new Set() }, workspace: WS }, { allBeforeNow: true, timeoutMs: 100 });
    assert.equal(r.supported, false);
    const r2 = await awaitRecallable({ vector: { indexedIds: async (ids) => new Set(ids) }, graph: graphStub(), workspace: WS, pacing: FAST }, { ids: ['q'], timeoutMs: 100 });
    assert.equal(ok(r2).ready, true);
});

console.log('\nreplicator tick wake');
await test('waitForRefresh resolves on the next lag-cache refresh (the replicator tick), not at maxMs', async () => {
    const cache = new OutboxLagCache({ defaultLagThresholdSeconds: 30, depthThreshold: 1000 });
    const t0 = Date.now();
    const w = cache.waitForRefresh(10_000);
    setTimeout(() => cache.refresh({ depth: 0, lagSeconds: 0, dead: 0, perWorkspace: {} }), 30);
    await w;
    assert.ok(Date.now() - t0 < 1000, 'woken by refresh()');
});

await test('waitForRefresh honours maxMs and abort, and never rejects', async () => {
    const cache = new OutboxLagCache({ defaultLagThresholdSeconds: 30, depthThreshold: 1000 });
    const t0 = Date.now();
    await cache.waitForRefresh(60);
    assert.ok(Date.now() - t0 >= 50);
    const ac = new AbortController();
    const t1 = Date.now();
    const w = cache.waitForRefresh(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await w;
    assert.ok(Date.now() - t1 < 1000);
    await cache.waitForRefresh(10_000, AbortSignal.abort()); // already aborted
});

await test('awaitRecallable sleeps on waitForRefresh (replicator progress) instead of its own timer', async () => {
    const h = await arcadeFakeHarness(0);
    await h.queue('w1');
    let waits = 0;
    let wake: (() => void) | undefined;
    const waitForRefresh = (_ms: number) => { waits++; return new Promise<void>((res) => { wake = res; }); };
    const p = awaitRecallable({ ...h.deps(), waitForRefresh, pacing: { initialMs: 10_000, capMs: 10_000, minGapMs: 0 } }, { ids: ['w1'], timeoutMs: 20_000 });
    await sleep(80);
    assert.equal(waits, 1, 'parked on the tick, not polling');
    await h.embed('w1');
    wake!(); // the replicator tick
    const r = ok(await p);
    assert.equal(r.ready, true);
    assert.equal(waits, 1);
    h.close();
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
