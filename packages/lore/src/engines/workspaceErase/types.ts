/**
 * workspaceErase/types.ts — the contract every per-store workspace eraser implements.
 *
 * "Delete means delete" (Rafi 2026-10-25): once a workspace delete is confirmed and its recovery
 * window has passed (or "erase now" was asked for), every copy Lore controls is erased — rows,
 * history, indexes, queues, caches, uploaded source files — and a receipt with counts is written
 * to the deletion log (`config/deletedWorkspaces.ts`). Each store that can hold workspace data
 * provides one `WorkspaceEraser`; the lifecycle runs all applicable erasers and records the
 * combined result.
 *
 * Rules every eraser follows:
 *   - Match ONLY by the permanent workspace id (`EraseTarget.id`) — never by name alone. Data that
 *     cannot be proven to belong to the target is left alone and reported, never guessed at.
 *   - Idempotent: running again after a full or partial erase is safe and finishes the job.
 *   - Verify after erasing: `remaining` holds what is still there after a fresh count (0 = gone).
 *   - Bounded work per statement/transaction (batches), so a large workspace does not hold long locks.
 *   - Never throw for "nothing to erase"; throw only for unexpected failures (caller retries later).
 */

export interface EraseTarget {
    /** Permanent workspace id (config/workspaceIds.ts) — the ONLY matching key. */
    id: string;
    /** Informational (logs / receipts); never used for matching. */
    name: string;
    /** The workspace's registered data directory at deletion time (local stores). */
    path: string;
    /** Deployment mode recorded at deletion time ('local' | 'cloud' | 'local-sync' | null). */
    mode: string | null;
    /** Org id recorded at deletion time (cloud), else null. */
    orgId: string | null;
    /**
     * Lane f6b (additive, optional) — hidden holding folder the local data dir was renamed to when the
     * workspace was deleted (`.erase-hold-<id>`). Absent/null for a legacy delete (use `path`) or when
     * nothing was held. Only the local-dir eraser reads it.
     */
    holdingPath?: string | null;
    /**
     * Lane f6c (additive, optional) — graph engine the registry entry declared at deletion time ('postgres', 'sqlite',
     * 'surreal', ...), taken from the deletion record's saved entry. Absent/null when the record has none (legacy delete)
     * or the entry declared none. Lets a host-level eraser tell whether a server-engine store can hold this workspace's data.
     */
    engine?: string | null;
    /**
     * Additive, optional — when the workspace was created / deleted (from the deletion record). Only the audit-log eraser
     * reads them, to bound a name-only match to the workspace's own lifetime. Absent = unknown.
     */
    createdAt?: string | null;
    deletedAt?: string;
}

export type EraseStatus =
    /** Everything this store held for the workspace is gone (verified count = 0). */
    | 'complete'
    /** Some data removed, some still remains — the caller retries later. */
    | 'partial'
    /** This store holds nothing for this workspace / is not configured in this deployment. */
    | 'not-applicable'
    /** Erase ran, but the store cannot prove what remains (e.g. no count API). */
    | 'unverifiable';

export interface EraseStepResult {
    /** Store label, e.g. 'local-dir', 'postgres', 'dataplane', 'blobs-fs', 'blobs-groundfloor', 'keyring'. */
    store: string;
    status: EraseStatus;
    /** What was removed, per table/collection/kind (rows, files, bytes ...). */
    removed: Record<string, number>;
    /** What a fresh count found AFTER erasing, per table/collection/kind (all 0 when complete). */
    remaining: Record<string, number>;
    /** Plain-language note (why partial / not-applicable / unverifiable). Never contains secrets. */
    detail?: string;
}

export interface EraseOptions {
    signal?: AbortSignal;
}

export interface WorkspaceEraser {
    /** Store label, same as `EraseStepResult.store`. */
    readonly store: string;
    erase(target: EraseTarget, opts?: EraseOptions): Promise<EraseStepResult>;
}
