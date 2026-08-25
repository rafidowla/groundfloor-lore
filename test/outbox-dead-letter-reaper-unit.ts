#!/usr/bin/env tsx
/**
 * outbox-dead-letter-reaper-unit.ts — half-completion reaper (2026-06-09).
 *
 * The hot lane writes verbatim BEFORE the durable graph-upsert attempt
 * for `node.upsert` ops. If the graph upsert exhausts its retry budget
 * and the entry goes dead-letter, the verbatim row written by the hot
 * lane is left stranded — a true orphan (vector with no graph node
 * anywhere). The reaper hooks `physicalDeleteVerbatim` at dead-letter
 * time so the stranded row is removed.
 *
 * Pins:
 *   R1: node.upsert dead-letter triggers physicalDeleteVerbatim(lore:<id>)
 *   R2: edge.upsert dead-letter does NOT trigger the reaper (no half-completion)
 *   R3: missing physicalDeleteVerbatim substrate is graceful (no throw)
 *   R4: failure inside the reaper is non-fatal — the entry still gets marked dead
 *   R5: id payload already prefixed `lore:` is not double-prefixed
 */

import assert from 'node:assert/strict';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type {
    OutboxEntry,
    OutboxReplicationState,
    OutboxStatus,
    OutboxStore,
} from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function it(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
}

console.log('outbox dead-letter reaper (2026-06-09)');

interface FakeStore extends Partial<OutboxStore> {
    entries: OutboxEntry[];
    statusEvents: Array<{ id: string; status: OutboxStatus }>;
}

function makeFakeStore(initial: OutboxEntry[] = []): FakeStore {
    const entries: OutboxEntry[] = [...initial];
    const statusEvents: Array<{ id: string; status: OutboxStatus }> = [];
    const replState = new Map<string, OutboxReplicationState>();
    const store: FakeStore = {
        entries,
        statusEvents,
        async record(e: OutboxEntry) { entries.push(e); },
        async batchRecord(es: OutboxEntry[]) { for (const e of es) entries.push(e); },
        async markStep() { /* unused */ },
        async markCompleted() { /* unused */ },
        async remove() { /* unused */ },
        async listUnfinished() { return entries.filter((e) => !e.completed); },
        async listWorkspacesWithPending() {
            const out = new Set<string>();
            for (const e of entries) if ((e.status === 'pending' || e.status === 'failed') && e.workspace) out.add(e.workspace);
            return [...out];
        },
        async listPendingForWorkspace(workspace: string, limit: number) {
            return entries
                .filter((e) => e.workspace === workspace && (e.status === 'pending' || e.status === 'failed'))
                .sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0))
                .slice(0, limit);
        },
        async markEntryStatus(entryId: string, status: OutboxStatus) {
            statusEvents.push({ id: entryId, status });
            const row = entries.find((e) => e.id === entryId);
            if (row) row.status = status;
        },
        async readReplicationState(_workspace: string) {
            return replState.get(_workspace) ?? { lastReplicatedSeq: 0, updatedAt: new Date().toISOString() };
        },
        async writeReplicationState(_workspace: string, state: OutboxReplicationState) { replState.set(_workspace, state); },
    };
    return store;
}

function nodeUpsertEntry(id: string, workspace: string, payloadId: string): OutboxEntry {
    return {
        id,
        operation: 'node.upsert',
        initiator: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [{ kind: 'node.upsert', status: 'pending' }],
        completed: false,
        workspace,
        sequenceId: 1,
        operationKind: 'node.upsert',
        payload: { id: payloadId, type: 'decision', label: 'L' },
        status: 'pending',
        attempts: 0,
    };
}

function edgeUpsertEntry(id: string, workspace: string): OutboxEntry {
    return {
        id,
        operation: 'edge.upsert',
        initiator: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [{ kind: 'edge.upsert', status: 'pending' }],
        completed: false,
        workspace,
        sequenceId: 1,
        operationKind: 'edge.upsert',
        payload: { sourceId: 'a', targetId: 'b', relation: 'mentions' },
        status: 'pending',
        attempts: 0,
    };
}

it('R1 — node.upsert dead-letter triggers physicalDeleteVerbatim with lore:<id>', async () => {
    const reaped: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('simulated graph upsert failure'); },
        physicalDeleteVerbatim: async (id: string) => { reaped.push(id); },
    };
    const entry = nodeUpsertEntry('e1', 'wsR', 'half-completed');
    const store = makeFakeStore([entry]);
    // maxAttempts=1 → first failure goes straight to dead.
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce();
    assert.deepEqual(store.statusEvents.filter((e) => e.id === 'e1' && e.status === 'dead').map((e) => e.id), ['e1'], 'entry marked dead');
    assert.deepEqual(reaped, ['lore:half-completed'], 'reaper called with lore-prefixed id');
});

it('R2 — edge.upsert dead-letter does NOT trigger the reaper', async () => {
    const reaped: string[] = [];
    const substrates: DispatcherSubstrates = {
        addEdge: async () => { throw new Error('simulated edge upsert failure'); },
        physicalDeleteVerbatim: async (id: string) => { reaped.push(id); },
    };
    const entry = edgeUpsertEntry('e2', 'wsR');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce();
    assert.ok(store.statusEvents.some((e) => e.id === 'e2' && e.status === 'dead'), 'edge entry marked dead');
    assert.deepEqual(reaped, [], 'edge dead-letter does not reap verbatim');
});

it('R3 — missing physicalDeleteVerbatim substrate is graceful (no throw)', async () => {
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('graph upsert failed'); },
        // No physicalDeleteVerbatim wired (older daemon / minimal test).
    };
    const entry = nodeUpsertEntry('e3', 'wsR', 'no-reaper');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce(); // must not throw
    assert.ok(store.statusEvents.some((e) => e.id === 'e3' && e.status === 'dead'), 'entry still dead-letters cleanly');
});

it('R4 — reaper failure is non-fatal; entry still goes dead', async () => {
    const reapCalls: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('graph upsert failed'); },
        physicalDeleteVerbatim: async (id: string) => { reapCalls.push(id); throw new Error('reap blew up'); },
    };
    const entry = nodeUpsertEntry('e4', 'wsR', 'reaper-fails');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce(); // must not throw
    assert.deepEqual(reapCalls, ['lore:reaper-fails'], 'reaper was attempted');
    assert.ok(store.statusEvents.some((e) => e.id === 'e4' && e.status === 'dead'), 'dead-letter transition completes despite reap failure');
});

it('R5 — payload id already lore-prefixed is not double-prefixed', async () => {
    const reaped: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('graph upsert failed'); },
        physicalDeleteVerbatim: async (id: string) => { reaped.push(id); },
    };
    const entry = nodeUpsertEntry('e5', 'wsR', 'lore:already-prefixed');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce();
    assert.deepEqual(reaped, ['lore:already-prefixed'], 'reaper sees a single lore: prefix');
});

it('R6 — reaper routes physicalDeleteVerbatim to the ENTRY workspace, not boot (audit 2026-06-25)', async () => {
    const reaped: Array<{ id: string; workspace?: string }> = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('graph upsert failed'); },
        physicalDeleteVerbatim: async (id: string, workspace?: string) => { reaped.push({ id, workspace }); },
    };
    // Entry belongs to a NON-boot workspace; the orphan vector lives there.
    const entry = nodeUpsertEntry('e6', 'tenant-b', 'orphan-vec');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce();
    assert.deepEqual(
        reaped,
        [{ id: 'lore:orphan-vec', workspace: 'tenant-b' }],
        'reap must target the entry workspace (else it hits the boot LanceDB: orphan survives or a boot-ws vector is wrongly deleted)',
    );
});

it('R7 — reaper SKIPS the delete when the node is live (re-upserted during the retry window) (audit 2026-06-25)', async () => {
    const reaped: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('graph upsert failed'); },
        physicalDeleteVerbatim: async (id: string) => { reaped.push(id); },
        hasNode: async () => true, // node is live (a re-upsert landed during the window)
    };
    const entry = nodeUpsertEntry('e7', 'wsR', 'live-node');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce();
    assert.ok(store.statusEvents.some((e) => e.id === 'e7' && e.status === 'dead'), 'entry still dead-letters');
    assert.deepEqual(reaped, [], "a live node's vector must NOT be reaped");
});

it('R8 — reaper DELETES when the node is absent (true orphan)', async () => {
    const reaped: string[] = [];
    const substrates: DispatcherSubstrates = {
        upsertNode: async () => { throw new Error('graph upsert failed'); },
        physicalDeleteVerbatim: async (id: string) => { reaped.push(id); },
        hasNode: async () => false, // node absent → genuine orphan
    };
    const entry = nodeUpsertEntry('e8', 'wsR', 'orphan-node');
    const store = makeFakeStore([entry]);
    const r = new OutboxReplicator({ store: store as OutboxStore, substrates, config: { maxAttempts: 1 }, log: () => undefined });
    await r.tickOnce();
    assert.deepEqual(reaped, ['lore:orphan-node'], 'a true orphan vector is reaped');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
