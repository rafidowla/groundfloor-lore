/**
 * pendingOps.ts — Storage for second-party-approval-pending Lore ops.
 *
 * Per AUTH_AND_SYNC_DESIGN.md: when an operation tagged
 * `second-party` lands at the route handler, instead of executing
 * we capture its intent into the pending-ops queue. A different human
 * with `administer` (or the policy-specified narrower permission)
 * approves or rejects via `POST /api/approvals/{id}/decision`. On
 * approve, the op is replayed by the original handler.
 *
 * Storage:
 *   Local mode → SQLite at `.lore/pending-ops.sqlite` (this PR ships
 *                 the schema + a Kùzu-backed PendingOpsStore).
 *   Cloud mode  → Postgres collection (Bucket B/C follow-up; the
 *                 interface here is shaped to plug into both).
 *
 * Wire shape:
 *   {
 *     id:           UUID
 *     operation:    'forget_person' / 'drop_workspace' / etc.
 *     workspaceId:  scope of the op (matches X-Lore-Workspace)
 *     initiator:    portal_user id of the requester
 *     argsJson:     JSON-encoded args envelope (replayed on approve)
 *     status:       'pending' | 'approved' | 'rejected' | 'executed' | 'expired'
 *     createdAt / decidedAt / executedAt — ISO 8601
 *     decidedBy:    portal_user id of the approver
 *     decidedReason: free-text rationale (audit)
 *   }
 *
 * Lifecycle:
 *   pending → approved/rejected → (if approved) executed/failed
 *   pending → expired (after configurable TTL, default 7d)
 *
 * Idempotency:
 *   Re-deciding a non-pending op is a no-op (returns the existing
 *   row). Re-executing an already-executed op is also a no-op.
 *   Approver === initiator is rejected with a clear error.
 */

import { randomUUID } from 'node:crypto';

export type PendingOpStatus =
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'executed'
    | 'expired';

export interface PendingOp {
    id: string;
    operation: string;
    workspaceId: string;
    initiator: string;
    argsJson: string;
    status: PendingOpStatus;
    createdAt: string;
    decidedAt?: string;
    executedAt?: string;
    decidedBy?: string;
    decidedReason?: string;
    /** Free-text rationale captured at enqueue time. Surfaces in the approval UI. */
    enqueueRationale?: string;
    /**
     * Permission the second-party approver must hold to decide this op,
     * computed by decideApproval at enqueue time and persisted on the row so
     * the decision endpoint can enforce the correct (possibly narrower) gate.
     * Literal is inlined (not imported from humanApproval) to avoid an import
     * cycle. Optional/back-compat: pre-existing rows read back as undefined.
     */
    approverPermission?: 'administer' | 'manage_members';
}

export interface EnqueueInput {
    operation: string;
    workspaceId: string;
    initiator: string;
    args: unknown;
    enqueueRationale?: string;
    approverPermission?: 'administer' | 'manage_members';
}

export interface DecisionInput {
    id: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    reason?: string;
}

/**
 * Backend interface — separate impls for Kùzu (local) + Postgres-via-
 * Dataplane (cloud). The route handlers + decision endpoints depend
 * only on this interface.
 */
export interface PendingOpsStore {
    enqueue(input: EnqueueInput): Promise<PendingOp>;
    getById(id: string): Promise<PendingOp | null>;
    list(opts?: ListPendingOpsOpts): Promise<PendingOp[]>;
    decide(input: DecisionInput): Promise<PendingOp>;
    /** Mark the op `executed` (called after the op replay succeeds). */
    markExecuted(id: string): Promise<PendingOp>;
    /** Sweep ops past the TTL → status='expired'. Returns count. */
    expireOlderThan(cutoff: Date): Promise<number>;
}

export interface ListPendingOpsOpts {
    status?: PendingOpStatus;
    workspaceId?: string;
    initiator?: string;
    limit?: number;
}

/**
 * Pluggable id minter — tests inject a deterministic generator so
 * assertions don't depend on UUID randomness.
 */
export type IdMinter = () => string;
export const defaultIdMinter: IdMinter = () => randomUUID();

/**
 * Pluggable clock — same reason. `() => new Date().toISOString()` in
 * production; tests inject a fixed-time function.
 */
export type Clock = () => string;
export const defaultClock: Clock = () => new Date().toISOString();

/**
 * Errors the store may throw. Keep distinct so route handlers can map
 * each to the right HTTP status without parsing strings.
 */
export class PendingOpNotFoundError extends Error {
    constructor(public readonly id: string) {
        super(`pending op not found: ${id}`);
        this.name = 'PendingOpNotFoundError';
    }
}

export class SelfApprovalForbiddenError extends Error {
    constructor(public readonly id: string) {
        super(`approver must be a different user from the initiator (op ${id})`);
        this.name = 'SelfApprovalForbiddenError';
    }
}

export class PendingOpStaleError extends Error {
    constructor(public readonly id: string, public readonly currentStatus: PendingOpStatus) {
        super(`op ${id} is ${currentStatus}, no further action allowed`);
        this.name = 'PendingOpStaleError';
    }
}
