#!/usr/bin/env tsx
/**
 * audit-5b-outbox-dead-sweep-unit.ts — regression for the Cluster-5 medium
 * finding (2026-08-17 functional-correctness audit):
 *
 *   listFailedOlderThan returned status='dead' rows on EVERY routine
 *   self-heal sweep, not just the operator drain path its own comment
 *   described — so the replicator's per-tick maybeSelfHeal swept
 *   dead-letter rows back to 'replicated' whenever the substrate probe
 *   verified, and the dead-letter queue silently self-emptied.
 *
 * Fix: listFailedOlderThan / runSelfHealSweep take `includeDead` (default
 * false); only the drain-failed CLI passes includeDead: true.
 *
 * Exercises the REAL production entry points: SqliteOutboxStore +
 * OutboxReplicator.runSelfHealSweep.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/audit-5b-outbox-dead-sweep-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit5b-outbox-'));
process.env['LORE_HOME'] = TEST_HOME;

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('Audit cluster 5 — routine self-heal must not drain the dead-letter queue');

await test('routine sweep recovers failed rows but leaves dead rows dead; operator opt-in sweeps dead', async () => {
    const store = new SqliteOutboxStore(path.join(TEST_HOME, 'ws'));
    // Identity-only payloads → existence probe is a sound witness.
    const failedEntry = await recordHotWrite(store, {
        workspace: 'ws1', operationKind: 'node.upsert', payload: { id: 'n-failed' },
    });
    const deadEntry = await recordHotWrite(store, {
        workspace: 'ws1', operationKind: 'node.upsert', payload: { id: 'n-dead' },
    });
    await store.markEntryStatus(failedEntry.id, 'failed', { error: 'transient', bumpAttempt: true });
    await store.markEntryStatus(deadEntry.id, 'dead', { error: 'gave up', bumpAttempt: true });

    // Substrate probe: everything verifies (the row's effect DID land).
    const replicator = new OutboxReplicator({
        store,
        substrates: { hasNode: async () => true },
        log: () => undefined,
    });

    // 1. Routine sweep (what maybeSelfHeal does every tick).
    const routine = await replicator.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(routine.examined, 1, 'routine sweep must examine only the failed row');
    assert.equal(routine.recovered, 1);
    const deadAfterRoutine = (await store.listDead?.({ workspace: 'ws1' })) ?? [];
    assert.equal(deadAfterRoutine.length, 1, 'dead row must SURVIVE the routine sweep');
    assert.equal(deadAfterRoutine[0]!.id, deadEntry.id);

    // 2. Operator drain path opts dead rows in.
    const drain = await replicator.runSelfHealSweep({ force: true, graceMsOverride: 0, includeDead: true });
    assert.equal(drain.examined, 1, 'drain sweep examines the remaining dead row');
    assert.equal(drain.recovered, 1, 'drain sweep recovers it');
    const deadAfterDrain = (await store.listDead?.({ workspace: 'ws1' })) ?? [];
    assert.equal(deadAfterDrain.length, 0, 'operator drain empties the dead queue — by choice');

    store.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
