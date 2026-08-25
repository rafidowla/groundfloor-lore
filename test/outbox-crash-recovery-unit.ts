#!/usr/bin/env tsx
/**
 * outbox-crash-recovery-unit.ts — SP-F2 (2026-06-10).
 *
 * Crash-recovery + replay correctness for the universal-write outbox.
 * Four sibling regressions, all VERIFIED against the pre-fix code:
 *
 *   F1: boot recovery flipped every undelivered hot-lane row to
 *       'replicated' WITHOUT dispatching it (hot-lane rows carry a
 *       single pre-'done' step, so the legacy allDone check was
 *       trivially true) — undelivered writes were silently abandoned
 *       on crash-restart and the dead-letter queue was erased.
 *   F2: the replicator's cursor pre-filter permanently starved a
 *       'failed' row sitting behind a later row's success — retries
 *       never happened, the row never dead-lettered, and lag grew
 *       into 503 backpressure.
 *   F3: embed.batch dispatcher substrates (batchedEmbedder +
 *       storeEmbedBatch) were never wired by outbox/wiring.ts — every
 *       embed.batch row dead-lettered instantly in production.
 *   F4: replicated rows were never pruned — outbox.sqlite grew forever.
 *
 * Pins:
 *   P1: undelivered pending hot-lane row SURVIVES boot recovery and is
 *       dispatched by the replicator afterwards (crash-restart sim)
 *   P2: 'dead' rows survive boot recovery (DLQ not erased)
 *   P3: crashed-mid-dispatch 'replicating' row is re-queued to 'pending'
 *   P4: failed row behind a later success is retried on subsequent
 *       ticks and dead-letters once maxAttempts is exhausted
 *   P5: embed.batch replicates (not dead-letters) through wireOutbox's
 *       PRODUCTION substrates; vectors + texts land in the verbatim store
 *   P6: prune removes old replicated rows, keeps failed/dead, and
 *       sequenceIds stay monotonic after pruning
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import {
    recoverOutbox,
    InMemoryOutboxHandlerRegistry,
} from '../packages/lore/src/outbox/recovery.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { SyncEngine } from '../packages/lore/src/engines/syncEngine.js';
import type { WorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function mkTmp(): { loreDir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-spf2-'));
    return {
        loreDir: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

console.log('outbox crash-recovery + replay correctness (SP-F2)');

/* ---------- P1: crash-restart does not abandon undelivered rows ---------- */

test('P1 — undelivered hot-lane row survives boot recovery and is re-dispatched', async () => {
    const t = mkTmp();
    try {
        const store = new SqliteOutboxStore(t.loreDir);
        // "Process 1": commit a hot-lane write, then crash BEFORE the
        // replicator delivers it (we simply never tick).
        const entry = await recordHotWrite(store, {
            workspace: 'ws1',
            operationKind: 'node.upsert',
            payload: { id: 'n-crash', type: 'decision', label: 'L' },
        });
        // "Process 2" boot: recovery must NOT mark the row completed —
        // pre-fix it flipped status to 'replicated' with zero dispatch.
        const report = await recoverOutbox(store, new InMemoryOutboxHandlerRegistry());
        assert.equal(report.discovered, 1);
        assert.equal(report.completed, 0, 'recovery must not complete an undispatched replicator row');
        assert.equal(report.skippedReplicatorRows, 1);
        const still = await store.listPendingForWorkspace('ws1', 10);
        assert.equal(still.length, 1, 'row still pending for the replicator');
        assert.equal(still[0].id, entry.id);
        assert.equal(still[0].status, 'pending');
        // Boot continues: replicator delivers the row.
        const upserts: string[] = [];
        const substrates: DispatcherSubstrates = {
            upsertNode: async (p) => { upserts.push(String(p['id'])); },
        };
        const r = new OutboxReplicator({ store, substrates, log: () => undefined });
        await r.tickOnce();
        assert.deepEqual(upserts, ['n-crash'], 'row was dispatched after recovery');
        assert.equal((await store.listPendingForWorkspace('ws1', 10)).length, 0);
        store.close();
    } finally { t.cleanup(); }
});

test('P2 — dead-letter rows survive boot recovery (DLQ not erased)', async () => {
    const t = mkTmp();
    try {
        const store = new SqliteOutboxStore(t.loreDir);
        const entry = await recordHotWrite(store, {
            workspace: 'ws2',
            operationKind: 'node.upsert',
            payload: { id: 'n-dead', type: 'decision', label: 'L' },
        });
        await store.markEntryStatus(entry.id, 'dead', { error: 'poison', bumpAttempt: true });
        await recoverOutbox(store, new InMemoryOutboxHandlerRegistry());
        const dead = await store.listDead({ workspace: 'ws2' });
        assert.equal(dead.length, 1, 'dead row still in the DLQ after boot recovery');
        assert.equal(dead[0].id, entry.id);
        store.close();
    } finally { t.cleanup(); }
});

test('P3 — crashed-mid-dispatch replicating row is re-queued to pending', async () => {
    const t = mkTmp();
    try {
        const store = new SqliteOutboxStore(t.loreDir);
        const entry = await recordHotWrite(store, {
            workspace: 'ws3',
            operationKind: 'node.upsert',
            payload: { id: 'n-mid', type: 'decision', label: 'L' },
        });
        // Simulate the crash window: replicator marked 'replicating',
        // daemon died before the substrate write was acknowledged.
        await store.markEntryStatus(entry.id, 'replicating');
        assert.equal((await store.listPendingForWorkspace('ws3', 10)).length, 0,
            'replicating rows are invisible to the replicator poll — without recovery this row is stranded');
        const report = await recoverOutbox(store, new InMemoryOutboxHandlerRegistry());
        assert.equal(report.requeuedReplicating, 1);
        const still = await store.listPendingForWorkspace('ws3', 10);
        assert.equal(still.length, 1, 'row re-queued for idempotent replay');
        assert.equal(still[0].status, 'pending');
        store.close();
    } finally { t.cleanup(); }
});

/* ---------- P4: cursor no longer starves failed rows ---------- */

test('P4 — failed row behind a later success is retried, then dead-letters at maxAttempts', async () => {
    const t = mkTmp();
    try {
        const store = new SqliteOutboxStore(t.loreDir, { retryBaseMs: 0 });
        await recordHotWrite(store, {
            workspace: 'ws4', operationKind: 'node.upsert',
            payload: { id: 'bad', type: 'decision', label: 'L' },
        });
        await recordHotWrite(store, {
            workspace: 'ws4', operationKind: 'node.upsert',
            payload: { id: 'good', type: 'decision', label: 'L' },
        });
        const dispatched: string[] = [];
        const substrates: DispatcherSubstrates = {
            upsertNode: async (p) => {
                const id = String(p['id']);
                dispatched.push(id);
                if (id === 'bad') throw new Error('simulated substrate failure');
            },
        };
        const r = new OutboxReplicator({
            store, substrates, log: () => undefined,
            config: { maxAttempts: 3 },
        });
        // Tick 1: bad (seq 1) fails, good (seq 2) succeeds → cursor
        // advances to 2. Pre-fix, the cursor pre-filter dropped seq 1 on
        // every later tick: attempts froze at 1 and the row never
        // retried NOR dead-lettered.
        await r.tickOnce();
        assert.deepEqual(dispatched, ['bad', 'good']);
        assert.equal((await store.readReplicationState('ws4')).lastReplicatedSeq, 2,
            'cursor advanced past the failed row — the starvation precondition');
        // Tick 2: failed row must be re-dispatched.
        await r.tickOnce();
        assert.equal(dispatched.filter((d) => d === 'bad').length, 2, 'failed row retried behind the cursor');
        // Tick 3: third attempt exhausts maxAttempts → dead-letter.
        await r.tickOnce();
        assert.equal(dispatched.filter((d) => d === 'bad').length, 3);
        const dead = await store.listDead({ workspace: 'ws4' });
        assert.equal(dead.length, 1, 'poison row reaches the DLQ instead of starving forever');
        assert.equal(dead[0].attempts, 3);
        // Tick 4: dead rows are skipped — no further dispatches.
        await r.tickOnce();
        assert.equal(dispatched.filter((d) => d === 'bad').length, 3, 'dead row no longer polled');
        store.close();
    } finally { t.cleanup(); }
});

/* ---------- P5: embed.batch wired in PRODUCTION substrates ---------- */

test('P5 — embed.batch replicates through wireOutbox production substrates (no dead-letter)', async () => {
    const t = mkTmp();
    try {
        const addedRows: Array<Record<string, unknown>> = [];
        const upsertedRows: Array<Record<string, unknown>> = [];
        const deletedIds: string[] = [];
        const stubGraph = {
            getNode: async (id: string) => ({
                id, type: 'decision', label: `label-${id}`, content: '', tags: 'a,b',
                project: 'p1', ecosystem: 'e1', metadata: '', createdAt: '2026-06-10',
                updatedAt: '2026-06-10', syncedAt: null,
            }),
        } as unknown as WorkspaceGraph;
        const stubVerbatim = {
            physicalDeleteMany: async (ids: string[]) => { deletedIds.push(...ids); return ids.length; },
            bulkAddPrebuiltRows: async (rows: Array<Record<string, unknown>>) => { addedRows.push(...rows); },
            // SW-03 (B4): embed.batch now persists via an ATOMIC mergeInsert
            // upsert instead of delete-then-add; this is the path exercised.
            bulkUpsertPrebuiltRows: async (rows: Array<Record<string, unknown>>) => { upsertedRows.push(...rows); },
        } as unknown as VerbatimStore;
        const stubEmbedder = {
            dimension: 4,
            modelId: 'stub-model',
            embedDocument: async () => [9, 9, 9, 9],
            embedDocumentBatch: async (texts: string[]) => texts.map((_, i) => [i + 1, i + 1, i + 1, i + 1]),
        } as unknown as EmbeddingProvider;
        const wiring = wireOutbox({
            loreDir: t.loreDir,
            getSyncEngine: () => ({
                recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }),
            }) as unknown as SyncEngine,
            getGraph: () => stubGraph,
            getVerbatim: () => stubVerbatim,
            getEmbedder: () => stubEmbedder,
        });
        await recordHotWrite(wiring.store, {
            workspace: 'wsE',
            operationKind: 'embed.batch',
            payload: { texts: ['hello', 'world'], targetNodeIds: ['lore:n1', 'lore:n2'] },
        });
        await wiring.replicator.tickOnce();
        // Pre-fix: UnwiredOperationKindError → marked dead on first dispatch.
        const dead = await wiring.store.listDead!({ workspace: 'wsE' });
        assert.equal(dead.length, 0, 'embed.batch must not dead-letter with production wiring');
        assert.equal((await wiring.store.listPendingForWorkspace!('wsE', 10)).length, 0, 'row replicated');
        // SW-03 (B4): embed.batch persists via the ATOMIC bulkUpsertPrebuiltRows
        // (mergeInsert on id), NOT delete-then-add — so there is no window where
        // the canonical vectors are deleted but not yet re-added. The old replace
        // path (physicalDeleteMany + bulkAddPrebuiltRows) must NOT be exercised.
        assert.deepEqual(deletedIds, [], 'no separate delete: atomic upsert leaves old-or-new, never neither');
        assert.equal(addedRows.length, 0, 'old delete-then-add path replaced by atomic upsert');
        assert.equal(upsertedRows.length, 2);
        assert.deepEqual(upsertedRows.map((r) => r['id']), ['lore:n1', 'lore:n2']);
        assert.deepEqual(upsertedRows.map((r) => r['text']), ['hello', 'world'], 'stored text is the embedded text');
        assert.deepEqual(upsertedRows[0]['vector'], [1, 1, 1, 1]);
        assert.deepEqual(upsertedRows[1]['vector'], [2, 2, 2, 2]);
        assert.equal(upsertedRows[0]['label'], 'label-n1', 'metadata enriched from the graph node');
        assert.ok(typeof upsertedRows[0]['contentHash'] === 'string' && upsertedRows[0]['contentHash'] !== '');
        (wiring.store as SqliteOutboxStore).close();
    } finally { t.cleanup(); }
});

/* ---------- P6: replicated rows are pruned; sequenceIds stay monotonic ---------- */

test('P6 — prune deletes old replicated rows, keeps failed/dead, keeps sequenceIds monotonic', async () => {
    const t = mkTmp();
    try {
        const store = new SqliteOutboxStore(t.loreDir);
        for (const id of ['p1', 'p2', 'p3']) {
            await recordHotWrite(store, {
                workspace: 'wsP', operationKind: 'node.upsert',
                payload: { id, type: 'decision', label: 'L' },
            });
        }
        const substrates: DispatcherSubstrates = { upsertNode: async () => { /* succeed */ } };
        const r = new OutboxReplicator({ store, substrates, log: () => undefined });
        await r.tickOnce();
        assert.equal((await store.readReplicationState('wsP')).lastReplicatedSeq, 3);
        // Operator-triage rows that must survive the sweep.
        const failedEntry = await recordHotWrite(store, {
            workspace: 'wsP', operationKind: 'node.upsert',
            payload: { id: 'p-failed', type: 'decision', label: 'L' },
        });
        await store.markEntryStatus(failedEntry.id, 'failed', { error: 'x', bumpAttempt: true });
        const deadEntry = await recordHotWrite(store, {
            workspace: 'wsP', operationKind: 'node.upsert',
            payload: { id: 'p-dead', type: 'decision', label: 'L' },
        });
        await store.markEntryStatus(deadEntry.id, 'dead', { error: 'x', bumpAttempt: true });
        // Prune everything replicated, regardless of age.
        const pruned = await r.runPruneSweep({ force: true, olderThanMsOverride: 0 });
        assert.equal(pruned, 3, 'all replicated rows pruned');
        assert.equal(r.getStats().pruned, 3);
        // includeDead: true -- listFailedOlderThan defaults to 'failed' rows
        // only (a deliberate distinction: failed=retriable, dead=given-up),
        // so this test must opt in explicitly to see both, matching what it
        // actually asserts on the next line.
        const surviving = await store.listFailedOlderThan(0, { workspace: 'wsP', includeDead: true });
        assert.equal(surviving.length, 2, 'failed + dead rows survive the sweep');
        // Monotonic sequenceIds: surviving max seq is 5; the cursor (3)
        // would also keep us monotonic if ALL rows were pruned. Prune the
        // failed/dead too (via remove) to prove the cursor-seeded floor.
        await store.remove(failedEntry.id);
        await store.remove(deadEntry.id);
        const fresh = await recordHotWrite(store, {
            workspace: 'wsP', operationKind: 'node.upsert',
            payload: { id: 'p-after', type: 'decision', label: 'L' },
        });
        assert.ok((fresh.sequenceId ?? 0) > 3,
            `sequenceId must stay above the replication cursor after pruning (got ${fresh.sequenceId})`);
        // Cursor state itself survives the prune.
        assert.equal((await store.readReplicationState('wsP')).lastReplicatedSeq, 3);
        store.close();
    } finally { t.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
