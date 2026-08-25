/**
 * outbox/sqliteStore.ts — SQLite-backed OutboxStore (Sprint O3c).
 *
 * Replaces FileOutboxStore's whole-file-rewrite-on-every-mutation
 * pattern with per-row INSERT/UPDATE backed by SQLite (WAL mode).
 *
 * Why this exists:
 *   O3b perf measurement found outbox.json reached 22 MB / 11k entries
 *   and every record() + every replicator status update rewrote the
 *   ENTIRE file. A bulk write of 1000 nodes triggered ~1000 status
 *   updates ≈ 22 GB of I/O. The outbox-first architecture is correct;
 *   the JSON file backend was a shortcut that doesn't scale beyond
 *   ~500 entries.
 *
 * Implements the same `OutboxStore` interface as `FileOutboxStore`
 * (see types.ts) so the swap is invisible to callers. wiring.ts picks
 * the implementation based on LORE_OUTBOX_BACKEND env var (default
 * 'sqlite' post-O3c; 'json' for emergency rollback).
 *
 * Schema (created if not present at open time):
 *   outbox_entries          — one row per outbox entry
 *   outbox_replication_state — per-workspace replication cursor
 *
 * Migration from JSON: see migrateJsonOutbox() — runs on first open if
 * outbox.json exists and outbox.sqlite has no entries. Idempotent
 * (re-running is a no-op once SQLite has rows). Atomic at the
 * SQLite-transaction level: any failure rolls back AND leaves
 * outbox.json untouched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import type {
    OutboxAggregateStats,
    OutboxEntry,
    OutboxReplicationState,
    OutboxStatus,
    OutboxStore as IOutboxStore,
    OutboxWorkspaceStats,
    StepStatus,
} from './types.js';
import { supersessionFamilySql, type EntityFamily } from './supersession.js';
import {
    migrateJsonOutbox,
    DEFAULT_WORKSPACE_BACKFILL,
    type MigrationReport,
} from './sqliteJsonMigration.js';

// Re-exported so existing importers of MigrationReport from this module
// keep working after the extraction.
export type { MigrationReport } from './sqliteJsonMigration.js';

const SQLITE_FILE = 'outbox.sqlite';
const MAX_ERROR_LEN = 1024;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS outbox_entries (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  sequenceId      INTEGER NOT NULL,
  operationKind   TEXT NOT NULL,
  payload         TEXT,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  lastError       TEXT,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  replicatedAt    TEXT,
  failedAt        TEXT,
  nextAttemptAt   TEXT,
  steps           TEXT,
  operation       TEXT NOT NULL,
  initiator       TEXT NOT NULL,
  completed       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_workspace_seq ON outbox_entries(workspace, sequenceId);
CREATE INDEX IF NOT EXISTS idx_outbox_status_ws_created ON outbox_entries(status, workspace, createdAt);
CREATE INDEX IF NOT EXISTS idx_outbox_completed ON outbox_entries(completed);
CREATE INDEX IF NOT EXISTS idx_outbox_next_attempt ON outbox_entries(nextAttemptAt);

CREATE TABLE IF NOT EXISTS outbox_replication_state (
  workspace          TEXT PRIMARY KEY,
  lastReplicatedSeq  INTEGER NOT NULL,
  updatedAt          TEXT NOT NULL
);
`;

interface Row {
    id: string;
    workspace: string;
    sequenceId: number;
    operationKind: string;
    payload: string | null;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    replicatedAt: string | null;
    failedAt: string | null;
    /** SP-21: ISO timestamp before which a failed row should not be retried. */
    nextAttemptAt: string | null;
    steps: string | null;
    operation: string;
    initiator: string;
    completed: number;
}

function rowToEntry(r: Row): OutboxEntry {
    return {
        id: r.id,
        operation: r.operation,
        initiator: r.initiator,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        steps: r.steps ? JSON.parse(r.steps) : [],
        completed: !!r.completed,
        workspace: r.workspace,
        operationKind: r.operationKind as OutboxEntry['operationKind'],
        payload: r.payload ? JSON.parse(r.payload) : undefined,
        status: r.status as OutboxStatus,
        attempts: r.attempts,
        lastError: r.lastError ?? undefined,
        replicatedAt: r.replicatedAt ?? undefined,
        failedAt: r.failedAt ?? undefined,
        nextAttemptAt: r.nextAttemptAt ?? undefined,
        sequenceId: r.sequenceId,
    };
}

export class SqliteOutboxStore implements IOutboxStore {
    private readonly db: DatabaseType;
    private readonly dbPath: string;
    private readonly dir: string;
    private readonly retryBaseMs: number;

    constructor(loreDir: string, opts?: { retryBaseMs?: number }) {
        this.retryBaseMs = opts?.retryBaseMs ?? 500;
        fs.mkdirSync(loreDir, { recursive: true });
        this.dir = loreDir;
        this.dbPath = path.join(loreDir, SQLITE_FILE);
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA_SQL);
        // SP-21: add nextAttemptAt column to existing DBs that predate this migration.
        // ALTER TABLE ADD COLUMN is idempotent in SQLite (no-op if column exists)
        // but SQLite <3.37 does not support IF NOT EXISTS on ADD COLUMN, so we
        // try/catch and ignore the "duplicate column" error.
        // SW-06 (B9): narrow the catch to ONLY swallow "duplicate column". A real
        // migration/IO failure (disk full, corrupt schema, locked DB) must surface
        // here, not be masked into a confusing "no such column: nextAttemptAt"
        // error on the next query.
        try {
            this.db.exec(`ALTER TABLE outbox_entries ADD COLUMN nextAttemptAt TEXT`);
        } catch (err) {
            if (!/duplicate column/i.test((err as Error).message)) throw err;
            /* column already exists — no-op */
        }
    }

    get path(): string { return this.dbPath; }
    get directory(): string { return this.dir; }

    /** Close the underlying SQLite handle. Idempotent. */
    close(): void {
        try { this.db.close(); } catch { /* ignore double-close */ }
    }

    /** Per-workspace next sequenceId.
     *
     *  SP-F2 (2026-06-10): replicated rows are now pruned
     *  (pruneReplicated), so MAX(sequenceId) over surviving rows can go
     *  BACKWARDS after a sweep. The replication cursor is never pruned
     *  and records the high-water mark of everything successfully
     *  replicated — seed from whichever is larger so sequenceIds stay
     *  monotonic per workspace across prunes. */
    private nextSequenceId(workspace: string): number {
        const r = this.db.prepare(
            `SELECT COALESCE(MAX(sequenceId), 0) AS m FROM outbox_entries WHERE workspace = ?`,
        ).get(workspace) as { m: number };
        const c = this.db.prepare(
            `SELECT COALESCE(MAX(lastReplicatedSeq), 0) AS m FROM outbox_replication_state WHERE workspace = ?`,
        ).get(workspace) as { m: number };
        return Math.max(r.m, c.m) + 1;
    }

    private normalizeForWrite(entry: OutboxEntry): void {
        if (entry.operationKind !== undefined) {
            if (!entry.workspace || typeof entry.workspace !== 'string') {
                throw new Error(
                    `outbox: workspace is required for operationKind '${entry.operationKind}' entries (Sprint L invariant)`,
                );
            }
        } else {
            entry.workspace ??= DEFAULT_WORKSPACE_BACKFILL;
            entry.operationKind = 'sync.vector.mirror';
        }
        entry.status ??= 'pending';
        entry.attempts ??= 0;
        entry.updatedAt ??= entry.createdAt;
    }

    private upsertRow(entry: OutboxEntry): void {
        this.db.prepare(
            `INSERT OR REPLACE INTO outbox_entries
             (id, workspace, sequenceId, operationKind, payload, status,
              attempts, lastError, createdAt, updatedAt, replicatedAt,
              failedAt, nextAttemptAt, steps, operation, initiator, completed)
             VALUES
             (@id, @workspace, @sequenceId, @operationKind, @payload, @status,
              @attempts, @lastError, @createdAt, @updatedAt, @replicatedAt,
              @failedAt, @nextAttemptAt, @steps, @operation, @initiator, @completed)`,
        ).run({
            id: entry.id,
            workspace: entry.workspace,
            sequenceId: entry.sequenceId,
            operationKind: entry.operationKind,
            payload: entry.payload ? JSON.stringify(entry.payload) : null,
            status: entry.status,
            attempts: entry.attempts ?? 0,
            lastError: entry.lastError ?? null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            replicatedAt: entry.replicatedAt ?? null,
            failedAt: entry.failedAt ?? null,
            nextAttemptAt: entry.nextAttemptAt ?? null,
            steps: entry.steps ? JSON.stringify(entry.steps) : null,
            operation: entry.operation,
            initiator: entry.initiator,
            completed: entry.completed ? 1 : 0,
        });
    }

    async record(entry: OutboxEntry): Promise<void> {
        this.normalizeForWrite(entry);
        if (typeof entry.sequenceId !== 'number') {
            entry.sequenceId = this.nextSequenceId(entry.workspace!);
        }
        this.upsertRow(entry);
    }

    async batchRecord(entries: OutboxEntry[]): Promise<void> {
        if (entries.length === 0) return;
        // Allocate per-workspace sequenceIds once; transaction wraps all
        // INSERTs (single fsync).
        const nextSeqByWs: Record<string, number> = {};
        for (const e of entries) this.normalizeForWrite(e);
        const txn = this.db.transaction((rows: OutboxEntry[]) => {
            for (const entry of rows) {
                const ws = entry.workspace!;
                if (typeof entry.sequenceId !== 'number') {
                    if (nextSeqByWs[ws] === undefined) {
                        nextSeqByWs[ws] = this.nextSequenceId(ws);
                    }
                    entry.sequenceId = nextSeqByWs[ws]++;
                }
                this.upsertRow(entry);
            }
        });
        txn(entries);
    }

    async markStep(entryId: string, stepIndex: number, status: StepStatus, error?: string): Promise<void> {
        // SP-18 — wrap the read-modify-write in a synchronous better-sqlite3
        // transaction so two concurrent markStep() calls on the SAME entry but
        // DIFFERENT step indices (coordinator handler + self-heal sweep +
        // recovery worker can interleave on one row) cannot lost-update each
        // other. Pre-SP-18 the SELECT→JSON.parse→mutate-in-JS→UPDATE ran
        // un-serialized: both readers saw the same `steps` blob, each flipped
        // only its own step in its private copy, and the second UPDATE
        // overwrote the first's flip. The transaction serializes the whole
        // SELECT+UPDATE so each call sees the prior call's committed steps.
        const txn = this.db.transaction((id: string, idx: number, st: StepStatus, err?: string) => {
            const row = this.db.prepare(`SELECT steps, updatedAt FROM outbox_entries WHERE id = ?`).get(id) as
                { steps: string | null; updatedAt: string } | undefined;
            if (!row) return;
            const steps = row.steps ? JSON.parse(row.steps) as OutboxEntry['steps'] : [];
            const step = steps[idx];
            if (!step) return;
            const now = new Date().toISOString();
            step.status = st;
            if (!step.startedAt) step.startedAt = now;
            if (st === 'done' || st === 'failed') step.finishedAt = now;
            if (err) step.error = err.slice(0, MAX_ERROR_LEN);
            this.db.prepare(`UPDATE outbox_entries SET steps = ?, updatedAt = ? WHERE id = ?`)
                .run(JSON.stringify(steps), now, id);
        });
        txn(entryId, stepIndex, status, error);
    }

    /**
     * F-S03/S04/S05 — atomic completion decision for `withOutbox`.
     *
     * Reads the entry's `steps` blob and flips it to completed/'replicated'
     * inside ONE better-sqlite3 transaction, so the read-the-state →
     * decide → write happens with no window for a concurrent worker
     * (self-heal sweep, recovery, a racing markStep) to mutate the row
     * underfoot. The coordinator previously did this via a separate
     * listUnfinished() scan whose result could change between the scan and
     * the markCompleted() — that race is what this method closes.
     *
     * Returns true when the entry was found AND every step is 'done' (it
     * is now marked completed); false when the entry is missing or still
     * has an unfinished step (left untouched for recovery to pick up).
     */
    async completeIfAllStepsDone(entryId: string): Promise<boolean> {
        const txn = this.db.transaction((id: string): boolean => {
            const row = this.db.prepare(
                `SELECT steps, status FROM outbox_entries WHERE id = ?`,
            ).get(id) as { steps: string | null; status: string } | undefined;
            if (!row) return false;
            const steps = row.steps ? JSON.parse(row.steps) as OutboxEntry['steps'] : [];
            if (steps.some(s => s.status !== 'done')) return false;
            const now = new Date().toISOString();
            if (row.status !== 'replicated') {
                this.db.prepare(
                    `UPDATE outbox_entries SET completed = 1, updatedAt = ?, status = 'replicated', replicatedAt = ? WHERE id = ?`,
                ).run(now, now, id);
            } else {
                this.db.prepare(`UPDATE outbox_entries SET completed = 1, updatedAt = ? WHERE id = ?`)
                    .run(now, id);
            }
            return true;
        });
        return txn(entryId);
    }

    async markCompleted(entryId: string): Promise<void> {
        const row = this.db.prepare(`SELECT status FROM outbox_entries WHERE id = ?`).get(entryId) as
            { status: string } | undefined;
        if (!row) return;
        const now = new Date().toISOString();
        if (row.status !== 'replicated') {
            this.db.prepare(
                `UPDATE outbox_entries SET completed = 1, updatedAt = ?, status = 'replicated', replicatedAt = ? WHERE id = ?`,
            ).run(now, now, entryId);
        } else {
            this.db.prepare(`UPDATE outbox_entries SET completed = 1, updatedAt = ? WHERE id = ?`)
                .run(now, entryId);
        }
    }

    async remove(entryId: string): Promise<void> {
        this.db.prepare(`DELETE FROM outbox_entries WHERE id = ?`).run(entryId);
    }

    // C-R2-03 — conditional remove for rollback safety, SQLite backend (the
    // DEFAULT since O3c; previously only FileOutboxStore implemented this, so
    // rollback retraction on the production store silently degraded to the
    // racy unconditional remove() above). Only deletes the row while it is
    // still 'pending'. The conditional DELETE's WHERE clause is the
    // serialization point (better-sqlite3 statements are atomic): if the
    // replicator's markEntryStatus(id,'replicating') commits first, the
    // DELETE matches 0 rows and we return false so the caller compensates
    // (records a node.delete/edge.delete) instead of leaving an orphan the
    // in-flight replay resurrects. A missing row means nothing to replay.
    async removeIfPending(entryId: string): Promise<boolean> {
        const r = this.db.prepare(`DELETE FROM outbox_entries WHERE id = ? AND status = 'pending'`).run(entryId);
        if (r.changes > 0) return true;
        const row = this.db.prepare(`SELECT status FROM outbox_entries WHERE id = ?`).get(entryId) as { status: string } | undefined;
        // Row gone (never existed / already pruned) → nothing to replay.
        // Row present but claimed (replicating/failed/dead/replicated) →
        // the replicator owns it; the caller must compensate.
        return row === undefined;
    }

    /** Slice-4 — purge every row + the replication cursor for a workspace/lane
     *  key (arcade destroyApp right-to-be-forgotten). Deletes irrespective of
     *  status. Atomic (one transaction). Returns rows deleted. */
    async deleteByWorkspace(workspace: string): Promise<number> {
        const tx = this.db.transaction((ws: string) => {
            const r = this.db.prepare(`DELETE FROM outbox_entries WHERE workspace = ?`).run(ws);
            this.db.prepare(`DELETE FROM outbox_replication_state WHERE workspace = ?`).run(ws);
            return r.changes;
        });
        return tx(workspace) as number;
    }

    async listUnfinished(): Promise<OutboxEntry[]> {
        const rows = this.db.prepare(`SELECT * FROM outbox_entries WHERE completed = 0`).all() as Row[];
        return rows.map(rowToEntry);
    }

    async listPendingForWorkspace(workspace: string, limit: number): Promise<OutboxEntry[]> {
        // SP-21: exclude 'failed' rows whose nextAttemptAt is in the future.
        // Wrap in datetime() on both sides: ISO-8601 'T'-format timestamps (stored
        // by Date#toISOString) compare lexicographically GREATER than SQLite's
        // space-format 'YYYY-MM-DD HH:MM:SS', so raw string compare is wrong.
        // datetime() normalises both to the same format for a correct UTC comparison.
        const rows = this.db.prepare(
            `SELECT * FROM outbox_entries
             WHERE workspace = ? AND status IN ('pending', 'failed')
               AND (nextAttemptAt IS NULL OR datetime(nextAttemptAt) <= datetime('now'))
             ORDER BY sequenceId ASC
             LIMIT ?`,
        ).all(workspace, Math.max(0, limit)) as Row[];
        return rows.map(rowToEntry);
    }

    async listWorkspacesWithPending(): Promise<string[]> {
        const rows = this.db.prepare(
            `SELECT DISTINCT workspace FROM outbox_entries WHERE status IN ('pending', 'failed')`,
        ).all() as { workspace: string }[];
        return rows.map(r => r.workspace);
    }

    /**
     * SP-21: compute the ISO timestamp for the next retry using exponential
     * backoff. base=500ms, cap=30s, doubles per attempt.
     *   attempt 0 → +500ms, 1 → +1s, 2 → +2s, 3 → +4s, ... cap=30s
     */
    static computeNextAttemptAt(attempts: number, nowMs = Date.now(), baseMs = 500): string {
        const CAP_MS = 30_000;
        const backoffMs = Math.min(baseMs * Math.pow(2, attempts), CAP_MS);
        return new Date(nowMs + backoffMs).toISOString();
    }

    async markEntryStatus(
        entryId: string,
        status: OutboxStatus,
        info?: { error?: string; bumpAttempt?: boolean },
    ): Promise<void> {
        // SW-06 (B7) — wrap the read-modify-write in a synchronous better-sqlite3
        // transaction, mirroring the SP-18 fix on markStep. Pre-SW-06 the
        // SELECT attempts → compute-in-JS → UPDATE ran un-serialized: the daemon
        // replicator and the drain-CLI (or two replicator passes) racing the SAME
        // row both read the same `attempts`, each computed the same bumped value,
        // and the second UPDATE clobbered the first's bump. A row could thus
        // under-count attempts and dodge the dead-letter cutoff forever. The
        // bump is also done as `attempts = attempts + ?` in SQL so the increment
        // is computed against the row's committed value, not a stale JS snapshot.
        const txn = this.db.transaction((
            id: string,
            st: OutboxStatus,
            inf?: { error?: string; bumpAttempt?: boolean },
        ) => {
            const row = this.db.prepare(`SELECT attempts FROM outbox_entries WHERE id = ?`).get(id) as
                { attempts: number } | undefined;
            if (!row) return;
            const now = new Date().toISOString();
            const nowMs = Date.now();
            const bump = inf?.bumpAttempt ? 1 : 0;
            const attempts = row.attempts + bump;
            const lastError = inf?.error ? inf.error.slice(0, MAX_ERROR_LEN) : null;
            const replicatedAt = st === 'replicated' ? now : null;
            const failedAt = (st === 'failed' || st === 'dead') ? now : null;
            // SP-21: set nextAttemptAt with exponential backoff when marking failed.
            // Dead rows never retry, so nextAttemptAt is NULL for 'dead'.
            const nextAttemptAt = st === 'failed'
                ? SqliteOutboxStore.computeNextAttemptAt(attempts, nowMs, this.retryBaseMs)
                : null;
            const completed = st === 'replicated' ? 1 : 0;
            // Preserve existing replicatedAt/failedAt if status didn't transition
            // into them this call. attempts is bumped in SQL (`attempts + ?`) so
            // the increment is relative to the committed row, never a stale read.
            this.db.prepare(
                `UPDATE outbox_entries SET
                  status = ?,
                  attempts = attempts + ?,
                  updatedAt = ?,
                  lastError = COALESCE(?, lastError),
                  replicatedAt = COALESCE(?, replicatedAt),
                  failedAt = COALESCE(?, failedAt),
                  nextAttemptAt = ?,
                  completed = CASE WHEN ? = 1 THEN 1 ELSE completed END
                 WHERE id = ?`,
            ).run(st, bump, now, lastError, replicatedAt, failedAt, nextAttemptAt, completed, id);
        });
        txn(entryId, status, info);
    }

    /**
     * Sprint O6 (2026-05-24) — self-heal + operator-drain primitive.
     *
     * Returns `status='failed'` rows whose `failedAt` (fallback
     * `updatedAt`) is older than `olderThanMs` ms ago. Cheap: uses the
     * `idx_outbox_status_ws_created` index, evaluates the staleness
     * filter on the (tiny) failed slice only.
     *
     * Audit cluster 5 (2026-08-17): 'dead' rows are included ONLY when the
     * caller passes `includeDead: true` (the operator drain-failed path).
     * Previously EVERY caller got them, so the replicator's routine
     * self-heal tick swept dead-letter rows back to 'replicated' whenever
     * the substrate probe verified — silently emptying the dead-letter
     * queue whose entire purpose is to hold rows for a human decision.
     */
    async listFailedOlderThan(
        olderThanMs: number,
        opts?: { workspace?: string | null; limit?: number; includeDead?: boolean },
    ): Promise<OutboxEntry[]> {
        const cutoff = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
        const limit = Math.max(0, opts?.limit ?? 500);
        const ws = opts?.workspace ?? null;
        const statuses = opts?.includeDead ? `('failed', 'dead')` : `('failed')`;
        const sql = ws === null
            ? `SELECT * FROM outbox_entries
                 WHERE status IN ${statuses}
                   AND COALESCE(failedAt, updatedAt) <= ?
                 ORDER BY workspace ASC, sequenceId ASC
                 LIMIT ?`
            : `SELECT * FROM outbox_entries
                 WHERE status IN ${statuses} AND workspace = ?
                   AND COALESCE(failedAt, updatedAt) <= ?
                 ORDER BY sequenceId ASC
                 LIMIT ?`;
        const rows = ws === null
            ? this.db.prepare(sql).all(cutoff, limit) as Row[]
            : this.db.prepare(sql).all(ws, cutoff, limit) as Row[];
        return rows.map(rowToEntry);
    }

    async listDead(opts?: { workspace?: string | null; limit?: number }): Promise<OutboxEntry[]> {
        const limit = Math.max(0, opts?.limit ?? 500);
        const ws = opts?.workspace ?? null;
        const sql = ws === null
            ? `SELECT * FROM outbox_entries WHERE status = 'dead'
                 ORDER BY workspace ASC, sequenceId ASC LIMIT ?`
            : `SELECT * FROM outbox_entries WHERE status = 'dead' AND workspace = ?
                 ORDER BY sequenceId ASC LIMIT ?`;
        const rows = ws === null
            ? this.db.prepare(sql).all(limit) as Row[]
            : this.db.prepare(sql).all(ws, limit) as Row[];
        return rows.map(rowToEntry);
    }

    /** SP-F2 (2026-06-10) — retention sweep for replicated rows. See the
     *  OutboxStore.pruneReplicated contract in types.ts: only
     *  status='replicated' rows older than the cutoff are deleted;
     *  failed/dead rows and outbox_replication_state are untouched.
     *  Subquery + LIMIT (instead of DELETE ... LIMIT) because better-sqlite3
     *  builds don't guarantee SQLITE_ENABLE_UPDATE_DELETE_LIMIT. */
    async pruneReplicated(
        olderThanMs: number,
        opts?: { workspace?: string | null; limit?: number },
    ): Promise<number> {
        const cutoff = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
        const limit = Math.max(0, opts?.limit ?? 5000);
        const ws = opts?.workspace ?? null;
        const sql = ws === null
            ? `DELETE FROM outbox_entries WHERE id IN (
                 SELECT id FROM outbox_entries
                 WHERE status = 'replicated'
                   AND COALESCE(replicatedAt, updatedAt) <= ?
                 ORDER BY workspace ASC, sequenceId ASC
                 LIMIT ?)`
            : `DELETE FROM outbox_entries WHERE id IN (
                 SELECT id FROM outbox_entries
                 WHERE status = 'replicated' AND workspace = ?
                   AND COALESCE(replicatedAt, updatedAt) <= ?
                 ORDER BY sequenceId ASC
                 LIMIT ?)`;
        const info = ws === null
            ? this.db.prepare(sql).run(cutoff, limit)
            : this.db.prepare(sql).run(ws, cutoff, limit);
        return info.changes;
    }

    /**
     * F-S03/S04/S05 (RA-6 per-key watermark) + cross-kind generalization
     * (2026-07-05 durability fix) - has a NEWER row for the same ENTITY
     * (same workspace + same entity identity, ANY operationKind WITHIN the
     * same entity family) already reached 'replicated' past this row's
     * sequenceId?
     *
     * The replicator calls this before replaying a `status='failed'` row.
     * RA-6 originally scoped supersession to a SINGLE operationKind, which
     * only caught upsert-supersedes-upsert and missed the reverse-op
     * reorderings (a replicated node.delete must supersede a failed
     * node.upsert on the same id, else the retry RESURRECTS a deleted node;
     * and the three symmetric cases across node/edge). Supersession is
     * scoped BY ENTITY FAMILY (a node op never supersedes an edge op even
     * on a colliding key); the same-kind RA-6 behavior is a strict subset.
     * `key` is the family's canonical identity, matched via
     * supersessionFamilySql (keeps the SQL in lock-step with keyOfEntry). A
     * row with no extractable key/family never reaches here - the caller
     * falls through to the normal retry path. See outbox/supersession.ts.
     */
    async hasNewerReplicatedForKey(
        workspace: string,
        entityFamily: EntityFamily,
        key: string,
        sequenceId: number,
    ): Promise<boolean> {
        // Match the SAME entity identity across ALL kinds in the family.
        // supersessionFamilySql reproduces keyOfEntry()'s derivation so
        // upsert/delete rows on the same entity compare equal (shared with
        // the replicator so the two stay in lock-step).
        const familySql = supersessionFamilySql(entityFamily);
        const r = this.db.prepare(
            `SELECT 1 AS hit FROM outbox_entries
             WHERE workspace = ? AND status = 'replicated'
               AND operationKind IN ${familySql.kinds}
               AND sequenceId > ?
               AND ${familySql.keyExpr} = ?
             LIMIT 1`,
        ).get(workspace, sequenceId, key) as { hit: number } | undefined;
        return r !== undefined;
    }

    async readReplicationState(workspace: string): Promise<OutboxReplicationState> {
        const r = this.db.prepare(
            `SELECT lastReplicatedSeq, updatedAt FROM outbox_replication_state WHERE workspace = ?`,
        ).get(workspace) as { lastReplicatedSeq: number; updatedAt: string } | undefined;
        if (!r) {
            return { lastReplicatedSeq: 0, updatedAt: new Date(0).toISOString() };
        }
        return { lastReplicatedSeq: r.lastReplicatedSeq, updatedAt: r.updatedAt };
    }

    async writeReplicationState(workspace: string, state: OutboxReplicationState): Promise<void> {
        // F-S03/S04/S05 — the cursor is a high-water mark; it must only
        // ever advance. The old ON CONFLICT blindly took excluded.* so a
        // concurrent / out-of-order tick (e.g. a workspace processed in two
        // overlapping passes, or a stale write racing a higher committed
        // value) could move lastReplicatedSeq BACKWARD. A backward cursor
        // would let already-replicated rows re-enter the scan window and,
        // worse, breaks the sequenceId monotonicity guarantee
        // nextSequenceId() relies on after a prune. Guard the update so it
        // only fires when the incoming seq is strictly greater; updatedAt
        // is taken from the larger of the two so observability tracks the
        // winning value (GREATEST via MAX since SQLite lacks GREATEST).
        this.db.prepare(
            `INSERT INTO outbox_replication_state (workspace, lastReplicatedSeq, updatedAt)
             VALUES (?, ?, ?)
             ON CONFLICT(workspace) DO UPDATE SET
               lastReplicatedSeq = excluded.lastReplicatedSeq,
               updatedAt = excluded.updatedAt
             WHERE excluded.lastReplicatedSeq > outbox_replication_state.lastReplicatedSeq`,
        ).run(workspace, state.lastReplicatedSeq, state.updatedAt);
    }

    async statsByWorkspace(): Promise<Record<string, OutboxWorkspaceStats>> {
        const stats: Record<string, OutboxWorkspaceStats> = {};
        const now = Date.now();
        const depthRows = this.db.prepare(
            `SELECT workspace, COUNT(*) AS depth, MIN(createdAt) AS oldest
             FROM outbox_entries
             WHERE status IN ('pending', 'replicating', 'failed')
             GROUP BY workspace`,
        ).all() as { workspace: string; depth: number; oldest: string | null }[];
        for (const r of depthRows) {
            const s = stats[r.workspace] ??= { depth: 0, lagSeconds: 0, dead: 0 };
            s.depth = r.depth;
            if (r.oldest) {
                const created = Date.parse(r.oldest);
                if (Number.isFinite(created)) {
                    s.lagSeconds = Math.max(0, Math.floor((now - created) / 1000));
                }
            }
        }
        const deadRows = this.db.prepare(
            `SELECT workspace, COUNT(*) AS dead FROM outbox_entries WHERE status = 'dead' GROUP BY workspace`,
        ).all() as { workspace: string; dead: number }[];
        for (const r of deadRows) {
            const s = stats[r.workspace] ??= { depth: 0, lagSeconds: 0, dead: 0 };
            s.dead = r.dead;
        }
        return stats;
    }

    async aggregateStats(): Promise<OutboxAggregateStats> {
        const perWorkspace = await this.statsByWorkspace();
        let depth = 0, dead = 0, lagSeconds = 0;
        for (const s of Object.values(perWorkspace)) {
            depth += s.depth;
            dead += s.dead;
            if (s.lagSeconds > lagSeconds) lagSeconds = s.lagSeconds;
        }
        return { depth, dead, lagSeconds, perWorkspace };
    }

    /** Idempotent migration from outbox.json + outbox-replication.json
     *  into this SQLite store. Returns a report. Safe to call on every
     *  boot — no-op if SQLite already populated. On any error the
     *  partial inserts are rolled back AND outbox.json is left intact;
     *  the SQLite file is removed so a fresh attempt can be made.
     *
     *  Implementation extracted to sqliteJsonMigration.ts (file-size cap). */
    migrateFromJson(): MigrationReport {
        return migrateJsonOutbox({
            db: this.db,
            dir: this.dir,
            upsertRow: (entry) => this.upsertRow(entry),
        });
    }
}
