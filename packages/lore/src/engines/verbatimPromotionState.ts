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

// ---- abort cooldown (3.35.3 review finding F1b) ------------------------------------------------
//
// An aborted promotion (writes never paused, verification failed, the write lock never freed, a
// thrown error) used to be retried by the very next write after the row-count threshold, i.e.
// immediately and forever: each attempt re-streams the whole table. The cooldown persists across
// restarts in `.lore/promotion-cooldown.json` (separate from promotion.json, which recoverOnOpen
// deletes on every start) and doubles on every consecutive abort: 1 min, 2, 4 ... capped at 1 h. A
// committed promotion clears it. It throttles only the AUTOMATIC trigger; an explicit
// `lore vectors promote` calls promoteWorkspace directly and ignores it (but still records aborts).

export interface PromotionCooldown {
    /** Consecutive aborts since the last commit. */
    failures: number;
    /** Epoch ms before which the automatic trigger will not start another attempt. */
    nextAttemptAt: number;
    lastReason: string;
    updatedAt: string;
}

const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 3_600_000;

function envMs(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Delay after the `failures`-th consecutive abort: base * 2^(failures-1), capped. */
export function promotionCooldownDelayMs(failures: number): number {
    const base = envMs('LORE_PROMOTION_COOLDOWN_MS', COOLDOWN_BASE_MS);
    const max = envMs('LORE_PROMOTION_COOLDOWN_MAX_MS', COOLDOWN_MAX_MS);
    return Math.min(max, base * 2 ** Math.max(0, failures - 1));
}

function cooldownJsonPath(basePath: string): string {
    return path.join(basePath, '.lore', 'promotion-cooldown.json');
}

/** Process cache so the per-write trigger check never touches the disk after the first read. */
const cooldownCache = new Map<string, PromotionCooldown | null>();

export function readPromotionCooldown(basePath: string): PromotionCooldown | null {
    const key = path.resolve(basePath);
    if (cooldownCache.has(key)) return cooldownCache.get(key) ?? null;
    let value: PromotionCooldown | null = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(cooldownJsonPath(key), 'utf-8')) as Partial<PromotionCooldown>;
        if (typeof parsed.failures === 'number' && typeof parsed.nextAttemptAt === 'number') {
            value = {
                failures: parsed.failures, nextAttemptAt: parsed.nextAttemptAt,
                lastReason: String(parsed.lastReason ?? ''), updatedAt: String(parsed.updatedAt ?? ''),
            };
        }
    } catch { /* absent or unreadable: no cooldown (fail open: a bad file must not disable promotion forever) */ }
    cooldownCache.set(key, value);
    return value;
}

/** Milliseconds until the automatic trigger may start another attempt (0 when it may). */
export function promotionCooldownRemainingMs(basePath: string, now: number = Date.now()): number {
    const c = readPromotionCooldown(basePath);
    return c ? Math.max(0, c.nextAttemptAt - now) : 0;
}

/** Record an aborted attempt: bump the consecutive-failure count and push the next attempt out. */
export function recordPromotionAbort(basePath: string, reason: string, now: number = Date.now()): PromotionCooldown {
    const key = path.resolve(basePath);
    const failures = (readPromotionCooldown(key)?.failures ?? 0) + 1;
    const next: PromotionCooldown = {
        failures, nextAttemptAt: now + promotionCooldownDelayMs(failures),
        lastReason: reason.slice(0, 500), updatedAt: new Date(now).toISOString(),
    };
    cooldownCache.set(key, next);
    try {
        const fp = cooldownJsonPath(key);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        const tmp = `${fp}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, fp);
    } catch { /* the in-memory cooldown still applies for this process */ }
    return next;
}

export function clearPromotionCooldown(basePath: string): void {
    const key = path.resolve(basePath);
    cooldownCache.set(key, null);
    try { fs.unlinkSync(cooldownJsonPath(key)); } catch { /* already gone */ }
}

/** Test seam: forget the in-process cache so the next read hits the file. */
export function resetPromotionCooldownCache(): void {
    cooldownCache.clear();
}
