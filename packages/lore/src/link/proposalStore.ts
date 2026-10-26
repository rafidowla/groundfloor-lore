/**
 * proposalStore.ts - the proposals store + typing log of Links Loop D.
 *
 * A `contradicts` or `supersedes` verdict is a PROPOSAL: it is stored here and changes nothing about what recall
 * treats as current until a person (or a host) accepts it through LinkService.acceptProposal. Rows live in the link
 * queue SQLite file beside the other link state. A proposal is unique per (workspace, kind, from, to), so discovery
 * re-seeing a pair never raises it twice, and a REJECTED proposal is never re-raised.
 *
 * `link_typing_log` records every typing verdict that led to something (an edge written, a proposal raised, a
 * budget stop) with the typer id and whether it was sovereign (ran on this machine). It is bounded: oldest rows are
 * trimmed once it grows past LOG_KEEP.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export type ProposalKind = 'supersedes' | 'contradicts';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface LinkProposal {
    id: number;
    workspace: string;
    kind: ProposalKind;
    /** `supersedes`: the NEWER node (the one that would supersede). `contradicts`: the lower node id. */
    fromId: string;
    /** `supersedes`: the OLDER node (the one that would be superseded). `contradicts`: the higher node id. */
    toId: string;
    score: number;
    /** Which typer raised it (`rules`, `nli:<model>`, `judge:<model>`). */
    typer: string;
    /** False when the verdict left this machine (a hosted judge). */
    sovereign: boolean;
    reason: string | null;
    status: ProposalStatus;
    createdAt: number;
    decidedAt: number | null;
    decidedBy: string | null;
    note: string | null;
}

export interface NewProposal {
    workspace: string;
    kind: ProposalKind;
    fromId: string;
    toId: string;
    score: number;
    typer: string;
    sovereign: boolean;
    reason?: string | null;
}

export interface TypingLogEntry {
    workspace: string;
    a: string;
    b: string;
    relation: string;
    typer: string;
    sovereign: boolean;
    confidence: number;
    outcome: 'edge_written' | 'proposal' | 'proposal_exists' | 'budget_stop';
    at: number;
}

export interface ProposalFilter { status?: ProposalStatus | 'any'; kind?: ProposalKind; limit?: number; /** Rows to skip (paging); default 0. */ offset?: number }

export interface ProposalStore {
    /** Insert unless one exists for the same (workspace, kind, from, to) in ANY status. True when a new row was created. */
    add(p: NewProposal, now: number): boolean;
    get(workspace: string, id: number): LinkProposal | null;
    list(workspace: string, filter?: ProposalFilter): LinkProposal[];
    decide(workspace: string, id: number, status: Exclude<ProposalStatus, 'pending'>, now: number, by: string | null, note: string | null): boolean;
    log(entry: TypingLogEntry): void;
    listLog(workspace: string, limit: number): TypingLogEntry[];
    counts(): { pending: number; accepted: number; rejected: number; stale: number };
    close(): void;
}

const LOG_KEEP = 20_000;
const LOG_TRIM_EVERY = 500;
const REASON_MAX = 500;

type Row = Record<string, string | number | null>;

export class SqliteProposalStore implements ProposalStore {
    private readonly db: DatabaseType;
    private logWrites = 0;

    constructor(file: string) {
        this.db = new Database(file);
        if (file !== ':memory:') {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS link_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, kind TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
            score REAL NOT NULL, typer TEXT NOT NULL, sovereign INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, note TEXT,
            UNIQUE (workspace, kind, from_id, to_id)
        );
        CREATE INDEX IF NOT EXISTS link_proposals_ws_status ON link_proposals (workspace, status, id);
        CREATE TABLE IF NOT EXISTS link_typing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, relation TEXT NOT NULL,
            typer TEXT NOT NULL, sovereign INTEGER NOT NULL, confidence REAL NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS link_typing_log_ws ON link_typing_log (workspace, id)`);
    }

    private static row(r: Row): LinkProposal {
        return {
            id: r.id as number, workspace: r.workspace as string, kind: r.kind as ProposalKind, fromId: r.from_id as string, toId: r.to_id as string,
            score: r.score as number, typer: r.typer as string, sovereign: r.sovereign === 1, reason: r.reason as string | null,
            status: r.status as ProposalStatus, createdAt: r.created_at as number, decidedAt: r.decided_at as number | null,
            decidedBy: r.decided_by as string | null, note: r.note as string | null,
        };
    }

    add(p: NewProposal, now: number): boolean {
        const info = this.db.prepare(
            `INSERT OR IGNORE INTO link_proposals (workspace, kind, from_id, to_id, score, typer, sovereign, reason, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(p.workspace, p.kind, p.fromId, p.toId, p.score, p.typer, p.sovereign ? 1 : 0, p.reason ? p.reason.slice(0, REASON_MAX) : null, now);
        return info.changes > 0;
    }

    get(workspace: string, id: number): LinkProposal | null {
        const r = this.db.prepare(`SELECT * FROM link_proposals WHERE workspace = ? AND id = ?`).get(workspace, id) as Row | undefined;
        return r ? SqliteProposalStore.row(r) : null;
    }

    list(workspace: string, filter: ProposalFilter = {}): LinkProposal[] {
        const status = filter.status ?? 'pending';
        const where = ['workspace = ?'];
        const params: Array<string | number> = [workspace];
        if (status !== 'any') { where.push('status = ?'); params.push(status); }
        if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
        const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 1000);
        const offset = Math.min(Math.max(Math.trunc(filter.offset ?? 0) || 0, 0), 1_000_000);
        const rows = this.db.prepare(`SELECT * FROM link_proposals WHERE ${where.join(' AND ')} ORDER BY score DESC, id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
        return rows.map(SqliteProposalStore.row);
    }

    decide(workspace: string, id: number, status: Exclude<ProposalStatus, 'pending'>, now: number, by: string | null, note: string | null): boolean {
        const info = this.db.prepare(
            `UPDATE link_proposals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE workspace = ? AND id = ? AND status = 'pending'`,
        ).run(status, now, by, note ? note.slice(0, REASON_MAX) : null, workspace, id);
        return info.changes > 0;
    }

    log(e: TypingLogEntry): void {
        this.db.prepare(
            `INSERT INTO link_typing_log (workspace, a, b, relation, typer, sovereign, confidence, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(e.workspace, e.a, e.b, e.relation, e.typer, e.sovereign ? 1 : 0, e.confidence, e.outcome, e.at);
        if (++this.logWrites % LOG_TRIM_EVERY === 0) {
            this.db.prepare(`DELETE FROM link_typing_log WHERE id <= (SELECT max(id) FROM link_typing_log) - ?`).run(LOG_KEEP);
        }
    }

    listLog(workspace: string, limit: number): TypingLogEntry[] {
        const rows = this.db.prepare(`SELECT * FROM link_typing_log WHERE workspace = ? ORDER BY id DESC LIMIT ?`).all(workspace, Math.max(1, Math.trunc(limit))) as Row[];
        return rows.map((r) => ({
            workspace: r.workspace as string, a: r.a as string, b: r.b as string, relation: r.relation as string, typer: r.typer as string,
            sovereign: r.sovereign === 1, confidence: r.confidence as number, outcome: r.outcome as TypingLogEntry['outcome'], at: r.at as number,
        }));
    }

    counts(): { pending: number; accepted: number; rejected: number; stale: number } {
        const out = { pending: 0, accepted: 0, rejected: 0, stale: 0 };
        for (const r of this.db.prepare(`SELECT status, count(*) AS c FROM link_proposals GROUP BY status`).all() as Array<{ status: keyof typeof out; c: number }>) {
            if (r.status in out) out[r.status] = r.c;
        }
        return out;
    }

    close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
