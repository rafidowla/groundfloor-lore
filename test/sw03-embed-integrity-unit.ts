#!/usr/bin/env tsx
/**
 * test/sw03-embed-integrity-unit.ts — SW-03 embedding-pipeline integrity.
 *
 * Drives the REAL wireOutbox `storeEmbedBatch` + `batchedEmbedder`
 * substrate closures (reached via replicator.substrates, the same object
 * production uses) through the REAL dispatch('embed.batch') path — the
 * same code MCP-produced embed.batch rows flow through. This exercises
 * the three fixes from AUDIT_FINDINGS B4/B5/B10:
 *
 *   B4 — storeEmbedBatch must replace vectors ATOMICALLY. The old path
 *        did physicalDeleteMany(ids) THEN bulkAddPrebuiltRows(rows): a
 *        crash between the delete and the add left the node with NO
 *        vector (deleted-but-not-re-added) until a full re-embed. The
 *        branch uses one atomic bulkUpsertPrebuiltRows — a throw leaves
 *        the OLD or NEW vector, never neither.
 *
 *   B5 — embedBatch must assert returned-vector-count == input-text-count
 *        per chunk and THROW on mismatch, so a flaky provider that
 *        returns fewer vectors makes the outbox retry instead of
 *        persisting a misaligned / partial result.
 *
 *   B10 — (covered by the embed-queue unit below) the retry timer must
 *         resolve-drained / re-route when stop() ran first, so a
 *         retrying job is never stranded on shutdown.
 *
 * Each test FAILS on base (swarm/integration before SW-03) and PASSES on
 * the branch.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { EmbedQueue } from '../packages/lore/src/embed/queue.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

const DIM = 4;

/** Minimal graph fake — getNode returns the node so storeEmbedBatch does
 *  not skip it as "deleted since enqueue". */
function fakeGraph() {
    const ids = new Set<string>();
    return {
        seed(id: string) { ids.add(id); },
        async upsertNode(n: Record<string, unknown>) { ids.add(String(n['id'])); return n; },
        async addEdge() { /* no-op */ },
        async deleteNode(id: string) { ids.delete(id); return true; },
        async deleteEdge() { return 0; },
        async getNode(id: string) { return ids.has(id) ? { id, type: 't', label: 'l', embed: true } : null; },
        getGraphContext() { return { queryRows: async () => [{ c: 0 }] }; },
    };
}

/**
 * Verbatim fake modelling LanceDB id-keyed vector semantics, with a
 * `failOn` hook so a test can simulate a crash mid-persist.
 *
 *   - physicalDeleteMany(ids): removes those ids (the destructive half
 *     of the old non-atomic replace).
 *   - bulkAddPrebuiltRows(rows): the additive half — can be made to throw.
 *   - bulkUpsertPrebuiltRows(rows): the atomic replace — all-or-nothing.
 *
 * `vectors` is the source of truth for "does node N still have a vector?".
 */
function fakeVerbatim(opts: { failBulkAdd?: boolean; failBulkUpsert?: boolean } = {}) {
    return {
        vectors: new Map<string, number[]>(),
        deleteManyCalls: 0,
        bulkAddCalls: 0,
        bulkUpsertCalls: 0,
        seed(id: string, vector: number[]) { this.vectors.set(id, vector); },
        has(id: string) { return this.vectors.has(id); },
        async physicalDeleteMany(ids: string[]) {
            this.deleteManyCalls++;
            for (const id of ids) this.vectors.delete(id);
            return ids.length;
        },
        async bulkAddPrebuiltRows(rows: Array<Record<string, unknown>>) {
            this.bulkAddCalls++;
            if (opts.failBulkAdd) throw new Error('simulated crash during bulkAddPrebuiltRows');
            for (const r of rows) this.vectors.set(String(r['id']), r['vector'] as number[]);
        },
        async bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>) {
            this.bulkUpsertCalls++;
            // Atomic: if it throws, NOTHING is mutated.
            if (opts.failBulkUpsert) throw new Error('simulated crash during bulkUpsertPrebuiltRows');
            for (const r of rows) this.vectors.set(String(r['id']), r['vector'] as number[]);
        },
        // unused-but-present substrate surface
        async store() { /* no-op */ },
        async storeBatch() { /* no-op */ },
        async physicalDelete(id: string) { this.vectors.delete(id); },
        async getById(id: string) { return this.vectors.has(id) ? { id } : null; },
    };
}

/** Provider fake. `shortBy` makes embedDocumentBatch return fewer vectors
 *  than texts (the B5 flaky-provider case). */
class FakeProvider implements EmbeddingProvider {
    public readonly dimension = DIM;
    public readonly modelId = 'fake/sw03';
    public batchCalls = 0;
    constructor(private readonly shortBy = 0) {}
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedQuery(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(_t: string): Promise<number[]> { return new Array(DIM).fill(0.5); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        this.batchCalls++;
        const n = Math.max(0, texts.length - this.shortBy);
        return texts.slice(0, n).map(() => new Array(DIM).fill(0.5));
    }
}

function entry(payload: Record<string, unknown>): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id: `e-${Math.random().toString(36).slice(2)}`,
        operation: 'embed.batch', initiator: 'test', createdAt: now, updatedAt: now,
        steps: [], completed: false, workspace: undefined, operationKind: 'embed.batch',
        payload, status: 'pending', attempts: 0,
    };
}

function substratesFromWiring(graph: ReturnType<typeof fakeGraph>, verbatim: ReturnType<typeof fakeVerbatim>, provider: EmbeddingProvider): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw03-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => verbatim as never,
        getEmbedder: () => provider,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

console.log('SW-03 — embedding-pipeline integrity');

/* ---------- B4: atomic replace ---------- */

test('B4: a crash mid-persist on a re-embed leaves the node WITH a vector (atomic replace)', async () => {
    // Re-embed scenario: node n1 already has an OLD vector. The replace
    // is forced to crash during persistence. On base (delete-then-add)
    // the old vector is deleted first, then the add throws → n1 has NO
    // vector. On branch (atomic upsert) the upsert throws as a unit → the
    // old vector survives. Either way the dispatch throws (outbox retries),
    // but the node must NEVER be left without a vector.
    const graph = fakeGraph();
    graph.seed('n1');
    const oldVec = new Array(DIM).fill(0.1);
    // Fail BOTH the additive paths so base and branch both attempt-and-fail.
    const verbatim = fakeVerbatim({ failBulkAdd: true, failBulkUpsert: true });
    verbatim.seed('lore:n1', oldVec);
    const subs = substratesFromWiring(graph, verbatim, new FakeProvider());

    await assert.rejects(
        dispatch(entry({ texts: ['fresh text'], targetNodeIds: ['lore:n1'] }), subs),
        'the failed persist must propagate so the outbox retries',
    );

    assert.equal(
        verbatim.has('lore:n1'), true,
        'n1 must STILL have a vector after a crashed re-embed — no deleted-but-not-re-added window',
    );
    // On the branch the atomic path is used and the destructive deleteMany
    // is never called.
    assert.equal(verbatim.deleteManyCalls, 0, 'atomic path must not pre-delete vectors');
    assert.equal(verbatim.bulkUpsertCalls, 1, 'must go through the atomic upsert');
});

test('B4: a successful re-embed updates the vector via the atomic path', async () => {
    const graph = fakeGraph();
    graph.seed('n2');
    const verbatim = fakeVerbatim();
    verbatim.seed('lore:n2', new Array(DIM).fill(0.1));
    const subs = substratesFromWiring(graph, verbatim, new FakeProvider());

    await dispatch(entry({ texts: ['t2'], targetNodeIds: ['lore:n2'] }), subs);

    assert.equal(verbatim.has('lore:n2'), true, 'vector present after successful re-embed');
    assert.deepEqual(verbatim.vectors.get('lore:n2'), new Array(DIM).fill(0.5), 'vector refreshed to the new embedding');
    assert.equal(verbatim.deleteManyCalls, 0, 'no destructive pre-delete on the happy path either');
});

/* ---------- B5: short/partial provider response ---------- */

test('B5: a provider returning fewer vectors than texts THROWS (outbox retries) and persists nothing', async () => {
    const graph = fakeGraph();
    graph.seed('a');
    graph.seed('b');
    graph.seed('c');
    const verbatim = fakeVerbatim();
    // Provider drops one vector — 3 texts in, 2 vectors out.
    const subs = substratesFromWiring(graph, verbatim, new FakeProvider(1));

    await assert.rejects(
        dispatch(entry({ texts: ['ta', 'tb', 'tc'], targetNodeIds: ['lore:a', 'lore:b', 'lore:c'] }), subs),
        /returned 2 vectors for 3 texts|misaligned/i,
    );

    // The misalignment must be caught BEFORE any persist — no partial /
    // mis-aligned rows in the store.
    assert.equal(verbatim.vectors.size, 0, 'no vectors persisted from a short provider response');
    assert.equal(verbatim.bulkUpsertCalls, 0, 'storeEmbedBatch must not run on a count mismatch');
});

test('B5: a matched provider response persists all vectors', async () => {
    const graph = fakeGraph();
    graph.seed('a');
    graph.seed('b');
    const verbatim = fakeVerbatim();
    const subs = substratesFromWiring(graph, verbatim, new FakeProvider(0));

    await dispatch(entry({ texts: ['ta', 'tb'], targetNodeIds: ['lore:a', 'lore:b'] }), subs);

    assert.equal(verbatim.vectors.size, 2, 'both vectors persisted');
    assert.equal(verbatim.has('lore:a') && verbatim.has('lore:b'), true);
});

/* ---------- B10: retry timer must not strand a job after stop() ---------- */

test('B10: a job retrying when stop() ran is not stranded — drained() still resolves', async () => {
    // Force the first attempt to fail so the job enters the backoff gap,
    // then stop() during that gap. The retry timer fires into a
    // non-running queue: pump() can never dispatch the job again. On base
    // the job is re-parked in `pending` (stranded) and any drained()
    // awaiter hangs forever. On branch the job is re-routed to permanent
    // failure (recorded, not lost) and drained() resolves.
    let attempts = 0;
    const permFailed: string[] = [];
    const q = new EmbedQueue({
        maxRetries: 3,
        initialBackoffMs: 10,
        concurrency: 1,
        onPermanentFailure: (job) => { permFailed.push(job.nodeId); },
    });
    q.start(async () => {
        attempts++;
        throw new Error('transient — force a retry');
    });
    q.enqueue('n', 'text');
    // Let the first attempt run + fail, scheduling the retry timer.
    await new Promise(r => setTimeout(r, 2));
    q.stop();

    // drained() must resolve within a bounded window (the fix), not hang.
    await Promise.race([
        q.drained(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drained() hung — retry job stranded after stop()')), 500)),
    ]);

    assert.ok(attempts >= 1, 'the job attempted at least once');
    assert.equal(q.stats().pending, 0, 'no job left stranded in pending after stop()');
    // The re-routed job is recorded as a permanent failure, not silently lost.
    assert.deepEqual(permFailed, ['n'], 'a job retrying past stop() is re-routed to onPermanentFailure');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
