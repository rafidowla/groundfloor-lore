#!/usr/bin/env tsx
/**
 * test/bulk-chunked-lock-unit.ts — QA A2 round-4 regression (2026-09-03).
 *
 * The round-3 fix (ef551757, test/bulk-delete-outbox-lock-order-unit.ts)
 * closed the outbox-commit-vs-lock ordering race by moving a bulk batch's
 * `recordHotWriteBatch` commit to be the first thing done INSIDE a single
 * `withNodeLocks(allIds, ...)` call spanning the WHOLE batch. QA round-4
 * found that holding every one of a large batch's locks for the full
 * duration of the batch's substrate loop meant a concurrent single-key
 * writer on ANY one of those ids blocked for nearly the WHOLE batch's wall
 * time — 865x-960x amplification measured for a 1000-id batch (`p50=253ms`
 * only after the round-4 fix; unfixed it was `p50~10.4s`).
 *
 * Round-4 finding 1 fix: chunk the batch into `withNodeLocks` calls of at
 * most `BULK_LOCK_CHUNK_SIZE` ids each (core/nodeWriteLock.ts), acquired
 * and released one chunk at a time, with each chunk's outbox commit still
 * the first thing done inside THAT chunk's lock.
 *
 * Round-4 finding 2: a per-node substrate failure inside a bulk upsert (the
 * `batchGraph` branch's `!br.ok`, and the ARCADE `upsertOne` per-item
 * failure) left that node's already-committed `node.upsert` outbox row
 * pending — a later replicator tick created a "ghost" node the caller was
 * told `ok:false` for. Same class of bug in `handleBulkDelete`: a per-id
 * `deleteNode` substrate failure left the batch's `node.delete` row
 * pending, risking a later replicator-only delete with no accompanying
 * verbatim tombstone (the tombstone only ever runs in the synchronous
 * success path). Fix: retract the failed id's outbox row, mirroring
 * `core/nodeService.ts`'s "retracting the node.upsert outbox row" pattern
 * (`outbox/hotLane.ts`'s new `retractHotWriteOrCompensate`).
 *
 * This file covers four things the round-3 test didn't:
 *   (a) the round-3 ordering race still converges ACROSS a chunk boundary
 *       (the racing id lives in chunk 2 while chunk 1 is in flight).
 *   (b) a concurrent single upsert against a 1000-id bulk-delete completes
 *       in well under 1s (the round-4 perf regression, asserted not just
 *       measured).
 *   (c) a partial bulk-upsert substrate failure leaves NO pending
 *       node.upsert row for the failed id, and a full outbox replay
 *       creates no ghost node.
 *   (d) the same for a partial bulk-delete substrate failure: no pending
 *       node.delete row for the failed id, and a full outbox replay does
 *       not delete the node behind the caller's back.
 *   (e) QA E5-A2 (2026-09-03): the batchGraph branch's INLINE-EMBED failure
 *       path (embedMode==='inline', br.ok true but the verbatim seed then
 *       throws) leaves NO pending node.upsert row for the failed id either
 *       — this catch block committed the row via the same `!br.ok` check's
 *       sibling path but, unlike it, never retracted on failure.
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`, a
 * real `VerbatimStore`, a real `FileOutboxStore`, the REAL `handleBulkDelete`
 * / `tryBulkWriteRoutes` HTTP handlers via a fake req/res (mirrors
 * test/bulk-delete-outbox-lock-order-unit.ts), and the REAL `dispatch()`
 * (outbox/dispatcher.ts) for replay-convergence checks. (c)/(d) monkeypatch
 * one substrate call to fail — the narrowest way to exercise the EXACT
 * `!br.ok` / catch branches without a real SurrealDB-level fault.
 *
 * Run: npx tsx test/bulk-chunked-lock-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { handleBulkDelete } from '../packages/lore/src/mcp/http/routes/bulkWriteEdgesDelete.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { BULK_LOCK_CHUNK_SIZE } from '../packages/lore/src/core/nodeWriteLock.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'bulk-chunked-lock-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bulk-chunked-lock-wiring-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
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

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\nbulk chunked-lock regression (QA A2 round-4)\n');

/** node.upsert / node.delete outbox rows for `id`, in commit order. */
async function nodeKindsFor(outboxStore: FileOutboxStore, ws: string, id: string): Promise<string[]> {
    const rows = await outboxStore.listPendingForWorkspace(ws, 10_000);
    return rows
        .filter((r) => r.operationKind === 'node.upsert' || r.operationKind === 'node.delete')
        .filter((r) => {
            const p = r.payload as { id?: unknown } | undefined;
            return p?.id === id;
        })
        .map((r) => String(r.operationKind));
}

// (a) ---------------------------------------------------------------------
test('(a) bulk-delete: round-3 ordering invariant still holds when the racing id lives in a LATER chunk than the one currently in flight', async () => {
    assert.ok(BULK_LOCK_CHUNK_SIZE >= 10 && BULK_LOCK_CHUNK_SIZE <= 200, `sanity: unexpected BULK_LOCK_CHUNK_SIZE=${BULK_LOCK_CHUNK_SIZE}`);
    const g = mkTmp('bulk-chunk-a-g-');
    const v = mkTmp('bulk-chunk-a-v-');
    const o = mkTmp('bulk-chunk-a-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'bulk-chunk-a-ws';
    try {
        // Chunk 1 = ids[0 .. BULK_LOCK_CHUNK_SIZE-1] (all fillers). `shared`
        // sits a few slots into chunk 2, so it is NOT locked at all while
        // chunk 1's delete loop is running — proving the round-3 invariant
        // (outbox commit + substrate write atomic per id) still holds when
        // the id racing a concurrent writer is outside the CURRENTLY held
        // lock, not just inside it.
        const chunk1Fillers = Array.from({ length: BULK_LOCK_CHUNK_SIZE }, (_, i) => `c1-filler-${i}`);
        const shared = 'shared-node';
        const chunk2Fillers = ['c2-filler-0', 'c2-filler-1'];
        const allIds = [...chunk1Fillers, shared, ...chunk2Fillers];
        assert.ok(allIds.length > BULK_LOCK_CHUNK_SIZE, 'batch must span at least two chunks');
        assert.ok(allIds.indexOf(shared) >= BULK_LOCK_CHUNK_SIZE, 'shared id must land in the SECOND chunk');

        for (const id of allIds) {
            const seed = await nodeUpsert(
                { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
                  nodeData: { id, type: 'note', label: 'seed', content: `seed-${id}`, tags: ['t'], security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            assert.equal(seed.ok, true, `seed write for ${id} must succeed`);
        }

        const res = fakeRes();
        const deletePromise = handleBulkDelete(
            res,
            { ids: allIds, workspace: ws },
            {
                store: { loreGraph: graph, loreVerbatim: store } as never,
                auditLog: { log: () => undefined } as never,
                deploymentMode: 'local', dataplane: null,
                outboxStore,
            },
        );
        const upsertPromise = (async () => {
            // Starts almost immediately — well before chunk 1's ~50-id delete
            // loop (real SurrealGraph + LanceDB calls) can finish and chunk 2's
            // lock (which covers `shared`) is even requested.
            await delay(2);
            return nodeUpsert(
                { id: shared, workspace: ws, ecosystem: '*', initiator: 'test:concurrent-upsert',
                  nodeData: { id: shared, type: 'note', label: 'race-winner', content: 'RACE-WINNER-CONTENT', tags: ['t'], security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
        })();

        const [, upsertResult] = await Promise.all([deletePromise, upsertPromise]);
        assert.equal(upsertResult.ok, true, 'the concurrent upsert must still report success');
        assert.equal(res._status, 200, `bulk-delete must return 200, got ${res._status}: ${res._body}`);

        const graphNode = await graph.getNode(shared);
        const realPresent = !!graphNode;

        const kinds = await nodeKindsFor(outboxStore, ws, shared);
        const lastKind = kinds[kinds.length - 1];
        const expectedKind = realPresent ? 'node.upsert' : 'node.delete';
        assert.equal(lastKind, expectedKind,
            `real graph=${realPresent ? 'PRESENT' : 'ABSENT'} but shared-id outbox order was [${kinds.join(',')}]`);

        const substrates = realDispatchSubstrates(graph, store);
        const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        for (const entry of allPending) await dispatch(entry, substrates);
        const graphAfterReplay = await graph.getNode(shared);
        assert.equal(!!graphAfterReplay, realPresent,
            `replay must converge to the real end-state (real present=${realPresent}, replay present=${!!graphAfterReplay})`);
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

// (b) ---------------------------------------------------------------------
test('(b) bulk-delete(1000 ids) in flight: a concurrent single nodeUpsert completes in well under 1s', async () => {
    const N = 1000;
    const g = mkTmp('bulk-chunk-b-g-');
    const v = mkTmp('bulk-chunk-b-v-');
    const o = mkTmp('bulk-chunk-b-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'bulk-chunk-b-ws';
    try {
        const ids = Array.from({ length: N }, (_, i) => `bulk-node-${String(i).padStart(5, '0')}`);
        for (const id of ids) {
            await graph.upsertNode({
                id, workspace: ws, ecosystem: '*', type: 'note', label: 'seed',
                content: `seed-${id}`, tags: ['t'], security_scopes: [] as string[],
            } as never);
        }

        const res = fakeRes();
        const t0 = Date.now();
        const bulkPromise = handleBulkDelete(res, { ids, workspace: ws }, {
            store: { loreGraph: graph, loreVerbatim: store } as never,
            auditLog: { log: () => undefined } as never,
            deploymentMode: 'local', dataplane: null, outboxStore,
        }).then(() => Date.now() - t0);

        // A single concurrent upsert on an id well inside the batch, started
        // just after the bulk call kicks off — the round-4 regression this
        // pins is that this call used to wait for nearly the WHOLE batch
        // (865x-960x amplification, ~10s) instead of just its own chunk.
        const targetId = ids[500]!;
        const singleStart = Date.now();
        const singlePromise = (async () => {
            await delay(2);
            const r = await nodeUpsert(
                { id: targetId, workspace: ws, ecosystem: '*', initiator: 'test:concurrent-single',
                  nodeData: { id: targetId, type: 'note', label: 'race', content: 'race-content', tags: [], security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            return { ok: r.ok, dt: Date.now() - singleStart };
        })();

        const [bulkWallMs, single] = await Promise.all([bulkPromise, singlePromise]);
        assert.equal(res._status, 200, `bulk-delete must return 200, got ${res._status}`);
        assert.equal(single.ok, true, 'concurrent single upsert must succeed');
        console.log(`    bulk-delete(${N}) wall=${bulkWallMs}ms, concurrent single upsert=${single.dt}ms`);
        assert.ok(single.dt < 1000, `concurrent single upsert took ${single.dt}ms — must complete in under 1s even with a ${N}-id bulk-delete in flight`);
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

// (c) ---------------------------------------------------------------------
test('(c) bulk-upsert: a per-node substrate failure leaves NO pending node.upsert row for that id, and a full replay creates no ghost node', async () => {
    const g = mkTmp('bulk-chunk-c-g-');
    const v = mkTmp('bulk-chunk-c-v-');
    const o = mkTmp('bulk-chunk-c-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'bulk-chunk-c-ws';
    try {
        const goodIds = ['good-0', 'good-1'];
        const badId = 'bad-node';
        const nodes = [
            ...goodIds.map((id) => ({ id, type: 'note', label: 'ok', content: `content-${id}` })),
            { id: badId, type: 'note', label: 'will-fail-at-substrate', content: 'x' },
        ];

        // Monkeypatch bulkUpsertNodes to simulate a genuine per-node substrate
        // failure for `badId` while the others ACTUALLY write, matching
        // SurrealGraph's real per-node error-isolation contract.
        const original = graph.bulkUpsertNodes.bind(graph);
        (graph as unknown as { bulkUpsertNodes: typeof graph.bulkUpsertNodes }).bulkUpsertNodes = (async (batch: never[]) => {
            const results = [];
            for (const node of batch as Array<{ id: string }>) {
                if (node.id === badId) {
                    results.push({ id: node.id, ok: false, error: 'SIMULATED substrate constraint violation' });
                    continue;
                }
                const r = await original([node] as never);
                results.push(r[0]);
            }
            return results;
        }) as typeof graph.bulkUpsertNodes;

        const res = fakeRes();
        await tryBulkWriteRoutes(
            fakePostReqWithBody(JSON.stringify({ workspace: ws, nodes, embed: 'skip' })),
            res, '/api/nodes/bulk', '/api/nodes/bulk',
            { store: { loreGraph: graph, loreVerbatim: store } as never, auditLog: { log: () => undefined } as never,
              deploymentMode: 'local', dataplane: null, outboxStore },
        );
        const body = JSON.parse(res._body) as { results: Array<{ id: string; ok: boolean }> };
        const badResult = body.results.find((r) => r.id === badId);
        assert.ok(badResult, 'result for bad node must be present');
        assert.equal(badResult!.ok, false, 'bad node result must report ok:false');

        const badGraphNode = await graph.getNode(badId);
        assert.equal(badGraphNode, null, 'bad node must NOT exist in the graph (substrate write failed)');

        const pending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        const badRows = pending.filter((r) => (r.payload as { id?: unknown })?.id === badId && r.operationKind === 'node.upsert');
        assert.equal(badRows.length, 0,
            `the failed node's node.upsert outbox row must be retracted — found ${badRows.length} pending row(s): ${JSON.stringify(badRows)}`);

        // Full replicator-shaped replay of every remaining pending row must
        // NOT resurrect the failed node.
        const substrates = realDispatchSubstrates(graph, store);
        const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        for (const entry of allPending) await dispatch(entry, substrates);
        const ghostNode = await graph.getNode(badId);
        assert.equal(ghostNode, null, 'replay must not resurrect the node the caller was told failed');

        for (const id of goodIds) {
            const n = await graph.getNode(id);
            assert.ok(n, `good node ${id} must exist`);
        }
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

// (d) ---------------------------------------------------------------------
test('(d) bulk-delete: a per-id substrate delete failure leaves NO pending node.delete row for that id, and a full replay does not delete it', async () => {
    const g = mkTmp('bulk-chunk-d-g-');
    const v = mkTmp('bulk-chunk-d-v-');
    const o = mkTmp('bulk-chunk-d-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'bulk-chunk-d-ws';
    try {
        const goodIds = ['good-0', 'good-1'];
        const badId = 'bad-delete-node';
        const allIds = [...goodIds, badId];
        for (const id of allIds) {
            await graph.upsertNode({
                id, workspace: ws, ecosystem: '*', type: 'note', label: 'seed', content: 'orig', tags: [], security_scopes: [],
            } as never);
        }

        // Monkeypatch deleteNode to simulate a genuine per-id substrate
        // failure for `badId` (a real error, NOT the idempotent
        // already-gone `false` return) while other ids delete for real.
        const originalDelete = graph.deleteNode.bind(graph);
        (graph as unknown as { deleteNode: typeof graph.deleteNode }).deleteNode = (async (id: string) => {
            if (id === badId) throw new Error('SIMULATED substrate delete failure');
            return originalDelete(id);
        }) as typeof graph.deleteNode;

        const res = fakeRes();
        await handleBulkDelete(res, { ids: allIds, workspace: ws }, {
            store: { loreGraph: graph, loreVerbatim: store } as never,
            auditLog: { log: () => undefined } as never,
            deploymentMode: 'local', dataplane: null, outboxStore,
        });
        const body = JSON.parse(res._body) as { results: Array<{ id: string; ok: boolean }> };
        const badResult = body.results.find((r) => r.id === badId);
        assert.ok(badResult, 'result for bad-delete node must be present');
        assert.equal(badResult!.ok, false, 'bad-delete node result must report ok:false');

        const stillPresent = await graph.getNode(badId);
        assert.ok(stillPresent, 'bad-delete node must STILL be present — the substrate delete failed');

        const pending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        const badRows = pending.filter((r) => (r.payload as { id?: unknown })?.id === badId && r.operationKind === 'node.delete');
        assert.equal(badRows.length, 0,
            `the failed id's node.delete outbox row must be retracted — found ${badRows.length} pending row(s): ${JSON.stringify(badRows)}`);

        // Full replicator-shaped replay of every remaining pending row must
        // NOT delete the node behind the caller's back.
        const substrates = realDispatchSubstrates(graph, store);
        const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        for (const entry of allPending) await dispatch(entry, substrates);
        const afterReplay = await graph.getNode(badId);
        assert.ok(afterReplay, 'replay must not delete the node the caller was told the delete failed for');

        for (const id of goodIds) {
            const n = await graph.getNode(id);
            assert.equal(n, null, `good node ${id} must have been deleted`);
        }
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

// (e) ---------------------------------------------------------------------
test('(e) bulk-upsert (inline embed): a per-node inline verbatim-seed failure leaves NO pending node.upsert row for that id, and a full replay creates no node', async () => {
    const g = mkTmp('bulk-chunk-e-g-');
    const v = mkTmp('bulk-chunk-e-v-');
    const o = mkTmp('bulk-chunk-e-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'bulk-chunk-e-ws';
    try {
        const goodId = 'good-node';
        const badId = 'embed-fail-node';
        const nodes = [
            { id: goodId, type: 'note', label: 'ok', content: 'fine' },
            { id: badId, type: 'note', label: 'will-fail-embed', content: 'boom' },
        ];

        // Monkeypatch VerbatimStore.store to simulate a genuine inline embed
        // failure (e.g. embedding provider unavailable) for `badId` only —
        // this is the real inline-embed call path (bulkWrite.ts's
        // `target.verbatimStore` -> LoreStorageClient -> VerbatimStore.store),
        // exercising the exact catch block this test guards.
        const originalStore = store.store.bind(store);
        (store as unknown as { store: typeof store.store }).store = (async (doc: { id: string }) => {
            if (doc.id === `lore:${badId}`) throw new Error('SIMULATED: embedding provider unavailable');
            return originalStore(doc as never);
        }) as typeof store.store;

        const res = fakeRes();
        await tryBulkWriteRoutes(
            fakePostReqWithBody(JSON.stringify({ workspace: ws, nodes, embed: 'inline' })),
            res, '/api/nodes/bulk', '/api/nodes/bulk',
            { store: { loreGraph: graph, loreVerbatim: store } as never, auditLog: { log: () => undefined } as never,
              deploymentMode: 'local', dataplane: null, outboxStore },
        );
        const body = JSON.parse(res._body) as { results: Array<{ id: string; ok: boolean }> };
        const badResult = body.results.find((r) => r.id === badId);
        assert.ok(badResult, 'result for bad node must be present');
        assert.equal(badResult!.ok, false, 'bad node result must report ok:false (verbatim seed failed)');

        const badGraphNode = await graph.getNode(badId);
        assert.equal(badGraphNode, null, 'bad node must NOT exist in the graph (inline rollback deleteNode must have run)');

        const pending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        const badRows = pending.filter((r) => (r.payload as { id?: unknown })?.id === badId && r.operationKind === 'node.upsert');
        assert.equal(badRows.length, 0,
            `the failed-embed node's node.upsert outbox row must be retracted — found ${badRows.length} pending row(s): ${JSON.stringify(badRows)}`);

        // Full replicator-shaped replay of every remaining pending row must
        // NOT resurrect the node the caller was told failed.
        const substrates = realDispatchSubstrates(graph, store);
        const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        for (const entry of allPending) await dispatch(entry, substrates);
        const ghostNode = await graph.getNode(badId);
        assert.equal(ghostNode, null, 'replay must not resurrect the node whose inline embed failed');

        const goodGraphNode = await graph.getNode(goodId);
        assert.ok(goodGraphNode, 'good node must exist (its embed succeeded)');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
