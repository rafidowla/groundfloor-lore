/**
 * sqliteLinkQueue.ts - the DURABLE link queue (link-on-arrival).
 *
 * Deliberately NOT the main outbox: link backlog must never count toward the
 * `outbox_lag` gate that sheds writes (design section 4, Loop A). It is a small
 * SQLite file of its own, keyed (workspace, node_id), so:
 *   - enqueueing the same node twice is one row (replay-idempotent);
 *   - a node re-embedded while it is being linked is flagged `redo` and linked
 *     again after, never lost and never double-counted;
 *   - rows live until their links are written, so a restart simply resumes
 *     (claimed rows from a dead process go back to `ready` on open).
 *
 * Sync better-sqlite3 calls, same as the graph engine. Engine-neutral callers
 * only see the `LinkQueueStore` interface; a Postgres deployment can supply a
 * table-backed implementation of it.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { DuplicateCandidate } from './linkTypes.js';

export interface QueuedLink {
    workspace: string;
    nodeId: string;
    ecosystem: string | null;
    committedAt: number;
    attempts: number;
}

export interface LinkQueueCounts { ready: number; claimed: number; failed: number }

export interface LinkQueueStore {
    enqueue(workspace: string, items: ReadonlyArray<{ id: string; ecosystem?: string }>, now: number): number;
    claim(limit: number, now: number): { token: string; rows: QueuedLink[] };
    complete(token: string, rows: ReadonlyArray<{ workspace: string; nodeId: string }>): number;
    retry(token: string, rows: ReadonlyArray<{ workspace: string; nodeId: string; reason: string }>, maxAttempts: number): { retried: number; failed: number };
    counts(): LinkQueueCounts;
    oldestPendingAt(): number | null;
    addDuplicates(workspace: string, dups: ReadonlyArray<DuplicateCandidate>, now: number): void;
    listDuplicates(workspace: string, limit: number): Array<DuplicateCandidate & { seenAt: number }>;
    totals(): { linked: number; failed: number };
    /**
     * Migration source only. Before the durable opt-out moved into the workspace store, opt-outs lived in
     * this file's `link_optout` table. These three read and retire that table; nothing writes to it any more
     * and a fresh queue file never creates it.
     */
    legacyOptOutWorkspaces(): string[];
    /** Live legacy opt-outs of one workspace (non-sticky rows older than the retired 7-day expiry are not live). */
    legacyOptOuts(workspace: string, now: number): string[];
    /** Delete the workspace's legacy rows (`ids` omitted = all of them, expired ones included). Call only after the store write succeeded. */
    dropLegacyOptOuts(workspace: string, ids?: ReadonlyArray<string>): void;
    close(): void;
}

let tokenSeq = 0;
/** The expiry the retired queue-file opt-out used; applied only when migrating old rows so ancient never-committed ones are not resurrected. */
const LEGACY_OPTOUT_TTL_MS = 7 * 24 * 3600 * 1000;

export class SqliteLinkQueue implements LinkQueueStore {
    private readonly db: DatabaseType;

    constructor(file: string) {
        this.db = new Database(file);
        if (file !== ':memory:') {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
        }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS link_queue (
                workspace   TEXT NOT NULL,
                node_id     TEXT NOT NULL,
                ecosystem   TEXT,
                committed_at INTEGER NOT NULL,
                state       TEXT NOT NULL DEFAULT 'ready',
                claim_token TEXT,
                redo        INTEGER NOT NULL DEFAULT 0,
                attempts    INTEGER NOT NULL DEFAULT 0,
                last_error  TEXT,
                PRIMARY KEY (workspace, node_id)
            );
            CREATE INDEX IF NOT EXISTS idx_link_queue_state ON link_queue(state, committed_at);
            CREATE TABLE IF NOT EXISTS link_dup_candidates (
                workspace TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
                score REAL NOT NULL, seen_at INTEGER NOT NULL,
                PRIMARY KEY (workspace, a, b)
            );
            CREATE TABLE IF NOT EXISTS link_totals (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        `);
        // Restart recovery: whatever a dead process had claimed is simply ready again.
        this.db.prepare(`UPDATE link_queue SET state = 'ready', claim_token = NULL WHERE state = 'claimed'`).run();
    }

    enqueue(workspace: string, items: ReadonlyArray<{ id: string; ecosystem?: string }>, now: number): number {
        if (items.length === 0) return 0;
        // A fresh vector for a node that is mid-link (claimed) sets `redo`; for a
        // ready/failed row it refreshes the timestamp and re-arms it.
        const stmt = this.db.prepare(
            `INSERT INTO link_queue (workspace, node_id, ecosystem, committed_at, state)
             VALUES (?, ?, ?, ?, 'ready')
             ON CONFLICT(workspace, node_id) DO UPDATE SET
                 ecosystem = COALESCE(excluded.ecosystem, link_queue.ecosystem),
                 redo = CASE WHEN link_queue.state = 'claimed' THEN 1 ELSE link_queue.redo END,
                 committed_at = CASE WHEN link_queue.state = 'claimed' THEN link_queue.committed_at ELSE excluded.committed_at END,
                 state = CASE WHEN link_queue.state = 'claimed' THEN 'claimed' ELSE 'ready' END,
                 attempts = CASE WHEN link_queue.state = 'failed' THEN 0 ELSE link_queue.attempts END`,
        );
        this.db.transaction(() => { for (const it of items) stmt.run(workspace, it.id, it.ecosystem ?? null, now); })();
        return items.length;
    }

    claim(limit: number, _now: number): { token: string; rows: QueuedLink[] } {
        const token = `c${Date.now().toString(36)}-${(tokenSeq++).toString(36)}`;
        const rows = this.db.transaction(() => {
            const picked = this.db.prepare(
                `SELECT workspace, node_id, ecosystem, committed_at, attempts FROM link_queue
                 WHERE state = 'ready' ORDER BY committed_at ASC, workspace ASC, node_id ASC LIMIT ?`,
            ).all(limit) as Array<{ workspace: string; node_id: string; ecosystem: string | null; committed_at: number; attempts: number }>;
            const mark = this.db.prepare(`UPDATE link_queue SET state = 'claimed', claim_token = ? WHERE workspace = ? AND node_id = ?`);
            for (const r of picked) mark.run(token, r.workspace, r.node_id);
            return picked;
        })();
        return { token, rows: rows.map((r) => ({ workspace: r.workspace, nodeId: r.node_id, ecosystem: r.ecosystem, committedAt: r.committed_at, attempts: r.attempts })) };
    }

    complete(token: string, rows: ReadonlyArray<{ workspace: string; nodeId: string }>): number {
        if (rows.length === 0) return 0;
        let done = 0;
        this.db.transaction(() => {
            // A `redo` row (re-embedded mid-link) goes back to ready instead of being deleted.
            const redo = this.db.prepare(
                `UPDATE link_queue SET state = 'ready', claim_token = NULL, redo = 0, attempts = 0
                 WHERE workspace = ? AND node_id = ? AND claim_token = ? AND redo = 1`,
            );
            const del = this.db.prepare(`DELETE FROM link_queue WHERE workspace = ? AND node_id = ? AND claim_token = ? AND redo = 0`);
            for (const r of rows) {
                if (redo.run(r.workspace, r.nodeId, token).changes > 0) continue;
                done += del.run(r.workspace, r.nodeId, token).changes;
            }
            this.bump('linked', done);
        })();
        return done;
    }

    retry(token: string, rows: ReadonlyArray<{ workspace: string; nodeId: string; reason: string }>, maxAttempts: number): { retried: number; failed: number } {
        let retried = 0, failed = 0;
        this.db.transaction(() => {
            const get = this.db.prepare(`SELECT attempts FROM link_queue WHERE workspace = ? AND node_id = ? AND claim_token = ?`);
            const upd = this.db.prepare(
                `UPDATE link_queue SET attempts = ?, state = ?, claim_token = NULL, last_error = ?
                 WHERE workspace = ? AND node_id = ? AND claim_token = ?`,
            );
            for (const r of rows) {
                const cur = get.get(r.workspace, r.nodeId, token) as { attempts: number } | undefined;
                if (!cur) continue;
                const attempts = cur.attempts + 1;
                const state = attempts >= maxAttempts ? 'failed' : 'ready';
                upd.run(attempts, state, r.reason.slice(0, 500), r.workspace, r.nodeId, token);
                if (state === 'failed') failed++; else retried++;
            }
            if (failed > 0) this.bump('failed', failed);
        })();
        return { retried, failed };
    }

    counts(): LinkQueueCounts {
        const out: LinkQueueCounts = { ready: 0, claimed: 0, failed: 0 };
        for (const r of this.db.prepare(`SELECT state, count(*) AS c FROM link_queue GROUP BY state`).all() as Array<{ state: keyof LinkQueueCounts; c: number }>) {
            if (r.state in out) out[r.state] = r.c;
        }
        return out;
    }

    oldestPendingAt(): number | null {
        const r = this.db.prepare(`SELECT min(committed_at) AS m FROM link_queue WHERE state IN ('ready','claimed')`).get() as { m: number | null };
        return r.m;
    }

    addDuplicates(workspace: string, dups: ReadonlyArray<DuplicateCandidate>, now: number): void {
        if (dups.length === 0) return;
        const stmt = this.db.prepare(
            `INSERT INTO link_dup_candidates (workspace, a, b, score, seen_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(workspace, a, b) DO UPDATE SET score = excluded.score, seen_at = excluded.seen_at`,
        );
        this.db.transaction(() => { for (const d of dups) stmt.run(workspace, d.a, d.b, d.score, now); })();
    }

    listDuplicates(workspace: string, limit: number): Array<DuplicateCandidate & { seenAt: number }> {
        const rows = this.db.prepare(
            `SELECT a, b, score, seen_at FROM link_dup_candidates WHERE workspace = ? ORDER BY score DESC, a ASC, b ASC LIMIT ?`,
        ).all(workspace, limit) as Array<{ a: string; b: string; score: number; seen_at: number }>;
        return rows.map((r) => ({ a: r.a, b: r.b, score: r.score, seenAt: r.seen_at }));
    }

    totals(): { linked: number; failed: number } {
        const get = (k: string): number => ((this.db.prepare(`SELECT value FROM link_totals WHERE key = ?`).get(k) as { value: number } | undefined)?.value ?? 0);
        return { linked: get('linked'), failed: get('failed') };
    }

    private hasLegacyTable(): boolean {
        return this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'link_optout'`).get() !== undefined;
    }

    legacyOptOutWorkspaces(): string[] {
        if (!this.hasLegacyTable()) return [];
        return (this.db.prepare(`SELECT DISTINCT workspace FROM link_optout`).all() as Array<{ workspace: string }>).map((r) => r.workspace);
    }

    legacyOptOuts(workspace: string, now: number): string[] {
        if (!this.hasLegacyTable()) return [];
        const cols = this.db.prepare(`PRAGMA table_info(link_optout)`).all() as Array<{ name: string }>;
        const sticky = cols.some((c) => c.name === 'sticky') ? 'sticky = 1 OR ' : '';
        const rows = this.db.prepare(`SELECT node_id FROM link_optout WHERE workspace = ? AND (${sticky}at >= ?)`)
            .all(workspace, now - LEGACY_OPTOUT_TTL_MS) as Array<{ node_id: string }>;
        return rows.map((r) => r.node_id);
    }

    dropLegacyOptOuts(workspace: string, ids?: ReadonlyArray<string>): void {
        if (!this.hasLegacyTable()) return;
        if (!ids) { this.db.prepare(`DELETE FROM link_optout WHERE workspace = ?`).run(workspace); return; }
        const stmt = this.db.prepare(`DELETE FROM link_optout WHERE workspace = ? AND node_id = ?`);
        this.db.transaction(() => { for (const id of ids) stmt.run(workspace, id); })();
    }

    private bump(key: string, by: number): void {
        if (by <= 0) return;
        this.db.prepare(`INSERT INTO link_totals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`).run(key, by);
    }

    close(): void {
        try { this.db.close(); } catch { /* already closed */ }
    }
}
