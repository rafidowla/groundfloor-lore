#!/usr/bin/env tsx
/**
 * test/outbox-crosskind-supersede-unit.ts — cross-kind outbox
 * supersession durability regression (2026-07-05).
 *
 * THE BUG (confirmed HIGH-severity, reachable in embedded/local):
 *   RA-6 (F-S03/S04/S05) skips a stale `status='failed'` outbox row when a
 *   NEWER same-key row already reached 'replicated', so replaying it can't
 *   revert the newer state. But the store's `hasNewerReplicatedForKey`
 *   hard-scoped its WHERE to `operationKind = ?`, so supersession only fired
 *   WITHIN a single operationKind. That misses the reverse-op reorderings:
 *
 *     1. store node X  → node.upsert seq=1 (pending) + direct graph write
 *     2. the replicator dispatch of seq=1 throws TRANSIENTLY (Kùzu
 *        single-writer acquireTimeout / IO hiccup) → row 'failed' w/ a
 *        future nextAttemptAt (backoff).
 *     3. delete node X → node.delete seq=3 (pending) + direct graph delete;
 *        X is gone.
 *     4. the replicator replicates seq=3 → 'replicated'.
 *     5. seq=1's backoff expires and it retries; isSupersededFailed asked
 *        hasNewerReplicatedForKey(ws,'node.upsert',X,1), which only matched
 *        SAME-kind node.upsert rows, so the replicated node.delete did NOT
 *        supersede it → the replicator RE-DISPATCHED upsertNode(X),
 *        RESURRECTING the deleted node durably.
 *
 * THE FIX: supersession is scoped by ENTITY FAMILY (node.* vs node.*,
 * edge.* vs edge.*) — ANY newer replicated op on the SAME entity supersedes
 * a failed op, regardless of kind — but NEVER across families. This file
 * models the EXACT reordering (NOT in-seq order) against a REAL
 * SqliteOutboxStore + OutboxReplicator with fake substrates, and asserts the
 * failed op is SUPERSEDED (skipped, marked dead) rather than re-dispatched.
 *
 * Cases:
 *   R1  reported case: replicated node.delete supersedes failed node.upsert
 *       (same id) → upsert NOT re-dispatched, node stays deleted.
 *   R2  inverse: replicated node.upsert supersedes failed node.delete
 *       (same id) → delete NOT re-dispatched, node stays live.
 *   E1  edge variant: replicated edge.delete supersedes failed edge.upsert
 *       (same sourceId/targetId/relation).
 *   E2  edge inverse: replicated edge.upsert supersedes failed edge.delete.
 *   N1  NEGATIVE: a failed op on key K is NOT superseded by a replicated op
 *       on a DIFFERENT key K2 (no over-broad supersession) → it retries.
 *   N2  NEGATIVE: a node op is NOT superseded by an edge op even when their
 *       key strings could collide (family scoping) → it retries.
 *   S1  SUBSET: original RA-6 same-kind behavior still holds (replicated
 *       node.upsert seq>S supersedes failed node.upsert on same id).
 *
 * REGRESSION (2026-07-05, follow-up to c79e505): c79e505 replaced the
 * payload.id/same-kind guard with keyOfEntry(), which returned a family only
 * for node.* / edge.* — so `verbatim.upsert` (payload id = `lore:<id>`) LOST
 * supersession entirely, letting an older FAILED verbatim.upsert retry and
 * durably OVERWRITE a newer replicated verbatim.upsert on the same id
 * (vector/BM25 substrate reverts to stale content → stale recall/search).
 * These cases lock in the restored behavior:
 *   V-SAME  replicated verbatim.upsert supersedes failed verbatim.upsert on
 *           the SAME id → the failed one is NOT re-dispatched; stored content
 *           stays the newer text (no stale overwrite).
 *   VN-ID   NEGATIVE: a failed verbatim.upsert is NOT superseded by a
 *           verbatim.upsert on a DIFFERENT id → it retries.
 *   VN-FAM  NEGATIVE: a failed verbatim.upsert is NOT superseded by a node.*
 *           op sharing the exact key string (verbatim is its own family) →
 *           it retries. (There is no verbatim delete/tombstone kind, so no
 *           V-CROSS pair exists.)
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { keyOfEntry } from '../packages/lore/src/outbox/supersession.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry, OutboxStatus } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); }
    })());
}

const tmpDirs: string[] = [];
function newStore(): SqliteOutboxStore {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-crosskind-'));
    tmpDirs.push(d);
    return new SqliteOutboxStore(d, { retryBaseMs: 500 });
}

const NOW = '2026-07-05T00:00:00.000Z';
function baseEntry(over: Partial<OutboxEntry> & { id: string }): OutboxEntry {
    return {
        id: over.id,
        operation: over.operation ?? 'op',
        initiator: over.initiator ?? 'test:crosskind',
        createdAt: over.createdAt ?? NOW,
        updatedAt: over.updatedAt ?? NOW,
        steps: over.steps ?? [],
        completed: over.completed ?? false,
        workspace: over.workspace,
        operationKind: over.operationKind,
        payload: over.payload,
        status: over.status,
        sequenceId: over.sequenceId,
    };
}

/**
 * A fake-substrate replicator harness. `dispatched` records every
 * operationKind:key the dispatcher actually applied, so we can prove
 * whether a superseded row was (wrongly) re-dispatched. `graph` /`edges`
 * model durable substrate state so we can assert the entity's final state.
 */
function makeHarness(store: SqliteOutboxStore) {
    const dispatched: string[] = [];
    const nodes = new Set<string>();
    const edges = new Set<string>();
    // Models the durable verbatim (vector/BM25) substrate: id → stored text.
    // A stale re-dispatch of a superseded verbatim.upsert would overwrite a
    // newer value here — the exact regression under test.
    const verbatim = new Map<string, string>();
    const edgeKey = (p: { sourceId: string; targetId: string; relation: string }) => `${p.sourceId}|${p.targetId}|${p.relation}`;
    const substrates: DispatcherSubstrates = {
        async upsertNode(payload) {
            dispatched.push(`node.upsert:${String(payload['id'])}`);
            nodes.add(String(payload['id']));
        },
        async deleteNode(id) {
            dispatched.push(`node.delete:${id}`);
            nodes.delete(id);
        },
        async addEdge(payload) {
            dispatched.push(`edge.upsert:${edgeKey(payload as never)}`);
            edges.add(edgeKey(payload as never));
        },
        async deleteEdge(payload) {
            dispatched.push(`edge.delete:${edgeKey(payload)}`);
            edges.delete(edgeKey(payload));
        },
        // Deliberately NO upsertVerbatimBatch: with it unwired, the replicator
        // takes the per-row replicateOne path (where the supersession guard
        // lives) regardless of run length, so V-* exercise the guard directly.
        async upsertVerbatim(payload) {
            const id = String(payload['id']);
            dispatched.push(`verbatim.upsert:${id}`);
            verbatim.set(id, String(payload['text']));
        },
    };
    const replicator = new OutboxReplicator({
        store, substrates,
        // grace/prune cadence irrelevant here — we drive tickOnce directly.
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 },
        log: () => undefined,
    });
    return { dispatched, nodes, edges, verbatim, replicator };
}

/** Force a recorded row to `status='failed'` with a PAST nextAttemptAt so
 *  the next tick considers it retryable, mirroring an expired backoff. */
async function markFailedRetryable(store: SqliteOutboxStore, id: string): Promise<void> {
    await store.markEntryStatus(id, 'failed', { error: 'injected transient failure', bumpAttempt: true });
    // markEntryStatus sets nextAttemptAt in the FUTURE (backoff). Rewrite it
    // to the past so listPendingForWorkspace will return the row this tick.
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
        .db.prepare(`UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?`)
        .run('2000-01-01T00:00:00.000Z', id);
}

/** Directly plant a 'replicated' row (models a later op the replicator
 *  already durably applied). Sequence + payload set explicitly. */
async function plantReplicated(
    store: SqliteOutboxStore,
    e: Partial<OutboxEntry> & { id: string; workspace: string; operationKind: OutboxEntry['operationKind']; sequenceId: number },
): Promise<void> {
    await store.record(baseEntry(e));
    await store.markEntryStatus(e.id, 'replicated');
}

console.log('Cross-kind outbox supersession (durability regression)');

// ── keyOfEntry unit coverage (derivation must be consistent per family) ──

test('keyOfEntry: node.upsert and node.delete on same id → equal key/family', () => {
    const up = keyOfEntry(baseEntry({ id: 'a', operationKind: 'node.upsert', workspace: 'w', payload: { id: 'X' } }));
    const del = keyOfEntry(baseEntry({ id: 'b', operationKind: 'node.delete', workspace: 'w', payload: { id: 'X' } }));
    assert.deepEqual(up, { family: 'node', key: 'X' });
    assert.deepEqual(del, { family: 'node', key: 'X' });
});

test('keyOfEntry: edge.upsert and edge.delete on same triple → equal key/family', () => {
    const up = keyOfEntry(baseEntry({ id: 'a', operationKind: 'edge.upsert', workspace: 'w', payload: { sourceId: 'S', targetId: 'T', relation: 'R', confidence: 'extracted' } }));
    const del = keyOfEntry(baseEntry({ id: 'b', operationKind: 'edge.delete', workspace: 'w', payload: { sourceId: 'S', targetId: 'T', relation: 'R' } }));
    assert.ok(up && del);
    assert.equal(up!.family, 'edge');
    assert.equal(del!.family, 'edge');
    assert.equal(up!.key, del!.key, 'edge upsert/delete on same identity must derive the SAME key');
});

test('keyOfEntry: verbatim.upsert keyed on payload.id in its OWN family (regression: c79e505 dropped it)', () => {
    // Restored behavior: verbatim.upsert derives key = payload.id (`lore:<id>`)
    // like node, but family='verbatim' so it never cross-supersedes a node op.
    const v = keyOfEntry(baseEntry({ id: 'a', operationKind: 'verbatim.upsert', workspace: 'w', payload: { id: 'lore:V' } }));
    assert.deepEqual(v, { family: 'verbatim', key: 'lore:V' });
    // Same key STRING as a node op, but a disjoint family (must not collide).
    const n = keyOfEntry(baseEntry({ id: 'b', operationKind: 'node.upsert', workspace: 'w', payload: { id: 'lore:V' } }));
    assert.deepEqual(n, { family: 'node', key: 'lore:V' });
    assert.notEqual(v!.family, n!.family, 'verbatim and node share the id space but must be different families');
});

test('keyOfEntry: genuinely keyless kinds return null (no guard) — matches pre-fix', () => {
    // These carried no payload.id pre-c79e505 either, so they correctly have
    // no supersession identity. Guards against a future kind silently losing
    // (or wrongly gaining) supersession.
    const nullKinds: Array<[OutboxEntry['operationKind'], Record<string, unknown>]> = [
        ['verbatim.upsert.batch', { items: [{ id: 'lore:V' }] }],
        ['sync.vector.mirror', { nodeIds: ['n1'] }],
        ['embed.batch', { texts: ['t'], targetNodeIds: ['n1'] }],
        ['embed.done', {}],
        ['load.received', { jobId: 'j1' }],
        ['load.done', { jobId: 'j1' }],
        ['migration.started', { migrationId: 'm1' }],
        ['migration.applied', { migrationId: 'm1' }],
        ['migration.failed', { migrationId: 'm1' }],
        ['stream.event', { streamEventId: 's1' }],
    ];
    for (const [kind, payload] of nullKinds) {
        assert.equal(
            keyOfEntry(baseEntry({ id: 'k', operationKind: kind, workspace: 'w', payload })),
            null,
            `${kind} must have no supersession identity (payload carries no id)`,
        );
    }
    // Missing/blank required identity fields still fall through to null.
    assert.equal(keyOfEntry(baseEntry({ id: 'b', operationKind: 'node.upsert', workspace: 'w', payload: {} })), null);
    assert.equal(keyOfEntry(baseEntry({ id: 'c', operationKind: 'verbatim.upsert', workspace: 'w', payload: {} })), null);
});

// ── R1: reported case — replicated node.delete supersedes failed node.upsert ──

test('R1 replicated node.delete supersedes failed node.upsert (same id) → upsert NOT re-dispatched, node stays deleted', async () => {
    const store = newStore();
    const ws = 'ws1';
    const { dispatched, nodes, replicator } = makeHarness(store);

    // seq=1: the failed node.upsert(X) (transient dispatch failure earlier).
    await store.record(baseEntry({ id: 'up1', operationKind: 'node.upsert', workspace: ws, payload: { id: 'X' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'up1');
    // (X was written directly during the original hot write, then deleted below.)

    // seq=3: node.delete(X) already durably replicated (X is gone).
    await plantReplicated(store, { id: 'del3', operationKind: 'node.delete', workspace: ws, payload: { id: 'X' }, sequenceId: 3 });

    // Retry tick: the failed upsert must be SUPERSEDED (skipped, marked dead).
    await replicator.tickOnce();

    assert.equal(dispatched.filter(d => d === 'node.upsert:X').length, 0,
        `the superseded upsert must NOT be re-dispatched; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(nodes.has('X'), false, 'X must stay deleted (no resurrection)');
    const row = await getRow(store, 'up1');
    assert.equal(row?.status, 'dead', `superseded row must be marked dead, got '${row?.status}'`);
});

// ── R2: inverse — replicated node.upsert supersedes failed node.delete ──

test('R2 replicated node.upsert supersedes failed node.delete (same id) → delete NOT re-dispatched, node stays live', async () => {
    const store = newStore();
    const ws = 'ws2';
    const { dispatched, nodes, replicator } = makeHarness(store);
    nodes.add('Y'); // Y is currently live (re-created by the newer upsert).

    await store.record(baseEntry({ id: 'del1', operationKind: 'node.delete', workspace: ws, payload: { id: 'Y' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'del1');
    await plantReplicated(store, { id: 'up3', operationKind: 'node.upsert', workspace: ws, payload: { id: 'Y' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.filter(d => d === 'node.delete:Y').length, 0,
        `the superseded delete must NOT be re-dispatched; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(nodes.has('Y'), true, 'Y must stay live (a stale delete must not wipe the re-created node)');
    const row = await getRow(store, 'del1');
    assert.equal(row?.status, 'dead');
});

// ── E1 / E2: edge family, both directions ──

test('E1 replicated edge.delete supersedes failed edge.upsert (same triple) → upsert NOT re-dispatched', async () => {
    const store = newStore();
    const ws = 'ws3';
    const { dispatched, edges, replicator } = makeHarness(store);

    await store.record(baseEntry({ id: 'eup1', operationKind: 'edge.upsert', workspace: ws, payload: { sourceId: 'S', targetId: 'T', relation: 'R', confidence: 'extracted' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'eup1');
    await plantReplicated(store, { id: 'edel3', operationKind: 'edge.delete', workspace: ws, payload: { sourceId: 'S', targetId: 'T', relation: 'R' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.filter(d => d.startsWith('edge.upsert:')).length, 0,
        `the superseded edge.upsert must NOT be re-dispatched; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(edges.has('S|T|R'), false, 'edge must stay deleted');
    assert.equal((await getRow(store, 'eup1'))?.status, 'dead');
});

test('E2 replicated edge.upsert supersedes failed edge.delete (same triple) → delete NOT re-dispatched', async () => {
    const store = newStore();
    const ws = 'ws4';
    const { dispatched, edges, replicator } = makeHarness(store);
    edges.add('S|T|R'); // edge currently live (re-created by newer upsert).

    await store.record(baseEntry({ id: 'edel1', operationKind: 'edge.delete', workspace: ws, payload: { sourceId: 'S', targetId: 'T', relation: 'R' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'edel1');
    await plantReplicated(store, { id: 'eup3', operationKind: 'edge.upsert', workspace: ws, payload: { sourceId: 'S', targetId: 'T', relation: 'R', confidence: 'extracted' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.filter(d => d.startsWith('edge.delete:')).length, 0,
        `the superseded edge.delete must NOT be re-dispatched; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(edges.has('S|T|R'), true, 'edge must stay live');
    assert.equal((await getRow(store, 'edel1'))?.status, 'dead');
});

// ── N1: NEGATIVE — different key is NOT superseded (no over-broad match) ──

test('N1 failed node.upsert(K) is NOT superseded by a replicated node.delete on a DIFFERENT key K2 → it retries', async () => {
    const store = newStore();
    const ws = 'ws5';
    const { dispatched, nodes, replicator } = makeHarness(store);

    await store.record(baseEntry({ id: 'up1', operationKind: 'node.upsert', workspace: ws, payload: { id: 'K' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'up1');
    // A newer replicated delete, but on a DIFFERENT entity K2.
    await plantReplicated(store, { id: 'del3', operationKind: 'node.delete', workspace: ws, payload: { id: 'K2' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.includes('node.upsert:K'), true,
        `un-superseded failed upsert(K) must retry (dispatch); dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(nodes.has('K'), true, 'K must be applied by the legitimate retry');
    assert.equal((await getRow(store, 'up1'))?.status, 'replicated', 'the retried row succeeds');
});

// ── N2: NEGATIVE — node op NOT superseded by an edge op (family scoping) ──

test('N2 failed node op is NOT superseded by a replicated edge op even with a colliding key → it retries', async () => {
    const store = newStore();
    const ws = 'ws6';
    const { dispatched, nodes, replicator } = makeHarness(store);

    // Failed node.upsert keyed on id='S T R' — chosen to (potentially) collide
    // with the edge composite of the edge planted below. Family scoping MUST
    // prevent the edge from superseding the node.
    await store.record(baseEntry({ id: 'up1', operationKind: 'node.upsert', workspace: ws, payload: { id: 'S T R' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'up1');
    await plantReplicated(store, { id: 'eup3', operationKind: 'edge.upsert', workspace: ws, payload: { sourceId: 'S', targetId: 'T', relation: 'R', confidence: 'extracted' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.includes('node.upsert:S T R'), true,
        `node op must NOT be superseded by an edge op; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(nodes.has('S T R'), true);
    assert.equal((await getRow(store, 'up1'))?.status, 'replicated');
});

// ── V-SAME: regression — replicated verbatim.upsert supersedes failed one ──

test('V-SAME replicated verbatim.upsert supersedes failed verbatim.upsert (same id) → failed NOT re-dispatched, content stays newer text', async () => {
    const store = newStore();
    const ws = 'wsV';
    const { dispatched, verbatim, replicator } = makeHarness(store);
    // The newer replicated write already set the durable content to newText.
    verbatim.set('lore:X', 'newText');

    // seq=1: an OLDER verbatim.upsert(lore:X, oldText) that failed transiently.
    await store.record(baseEntry({ id: 'vup1', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:X', text: 'oldText' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'vup1');
    // seq=3: the NEWER verbatim.upsert(lore:X, newText) already durably replicated.
    await plantReplicated(store, { id: 'vup3', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:X', text: 'newText' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.filter(d => d === 'verbatim.upsert:lore:X').length, 0,
        `the superseded verbatim.upsert must NOT be re-dispatched; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(verbatim.get('lore:X'), 'newText',
        'stored content must stay the newer text (a stale re-dispatch would revert it to oldText)');
    assert.equal((await getRow(store, 'vup1'))?.status, 'dead', 'superseded verbatim row must be marked dead');
});

// ── V-CONSOLIDATION: regression — the SP-13 consolidation fast path must ALSO
//    apply the RA-6 guard. A stale failed row consolidated into a batch used to
//    overwrite newer committed verbatim content (the guard lived only in
//    replicateOne, which the consolidated dispatch never reached). ──

test('V-CONSOLIDATION a superseded failed verbatim.upsert is dropped from the consolidated batch (no stale overwrite)', async () => {
    const store = newStore();
    const ws = 'wsVC';
    const dispatched: string[] = [];
    const verbatim = new Map<string, string>();
    const batchItems: Array<Array<Record<string, unknown>>> = [];
    const substrates: DispatcherSubstrates = {
        async upsertNode(payload) { dispatched.push(`node.upsert:${String(payload['id'])}`); },
        async deleteNode(id) { dispatched.push(`node.delete:${id}`); },
        async addEdge(payload) { dispatched.push('edge.upsert'); },
        async deleteEdge(payload) { dispatched.push('edge.delete'); },
        async upsertVerbatim(payload) {
            const id = String(payload['id']);
            dispatched.push(`verbatim.upsert:${id}`);
            verbatim.set(id, String(payload['text']));
        },
        // Wired so the SP-13 consolidation path (NOT replicateOne) is taken.
        async upsertVerbatimBatch(payload) {
            batchItems.push(payload.items);
            for (const it of payload.items) {
                const id = String(it['id']);
                dispatched.push(`verbatim.upsert.batch:${id}`);
                verbatim.set(id, String(it['text']));
            }
        },
    };
    const replicator = new OutboxReplicator({
        store, substrates,
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0 },
        log: () => undefined,
    });
    // Durable state already holds the newer content for lore:X.
    verbatim.set('lore:X', 'newText');

    // seq=1: stale failed verbatim.upsert(lore:X, oldText).
    await store.record(baseEntry({ id: 'vup1', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:X', text: 'oldText' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'vup1');
    // seq=2: adjacent verbatim.upsert(lore:Y) — makes a 2-row consolidation run.
    await store.record(baseEntry({ id: 'vup2', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:Y', text: 'textY' }, sequenceId: 2 }));
    // seq=3: the newer replicated write on lore:X (supersedes seq=1).
    await plantReplicated(store, { id: 'vup3', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:X', text: 'newText' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(verbatim.get('lore:X'), 'newText',
        `stale failed row must NOT overwrite newer content; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(dispatched.includes('verbatim.upsert.batch:lore:X'), false,
        'superseded lore:X must be excluded from the consolidated batch');
    assert.equal((await getRow(store, 'vup1'))?.status, 'dead', 'superseded row marked dead');
    assert.equal((await getRow(store, 'vup2'))?.status, 'replicated', 'survivor row still applied');
});


// ── VN-ID: NEGATIVE — different verbatim id is NOT superseded ──

test('VN-ID failed verbatim.upsert(lore:A) is NOT superseded by a replicated verbatim.upsert on a DIFFERENT id → it retries', async () => {
    const store = newStore();
    const ws = 'wsVN1';
    const { dispatched, verbatim, replicator } = makeHarness(store);

    await store.record(baseEntry({ id: 'vup1', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:A', text: 'textA' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'vup1');
    // Newer replicated verbatim.upsert, but on a DIFFERENT id lore:B.
    await plantReplicated(store, { id: 'vup3', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:B', text: 'textB' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.includes('verbatim.upsert:lore:A'), true,
        `un-superseded failed verbatim.upsert(lore:A) must retry; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(verbatim.get('lore:A'), 'textA', 'the legitimate retry writes its content');
    assert.equal((await getRow(store, 'vup1'))?.status, 'replicated');
});

// ── VN-FAM: NEGATIVE — a node op does NOT supersede a verbatim op (family) ──

test('VN-FAM failed verbatim.upsert is NOT superseded by a node.* op sharing the exact key string → it retries', async () => {
    const store = newStore();
    const ws = 'wsVN2';
    const { dispatched, verbatim, replicator } = makeHarness(store);

    // Failed verbatim.upsert keyed on id='lore:C'.
    await store.record(baseEntry({ id: 'vup1', operationKind: 'verbatim.upsert', workspace: ws, payload: { id: 'lore:C', text: 'textC' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'vup1');
    // Newer replicated node op sharing the EXACT key string 'lore:C'. Verbatim
    // is its own family, so this must NOT supersede the verbatim row.
    await plantReplicated(store, { id: 'ndel3', operationKind: 'node.delete', workspace: ws, payload: { id: 'lore:C' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.includes('verbatim.upsert:lore:C'), true,
        `verbatim op must NOT be superseded by a node op on a colliding key; dispatched=${JSON.stringify(dispatched)}`);
    assert.equal(verbatim.get('lore:C'), 'textC');
    assert.equal((await getRow(store, 'vup1'))?.status, 'replicated');
});

// ── S1: SUBSET — original RA-6 same-kind supersession still holds ──

test('S1 (RA-6 subset) replicated node.upsert supersedes failed node.upsert on same id', async () => {
    const store = newStore();
    const ws = 'ws7';
    const { dispatched, replicator } = makeHarness(store);

    await store.record(baseEntry({ id: 'up1', operationKind: 'node.upsert', workspace: ws, payload: { id: 'Z' }, sequenceId: 1 }));
    await markFailedRetryable(store, 'up1');
    await plantReplicated(store, { id: 'up3', operationKind: 'node.upsert', workspace: ws, payload: { id: 'Z' }, sequenceId: 3 });

    await replicator.tickOnce();

    assert.equal(dispatched.filter(d => d === 'node.upsert:Z').length, 0,
        'a newer replicated same-kind upsert must still supersede (RA-6 subset preserved)');
    assert.equal((await getRow(store, 'up1'))?.status, 'dead');
});

/** Read a raw status snapshot for one entry id. */
async function getRow(store: SqliteOutboxStore, id: string): Promise<{ status: OutboxStatus } | undefined> {
    const r = (store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } })
        .db.prepare(`SELECT status FROM outbox_entries WHERE id = ?`).get(id) as { status: OutboxStatus } | undefined;
    return r;
}

await Promise.all(pending);
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
