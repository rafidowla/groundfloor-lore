/**
 * outbox/sqliteJsonMigration.ts — the outbox.json → outbox.sqlite one-time
 * migration, extracted from sqliteStore.ts (2026-08-17) to keep that file
 * under the 800-line hard cap. Same extraction convention as
 * engines/verbatimBatch.ts / verbatimHistory.ts: the free function takes a
 * narrow context (db handle + directory + the store's row writer) and the
 * store method delegates to it.
 *
 * Idempotent: runs on first open when outbox.json exists and the SQLite
 * table is empty; renames the JSON files to `.migrated-<ts>` only after a
 * fully successful copy, so any failure leaves the JSON source intact for
 * the next attempt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { OutboxEntry, OutboxReplicationState } from './types.js';

const JSON_FILE = 'outbox.json';
const REPL_JSON_FILE = 'outbox-replication.json';
/** Legacy rows without a workspace are backfilled to the boot workspace. */
export const DEFAULT_WORKSPACE_BACKFILL = 'default';

export interface MigrationReport {
    migratedEntries: number;
    migratedRepl: number;
    durationMs: number;
    renamedTo?: string;
    rolledBack?: boolean;
    error?: string;
}

/** Narrow context the migration needs from SqliteOutboxStore. */
export interface JsonMigrationCtx {
    db: DatabaseType;
    dir: string;
    /** The store's row writer (keeps INSERT shape in one place). */
    upsertRow: (entry: OutboxEntry) => void;
}

/** Idempotent migration from outbox.json + outbox-replication.json.
 *  On failure the transaction rolls back AND leaves outbox.json in place;
 *  the SQLite table is emptied so a fresh attempt can be made. */
export function migrateJsonOutbox(ctx: JsonMigrationCtx): MigrationReport {
    const { db, dir, upsertRow } = ctx;
    const startedAt = Date.now();
    const jsonPath = path.join(dir, JSON_FILE);
    const replJsonPath = path.join(dir, REPL_JSON_FILE);

    // Idempotency gate: if SQLite already has entries, treat as
    // already-migrated. We do NOT re-rename outbox.json since a
    // previous run already did (it would now be .migrated-*).
    const existing = db.prepare(`SELECT COUNT(*) AS c FROM outbox_entries`).get() as { c: number };
    if (existing.c > 0) {
        return { migratedEntries: 0, migratedRepl: 0, durationMs: 0 };
    }
    if (!fs.existsSync(jsonPath)) {
        return { migratedEntries: 0, migratedRepl: 0, durationMs: 0 };
    }

    let parsed: Record<string, OutboxEntry>;
    try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return { migratedEntries: 0, migratedRepl: 0, durationMs: Date.now() - startedAt };
        }
        parsed = obj as Record<string, OutboxEntry>;
    } catch (err) {
        return {
            migratedEntries: 0, migratedRepl: 0,
            durationMs: Date.now() - startedAt,
            error: `outbox.json unparseable: ${(err as Error).message}`,
        };
    }

    const entries = Object.values(parsed);
    let migratedEntries = 0;
    try {
        const txn = db.transaction((rows: OutboxEntry[]) => {
            // Backfill legacy rows the same way FileOutboxStore did
            // on read so the migrated SQLite content is shape-identical
            // to what callers see today.
            const maxSeqByWs: Record<string, number> = {};
            const needsSeq: OutboxEntry[] = [];
            for (const e of rows) {
                const ws = e.workspace ?? DEFAULT_WORKSPACE_BACKFILL;
                if (e.workspace === undefined) e.workspace = ws;
                if (e.operationKind === undefined) e.operationKind = 'sync.vector.mirror';
                if (e.status === undefined) {
                    e.status = e.completed ? 'replicated' : 'pending';
                }
                if (e.attempts === undefined) e.attempts = 0;
                if (e.updatedAt === undefined) e.updatedAt = e.createdAt;
                if (e.operation === undefined) e.operation = e.operationKind ?? 'unknown';
                if (e.initiator === undefined) e.initiator = 'system:legacy';
                if (typeof e.sequenceId === 'number') {
                    maxSeqByWs[ws] = Math.max(maxSeqByWs[ws] ?? 0, e.sequenceId);
                } else {
                    needsSeq.push(e);
                }
            }
            needsSeq.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
            const seqCursor: Record<string, number> = { ...maxSeqByWs };
            for (const e of needsSeq) {
                const ws = e.workspace!;
                seqCursor[ws] = (seqCursor[ws] ?? 0) + 1;
                e.sequenceId = seqCursor[ws];
            }
            for (const e of rows) {
                upsertRow(e);
                migratedEntries++;
            }
        });
        txn(entries);
    } catch (err) {
        // Rollback: empty out partial table; leave outbox.json untouched.
        try { db.exec(`DELETE FROM outbox_entries`); } catch { /* ignore */ }
        return {
            migratedEntries: 0,
            migratedRepl: 0,
            durationMs: Date.now() - startedAt,
            error: `migration failed: ${(err as Error).message}`,
            rolledBack: true,
        };
    }

    // Migrate replication-state sidecar if present.
    let migratedRepl = 0;
    if (fs.existsSync(replJsonPath)) {
        try {
            const raw = fs.readFileSync(replJsonPath, 'utf-8');
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                const insert = db.prepare(
                    `INSERT INTO outbox_replication_state (workspace, lastReplicatedSeq, updatedAt)
                     VALUES (?, ?, ?)
                     ON CONFLICT(workspace) DO UPDATE SET
                       lastReplicatedSeq = excluded.lastReplicatedSeq,
                       updatedAt = excluded.updatedAt`,
                );
                const txn = db.transaction((entries: Array<[string, OutboxReplicationState]>) => {
                    for (const [ws, state] of entries) {
                        if (typeof state?.lastReplicatedSeq === 'number') {
                            insert.run(ws, state.lastReplicatedSeq, state.updatedAt ?? new Date().toISOString());
                            migratedRepl++;
                        }
                    }
                });
                txn(Object.entries(obj as Record<string, OutboxReplicationState>));
            }
        } catch (err) {
            console.error(`[outbox-sqlite] repl-state migration warning: ${(err as Error).message}`);
        }
    }

    // Rename outbox.json → outbox.json.migrated-<timestamp>. We do
    // this LAST so that any failure above leaves outbox.json intact.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const renamedTo = `${jsonPath}.migrated-${ts}`;
    try {
        fs.renameSync(jsonPath, renamedTo);
    } catch (err) {
        console.error(`[outbox-sqlite] could not rename outbox.json: ${(err as Error).message}`);
    }
    // Repl-state sidecar similarly.
    if (fs.existsSync(replJsonPath)) {
        try {
            fs.renameSync(replJsonPath, `${replJsonPath}.migrated-${ts}`);
        } catch { /* non-fatal */ }
    }
    return {
        migratedEntries,
        migratedRepl,
        durationMs: Date.now() - startedAt,
        renamedTo,
    };
}
