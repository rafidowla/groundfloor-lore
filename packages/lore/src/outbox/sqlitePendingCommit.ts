/**
 * sqlitePendingCommit.ts - SQLite side of the 3.35.0 (R3) `pending_commit` outbox row state, split out
 * of sqliteStore.ts (file-size cap).
 *
 * `status` is a free TEXT column, so the new state needs no schema change: rows written by an older
 * build carry 'pending'/'replicating'/... and are therefore "ready" by construction, and the claim and
 * list queries (`status IN ('pending','failed')`) never see a 'pending_commit' row.
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { rowToEntry, type Row } from './sqliteRows.js';
import type { OutboxEntry } from './types.js';

/** Flip `pending_commit` rows to `pending` (the graph commit they were recorded ahead of succeeded). Returns rows flipped. */
export function markCommittedOf(db: DatabaseType, ids: string[]): number {
    if (ids.length === 0) return 0;
    const stmt = db.prepare(`UPDATE outbox_entries SET status = 'pending', updatedAt = ? WHERE id = ? AND status = 'pending_commit'`);
    const now = new Date().toISOString();
    return db.transaction((all: string[]) => all.reduce((n, id) => n + stmt.run(now, id).changes, 0))(ids) as number;
}

export function listPendingCommitOf(db: DatabaseType, limit = 500): OutboxEntry[] {
    const rows = db.prepare(`SELECT * FROM outbox_entries WHERE status = 'pending_commit' ORDER BY createdAt ASC, sequenceId ASC LIMIT ?`).all(Math.max(0, limit)) as Row[];
    return rows.map(rowToEntry);
}

/** Per-workspace count of `pending_commit` rows (kept out of depth, lag and dead). */
export function pendingCommitCounts(db: DatabaseType): Array<{ workspace: string; n: number }> {
    return db.prepare(`SELECT workspace, COUNT(*) AS n FROM outbox_entries WHERE status = 'pending_commit' GROUP BY workspace`).all() as Array<{ workspace: string; n: number }>;
}
