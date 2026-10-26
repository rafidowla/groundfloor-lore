/**
 * discoveryStore.ts - durable per-workspace state of Links Loop D (discovery).
 *
 * One row per workspace in the link-queue SQLite file (own connection, WAL, like SqlitePruneStore). The cursor is the
 * keyset position of the in-progress pass over `bulkList` (updatedAt DESC, id ASC), so a restart resumes the pass.
 * `watermark` is the start time of the last COMPLETED pass: the next pass only walks nodes changed since then
 * ("recently changed regions"); null means the first pass, which walks the whole workspace in budgeted slices.
 *
 * Design note: the design doc places link state in per-workspace state. The link queue file is where Loops B/C
 * already keep theirs (the workspace graph DB has no generic key-value table), so Loop D follows them.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export interface DiscoveryState {
    workspace: string;
    /** Keyset cursor of the pass in progress (last node seen); null between passes. */
    cursorUpdatedAt: string | null;
    cursorId: string | null;
    /** ISO time the pass in progress started; becomes `watermark` when it completes. */
    passStartedAt: string | null;
    /** ISO start time of the last completed pass; null before the first one finishes. */
    watermark: string | null;
    passes: number;
    runs: number;
    nodesScanned: number;
    pairsScanned: number;
    linksAdded: number;
    supportsAdded: number;
    proposalsRaised: number;
    budgetStops: number;
    lastRunAt: number | null;
    /** UTC day (YYYY-MM-DD) of `judgeUsed`; the daily judge budget resets when the day changes. */
    judgeDay: string | null;
    judgeUsed: number;
}

export const emptyDiscoveryState = (workspace: string): DiscoveryState => ({
    workspace, cursorUpdatedAt: null, cursorId: null, passStartedAt: null, watermark: null, passes: 0, runs: 0, nodesScanned: 0,
    pairsScanned: 0, linksAdded: 0, supportsAdded: 0, proposalsRaised: 0, budgetStops: 0, lastRunAt: null, judgeDay: null, judgeUsed: 0,
});

export interface DiscoveryStateStore {
    get(workspace: string): DiscoveryState | null;
    put(state: DiscoveryState): void;
    list(): DiscoveryState[];
    close(): void;
}

type Row = Record<string, string | number | null>;

export class SqliteDiscoveryStore implements DiscoveryStateStore {
    private readonly db: DatabaseType;

    constructor(file: string) {
        this.db = new Database(file);
        if (file !== ':memory:') {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS link_discovery (
            workspace TEXT PRIMARY KEY, cursor_updated_at TEXT, cursor_id TEXT, pass_started_at TEXT, watermark TEXT,
            passes INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, nodes_scanned INTEGER NOT NULL DEFAULT 0,
            pairs_scanned INTEGER NOT NULL DEFAULT 0, links_added INTEGER NOT NULL DEFAULT 0, supports_added INTEGER NOT NULL DEFAULT 0,
            proposals_raised INTEGER NOT NULL DEFAULT 0, budget_stops INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER,
            judge_day TEXT, judge_used INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
        )`);
    }

    private static row(r: Row): DiscoveryState {
        return {
            workspace: r.workspace as string, cursorUpdatedAt: r.cursor_updated_at as string | null, cursorId: r.cursor_id as string | null,
            passStartedAt: r.pass_started_at as string | null, watermark: r.watermark as string | null, passes: r.passes as number,
            runs: r.runs as number, nodesScanned: r.nodes_scanned as number, pairsScanned: r.pairs_scanned as number,
            linksAdded: r.links_added as number, supportsAdded: r.supports_added as number, proposalsRaised: r.proposals_raised as number,
            budgetStops: r.budget_stops as number, lastRunAt: r.last_run_at as number | null, judgeDay: r.judge_day as string | null,
            judgeUsed: r.judge_used as number,
        };
    }

    get(workspace: string): DiscoveryState | null {
        const r = this.db.prepare(`SELECT * FROM link_discovery WHERE workspace = ?`).get(workspace) as Row | undefined;
        return r ? SqliteDiscoveryStore.row(r) : null;
    }

    put(s: DiscoveryState): void {
        this.db.prepare(
            `INSERT INTO link_discovery (workspace, cursor_updated_at, cursor_id, pass_started_at, watermark, passes, runs, nodes_scanned,
                 pairs_scanned, links_added, supports_added, proposals_raised, budget_stops, last_run_at, judge_day, judge_used, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace) DO UPDATE SET cursor_updated_at = excluded.cursor_updated_at, cursor_id = excluded.cursor_id,
                 pass_started_at = excluded.pass_started_at, watermark = excluded.watermark, passes = excluded.passes, runs = excluded.runs,
                 nodes_scanned = excluded.nodes_scanned, pairs_scanned = excluded.pairs_scanned, links_added = excluded.links_added,
                 supports_added = excluded.supports_added, proposals_raised = excluded.proposals_raised, budget_stops = excluded.budget_stops,
                 last_run_at = excluded.last_run_at, judge_day = excluded.judge_day, judge_used = excluded.judge_used, updated_at = excluded.updated_at`,
        ).run(s.workspace, s.cursorUpdatedAt, s.cursorId, s.passStartedAt, s.watermark, s.passes, s.runs, s.nodesScanned, s.pairsScanned,
            s.linksAdded, s.supportsAdded, s.proposalsRaised, s.budgetStops, s.lastRunAt, s.judgeDay, s.judgeUsed, Date.now());
    }

    list(): DiscoveryState[] {
        return (this.db.prepare(`SELECT * FROM link_discovery ORDER BY workspace`).all() as Row[]).map(SqliteDiscoveryStore.row);
    }

    close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
