#!/usr/bin/env tsx
/**
 * test/pkg2-migration-concurrency-unit.ts — deferred-tail Package 2
 * (migration-runner concurrency) NEW-behavior tests.
 *
 *   C-R3-03  per-workspace lock: two concurrent execute() calls sharing a
 *            CheckpointStore (same workspace) are SERIALIZED — their op batches
 *            never interleave, and the second sees a clean slate after the first
 *            finished (no clobbered checkpoint / foreign-in-flight race).
 *   C-R3-04  resumable rollback: a rollback that fails partway checkpoints the
 *            ops it completed; a re-run skips them (alreadyRolledBack) and only
 *            redoes the unfinished ops, clearing the checkpoint when all done.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MigrationRunner } from '../packages/lore/src/schemas/migration/runner.js';
import { CheckpointStore } from '../packages/lore/src/schemas/migration/checkpointStore.js';
import type {
    BatchResult,
    ExecuteReport,
    MigrationBackend,
    MigrationOp,
} from '../packages/lore/src/schemas/migration/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

const createdTmpDirs: string[] = [];
function tmpLoreDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg2-mig-'));
    createdTmpDirs.push(dir);
    return path.join(dir, '.lore');
}

function writeSnapshot(dir: string, sandboxId: string, op: MigrationOp, rows: unknown[]): void {
    fs.mkdirSync(dir, { recursive: true });
    const iso = new Date().toISOString();
    const safeTs = iso.replace(/[:.]/g, '-');
    const file = path.join(dir, `${safeTs}_${sandboxId}_${op.kind.replace(/\./g, '_')}_${op.target.replace(/[/\\.]/g, '__')}.jsonl`);
    const header = JSON.stringify({ _snapshotMetadata: { sandboxId, changeKind: op.kind, changeTarget: op.target, capturedAt: iso, rowCount: rows.length } });
    fs.writeFileSync(file, `${header}\n${rows.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
}

function fakeExecuteReport(ops: MigrationOp[], planId = 'pkg2-plan'): ExecuteReport {
    return {
        ops: ops.map(op => ({ op, deleted: 0, modified: 0 })),
        totalDeleted: 0, totalModified: 0, succeeded: true,
        startedAt: '2026-06-28T00:00:00.000Z', finishedAt: '2026-06-28T00:01:00.000Z',
        planId, resumed: false,
    };
}

console.log('Package 2 migration concurrency — per-workspace lock + resumable rollback');

/* ─────────────────── C-R3-03: concurrent execute is serialized ───────────── */

test('C-R3-03 two concurrent execute() on the same workspace do NOT interleave', async () => {
    const loreDir = tmpLoreDir();
    // Shared CheckpointStore path == same workspace == same lock key. Each runner
    // instance is constructed separately (mirrors per-request construction). Use
    // ONE shared backend across both runners so the `active` flag is global — the
    // lock must serialize the two execute() calls so it's never concurrently set.
    let active = false;
    let interleaved = false;
    const order: string[] = [];
    const backend: MigrationBackend = {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch(op): Promise<BatchResult> {
            if (active) interleaved = true;
            active = true;
            order.push(`enter:${op.target}`);
            await new Promise(r => setImmediate(r));
            order.push(`exit:${op.target}`);
            active = false;
            return { deleted: 1, modified: 0, nextCursor: null };
        },
        async rollbackOp() { return { restored: 0, repaired: 0 }; },
    };

    const runnerA = new MigrationRunner(backend, new CheckpointStore(loreDir));
    const runnerB = new MigrationRunner(backend, new CheckpointStore(loreDir));
    const planA = { planId: 'A', ops: [{ kind: 'node_type.removed' as const, target: 'know.A' }], proposedBy: 'human:r', approvedBy: 'human:r' };
    const planB = { planId: 'B', ops: [{ kind: 'node_type.removed' as const, target: 'know.B' }], proposedBy: 'human:r', approvedBy: 'human:r' };

    const [ra, rb] = await Promise.allSettled([runnerA.execute(planA), runnerB.execute(planB)]);

    assert.equal(interleaved, false, 'execute batches must NOT interleave across concurrent same-workspace runs');
    // Both either completed, or one was refused (foreign-in-flight) — but the
    // serialization means at least one fully succeeded and order is non-interleaved.
    const succeeded = [ra, rb].filter(r => r.status === 'fulfilled').length;
    assert.ok(succeeded >= 1, 'at least one execute must complete');
    // Order must be enter/exit paired, never enter:A,enter:B,...
    for (let i = 0; i < order.length; i += 2) {
        assert.ok(order[i].startsWith('enter:') && order[i + 1]?.startsWith('exit:'), `batches must be atomic pairs, got ${order.join(',')}`);
    }
});

/* ─────────────────── C-R3-04: resumable rollback ─────────────────────────── */

function rollbackBackend(throwsFor: Set<string>) {
    const rolledBack: string[] = [];
    const backend: MigrationBackend = {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch() { return { deleted: 0, modified: 0, nextCursor: null }; },
        async rollbackOp(op) {
            const key = `${op.kind}:${op.target}`;
            if (throwsFor.has(key)) throw new Error(`injected rollback failure for ${key}`);
            rolledBack.push(key);
            return { restored: 1, repaired: 0 };
        },
    };
    return { backend, rolledBack };
}

test('C-R3-04 partial rollback checkpoints completed ops; resume skips them and finishes', async () => {
    const loreDir = tmpLoreDir();
    const snapDir = path.join(loreDir, 'data-snapshots');
    const sandboxId = 'pkg2-sb';
    const ops: MigrationOp[] = [
        { kind: 'node_type.removed', target: 'know.First' },
        { kind: 'node_type.removed', target: 'know.Second' },
    ];
    for (const op of ops) writeSnapshot(snapDir, sandboxId, op, [{ id: `x-${op.target}` }]);
    const plan = { ops, proposedBy: 'human:r', approvedBy: 'human:r', sandboxId };
    const report = fakeExecuteReport(ops);
    const store = new CheckpointStore(loreDir);

    // ── Attempt 1: rollback fails on know.First (the op processed LAST in
    //    reverse order is know.First; know.Second rolls back first + checkpoints).
    const b1 = rollbackBackend(new Set(['node_type.removed:know.First']));
    const runner1 = new MigrationRunner(b1.backend, store);
    const r1 = await runner1.rollback(plan, report, snapDir);
    assert.equal(r1.succeeded, false, 'attempt 1 must report failure (one op threw)');
    assert.deepEqual(b1.rolledBack, ['node_type.removed:know.Second'], 'only the non-throwing op rolled back');

    // Checkpoint must persist the completed op (and NOT be cleared on failure).
    const cp = store.loadRollback();
    assert.ok(cp, 'a rollback checkpoint must exist after a partial failure');
    assert.equal(cp!.planId, report.planId);
    assert.deepEqual(cp!.completed, ['node_type.removed:know.Second'], 'checkpoint records the completed op');

    // ── Attempt 2: backend now succeeds for everything. The already-done op
    //    must be SKIPPED (alreadyRolledBack), only know.First redone.
    const b2 = rollbackBackend(new Set());
    const runner2 = new MigrationRunner(b2.backend, store);
    const r2 = await runner2.rollback(plan, report, snapDir);
    assert.equal(r2.succeeded, true, 'attempt 2 must succeed');
    assert.deepEqual(b2.rolledBack, ['node_type.removed:know.First'], 'resume redoes ONLY the previously-failed op');
    const skipped = r2.ops.filter(o => o.alreadyRolledBack).map(o => `${o.op.kind}:${o.op.target}`);
    assert.deepEqual(skipped, ['node_type.removed:know.Second'], 'the already-done op is reported as skipped');

    // Checkpoint cleared once everything is done.
    assert.equal(store.loadRollback(), null, 'rollback checkpoint must be cleared after a fully-successful rollback');
});

await Promise.all(pending);
for (const d of createdTmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
