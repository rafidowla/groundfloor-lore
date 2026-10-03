#!/usr/bin/env tsx
/**
 * bulk-rollback-restore-unit.ts — 3.26.0: a failed item of POST
 * /api/nodes/bulk no longer deletes the node it was updating.
 *
 * The defect (the bulk twin of test/rollback-restore-prior-unit.ts): the bulk
 * route undid a failed item as if the item had created the node.
 *   - `embed: 'inline'`, the verbatim seed fails after the graph write: the
 *     rollback called `deleteNode(id)`, removing a node that existed before.
 *   - the item's `node.upsert` outbox row was already claimed by the
 *     replicator: the compensating row was always a `node.delete`, so the
 *     replay removed the existing node (inline-seed failure, a per-item
 *     substrate failure, and a failed supersedes-apply alike).
 *
 * The fix (mcp/http/routes/bulkWriteRollback.ts), pinned here:
 *   - the node is read under the chunk's locks before an inline item writes;
 *     a failed seed puts that node back, and deletes only a node the item
 *     created;
 *   - a read that fails rejects the item before anything is written;
 *   - a claimed row is compensated by a `node.upsert` of what the graph holds
 *     when the node exists, by a `node.delete` when it does not.
 *
 * Part 1 drives the helpers with fakes. Part 2 runs the real route against a
 * real graph (SQLite and SurrealDB), a real VerbatimStore and a real
 * FileOutboxStore, and replays the outbox through the real dispatcher.
 *
 * Run: npx tsx test/bulk-rollback-restore-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { makeVerbatimStore } from './helpers/testVerbatimStore.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { readInlinePriors, retractBulkNodeUpsert, undoBulkGraphWrite } from '../packages/lore/src/mcp/http/routes/bulkWriteRollback.js';
import { restorePayload } from '../packages/lore/src/core/nodeServiceVerbatim.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EmbeddingProvider, LoreNode } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

// ───────────────────────── Part 1 — the helpers, with fakes ─────────────────────────

const PRIOR = { id: 'n1', type: 'decision', label: 'original', content: 'original content', tags: ['keep'], project: 'ws', ecosystem: '*', metadata: '{"a":1}', stale: false } as unknown as LoreNode;
const WRITTEN = { id: 'n1', type: 'decision', label: 'NEW', content: 'new content', stale: true };

function fakeStore(opts: { claimed?: boolean; withoutRemoveIfPending?: boolean } = {}) {
    const state = { recorded: [] as OutboxEntry[], removed: [] as string[] };
    const store: OutboxStore = {
        async record(e: OutboxEntry) { state.recorded.push(e); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove(id: string) { state.removed.push(id); },
        async listUnfinished() { return []; },
    };
    if (!opts.withoutRemoveIfPending) {
        store.removeIfPending = async (id: string) => { if (opts.claimed) return false; state.removed.push(id); return true; };
    }
    return { store, state };
}
const readerOf = (node: LoreNode | null | Error) => {
    const g = { reads: 0, async getNode(_id: string) { g.reads++; if (node instanceof Error) throw node; return node; } };
    return g;
};

console.log('\nbulk rollback helpers (3.26.0)\n');

await test('undoBulkGraphWrite: an existing node is put back, a created one deleted', async () => {
    const calls: unknown[] = [];
    const g = { async upsertNode(n: never) { calls.push(['upsert', n]); }, async deleteNode(id: string) { calls.push(['delete', id]); } };
    await undoBulkGraphWrite(g, 'n1', PRIOR, WRITTEN);
    assert.deepEqual(calls, [['upsert', restorePayload(PRIOR, WRITTEN)]]);
    assert.equal((calls[0] as [string, Record<string, unknown>])[1].stale, false, 'a flag the failed item set is reset');
    calls.length = 0;
    await undoBulkGraphWrite(g, 'fresh', null, WRITTEN);
    await undoBulkGraphWrite(g, 'unknown', undefined, WRITTEN);
    assert.deepEqual(calls, [['delete', 'fresh'], ['delete', 'unknown']]);
});

await test('undoBulkGraphWrite: a node deleted while the item was in flight is not brought back', async () => {
    const calls: unknown[] = [];
    const g = { async getNode(_id: string) { return null; }, async upsertNode(n: never) { calls.push(['upsert', n]); }, async deleteNode(id: string) { calls.push(['delete', id]); } };
    await undoBulkGraphWrite(g, 'n1', PRIOR, WRITTEN);
    assert.deepEqual(calls, []);
    const still = { ...g, async getNode(_id: string) { return PRIOR; } };
    await undoBulkGraphWrite(still, 'n1', PRIOR, WRITTEN);
    assert.deepEqual(calls, [['upsert', restorePayload(PRIOR, WRITTEN)]]);
});

await test('retractBulkNodeUpsert: a still-pending row is removed and the graph is not read', async () => {
    const { store, state } = fakeStore();
    const g = readerOf(PRIOR);
    await retractBulkNodeUpsert({ store, entryId: 'e1', workspace: 'ws', graph: g, id: 'n1', written: WRITTEN });
    assert.deepEqual(state.removed, ['e1']);
    assert.equal(state.recorded.length, 0);
    assert.equal(g.reads, 0);
});

await test('retractBulkNodeUpsert: claimed row, node present → compensating node.upsert of the node', async () => {
    const { store, state } = fakeStore({ claimed: true });
    await retractBulkNodeUpsert({ store, entryId: 'e1', workspace: 'ws', graph: readerOf(PRIOR), id: 'n1', written: WRITTEN });
    assert.equal(state.recorded.length, 1);
    const row = state.recorded[0]!;
    assert.equal(row.operationKind, 'node.upsert');
    assert.equal(row.operation, 'graph.upsert');
    assert.equal(row.workspace, 'ws');
    assert.deepEqual(row.payload, restorePayload(PRIOR, WRITTEN));
});

await test('retractBulkNodeUpsert: claimed row, node absent → compensating node.delete', async () => {
    const { store, state } = fakeStore({ claimed: true });
    await retractBulkNodeUpsert({ store, entryId: 'e1', workspace: 'ws', graph: readerOf(null), id: 'n1', written: WRITTEN });
    assert.equal(state.recorded.length, 1);
    assert.equal(state.recorded[0]!.operationKind, 'node.delete');
    assert.deepEqual(state.recorded[0]!.payload, { id: 'n1' });
});

await test('retractBulkNodeUpsert: claimed row, node unreadable → rejects, no row is guessed', async () => {
    const { store, state } = fakeStore({ claimed: true });
    await assert.rejects(() => retractBulkNodeUpsert({ store, entryId: 'e1', workspace: 'ws', graph: readerOf(new Error('read failed')), id: 'n1', written: WRITTEN }), /read failed/);
    assert.equal(state.recorded.length, 0);
});

await test('retractBulkNodeUpsert: a store without removeIfPending removes the row', async () => {
    const { store, state } = fakeStore({ withoutRemoveIfPending: true });
    await retractBulkNodeUpsert({ store, entryId: 'e1', workspace: 'ws', graph: readerOf(PRIOR), id: 'n1', written: WRITTEN });
    assert.deepEqual(state.removed, ['e1']);
    assert.equal(state.recorded.length, 0);
});

await test('a graph without getNode: no priors, every item kept, a claimed row is compensated by node.delete (pre-3.26)', async () => {
    const specs = [{ idx: 0, raw: { id: 'n1' }, embedMode: 'inline' }, { idx: 1, raw: { id: 'n2' }, embedMode: 'queued' }];
    const failures: number[] = [];
    const { chunk, priors } = await readInlinePriors({}, specs, (s) => failures.push(s.idx));
    assert.deepEqual(chunk.map((s) => s.idx), [0, 1]);
    assert.equal(priors.size, 0);
    assert.deepEqual(failures, []);
    const { store, state } = fakeStore({ claimed: true });
    await retractBulkNodeUpsert({ store, entryId: 'e1', workspace: 'ws', graph: {}, id: 'n1', written: WRITTEN });
    assert.deepEqual(state.recorded.map((r) => r.operationKind), ['node.delete']);
});

await test('readInlinePriors: reads inline items only; an unreadable one is failed and dropped', async () => {
    const reads: string[] = [];
    const g = { async getNode(id: string) { reads.push(id); if (id === 'bad') throw new Error('graph read failed'); return id === 'n1' ? PRIOR : null; } };
    const specs = [
        { idx: 0, raw: { id: 'n1' }, embedMode: 'inline' },
        { idx: 1, raw: { id: 'fresh' }, embedMode: 'inline' },
        { idx: 2, raw: { id: 'queued' }, embedMode: 'queued' },
        { idx: 3, raw: { id: 'bad' }, embedMode: 'inline' },
    ];
    const failures: Array<[number, string]> = [];
    const { chunk, priors } = await readInlinePriors(g, specs, (s, error) => failures.push([s.idx, error]));
    assert.deepEqual(reads, ['n1', 'fresh', 'bad'], 'a queued item costs no read');
    assert.deepEqual(chunk.map((s) => s.idx), [0, 1, 2]);
    assert.equal(priors.get('n1'), PRIOR);
    assert.equal(priors.get('fresh'), null);
    assert.equal(priors.has('queued'), false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]![0], 3);
    assert.match(failures[0]![1], /graph read failed.*nothing was written/);
});

// ───────────────────────── Part 2 — the real route ─────────────────────────

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'bulk-rollback-restore-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakePostReqWithBody(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

type Graph = SurrealGraph | SqliteGraph;
interface Rig { graph: Graph; store: VerbatimStoreApi; outbox: FileOutboxStore; ws: string; substrates: DispatcherSubstrates }
type Item = { id: string; ok: boolean; error?: string };

async function rig(engine: 'sqlite' | 'surreal', tag: string): Promise<Rig> {
    const ws = `bulk-restore-${engine}-${tag}`;
    const graph: Graph = engine === 'sqlite' ? new SqliteGraph(mkTmp('bulk-restore-g-'), { workspaceId: ws }) : new SurrealGraph(mkTmp('bulk-restore-g-'));
    const store = makeVerbatimStore(mkTmp('bulk-restore-v-'), new ConstEmbedProvider());
    const outbox = new FileOutboxStore(mkTmp('bulk-restore-o-'));
    await graph.initialize();
    await store.initialize();
    const wiring = wireOutbox({
        loreDir: mkTmp('bulk-restore-w-'),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    const substrates = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    return { graph, store, outbox, ws, substrates };
}
async function closeRig(r: Rig): Promise<void> {
    await r.store.close().catch(() => undefined);
    await r.graph.close().catch(() => undefined);
}
async function bulk(r: Rig, nodes: Array<Record<string, unknown>>, embed: 'inline' | 'skip'): Promise<Item[]> {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        fakePostReqWithBody(JSON.stringify({ workspace: r.ws, nodes, embed })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.graph, loreVerbatim: r.store } as never, auditLog: { log: () => undefined } as never,
          deploymentMode: 'local', dataplane: null, outboxStore: r.outbox },
    );
    return (JSON.parse(res._body) as { results: Item[] }).results;
}
const pendingRows = (r: Rig) => r.outbox.listPendingForWorkspace(r.ws, 10_000);
/** Replay every row the call under test left behind, in commit order. */
async function replayNew(r: Rig, seen: Set<string>): Promise<OutboxEntry[]> {
    const rows = (await pendingRows(r)).filter((e) => !seen.has(e.id));
    for (const e of rows) await dispatch(e, r.substrates);
    return rows;
}
const nodeRows = (rows: OutboxEntry[], id: string) => rows.filter((e) => (e.payload as { id?: unknown })?.id === id && String(e.operationKind).startsWith('node.'));
/** What a reader sees, without the write stamps a rewrite renews. */
function comparable(node: unknown): Record<string, unknown> {
    const { updatedAt: _u, version: _v, syncedAt: _s, ...rest } = node as Record<string, unknown>;
    return rest;
}
/** Seed one node through the route itself and return it plus the ids of the outbox rows already there. */
async function seed(r: Rig, id: string): Promise<{ before: LoreNode; seen: Set<string> }> {
    const out = await bulk(r, [{ id, type: 'decision', label: 'original label', content: 'original content', tags: 'alpha,beta', metadata: JSON.stringify({ origin: 'seed' }) }], 'inline');
    assert.equal(out[0]!.ok, true, JSON.stringify(out));
    const before = await r.graph.getNode(id);
    assert.ok(before, 'seeded');
    return { before, seen: new Set((await pendingRows(r)).map((e) => e.id)) };
}
const UPDATE = (id: string) => ({ id, type: 'decision', label: 'REPLACED', content: 'replaced content', tags: 'gamma', metadata: JSON.stringify({ origin: 'failed write' }) });
/** Make the inline verbatim seed fail for `id` until the returned function is called. */
function failSeedFor(r: Rig, id: string): () => void {
    const original = r.store.store.bind(r.store);
    (r.store as unknown as { store: typeof r.store.store }).store = (async (doc: { id: string }) => {
        if (doc.id === `lore:${id}`) throw new Error('SIMULATED: embedding provider unavailable');
        return original(doc as never);
    }) as typeof r.store.store;
    return () => { (r.store as unknown as { store: typeof r.store.store }).store = original; };
}
/** The replicator already claimed every row: `removeIfPending` answers false. */
function claimRows(r: Rig): void {
    (r.outbox as unknown as { removeIfPending: (id: string) => Promise<boolean> }).removeIfPending = async () => false;
}

for (const engine of ['sqlite', 'surreal'] as const) {
    console.log(`\nPOST /api/nodes/bulk — ${engine} graph\n`);

    await test(`[${engine}] inline seed fails on an UPDATE → the node is exactly as it was, no save row left`, async () => {
        const r = await rig(engine, 'a');
        try {
            const { before, seen } = await seed(r, 'keep-me');
            const restore = failSeedFor(r, 'keep-me');
            let out: Item[];
            try { out = await bulk(r, [UPDATE('keep-me'), { id: 'other', type: 'note', label: 'ok', content: 'fine' }], 'inline'); } finally { restore(); }
            assert.equal(out.find((i) => i.id === 'keep-me')!.ok, false);
            assert.equal(out.find((i) => i.id === 'other')!.ok, true);
            const after = await r.graph.getNode('keep-me');
            assert.ok(after, 'the node that existed before the failed item must still exist');
            assert.deepEqual(comparable(after), comparable(before));
            const rows = await replayNew(r, seen);
            assert.deepEqual(nodeRows(rows, 'keep-me'), [], 'the failed item left no node row');
            assert.deepEqual(comparable(await r.graph.getNode('keep-me')), comparable(before), 'and a replay does not change it');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] inline seed fails on a CREATE → nothing is left behind (unchanged)`, async () => {
        const r = await rig(engine, 'b');
        try {
            const restore = failSeedFor(r, 'never-was');
            let out: Item[];
            try { out = await bulk(r, [UPDATE('never-was')], 'inline'); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.equal(await r.graph.getNode('never-was'), null);
            await replayNew(r, new Set());
            assert.equal(await r.graph.getNode('never-was'), null);
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] inline seed fails on an UPDATE whose row was already claimed → replay ends on the previous node`, async () => {
        const r = await rig(engine, 'c');
        try {
            const { before, seen } = await seed(r, 'keep-me');
            claimRows(r);
            const restore = failSeedFor(r, 'keep-me');
            let out: Item[];
            try { out = await bulk(r, [UPDATE('keep-me')], 'inline'); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(comparable(await r.graph.getNode('keep-me')), comparable(before));
            const rows = await replayNew(r, seen);
            const mine = nodeRows(rows, 'keep-me');
            assert.deepEqual(mine.map((e) => e.operationKind), ['node.upsert', 'node.upsert'], 'the claimed row, then a compensating SAVE (never a delete)');
            assert.equal((mine[1]!.payload as { label?: unknown }).label, 'original label');
            const end = await r.graph.getNode('keep-me');
            assert.ok(end, 'the replay must not delete the node');
            assert.deepEqual(comparable(end), comparable(before));
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] a per-item substrate failure on an UPDATE whose row was already claimed → the node survives the replay`, async () => {
        const r = await rig(engine, 'd');
        try {
            const { before, seen } = await seed(r, 'keep-me');
            claimRows(r);
            const g = r.graph as unknown as { bulkUpsertNodes(batch: unknown[]): Promise<Array<{ id: string; ok: boolean; error?: string }>> };
            const original = g.bulkUpsertNodes.bind(r.graph);
            g.bulkUpsertNodes = async (batch) => (batch as Array<{ id: string }>).map((n) => ({ id: n.id, ok: false, error: 'SIMULATED substrate constraint violation' }));
            let out: Item[];
            try { out = await bulk(r, [UPDATE('keep-me')], 'skip'); } finally { g.bulkUpsertNodes = original; }
            assert.equal(out[0]!.ok, false);
            const rows = await replayNew(r, seen);
            assert.deepEqual(nodeRows(rows, 'keep-me').map((e) => e.operationKind), ['node.upsert', 'node.upsert']);
            const end = await r.graph.getNode('keep-me');
            assert.ok(end, 'the replay must not delete a node the failed item never created');
            assert.deepEqual(comparable(end), comparable(before));
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] the node cannot be read before an inline item → the item fails with nothing written`, async () => {
        const r = await rig(engine, 'e');
        try {
            const { before, seen } = await seed(r, 'keep-me');
            const g = r.graph as unknown as { getNode(id: string): Promise<LoreNode | null> };
            const original = g.getNode.bind(r.graph);
            g.getNode = async (id) => { if (id === 'keep-me') throw new Error('SIMULATED read failure'); return original(id); };
            let out: Item[];
            try { out = await bulk(r, [UPDATE('keep-me'), { id: 'other', type: 'note', label: 'ok', content: 'fine' }], 'inline'); } finally { g.getNode = original; }
            const mine = out.find((i) => i.id === 'keep-me')!;
            assert.equal(mine.ok, false);
            assert.match(String(mine.error), /nothing was written/);
            assert.equal(out.find((i) => i.id === 'other')!.ok, true, 'the rest of the batch is unaffected');
            assert.deepEqual(nodeRows((await pendingRows(r)).filter((e) => !seen.has(e.id)), 'keep-me'), [], 'no outbox row was recorded for it');
            assert.deepEqual(await r.graph.getNode('keep-me'), before, 'not even its write stamp moved');
        } finally { await closeRig(r); }
    });
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
