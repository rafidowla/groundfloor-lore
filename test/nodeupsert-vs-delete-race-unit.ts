#!/usr/bin/env tsx
/**
 * test/nodeupsert-vs-delete-race-unit.ts — regression for the
 * cross-substrate split-brain between `nodeUpsert()` and the node-DELETE /
 * bulk write paths.
 *
 * Sibling of test/nodeupsert-concurrent-split-brain-unit.ts, which pinned
 * upsert-vs-upsert. This one pins the case that was still open: `nodeUpsert()`
 * held a per-(workspace,id) lock that was PRIVATE to core/nodeService.ts, so
 * every OTHER mutating path for the same id — MCP `delete_node`, REST
 * `DELETE /api/node/:id`, `POST /api/nodes/bulk`, `POST /api/nodes/bulk-delete`,
 * changeset delete, prune/restore, and the outbox replay — ran its own
 * outbox -> graph -> verbatim sequence with no serialization against it
 * (only `SurrealGraph`'s graph-ONLY `nodeWriteChain` underneath).
 *
 * Two things break when a delete interleaves with an upsert on one id:
 *   1. The substrates disagree: the graph holds the node while the
 *      verbatim/search mirror holds a tombstone (or the reverse), with BOTH
 *      callers told the write succeeded. Durable, silent.
 *   2. The outbox order contradicts the executed order: the outbox says
 *      `node.upsert` then `node.delete` while the graph's surviving state is
 *      the upsert's — so a replay/replication of those rows re-applies the
 *      OPPOSITE outcome.
 *
 * The fix: one shared lock, `withNodeLock` / `withNodeLocks` in
 * core/nodeWriteLock.ts (the same `KeyedMutex` and key format nodeService
 * used privately), taken by `nodeUpsert()` AND by every one of those paths.
 *
 * Baseline behaviour is exercised honestly rather than asserted from a
 * comment: `core/nodeWriteLock.js` is imported DYNAMICALLY and falls back to
 * a pass-through when the module does not exist (i.e. on pre-fix source).
 * Pre-fix the delete/bulk sequences below therefore run exactly as the
 * shipped handlers ran them — unserialized — and the split-brain reproduces.
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`
 * (embedded SurrealDB), a real `VerbatimStore` (LanceDB, constant-vector
 * embedder so no model load), a real `FileOutboxStore` — with the delete
 * sequence replicating mcp/tools/memory/deleteNode.ts step for step
 * (`recordHotWrite('node.delete')` -> `graph.deleteNode` -> verbatim
 * `tombstone`) and the bulk sequence replicating the batched branch of
 * mcp/http/routes/bulkWrite.ts (`recordHotWriteBatch` -> `bulkUpsertNodes`
 * -> per-node verbatim seed). Jitter is injected in the window the real
 * handlers leave open (between the graph write and the verbatim write) so
 * the race is exercised deterministically instead of hoped for.
 *
 * Run: npx tsx test/nodeupsert-vs-delete-race-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { recordHotWrite, recordHotWriteBatch } from '../packages/lore/src/outbox/hotLane.js';
import { buildVerbatimText } from '../packages/lore/src/engines/verbatimSchema.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

/* ─── the lock under test, resolved at runtime ─────────────────────────
 * Present post-fix; absent pre-fix, where both helpers degrade to a
 * pass-through and the sequences below run exactly as the shipped
 * handlers ran them before the fix. */
type LockFn = <T>(workspace: string, id: string, fn: () => Promise<T>) => Promise<T>;
type MultiLockFn = <T>(workspace: string, ids: readonly string[], fn: () => Promise<T>) => Promise<T>;
let withNodeLock: LockFn = (_w, _i, fn) => fn();
let withNodeLocks: MultiLockFn = (_w, _i, fn) => fn();
let lockPresent = false;
try {
    const mod = await import('../packages/lore/src/core/nodeWriteLock.js');
    withNodeLock = mod.withNodeLock;
    withNodeLocks = mod.withNodeLocks;
    lockPresent = true;
} catch {
    console.log('  ! core/nodeWriteLock.js absent — running the BASELINE (unserialized) shape');
}

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/** Constant-vector embedder: avoids loading a real model. */
class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'delete-race-const'; }
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

// Plain `new Promise` executor — `Promise.withResolvers` is not on this
// package's TS lib target (see surrealConnection.ts's identical note).
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Stack {
    graph: SurrealGraph;
    store: VerbatimStore;
    outboxStore: FileOutboxStore;
    close: () => Promise<void>;
}

async function openStack(prefix: string): Promise<Stack> {
    const g = mkTmp(`${prefix}-g-`);
    const v = mkTmp(`${prefix}-v-`);
    const o = mkTmp(`${prefix}-o-`);
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    return {
        graph, store, outboxStore,
        close: async () => {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); o.cleanup();
        },
    };
}

const WORKSPACE = 'w';

function upsert(stack: Stack, id: string, label: string): Promise<{ ok: boolean }> {
    return nodeUpsert(
        {
            id, workspace: WORKSPACE, ecosystem: '*', initiator: `test:${label}`,
            nodeData: {
                id, type: 'note', label, content: `content-${label}`,
                tags: ['t'], security_scopes: [] as string[],
            },
            targetGraph: stack.graph,
        },
        {
            outboxStore: stack.outboxStore,
            inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) },
        },
    );
}

/**
 * mcp/tools/memory/deleteNode.ts's sequence, step for step, under the same
 * lock the handler now takes. `graphToVerbatimDelayMs` widens the window the
 * handler genuinely has between its graph delete and its tombstone (the
 * tombstone awaits a LanceDB flush) so the race is exercised every run.
 */
async function deleteSequence(stack: Stack, id: string, graphToVerbatimDelayMs: number): Promise<boolean> {
    return withNodeLock(WORKSPACE, id, async () => {
        await recordHotWrite(stack.outboxStore, {
            workspace: WORKSPACE,
            operationKind: 'node.delete',
            payload: { id },
            initiator: 'mcp:delete_node',
            operation: 'node.delete',
        });
        const deleted = await stack.graph.deleteNode(id);
        if (!deleted) return false;
        await delay(graphToVerbatimDelayMs);
        await stack.store.tombstone(`lore:${id}`, 'graph node deleted via MCP delete_node');
        return true;
    });
}

/** True when the verbatim row for `id` is a tombstone rather than live content. */
async function verbatimState(stack: Stack, id: string): Promise<{ tombstoned: boolean; text: string; present: boolean }> {
    const row = await stack.store.getById(`lore:${id}`);
    const text = row?.text ?? '';
    return { tombstoned: text.startsWith('[TOMBSTONED'), text, present: !!row };
}

/** node.* rows for the workspace, in commit order (sequenceId). */
async function nodeOutboxKinds(stack: Stack): Promise<string[]> {
    const rows = await stack.outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
    return rows
        .map((r) => r.operationKind)
        .filter((k) => k === 'node.upsert' || k === 'node.delete')
        .map((k) => String(k));
}

console.log(`\nnodeUpsert vs delete / bulk — shared per-(workspace,id) write-lock regression (lock module ${lockPresent ? 'PRESENT' : 'ABSENT'})\n`);

test('concurrent nodeUpsert + delete_node on the SAME id: graph and verbatim agree, and outbox order matches execution order (5 iterations)', async () => {
    const ITERATIONS = 5;
    const splitBrains: string[] = [];
    const outboxMismatches: string[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
        const stack = await openStack('lore-delrace');
        try {
            const id = 'delete-race-node';
            const seed = await upsert(stack, id, 'seed');
            assert.equal(seed.ok, true, 'seed write must succeed');

            // The delete starts first; the upsert lands 20 ms in — inside the
            // 60 ms window the delete leaves between its graph delete and its
            // tombstone. Pre-fix that is exactly where the upsert's graph +
            // verbatim writes slot in, and the delayed tombstone then buries
            // the verbatim row of a node the graph still holds.
            const [deleted, up] = await Promise.all([
                deleteSequence(stack, id, 60),
                (async () => { await delay(20); return upsert(stack, id, 'A'); })(),
            ]);
            assert.equal(up.ok, true, 'the concurrent upsert must still report success');

            const graphNode = await stack.graph.getNode(id);
            const verbatim = await verbatimState(stack, id);
            const graphPresent = !!graphNode;

            // Consistency: node in the graph <=> live (non-tombstoned) verbatim row.
            if (graphPresent === verbatim.tombstoned) {
                splitBrains.push(
                    `run ${run}: deleted=${deleted} graph=${graphPresent ? `PRESENT(${graphNode!.label})` : 'ABSENT'} ` +
                    `verbatim=${verbatim.tombstoned ? 'TOMBSTONED' : verbatim.present ? `LIVE(${verbatim.text.slice(0, 24)})` : 'ABSENT'}`,
                );
            }

            // Ordering: whichever operation ran LAST owns the surviving graph
            // state, so it must also own the LAST node.* outbox row. Under the
            // lock the two cannot disagree; unlocked they routinely do (the
            // outbox says node.upsert then node.delete while the graph holds
            // the upsert), which makes replay re-apply the opposite outcome.
            const kinds = await nodeOutboxKinds(stack);
            const lastKind = kinds[kinds.length - 1];
            const expected = graphPresent ? 'node.upsert' : 'node.delete';
            if (lastKind !== expected) {
                outboxMismatches.push(`run ${run}: graph=${graphPresent ? 'PRESENT' : 'ABSENT'} but outbox order ${kinds.join(',')}`);
            }
        } finally {
            await stack.close();
        }
    }
    assert.deepEqual(splitBrains, [], `graph/verbatim split-brain reproduced:\n      ${splitBrains.join('\n      ')}`);
    assert.deepEqual(outboxMismatches, [], `outbox order contradicts executed order:\n      ${outboxMismatches.join('\n      ')}`);
});

test('concurrent bulk upsert + single nodeUpsert on a SHARED id: graph and verbatim agree on one winner (5 iterations)', async () => {
    const ITERATIONS = 5;
    const splitBrains: string[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
        const stack = await openStack('lore-bulkrace');
        try {
            // Three ids in the batch, one of them (`shared`) also written by a
            // concurrent single write — the realistic shape, not a 1-item batch.
            const ids = ['bulk-race-a', 'bulk-race-shared', 'bulk-race-z'];
            const shared = ids[1]!;

            // mcp/http/routes/bulkWrite.ts's batched branch, step for step:
            // one recordHotWriteBatch for the whole batch, then bulkUpsertNodes
            // + the per-node inline verbatim seed under the batch's locks.
            const bulkSequence = async (): Promise<void> => {
                const rows = ids.map((id) => ({
                    id, type: 'note', label: 'BULK', content: `content-BULK`,
                    tags: [] as string[], project: WORKSPACE, ecosystem: '*',
                }));
                await recordHotWriteBatch(stack.outboxStore, rows.map((raw) => ({
                    workspace: WORKSPACE,
                    operationKind: 'node.upsert' as const,
                    payload: raw as unknown as Record<string, unknown>,
                    initiator: 'http:POST /api/nodes/bulk',
                    operation: 'graph.upsert',
                })));
                await withNodeLocks(WORKSPACE, ids, async () => {
                    await stack.graph.bulkUpsertNodes(rows as never);
                    for (const raw of rows) {
                        // The window the real handler has between its batched
                        // graph write and each node's verbatim seed.
                        await delay(20);
                        const text = buildVerbatimText(raw.label, raw.content, raw.tags);
                        await stack.store.store({
                            id: `lore:${raw.id}`,
                            text,
                            metadata: { type: raw.type, label: raw.label, tags: '', project: WORKSPACE, ecosystem: '*' },
                        });
                    }
                });
            };

            const [, single] = await Promise.all([
                bulkSequence(),
                (async () => { await delay(10); return upsert(stack, shared, 'SINGLE'); })(),
            ]);
            assert.equal(single.ok, true, 'the concurrent single write must still report success');

            const graphNode = await stack.graph.getNode(shared);
            assert.ok(graphNode, 'graph node must exist after both writes');
            const verbatim = await verbatimState(stack, shared);
            assert.equal(verbatim.present, true, 'verbatim row must exist after both writes');
            // Whichever writer the graph kept must be the one the verbatim
            // mirror kept. Pre-fix the single write's verbatim seed lands
            // inside the batch's graph-to-verbatim window and is then
            // overwritten by the batch's own seed for the same id, while the
            // graph keeps the single write.
            if (!verbatim.text.includes(`content-${graphNode.label}`)) {
                splitBrains.push(`run ${run}: graph="${graphNode.label}" but verbatim="${verbatim.text.slice(0, 40)}"`);
            }
        } finally {
            await stack.close();
        }
    }
    assert.deepEqual(splitBrains, [], `bulk-vs-single split-brain reproduced:\n      ${splitBrains.join('\n      ')}`);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
