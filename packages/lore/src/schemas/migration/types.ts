/**
 * migration/types.ts — Phase 4 item 8.
 *
 * Contracts for the migration runner. The runner sequences
 * MigrationOps against a substrate-specific MigrationBackend; the
 * Plan provides operator provenance + an optional link back to the
 * schema-authoring sandbox that motivated the migration.
 *
 * See docs/architecture/MIGRATION_RUNNER_DESIGN.md for the rationale and
 * docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md for the broader Agentic-DBA
 * principles this implements.
 *
 * MVP scope: only `node_type.removed` and `field.removed` are
 * implemented (most-common destructive cases). The shape covers the
 * other 7 destructive kinds; KuzuMigrationBackend will throw
 * `unsupported_op` for them until added.
 *
 * 2026-05-16 — batched checkpointing: `executeOp` was replaced by
 * `executeOpBatch(op, cursor, batchSize) → BatchResult`. The runner
 * loops over batches, persists a checkpoint after each batch to
 * `<workspace>/.lore/migrations/in-flight.json`, and can resume a
 * crashed plan from the saved cursor. See CheckpointStore.
 */

/**
 * Subset of SchemaChangeKind covered by the runner. All 9 destructive
 * kinds from `SchemaChangeKind` are listed; backends choose which to
 * implement (others throw `UNSUPPORTED_OP_ERROR` so the runner can
 * report cleanly).
 *
 * Coverage as of 2026-05-16 (KuzuMigrationBackend):
 *   - row-level work:     node_type.removed, field.removed, edge_type.removed
 *   - row-level + params: node_type.renamed (needs params.newName),
 *                         field.type_changed (needs params.newType)
 *   - schema-only no-op:  node_type.kind_changed, field.sensitivity_flipped,
 *                         permission.changed, permission.removed
 */
export type MigrationOpKind =
    | 'node_type.removed'
    | 'node_type.renamed'
    | 'node_type.kind_changed'
    | 'field.removed'
    | 'field.type_changed'
    | 'field.sensitivity_flipped'
    | 'edge_type.removed'
    | 'permission.changed'
    | 'permission.removed';

export interface MigrationOp {
    kind: MigrationOpKind;
    /**
     * Per-kind target identifier:
     *   - node_type.{removed,renamed,kind_changed} → type name (e.g. "know.Tenant")
     *   - field.{removed,type_changed,sensitivity_flipped} → "<NodeType>.<field>"
     *   - edge_type.removed → relation name (e.g. "leases")
     *   - permission.{changed,removed} → "<NodeType>.<verb>" (e.g. "know.Tenant.read")
     */
    target: string;
    /**
     * Kind-specific extras. Empty for removals and the schema-only
     * no-ops; populated for renames + retypes:
     *   - node_type.renamed → { newName: string }
     *   - field.type_changed → { newType: string, coerce?: 'lossy'|'strict' }
     * Backends document required params per kind; missing required
     * params surface as a clear error from the backend.
     */
    params?: Record<string, unknown>;
}

export interface MigrationPlan {
    ops: MigrationOp[];
    /** kind:id convention shared with SchemaProposal. */
    proposedBy: string;
    /** Operator running the migration. Audit only — Phase 1's destructive
     *  guard already enforced human approval upstream. */
    approvedBy: string;
    /** Optional link to the schema-authoring proposal this migration
     *  follows from, so the audit trail can join up. */
    sandboxId?: string;
    note?: string;
    /**
     * Stable plan identity used by the CheckpointStore to recognise
     * an in-flight resume after a crash or process restart. If
     * absent, MigrationRunner.execute() generates one.
     */
    planId?: string;
}

/* ────────────────────────────────────────────────────────────── */
/*  Per-op result shapes                                          */
/* ────────────────────────────────────────────────────────────── */

export interface DryRunOpResult {
    op: MigrationOp;
    /** Number of rows the execute would touch. */
    affectedRowCount: number;
    /** First N rows (or row summaries) for human preview. Empty
     *  when affectedRowCount is 0. */
    sampleRows?: unknown[];
    /** Human-readable note (e.g. for unsupported kinds). */
    note?: string;
}

export interface DryRunReport {
    ops: DryRunOpResult[];
    totalAffected: number;
    /** ISO timestamp the dry-run was computed at. */
    computedAt: string;
}

export interface ExecuteOpResult {
    op: MigrationOp;
    /** Rows physically removed (`node_type.removed`). */
    deleted: number;
    /** Rows whose metadata changed (`field.removed`). */
    modified: number;
    /** Present iff this op failed; subsequent ops are skipped. */
    error?: string;
}

export interface ExecuteReport {
    ops: ExecuteOpResult[];
    totalDeleted: number;
    totalModified: number;
    /** False when at least one op had an error. */
    succeeded: boolean;
    startedAt: string;
    finishedAt: string;
    /** Stable plan identity (echoed back from MigrationPlan.planId
     *  or generated). Lets callers correlate this report with the
     *  checkpoint file that was active during execution. */
    planId: string;
    /** True iff execute() picked up a previously-in-flight plan
     *  from the checkpoint store rather than starting fresh. */
    resumed: boolean;
}

/**
 * One batch's worth of work returned by `MigrationBackend.executeOpBatch`.
 * `nextCursor === null` means this op is complete; otherwise the
 * runner should call `executeOpBatch` again with the returned cursor
 * to continue.
 */
export interface BatchResult {
    deleted: number;
    modified: number;
    /** Substrate-defined opaque marker. The runner treats this as
     *  a black box and just hands it back on the next call. */
    nextCursor: string | null;
}

/* ────────────────────────────────────────────────────────────── */
/*  Substrate-adapter contract                                    */
/* ────────────────────────────────────────────────────────────── */

/**
 * A MigrationBackend translates abstract MigrationOps into
 * substrate-native operations.
 *
 *   dryRunOp        — read-only. NEVER writes. Returns the would-affect
 *                     count + an optional preview sample.
 *   executeOpBatch  — performs ONE batch of the transformation. The
 *                     runner loops until `nextCursor === null` and
 *                     persists a checkpoint after each batch so a
 *                     crash mid-op is resumable. Backends MUST treat
 *                     `cursor === null` as "start at the beginning".
 *   rollbackOp      — reverses a previously-executed op using the
 *                     snapshot rows captured at schema_approve time
 *                     (Phase 1 item 3). NOT batched in MVP — the row
 *                     set is bounded by the original op's blast
 *                     radius and snapshots ship as a single JSONL.
 *
 * Backends MUST throw an Error whose message === `UNSUPPORTED_OP_ERROR`
 * when handed an op kind they don't implement (so the runner can
 * report it cleanly).
 */
export interface MigrationBackend {
    dryRunOp(
        op: MigrationOp,
        sampleN: number,
    ): Promise<Omit<DryRunOpResult, 'op'>>;

    executeOpBatch(
        op: MigrationOp,
        cursor: string | null,
        batchSize: number,
    ): Promise<BatchResult>;

    rollbackOp(
        op: MigrationOp,
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<Omit<RollbackOpResult, 'op' | 'error' | 'snapshotFile'>>;
}

/* ────────────────────────────────────────────────────────────── */
/*  Rollback shapes                                               */
/* ────────────────────────────────────────────────────────────── */

export interface RollbackOpResult {
    op: MigrationOp;
    /** Rows reinserted (`node_type.removed`). */
    restored: number;
    /** Rows whose metadata had a field re-added (`field.removed`). */
    repaired: number;
    /** Absolute path to the snapshot file used for this op. */
    snapshotFile?: string;
    /** Present iff this op failed; subsequent ops still attempted —
     *  rollback's failure mode is fail-soft (best-effort recovery),
     *  unlike execute's fail-fast. */
    error?: string;
    /** C-R3-04 — set when a resumed rollback skipped this op because a prior
     *  (crashed) rollback attempt had already restored it. No work was redone. */
    alreadyRolledBack?: boolean;
}

export interface RollbackReport {
    ops: RollbackOpResult[];
    totalRestored: number;
    totalRepaired: number;
    /** False when at least one op had an error. */
    succeeded: boolean;
    startedAt: string;
    finishedAt: string;
    /** Stable plan identity echoed back. */
    planId: string;
}

/** Stable error string a backend uses for kinds it doesn't yet
 *  implement. The runner surfaces this verbatim in the report. */
export const UNSUPPORTED_OP_ERROR = 'unsupported_op';
