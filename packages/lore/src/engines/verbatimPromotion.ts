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
    promotionCooldownRemainingMs, recordPromotionAbort, clearPromotionCooldown,
    type PromotionState,
} from './verbatimPromotionState.js';
import { ensureChangesLogTable, dropChangesLogTable } from './sqliteVerbatimSchema.js';
import { streamStage, copyTail } from './verbatimPromotionStage.js';
import type { VerifyResult } from './verbatimPromotionVerify.js';
import { catchUpAndCommit, runWithoutBlocking, lockWaitBudgetMs } from './verbatimPromotionGate.js';
import { readPieceSidecar } from './pieces/pieceLayout.js';

const DEFAULT_PROMOTE_ROWS = 250_000;
/** How long an abort waits (without blocking the loop) for a foreign write lock so it can drop the triggers. */
const ABORT_DROP_BUDGET_MS = 10_000;

/** 3.27.1: exported so `lore migrate-vectors --to sqlite` refuses a store
 *  that would promote straight back to Lance on its first write. */
export function promoteRowsThreshold(): number {
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
    // F1b: after an aborted attempt, back off (1 min doubling to 1 h, persisted) instead of
    // re-streaming the whole table on the very next write.
    if (promotionCooldownRemainingMs(basePath) > 0) return false;
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

            // D7c (3.23) — capture piece-index state BEFORE any renames
            // happen. The piece sidecar (piece_layout.json) lives inside
            // `.lore/lancedb/` right alongside embedding_model.json
            // (embeddingFingerprint.ts) — the SAME directory
            // finishCommitRenames' step 1 moves aside as "stale" once this
            // promotion commits. Reading it now, while it is still in
            // place, is the only chance to know whether pieces were
            // built+complete pre-promotion; reading it after commit would
            // see the new (empty) lancedb dir and always report "absent".
            const pieceSidecarBefore = opts.dryRun ? null : readPieceSidecar(resolved);

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

            try {
                // F4: the DDL needs the write lock; never sleep inside SQLite waiting for another process's.
                await runWithoutBlocking(db, () => { ensureChangesLogTable(db); installChangesLogTriggers(db); }, lockWaitBudgetMs());
                // Step 2/3: stream-stage. Writes landing from here on are
                // captured by the changes-log triggers just installed.
                const staging = stagingDirPath(resolved);
                try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* clean slate */ }
                const { highWaterRowid, rowsStaged } = await streamStage(db, staging, dim);
                writePromotionState(resolved, { state: 'staging', startedAt, sourceRows: sourceCount, highWaterRowid });

                // Step 4: drain the tail while writes continue. SQLITE-STALL
                // fix item 1: copyTail holds no SQLite lock across an await
                // (it reads the changes-log in bounded synchronous windows
                // and applies each chunk to LanceDB outside any
                // transaction), so the live store's writes are never blocked
                // for the duration of the copy. They are captured by the
                // changes-log triggers and picked up here or in the final
                // catch-up below.
                const drained = await copyTail(db, staging, dim, highWaterRowid);
                let lastSeq = drained.lastSeq;
                let tailRowsApplied = drained.tailRowsApplied;

                // Step 5: build indexes on the staged table (FTS — the IVF
                // vector index is Lance-native and VerbatimStore's own
                // ensureVectorIndex/ensureFtsIndex builds it the same way
                // it would for any freshly-populated table; invoked here
                // via a plain connect+openTable so this module stays
                // independent of a live VerbatimStore instance).
                await buildStagedIndexes(staging, dim);

                // Steps 6+7: verify, then commit behind the gate (verbatimPromotionGate.ts):
                // free catch-up rounds while writers run, then a short write-barrier window in which
                // the small remaining tail is copied and the commit is made with no await between the
                // final `max(seq)` re-check and the renames.
                let committedAt = '';
                const outcome = await catchUpAndCommit({
                    db, resolved, staging, dim, highWaterRowid, sourceCount,
                    sampleSize: opts.sampleSize ?? 200, lastSeq, tailRowsApplied,
                    commitSync: () => {
                        committedAt = startedAt.replace(/[:.]/g, '-');
                        const committedState: PromotionState = { state: 'committed', startedAt, sourceRows: sourceCount, highWaterRowid, committedAt };
                        writePromotionState(resolved, committedState);
                        dropChangesLogTriggers(db);
                        dropChangesLogTable(db);
                        db.exec('COMMIT');
                        db.close(); // release the handle before renaming verbatim.sqlite out from under it
                        finishCommitRenames(resolved, committedState);
                        clearPromotionState(resolved);
                    },
                });
                if (outcome.kind === 'failed') {
                    const msg = outcome.verify.reasons.join(' | ');
                    if (outcome.reason === 'verify') log.error(`[verbatimPromotion] verification FAILED for ${resolved} - aborting, SQLite remains authoritative: ${msg}`);
                    else log.warn(`[verbatimPromotion] ${resolved}: ${msg}`);
                    // The staged copy is DELETED on every abort (F1c): the changes-log triggers are dropped
                    // here and the catch-up cursor lives only in memory, so a later attempt could not prove
                    // the staged table still equals SQLite and would have to re-verify everything anyway.
                    await abortStaging(db, resolved);
                    recordPromotionAbort(resolved, msg);
                    return { committed: false, dryRun: false, verify: outcome.verify, rowsStaged, tailRowsApplied: outcome.tailRowsApplied };
                }
                clearPromotionCooldown(resolved);
                return await finishCommitted(resolved, committedAt, outcome.verify, rowsStaged, outcome.tailRowsApplied, pieceSidecarBefore);
            } catch (err) {
                // Any failure before commit: abort cleanly, SQLite intact.
                try { if (db.open && db.inTransaction) db.exec('ROLLBACK'); } catch { /* best-effort */ }
                try { fs.rmSync(stagingDirPath(resolved), { recursive: true, force: true }); } catch { /* best-effort */ }
                try { if (db.open) await runWithoutBlocking(db, () => { dropChangesLogTriggers(db); dropChangesLogTable(db); }, 10_000); } catch { /* best-effort */ }
                clearPromotionState(resolved);
                recordPromotionAbort(resolved, `error: ${(err as Error).message}`);
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

/** Abort path shared by verification failure and a non-converging gate: discard staging,
 *  drop the log (without sleeping on a foreign lock), clear state. SQLite stays authoritative.
 *  Dropping the triggers needs the write lock. If a foreign process still holds it after the budget,
 *  the abort is still reported (the caller records the cooldown) and promotion.json is LEFT in place:
 *  recoverOnOpen (next open, or the next promoteWorkspace) drops the triggers and log then. */
async function abortStaging(db: DatabaseType, resolved: string): Promise<void> {
    try { fs.rmSync(stagingDirPath(resolved), { recursive: true, force: true }); } catch { /* best-effort */ }
    try {
        await runWithoutBlocking(db, () => { dropChangesLogTriggers(db); dropChangesLogTable(db); }, ABORT_DROP_BUDGET_MS);
        clearPromotionState(resolved);
    } catch (err) {
        log.warn(`[verbatimPromotion] ${resolved}: could not drop the changes-log triggers after an abort (${(err as Error).message}); they will be removed on the next open`);
    }
}

async function finishCommitted(
    resolved: string, committedAt: string, verify: VerifyResult, rowsStaged: number, tailRowsApplied: number,
    pieceSidecarBefore: ReturnType<typeof readPieceSidecar>,
): Promise<PromoteResult> {
    // D7c (3.23), revised per final review (B2): promotion used
    // to rebuild the piece index inline here, re-embedding every
    // node's pieces with the DEFAULT embedder before returning.
    // That widened the promotion lost-write window from minutes
    // to hours (SqliteVerbatimStore keeps serving reads/writes
    // against the just-renamed-away backup file for the whole
    // rebuild, with no promotion-state write gate of its own),
    // and used createEmbeddingProvider()'s default args rather
    // than the workspace's own/host-injected provider, so a
    // rebuilt sidecar could come out fingerprint-mismatched
    // (immediately `stale`) on a host with a non-default
    // embedder. The old sidecar (and, on the Lance engine, the
    // old piece table) were already swept into the
    // `.stale-<ts>` aside directory by finishCommitRenames step
    // 1 above, so the freshly-promoted Lance store simply has no
    // piece index at all — `pieceIndexStatus` reports
    // `not_built` and `pieceAwareSearch` falls back to the
    // canonical vector leg until an operator explicitly rebuilds
    // it. This keeps the promotion's own commit point exactly
    // where it always was (finishCommitRenames, above) with
    // nothing awaited afterward.
    if (pieceSidecarBefore?.complete) {
        // Deliberately no quote marks around not_built / the CLI
        // command name below — logger.ts's redactError() hashes
        // ANY quoted substring as a possible node-id (S9), which
        // would turn this operator-facing hint into unreadable
        // id# tags. The workspace path itself still gets scrubbed
        // by the same function (it is a /private|/Users|... path),
        // consistent with every other log line in this module.
        log.warn(`[verbatimPromotion] ${resolved} promoted from SQLite to Lance with a complete piece index in place — the piece index was NOT carried over (pieceIndexStatus is now not_built; recall falls back to canonical vectors until it is rebuilt). Run lore migrate piece-vectors on this workspace to rebuild it.`);
    }

    return {
        committed: true, dryRun: false, verify, rowsStaged, tailRowsApplied,
        newLanceDbPath: lancedbDirPath(resolved),
        sqliteBackupPath: promotedSqliteBackupPath(resolved, committedAt),
    };
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
