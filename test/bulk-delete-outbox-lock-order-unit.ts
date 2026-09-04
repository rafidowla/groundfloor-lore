#!/usr/bin/env tsx
/**
 * test/bulk-delete-outbox-lock-order-unit.ts — QA A2 round-3 regression
 * (2026-09-03).
 *
 * `mcp/http/routes/bulkWriteEdgesDelete.ts::handleBulkDelete` (the
 * POST /api/nodes/bulk-delete handler) used to commit the WHOLE batch's
 * `node.delete` outbox rows via `recordHotWriteBatch` BEFORE the per-id
 * loop took `withNodeLock` for any of them. A concurrent `nodeUpsert()` on
 * one of the batch's ids records its OWN `node.upsert` row inside ITS lock
 * and can win that lock — and finish, releasing it — before this batch's
 * turn for that id even starts. The real substrate order then came out
 * backwards from the outbox commit order (this batch's `node.delete` row
 * was already durable before the concurrent upsert's `node.upsert` row
 * existed, even though the upsert's write landed AFTER this batch actually
 * deleted the node) — a replay of the outbox in commit order resurrected a
 * node the real end-state had deleted.
 *
 * `mcp/http/routes/bulkWrite.ts::handleBulkNodes` (POST /api/nodes/bulk) had
 * the identical shape for `node.upsert`: its `recordHotWriteBatch` call also
 * ran before either write branch's lock(s), so the same class of race let a
 * concurrent delete's outbox row predate a bulk-upsert whose write actually
 * landed first (or vice versa).
 *
 * Fix (both files): acquire every id in the batch via `withNodeLocks`
 * (sorted, deadlock-free) FIRST, then run the batch's single
 * `recordHotWriteBatch` commit and every id's substrate write INSIDE that
 * one locked region. Nothing touching any of the batch's ids can land
 * between the outbox commit and the substrate writes any more.
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`, a
 * real `VerbatimStore`, a real `FileOutboxStore`, the REAL `handleBulkDelete`
 * / `tryBulkWriteRoutes` HTTP handlers (captured via a fake req/res, mirroring
 * test/verbatim-tombstone-outbox-replay-unit.ts and test/bulk-write-w9-unit.ts)
 * racing the REAL `nodeUpsert()` / `handleBulkDelete` on a shared id, and the
 * REAL `dispatch()` (outbox/dispatcher.ts) driven by REAL substrates
 * `wireOutbox()` builds for the replay-convergence check.
 *
 * Run: npx tsx test/bulk-delete-outbox-lock-order-unit.ts
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
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'bulkdel-lock-order-const'; }
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bulkdel-lock-order-wiring-'));
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
function fakeDeleteReq(): IncomingMessage {
    return { method: 'DELETE', on: () => undefined } as unknown as IncomingMessage;
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

console.log('\nbulk outbox-commit vs write-lock ordering — regression (QA A2 round-3)\n');

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

test('bulk-delete races a concurrent nodeUpsert on a shared id: outbox order matches the real end-state, and a full replay converges (5 iterations)', async () => {
    const ITERATIONS = 5;
    const mismatches: string[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
        const g = mkTmp(`lore-bulkdel-lockorder-g${run}-`);
        const v = mkTmp(`lore-bulkdel-lockorder-v${run}-`);
        const o = mkTmp(`lore-bulkdel-lockorder-o${run}-`);
        const graph = new SurrealGraph(g.dir);
        const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
        const outboxStore = new FileOutboxStore(o.dir);
        await graph.initialize();
        await store.initialize();
        const ws = `bulkdel-lockorder-ws-${run}`;
        try {
            const shared = 'shared-node';
            // Several filler ids ahead of `shared` in the batch — handleBulkDelete
            // processes ids sequentially, so the REAL SurrealGraph deletes +
            // LanceDB tombstones + outbox writes for these give the concurrent
            // upsert below a real (not simulated) window to win the lock on
            // `shared` before the delete loop's turn for it arrives.
            const fillers = ['filler-0', 'filler-1', 'filler-2', 'filler-3', 'filler-4'];
            const allIds = [...fillers, shared];
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
                await delay(2); // starts just after the delete's outbox commit, well before its loop reaches `shared`
                return nodeUpsert(
                    { id: shared, workspace: ws, ecosystem: '*', initiator: 'test:concurrent-upsert',
                      nodeData: { id: shared, type: 'note', label: 'race-winner', content: 'RACE-WINNER-CONTENT', tags: ['t'], security_scopes: [] as string[] },
                      targetGraph: graph },
                    { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
                );
            })();

            const [, upsertResult] = await Promise.all([deletePromise, upsertPromise]);
            assert.equal(upsertResult.ok, true, 'the concurrent upsert must still report success');

            const graphNode = await graph.getNode(shared);
            const realPresent = !!graphNode;

            const kinds = await nodeKindsFor(outboxStore, ws, shared);
            const lastKind = kinds[kinds.length - 1];
            const expectedKind = realPresent ? 'node.upsert' : 'node.delete';
            if (lastKind !== expectedKind) {
                mismatches.push(
                    `run ${run}: real graph=${realPresent ? 'PRESENT' : 'ABSENT'} but shared-id outbox order was [${kinds.join(',')}]`,
                );
            }

            // Full replicator-shaped replay of every pending row must converge
            // to the SAME real end-state, not resurrect/re-delete it.
            const substrates = realDispatchSubstrates(graph, store);
            const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
            for (const entry of allPending) await dispatch(entry, substrates);
            const graphAfterReplay = await graph.getNode(shared);
            assert.equal(
                !!graphAfterReplay, realPresent,
                `run ${run}: replay must converge to the real end-state (real present=${realPresent}, replay present=${!!graphAfterReplay})`,
            );
        } finally {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); o.cleanup();
        }
    }
    assert.deepEqual(mismatches, [], `bulk-delete outbox order contradicted the real end-state:\n      ${mismatches.join('\n      ')}`);
});

/**
 * A thin pass-through over a REAL `SurrealGraph` that deliberately does NOT
 * expose `bulkListProjected`/`queryEdges` — `isWorkspaceGraph()`
 * (engines/requireWorkspaceGraph.ts) then reports false, so
 * `handleBulkNodes` takes its ARCADE/cloud `else` branch (a sequential
 * `upsertOne` loop) instead of the batched `bulkUpsertNodes` branch. Every
 * call still hits the SAME real SurrealDB instance, so each item in the
 * loop below is a genuine async operation (real yield points), unlike a
 * fully in-memory fake graph, which would let the whole loop run to
 * completion inside one microtask tick and never leave the concurrent
 * delete an opening.
 */
function asArcadeLikeGraph(real: SurrealGraph) {
    return {
        upsertNode: (n: never) => real.upsertNode(n),
        deleteNode: (id: string) => real.deleteNode(id),
        getNode: (id: string) => real.getNode(id),
        addEdge: (e: never) => real.addEdge(e),
    };
}

test('bulk node-upsert (POST /api/nodes/bulk, ARCADE per-id branch) races a concurrent delete on a shared id: outbox order matches the real end-state, and a full replay converges (5 iterations)', async () => {
    const ITERATIONS = 5;
    const mismatches: string[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
        const g = mkTmp(`lore-bulkup-lockorder-g${run}-`);
        const v = mkTmp(`lore-bulkup-lockorder-v${run}-`);
        const o = mkTmp(`lore-bulkup-lockorder-o${run}-`);
        const realGraph = new SurrealGraph(g.dir);
        const graph = asArcadeLikeGraph(realGraph);
        const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
        const outboxStore = new FileOutboxStore(o.dir);
        await realGraph.initialize();
        await store.initialize();
        const ws = `bulkup-lockorder-ws-${run}`;
        try {
            const shared = 'shared-node';
            const seed = await nodeUpsert(
                { id: shared, workspace: ws, ecosystem: '*', initiator: 'test:seed',
                  nodeData: { id: shared, type: 'note', label: 'seed', content: 'seed-content', tags: ['t'], security_scopes: [] as string[] },
                  targetGraph: graph as never },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            assert.equal(seed.ok, true);

            // Several filler ids ahead of `shared` in the batch — the ARCADE
            // `else` branch (mcp/http/routes/bulkWrite.ts) processes
            // `validSpecs` sequentially via `upsertOne`, each a REAL
            // SurrealGraph call (the wrapper above), giving the concurrent
            // delete below a real window to win the lock on `shared` and
            // finish before the batch's turn for it arrives.
            const fillers = ['filler-0', 'filler-1', 'filler-2', 'filler-3', 'filler-4'];
            const nodes = fillers.map((id) => ({ id, type: 'note', label: 'filler' }))
                .concat([{ id: shared, type: 'note', label: 'BULK-WINNER', content: 'BULK-WINNER-CONTENT' } as never]);

            const res = fakeRes();
            const upsertPromise = tryBulkWriteRoutes(
                fakePostReqWithBody(JSON.stringify({ workspace: ws, nodes, embed: 'skip' })),
                res, '/api/nodes/bulk', '/api/nodes/bulk',
                {
                    store: { loreGraph: graph, loreVerbatim: store } as never,
                    auditLog: { log: () => undefined } as never,
                    deploymentMode: 'local', dataplane: null,
                    outboxStore,
                },
            );
            const deleteRes = fakeRes();
            const deletePromise = (async () => {
                await delay(2); // starts just after the bulk's outbox commit, well before its loop reaches `shared`
                return handleBulkDelete(
                    deleteRes,
                    { ids: [shared], workspace: ws },
                    {
                        store: { loreGraph: graph, loreVerbatim: store } as never,
                        auditLog: { log: () => undefined } as never,
                        deploymentMode: 'local', dataplane: null,
                        outboxStore,
                    },
                );
            })();

            await Promise.all([upsertPromise, deletePromise]);
            assert.equal(deleteRes._status, 200, `bulk-delete must succeed; got ${deleteRes._status}: ${deleteRes._body}`);

            const graphNode = await realGraph.getNode(shared);
            const realPresent = !!graphNode;

            const kinds = await nodeKindsFor(outboxStore, ws, shared);
            const lastKind = kinds[kinds.length - 1];
            const expectedKind = realPresent ? 'node.upsert' : 'node.delete';
            if (lastKind !== expectedKind) {
                mismatches.push(
                    `run ${run}: real graph=${realPresent ? 'PRESENT' : 'ABSENT'} but shared-id outbox order was [${kinds.join(',')}]`,
                );
            }

            const substrates = realDispatchSubstrates(realGraph, store);
            const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
            for (const entry of allPending) await dispatch(entry, substrates);
            const graphAfterReplay = await realGraph.getNode(shared);
            assert.equal(
                !!graphAfterReplay, realPresent,
                `run ${run}: replay must converge to the real end-state (real present=${realPresent}, replay present=${!!graphAfterReplay})`,
            );
        } finally {
            await store.close().catch(() => undefined);
            await realGraph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); o.cleanup();
        }
    }
    assert.deepEqual(mismatches, [], `bulk node-upsert outbox order contradicted the real end-state:\n      ${mismatches.join('\n      ')}`);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
