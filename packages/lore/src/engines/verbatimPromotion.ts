/**
 * verbatimPromotion.ts — SQLite -> LanceDB promotion orchestrator.
 *
 * 3.21 step 2 part 3 (design section 3, Opus-owned). Selection wiring
 * (which engine a workspace uses, `workspaces.json`'s `vectorEngine`
 * field) is OUT OF SCOPE for this step — see the design's section 2 and
 * this repo's current work split. This module operates entirely on
 * EXPLICIT paths: give it a workspace's base path (the dir containing
 * `.lore/`) and it promotes that workspace's `verbatim.sqlite`, full stop.
 * `promoteWorkspace`'s return value (`newLanceDbPath`,
 * `sqliteBackupPath`) is the hook a FUTURE resolver-wiring change calls to
 * actually swap a live cached store — recorded here, not built here.
 *
 * Crash-safety model (design section 3): `promotion.json` is the ONLY
 * source of truth for "what step was in flight". The single commit point
 * is `commitPromotion`'s rename sequence — everything before it is
 * discardable (source SQLite is untouched and authoritative throughout
 * staging); everything at or after it is IDEMPOTENT (safe to re-run the
 * remaining renames if a crash lands mid-commit). `recoverOnOpen` is the
 * one function that must run before ANY new promotion attempt, and is
 * safe to call unconditionally (no-op when there's nothing to recover).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../logger.js';
import {
    readPromotionState, writePromotionState, clearPromotionState,
    stagingDirPath, lancedbDirPath, verbatimSqlitePath, promotedSqliteBackupPath,
    installChangesLogTriggers, dropChangesLogTriggers,
    type PromotionState,
} from './verbatimPromotionState.js';
import { ensureChangesLogTable, dropChangesLogTable } from './sqliteVerbatimSchema.js';
import { streamStage, copyTail } from './verbatimPromotionStage.js';
import { verifyPromotion, type VerifyResult } from './verbatimPromotionVerify.js';

const DEFAULT_PROMOTE_ROWS = 250_000;

function promoteRowsThreshold(): number {
    const raw = process.env.LORE_VECTOR_PROMOTE_ROWS;
    if (!raw || raw.trim() === '') return DEFAULT_PROMOTE_ROWS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PROMOTE_ROWS;
}

/** Cheap per-process registry — "at most one [promotion] per workspace at
 *  a time" (design section 3, "Trigger"). Keyed on the resolved basePath. */
const inFlight = new Set<string>();

/** Checked after each committed storeBatch/store on a SQLite store (design
 *  section 3, "Trigger") — a cheap counter compare, not `COUNT(*)`. The
 *  counter itself is the caller's `handleCount`-adjacent write tally; this
 *  function only applies the policy (0 disables, threshold compare,
 *  already-in-flight guard). */
export function shouldTriggerPromotion(basePath: string, rowCountEstimate: number): boolean {
    const threshold = promoteRowsThreshold();
    if (threshold === 0) return false;
    if (inFlight.has(path.resolve(basePath))) return false;
    return rowCountEstimate >= threshold;
}

export interface PromoteOptions {
    dryRun?: boolean;
    /** Row count above which the design's default trigger would have
     *  fired — used only for the CLI's dry-run summary, never to gate the
     *  actual promotion (an explicit `lore vectors promote` call always
     *  runs, per design section 3's "Demotion is not built... manual CLI
     *  ... for operators" — a manual invocation is not the auto-trigger). */
    sampleSize?: number;
}

export interface PromoteResult {
    committed: boolean;
    dryRun: boolean;
    verify: VerifyResult;
    newLanceDbPath?: string;
    sqliteBackupPath?: string;
    rowsStaged: number;
    tailRowsApplied: number;
}

/**
 * Restart recovery (design step 8). MUST run before any new promotion
 * attempt on `basePath`. Safe to call unconditionally — a no-op when
 * `promotion.json` is absent.
 *
 *   - state:'staging' with no commit: discard the staging dir, drop the
 *     changes-log table + triggers, SQLite continues unmodified.
 *   - state:'committed': finish any remaining renames, idempotently (the
 *     rename sequence in commitPromotion is itself written to tolerate
 *     being re-run against a partially-renamed disk state — see its own
 *     comments).
 */
export function recoverOnOpen(basePath: string): void {
    const state = readPromotionState(basePath);
    if (!state) return;
    if (state.state === 'staging') {
        log.info(`[verbatimPromotion] recovering from an interrupted staging run at ${basePath} — discarding the staging dir, resuming SQLite as authoritative`);
        const staging = stagingDirPath(basePath);
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
        const dbPath = verbatimSqlitePath(basePath);
        if (fs.existsSync(dbPath)) {
            const db = new Database(dbPath);
            try { dropChangesLogTriggers(db); dropChangesLogTable(db); } finally { db.close(); }
        }
        clearPromotionState(basePath);
        return;
    }
    // state === 'committed': finish idempotently.
    log.info(`[verbatimPromotion] recovering from an interrupted commit at ${basePath} — finishing the rename sequence idempotently`);
    finishCommitRenames(basePath, state);
    clearPromotionState(basePath);
}

/** The rename sequence itself, factored out so both the normal commit
 *  path and crash recovery can call it — idempotent: each rename is
 *  guarded by an existence check, so re-running it against a disk state
 *  where some renames already landed (crash mid-sequence) just skips the
 *  ones already done. */
export function finishCommitRenames(basePath: string, state: PromotionState): void {
    const staging = stagingDirPath(basePath);
    const finalDir = lancedbDirPath(basePath);
    const sqlitePath = verbatimSqlitePath(basePath);
    const ts = state.committedAt ?? new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = promotedSqliteBackupPath(basePath, ts);

    // 1. Move any STALE lancedb/ aside first (design: "first moving any
    //    stale lancedb aside"). A prior failed/partial promotion or a
    //    hand-rolled lancedb dir from before this workspace ever used
    //    SQLite could both be sitting here; never silently clobber it.
    if (fs.existsSync(finalDir) && !fs.existsSync(staging)) {
        // staging is already gone — this rename already completed in an
        // earlier (crashed) attempt at this exact commit. Nothing to do.
    } else if (fs.existsSync(finalDir)) {
        const staleAside = `${finalDir}.stale-${ts}`;
        if (!fs.existsSync(staleAside)) fs.renameSync(finalDir, staleAside);
    }
    // 2. Promote the staging dir to the canonical name.
    if (fs.existsSync(staging)) {
        fs.renameSync(staging, finalDir);
    }
    // 3. Rename verbatim.sqlite -> verbatim.sqlite.promoted-<ts> (kept, not
    //    deleted — it is the rollback, removed only by an explicit CLI
    //    prune per the design).
    if (fs.existsSync(sqlitePath) && !fs.existsSync(backupPath)) {
        fs.renameSync(sqlitePath, backupPath);
    }
}

/**
 * The full promotion procedure (design section 3 steps 1-7), against an
 * explicit workspace base path. Does NOT touch `workspaces.json` — see
 * this file's header. Does NOT swap any live resolver-cached store — the
 * caller (once section-2 wiring exists) is expected to reopen a fresh
 * VerbatimStore at `newLanceDbPath` after this returns `committed: true`.
 */
export async function promoteWorkspace(basePath: string, dim: number, opts: PromoteOptions = {}): Promise<PromoteResult> {
    const resolved = path.resolve(basePath);
    recoverOnOpen(resolved); // never start a new attempt on top of a stale one

    if (inFlight.has(resolved)) {
        throw new Error(`[verbatimPromotion] a promotion is already in flight for ${resolved}`);
    }
    inFlight.add(resolved);
    try {
        const sqlitePath = verbatimSqlitePath(resolved);
        if (!fs.existsSync(sqlitePath)) {
            throw new Error(`[verbatimPromotion] no verbatim.sqlite at ${sqlitePath} — nothing to promote`);
        }
        const db: DatabaseType = new Database(sqlitePath);
        db.pragma('busy_timeout = 5000');
        try {
            const sourceCount = (db.prepare(`SELECT count(*) as c FROM verbatim`).get() as { c: number }).c;

            if (opts.dryRun) {
                return {
                    committed: false, dryRun: true,
                    verify: { ok: true, reasons: [], sourceRowCount: sourceCount, targetRowCount: 0, sampledRows: 0, sampleFailures: 0 },
                    rowsStaged: 0, tailRowsApplied: 0,
                };
            }

            // Step 1: record intent.
            const startedAt = new Date().toISOString();
            writePromotionState(resolved, { state: 'staging', startedAt, sourceRows: sourceCount });
            ensureChangesLogTable(db);
            installChangesLogTriggers(db);

            try {
                // Step 2/3: stream-stage. Writes landing from here on are
                // captured by the changes-log triggers just installed.
                const staging = stagingDirPath(resolved);
                try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* clean slate */ }
                const { highWaterRowid, rowsStaged } = await streamStage(db, staging, dim);
                writePromotionState(resolved, { state: 'staging', startedAt, sourceRows: sourceCount, highWaterRowid });

                // Step 4: tail copy. SQLite's own EXCLUSIVE-transaction file
                // lock is the "write gate" — better-sqlite3 is synchronous
                // and single-connection-per-handle, so briefly holding an
                // EXCLUSIVE transaction on THIS connection blocks any other
                // connection's write (via SQLITE_BUSY + busy_timeout retry,
                // set above) for exactly as long as the tail-copy takes,
                // with zero application-level coordination needed on the
                // live SqliteVerbatimStore's write path. Writes are
                // delayed, never lost or rejected (design: "writes continue
                // during staging").
                let tailRowsApplied = 0;
                db.exec('BEGIN EXCLUSIVE');
                try {
                    const tail = await copyTail(db, staging, dim, highWaterRowid);
                    tailRowsApplied = tail.tailRowsApplied;
                } finally {
                    db.exec('COMMIT');
                }

                // Step 5: build indexes on the staged table (FTS — the IVF
                // vector index is Lance-native and VerbatimStore's own
                // ensureVectorIndex/ensureFtsIndex builds it the same way
                // it would for any freshly-populated table; invoked here
                // via a plain connect+openTable so this module stays
                // independent of a live VerbatimStore instance).
                await buildStagedIndexes(staging, dim);

                // Step 6: verify.
                const verify = await verifyPromotion(db, staging, opts.sampleSize ?? 200);
                if (!verify.ok) {
                    log.error(`[verbatimPromotion] verification FAILED for ${resolved} — aborting, SQLite remains authoritative: ${verify.reasons.join(' | ')}`);
                    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
                    dropChangesLogTriggers(db);
                    dropChangesLogTable(db);
                    clearPromotionState(resolved);
                    return { committed: false, dryRun: false, verify, rowsStaged, tailRowsApplied };
                }

                // Step 7: commit. The single durable commit point.
                const committedAt = startedAt.replace(/[:.]/g, '-');
                writePromotionState(resolved, { state: 'committed', startedAt, sourceRows: sourceCount, highWaterRowid, committedAt });
                dropChangesLogTriggers(db);
                dropChangesLogTable(db);
                db.close(); // release the handle before renaming verbatim.sqlite out from under it
                finishCommitRenames(resolved, { state: 'committed', startedAt, sourceRows: sourceCount, highWaterRowid, committedAt });
                clearPromotionState(resolved);

                return {
                    committed: true, dryRun: false, verify, rowsStaged, tailRowsApplied,
                    newLanceDbPath: lancedbDirPath(resolved),
                    sqliteBackupPath: promotedSqliteBackupPath(resolved, committedAt),
                };
            } catch (err) {
                // Any failure before commit: abort cleanly, SQLite intact.
                try { fs.rmSync(stagingDirPath(resolved), { recursive: true, force: true }); } catch { /* best-effort */ }
                try { dropChangesLogTriggers(db); dropChangesLogTable(db); } catch { /* best-effort */ }
                clearPromotionState(resolved);
                throw err;
            }
        } finally {
            // db may already be closed (commit path) — better-sqlite3's
            // close() is idempotent-safe to call again via db.open check.
            if (db.open) db.close();
        }
    } finally {
        inFlight.delete(resolved);
    }
}

export async function buildStagedIndexes(stagingDir: string, _dim: number): Promise<void> {
    const lancedb = await import('@lancedb/lancedb');
    const { computeIvfPartitions } = await import('./verbatimBatch.js');
    const connection = await lancedb.connect(stagingDir);
    const table = await connection.openTable('lore_verbatim');
    const count = await table.countRows();
    if (count === 0) return;
    // Same 256-row floor ensureVectorIndex uses (verbatimBatch.ts): below
    // that, an unindexed vectorSearch is already sub-millisecond and
    // exact, and IVF_FLAT's KMeans step genuinely cannot train more
    // centroids than there are vectors (a small promoted table hit
    // exactly that error before this fix — computeIvfPartitions alone
    // isn't enough at very low row counts, e.g. 4 partitions for 10 rows
    // was still requested by a naive sqrt(count) formula; reusing the
    // SAME helper + threshold ensureVectorIndex uses is what actually
    // closes it, not a smaller constant).
    if (count >= 256) {
        try {
            const numPartitions = computeIvfPartitions(count);
            await table.createIndex('vector', { config: lancedb.Index.ivfFlat({ numPartitions }) });
        } catch (err) {
            log.error(`[verbatimPromotion] staged vector index build failed (non-fatal — search still works unindexed): ${(err as Error).message}`);
        }
    }
    try {
        await table.createIndex('text', { config: lancedb.Index.fts() });
    } catch (err) {
        log.error(`[verbatimPromotion] staged FTS index build failed (non-fatal — search still works unindexed): ${(err as Error).message}`);
    }
}
