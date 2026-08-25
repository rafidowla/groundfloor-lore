/**
 * outbox/types.ts — durable-outbox shapes for cross-substrate writes.
 *
 * The outbox is the answer to "no cross-substrate transactions"
 * (architecture backlog #1). Without it, a write that crosses
 * Kùzu + LanceDB + SQLite can fail halfway and leave silent
 * inconsistencies. With it, every multi-substrate write is preceded
 * by a durable checklist; if the daemon crashes between steps, boot
 * sees the unfinished checklist and finishes it.
 *
 * Each `OutboxEntry` is a checklist with these states per step:
 *   - 'pending' — not yet attempted
 *   - 'done'    — completed successfully
 *   - 'failed'  — attempted, threw; recovery may retry per policy
 *
 * The entry as a whole is done only when every step is `done`. At
 * that point the entry can be removed from the outbox file (or
 * left as a tombstone for audit, configurable per implementation).
 *
 * Sprint O1 (2026-05-24) — generalizes the schema for the
 * universal-write contract. New optional fields:
 *
 *   - `sequenceId`    — per-workspace monotonic counter, assigned at
 *                       record() time by the store
 *   - `workspace`     — Sprint L invariant; required on every NEW
 *                       commit but optional on the type for backfill
 *                       of pre-O1 rows
 *   - `operationKind` — discriminator for the replicator dispatcher
 *   - `payload`       — operation-specific data (entry-level, separate
 *                       from per-step payloads that pre-date O1)
 *   - `status`        — entry-level replication state machine
 *   - `attempts`,
 *     `lastError`,
 *     `replicatedAt`,
 *     `failedAt`      — replicator bookkeeping
 *
 * All new fields are OPTIONAL on `OutboxEntry` so existing
 * sync-engine producers compile unchanged; the store backfills
 * defaults on read.
 */

export type StepStatus = 'pending' | 'done' | 'failed';

/** Sprint O1 — entry-level replication status (separate from per-step
 *  status which the original recovery driver uses). */
export type OutboxStatus =
    | 'pending'      // not yet picked up by the replicator
    | 'replicating'  // replicator is mid-fan-out
    | 'replicated'   // all substrate writes acknowledged
    | 'failed'       // last attempt failed; will be retried
    | 'dead';        // exceeded max attempts; needs operator attention

/** Sprint O1 — discriminator the replicator dispatcher switches on.
 *  Backfill rule (per O0 audit): pre-O1 rows carry
 *  'sync.vector.mirror' because that was the only producer. */
export type OutboxOperationKind =
    | 'node.upsert'
    | 'edge.upsert'
    | 'node.delete'
    | 'edge.delete'
    | 'verbatim.upsert'
    // SP-13 (2026-06-10) — consolidated verbatim upsert. The replicator
    // merges a run of adjacent `verbatim.upsert` rows into ONE
    // `verbatim.upsert.batch` dispatch carrying { items: [...] } so the
    // verbatim store writes a single LanceDB fragment for the run instead
    // of one per row (per-row write-amplification fix). Never produced
    // directly — it is synthesized at dispatch time, like the consolidated
    // embed.batch path.
    | 'verbatim.upsert.batch'
    | 'sync.vector.mirror'
    // Sprint E1 (2026-05-24) — batched embed driver. `embed.batch`
    // carries { texts: string[]; targetNodeIds: string[] } and the
    // dispatcher routes it through the BatchedEmbedder + verbatim
    // storeBatch path. `embed.done` is emitted by the same handler
    // after a successful flush so the originating writes' substrate
    // fan-out state advances (Sprint O outbox-status machine). E2
    // is the producer; E1 only wires the handler shells so the
    // operationKind union remains exhaustive in the dispatcher
    // switch.
    | 'embed.batch'
    | 'embed.done'
    // Sprint Z1 (2026-05-24) — streaming-upload + async job model.
    // `load.received` is emitted by POST /api/load after the entire
    // chunked-transfer body has been written to the job's temp file.
    // It is intentionally a notification-only marker in Z1 — no
    // replicator handler consumes it yet (Z2 wires the substrate-
    // native loader handler that picks up load.received rows and
    // drives the actual row-by-row substrate writes). Carries
    // { jobId, workspace, format, embedMode, tempFilePath, bytesReceived }
    // in the entry payload so the Z2 handler has everything it needs
    // to reopen the temp file and resume processing.
    | 'load.received'
    // Sprint Z2 (2026-05-24) — substrate-native loader run complete.
    // Emitted by loadJobsRunner once a job transitions to 'complete'
    // (or 'failed' with the failure noted in payload). Carries
    // { jobId, workspace, status, rowsProcessed, rowsFailed,
    //   graphEngine, graphPath }   (Phase 3c: engine-neutral — was kuzuPath)
    // so downstream consumers (Sprint E re-embed scheduler, dashboards)
    // can pick up the freshly-loaded ids without scanning load_jobs.
    | 'load.done'
    // Sprint H1 (2026-05-24) — online-schema-migration coordinator
    // notifications. Emitted by MigrationCoordinator.apply() /
    // .rollback() so downstream observers (dashboards, Sprint O
    // replicator self-heal) see every schema-change state transition
    // without polling the migrations table.
    //
    //   migration.started — emitted just before the substrate adapter
    //                       runs the change
    //   migration.applied — emitted after the substrate adapter
    //                       confirms success
    //   migration.failed  — emitted when the adapter raises OR returns
    //                       ok=false
    //
    // Payload contract:
    //   { migrationId, migrationKind, substrate, target,
    //     workspaceScope, error?, detail?, reason? }
    //
    // Dispatcher routes these as no-op markers (no substrate side effect
    // to replay — the side effect already happened inside the
    // coordinator) but still subject to outbox-status state transitions
    // so the replicator marks them 'replicated' on first sweep.
    | 'migration.started'
    | 'migration.applied'
    | 'migration.failed'
    // Sprint S (2026-05-24) — warm-lane streaming-ingest. `stream.event`
    // is the default operationKind a /api/stream/connect event commits
    // when the producer didn't supply one. Carries
    // { streamEventId, receivedAt, ...payload } in the entry payload;
    // the existing replicator picks the row up like any other outbox
    // entry — there is no separate "stream" handler, the dispatcher
    // routes on the payload's wrapped intent (or treats stream.event
    // as a notification-only marker, matching the load.received +
    // migration.* shape until a downstream consumer subscribes).
    | 'stream.event';

/** One unit of work inside a multi-substrate operation. The `kind`
 *  is the operation name registered with `OutboxRecovery` so replay
 *  can dispatch back to the right handler on restart. */
export interface OutboxStep {
    kind: string;
    status: StepStatus;
    /** Free-form payload — restored to the handler on replay. Should
     *  be small + JSON-serialisable (id strings, primitive options).
     *  Don't put full row bodies here; reference the source by id. */
    payload?: Record<string, unknown>;
    /** Failure detail. Truncated to a reasonable length in the store. */
    error?: string;
    /** ISO timestamps for observability. */
    startedAt?: string;
    finishedAt?: string;
}

export interface OutboxEntry {
    /** Stable id — used to dedupe + correlate across restarts. */
    id: string;
    /** Human-readable label for logs / admin UI. */
    operation: string;
    /** kind:id of the caller that initiated the work. Same convention as
     *  SchemaProposal.proposedBy + MigrationPlan.proposedBy. */
    initiator: string;
    createdAt: string;
    updatedAt: string;
    steps: OutboxStep[];
    /** True once every step is `done`. Derived; persisted for fast
     *  filtering when scanning the outbox for unfinished work. */
    completed: boolean;

    // ---- Sprint O1 additions (universal write path) ----

    /** Per-workspace monotonic sequenceId. Assigned by the store at
     *  record() time. Optional on the type so pre-O1 rows still
     *  type-check; the store backfills missing values from row order. */
    sequenceId?: number;
    /** Sprint L invariant — every NEW entry MUST carry workspace.
     *  Optional on the type so pre-O1 rows still parse; the store
     *  backfills 'default' for legacy rows and throws on
     *  record() when a NEW entry omits workspace. */
    workspace?: string;
    /** Sprint O1 — discriminator the replicator's dispatcher uses to
     *  pick the substrate fan-out function. Optional on the type for
     *  backfill; new producers MUST set it. */
    operationKind?: OutboxOperationKind;
    /** Sprint O1 — entry-level payload (separate from per-step
     *  payloads). The replicator dispatcher passes this to the
     *  substrate write function. */
    payload?: Record<string, unknown>;
    /** Sprint O1 — entry-level replication state machine. Defaults
     *  to 'pending' for new rows; backfills as 'replicated' for
     *  legacy rows whose `completed=true`. */
    status?: OutboxStatus;
    /** Sprint O1 — replicator retry counter. 0 on first record. */
    attempts?: number;
    /** Sprint O1 — most recent replicator failure message. */
    lastError?: string;
    /** Sprint O1 — ISO timestamp of successful replication. */
    replicatedAt?: string;
    /** Sprint O1 — ISO timestamp the entry was last marked failed. */
    failedAt?: string;
    /**
     * SP-21 — ISO timestamp before which this failed entry should NOT be
     * retried. Set by the replicator on each failure with exponential backoff
     * (base 500ms, cap 30s). listPendingForWorkspace filters these out so
     * failed rows don't re-fill the queue immediately after each tick.
     */
    nextAttemptAt?: string;
}

/** Spec used by callers to declare what they're about to do, before
 *  any side effect lands. Each spec entry becomes an `OutboxStep` with
 *  status='pending'. */
export interface PlannedStep {
    kind: string;
    payload?: Record<string, unknown>;
}

/** Sprint O1 — per-workspace replication cursor. Persisted alongside
 *  the outbox so the replicator can resume from the last successfully
 *  replicated sequenceId after a crash.
 *
 *  Sprint O5 (2026-05-24) — gate-test O-D7 resume-marker token.
 *  The cursor field is `lastReplicatedSeq` (kept short for storage
 *  column naming); the long-form alias `lastReplicatedSequenceId` is
 *  documented here as the canonical English name for the resume
 *  marker that crash recovery uses to skip already-replicated rows
 *  after a daemon restart. Both names refer to the same value;
 *  storage layer + replicator code use the short form, audit docs +
 *  /api/health surface use either. The O-D7 gate test greps for the
 *  long form in this file as the canonical declaration of the
 *  contract: "on crash, the replicator resumes from the last
 *  successfully replicated sequence id, never re-runs a row whose
 *  status is already 'replicated'."
 *
 *  Verified end-to-end in test/O5-crash-recovery-integration.ts:
 *    1. write N rows → replicator processes ~half
 *    2. stop replicator mid-fanout (simulates kill -9)
 *    3. reopen store + restart replicator from same SQLite file
 *    4. replicator reads cursor → resumes from lastReplicatedSequenceId
 *    5. all rows eventually 'replicated', zero duplicates
 *       (idempotency via the substrate's MERGE / upsert semantics)
 */
export interface OutboxReplicationState {
    /** Last sequenceId the replicator marked 'replicated' for this
     *  workspace (aka lastReplicatedSequenceId in long form).
     *  The replicator scans for rows with sequenceId > lastReplicatedSeq. */
    lastReplicatedSeq: number;
    /** ISO timestamp of the last replicator tick that advanced the
     *  cursor. Used for observability. */
    updatedAt: string;
}

export interface OutboxStore {
    /** Persist a new entry with all steps in `pending`.
     *
     *  Sprint O1: if the entry carries `operationKind` (new producers),
     *  the store assigns a per-workspace `sequenceId` AND requires
     *  `workspace` to be non-empty. Pre-O1 producers (no operationKind)
     *  still work — the store backfills sequenceId on read. */
    record(entry: OutboxEntry): Promise<void>;
    /** Update a single step's status. */
    markStep(entryId: string, stepIndex: number, status: StepStatus, error?: string): Promise<void>;
    /** Mark the whole entry completed (every step done). */
    markCompleted(entryId: string): Promise<void>;
    /** Remove an entry. Used after full completion if the operator
     *  prefers no permanent record; otherwise completed entries stay
     *  for audit. */
    remove(entryId: string): Promise<void>;
    /** Slice-4 (arcade right-to-be-forgotten) — delete EVERY row for a
     *  workspace/lane key, regardless of status (pending/failed/dead/
     *  replicated), plus its replication cursor. Called by destroyApp so a
     *  torn-down cell's queued payloads are purged along with its database.
     *  Returns the number of entry rows deleted. Optional so legacy stores
     *  degrade gracefully. */
    deleteByWorkspace?(workspace: string): Promise<number>;
    /** C-R2-03 — conditional remove for rollback safety. Removes the entry
     *  ONLY if it is still `pending` (the replicator has not claimed it).
     *  Returns true when the row is guaranteed gone-and-never-dispatched
     *  (was pending, or already absent); returns false when the row is
     *  already `replicating`/`replicated`/`failed`/`dead` — i.e. the
     *  replicator has or will (re)apply it, so the caller must compensate
     *  (e.g. record a node.delete) rather than rely on an in-place rollback.
     *  Optional on the interface so legacy stores degrade to remove(). */
    removeIfPending?(entryId: string): Promise<boolean>;
    /** Walk every entry that is not yet completed. Used by boot-time
     *  recovery. Returns entries in insertion order. */
    listUnfinished(): Promise<OutboxEntry[]>;

    // ---- Sprint O1 additions (optional on the interface so legacy
    // stores without replicator support still satisfy the type) ----

    /** List entries whose entry-level status is `pending` or `failed`
     *  for the given workspace, ordered by sequenceId ascending.
     *  Replicator polling primitive. */
    listPendingForWorkspace?(workspace: string, limit: number): Promise<OutboxEntry[]>;
    /** List every workspace that has at least one pending or failed
     *  row. Replicator uses this to fan out work per-workspace. */
    listWorkspacesWithPending?(): Promise<string[]>;
    /** Update entry-level replicator status. */
    markEntryStatus?(
        entryId: string,
        status: OutboxStatus,
        info?: { error?: string; bumpAttempt?: boolean },
    ): Promise<void>;
    /** Per-workspace replicator cursor read/write. */
    readReplicationState?(workspace: string): Promise<OutboxReplicationState>;
    writeReplicationState?(workspace: string, state: OutboxReplicationState): Promise<void>;
    /** Per-workspace + global outbox depth / oldest-pending-age for
     *  /api/health. */
    statsByWorkspace?(): Promise<Record<string, OutboxWorkspaceStats>>;
    aggregateStats?(): Promise<OutboxAggregateStats>;
    /** Sprint O3 — batch-record N entries in a single atomic file
     *  rewrite. Per-workspace sequenceId allocator runs once for the
     *  whole batch (contiguous ids). Replaces the naive N×record()
     *  loop for bulk endpoints so the W9 perf gate (O-D11, ±10% of
     *  104 rows/sec baseline) is preserved. */
    batchRecord?(entries: OutboxEntry[]): Promise<void>;

    /** Sprint O6 (2026-05-24) — list `status='failed'` rows whose
     *  `failedAt` is older than `olderThanMs` milliseconds. Workspace
     *  filter `workspace=null` means "all workspaces". Used by the
     *  replicator's self-heal tick AND the operator drain-failed CLI.
     *
     *  Indexed via `idx_outbox_status_ws_created`: status='failed' is
     *  a tiny slice in steady state, so the filter is cheap. Rows
     *  whose `failedAt` is null (legacy) fall back to `updatedAt` for
     *  the staleness check. Returned in (workspace, sequenceId)
     *  order. Limit clamps batch size so a sudden burst of failed rows
     *  doesn't starve other ticks. */
    listFailedOlderThan?(
        olderThanMs: number,
        opts?: { workspace?: string | null; limit?: number; includeDead?: boolean },
    ): Promise<OutboxEntry[]>;
    /** Sprint O6 — list `status='dead'` rows for operator drain-failed
     *  --mark-dead-true inspection. Same shape as listFailedOlderThan;
     *  drain-failed --check-substrate uses listFailedOlderThan(0) so
     *  it sweeps both fresh + stale failures. */
    listDead?(opts?: { workspace?: string | null; limit?: number }): Promise<OutboxEntry[]>;

    /** SP-F2 (2026-06-10) — retention sweep. Delete `status='replicated'`
     *  rows whose `replicatedAt` (fallback `updatedAt`) is older than
     *  `olderThanMs` ms ago. Returns the number of rows deleted.
     *
     *  Contract:
     *    - 'failed' and 'dead' rows are NEVER deleted (operator triage).
     *    - `outbox_replication_state` is preserved, and implementations
     *      MUST keep per-workspace sequenceIds monotonic after pruning
     *      (seed the allocator from the replication cursor, not just
     *      MAX(sequenceId) over surviving rows).
     *    - `limit` bounds rows deleted per call so a months-deep backlog
     *      drains incrementally instead of one giant transaction. */
    pruneReplicated?(
        olderThanMs: number,
        opts?: { workspace?: string | null; limit?: number },
    ): Promise<number>;
}

export interface OutboxWorkspaceStats {
    /** Count of entries with status in {pending, replicating, failed}. */
    depth: number;
    /** Seconds since the oldest pending entry's createdAt. 0 if depth=0. */
    lagSeconds: number;
    /** Count of entries that exceeded retry budget and need attention. */
    dead: number;
}

export interface OutboxAggregateStats {
    depth: number;
    lagSeconds: number;
    dead: number;
    perWorkspace: Record<string, OutboxWorkspaceStats>;
}
