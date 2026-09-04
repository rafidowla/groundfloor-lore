/**
 * migration/runner.ts — Phase 4 item 8 + batched checkpointing.
 *
 * MigrationRunner sequences MigrationOps against a substrate-specific
 * MigrationBackend. Semantics:
 *
 *   dryRun(plan) — calls backend.dryRunOp for every op, collects
 *     reports, sums totalAffected. NEVER writes. Backend errors
 *     surface as per-op {note: error.message, affectedRowCount: 0}
 *     — dry-run is informational, doesn't abort.
 *
 *   execute(plan, opts?) — loops `executeOpBatch` per op until
 *     `nextCursor === null`. After every batch, persists a checkpoint
 *     to <workspace>/.lore/migrations/in-flight.json (if a
 *     CheckpointStore is wired). **Fail-fast**: first op with an
 *     error sets `succeeded: false`, records the error, and SKIPS
 *     subsequent ops. Earlier ops that completed are real — partial
 *     application is honest, not silently rolled back.
 *
 *   resume(planId) — picks up an in-flight plan from the checkpoint
 *     store. Completed ops are skipped (their counts re-surfaced
 *     from the checkpoint); the in-progress op continues from its
 *     saved cursor; pending ops run normally afterward.
 *
 * **Single-writer invariant**: only one in-flight plan at a time per
 * workspace. `execute()` refuses to start if an unrelated in-flight
 * plan is already on disk — caller must explicitly `resume(otherId)`
 * or clear the checkpoint first. This matches the local graph engine's
 * single-writer constraint.
 *
 * See docs/architecture/MIGRATION_RUNNER_DESIGN.md for design rationale and what's
 * deferred (cloud backend, automated rollback, other 7 destructive
 * op kinds, expand/migrate/contract decomposition, second-party HITL).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
    UNSUPPORTED_OP_ERROR,
    type DryRunOpResult,
    type DryRunReport,
    type ExecuteOpResult,
    type ExecuteReport,
    type MigrationBackend,
    type MigrationOp,
    type MigrationPlan,
    type RollbackOpResult,
    type RollbackReport,
} from './types.js';
import {
    CheckpointStore,
    type CheckpointOp,
    type CheckpointState,
} from './checkpointStore.js';
import type { SchemaChangeAuditLogger } from '../../security/schemaChangeAudit.js';
import { KeyedMutex } from '../../engines/writeQueue.js';

const DEFAULT_SAMPLE_N = 3;
const DEFAULT_BATCH_SIZE = 1000;

// C-R3-03 — PROCESS-WIDE per-workspace lock for destructive migration runs.
// A MigrationRunner is constructed per request (its CheckpointStore points at
// one workspace's `.lore/migrations/`), so the existing in-flight.json guard is
// a check-then-act: two concurrent execute()/resume()/rollback() calls for the
// SAME workspace (local mode = one daemon, many apps) can both pass the guard
// and interleave destructive batches, clobbering the checkpoint. This module-
// level mutex, keyed by the checkpoint file path (a stable per-workspace id),
// serializes them. Different workspaces never contend.
const migrationLocks = new KeyedMutex();
let locklessRunnerSeq = 0;

/** Phase 4 audit linkage — optional auditor + workspace handed to the
 *  runner so a successful migration writes one `migration.applied`
 *  entry per op to <workspace>/.lore/schema-changes.jsonl. Both fields
 *  are needed together; either both wired or both absent. */
export interface MigrationAuditDeps {
    auditLog: SchemaChangeAuditLogger;
    workspace: string;
    /** Schema version after the contract phase that motivated this
     *  migration. Used to fill `schemaVersionAfter`. Defaults to 0 if
     *  the caller can't easily compute it — the audit entry is still
     *  valid and queryable by kind/target/at. */
    schemaVersionAfter?: number;
}

/** Error a caller can switch on (instead of regex-matching the
 *  message) when a foreign plan is in flight. */
export const FOREIGN_IN_FLIGHT_ERROR = 'foreign_plan_in_flight';

export interface ExecuteOpts {
    /** Rows per batch. Default 1000. */
    batchSize?: number;
}

export class MigrationRunner {
    constructor(
        private readonly backend: MigrationBackend,
        /** Optional. When absent, execute() runs without persisting
         *  checkpoints — fine for unit tests with fake backends, not
         *  for production. */
        private readonly checkpointStore?: CheckpointStore,
        /** Optional. When wired, every successfully-applied op writes
         *  one `migration.applied` entry to the schema-change audit
         *  log so the data migration shows up on the same timeline as
         *  the schema mutation that motivated it. */
        private readonly audit?: MigrationAuditDeps,
    ) {}

    // C-R3-03 — stable per-workspace lock key. With a CheckpointStore (prod)
    // it's the checkpoint file path, so every runner instance for the same
    // workspace shares one lock. Without one (unit tests, fake backends) each
    // instance gets a unique key so lockless test runners never serialize.
    private readonly _locklessKey = `mig:lockless:${locklessRunnerSeq++}`;
    private lockKey(): string {
        return this.checkpointStore ? `mig:${this.checkpointStore.path()}` : this._locklessKey;
    }
    /** Serialize destructive runs per workspace (execute/resume/rollback). */
    private withWorkspaceLock<T>(op: () => Promise<T>): Promise<T> {
        return migrationLocks.run(this.lockKey(), op);
    }

    /**
     * Compute what every op would do, without writing. Backend
     * failures surface in the per-op note so the human approver
     * sees which ops are unsupported / would error.
     */
    async dryRun(plan: MigrationPlan, sampleN: number = DEFAULT_SAMPLE_N): Promise<DryRunReport> {
        const ops: DryRunOpResult[] = [];
        for (const op of plan.ops) {
            try {
                const r = await this.backend.dryRunOp(op, sampleN);
                ops.push({ op, ...r });
            } catch (err) {
                ops.push({
                    op,
                    affectedRowCount: 0,
                    note: (err as Error).message === UNSUPPORTED_OP_ERROR
                        ? `migration backend doesn't yet support kind '${op.kind}'`
                        : `dry-run failed: ${(err as Error).message}`,
                });
            }
        }
        const totalAffected = ops.reduce((s, r) => s + r.affectedRowCount, 0);
        return { ops, totalAffected, computedAt: new Date().toISOString() };
    }

    /**
     * Apply every op. Each op is run in batches of `batchSize` rows;
     * a checkpoint is persisted after every batch. First op error
     * stops the run; subsequent ops are recorded with a skipped
     * error message.
     */
    async execute(plan: MigrationPlan, opts: ExecuteOpts = {}): Promise<ExecuteReport> {
        // C-R3-03 — serialize per workspace so the in-flight guard below is no
        // longer a racy check-then-act against a concurrent execute/resume.
        return this.withWorkspaceLock(() => this.executeLocked(plan, opts));
    }

    private async executeLocked(plan: MigrationPlan, opts: ExecuteOpts): Promise<ExecuteReport> {
        const planId = plan.planId ?? randomUUID();
        const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

        // Refuse to START a new execute while ANY plan is in flight —
        // regardless of planId (audit L-028). The prior `inFlight.planId
        // !== planId` carve-out let a caller reuse the in-flight planId to
        // slip past the single-writer guard and clobber a running plan.
        // Resuming an in-flight plan is resume()'s job (it reattaches via
        // load()+planId match and never reaches this guard).
        if (this.checkpointStore) {
            const inFlight = this.checkpointStore.load();
            if (inFlight && hasIncompleteOps(inFlight)) {
                throw new Error(
                    `${FOREIGN_IN_FLIGHT_ERROR}: plan '${inFlight.planId}' is in flight ` +
                    `(${incompleteOpCount(inFlight)} ops remaining). Resume or clear it before starting a new one.`,
                );
            }
        }

        const startedAt = new Date().toISOString();
        const state = this.makeInitialState(plan, planId, startedAt);
        return this.runLoop(state, batchSize, false);
    }

    /**
     * Pick up a previously-in-flight plan from the checkpoint store.
     * Completed ops are skipped; the in-progress op continues from
     * its saved cursor. Throws if there is no in-flight plan with
     * that id, or if the runner wasn't constructed with a
     * CheckpointStore.
     */
    async resume(planId: string, opts: ExecuteOpts = {}): Promise<ExecuteReport> {
        // C-R3-03 — same per-workspace lock as execute(): resume must not
        // interleave with a concurrent execute/resume on the same workspace.
        return this.withWorkspaceLock(async () => {
            if (!this.checkpointStore) {
                throw new Error('MigrationRunner.resume requires a CheckpointStore');
            }
            const inFlight = this.checkpointStore.load();
            if (!inFlight || inFlight.planId !== planId) {
                throw new Error(`no in-flight plan with id '${planId}'`);
            }
            const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
            return this.runLoop(inFlight, batchSize, true);
        });
    }

    /**
     * Reverse a previously-executed plan using the Phase 1 data
     * snapshots. Reads `<dataSnapshotsDir>/*_<sandboxId>_<kind>_<target>.jsonl`
     * for each op (most recent if more than one matches) and hands
     * the body rows to `backend.rollbackOp`.
     *
     * Best-effort by design: a failed op does NOT abort the rest
     * (rollback's job is recovery; partial recovery still helps).
     * Each op's outcome surfaces individually in the report.
     *
     * `sandboxId` is required — without it the snapshot files can't
     * be matched. Callers usually pull this from the original
     * SchemaProposal that motivated the migration.
     */
    async rollback(
        plan: MigrationPlan & { sandboxId: string },
        executeReport: ExecuteReport,
        dataSnapshotsDir: string,
    ): Promise<RollbackReport> {
        // C-R3-03 — rollback is destructive too; serialize per workspace with
        // execute/resume so it can't interleave with a concurrent run.
        return this.withWorkspaceLock(() => this.rollbackLocked(plan, executeReport, dataSnapshotsDir));
    }

    private async rollbackLocked(
        plan: MigrationPlan & { sandboxId: string },
        executeReport: ExecuteReport,
        dataSnapshotsDir: string,
    ): Promise<RollbackReport> {
        if (!plan.sandboxId) {
            throw new Error('rollback requires plan.sandboxId to locate the data snapshots');
        }
        const startedAt = new Date().toISOString();
        const ops: RollbackOpResult[] = [];
        let succeeded = true;

        // C-R3-04 — resumable rollback. Load any prior rollback progress for
        // THIS plan; ops already rolled back are skipped (rollbackOp restores
        // from snapshots — idempotent — but skipping avoids redundant work and
        // makes a crash-resumed rollback converge instead of restarting). A
        // checkpoint for a different planId is stale → ignored + overwritten.
        const opKey = (op: MigrationOp): string => `${op.kind}:${op.target}`;
        const priorRollback = this.checkpointStore?.loadRollback();
        const completed = new Set<string>(
            priorRollback && priorRollback.planId === executeReport.planId ? priorRollback.completed : [],
        );
        const persistRollback = (): void => {
            this.checkpointStore?.saveRollback({
                planId: executeReport.planId,
                startedAt,
                lastCheckpointAt: startedAt,
                completed: Array.from(completed),
            });
        };

        // Reverse order so dependent ops are undone before their deps.
        const ordered = [...executeReport.ops].reverse();
        for (const executed of ordered) {
            const op = executed.op;
            const key = opKey(op);
            if (completed.has(key)) {
                // Already rolled back in a prior (crashed) attempt — record as a
                // no-op success so the report still lists every op.
                ops.push({ op, restored: 0, repaired: 0, alreadyRolledBack: true });
                continue;
            }
            try {
                const snapshotFile = findLatestSnapshot(dataSnapshotsDir, plan.sandboxId, op);
                if (!snapshotFile) {
                    ops.push({
                        op, restored: 0, repaired: 0,
                        error: `no snapshot file found for ${op.kind}(${op.target}) under sandbox '${plan.sandboxId}'`,
                    });
                    succeeded = false;
                    continue;
                }
                const rows = readSnapshotBodyRows(snapshotFile);
                const r = await this.backend.rollbackOp(op, rows);
                ops.push({ op, ...r, snapshotFile });
                // C-R3-04 — checkpoint AFTER the op so a crash before this point
                // re-runs the op (idempotent restore), never skips an unfinished one.
                completed.add(key);
                persistRollback();
            } catch (err) {
                const msg = (err as Error).message;
                ops.push({
                    op, restored: 0, repaired: 0,
                    error: msg === UNSUPPORTED_OP_ERROR
                        ? `migration backend doesn't yet support rollback of kind '${op.kind}'`
                        : msg,
                });
                succeeded = false;
            }
        }

        // C-R3-04 — only clear the rollback checkpoint when every op is
        // accounted for as done; if some failed, leave it so a later rollback
        // resumes just the unfinished ops instead of repeating the whole plan.
        if (succeeded) this.checkpointStore?.clearRollback();

        // Restore original (plan-order) sequence in the report.
        ops.reverse();
        return {
            ops,
            totalRestored: ops.reduce((s, r) => s + r.restored, 0),
            totalRepaired: ops.reduce((s, r) => s + r.repaired, 0),
            succeeded,
            startedAt,
            finishedAt: new Date().toISOString(),
            planId: executeReport.planId,
        };
    }

    /* ─── internal ───────────────────────────────────────────────── */

    private makeInitialState(plan: MigrationPlan, planId: string, startedAt: string): CheckpointState {
        return {
            planId,
            startedAt,
            lastCheckpointAt: startedAt,
            proposedBy: plan.proposedBy,
            approvedBy: plan.approvedBy,
            sandboxId: plan.sandboxId,
            note: plan.note,
            ops: plan.ops.map((op, opIndex): CheckpointOp => ({
                opIndex, op, status: 'pending',
                cursor: null, deleted: 0, modified: 0,
            })),
        };
    }

    private async runLoop(state: CheckpointState, batchSize: number, resumed: boolean): Promise<ExecuteReport> {
        let succeeded = true;
        for (const checkOp of state.ops) {
            if (checkOp.status === 'completed') continue;
            if (checkOp.status === 'failed') { succeeded = false; continue; }

            if (!succeeded) {
                checkOp.status = 'failed';
                checkOp.error = 'skipped — earlier op in the plan failed';
                this.persist(state);
                continue;
            }

            checkOp.status = 'in_progress';
            // Save a checkpoint at the START of an op so a crash
            // before the first batch is also detectable.
            this.persist(state);

            try {
                let cursor = checkOp.cursor;
                while (true) {
                    const batch = await this.backend.executeOpBatch(checkOp.op, cursor, batchSize);
                    checkOp.deleted += batch.deleted;
                    checkOp.modified += batch.modified;
                    cursor = batch.nextCursor;
                    checkOp.cursor = cursor;
                    this.persist(state);
                    if (cursor === null) break;
                }
                checkOp.status = 'completed';
                checkOp.cursor = null;
                this.persist(state);
                this.emitAuditEntry(state, checkOp);
            } catch (err) {
                const msg = (err as Error).message;
                checkOp.status = 'failed';
                checkOp.error = msg === UNSUPPORTED_OP_ERROR
                    ? `migration backend doesn't yet support kind '${checkOp.op.kind}'`
                    : msg;
                this.persist(state);
                succeeded = false;
            }
        }

        // Plan finished one way or another — clear the in-flight
        // checkpoint. The full report lives in the caller's return
        // value; the checkpoint was only for crash-recovery.
        this.clear();

        const ops: ExecuteOpResult[] = state.ops.map(co => ({
            op: co.op,
            deleted: co.deleted,
            modified: co.modified,
            ...(co.error ? { error: co.error } : {}),
        }));
        return {
            ops,
            totalDeleted: ops.reduce((s, r) => s + r.deleted, 0),
            totalModified: ops.reduce((s, r) => s + r.modified, 0),
            succeeded,
            startedAt: state.startedAt,
            finishedAt: new Date().toISOString(),
            planId: state.planId,
            resumed,
        };
    }

    private persist(state: CheckpointState): void {
        this.checkpointStore?.save(state);
    }

    private clear(): void {
        this.checkpointStore?.clear();
    }

    /** Phase 4 audit linkage. Best-effort — an audit failure must not
     *  abort the migration. The schema-change log is read by humans
     *  for visibility, not consulted by the runner itself. */
    private emitAuditEntry(state: CheckpointState, checkOp: CheckpointOp): void {
        if (!this.audit) return;
        try {
            this.audit.auditLog.append({
                at: new Date().toISOString(),
                workspace: this.audit.workspace,
                schemaVersionAfter: this.audit.schemaVersionAfter ?? 0,
                kind: 'migration.applied',
                target: `${checkOp.op.kind}:${checkOp.op.target}`,
                proposedBy: state.proposedBy,
                approvedBy: state.approvedBy,
                migration: 'dual-shape',
                note: `planId=${state.planId} deleted=${checkOp.deleted} modified=${checkOp.modified}` +
                    (state.sandboxId ? ` sandboxId=${state.sandboxId}` : ''),
            });
        } catch {
            // Swallow — see method-level rationale.
        }
    }
}

function hasIncompleteOps(state: CheckpointState): boolean {
    return state.ops.some(o => o.status !== 'completed' && o.status !== 'failed');
}

function incompleteOpCount(state: CheckpointState): number {
    return state.ops.filter(o => o.status !== 'completed' && o.status !== 'failed').length;
}

/**
 * Match snapshot files written by `dataSnapshot.makeSnapshotFileName`:
 *   `${safeTs}_${sandboxId}_${safeKind}_${safeTarget}.jsonl`
 * where safeKind replaces `.` with `_` and safeTarget replaces `.` and
 * `/` with `__`. Returns the path of the most recent matching file by
 * ISO timestamp prefix (filename sorts chronologically).
 */
function findLatestSnapshot(dir: string, sandboxId: string, op: MigrationOp): string | null {
    if (!fs.existsSync(dir)) return null;
    const safeKind = op.kind.replace(/\./g, '_');
    const safeTarget = op.target.replace(/[/\\.]/g, '__');
    const needle = `_${sandboxId}_${safeKind}_${safeTarget}.jsonl`;
    const matches = fs.readdirSync(dir)
        .filter(f => f.endsWith(needle))
        .sort();
    if (matches.length === 0) return null;
    return path.join(dir, matches[matches.length - 1]);
}

/**
 * Read the JSONL body of a snapshot file, skipping the header line
 * (the first line is `{"_snapshotMetadata":...}` per the writer in
 * `dataSnapshot.ts`). Returns row objects.
 */
function readSnapshotBodyRows(file: string): Array<Record<string, unknown>> {
    const raw = fs.readFileSync(file, 'utf-8').trimEnd();
    if (!raw) return [];
    const lines = raw.split('\n');
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            // Skip the header line.
            if (i === 0 && '_snapshotMetadata' in parsed) continue;
            rows.push(parsed);
        } catch { /* skip malformed lines */ }
    }
    return rows;
}

/** Convenience type re-exports for callers that build plans by hand. */
export type { MigrationOp, MigrationPlan, DryRunReport, ExecuteReport, MigrationBackend };
