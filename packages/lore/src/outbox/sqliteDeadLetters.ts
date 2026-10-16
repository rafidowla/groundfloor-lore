/**
 * sqliteDeadLetters.ts - 3.35.0 (a)/(p): the SQLite outbox's transient-failure bookkeeping and
 * dead-letter queries, split out of sqliteStore.ts (file-size cap).
 *
 * Three additive columns on outbox_entries (older files are migrated in place on open):
 *   firstTransientAt  ISO time of the row's FIRST transient failure; persisted so a daemon
 *                     restart does not reset the transient time ceiling.
 *   transientRetries  transient failures so far (NOT part of `attempts`).
 *   deadReason        reason class a row was dead-lettered with (failureDisposition.ts).
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { SUPERSEDED_DEAD_ERROR } from './supersession.js';
import type { Row } from './sqliteRows.js';

/** Hard cap on one dead-letter page (the route clamps to this too). */
export const MAX_DEAD_PAGE = 200;

/** Idempotent additive migration; only a duplicate-column error is swallowed. */
export function ensureTransientColumns(db: DatabaseType): void {
    for (const ddl of [
        `ALTER TABLE outbox_entries ADD COLUMN firstTransientAt TEXT`,
        `ALTER TABLE outbox_entries ADD COLUMN transientRetries INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE outbox_entries ADD COLUMN deadReason TEXT`,
    ]) {
        try {
            db.exec(ddl);
        } catch (err) {
            if (!/duplicate column/i.test((err as Error).message)) throw err;
        }
    }
}

/** Mark a row 'failed' for a later replay WITHOUT counting an attempt. One synchronous
 *  transaction (same reasoning as markEntryStatus: the daemon and the drain CLI may race). */
export function recordTransientFailureOf(
    db: DatabaseType,
    id: string,
    info: { error: string; nextAttemptAt: string },
    maxErrorLen: number,
): { firstTransientAt: string; transientRetries: number } | undefined {
    const txn = db.transaction((): { firstTransientAt: string; transientRetries: number } | undefined => {
        const now = new Date().toISOString();
        const res = db.prepare(
            `UPDATE outbox_entries SET
               status = 'failed',
               transientRetries = transientRetries + 1,
               firstTransientAt = COALESCE(firstTransientAt, ?),
               lastError = ?, failedAt = ?, nextAttemptAt = ?, updatedAt = ?
             WHERE id = ?`,
        ).run(now, info.error.slice(0, maxErrorLen), now, info.nextAttemptAt, now, id);
        if (res.changes === 0) return undefined;
        return db.prepare(`SELECT firstTransientAt, transientRetries FROM outbox_entries WHERE id = ?`)
            .get(id) as { firstTransientAt: string; transientRetries: number };
    });
    return txn();
}

export function listDeadOf(db: DatabaseType, opts?: { workspace?: string | null; limit?: number }): Row[] {
    const limit = Math.max(0, opts?.limit ?? 500);
    const ws = opts?.workspace ?? null;
    return ws === null
        ? db.prepare(
            `SELECT * FROM outbox_entries WHERE status = 'dead'
               ORDER BY workspace ASC, sequenceId ASC LIMIT ?`).all(limit) as Row[]
        : db.prepare(
            `SELECT * FROM outbox_entries WHERE status = 'dead' AND workspace = ?
               ORDER BY sequenceId ASC LIMIT ?`).all(ws, limit) as Row[];
}

/** One workspace's dead rows, newest dead first, clamped to {@link MAX_DEAD_PAGE}. */
export function listDeadPageOf(db: DatabaseType, opts: { workspace: string; limit?: number; offset?: number }): Row[] {
    const limit = Math.min(MAX_DEAD_PAGE, Math.max(0, Math.floor(opts.limit ?? 50)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    return db.prepare(
        `SELECT * FROM outbox_entries WHERE status = 'dead' AND workspace = ?
          ORDER BY COALESCE(failedAt, updatedAt) DESC, sequenceId DESC LIMIT ? OFFSET ?`,
    ).all(opts.workspace, limit, offset) as Row[];
}

/** SQL fragment: the reason class of a dead row, deriving it for rows that predate the column. */
export const DEAD_REASON_SQL =
    `COALESCE(deadReason, CASE WHEN lastError = '${SUPERSEDED_DEAD_ERROR.replace(/'/g, "''")}' THEN 'superseded' ELSE 'unclassified' END)`;

/** Dead rows per workspace per reason class. */
export function deadReasonCounts(db: DatabaseType): { workspace: string; reason: string; n: number }[] {
    return db.prepare(
        `SELECT workspace, ${DEAD_REASON_SQL} AS reason, COUNT(*) AS n
           FROM outbox_entries WHERE status = 'dead' GROUP BY workspace, reason`,
    ).all() as { workspace: string; reason: string; n: number }[];
}

/** See the OutboxStore.requeueDead contract in types.ts - in particular WHY this requeues to
 *  'failed' rather than 'pending' (the RA-6 supersession guard only runs on 'failed', and stale
 *  rows are exactly what it protects against). Also clears the transient bookkeeping so a
 *  requeued row gets a fresh ceiling. */
export function requeueDeadOf(
    db: DatabaseType,
    opts?: { workspace?: string | null; operationKind?: string; errorContains?: string; limit?: number },
): number {
    const limit = Math.max(0, opts?.limit ?? 500);
    if (limit === 0) return 0;
    const where: string[] = [`status = 'dead'`];
    const params: unknown[] = [];
    if (opts?.workspace) { where.push(`workspace = ?`); params.push(opts.workspace); }
    if (opts?.operationKind) { where.push(`operationKind = ?`); params.push(opts.operationKind); }
    if (opts?.errorContains) {
        // LIKE with the operand escaped: the caller's string is matched
        // literally, so an error text containing % or _ selects only itself.
        where.push(`lastError LIKE ? ESCAPE '\\'`);
        params.push(`%${opts.errorContains.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const now = new Date().toISOString();
    // Subselect + LIMIT rather than `UPDATE ... LIMIT`: better-sqlite3 builds
    // don't guarantee SQLITE_ENABLE_UPDATE_DELETE_LIMIT (same reason
    // pruneReplicated is written this way).
    const info = db.prepare(
        `UPDATE outbox_entries
            SET status = 'failed', attempts = 0, lastError = NULL,
                failedAt = NULL, nextAttemptAt = NULL, completed = 0,
                firstTransientAt = NULL, transientRetries = 0, deadReason = NULL,
                updatedAt = ?
          WHERE id IN (
                SELECT id FROM outbox_entries
                 WHERE ${where.join(' AND ')}
                 ORDER BY workspace ASC, sequenceId ASC
                 LIMIT ?)`,
    ).run(now, ...params, limit);
    return info.changes;
}

/** One workspace's dead-letter counts: `deadLettered` excludes RA-6-superseded rows (nothing is missing for those). */
export function deadSummaryOf(db: DatabaseType, workspace: string): { deadLettered: number; deadSuperseded: number; deadByReason: Record<string, number> } {
    const rows = db.prepare(
        `SELECT ${DEAD_REASON_SQL} AS reason, COUNT(*) AS n
           FROM outbox_entries WHERE status = 'dead' AND workspace = ? GROUP BY reason`,
    ).all(workspace) as { reason: string; n: number }[];
    const deadByReason: Record<string, number> = {};
    let total = 0;
    for (const r of rows) { deadByReason[r.reason] = r.n; total += r.n; }
    const deadSuperseded = deadByReason.superseded ?? 0;
    return { deadLettered: total - deadSuperseded, deadSuperseded, deadByReason };
}
