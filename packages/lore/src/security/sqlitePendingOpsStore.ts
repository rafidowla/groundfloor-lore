/**
 * sqlitePendingOpsStore.ts — the HITL second-party-approval queue, on SQLite.
 *
 * Replaces the former graph-native pending-ops store, which was one of only
 * two subsystems still issuing real graph DDL (`CREATE NODE TABLE
 * lore_pending_op`). The queue is row-shaped, not graph-shaped: it has never
 * stored an edge, and every query it runs is a filtered scan of one table.
 * The graph engine was never buying it anything.
 *
 * ── A RACE THIS FIXES, RATHER THAN PORTS ────────────────────────────────────
 *
 * The former version decides in two steps: `getById`, check
 * `status !== 'pending'`, then `SET n.status = ...`. Nothing holds between the
 * read and the write, so two approvers racing on one op can BOTH observe
 * `pending` and both write — the second silently overwriting the first's
 * decision, reason and identity. On an approval queue whose entire purpose is
 * "a second party must sign off", that is the failure that matters: the audit
 * row ends up naming one approver for a decision two people made.
 *
 * Here the guard is inside the UPDATE:
 *
 *     UPDATE ... SET status = ? WHERE id = ? AND status = 'pending'
 *
 * SQLite applies that atomically, so exactly one racer reports `changes === 1`
 * and the loser is told the op is stale — which is true. The pre-read remains,
 * but only to produce the RIGHT ERROR (not-found vs self-approval vs stale);
 * it is no longer what enforces the transition.
 *
 * ── SCHEMA NOTE ─────────────────────────────────────────────────────────────
 *
 * Optional columns are stored as SQL NULL and read back as `undefined`, which
 * is what `PendingOp` declares. The former version wrote `''` for absent reasons
 * (its binding had no clean null path), so a rejected-with-no-reason op read
 * back as an empty-string reason rather than "no reason given". Preserved as
 * NULL here; `rowToPendingOp` maps empty string to undefined as well so rows
 * written by the old store keep reading the same way.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
    PendingOpNotFoundError,
    PendingOpStaleError,
    SelfApprovalForbiddenError,
    defaultClock,
    defaultIdMinter,
    type Clock,
    type DecisionInput,
    type EnqueueInput,
    type IdMinter,
    type ListPendingOpsOpts,
    type PendingOp,
    type PendingOpsStore,
} from './pendingOps.js';

const TABLE = 'lore_pending_op';

/** SQL NULL / legacy empty-string → undefined, per the `PendingOp` contract. */
function opt(v: unknown): string | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    return String(v);
}

interface Row {
    id: string;
    operation: string;
    workspaceId: string;
    initiator: string;
    argsJson: string;
    status: string;
    createdAt: string;
    decidedAt: string | null;
    executedAt: string | null;
    decidedBy: string | null;
    decidedReason: string | null;
    enqueueRationale: string | null;
    approverPermission: string | null;
}

function rowToPendingOp(r: Row): PendingOp {
    const op: PendingOp = {
        id: r.id,
        operation: r.operation,
        workspaceId: r.workspaceId,
        initiator: r.initiator,
        argsJson: r.argsJson,
        status: r.status as PendingOp['status'],
        createdAt: r.createdAt,
    };
    const decidedAt = opt(r.decidedAt);
    if (decidedAt) op.decidedAt = decidedAt;
    const executedAt = opt(r.executedAt);
    if (executedAt) op.executedAt = executedAt;
    const decidedBy = opt(r.decidedBy);
    if (decidedBy) op.decidedBy = decidedBy;
    const decidedReason = opt(r.decidedReason);
    if (decidedReason) op.decidedReason = decidedReason;
    const rationale = opt(r.enqueueRationale);
    if (rationale) op.enqueueRationale = rationale;
    const perm = opt(r.approverPermission);
    if (perm) op.approverPermission = perm as PendingOp['approverPermission'];
    return op;
}

export class SqlitePendingOpsStore implements PendingOpsStore {
    private readonly db: DatabaseType;
    private readonly mintId: IdMinter;
    private readonly now: Clock;

    /**
     * @param dbPath   SQLite file, or ':memory:'. Shares the workspace's
     *                 `.lore/` directory with the collection tables but keeps
     *                 its own file: the approval queue is security state with a
     *                 different lifecycle from user collections, and a caller
     *                 truncating collections must not be able to drop approvals.
     */
    constructor(dbPath: string, mintId: IdMinter = defaultIdMinter, now: Clock = defaultClock) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.mintId = mintId;
        this.now = now;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                id                 TEXT PRIMARY KEY,
                operation          TEXT NOT NULL,
                workspaceId        TEXT NOT NULL,
                initiator          TEXT NOT NULL,
                argsJson           TEXT NOT NULL,
                status             TEXT NOT NULL,
                createdAt          TEXT NOT NULL,
                decidedAt          TEXT,
                executedAt         TEXT,
                decidedBy          TEXT,
                decidedReason      TEXT,
                enqueueRationale   TEXT,
                approverPermission TEXT
            );
            -- list() always filters on some combination of these and orders by
            -- createdAt, which is also the sweep predicate.
            CREATE INDEX IF NOT EXISTS ${TABLE}_status_created
                ON ${TABLE}(status, createdAt DESC);
            CREATE INDEX IF NOT EXISTS ${TABLE}_workspace
                ON ${TABLE}(workspaceId);
        `);
    }

    close(): void {
        if (this.db.open) this.db.close();
    }

    async enqueue(input: EnqueueInput): Promise<PendingOp> {
        const op: PendingOp = {
            id: this.mintId(),
            operation: input.operation,
            workspaceId: input.workspaceId,
            initiator: input.initiator,
            argsJson: JSON.stringify(input.args ?? null),
            status: 'pending',
            createdAt: this.now(),
        };
        if (input.enqueueRationale) op.enqueueRationale = input.enqueueRationale;
        if (input.approverPermission) op.approverPermission = input.approverPermission;
        this.db.prepare(
            `INSERT INTO ${TABLE}
                (id, operation, workspaceId, initiator, argsJson, status, createdAt,
                 enqueueRationale, approverPermission)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            op.id, op.operation, op.workspaceId, op.initiator, op.argsJson,
            op.status, op.createdAt,
            op.enqueueRationale ?? null, op.approverPermission ?? null,
        );
        return op;
    }

    async getById(id: string): Promise<PendingOp | null> {
        const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as Row | undefined;
        return row ? rowToPendingOp(row) : null;
    }

    async list(opts: ListPendingOpsOpts = {}): Promise<PendingOp[]> {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (opts.status) { clauses.push('status = ?'); params.push(opts.status); }
        if (opts.workspaceId) { clauses.push('workspaceId = ?'); params.push(opts.workspaceId); }
        if (opts.initiator) { clauses.push('initiator = ?'); params.push(opts.initiator); }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        // LIMIT is bound, not interpolated. The former version inlined
        // `Math.floor(opts.limit)`, which was safe only because of that floor.
        const limit = typeof opts.limit === 'number' && opts.limit > 0 ? 'LIMIT ?' : '';
        if (limit) params.push(Math.floor(opts.limit as number));
        const rows = this.db.prepare(
            `SELECT * FROM ${TABLE} ${where} ORDER BY createdAt DESC ${limit}`,
        ).all(...params) as Row[];
        return rows.map(rowToPendingOp);
    }

    /**
     * Approve or reject. The transition is enforced by the UPDATE's own
     * `status = 'pending'` predicate, so concurrent deciders cannot both win.
     */
    async decide(input: DecisionInput): Promise<PendingOp> {
        const existing = await this.getById(input.id);
        if (!existing) throw new PendingOpNotFoundError(input.id);
        if (existing.initiator === input.decidedBy) throw new SelfApprovalForbiddenError(input.id);
        if (existing.status !== 'pending') throw new PendingOpStaleError(input.id, existing.status);
        const res = this.db.prepare(
            `UPDATE ${TABLE}
                SET status = ?, decidedAt = ?, decidedBy = ?, decidedReason = ?
              WHERE id = ? AND status = 'pending'`,
        ).run(input.decision, this.now(), input.decidedBy, input.reason ?? null, input.id);
        if (res.changes === 0) {
            // Lost a race between the read above and this write. Re-read to
            // report the status that actually won rather than the stale one.
            const current = await this.getById(input.id);
            throw new PendingOpStaleError(input.id, current?.status ?? 'expired');
        }
        const updated = await this.getById(input.id);
        if (!updated) throw new PendingOpNotFoundError(input.id);
        return updated;
    }

    /** Same atomicity: only an `approved` op can become `executed`, once. */
    async markExecuted(id: string): Promise<PendingOp> {
        const existing = await this.getById(id);
        if (!existing) throw new PendingOpNotFoundError(id);
        if (existing.status !== 'approved') throw new PendingOpStaleError(id, existing.status);
        const res = this.db.prepare(
            `UPDATE ${TABLE} SET status = 'executed', executedAt = ?
              WHERE id = ? AND status = 'approved'`,
        ).run(this.now(), id);
        if (res.changes === 0) {
            const current = await this.getById(id);
            throw new PendingOpStaleError(id, current?.status ?? 'expired');
        }
        const updated = await this.getById(id);
        if (!updated) throw new PendingOpNotFoundError(id);
        return updated;
    }

    /**
     * TTL sweep. One statement — the former version needed a pre-count because
     * its binding could not return an update count, which also meant the count
     * it reported came from a different read than the write it described.
     */
    async expireOlderThan(cutoff: Date): Promise<number> {
        const res = this.db.prepare(
            `UPDATE ${TABLE} SET status = 'expired'
              WHERE status = 'pending' AND createdAt < ?`,
        ).run(cutoff.toISOString());
        return res.changes;
    }
}
