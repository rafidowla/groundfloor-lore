/**
 * linkPruneStore.ts - durable state of the background link-cap prune.
 *
 * One row per workspace in the link-queue SQLite file (own connection, WAL, like SqliteRebuildStore). `dirty`
 * means "link edges were written since the last full pass found nothing over the cap"; `cursor` is the last node
 * id a pass finished, so a restart resumes the pass instead of rescanning from the start. The row also doubles as
 * the registry of workspaces that have link edges, which the link-health snapshot walks.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export interface PruneState {
    workspace: string;
    dirty: boolean;
    /** Last node id whose over-cap check finished in the current pass; null between passes. */
    cursor: string | null;
    /** Edges soft-invalidated by the prune, all time. */
    evicted: number;
    /** Full passes completed (a pass that found nothing over the cap counts). */
    passes: number;
    lastPassAt: number | null;
}

export interface PruneStateStore {
    get(workspace: string): PruneState | null;
    put(state: PruneState): void;
    /** Mark a workspace as having fresh link writes (creates the row). */
    markDirty(workspace: string): void;
    list(): PruneState[];
    close(): void;
}

export class SqlitePruneStore implements PruneStateStore {
    private readonly db: DatabaseType;

    constructor(file: string) {
        this.db = new Database(file);
        if (file !== ':memory:') {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS link_prune (
            workspace TEXT PRIMARY KEY, dirty INTEGER NOT NULL, cursor TEXT, evicted INTEGER NOT NULL DEFAULT 0,
            passes INTEGER NOT NULL DEFAULT 0, last_pass_at INTEGER, updated_at INTEGER NOT NULL
        )`);
    }

    private static row(r: { workspace: string; dirty: number; cursor: string | null; evicted: number; passes: number; last_pass_at: number | null }): PruneState {
        return { workspace: r.workspace, dirty: r.dirty === 1, cursor: r.cursor, evicted: r.evicted, passes: r.passes, lastPassAt: r.last_pass_at };
    }

    get(workspace: string): PruneState | null {
        const r = this.db.prepare(`SELECT * FROM link_prune WHERE workspace = ?`).get(workspace) as Parameters<typeof SqlitePruneStore.row>[0] | undefined;
        return r ? SqlitePruneStore.row(r) : null;
    }

    put(s: PruneState): void {
        this.db.prepare(
            `INSERT INTO link_prune (workspace, dirty, cursor, evicted, passes, last_pass_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace) DO UPDATE SET dirty = excluded.dirty, cursor = excluded.cursor, evicted = excluded.evicted,
                 passes = excluded.passes, last_pass_at = excluded.last_pass_at, updated_at = excluded.updated_at`,
        ).run(s.workspace, s.dirty ? 1 : 0, s.cursor, s.evicted, s.passes, s.lastPassAt, Date.now());
    }

    markDirty(workspace: string): void {
        this.db.prepare(
            `INSERT INTO link_prune (workspace, dirty, updated_at) VALUES (?, 1, ?)
             ON CONFLICT(workspace) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
        ).run(workspace, Date.now());
    }

    list(): PruneState[] {
        return (this.db.prepare(`SELECT * FROM link_prune ORDER BY workspace`).all() as Array<Parameters<typeof SqlitePruneStore.row>[0]>).map(SqlitePruneStore.row);
    }

    close(): void { this.db.close(); }
}
