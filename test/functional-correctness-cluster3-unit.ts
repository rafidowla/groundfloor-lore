#!/usr/bin/env tsx
/**
 * functional-correctness-cluster3-unit.ts — 2026-08-17 functional-correctness
 * audit, Cluster 3: "No protection against concurrent or repeated writes to
 * the same item (races, duplicates, stale-wins)".
 *
 * Covers, each through the REAL production entry point and matching the
 * plan's RAN-AND-OBSERVED repro shape:
 *
 *   3.2 (HIGH)  Outbox verbatim.upsert consolidation (collectVerbatimUpsertRun
 *               → one storeBatch) never deduped payload.id: two rapid edits to
 *               one node in one tick → TWO permanent canonical rows, getById
 *               returned the STALE one, both outbox rows 'replicated'.
 *               Fix: dedupe keep-last at the storeBatch sink.
 *   3.3 (HIGH)  Same mechanism, distinct repro: two PENDING verbatim.upsert
 *               rows for 'lore:meeting-notes' in one tickOnce() → listIds
 *               returned the id twice and it never self-healed (a later edit
 *               updated BOTH duplicate rows). Fix: same sink dedupe; this test
 *               also locks the self-heal leg.
 *   3.4 (HIGH)  bulkIngest with duplicate ids in ONE call: verbatim side wrote
 *               two canonical rows per id (mergeInsert doesn't collapse
 *               duplicate SOURCE keys) and the graph side raced (mapLimit over
 *               the raw array → later entry didn't reliably win). Fix: Step 0
 *               dedupe keep-last before the graph fan-out and vector writes.
 *   3.5 (HIGH)  EmbedQueue: no per-nodeId coalescing — two enqueues for one
 *               node ran concurrently and the superseded text could win the
 *               vector row, both jobs 'done'. Fix: supersede-in-place for
 *               pending jobs + per-id in-flight serialization + stale-retry
 *               drop.
 *   medium      LanceDB table creation race ("already exists" on cold
 *               workspace) → ensureVerbatimTable opens instead of throwing.
 *   medium      tombstone() delete-then-add → single atomic mergeInsert.
 *   medium      nodeUpsertBatch: first per-node throw aborted the WHOLE batch
 *               (logEmbeddedWrite rethrows out of mapLimit) → per-node slot.
 *   low         autolink encoded the similarity score in the relation name, so
 *               re-embedding added a SECOND semantic edge per pair → relation
 *               is now the bare prefix, score lives in confidenceScore.
 *
 * Run: npx tsx test/functional-correctness-cluster3-unit.ts
 *      (or: npm run test:unit:functional-correctness-cluster3)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';
import { EmbedQueue } from '../packages/lore/src/embed/queue.js';
import { wireEmbedQueue } from '../packages/lore/src/embed/wiring.js';
import { reconnectOneNode } from '../packages/lore/src/engines/reconnect.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 384;
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

/** Deterministic stub embedder — no ONNX. Vector is derived from the text so
 *  identical texts embed identically; a `vectorFor` override map can key
 *  specific vectors by substring (the autolink test needs controlled sims). */
function stubProvider(vectorFor?: (text: string) => number[] | undefined): EmbeddingProvider {
    const vec = (text: string): number[] => {
        const overridden = vectorFor?.(text);
        if (overridden) return overridden;
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        const v = new Array<number>(DIM);
        for (let i = 0; i < DIM; i++) { h = Math.imul(h ^ (h >>> 13), 1274126177); v[i] = ((h >>> 0) % 2000 - 1000) / 1000; }
        return v;
    };
    return {
        dimension: DIM,
        modelId: 'stub/cluster3',
        initialize: async () => undefined,
        embed: async (t) => vec(t),
        embedQuery: async (t) => vec(t),
        embedDocument: async (t) => vec(t),
        embedDocumentBatch: async (ts) => ts.map(vec),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await sleep(5);
    }
}

/* ─── Outbox harness (real SqliteOutboxStore + OutboxReplicator + real
 *     VerbatimStore, substrates mirroring outbox/wiring.ts) ─── */

const NOW = '2026-08-17T00:00:00.000Z';
function verbatimUpsertEntry(id: string, entrySeqName: string, text: string): OutboxEntry {
    return {
        id: entrySeqName,
        operation: 'op',
        initiator: 'test:cluster3',
        createdAt: NOW,
        updatedAt: NOW,
        steps: [],
        completed: false,
        workspace: 'ws1',
        operationKind: 'verbatim.upsert',
        payload: {
            id,
            text,
            metadata: { type: 'note', label: entrySeqName, project: 'ws1', ecosystem: '*' },
        },
        status: 'pending',
    };
}

function entryStatus(store: SqliteOutboxStore, id: string): string {
    // Raw db handle for the status read-back — mirrors
    // outbox-crosskind-supersede-unit.ts; SqliteOutboxStore exposes no
    // per-entry status getter. Unchecked cast: test-only, shape is pinned by
    // the store's own schema.
    const db = (store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
    const row = db.prepare(`SELECT status FROM outbox_entries WHERE id = ?`).get(id) as { status: string } | undefined;
    return row?.status ?? '<missing>';
}

async function makeOutboxHarness(): Promise<{
    store: SqliteOutboxStore;
    replicator: OutboxReplicator;
    verbatim: VerbatimStore;
}> {
    const outboxDir = tmp('c3-outbox-');
    const verbatimDir = tmp('c3-verb-');
    const store = new SqliteOutboxStore(outboxDir, { retryBaseMs: 500 });
    const verbatim = new VerbatimStore(verbatimDir, stubProvider());
    await verbatim.initialize();
    // Mirrors outbox/wiring.ts: per-row → store(), consolidated → storeBatch().
    const substrates: DispatcherSubstrates = {
        upsertVerbatim: async (payload) => {
            const id = String(payload['id'] ?? '');
            if (!id) return;
            await verbatim.store({
                id,
                text: String(payload['text'] ?? ''),
                metadata: (payload['metadata'] as Record<string, unknown>) ?? {},
            });
        },
        upsertVerbatimBatch: async (payload) => {
            const docs = payload.items
                .map((it) => ({
                    id: String(it['id'] ?? ''),
                    text: String(it['text'] ?? ''),
                    metadata: (it['metadata'] as Record<string, unknown>) ?? {},
                }))
                .filter((d) => d.id);
            if (docs.length > 0) await verbatim.storeBatch(docs);
        },
    };
    const replicator = new OutboxReplicator({
        store, substrates,
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 },
        log: () => undefined,
    });
    return { store, replicator, verbatim };
}

/** Canonical-row count for an exact id (listIds is prefix-matched and would
 *  also return #rev history rows). */
async function canonicalRows(verbatim: VerbatimStore, id: string): Promise<string[]> {
    const ids = await verbatim.listIds(id);
    return ids.filter((x) => x === id);
}

console.log('functional-correctness cluster 3 — races / duplicates / stale-wins');

// ── 3.2 (HIGH) — consolidated verbatim.upsert run, two rapid edits, one tick ──
await test('3.2 outbox consolidation: two same-id verbatim.upsert rows in one tick → ONE canonical row, NEWEST text, both replicated', async () => {
    const { store, replicator, verbatim } = await makeOutboxHarness();
    // Exactly what nodeService emits on two rapid store_node calls for one id.
    await store.record(verbatimUpsertEntry('lore:note:1', 'e1', 'v1 ORIGINAL'));
    await store.record(verbatimUpsertEntry('lore:note:1', 'e2', 'v2 CORRECTED'));

    const processed = await replicator.tickOnce();
    assert.equal(processed, 2, 'both entries processed');
    assert.equal(entryStatus(store, 'e1'), 'replicated');
    assert.equal(entryStatus(store, 'e2'), 'replicated');

    const rows = await canonicalRows(verbatim, 'lore:note:1');
    assert.equal(rows.length, 1, `exactly ONE canonical row for lore:note:1 (got ${rows.length}: ${JSON.stringify(rows)})`);
    const got = await verbatim.getById('lore:note:1');
    assert.match(String(got?.text), /v2 CORRECTED/, `getById must return the NEWEST text, got ${JSON.stringify(got?.text)}`);

    // Search must not return the node twice (pre-fix: 2 hits, same id).
    const hits = await verbatim.search('CORRECTED', 10);
    const forId = hits.filter((h) => h.id === 'lore:note:1');
    assert.equal(forId.length, 1, `search returns lore:note:1 exactly once (got ${forId.length})`);
});

// ── 3.3 (HIGH) — same repro shape as the finding's meeting-notes run, plus
//    the never-self-heals leg ──
await test('3.3 pending pair consolidated in one tick stays ONE row AND a later edit still lands on a single row (self-heals)', async () => {
    const { store, replicator, verbatim } = await makeOutboxHarness();
    await store.record(verbatimUpsertEntry('lore:meeting-notes', 'm1', 'Meeting notes: we decided to ship on Friday'));
    await store.record(verbatimUpsertEntry('lore:meeting-notes', 'm2', 'Meeting notes: CORRECTED — we ship on Monday'));

    await replicator.tickOnce();
    let rows = await canonicalRows(verbatim, 'lore:meeting-notes');
    assert.equal(rows.length, 1, `one canonical row after consolidation (got ${rows.length})`);
    let got = await verbatim.getById('lore:meeting-notes');
    assert.match(String(got?.text), /Monday/, 'getById returns the corrected (newest) text, not the superseded one');

    // The finding's "never self-heals" leg: a later single edit (per-row path)
    // used to update BOTH duplicate rows, making the duplication permanent.
    // Post-fix there is only one row to begin with, and it must stay that way.
    await store.record(verbatimUpsertEntry('lore:meeting-notes', 'm3', 'Meeting notes: FINAL — ship Tuesday'));
    await replicator.tickOnce();
    rows = await canonicalRows(verbatim, 'lore:meeting-notes');
    assert.equal(rows.length, 1, `still one canonical row after a later edit (got ${rows.length})`);
    got = await verbatim.getById('lore:meeting-notes');
    assert.match(String(got?.text), /Tuesday/, 'third edit is the visible text');
});

// ── 3.4 (HIGH) — bulkIngest duplicate ids, embed:'sync', exact repro shape ──
await test("3.4 bulkIngest 16 entries = 8 ids × {OLD, NEW} embed:'sync' → one canonical row + graph row per id, NEW everywhere", async () => {
    const gdir = tmp('c3-bulk-g-');
    const vdir = tmp('c3-bulk-v-');
    const graph = new SurrealGraph(gdir);
    await graph.initialize();
    const verbatim = new VerbatimStore(vdir, stubProvider());
    await verbatim.initialize();

    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    const provider = stubProvider();
    const deps: BulkIngestDeps = {
        graph: graph as never,
        graphRegistry: null,
        activeWorkspaceName: () => '__not_active__', // no WAL / no autolink gating
        outboxStore: undefined,
        embedQueue: { enqueue: noop } as never,
        verbatimStore: verbatim as never,
        storageClient: stub,
        loreVerbatim: verbatim as never,
        embeddingProvider: provider,
        getWal: () => stub,
        versionStore: undefined,
        autolinkTracker: defaultAutolinkTracker,
    };

    // Exact repro shape: 8 ids, each present twice — all OLD entries first,
    // then all NEW (winner positions disjoint from losers).
    const entry = (i: number, phase: 'OLD' | 'NEW') => ({
        id: `dup-${i}`,
        workspace: 'w',
        ecosystem: '*',
        nodeData: {
            id: `dup-${i}`, type: 'note', label: `dup-${i}`,
            content: `${phase} text for ${i}`, tags: [], project: 'w', ecosystem: '*', metadata: '{}',
        },
    });
    const entries = [
        ...Array.from({ length: 8 }, (_, i) => entry(i, 'OLD')),
        ...Array.from({ length: 8 }, (_, i) => entry(i, 'NEW')),
    ];

    const r = await runBulkIngest(entries as never, { embed: 'sync', autolink: false }, deps);
    assert.equal(r.count, 16);
    assert.equal(r.results.length, 16, 'one result slot per input entry');
    assert.equal(r.succeeded, 16, `all 16 entries report success (superseded slots mirror their winner): ${JSON.stringify(r.results.filter((x) => !x?.ok))}`);
    assert.equal(r.ok, true);

    for (let i = 0; i < 8; i++) {
        const rows = await canonicalRows(verbatim, `lore:dup-${i}`);
        assert.equal(rows.length, 1, `dup-${i}: exactly ONE canonical vector row (got ${rows.length})`);
        const row = await verbatim.getById(`lore:dup-${i}`);
        assert.match(String(row?.text), new RegExp(`NEW text for ${i}`), `dup-${i}: verbatim holds NEW text`);
        const node = await graph.getNode(`dup-${i}`);
        assert.equal(node?.content, `NEW text for ${i}`, `dup-${i}: graph converged on NEW content`);
    }
    await graph.close();
});

// ── 3.5a (HIGH) — exact repro: real wireEmbedQueue + real VerbatimStore,
//    10 ids × (OLD then NEW) ──
await test('3.5a embed queue: 10 node ids enqueued OLD-then-NEW drain to NEW in every vector row', async () => {
    const vdir = tmp('c3-q-v-');
    const verbatim = new VerbatimStore(vdir, stubProvider());
    await verbatim.initialize();
    const graphNode = (id: string) => ({
        id, type: 'note', label: id, content: id, tags: [] as string[],
        project: 'w', ecosystem: '*', metadata: '{}',
        createdAt: NOW, updatedAt: NOW, syncedAt: null,
    });
    const stubGraph = { getNode: async (id: string) => graphNode(id) };
    const queue = wireEmbedQueue({ graph: stubGraph as never, vectorStore: verbatim as never, concurrency: 4 });

    for (let i = 0; i < 10; i++) {
        queue.enqueue(`n-${i}`, `OLD text revision one for ${i}`);
        queue.enqueue(`n-${i}`, `NEW text revision two for ${i}`);
    }
    await queue.drained();
    queue.stop();

    const stats = queue.stats();
    assert.equal(stats.permanentlyFailed, 0, 'no permanent failures');
    for (let i = 0; i < 10; i++) {
        const row = await verbatim.getById(`lore:n-${i}`);
        assert.match(
            String(row?.text),
            new RegExp(`NEW text revision two for ${i}`),
            `n-${i}: vector row holds the LAST-enqueued text (got ${JSON.stringify(row?.text)})`,
        );
        const rows = await canonicalRows(verbatim, `lore:n-${i}`);
        assert.equal(rows.length, 1, `n-${i}: exactly one canonical row`);
    }
});

// ── 3.5b — deterministic queue semantics (supersede / hold / stale-retry) ──
await test('3.5b queue coalescing: supersede-in-place, in-flight hold, stale-retry drop', async () => {
    // (1) supersede-in-place: second enqueue BEFORE start replaces the pending
    //     job — the executor runs ONCE with the newest text.
    {
        const calls: string[] = [];
        const q = new EmbedQueue({ concurrency: 4 });
        q.enqueue('n', 'OLD');
        q.enqueue('n', 'NEW');
        q.start(async ({ text }) => { calls.push(text); });
        await q.drained();
        q.stop();
        assert.deepEqual(calls, ['NEW'], `superseded pending job must not execute (got ${JSON.stringify(calls)})`);
    }

    // (2) cross-workspace coalescing keys must NOT merge: same nodeId in two
    //     workspaces is two jobs.
    {
        const calls: string[] = [];
        const q = new EmbedQueue({ concurrency: 4 });
        q.enqueue('n', 'A-ws1', 'ws1');
        q.enqueue('n', 'B-ws2', 'ws2');
        q.start(async ({ text }) => { calls.push(text); });
        await q.drained();
        q.stop();
        assert.deepEqual(calls.sort(), ['A-ws1', 'B-ws2'], 'different workspaces must not coalesce');
    }

    // (3) in-flight hold: an enqueue that arrives while its id is executing
    //     runs STRICTLY AFTER the in-flight job completes — last enqueue wins.
    {
        const calls: string[] = [];
        let releaseLatch!: () => void;
        const latch = { promise: new Promise<void>((resolve) => { releaseLatch = resolve; }) };
        const q = new EmbedQueue({ concurrency: 4 });
        q.start(async ({ text }) => {
            calls.push(text);
            if (calls.length === 1) await latch.promise; // first job parks in-flight
        });
        q.enqueue('n', 'OLD');
        await waitFor(() => calls.length === 1);
        q.enqueue('n', 'NEW');
        await sleep(50); // pump gets plenty of chances
        assert.equal(calls.length, 1, 'NEW must be held while OLD is in flight');
        releaseLatch();
        await q.drained();
        q.stop();
        assert.deepEqual(calls, ['OLD', 'NEW'], 'NEW runs strictly after OLD completes');
    }

    // (4) stale-retry drop: a job that fails and sits in the backoff gap must
    //     NOT re-run its captured text if a newer enqueue superseded it.
    {
        const calls: string[] = [];
        const q = new EmbedQueue({ concurrency: 4, initialBackoffMs: 5, maxRetries: 3 });
        q.start(async ({ text }) => {
            calls.push(text);
            if (text === 'OLD') throw new Error('transient boom');
        });
        q.enqueue('n', 'OLD');
        await waitFor(() => q.stats().retries === 1); // OLD failed, backoff scheduled
        q.enqueue('n', 'NEW');
        await q.drained();
        q.stop();
        assert.deepEqual(calls, ['OLD', 'NEW'], `stale retry must be dropped (got ${JSON.stringify(calls)})`);
        assert.equal(q.stats().permanentlyFailed, 0);
    }
});

// ── medium — cold-workspace first-write table-creation race ──
await test('medium: concurrent first writes to a cold workspace do not throw "already exists" and all rows land', async () => {
    const vdir = tmp('c3-race-v-');
    const verbatim = new VerbatimStore(vdir, stubProvider());
    await verbatim.initialize(); // NOTE: table itself not yet created
    const settled = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
            verbatim.store({ id: `lore:cold-${i}`, text: `cold write ${i}`, metadata: { type: 'note' } })),
    );
    const rejected = settled.filter((s) => s.status === 'rejected');
    assert.equal(rejected.length, 0, `no first write may fail (got ${JSON.stringify(rejected.map((r) => (r as PromiseRejectedResult).reason?.message))})`);
    for (let i = 0; i < 6; i++) {
        assert.ok(await verbatim.getById(`lore:cold-${i}`), `lore:cold-${i} present`);
    }
});

// ── medium — tombstone() is one atomic mergeInsert (was delete-then-add) ──
await test('medium: tombstone replaces the canonical row atomically (tombstone text visible, single row, history snapshot kept)', async () => {
    const vdir = tmp('c3-tomb-v-');
    const verbatim = new VerbatimStore(vdir, stubProvider());
    await verbatim.initialize();
    await verbatim.store({ id: 'lore:t1', text: 'original content to tombstone', metadata: { type: 'note' } });

    await verbatim.tombstone('lore:t1', 'cluster3 regression');

    const row = await verbatim.getById('lore:t1');
    assert.match(String(row?.text), /^\[TOMBSTONED /, 'canonical row now carries the tombstone marker');
    assert.match(String(row?.text), /original content to tombstone/, 'original text retained under the marker');
    const rows = await canonicalRows(verbatim, 'lore:t1');
    assert.equal(rows.length, 1, `exactly one canonical row after tombstone (got ${rows.length})`);
    const history = await verbatim.getHistory('lore:t1');
    assert.equal(history.length, 2, `canonical + one #rev snapshot (got ${history.length})`);

    // Idempotent: second tombstone is a no-op.
    await verbatim.tombstone('lore:t1', 'again');
    const history2 = await verbatim.getHistory('lore:t1');
    assert.equal(history2.length, 2, 'second tombstone adds nothing');
});

// ── low — autolink re-embed dedupes on the pair, not the score string ──
await test('low: re-embedding a node updates (not duplicates) its semantic edge to the same neighbour', async () => {
    const gdir = tmp('c3-auto-g-');
    const vdir = tmp('c3-auto-v-');
    // Controlled similarities: 'OTHER' is the neighbour; the node's two
    // revisions embed differently but both clear minSim (0.65) — pre-fix the
    // two sims produced two relation strings and two edges.
    const e0 = [1, 0, ...new Array<number>(DIM - 2).fill(0)];
    const v1 = [0.95, 0.05, ...new Array<number>(DIM - 2).fill(0)];
    const v2 = [0.7, 0.3, ...new Array<number>(DIM - 2).fill(0)];
    const provider = stubProvider((text) => {
        if (text.includes('NEIGHBOUR')) return e0;
        if (text.includes('REVISION-ONE')) return v1;
        if (text.includes('REVISION-TWO')) return v2;
        return undefined;
    });
    const graph = new SurrealGraph(gdir);
    await graph.initialize();
    const verbatim = new VerbatimStore(vdir, provider);
    await verbatim.initialize();

    const mkNode = (id: string, content: string) => ({
        id, type: 'note', label: id, content, tags: [] as string[],
        project: 'p', ecosystem: '*', metadata: '{}',
        createdAt: NOW, updatedAt: NOW, syncedAt: null,
    });
    await graph.upsertNode(mkNode('other', 'NEIGHBOUR node') as never);
    await graph.upsertNode(mkNode('n1', 'REVISION-ONE') as never);
    await verbatim.store({ id: 'lore:other', text: 'NEIGHBOUR node', metadata: { type: 'note', ecosystem: '*' } });

    const nodeV1 = { id: 'n1', label: 'n1', content: 'REVISION-ONE', tags: [] as string[], type: 'note', project: 'p', ecosystem: '*' };
    const first = await reconnectOneNode(graph as never, verbatim as never, nodeV1, { k: 5, minSim: 0.65 });
    assert.equal(first.added, 1, `first autolink adds one edge (got ${first.added})`);

    // Re-embed with different content → different similarity. Pre-fix this
    // added a SECOND edge (relation 'semantic_neighbor:<new score>').
    const nodeV2 = { ...nodeV1, content: 'REVISION-TWO' };
    await reconnectOneNode(graph as never, verbatim as never, nodeV2, { k: 5, minSim: 0.65 });

    const edges = await graph.queryEdges({ source: 'n1', limit: 100, offset: 0 } as never);
    const semantic = edges.filter((e) => e.relation.startsWith('semantic_neighbor'));
    assert.equal(semantic.length, 1, `exactly ONE semantic edge n1↔other after re-embed (got ${semantic.length}: ${JSON.stringify(semantic.map((e) => e.relation))})`);
    assert.equal(semantic[0]!.relation, 'semantic_neighbor', 'relation is the bare prefix; score lives in confidenceScore');
    await graph.close();
});

// ── 3.2 sibling — the embed.batch consolidation sink (replicator
//    collectEmbedBatchRun → wiring storeEmbedBatch → bulkUpsertPrebuiltRows)
//    showed the same duplicate-source-key defect ──
await test('3.2b bulkUpsertPrebuiltRows with duplicate ids in the SOURCE batch lands ONE row, keep-last (embed.batch consolidation sink)', async () => {
    const vdir = tmp('c3-emb-v-');
    const verbatim = new VerbatimStore(vdir, stubProvider());
    await verbatim.initialize();
    const mkRow = (id: string, text: string) => ({
        vector: new Array<number>(DIM).fill(0.1),
        id, text,
        type: 'note', label: '', tags: '', project: 'w', ecosystem: '*',
        updatedAt: NOW, security_scopes: [] as string[], contentHash: '',
    });
    await verbatim.bulkUpsertPrebuiltRows([
        mkRow('lore:x', 'A-old'),
        mkRow('lore:x', 'B-new'),
    ] as never);
    const rows = await canonicalRows(verbatim, 'lore:x');
    assert.equal(rows.length, 1, `one canonical row for lore:x (got ${rows.length})`);
    const got = await verbatim.getById('lore:x');
    assert.equal(got?.text, 'B-new', `keep-last wins (got ${JSON.stringify(got?.text)})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
