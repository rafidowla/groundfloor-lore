/**
 * versionStore.ts — Immutable version history + changeset store (Feature 8, 2026-05-26).
 *
 * Tables (in <loreDir>/versions.sqlite):
 *   node_versions    — one immutable row per write on any node
 *   changesets       — atomic transaction headers (open/committed/rolled_back)
 *   changeset_writes — buffered upsert/delete ops for open changesets
 *
 * Retention policy (pruneVersions):
 *   Rows older than the configured retention window are soft-deleted
 *   (compacted=1). Protected-node rows — any row whose previous_state
 *   or new_state JSON contains the string '"status":"protected"' — are
 *   retained indefinitely regardless of age.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';

const SQLITE_FILE = 'versions.sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS node_versions (
  version_id     TEXT PRIMARY KEY,
  node_id        TEXT NOT NULL,
  workspace      TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  principal      TEXT NOT NULL DEFAULT 'mcp',
  operation      TEXT NOT NULL,
  previous_state TEXT,
  new_state      TEXT,
  changeset_id   TEXT,
  compacted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nv_node_ws ON node_versions(node_id, workspace, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nv_ws_ts   ON node_versions(workspace, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nv_cset    ON node_versions(changeset_id)
  WHERE changeset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS changesets (
  id           TEXT PRIMARY KEY,
  workspace    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('open','committed','rolled_back')),
  created_at   TEXT NOT NULL,
  committed_at TEXT,
  write_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cset_ws ON changesets(workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS changeset_writes (
  id           TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  seq          INTEGER NOT NULL,
  operation    TEXT NOT NULL,
  payload      TEXT NOT NULL,
  UNIQUE(changeset_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cw_cset ON changeset_writes(changeset_id, seq);
`;

/* ─── Public types ─────────────────────────────────────────────── */

export interface VersionRecord {
    versionId: string;
    nodeId: string;
    workspace: string;
    timestamp: string;
    principal: string;
    operation: string;
    previousState: unknown | null;
    newState: unknown | null;
    changesetId: string | null;
    compacted: boolean;
}

export interface Changeset {
    id: string;
    workspace: string;
    status: 'open' | 'committed' | 'rolled_back';
    createdAt: string;
    committedAt: string | null;
    writeCount: number;
}

export interface ChangesetWrite {
    id: string;
    changesetId: string;
    seq: number;
    operation: string;
    payload: unknown;
}

/* ─── VersionStore ─────────────────────────────────────────────── */

export class VersionStore {
    private db: DatabaseType;

    private constructor(db: DatabaseType) {
        this.db = db;
    }

    /**
     * Open (or create) versions.sqlite at <loreDir>/versions.sqlite.
     * Idempotent: schema is CREATE IF NOT EXISTS throughout.
     */
    static open(loreDir: string): VersionStore {
        const filePath = path.join(loreDir, SQLITE_FILE);
        const db = new Database(filePath);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.exec(SCHEMA_SQL);
        return new VersionStore(db);
    }

    close(): void {
        try { this.db.close(); } catch { /* ignore */ }
    }

    /* ─── node_versions ──────────────────────────────────────────── */

    recordVersion(r: Omit<VersionRecord, 'compacted'>): void {
        this.db
            .prepare(
                `INSERT INTO node_versions
                   (version_id, node_id, workspace, timestamp, principal,
                    operation, previous_state, new_state, changeset_id, compacted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            )
            .run(
                r.versionId,
                r.nodeId,
                r.workspace,
                r.timestamp,
                r.principal,
                r.operation,
                r.previousState != null ? JSON.stringify(r.previousState) : null,
                r.newState != null ? JSON.stringify(r.newState) : null,
                r.changesetId ?? null,
            );
    }

    /** Newest-first version log for a single node. Excludes compacted rows. */
    getVersions(nodeId: string, workspace: string, limit = 50): VersionRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM node_versions
                 WHERE node_id = ? AND workspace = ? AND compacted = 0
                 ORDER BY timestamp DESC LIMIT ?`,
            )
            .all(nodeId, workspace, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToVersion);
    }

    /** All non-compacted changes in a workspace at or after `since` (ISO 8601). */
    getDiff(workspace: string, since: string): VersionRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM node_versions
                 WHERE workspace = ? AND timestamp >= ? AND compacted = 0
                 ORDER BY timestamp DESC`,
            )
            .all(workspace, since) as Array<Record<string, unknown>>;
        return rows.map(rowToVersion);
    }

    /** All version records created as part of a specific changeset (oldest-first). */
    getVersionsByChangeset(changesetId: string): VersionRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM node_versions
                 WHERE changeset_id = ? ORDER BY timestamp ASC`,
            )
            .all(changesetId) as Array<Record<string, unknown>>;
        return rows.map(rowToVersion);
    }

    /**
     * Soft-compact version rows older than `olderThanDays`.
     * Protected-node rows (state JSON contains '"status":"protected"') are
     * skipped regardless of age.
     * Returns the number of rows compacted.
     */
    pruneVersions(olderThanDays: number): number {
        const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
        const result = this.db
            .prepare(
                `UPDATE node_versions
                 SET compacted = 1
                 WHERE timestamp < ?
                   AND compacted = 0
                   AND (previous_state IS NULL
                        OR previous_state NOT LIKE '%"status":"protected"%')
                   AND (new_state IS NULL
                        OR new_state NOT LIKE '%"status":"protected"%')`,
            )
            .run(cutoff);
        return (result as unknown as { changes: number }).changes;
    }

    /**
     * Hard-delete rows already marked `compacted=1`. Every read path
     * (getVersionHistory, getChangesSince) already excludes compacted rows —
     * nothing in this codebase ever reads one — so retaining them serves no
     * purpose and is why `versions.sqlite` grew unbounded even where
     * `pruneVersions` ran: soft-delete alone frees no disk space.
     * Returns the number of rows removed.
     */
    hardDeleteCompacted(): number {
        const result = this.db.prepare(`DELETE FROM node_versions WHERE compacted = 1`).run();
        return (result as unknown as { changes: number }).changes;
    }

    /**
     * Reclaim the freed pages on disk. SQLite DELETE leaves freed pages in
     * the file's internal freelist for reuse — the file itself does not
     * shrink without this. Exclusive on the connection while it runs;
     * callers should treat this as a maintenance operation, not something
     * to run on every write.
     *
     * The store opens in WAL mode (`journal_mode = WAL`), so VACUUM's own
     * rewrite lands in `versions.sqlite-wal`, not the main file — measured:
     * the main file's on-disk size does not change until that WAL is
     * checkpointed back in. Without the explicit checkpoint below, the
     * space would only be reclaimed on the NEXT `close()`, which a
     * long-running daemon may not do for days. `TRUNCATE` (not the default
     * `PASSIVE`) forces the checkpoint immediately and shrinks the -wal
     * file itself back to empty.
     */
    vacuum(): void {
        this.db.exec('VACUUM');
        this.db.pragma('wal_checkpoint(TRUNCATE)');
    }

    /* ─── changesets ─────────────────────────────────────────────── */

    createChangeset(workspace: string): string {
        // RA2-reaudit2 — crypto-random id. The old timestamp + 6 chars of
        // Math.random() was guessable, letting a caller target/forge another
        // open changeset's id.
        const id = `cs-${randomUUID()}`;
        this.db
            .prepare(
                `INSERT INTO changesets (id, workspace, status, created_at, write_count)
                 VALUES (?, ?, 'open', ?, 0)`,
            )
            .run(id, workspace, new Date().toISOString());
        return id;
    }

    getChangeset(id: string): Changeset | null {
        const row = this.db
            .prepare(`SELECT * FROM changesets WHERE id = ?`)
            .get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return rowToChangeset(row);
    }

    updateChangeset(id: string, status: 'committed' | 'rolled_back'): void {
        this.db
            .prepare(`UPDATE changesets SET status = ?, committed_at = ? WHERE id = ?`)
            .run(status, new Date().toISOString(), id);
    }

    incrementWriteCount(changesetId: string): void {
        this.db
            .prepare(`UPDATE changesets SET write_count = write_count + 1 WHERE id = ?`)
            .run(changesetId);
    }

    /* ─── changeset_writes ───────────────────────────────────────── */

    /**
     * Append a buffered write to an open changeset and return the seq it was
     * assigned.
     *
     * SW-06 (B8): seq is allocated atomically inside a single transaction that
     * also bumps the changeset's write_count. Pre-SW-06 the caller read
     * changeset.write_count and passed it as `seq`; two concurrent store_node
     * calls buffering into the SAME changeset both read the same write_count,
     * both inserted with the same seq → `UNIQUE(changeset_id, seq)` violation
     * (one write lost), and the two write_count bumps could interleave and
     * under-count. Deriving seq from `MAX(seq)+1` of the committed rows under
     * the same transaction that bumps write_count closes both windows.
     */
    addChangesetWrite(changesetId: string, operation: string, payload: unknown): number {
        const txn = this.db.transaction((csId: string, op: string, body: string): number => {
            const r = this.db
                .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM changeset_writes WHERE changeset_id = ?`)
                .get(csId) as { next: number };
            const seq = r.next;
            this.db
                .prepare(
                    `INSERT INTO changeset_writes (id, changeset_id, seq, operation, payload)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(randomUUID(), csId, seq, op, body);
            this.db
                .prepare(`UPDATE changesets SET write_count = write_count + 1 WHERE id = ?`)
                .run(csId);
            return seq;
        });
        return txn(changesetId, operation, JSON.stringify(payload));
    }

    getChangesetWrites(changesetId: string): ChangesetWrite[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM changeset_writes
                 WHERE changeset_id = ? ORDER BY seq ASC`,
            )
            .all(changesetId) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            id: String(r['id'] ?? ''),
            changesetId: String(r['changeset_id'] ?? ''),
            seq: Number(r['seq'] ?? 0),
            operation: String(r['operation'] ?? ''),
            payload: r['payload'] ? JSON.parse(String(r['payload'])) : null,
        }));
    }
}

/* ─── Row mappers ────────────────────────────────────────────────── */

function rowToVersion(r: Record<string, unknown>): VersionRecord {
    return {
        versionId: String(r['version_id'] ?? ''),
        nodeId: String(r['node_id'] ?? ''),
        workspace: String(r['workspace'] ?? ''),
        timestamp: String(r['timestamp'] ?? ''),
        principal: String(r['principal'] ?? 'mcp'),
        operation: String(r['operation'] ?? ''),
        previousState: r['previous_state'] != null
            ? JSON.parse(String(r['previous_state'])) : null,
        newState: r['new_state'] != null
            ? JSON.parse(String(r['new_state'])) : null,
        changesetId: r['changeset_id'] != null ? String(r['changeset_id']) : null,
        compacted: Number(r['compacted'] ?? 0) === 1,
    };
}

function rowToChangeset(r: Record<string, unknown>): Changeset {
    return {
        id: String(r['id'] ?? ''),
        workspace: String(r['workspace'] ?? ''),
        status: String(r['status'] ?? 'open') as Changeset['status'],
        createdAt: String(r['created_at'] ?? ''),
        committedAt: r['committed_at'] != null ? String(r['committed_at']) : null,
        writeCount: Number(r['write_count'] ?? 0),
    };
}
