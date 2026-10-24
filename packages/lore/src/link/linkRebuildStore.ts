/**
 * linkRebuildStore.ts - durable checkpoint for the link rebuild (Loop C / D2).
 *
 * One row per workspace, living in the link-queue SQLite file (own connection, WAL): a restart reads
 * `status = 'running'` back and the rebuild resumes after `cursor` instead of starting over.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export type RebuildStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface RebuildState {
    workspace: string;
    runId: string;
    status: RebuildStatus;
    startedAt: number;
    finishedAt: number | null;
    /** Policy + model the run recomputes with (stamped on every edge it writes). */
    policyVersion: string;
    modelFingerprint: string | null;
    /** Last node id fully processed (ids are walked in sorted order); null before the first batch. */
    cursor: string | null;
    /** Nodes to walk (fixed when the run starts). */
    total: number;
    /** Nodes walked so far. */
    done: number;
    /** New link edges written. */
    inserted: number;
    /** Kept links whose stamp (policy / model) or score was stale: re-asserted in place. */
    refreshed: number;
    /** Links no longer wanted by either endpoint: soft-invalidated (valid_to set), never deleted. */
    invalidated: number;
    /** Links already correct: left untouched. */
    unchanged: number;
    /** Wanted pairs already held by a non-link edge (caller, import, legacy): left alone. */
    keptForeign: number;
    /** Links not judged because an endpoint has no stored vector yet: left alone. */
    skippedNoVector: number;
    /** Existing links left alone because an endpoint opted out of linking (`autolink:false`). Absent on checkpoints written before this field existed. */
    skippedOptOut?: number;
    lastError: string | null;
}

export interface RebuildStateStore {
    get(workspace: string): RebuildState | null;
    put(state: RebuildState): void;
    list(): RebuildState[];
    close(): void;
}

export class SqliteRebuildStore implements RebuildStateStore {
    private readonly db: DatabaseType;

    constructor(file: string) {
        this.db = new Database(file);
        if (file !== ':memory:') {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS link_rebuild (
            workspace TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL
        )`);
    }

    get(workspace: string): RebuildState | null {
        const row = this.db.prepare(`SELECT state FROM link_rebuild WHERE workspace = ?`).get(workspace) as { state: string } | undefined;
        return row ? (JSON.parse(row.state) as RebuildState) : null;
    }

    put(state: RebuildState): void {
        this.db.prepare(
            `INSERT INTO link_rebuild (workspace, state, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(workspace) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        ).run(state.workspace, JSON.stringify(state), Date.now());
    }

    list(): RebuildState[] {
        return (this.db.prepare(`SELECT state FROM link_rebuild ORDER BY workspace`).all() as Array<{ state: string }>)
            .map((r) => JSON.parse(r.state) as RebuildState);
    }

    close(): void { this.db.close(); }
}
