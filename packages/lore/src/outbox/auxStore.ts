/**
 * auxStore.ts — SQLite store for auxiliary Lore tables (2026-05-26).
 *
 * Manages three tables that are daemon-global (single SQLite file at
 * <loreDir>/aux.sqlite, co-located with outbox.sqlite):
 *
 *   node_outcomes   — per-node use-outcome records (Feature 2)
 *   prune_jobs      — async prune operation tracking (Feature 1)
 *   corpus_counters — pre-aggregated workspace metric counters (Feature 7)
 *
 * Uses better-sqlite3 (same dep as sqliteStore.ts, synchronous API).
 * Schema is created on first open; subsequent opens are idempotent.
 */

import * as path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';

const SQLITE_FILE = 'aux.sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS node_outcomes (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('success','failure','partial')),
  notes       TEXT,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_node_ws ON node_outcomes(node_id, workspace);

CREATE TABLE IF NOT EXISTS prune_jobs (
  id           TEXT PRIMARY KEY,
  workspace    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  options      TEXT NOT NULL,
  result       TEXT,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prune_jobs_ws ON prune_jobs(workspace, created_at);

CREATE TABLE IF NOT EXISTS corpus_counters (
  workspace  TEXT NOT NULL,
  metric     TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, metric)
);
`;

/* ─── Public types ─────────────────────────────────────────────── */

export type OutcomeStatus = 'success' | 'failure' | 'partial';

export interface Outcome {
    id: string;
    nodeId: string;
    workspace: string;
    status: OutcomeStatus;
    notes: string | null;
    recordedBy: string | null;
    recordedAt: string;
}

export interface PruneOptions {
    classification?: 'foundational' | 'tactical' | 'observational';
    olderThanDays?: number;
    tags?: string;
    hardDelete?: boolean;
    dryRun?: boolean;
}

export type PruneJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PruneJob {
    id: string;
    workspace: string;
    status: PruneJobStatus;
    options: PruneOptions;
    result: PruneJobResult | null;
    createdAt: string;
    completedAt: string | null;
}

export interface PruneJobResult {
    matched: number;
    archived: number;
    hardDeleted: number;
    skipped: number;
    protectedCount: number;
    dryRun: boolean;
}

/* ─── AuxStore ─────────────────────────────────────────────────── */

export class AuxStore {
    private db: DatabaseType;

    private constructor(db: DatabaseType) {
        this.db = db;
    }

    /**
     * Open (or create) the aux.sqlite file at <loreDir>/aux.sqlite.
     * loreDir is the LORE_HOME root directory (same convention as outbox.sqlite).
     */
    static open(loreDir: string): AuxStore {
        const filePath = path.join(loreDir, SQLITE_FILE);
        const db = new Database(filePath);
        // WAL mode for concurrent reads during long prune jobs.
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.exec(SCHEMA_SQL);
        return new AuxStore(db);
    }

    close(): void {
        try { this.db.close(); } catch { /* ignore */ }
    }

    /* ─── node_outcomes ──────────────────────────────────────────── */

    recordOutcome(o: {
        id: string;
        nodeId: string;
        workspace: string;
        status: OutcomeStatus;
        notes?: string;
        recordedBy?: string;
    }): void {
        this.db
            .prepare(
                `INSERT INTO node_outcomes (id, node_id, workspace, status, notes, recorded_by, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                o.id,
                o.nodeId,
                o.workspace,
                o.status,
                o.notes ?? null,
                o.recordedBy ?? null,
                new Date().toISOString(),
            );
    }

    getOutcomes(nodeId: string, workspace: string, limit = 20): Outcome[] {
        const rows = this.db
            .prepare(
                `SELECT id, node_id, workspace, status, notes, recorded_by, recorded_at
                 FROM node_outcomes
                 WHERE node_id = ? AND workspace = ?
                 ORDER BY recorded_at DESC
                 LIMIT ?`,
            )
            .all(nodeId, workspace, limit) as Array<Record<string, unknown>>;

        return rows.map((r) => ({
            id: String(r['id'] ?? ''),
            nodeId: String(r['node_id'] ?? ''),
            workspace: String(r['workspace'] ?? ''),
            status: String(r['status'] ?? 'success') as OutcomeStatus,
            notes: r['notes'] != null ? String(r['notes']) : null,
            recordedBy: r['recorded_by'] != null ? String(r['recorded_by']) : null,
            recordedAt: String(r['recorded_at'] ?? ''),
        }));
    }

    getOutcomeCount(nodeId: string, workspace: string): { success: number; failure: number; partial: number } {
        const row = this.db
            .prepare(
                `SELECT
                   SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS s,
                   SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS f,
                   SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) AS p
                 FROM node_outcomes
                 WHERE node_id = ? AND workspace = ?`,
            )
            .get(nodeId, workspace) as Record<string, unknown> | undefined;
        return {
            success: Number(row?.['s'] ?? 0),
            failure: Number(row?.['f'] ?? 0),
            partial: Number(row?.['p'] ?? 0),
        };
    }

    getWorkspaceOutcomeTotals(workspace: string): { success: number; failure: number; partial: number } {
        const row = this.db
            .prepare(
                `SELECT
                   SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS s,
                   SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS f,
                   SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) AS p
                 FROM node_outcomes WHERE workspace = ?`,
            )
            .get(workspace) as Record<string, unknown> | undefined;
        return {
            success: Number(row?.['s'] ?? 0),
            failure: Number(row?.['f'] ?? 0),
            partial: Number(row?.['p'] ?? 0),
        };
    }

    /* ─── prune_jobs ─────────────────────────────────────────────── */

    createPruneJob(workspace: string, options: PruneOptions): string {
        const id = `prune-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.db
            .prepare(
                `INSERT INTO prune_jobs (id, workspace, status, options, created_at)
                 VALUES (?, ?, 'running', ?, ?)`,
            )
            .run(id, workspace, JSON.stringify(options), new Date().toISOString());
        return id;
    }

    updatePruneJob(id: string, patch: { status: PruneJobStatus; result?: PruneJobResult }): void {
        this.db
            .prepare(
                `UPDATE prune_jobs
                 SET status = ?, result = ?, completed_at = ?
                 WHERE id = ?`,
            )
            .run(
                patch.status,
                patch.result != null ? JSON.stringify(patch.result) : null,
                ['completed', 'failed'].includes(patch.status) ? new Date().toISOString() : null,
                id,
            );
    }

    getPruneJob(id: string): PruneJob | null {
        const row = this.db
            .prepare(`SELECT * FROM prune_jobs WHERE id = ?`)
            .get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            id: String(row['id'] ?? ''),
            workspace: String(row['workspace'] ?? ''),
            status: String(row['status'] ?? 'pending') as PruneJobStatus,
            options: row['options'] ? (JSON.parse(String(row['options'])) as PruneOptions) : {},
            result: row['result'] ? (JSON.parse(String(row['result'])) as PruneJobResult) : null,
            createdAt: String(row['created_at'] ?? ''),
            completedAt: row['completed_at'] != null ? String(row['completed_at']) : null,
        };
    }

    /* ─── corpus_counters ────────────────────────────────────────── */

    getCorpusCounters(workspace: string): Record<string, number> {
        const rows = this.db
            .prepare(`SELECT metric, value FROM corpus_counters WHERE workspace = ?`)
            .all(workspace) as Array<Record<string, unknown>>;
        const out: Record<string, number> = {};
        for (const r of rows) {
            out[String(r['metric'] ?? '')] = Number(r['value'] ?? 0);
        }
        return out;
    }

    incrementCounter(workspace: string, metric: string, delta = 1): void {
        this.db
            .prepare(
                `INSERT INTO corpus_counters (workspace, metric, value, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(workspace, metric)
                 DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`,
            )
            .run(workspace, metric, delta, new Date().toISOString());
    }

    setCounter(workspace: string, metric: string, value: number): void {
        this.db
            .prepare(
                `INSERT INTO corpus_counters (workspace, metric, value, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(workspace, metric)
                 DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(workspace, metric, value, new Date().toISOString());
    }
}
