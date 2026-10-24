/**
 * verbatimPromotionGate.ts - the catch-up rounds and the commit gate of a SQLite -> LanceDB promotion.
 *
 * Split out of verbatimPromotion.ts (3.35.3, review findings F1/F4/F6). The shape:
 *
 *   1. FREE ROUNDS. Each round opens a deferred read snapshot of SQLite (under WAL it blocks no
 *      writer), applies the changes-log delta up to that snapshot, and on the first round runs the
 *      full verification. A round ends with a row-count check and a content check of the entities
 *      it touched (F6). Writers are never blocked. When the unseen tail is small
 *      (<= smallTailRows(), default 1000 log rows) we move on; if it never gets small within
 *      MAX_GATE_ROUNDS the attempt is abandoned.
 *   2. BARRIER ATTEMPTS (F1a). The in-process writers of this workspace are parked behind an
 *      application-level write barrier (verbatimWriteBarrier.ts; they queue, never fail), the small
 *      tail is copied and checked, and the gate is taken: `BEGIN EXCLUSIVE`, re-check
 *      `max(seq) == lastSeq`, then the caller's synchronous commit (state file, drop triggers, COMMIT,
 *      close, renames). The barrier hold is bounded (2 s); nothing here holds a SQLite transaction
 *      across an await while in-process writers can run (the promotion uses its own connection and
 *      only ever holds a read snapshot across awaits). A write from ANOTHER process cannot be parked;
 *      it just makes the re-check fail and the attempt repeat (at most MAX_BARRIER_ATTEMPTS).
 *   3. NO EVENT-LOOP STALL ON A FOREIGN LOCK (F4). `busy_timeout` is a synchronous sleep inside
 *      sqlite3_step: with the usual 5000 ms a foreign write lock freezes the whole process. Every
 *      lock acquisition here runs with `busy_timeout = 0` and retries on a timer with an await
 *      between attempts; the timeout is restored in a `finally`. While a foreign process holds the
 *      write lock the barrier is lowered and we poll for the lock to free (budget
 *      lockWaitBudgetMs(), default 60 s) so in-process writers are not parked for it.
 */
import type { Database as DatabaseType } from 'better-sqlite3';

import { log } from '../logger.js';
import { isSqliteLockedError } from './graphShared/deleteOutcome.js';
import { copyTail } from './verbatimPromotionStage.js';
import { verifyPromotion, stagedRowCountsMatch, stagedEntitiesMatch, type VerifyResult } from './verbatimPromotionVerify.js';
import { raiseWriteBarrier } from './verbatimWriteBarrier.js';

/** Free catch-up rounds before the attempt is abandoned as non-convergent. */
export const MAX_GATE_ROUNDS = 25;
/** Barrier attempts (each ends in a commit or a changed log) before the attempt is abandoned. */
export const MAX_BARRIER_ATTEMPTS = 3;
export const BARRIER_HOLD_MS = 2000;
export const BARRIER_DRAIN_MS = 1000;
const LOCK_POLL_MS = 25;
const NORMAL_BUSY_TIMEOUT_MS = 5000;

const envInt = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
};
/** Unseen change-log rows at or below which the write barrier is raised. */
export const smallTailRows = (): number => envInt('LORE_PROMOTION_SMALL_TAIL_ROWS', 1000);
/** Total time spent waiting for a foreign process's write lock before the attempt is abandoned. */
export const lockWaitBudgetMs = (): number => envInt('LORE_PROMOTION_LOCK_WAIT_MS', 60_000);

/** Test seams (never set in production). */
export const promotionTestHooks: {
    afterRound?: (round: number) => void | Promise<void>;
    beforeGate?: (attempt: number) => void | Promise<void>;
} = {};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` (one synchronous SQLite operation) with `busy_timeout = 0`, retrying on lock errors with
 * an await between attempts, until `budgetMs` has elapsed (then the last lock error is thrown).
 * The timeout is restored in a `finally`. The event loop is never blocked by a foreign lock.
 */
export async function runWithoutBlocking<T>(db: DatabaseType, fn: () => T, budgetMs: number): Promise<T> {
    const deadline = Date.now() + budgetMs;
    db.pragma('busy_timeout = 0');
    try {
        for (;;) {
            try {
                return fn();
            } catch (err) {
                if (!isSqliteLockedError(err) || Date.now() >= deadline) throw err;
            }
            await sleep(LOCK_POLL_MS);
        }
    } finally {
        if (db.open) db.pragma(`busy_timeout = ${NORMAL_BUSY_TIMEOUT_MS}`);
    }
}

/** `BEGIN EXCLUSIVE` without blocking the loop; false when the lock was not free before `deadline`. */
async function acquireExclusive(db: DatabaseType, deadline: number): Promise<boolean> {
    try {
        await runWithoutBlocking(db, () => db.exec('BEGIN EXCLUSIVE'), Math.max(0, deadline - Date.now()));
        return true;
    } catch (err) {
        if (isSqliteLockedError(err)) return false;
        throw err;
    }
}

/** Poll (no barrier, no stall) until the write lock can be taken and released again, or the budget ends. */
async function waitForWriteLockFree(db: DatabaseType, budgetMs: number): Promise<boolean> {
    try {
        await runWithoutBlocking(db, () => { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); }, budgetMs);
        return true;
    } catch (err) {
        if (isSqliteLockedError(err)) return false;
        throw err;
    }
}

const maxLogSeq = (db: DatabaseType): number =>
    (db.prepare(`SELECT COALESCE(MAX(seq), 0) as m FROM verbatim_changes_log`).get() as { m: number }).m;
const unseenRows = (db: DatabaseType, lastSeq: number): number =>
    (db.prepare(`SELECT count(*) as c FROM verbatim_changes_log WHERE seq > ?`).get(lastSeq) as { c: number }).c;

export interface GateInputs {
    db: DatabaseType;
    resolved: string;
    staging: string;
    dim: number;
    highWaterRowid: number;
    sourceCount: number;
    sampleSize: number;
    /** Highest changes-log seq already applied to the staged table. */
    lastSeq: number;
    tailRowsApplied: number;
    /**
     * Called with the exclusive lock held and `max(seq) == lastSeq` re-checked, with no await since.
     * Must do the whole commit synchronously: state file, drop triggers and log, COMMIT, close, renames.
     */
    commitSync: () => void;
}

export type GateOutcome =
    | { kind: 'committed'; verify: VerifyResult; tailRowsApplied: number }
    | { kind: 'failed'; reason: 'verify' | 'nonconvergent' | 'lock'; verify: VerifyResult; tailRowsApplied: number };

/** Run the catch-up rounds and the barrier-protected gate. Never leaves a transaction open. */
export async function catchUpAndCommit(inp: GateInputs): Promise<GateOutcome> {
    const { db, resolved, staging, dim, highWaterRowid } = inp;
    let lastSeq = inp.lastSeq;
    let tailRowsApplied = inp.tailRowsApplied;
    // Held in an object so closures and the loop below see one value (TS cannot track closure writes to a `let`).
    const st: { verify: VerifyResult | null } = { verify: null };

    const failure = (reason: 'verify' | 'nonconvergent' | 'lock', msg: string | null): GateOutcome => {
        const base = st.verify ?? { sourceRowCount: inp.sourceCount, targetRowCount: 0, sampledRows: 0, sampleFailures: 0 };
        const v: VerifyResult = msg === null && st.verify ? st.verify : { ...base, ok: false, reasons: [msg ?? 'promotion aborted'] };
        return { kind: 'failed', reason, verify: v, tailRowsApplied };
    };

    /** One catch-up pass inside a read snapshot. Returns an abort message, or null when staged == SQLite. */
    const catchUpOnce = async (): Promise<string | null> => {
        db.exec('BEGIN');
        try {
            const snapSeq = maxLogSeq(db);
            const delta = await copyTail(db, staging, dim, highWaterRowid, { fromSeq: lastSeq, toSeq: snapSeq });
            lastSeq = delta.lastSeq;
            tailRowsApplied += delta.tailRowsApplied;
            if (st.verify === null) {
                st.verify = await verifyPromotion(db, staging, inp.sampleSize);
                return st.verify.ok ? null : st.verify.reasons.join(' | ');
            }
            if (!(await stagedRowCountsMatch(db, staging)).ok) return 'row count mismatch after final catch-up';
            if (!delta.touchedOverflow) {
                const content = await stagedEntitiesMatch(db, staging, delta.touchedEntities);
                if (!content.ok) return `content mismatch after final catch-up: ${content.detail}`;
            }
            return null;
        } finally {
            db.exec('COMMIT'); // end the read snapshot
        }
    };
    const verifyFailed = (msg: string): GateOutcome => failure('verify', st.verify && !st.verify.ok ? null : msg);

    // ---- 1. free rounds: writers are never blocked ----
    let round = 0;
    for (;;) {
        if (++round > MAX_GATE_ROUNDS) {
            return failure('nonconvergent', `writes kept landing during ${MAX_GATE_ROUNDS} catch-up rounds (tail never fell below ${smallTailRows()} rows); promotion aborted and will retry after a cooldown`);
        }
        const bad = await catchUpOnce();
        if (bad) return verifyFailed(bad);
        if (promotionTestHooks.afterRound) await promotionTestHooks.afterRound(round);
        if (unseenRows(db, lastSeq) <= smallTailRows()) break;
    }

    // ---- 2. barrier attempts ----
    let attempt = 1;
    const lockBudgetEnd = { at: 0 }; // set when a foreign lock is first seen
    while (attempt <= MAX_BARRIER_ATTEMPTS) {
        const handle = await raiseWriteBarrier(resolved, { holdMs: BARRIER_HOLD_MS, drainMs: BARRIER_DRAIN_MS });
        if (!handle) {
            // Writes already in flight did not finish in time; nobody was blocked for long. Back off.
            log.warn(`[verbatimPromotion] ${resolved}: in-process writes did not drain within ${BARRIER_DRAIN_MS} ms; backing off`);
            attempt++;
            await sleep(200);
            const bad = await catchUpOnce();
            if (bad) return verifyFailed(bad);
            continue;
        }
        let contended = false;
        try {
            if (promotionTestHooks.beforeGate) await promotionTestHooks.beforeGate(attempt);
            const bad = await catchUpOnce(); // the small tail, with in-process writers parked
            if (bad) return verifyFailed(bad);
            if (await acquireExclusive(db, handle.deadline)) {
                if (maxLogSeq(db) === lastSeq) {
                    // ---- synchronous gate: NO await from here to the renames ----
                    inp.commitSync();
                    handle.retire(); // writers parked behind the barrier must not resume on the retired file
                    return { kind: 'committed', verify: st.verify!, tailRowsApplied };
                }
                db.exec('ROLLBACK'); // a write from another process (or an expired barrier) landed; go again
                attempt++;
            } else {
                contended = true;
            }
        } finally {
            handle.release();
        }
        if (contended) {
            // A foreign process holds the write lock. Writers are un-parked; poll without stalling.
            if (lockBudgetEnd.at === 0) lockBudgetEnd.at = Date.now() + lockWaitBudgetMs();
            const left = lockBudgetEnd.at - Date.now();
            if (left <= 0 || !(await waitForWriteLockFree(db, left))) {
                return failure('lock', `the SQLite write lock was still held by another process after waiting; promotion aborted and will retry after a cooldown`);
            }
        }
    }
    return failure('nonconvergent', `the change log kept moving across ${MAX_BARRIER_ATTEMPTS} write-barrier attempts (writes from another process?); promotion aborted and will retry after a cooldown`);
}
