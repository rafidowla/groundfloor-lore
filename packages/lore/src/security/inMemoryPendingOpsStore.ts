/**
 * inMemoryPendingOpsStore.ts — Process-local PendingOpsStore.
 *
 * Two uses:
 *   1. Test fixtures — exercises the queue lifecycle without disk.
 *   2. Cloud-mode placeholder, until the persistent Postgres-via-Dataplane
 *      impl lands (see `mcp/services.ts`'s `createPendingOpsStore`). Trades
 *      durability for "works today"; ops queued here are lost on daemon
 *      restart, which is acceptable because:
 *        - second-party flows are rare-by-design; daemon restarts
 *          mid-flow get a refresh + the initiator re-submits.
 *        - the audit log captures the enqueue regardless, so nothing
 *          is silently dropped.
 *
 * Local mode uses the durable `SqlitePendingOpsStore` instead, which drops
 * straight in via the same `PendingOpsStore` interface.
 */

import {
    type PendingOp,
    type PendingOpStatus,
    type PendingOpsStore,
    type EnqueueInput,
    type DecisionInput,
    type ListPendingOpsOpts,
    type IdMinter,
    type Clock,
    defaultIdMinter,
    defaultClock,
    PendingOpNotFoundError,
    PendingOpStaleError,
    SelfApprovalForbiddenError,
} from './pendingOps.js';

/** SP-11 — terminal rows (executed/rejected/expired) older than this many
 *  ms past their last transition are dropped from the in-memory Map by
 *  expireOlderThan(). Without this, every approval-flow op accumulated for
 *  the daemon's lifetime even after it reached a terminal state. 7 days
 *  keeps recent history queryable while bounding growth. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_STATES: ReadonlySet<PendingOpStatus> = new Set<PendingOpStatus>([
    'executed',
    'rejected',
    'expired',
]);

/** Most-recent transition timestamp for a row — used to age terminal rows. */
function lastTransitionAt(row: PendingOp): string {
    return row.executedAt ?? row.decidedAt ?? row.createdAt;
}

export class InMemoryPendingOpsStore implements PendingOpsStore {
    private readonly rows = new Map<string, PendingOp>();
    private readonly mintId: IdMinter;
    private readonly now: Clock;

    constructor(opts: { mintId?: IdMinter; clock?: Clock } = {}) {
        this.mintId = opts.mintId ?? defaultIdMinter;
        this.now = opts.clock ?? defaultClock;
    }

    async enqueue(input: EnqueueInput): Promise<PendingOp> {
        const id = this.mintId();
        const row: PendingOp = {
            id,
            operation: input.operation,
            workspaceId: input.workspaceId,
            initiator: input.initiator,
            argsJson: JSON.stringify(input.args ?? null),
            status: 'pending',
            createdAt: this.now(),
            enqueueRationale: input.enqueueRationale,
            approverPermission: input.approverPermission,
        };
        this.rows.set(id, row);
        return { ...row };
    }

    async getById(id: string): Promise<PendingOp | null> {
        const row = this.rows.get(id);
        return row ? { ...row } : null;
    }

    async list(opts: ListPendingOpsOpts = {}): Promise<PendingOp[]> {
        const all = Array.from(this.rows.values()).filter((r) => {
            if (opts.status && r.status !== opts.status) return false;
            if (opts.workspaceId && r.workspaceId !== opts.workspaceId) return false;
            if (opts.initiator && r.initiator !== opts.initiator) return false;
            return true;
        });
        // Most-recent first — matches what an approval UI wants by default.
        all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const limited = typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all;
        return limited.map((r) => ({ ...r }));
    }

    async decide(input: DecisionInput): Promise<PendingOp> {
        const row = this.rows.get(input.id);
        if (!row) throw new PendingOpNotFoundError(input.id);
        if (row.initiator === input.decidedBy) throw new SelfApprovalForbiddenError(input.id);
        if (row.status !== 'pending') throw new PendingOpStaleError(input.id, row.status);
        const updated: PendingOp = {
            ...row,
            status: input.decision,
            decidedAt: this.now(),
            decidedBy: input.decidedBy,
            decidedReason: input.reason,
        };
        this.rows.set(updated.id, updated);
        return { ...updated };
    }

    async markExecuted(id: string): Promise<PendingOp> {
        const row = this.rows.get(id);
        if (!row) throw new PendingOpNotFoundError(id);
        if (row.status !== 'approved') throw new PendingOpStaleError(id, row.status);
        const updated: PendingOp = {
            ...row,
            status: 'executed',
            executedAt: this.now(),
        };
        this.rows.set(id, updated);
        return { ...updated };
    }

    async expireOlderThan(cutoff: Date): Promise<number> {
        let count = 0;
        const cutoffStr = cutoff.toISOString();
        for (const [id, row] of this.rows) {
            if (row.status === 'pending' && row.createdAt < cutoffStr) {
                this.rows.set(id, { ...row, status: 'expired' as PendingOpStatus });
                count += 1;
            }
        }
        // SP-11 — drop terminal rows past the retention horizon so the
        // in-memory Map doesn't accumulate executed/rejected/expired ops
        // for the daemon's lifetime. Runs in the same sweep so no extra
        // tick is needed; the audit log already durably records each op.
        this.cleanupTerminalRows();
        return count;
    }

    /**
     * SP-11 — remove terminal-state rows whose last transition is older
     * than TERMINAL_RETENTION_MS relative to `now()`. Returns the count
     * removed. Exposed for the regression test and for any explicit
     * maintenance tick; expireOlderThan also calls it.
     */
    cleanupTerminalRows(): number {
        const horizon = new Date(Date.parse(this.now()) - TERMINAL_RETENTION_MS).toISOString();
        let removed = 0;
        for (const [id, row] of this.rows) {
            if (TERMINAL_STATES.has(row.status) && lastTransitionAt(row) < horizon) {
                this.rows.delete(id);
                removed += 1;
            }
        }
        return removed;
    }

    /** SP-11 test/observability hook — current row count. */
    size(): number {
        return this.rows.size;
    }
}
