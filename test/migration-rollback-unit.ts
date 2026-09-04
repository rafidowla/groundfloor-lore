#!/usr/bin/env tsx
/**
 * test/migration-rollback-unit.ts — Phase 4 automated rollback.
 *
 * End-to-end test of the rollback path: write a Phase-1-style data
 * snapshot to .lore/data-snapshots/, call MigrationRunner.rollback,
 * verify the in-memory fake backend received the right snapshot rows
 * and the report's per-op + total counts match.
 *
 * Also covers fail-soft semantics (one op's error doesn't abort
 * the rest), missing-snapshot handling, and the
 * UNSUPPORTED_OP_ERROR surface.
 *
 * Real legacy-engine rollback is covered alongside the schema-routes test
 * harness (small surface — most logic is in the runner + snapshot
 * file plumbing).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MigrationRunner } from '../packages/lore/src/schemas/migration/runner.js';
import {
    UNSUPPORTED_OP_ERROR,
    type MigrationBackend,
    type MigrationOp,
    type ExecuteReport,
    type RollbackOpResult,
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

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-rollback-'));
    try { return await fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/* ---------- snapshot writer matching dataSnapshot.ts ---------- */

function writeSnapshot(dir: string, sandboxId: string, op: MigrationOp, rows: unknown[]): string {
    fs.mkdirSync(dir, { recursive: true });
    const isoTimestamp = new Date().toISOString();
    const safeTs = isoTimestamp.replace(/[:.]/g, '-');
    const safeKind = op.kind.replace(/\./g, '_');
    const safeTarget = op.target.replace(/[/\\.]/g, '__');
    const file = path.join(dir, `${safeTs}_${sandboxId}_${safeKind}_${safeTarget}.jsonl`);
    const header = JSON.stringify({
        _snapshotMetadata: { sandboxId, changeKind: op.kind, changeTarget: op.target, capturedAt: isoTimestamp, rowCount: rows.length },
    });
    const body = rows.map(r => JSON.stringify(r)).join('\n');
    fs.writeFileSync(file, body ? `${header}\n${body}\n` : `${header}\n`, 'utf-8');
    return file;
}

/* ---------- fake backend that records what rollbackOp received ---------- */

function fakeBackend(behavior: {
    rollbackResults?: Record<string, { restored: number; repaired: number }>;
    rollbackThrows?: Record<string, string>;
}) {
    const received: Array<{ op: MigrationOp; snapshotRows: ReadonlyArray<Record<string, unknown>> }> = [];
    const backend: MigrationBackend = {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch() { return { deleted: 0, modified: 0, nextCursor: null }; },
        async rollbackOp(op, snapshotRows) {
            received.push({ op, snapshotRows });
            const k = `${op.kind}|${op.target}`;
            if (behavior.rollbackThrows?.[k]) throw new Error(behavior.rollbackThrows[k]);
            return behavior.rollbackResults?.[k] ?? { restored: 0, repaired: 0 };
        },
    };
    return { backend, received };
}

function fakeExecuteReport(ops: MigrationOp[], planId = 'test-plan'): ExecuteReport {
    return {
        ops: ops.map(op => ({ op, deleted: 0, modified: 0 })),
        totalDeleted: 0, totalModified: 0, succeeded: true,
        startedAt: '2026-05-16T08:00:00.000Z',
        finishedAt: '2026-05-16T08:05:00.000Z',
        planId, resumed: false,
    };
}

const TWO_OP_PLAN = (sandboxId: string) => ({
    ops: [
        { kind: 'node_type.removed' as const, target: 'know.Doomed' },
        { kind: 'field.removed' as const, target: 'know.Person.email' },
    ],
    proposedBy: 'human:rafi',
    approvedBy: 'human:rafi',
    sandboxId,
});

console.log('MigrationRunner.rollback — Phase 4 automated rollback');

test('rollback reads snapshot body rows (skipping header) and hands them to backend.rollbackOp', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-abc';
        const op: MigrationOp = { kind: 'node_type.removed', target: 'know.Doomed' };
        writeSnapshot(dir, sandboxId, op, [
            { id: 'a', type: 'know.Doomed', label: 'A' },
            { id: 'b', type: 'know.Doomed', label: 'B' },
        ]);
        const { backend, received } = fakeBackend({
            rollbackResults: { 'node_type.removed|know.Doomed': { restored: 2, repaired: 0 } },
        });
        const runner = new MigrationRunner(backend);
        const report = await runner.rollback(
            { ops: [op], proposedBy: 'human:r', approvedBy: 'human:r', sandboxId },
            fakeExecuteReport([op]),
            dir,
        );
        assert.equal(report.succeeded, true);
        assert.equal(report.totalRestored, 2);
        assert.equal(received.length, 1);
        assert.equal(received[0].snapshotRows.length, 2, 'header line must be stripped');
        const first = received[0].snapshotRows[0] as Record<string, unknown>;
        assert.equal(first['id'], 'a');
    });
});

test('rollback processes ops in REVERSE order but reports them in plan order', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-order';
        const plan = TWO_OP_PLAN(sandboxId);
        for (const op of plan.ops) writeSnapshot(dir, sandboxId, op, [{ id: `x-${op.target}` }]);
        const { backend, received } = fakeBackend({
            rollbackResults: {
                'node_type.removed|know.Doomed': { restored: 1, repaired: 0 },
                'field.removed|know.Person.email': { restored: 0, repaired: 1 },
            },
        });
        const runner = new MigrationRunner(backend);
        const report = await runner.rollback(plan, fakeExecuteReport(plan.ops), dir);
        // Backend received the field op FIRST (reverse order).
        assert.equal(received[0].op.kind, 'field.removed');
        assert.equal(received[1].op.kind, 'node_type.removed');
        // Report still in plan order.
        assert.equal(report.ops[0].op.kind, 'node_type.removed');
        assert.equal(report.ops[1].op.kind, 'field.removed');
        assert.equal(report.totalRestored, 1);
        assert.equal(report.totalRepaired, 1);
    });
});

test('rollback is fail-SOFT — one op error does not abort the others', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-soft';
        const plan = TWO_OP_PLAN(sandboxId);
        for (const op of plan.ops) writeSnapshot(dir, sandboxId, op, [{ id: 'x' }]);
        const { backend } = fakeBackend({
            rollbackThrows: { 'node_type.removed|know.Doomed': 'legacy-engine connection blip' },
            rollbackResults: { 'field.removed|know.Person.email': { restored: 0, repaired: 5 } },
        });
        const runner = new MigrationRunner(backend);
        const report = await runner.rollback(plan, fakeExecuteReport(plan.ops), dir);
        assert.equal(report.succeeded, false);
        // The field op still ran and succeeded.
        const fieldResult = report.ops.find(r => r.op.kind === 'field.removed')!;
        assert.equal(fieldResult.repaired, 5);
        assert.equal(fieldResult.error, undefined);
        // The node_type op recorded the error.
        const nodeResult = report.ops.find(r => r.op.kind === 'node_type.removed')!;
        assert.match(nodeResult.error ?? '', /legacy-engine connection blip/);
    });
});

test('rollback surfaces a clear error when a snapshot file is missing', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-missing';
        const op: MigrationOp = { kind: 'node_type.removed', target: 'know.Lost' };
        // Note: no snapshot written.
        const { backend } = fakeBackend({});
        const runner = new MigrationRunner(backend);
        const report = await runner.rollback(
            { ops: [op], proposedBy: 'human:r', approvedBy: 'human:r', sandboxId },
            fakeExecuteReport([op]),
            dir,
        );
        assert.equal(report.succeeded, false);
        assert.match(report.ops[0].error ?? '', /no snapshot file found/);
    });
});

test('rollback finds the LATEST snapshot when multiple match', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-latest';
        const op: MigrationOp = { kind: 'node_type.removed', target: 'know.Doomed' };
        // Write two snapshots — second one has different row count
        // so we can verify which was loaded.
        writeSnapshot(dir, sandboxId, op, [{ id: 'old' }]);
        await new Promise(r => setTimeout(r, 5));  // ensure different timestamps
        writeSnapshot(dir, sandboxId, op, [{ id: 'new1' }, { id: 'new2' }]);
        const { backend, received } = fakeBackend({
            rollbackResults: { 'node_type.removed|know.Doomed': { restored: 2, repaired: 0 } },
        });
        const runner = new MigrationRunner(backend);
        await runner.rollback(
            { ops: [op], proposedBy: 'human:r', approvedBy: 'human:r', sandboxId },
            fakeExecuteReport([op]),
            dir,
        );
        assert.equal(received[0].snapshotRows.length, 2, 'latest (2-row) snapshot must win');
        const first = received[0].snapshotRows[0] as Record<string, unknown>;
        assert.ok(String(first['id']).startsWith('new'));
    });
});

test('rollback: UNSUPPORTED_OP_ERROR surfaces with friendly message', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-unsupp';
        const op: MigrationOp = { kind: 'node_type.removed', target: 'know.X' };
        writeSnapshot(dir, sandboxId, op, []);
        const { backend } = fakeBackend({
            rollbackThrows: { 'node_type.removed|know.X': UNSUPPORTED_OP_ERROR },
        });
        const runner = new MigrationRunner(backend);
        const report = await runner.rollback(
            { ops: [op], proposedBy: 'human:r', approvedBy: 'human:r', sandboxId },
            fakeExecuteReport([op]),
            dir,
        );
        assert.match(report.ops[0].error ?? '', /doesn't yet support rollback of kind 'node_type\.removed'/);
    });
});

test('rollback throws when plan.sandboxId is missing', async () => {
    await withTmpDir(async dir => {
        const op: MigrationOp = { kind: 'node_type.removed', target: 'know.X' };
        const { backend } = fakeBackend({});
        const runner = new MigrationRunner(backend);
        await assert.rejects(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => runner.rollback({ ops: [op], proposedBy: 'h', approvedBy: 'h' } as any, fakeExecuteReport([op]), dir),
            /sandboxId/,
        );
    });
});

test('rollback report carries planId, ISO timestamps, succeeded flag', async () => {
    await withTmpDir(async dir => {
        const sandboxId = 'sb-meta';
        const op: MigrationOp = { kind: 'node_type.removed', target: 'know.Y' };
        writeSnapshot(dir, sandboxId, op, [{ id: 'a' }]);
        const { backend } = fakeBackend({
            rollbackResults: { 'node_type.removed|know.Y': { restored: 1, repaired: 0 } },
        });
        const runner = new MigrationRunner(backend);
        const exec = fakeExecuteReport([op], 'plan-meta');
        const report = await runner.rollback(
            { ops: [op], proposedBy: 'h', approvedBy: 'h', sandboxId },
            exec,
            dir,
        );
        assert.equal(report.planId, 'plan-meta');
        assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(report.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(report.succeeded, true);
        assert.ok(report.ops[0].snapshotFile);
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
