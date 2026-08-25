#!/usr/bin/env tsx
/**
 * test/migration-runner-unit.ts — Phase 4 item 8 + batched
 * checkpointing tests.
 *
 * Verifies MigrationRunner behavior against an in-memory fake
 * MigrationBackend: dry-run never writes, execute loops batches
 * with checkpoint persistence between each, fail-fast semantics
 * (first failure skips the rest with explanatory errors), resume()
 * picks up an in-flight plan from the checkpoint store and skips
 * already-completed ops, foreign in-flight plan blocks a fresh
 * execute(), planId is generated when absent.
 *
 * Real Kùzu integration is covered separately in
 * test/migration-kuzu-backend-unit.ts.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MigrationRunner, FOREIGN_IN_FLIGHT_ERROR } from '../packages/lore/src/schemas/migration/runner.js';
import { CheckpointStore } from '../packages/lore/src/schemas/migration/checkpointStore.js';
import {
    UNSUPPORTED_OP_ERROR,
    type BatchResult,
    type MigrationBackend,
    type MigrationOp,
    type MigrationPlan,
    type DryRunOpResult,
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

async function withTmpLoreDir<T>(fn: (loreDir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-runner-'));
    const loreDir = path.join(dir, '.lore');
    try { return await fn(loreDir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/* ---------- in-memory backend with batched semantics ---------- */

interface RecordedCall {
    method: 'dryRunOp' | 'executeOpBatch';
    op: MigrationOp;
    cursor?: string | null;
    batchSize?: number;
}

/**
 * Fake backend that returns scripted batches per op. Each op's
 * `batches` array is consumed in order; the runner is responsible
 * for plumbing cursors back in (we just sanity-check the last cursor
 * received matches the prior batch's `nextCursor`).
 */
function fakeBackend(behavior: {
    dryRunResults?: Record<string, Omit<DryRunOpResult, 'op'>>;
    dryRunThrows?: Record<string, string>;
    executeBatches?: Record<string, BatchResult[]>;
    executeBatchThrows?: Record<string, string>;
}): MigrationBackend & { calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const batchCursors: Record<string, number> = {};
    return {
        calls,
        async dryRunOp(op) {
            calls.push({ method: 'dryRunOp', op });
            const k = `${op.kind}|${op.target}`;
            if (behavior.dryRunThrows?.[k]) throw new Error(behavior.dryRunThrows[k]);
            return behavior.dryRunResults?.[k] ?? { affectedRowCount: 0 };
        },
        async executeOpBatch(op, cursor, batchSize) {
            calls.push({ method: 'executeOpBatch', op, cursor, batchSize });
            const k = `${op.kind}|${op.target}`;
            if (behavior.executeBatchThrows?.[k]) throw new Error(behavior.executeBatchThrows[k]);
            const batches = behavior.executeBatches?.[k] ?? [{ deleted: 0, modified: 0, nextCursor: null }];
            const i = batchCursors[k] ?? 0;
            batchCursors[k] = i + 1;
            return batches[i] ?? { deleted: 0, modified: 0, nextCursor: null };
        },
    };
}

const PLAN_TWO_OPS: MigrationPlan = {
    ops: [
        { kind: 'node_type.removed', target: 'know.A' },
        { kind: 'field.removed', target: 'know.B.email' },
    ],
    proposedBy: 'human:rafi',
    approvedBy: 'human:rafi',
    planId: 'test-plan-1',
};

console.log('MigrationRunner — Phase 4 batched checkpointing');

/* ---------- dryRun (unchanged behavior from MVP) ---------- */

test('dryRun calls dryRunOp for every op in order; never calls executeOpBatch', async () => {
    const be = fakeBackend({
        dryRunResults: {
            'node_type.removed|know.A': { affectedRowCount: 5 },
            'field.removed|know.B.email': { affectedRowCount: 10 },
        },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.dryRun(PLAN_TWO_OPS);
    assert.equal(report.totalAffected, 15);
    assert.equal(be.calls.filter(c => c.method === 'executeOpBatch').length, 0);
});

test('dryRun: UNSUPPORTED_OP_ERROR gets a friendly note', async () => {
    const be = fakeBackend({
        dryRunThrows: { 'node_type.removed|know.A': UNSUPPORTED_OP_ERROR },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.dryRun({
        ops: [{ kind: 'node_type.removed', target: 'know.A' }],
        proposedBy: 'human:rafi', approvedBy: 'human:rafi',
    });
    assert.match(report.ops[0].note ?? '', /doesn't yet support kind 'node_type\.removed'/);
});

/* ---------- execute: batching + checkpoint persistence ---------- */

test('execute calls executeOpBatch in a loop until nextCursor is null', async () => {
    const be = fakeBackend({
        executeBatches: {
            'node_type.removed|know.A': [
                { deleted: 100, modified: 0, nextCursor: 'more' },
                { deleted: 100, modified: 0, nextCursor: 'more' },
                { deleted: 47, modified: 0, nextCursor: null },
            ],
            'field.removed|know.B.email': [
                { deleted: 0, modified: 50, nextCursor: null },
            ],
        },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.execute(PLAN_TWO_OPS);
    assert.equal(report.succeeded, true);
    assert.equal(report.totalDeleted, 247);
    assert.equal(report.totalModified, 50);
    // 3 batches for op A + 1 batch for op B = 4 executeOpBatch calls
    assert.equal(be.calls.filter(c => c.method === 'executeOpBatch').length, 4);
});

test('execute persists a checkpoint after every batch', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        const be = fakeBackend({
            executeBatches: {
                'node_type.removed|know.A': [
                    { deleted: 10, modified: 0, nextCursor: 'more' },
                    { deleted: 10, modified: 0, nextCursor: null },
                ],
                'field.removed|know.B.email': [
                    { deleted: 0, modified: 5, nextCursor: null },
                ],
            },
        });

        // Wrap CheckpointStore to count save calls.
        let saveCalls = 0;
        const origSave = store.save.bind(store);
        store.save = (s) => { saveCalls++; return origSave(s); };

        const runner = new MigrationRunner(be, store);
        await runner.execute(PLAN_TWO_OPS);

        // Expected saves: 1 op-start + 2 batches for op A = 3; then
        // 1 status=completed; 1 op-start for B + 1 batch + 1 completed
        // = 6 saves total minimum. We just assert "more than zero per batch".
        assert.ok(saveCalls >= 5, `expected at least 5 checkpoint saves, got ${saveCalls}`);

        // Checkpoint must be cleared at the end.
        assert.equal(store.load(), null);
    });
});

test('execute uses provided planId; generates one when absent', async () => {
    const be = fakeBackend({});
    const runner = new MigrationRunner(be);
    const withId = await runner.execute({ ...PLAN_TWO_OPS, planId: 'fixed-id' });
    assert.equal(withId.planId, 'fixed-id');
    const withoutId = await runner.execute({
        ops: [{ kind: 'node_type.removed', target: 'know.X' }],
        proposedBy: 'human:r', approvedBy: 'human:r',
    });
    assert.ok(withoutId.planId);
    assert.notEqual(withoutId.planId, 'fixed-id');
});

test('execute reports resumed=false on a fresh run', async () => {
    const be = fakeBackend({});
    const runner = new MigrationRunner(be);
    const r = await runner.execute(PLAN_TWO_OPS);
    assert.equal(r.resumed, false);
});

test('execute: ISO timestamps for startedAt + finishedAt', async () => {
    const be = fakeBackend({});
    const runner = new MigrationRunner(be);
    const r = await runner.execute(PLAN_TWO_OPS);
    assert.match(r.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(r.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
});

/* ---------- execute: fail-fast ---------- */

test('execute fail-fast: first batch error stops the op + subsequent ops, checkpoint records failure', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        const be = fakeBackend({
            executeBatchThrows: { 'node_type.removed|know.A': 'kuzu connection lost' },
        });
        const runner = new MigrationRunner(be, store);
        const report = await runner.execute(PLAN_TWO_OPS);
        assert.equal(report.succeeded, false);
        assert.equal(report.ops[0].error, 'kuzu connection lost');
        assert.match(report.ops[1].error ?? '', /skipped/);
        // Checkpoint must still be cleared (run is over).
        assert.equal(store.load(), null);
    });
});

test('execute: UNSUPPORTED_OP_ERROR surfaces with friendly message', async () => {
    const be = fakeBackend({
        executeBatchThrows: { 'node_type.removed|know.A': UNSUPPORTED_OP_ERROR },
    });
    const runner = new MigrationRunner(be);
    const r = await runner.execute({
        ops: [{ kind: 'node_type.removed', target: 'know.A' }],
        proposedBy: 'human:r', approvedBy: 'human:r',
    });
    assert.match(r.ops[0].error ?? '', /doesn't yet support kind/);
});

/* ---------- foreign in-flight detection ---------- */

test('execute refuses to start when a foreign plan is in flight', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        // Seed a pre-existing in-flight plan with a different planId.
        store.save({
            planId: 'someone-else',
            startedAt: '2026-05-16T08:00:00.000Z',
            lastCheckpointAt: '2026-05-16T08:00:00.000Z',
            proposedBy: 'human:rafi',
            approvedBy: 'human:rafi',
            ops: [{
                opIndex: 0,
                op: { kind: 'node_type.removed', target: 'know.X' },
                status: 'in_progress', cursor: 'somewhere', deleted: 5, modified: 0,
            }],
        });

        const be = fakeBackend({});
        const runner = new MigrationRunner(be, store);
        await assert.rejects(
            () => runner.execute(PLAN_TWO_OPS),
            new RegExp(FOREIGN_IN_FLIGHT_ERROR),
        );

        // Foreign checkpoint must be untouched.
        const stillThere = store.load();
        assert.equal(stillThere?.planId, 'someone-else');
    });
});

/* ---------- resume ---------- */

test('resume picks up where the in-flight checkpoint left off; resumed=true', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        // Op 0 already completed (deleted 47 of 47); op 1 was
        // in_progress with cursor 'last-id' after deleting 10.
        store.save({
            planId: 'resumed-plan',
            startedAt: '2026-05-16T08:00:00.000Z',
            lastCheckpointAt: '2026-05-16T08:05:00.000Z',
            proposedBy: 'human:rafi',
            approvedBy: 'human:rafi',
            ops: [
                { opIndex: 0, op: { kind: 'node_type.removed', target: 'know.A' },
                  status: 'completed', cursor: null, deleted: 47, modified: 0 },
                { opIndex: 1, op: { kind: 'field.removed', target: 'know.B.email' },
                  status: 'in_progress', cursor: 'last-id', deleted: 0, modified: 10 },
            ],
        });
        const be = fakeBackend({
            executeBatches: {
                'field.removed|know.B.email': [
                    { deleted: 0, modified: 5, nextCursor: null },
                ],
            },
        });
        const runner = new MigrationRunner(be, store);
        const r = await runner.resume('resumed-plan');
        assert.equal(r.resumed, true);
        assert.equal(r.succeeded, true);
        // Op 0 is reported with its pre-checkpoint counts (47 deletes).
        assert.equal(r.ops[0].deleted, 47);
        // Op 1 continues: had 10 modified, picked up 5 more = 15.
        assert.equal(r.ops[1].modified, 15);
        // executeOpBatch was called ONLY for op 1; op 0 was skipped.
        const opTargetsCalled = be.calls
            .filter(c => c.method === 'executeOpBatch')
            .map(c => c.op.target);
        assert.deepEqual(opTargetsCalled, ['know.B.email']);
        // First call to op 1 must use the saved cursor.
        const firstOp1Call = be.calls.find(c => c.method === 'executeOpBatch' && c.op.target === 'know.B.email');
        assert.equal(firstOp1Call?.cursor, 'last-id');
    });
});

test('resume throws when no in-flight plan with that id', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        const be = fakeBackend({});
        const runner = new MigrationRunner(be, store);
        await assert.rejects(() => runner.resume('does-not-exist'), /no in-flight plan/);
    });
});

test('resume throws when constructed without a CheckpointStore', async () => {
    const be = fakeBackend({});
    const runner = new MigrationRunner(be);
    await assert.rejects(() => runner.resume('anything'), /requires a CheckpointStore/);
});

/* ---------- new op kinds (2026-05-16): flow through the runner ---------- */

test('execute handles edge_type.removed via the runner', async () => {
    const be = fakeBackend({
        executeBatches: {
            'edge_type.removed|leases': [{ deleted: 4, modified: 0, nextCursor: null }],
        },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.execute({
        ops: [{ kind: 'edge_type.removed', target: 'leases' }],
        proposedBy: 'human:rafi', approvedBy: 'human:rafi',
    });
    assert.equal(report.succeeded, true);
    assert.equal(report.totalDeleted, 4);
});

test('execute handles node_type.renamed (param-bearing) via the runner', async () => {
    const be = fakeBackend({
        executeBatches: {
            'node_type.renamed|know.Old': [{ deleted: 0, modified: 7, nextCursor: null }],
        },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.execute({
        ops: [{ kind: 'node_type.renamed', target: 'know.Old', params: { newName: 'know.New' } }],
        proposedBy: 'human:rafi', approvedBy: 'human:rafi',
    });
    assert.equal(report.succeeded, true);
    assert.equal(report.totalModified, 7);
    // Backend received the params bag intact.
    const exec = be.calls.find(c => c.method === 'executeOpBatch');
    assert.equal((exec?.op as MigrationOp).params?.['newName'], 'know.New');
});

test('execute handles field.type_changed (param-bearing) via the runner', async () => {
    const be = fakeBackend({
        executeBatches: {
            'field.type_changed|know.Order.total': [{ deleted: 0, modified: 12, nextCursor: null }],
        },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.execute({
        ops: [{ kind: 'field.type_changed', target: 'know.Order.total', params: { newType: 'integer' } }],
        proposedBy: 'human:rafi', approvedBy: 'human:rafi',
    });
    assert.equal(report.succeeded, true);
    assert.equal(report.totalModified, 12);
});

test('execute handles all 4 schema-only no-op kinds (successful zero-counts)', async () => {
    const be = fakeBackend({
        // Backend returns 0/0/null for these — runner must report
        // succeeded:true and totals=0, NOT skip them as failures.
        executeBatches: {
            'node_type.kind_changed|know.X': [{ deleted: 0, modified: 0, nextCursor: null }],
            'field.sensitivity_flipped|know.X.f': [{ deleted: 0, modified: 0, nextCursor: null }],
            'permission.changed|know.X.read': [{ deleted: 0, modified: 0, nextCursor: null }],
            'permission.removed|know.X.write': [{ deleted: 0, modified: 0, nextCursor: null }],
        },
    });
    const runner = new MigrationRunner(be);
    const report = await runner.execute({
        ops: [
            { kind: 'node_type.kind_changed', target: 'know.X' },
            { kind: 'field.sensitivity_flipped', target: 'know.X.f' },
            { kind: 'permission.changed', target: 'know.X.read' },
            { kind: 'permission.removed', target: 'know.X.write' },
        ],
        proposedBy: 'human:rafi', approvedBy: 'human:rafi',
    });
    assert.equal(report.succeeded, true);
    assert.equal(report.totalDeleted, 0);
    assert.equal(report.totalModified, 0);
    assert.equal(report.ops.length, 4);
    for (const o of report.ops) assert.equal(o.error, undefined, `${o.op.kind} must not error`);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
