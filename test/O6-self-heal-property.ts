#!/usr/bin/env tsx
/**
 * test/O6-self-heal-property.ts — Sprint O6 gate test.
 *
 * Two cases extending Sprint O's gate (test/sprint-O-outbox-property.ts)
 * with the self-heal + operator drain-failed contract:
 *
 *   O-D12 — failed rows whose substrate already holds the data
 *           auto-recover within N seconds (replicator self-heal) with
 *           NO manual intervention.
 *
 *   O-D13 — operator can drain stuck rows via `lore outbox drain-failed`
 *           CLI without a daemon restart.
 *
 * Both flip from xfailStrict → expectPass when O6 ships. We land them
 * directly as expectPass here because this whole file IS O6 — the
 * presence of these cases enforces the contract going forward, and
 * Sprint Z (bulk loader) won't kick off until they're green.
 *
 * Same harness shape as test/sprint-O-outbox-property.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyApplied } from '../packages/lore/src/outbox/dispatcher.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { parseDrainFlags } from '../packages/lore/src/cli/commands/outbox.js';
import type {
    OutboxEntry, OutboxStore, OutboxStatus, OutboxReplicationState,
} from '../packages/lore/src/outbox/types.js';

let expectPassed = 0;
let expectFailed = 0;
let runnerErrors = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function expectPass(name: string, fn: () => Promise<void> | void): void {
    cases.push({ name, fn });
}

const SRC_ROOT = join(process.cwd(), 'packages/lore/src');

console.log('Sprint O6 gate test — self-heal + operator drain (2 cases)');

/* ----- O-D12 — failed-but-substrate-replicated rows auto-recover.
 *
 * Combination probe: (a) the dispatcher exports `verifyApplied`,
 * (b) the replicator carries a `runSelfHealSweep` method, AND (c) the
 * end-to-end behavior holds — a pre-seeded 'failed' row whose
 * substrate probe returns true flips to 'replicated' on the next
 * sweep with NO operator intervention.
 *
 * The static check pins the API surface so a refactor that hides the
 * method (or accidentally removes the dispatcher hook) breaks the
 * gate. The runtime check exercises the contract end-to-end. */
expectPass('O-D12 failed-but-substrate-replicated rows auto-recover via self-heal', async () => {
    const dispatcherSrc = readFileSync(join(SRC_ROOT, 'outbox/dispatcher.ts'), 'utf8');
    assert.ok(
        /export\s+async\s+function\s+verifyApplied/.test(dispatcherSrc),
        'outbox/dispatcher.ts must export verifyApplied(entry, substrates) — replicator self-heal contract',
    );
    const replicatorSrc = readFileSync(join(SRC_ROOT, 'outbox/replicator.ts'), 'utf8');
    assert.ok(
        /runSelfHealSweep\s*\(/.test(replicatorSrc),
        'outbox/replicator.ts must expose runSelfHealSweep() — operator + tick entry point',
    );

    // Runtime: synth a fake store with one failed row that the
    // substrate (stub hasNode hook) confirms is present.
    class Store implements OutboxStore {
        rows: OutboxEntry[] = [{
            id: 'gate-d12', operation: 'op', initiator: 'gate-test',
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
            failedAt: new Date(Date.now() - 60_000).toISOString(),
            steps: [], completed: false, workspace: 'default',
            operationKind: 'node.upsert', payload: { id: 'gate-node-d12' },
            status: 'failed', attempts: 1, sequenceId: 1,
        }];
        async record(): Promise<void> { /* unused */ }
        async markStep(): Promise<void> { /* unused */ }
        async markCompleted(): Promise<void> { /* unused */ }
        async remove(): Promise<void> { /* unused */ }
        async listUnfinished(): Promise<OutboxEntry[]> { return this.rows; }
        async listPendingForWorkspace(): Promise<OutboxEntry[]> { return []; }
        async listWorkspacesWithPending(): Promise<string[]> { return []; }
        async markEntryStatus(id: string, status: OutboxStatus): Promise<void> {
            const r = this.rows.find((x) => x.id === id);
            if (r) r.status = status;
        }
        async readReplicationState(): Promise<OutboxReplicationState> {
            return { lastReplicatedSeq: 0, updatedAt: new Date(0).toISOString() };
        }
        async writeReplicationState(): Promise<void> { /* unused */ }
        async listFailedOlderThan(): Promise<OutboxEntry[]> {
            return this.rows.filter((r) => r.status === 'failed');
        }
    }
    const store = new Store();
    const rep = new OutboxReplicator({
        store,
        substrates: { hasNode: async () => true },
        log: () => undefined,
    });
    const report = await rep.runSelfHealSweep({ force: true, graceMsOverride: 0 });
    assert.equal(report.recovered, 1, 'self-heal must flip the verified failed row to replicated');
    assert.equal(store.rows[0].status, 'replicated');

    // verifyApplied directly: same row, same outcome.
    const r = await verifyApplied(store.rows[0], { hasNode: async () => true });
    assert.equal(r.verified, true);
});

/* ----- O-D13 — operator can drain stuck rows via CLI without restart.
 *
 * Static probe pins the CLI surface: outbox.ts exists, exports
 * outboxCommand + parseDrainFlags, the index.ts CLI router has a
 * 'case "outbox":' branch, and the commands barrel re-exports
 * outboxCommand. Runtime probe: parseDrainFlags handles the documented
 * flags so an operator typing `lore outbox drain-failed --workspace
 * <ws>` does what the doc says. */
expectPass('O-D13 operator drain-failed CLI wired through cli/index.ts', () => {
    const outboxCmdSrc = readFileSync(join(SRC_ROOT, 'cli/commands/outbox.ts'), 'utf8');
    assert.ok(
        /export\s+async\s+function\s+outboxCommand/.test(outboxCmdSrc),
        'cli/commands/outbox.ts must export outboxCommand(args)',
    );
    assert.ok(
        /drain-failed/.test(outboxCmdSrc),
        'cli/commands/outbox.ts must implement drain-failed subcommand',
    );
    const cliIndex = readFileSync(join(SRC_ROOT, 'cli/index.ts'), 'utf8');
    assert.ok(
        /case 'outbox':/.test(cliIndex),
        `cli/index.ts must route 'outbox' command to outboxCommand`,
    );
    const cmdBarrel = readFileSync(join(SRC_ROOT, 'cli/commands/index.ts'), 'utf8');
    assert.ok(
        /outboxCommand/.test(cmdBarrel),
        `cli/commands/index.ts must re-export outboxCommand`,
    );

    // Runtime: parseDrainFlags semantics
    const def = parseDrainFlags([]);
    assert.equal(def.checkSubstrate, true, 'default checkSubstrate=true');
    assert.equal(def.markDead, false, 'default markDead=false');
    const full = parseDrainFlags(['--workspace', 'ws1', '--mark-dead', '--dry-run']);
    assert.equal(full.workspace, 'ws1');
    assert.equal(full.markDead, true);
    assert.equal(full.dryRun, true);
});

for (const c of cases) {
    try {
        await c.fn();
        console.log(`  ✓ ${c.name} (pass)`);
        expectPassed++;
    } catch (err) {
        console.error(`  ✗ ${c.name} — REGRESSION: ${(err as Error).message.split('\n')[0]?.slice(0, 200)}`);
        expectFailed++;
    }
}

console.log('');
console.log(`expect-pass:      ${expectPassed}`);
console.log(`expect-fail:      ${expectFailed}`);
console.log(`harness-errors:   ${runnerErrors}`);

if (expectFailed > 0 || runnerErrors > 0) {
    console.error(`FAIL: ${expectFailed} expectPass regressed, ${runnerErrors} harness errors`);
    process.exit(1);
}
console.log('');
console.log(`OK: ${expectPassed} expect-pass.`);
