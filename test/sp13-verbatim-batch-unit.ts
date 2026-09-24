#!/usr/bin/env tsx
/**
 * sp13-verbatim-batch-unit.ts — SP-13 regression.
 *
 * Two fixes:
 *
 *   A. Outbox replicator now consolidates a run of adjacent verbatim.upsert
 *      rows into ONE verbatim.upsert.batch dispatch → one storeBatch call →
 *      one LanceDB fragment for the whole run (was: one fragment per row;
 *      5,334 fragments / ~5k rows observed in the field). The number of
 *      batch dispatches (a proxy for LanceDB .add() commits / fragments) is
 *      asserted to be < rows/10.
 *
 *   B. VerbatimStore.store() short-circuits to a no-op when the live
 *      canonical row already carries the same contentHash — no
 *      snapshot+delete+add, no new fragment, for an unchanged write.
 *
 * Test A uses the E3-style in-memory outbox store + recording substrate
 * (no LanceDB). Test B exercises a real VerbatimStore against a temp dir.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/sp13-verbatim-batch-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { OutboxReplicator, VERBATIM_UPSERT_CONSOLIDATION_CAP }
    from '../packages/lore/src/outbox/replicator.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type {
    OutboxEntry, OutboxStore, OutboxStatus, OutboxReplicationState,
} from '../packages/lore/src/outbox/types.js';
// Opus review follow-up (item: excluded suites testing SEMANTICS, not Lance
// internals). Test B below exercises VerbatimStoreApi.store()'s
// skip-identical contract — routed through makeVerbatimStore so it runs
// against both engines. Test A (outbox replicator consolidation) never
// constructs a VerbatimStore at all — a fake in-memory substrate stands in
// for it — so it stays engine-independent and unchanged.
import { makeVerbatimStore, testVectorEngine } from './helpers/testVerbatimStore.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp13-lore-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['SP13_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

interface FakeStore extends Partial<OutboxStore> {
    entries: OutboxEntry[];
    statusEvents: Array<{ id: string; status: OutboxStatus }>;
}
function makeFakeStore(initial: OutboxEntry[] = []): FakeStore {
    const entries: OutboxEntry[] = [...initial];
    const statusEvents: Array<{ id: string; status: OutboxStatus }> = [];
    const replState = new Map<string, OutboxReplicationState>();
    return {
        entries, statusEvents,
        async record(e: OutboxEntry) { entries.push(e); },
        async markStep() { /* unused */ },
        async markCompleted() { /* unused */ },
        async remove() { /* unused */ },
        async listUnfinished() { return entries.filter((e) => !e.completed); },
        async listWorkspacesWithPending() {
            const out = new Set<string>();
            for (const e of entries) {
                if ((e.status === 'pending' || e.status === 'failed') && e.workspace) out.add(e.workspace);
            }
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
        async readReplicationState(workspace: string) {
            return replState.get(workspace) ?? { lastReplicatedSeq: 0, updatedAt: new Date().toISOString() };
        },
        async writeReplicationState(workspace: string, state: OutboxReplicationState) {
            replState.set(workspace, state);
        },
    };
}

function verbatimEntry(id: string, workspace: string, seq: number): OutboxEntry {
    return {
        id, operation: 'verbatim.upsert', initiator: 'test',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        steps: [], completed: false, workspace, sequenceId: seq,
        operationKind: 'verbatim.upsert',
        payload: { id: `lore:${id}`, text: `text-${id}`, metadata: {} },
        status: 'pending', attempts: 0,
    };
}

(async () => {
    console.log('SP-13 — verbatim write amplification: batched consolidation + skip-identical');

    /* ── A. Replicator consolidates 100 verbatim.upsert rows ───────── */
    await test('A1 — 100 verbatim.upsert rows → far fewer batch dispatches (< rows/10)', async () => {
        const N = 100;
        const rows = Array.from({ length: N }, (_, i) => verbatimEntry(`v${i}`, 'wsA', i + 1));
        const store = makeFakeStore(rows);

        // Recording substrate. perRowCalls = how many single-row store()
        // dispatches happened (one fragment each, pre-SP-13). batchCalls =
        // how many storeBatch dispatches (one fragment each, post-SP-13).
        let perRowCalls = 0;
        let batchCalls = 0;
        let docsViaBatch = 0;
        const substrates: DispatcherSubstrates = {
            async upsertVerbatim() { perRowCalls++; },
            async upsertVerbatimBatch(payload: { items: Array<Record<string, unknown>> }) {
                batchCalls++; docsViaBatch += payload.items.length;
            },
        } as unknown as DispatcherSubstrates;

        const replicator = new OutboxReplicator({
            store: store as OutboxStore, substrates, log: () => undefined,
        });
        const processed = await replicator.tickOnce();

        assert.equal(processed, N, `all ${N} rows processed (got ${processed})`);
        // "fragments after batching" is the number of LanceDB .add() commits,
        // proxied by the count of batch dispatches.
        const fragmentsAfter = batchCalls;
        const fragmentsBeforeBatching = N; // pre-SP-13: one per-row store()
        assert.ok(perRowCalls === 0, `no per-row dispatch when batch hook wired (got ${perRowCalls})`);
        assert.ok(docsViaBatch === N, `every doc routed through storeBatch (got ${docsViaBatch})`);
        assert.ok(fragmentsAfter < fragmentsBeforeBatching / 10,
            `fragmentsAfter (${fragmentsAfter}) must be < ${fragmentsBeforeBatching / 10}`);
        // With cap 256 and 100 rows, the whole run consolidates into 1.
        assert.equal(fragmentsAfter, 1, `100 rows ≤ cap → 1 batch (got ${fragmentsAfter})`);
        const replicated = store.statusEvents.filter((s) => s.status === 'replicated');
        assert.equal(replicated.length, N, `all ${N} rows marked replicated`);
    });

    await test('A2 — consolidation respects VERBATIM_UPSERT_CONSOLIDATION_CAP', async () => {
        // 600 rows, cap 256 → 3 runs (256 + 256 + 88).
        const N = 600;
        const rows = Array.from({ length: N }, (_, i) => verbatimEntry(`c${i}`, 'wsB', i + 1));
        const store = makeFakeStore(rows);
        let batchCalls = 0;
        const sizes: number[] = [];
        const substrates: DispatcherSubstrates = {
            async upsertVerbatim() { /* per-row fallback */ },
            async upsertVerbatimBatch(payload: { items: Array<Record<string, unknown>> }) {
                batchCalls++; sizes.push(payload.items.length);
            },
        } as unknown as DispatcherSubstrates;
        const replicator = new OutboxReplicator({
            store: store as OutboxStore, substrates, log: () => undefined,
            // Raise the per-tick fetch cap above N so the whole set is
            // considered in one tick and the consolidation cap (not the
            // fetch cap) is what splits the runs.
            config: { batchSize: N },
        });
        await replicator.tickOnce();
        assert.equal(batchCalls, Math.ceil(N / VERBATIM_UPSERT_CONSOLIDATION_CAP),
            `expected ceil(${N}/${VERBATIM_UPSERT_CONSOLIDATION_CAP}) runs (got ${batchCalls}: ${sizes.join(',')})`);
        assert.equal(sizes.reduce((a, b) => a + b, 0), N, 'every row accounted for');
        for (const s of sizes) assert.ok(s <= VERBATIM_UPSERT_CONSOLIDATION_CAP, `run ${s} ≤ cap`);
    });

    await test('A3 — without the batch hook, per-row dispatch still works (back-compat)', async () => {
        const rows = Array.from({ length: 5 }, (_, i) => verbatimEntry(`p${i}`, 'wsC', i + 1));
        const store = makeFakeStore(rows);
        let perRowCalls = 0;
        const substrates: DispatcherSubstrates = {
            async upsertVerbatim() { perRowCalls++; },
            // no upsertVerbatimBatch → consolidation is skipped
        } as unknown as DispatcherSubstrates;
        const replicator = new OutboxReplicator({
            store: store as OutboxStore, substrates, log: () => undefined,
        });
        const processed = await replicator.tickOnce();
        assert.equal(processed, 5, 'all rows processed via per-row path');
        assert.equal(perRowCalls, 5, 'each row dispatched individually');
    });

    /* ── B. VerbatimStore.store() skip-identical ───────────────────── */
    await test('B1 — re-storing identical content is a no-op (no rewrite)', async () => {
        const store = makeVerbatimStore(path.join(TEST_HOME, 'ws-b'));
        await store.initialize();
        try {
            const doc = { id: 'lore:n1', text: 'stable content', metadata: {} };
            await store.store(doc);
            const after1 = await store.getById('lore:n1');
            assert.ok(after1?.contentHash, 'first store sets a contentHash');
            const hash1 = after1!.contentHash;

            // Re-store the SAME content. Should short-circuit — no new row,
            // same contentHash, and (critically) no rev-snapshot created.
            await store.store(doc);
            const after2 = await store.getById('lore:n1');
            assert.equal(after2?.contentHash, hash1, 'contentHash unchanged after identical re-store');

            // "No snapshot was created" is probed differently per engine:
            // Lance encodes history via an `<id>#rev<ts>` id-suffix (see
            // verbatimHistory.ts) — listIds() is canonical-only BY DEFAULT
            // now (Opus review follow-up: it used to leak `#rev` snapshot
            // ids), so `includeHistory: true` is the explicit escape hatch
            // needed to keep counting snapshot rows via a `#rev`-prefix
            // search. SQLite tracks history via a real `is_canonical`
            // column instead — snapshots share the CANONICAL id, so a
            // `#rev`-suffix prefix search can never find them there; the
            // engine-native probe is getHistory()'s row count.
            if (testVectorEngine() === 'sqlite') {
                const hist = await store.getHistory('lore:n1');
                assert.equal(hist.length, 1, 'no rev-snapshot created for an unchanged re-store (sqlite: getHistory row count)');
            } else {
                const revs = await store.listIds('lore:n1#rev', { includeHistory: true });
                assert.equal(revs.length, 0, 'no rev-snapshot created for an unchanged re-store (lance: #rev id-suffix count)');
            }

            // Changing the content DOES rewrite (and snapshots the prior rev).
            await store.store({ id: 'lore:n1', text: 'changed content', metadata: {} });
            const after3 = await store.getById('lore:n1');
            assert.notEqual(after3?.contentHash, hash1, 'contentHash changes when text changes');
            if (testVectorEngine() === 'sqlite') {
                const hist2 = await store.getHistory('lore:n1');
                assert.ok(hist2.length >= 2, 'a rev-snapshot is created on a real change (sqlite: getHistory row count)');
            } else {
                const revs2 = await store.listIds('lore:n1#rev', { includeHistory: true });
                assert.ok(revs2.length >= 1, 'a rev-snapshot is created on a real change (lance: #rev id-suffix count)');
            }
        } finally {
            await store.close();
        }
    });

    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
