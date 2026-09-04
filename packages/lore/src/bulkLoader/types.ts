/**
 * bulkLoader/types.ts — Sprint Z2 BulkLoaderAdapter interface.
 *
 * The contract every substrate-native loader implements. Z2 ships:
 *   - sqliteAdapter (prepared INSERT + db.transaction wrapper; SQLite
 *     has no COPY per Z0 audit, but prepared+txn floor measured at
 *     1.23M rps so this is plenty fast)
 *   - surrealAdapter (graph rows routed through SurrealGraph's
 *     bulkUpsertNodes/addEdge write verbs)
 *   - lanceAdapter (table.add Arrow batch with server-side chunking;
 *     default 5k rows/batch to bound memory pressure)
 *
 * Z3 will extend with checkpoint/resume helpers; we declare the
 * checkpoint shape here so the gate test sees the constant and the
 * Z3 implementer doesn't need to re-export.
 *
 * Sprint Z principle clauses anchored here:
 *   - clause 3 — substrate-native loaders per format; per-row INSERT
 *     explicitly avoided
 *   - clause 4 — checkpoint every N rows (Z3 lands the default constant
 *                + resume helper; Z2 only sketches the placeholder
 *                BulkLoaderCheckpoint shape)
 *   - clause 5 — per-item failure isolation (BatchResult.errors[])
 *   - clause 8 — bulk-load default embed:skip (BulkLoaderOpts.embed)
 */

/**
 * Per-batch result returned by every adapter's writeBatch().
 *
 * Sprint Z principle clause 5 — per-item failures reported, NOT
 * thrown. The runner aggregates errors into load_jobs.errors_json.
 */
export interface BatchResult {
    /** Rows successfully written this batch. */
    written: number;
    /** Rows that failed this batch. Length === errors.length. */
    failed: number;
    /** Per-row failure detail. rowIndex is the offset within the
     *  full load job (NOT within this batch). */
    errors: Array<{ rowIndex: number; errorMessage: string }>;
}

/**
 * Embed-mode for a bulk load.
 *
 *   - 'skip'   — write rows without embedding (Sprint E E2 default at
 *                bulk-load scale; Z principle clause 8). Vector store
 *                receives placeholder zero-vectors via skip path or
 *                NO vector store write (verbatim-only). The Sprint E
 *                re-embed job can backfill later.
 *   - 'queued' — write rows, enqueue embed.batch outbox entries; the
 *                Sprint E BatchedEmbedder picks them up async.
 *   - 'inline' — embed synchronously in the loader; ONLY safe for
 *                small loads (Z principle clause 8 explicitly
 *                deprecates this at bulk scale).
 */
export type BulkLoaderEmbed = 'skip' | 'queued' | 'inline';

/**
 * Options every adapter accepts. Embed default = 'skip' per
 * Sprint Z principle clause 8 + Z-D10 gate.
 */
export interface BulkLoaderOpts {
    /** Embed mode for this batch. Default 'skip'. */
    embed: BulkLoaderEmbed;
    /** Workspace scope — Sprint L invariant, threaded for audit. */
    workspace: string;
    /** Job id — used by adapters that want to emit per-chunk outbox
     *  entries (the graph adapter uses this for graph fan-out). */
    jobId: string;
    /** The offset of the FIRST row in this batch within the overall
     *  job (so per-row failure errors can carry a stable row index). */
    baseRowIndex: number;
}

/**
 * Sprint Z2 placeholder checkpoint shape — the runner returns this
 * from adapter.checkpoint() so callers have a stable contract, but
 * Z2 does NOT persist it into load_jobs (Z3 owns the crash-resumable
 * checkpoint logic + the 10k-row default + the resume helper).
 *
 * Sprint Z3 — `checkpointRowId` is the canonical name persisted into
 * load_jobs.checkpoint_row (resume helper reads it via
 * loadJobsStore.listRunning() and seeks past it on restart). The
 * 10k-row default is exported as DEFAULT_CHECKPOINT_ROWS below
 * (Sprint Z principle clause 4).
 */
export interface BulkLoaderCheckpoint {
    /** Sprint Z3 canonical name — last persisted row index. */
    checkpointRowId: number;
    /** ISO timestamp of checkpoint write. */
    at: string;
    /** @deprecated Z2 placeholder field — read checkpointRowId. */
    offset: number;
}

/**
 * Sprint Z3 — checkpoint every N rows (default 10k per Sprint Z
 * principle clause 4). The runner uses this constant; adapters
 * expose it here so tests / readers see the policy in one place.
 *
 * resumeFrom helper: loadJobsRunner.startupReconcileAndResume()
 * queries load_jobs WHERE status='running' on boot and re-enters
 * each job at row index = checkpoint_row.
 */
export const DEFAULT_CHECKPOINT_ROWS = 10_000;

/**
 * The contract every substrate-native loader implements.
 *
 * Lifecycle:
 *   1. begin(opts)         — open a transaction / Arrow batcher / etc.
 *   2. writeBatch(rows)    — append a batch (called repeatedly)
 *   3. checkpoint()        — flush in-flight buffers (Z3 will call
 *                            from the runner at a Z3-defined interval
 *                            intervals; Z2 calls once at commit-time)
 *   4. commit() OR rollback()
 *
 * Z2 only exercises begin → writeBatch* → commit. Rollback + the
 * intermediate checkpoint() are reserved for Z3.
 */
export interface BulkLoaderAdapter<Row = unknown> {
    /** Substrate identifier — purely for logs + outbox routing. Phase 3c
     *  adds 'surreal' for the SurrealDB graph adapter; a workspace's
     *  graph rows route to whichever engine actually backs it. */
    readonly substrate: 'sqlite' | 'graph' | 'lance' | 'surreal';

    /** Open a write session for one batch run. */
    begin(opts: BulkLoaderOpts): Promise<void>;

    /** Append a batch of rows. Returns per-batch counts + errors. */
    writeBatch(rows: Row[]): Promise<BatchResult>;

    /** Flush in-flight buffers without ending the transaction.
     *  Z2 default impl is no-op; Z3 will wire crash-resumable
     *  checkpoints into load_jobs. */
    checkpoint(): Promise<BulkLoaderCheckpoint>;

    /** Commit the transaction / close the Arrow batcher. */
    commit(): Promise<void>;

    /** Abandon the transaction. Adapters that already auto-committed
     *  per writeBatch (LanceDB append) treat this as a no-op. */
    rollback(): Promise<void>;
}

// ─── Graph bulk-load row shapes + shared validator (engine-neutral) ────────
// These describe the rows `loadJobsRunner.routeJsonlObject` produces for ANY
// graph substrate — id/type/label/content for nodes, from/to/relationship
// for edges — so they live next to the adapter contract rather than in a
// substrate-specific file.

/** Graph node row shape. Matches LoreNode fields the runner produces. */
export interface GraphNodeRow {
    id: string;
    type: string;
    label: string;
    content: string;
    tags?: string[] | string;
    project?: string;
    ecosystem?: string;
    metadata?: string;
    workspace: string;
}

/** Graph edge row shape. */
export interface GraphEdgeRow {
    from: string;
    to: string;
    relationship: string;
    workspace: string;
    metadata?: string;
}

export type GraphRow =
    | { kind: 'node'; row: GraphNodeRow }
    | { kind: 'edge'; row: GraphEdgeRow };

/**
 * Per-row shape validation shared by every graph-substrate adapter. Same
 * checks + messages for every engine so a row is accepted or rejected
 * identically whichever substrate backs the workspace. Returns null when
 * the row is acceptable, else a machine-readable error string for
 * BatchResult.errors[].
 */
export function validateRow(row: GraphRow | undefined, expectedWorkspace: string): string | null {
    if (!row) return 'null_row';
    if (row.kind === 'node') {
        if (!row.row || typeof row.row.id !== 'string' || row.row.id.length === 0) {
            return 'missing_or_invalid_id';
        }
        if (row.row.workspace !== expectedWorkspace) {
            return `workspace_mismatch (expected ${expectedWorkspace}, got ${row.row.workspace})`;
        }
        return null;
    }
    if (row.kind === 'edge') {
        if (!row.row?.from || !row.row?.to || !row.row?.relationship) {
            return 'edge_missing_fields';
        }
        if (row.row.workspace !== expectedWorkspace) {
            return `workspace_mismatch (expected ${expectedWorkspace}, got ${row.row.workspace})`;
        }
        return null;
    }
    return 'unknown_row_kind';
}
