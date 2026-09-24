/**
 * verbatimPromotionState.ts — promotion.json state machine + the SQLite
 * changes-log that tracks writes landing DURING staging.
 *
 * 3.21 step 2 part 3 (design: 321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md
 * section 3, "Opus-owned design"). Crash-safe by construction: the ONLY
 * durable commit point is the rename sequence in verbatimPromotion.ts's
 * `commitPromotion` (step 7 in the design). Everything before that is
 * re-derivable from `promotion.json` + the still-fully-intact source
 * `verbatim.sqlite` — a crash at any point before commit leaves SQLite
 * authoritative and nothing lost; `recoverOnOpen` cleans up the half-built
 * staging artifacts so a later promotion attempt starts clean.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PromotionStateName = 'staging' | 'committed';

export interface PromotionState {
    state: PromotionStateName;
    startedAt: string;
    sourceRows: number;
    /** Set at the START of step 2 (stream-stage) — the rowid boundary the
     *  tail-copy (step 4) uses to find everything written since. Absent
     *  only in the brief window between recordIntent and stageRows. */
    highWaterRowid?: number;
    /** Set once step 7 (commit) begins — lets recoverOnOpen tell "crashed
     *  mid-commit, finish idempotently" apart from "crashed while staging,
     *  discard and retry". */
    committedAt?: string;
}

function promotionJsonPath(basePath: string): string {
    return path.join(basePath, '.lore', 'promotion.json');
}

export function readPromotionState(basePath: string): PromotionState | null {
    const fp = promotionJsonPath(basePath);
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf-8')) as PromotionState;
    } catch (err) {
        throw new Error(`[verbatimPromotion] corrupt promotion.json at ${fp}: ${(err as Error).message}`);
    }
}

/** Atomic write — stage to a tmp file and rename, same pattern
 *  embeddingFingerprint.ts's writeFingerprint uses, for the same reason
 *  (a half-written JSON here is a data-integrity issue: recoverOnOpen
 *  reads this file to decide what to clean up). */
export function writePromotionState(basePath: string, state: PromotionState): void {
    const fp = promotionJsonPath(basePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, fp);
}

export function clearPromotionState(basePath: string): void {
    const fp = promotionJsonPath(basePath);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

export function stagingDirPath(basePath: string): string {
    return path.join(basePath, '.lore', 'lancedb.promoting');
}

export function lancedbDirPath(basePath: string): string {
    return path.join(basePath, '.lore', 'lancedb');
}

export function verbatimSqlitePath(basePath: string): string {
    return path.join(basePath, '.lore', 'verbatim.sqlite');
}

export function promotedSqliteBackupPath(basePath: string, ts: string): string {
    return path.join(basePath, '.lore', `verbatim.sqlite.promoted-${ts}`);
}

/**
 * Changes-log table + triggers — written by SQLite itself (not application
 * code) so EVERY write path (store/storeBatch/tombstone/physicalDelete/
 * bulk*) is covered automatically, with no risk of a write path forgetting
 * to log. Created at the START of staging, dropped on both commit and
 * abort. `verbatim_changes_log` itself (the bare table) already exists via
 * sqliteVerbatimSchema.ts's `ensureChangesLogTable` — this adds the
 * triggers that actually populate it, which only make sense to have live
 * while a promotion is in flight (see that module's own doc comment).
 */
export function installChangesLogTriggers(db: DatabaseType): void {
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS verbatim_changes_log_ai AFTER INSERT ON verbatim BEGIN
            INSERT INTO verbatim_changes_log (row_rowid, row_id, is_canonical, op, at)
            VALUES (new.rowid, new.id, new.is_canonical, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS verbatim_changes_log_au AFTER UPDATE ON verbatim BEGIN
            INSERT INTO verbatim_changes_log (row_rowid, row_id, is_canonical, op, at)
            VALUES (new.rowid, new.id, new.is_canonical, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS verbatim_changes_log_ad AFTER DELETE ON verbatim BEGIN
            INSERT INTO verbatim_changes_log (row_rowid, row_id, is_canonical, op, at)
            VALUES (old.rowid, old.id, old.is_canonical, 'delete', datetime('now'));
        END;
    `);
}

export function dropChangesLogTriggers(db: DatabaseType): void {
    db.exec(`
        DROP TRIGGER IF EXISTS verbatim_changes_log_ai;
        DROP TRIGGER IF EXISTS verbatim_changes_log_au;
        DROP TRIGGER IF EXISTS verbatim_changes_log_ad;
    `);
}
