/**
 * surrealSettle.ts — wait for an on-disk SurrealDB store to stop changing
 * after its handle was closed, and read back what it actually holds.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `SurrealGraph.close()` awaits `db.close()`, and `@surrealdb/node`'s
 * `close()` only calls `this.#engine?.free()` — it does NOT await a flush.
 * surrealkv's WAL→sstable flush runs ~10-25 ms AFTER `close()` resolves, and
 * it writes by the ON-DISK PATH captured when the store was opened. Anything
 * that renames that directory aside and drops a different store at the same
 * path inside that window gets its files unlinked by the deferred flush:
 * `wal/00000000000000000000.wal` has the same filename in every fresh store,
 * so the flush of the OLD store deletes the NEW store's only data file. The
 * restored manifest still says 55 bytes / no sstables, so the next open reads
 * an EMPTY graph and reports success.
 *
 * That is exactly what `lore restore` does — sideline the live store, put the
 * archived one in its place, milliseconds apart. Measured on this machine:
 * 8/8 restores lost their data, 4/4 with a space in the path and 4/4 without
 * (the space handling in `surrealDataPath` is a separate, already-correct
 * concern — it is not the cause).
 *
 * The fix is a bounded settle: poll the store directory until it stops
 * changing, then let the caller move it. Cheap (~25-75 ms in practice),
 * bounded (2 s by default), and best-effort — a store that never settles is a
 * slow close, never a failed one.
 *
 * ── WHAT "QUIESCENT" MEANS HERE ─────────────────────────────────────────────
 *
 * Observed surrealkv close sequence for a store with pending writes:
 *   t+0    LOCK, manifest/…0.manifest(55), wal/…0.wal(1862)   ← close() resolved
 *   t+10   … sstables/…1.sst appears, manifest/.tmp_… appears
 *   t+25   manifest rewritten (63), .tmp_ gone, wal/ EMPTY
 * So an empty `wal/` is a positive "the flush finished" signal, `.tmp_*` files
 * are a positive "still working" signal, and a byte-and-mtime-identical tree
 * across two consecutive polls is the general one. A store whose WAL is
 * legitimately non-empty and idle (one just extracted from a backup tarball
 * and never opened) never empties its WAL, so tree-stability alone settles it
 * once `minQuietMs` has elapsed.
 *
 * Side Effects: `settleSurrealStore` only stats the directory. `probeSurrealStore`
 *   and `probeSurrealLock` open the embedded engine (which takes the directory
 *   lock and can create/flush files), then close and settle it again.
 * Concurrency: none of these serialise anything — they observe.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { openSurreal, surrealDataPath } from './surrealConnection.js';
import { NODE_TABLE } from './surrealRecordId.js';

/** Poll interval, total budget, and the floor below which we never declare a
 *  WAL-carrying store settled. Overridable per call and by env for operators
 *  on slow disks; `LORE_SURREAL_SETTLE_BUDGET_MS=0` disables the wait entirely. */
const DEFAULT_SETTLE_BUDGET_MS = 2_000;
const DEFAULT_SETTLE_POLL_MS = 25;
const DEFAULT_SETTLE_MIN_QUIET_MS = 150;

/**
 * QA round 2 (2026-09-03): the `unchangedSinceStart` fast path below was
 * trusting a tree that matched the PRE-LOOP snapshot the instant that was
 * confirmed by a single poll — i.e. as early as one `pollMs` after
 * `settleSurrealStore` was called. This module's own header documents the
 * deferred flush landing "~10-25 ms after `close()` resolves" — squarely
 * inside that one-poll window plus ordinary scheduler jitter, so a flush
 * landing at, say, t+30ms (one `pollMs` tick late) was invisible: the fast
 * path had already returned `quiescent` at t+25-27ms because nothing had
 * moved YET, not because nothing was going to. Fixed by never trusting the
 * fast path before at least two full poll intervals have elapsed AND at
 * least this floor — chosen to sit above the documented flush window with
 * headroom for jitter, while staying well under the pre-existing
 * `minQuietMs` floor this fast path exists to beat.
 */
const FAST_PATH_MIN_ELAPSED_MS = 60;

export interface SurrealSettleOptions {
    /** Hard ceiling on the wait. `0` skips settling. */
    budgetMs?: number;
    /** Gap between directory snapshots. */
    pollMs?: number;
    /** Minimum wait before a store whose `wal/` is non-empty counts as settled. */
    minQuietMs?: number;
}

export interface SurrealSettleResult {
    /** True unless the budget ran out while the tree was still changing. */
    settled: boolean;
    outcome: 'absent' | 'disabled' | 'quiescent' | 'timeout';
    waitedMs: number;
    polls: number;
}

/** Result of opening a store to read back what it holds. */
export interface SurrealStoreProbe {
    /** True when the embedded engine opened the store and answered a query. */
    readable: boolean;
    /** Rows in the `node` table, or null when the store was not readable. */
    nodeCount: number | null;
    /** Why it was not readable (or not probed at all). Null on success. */
    detail: string | null;
}

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

interface Fingerprint {
    /** `rel:size:mtimeMs` for every file, sorted — changes on any write. */
    sig: string;
    /** True when `wal/` is missing or holds no files. */
    walEmpty: boolean;
    /** True while surrealkv's atomic-rename temp files are still on disk. */
    hasTmp: boolean;
}

/**
 * Snapshot every file under a store directory. Returns null when the
 * directory is gone (a store that no longer exists is trivially quiescent).
 * Races with the very flush we are waiting on, so every stat is tolerant of
 * a file vanishing between readdir and stat.
 */
function fingerprintStore(storeDir: string): Fingerprint | null {
    const parts: string[] = [];
    let walEmpty = true;
    let hasTmp = false;
    function walk(dir: string, rel: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const abs = path.join(dir, entry.name);
            const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.name.startsWith('.tmp_') || entry.name.includes('.tmp_')) hasTmp = true;
            if (entry.isDirectory()) {
                parts.push(`${relPath}/`);
                walk(abs, relPath);
            } else {
                if (rel === 'wal') walEmpty = false;
                try {
                    const stat = fs.statSync(abs);
                    parts.push(`${relPath}:${stat.size}:${stat.mtimeMs}`);
                } catch {
                    // Unlinked mid-walk — that IS a change; make the signature differ.
                    parts.push(`${relPath}:gone:${Date.now()}`);
                }
            }
        }
    }
    if (!fs.existsSync(storeDir)) return null;
    walk(storeDir, '');
    return { sig: parts.join('\n'), walEmpty, hasTmp };
}

/**
 * settleSurrealStore — block until `storeDir` stops changing, or the budget
 * expires. Pass the ACTUAL store directory (`surrealDataPath(workspaceDir)`),
 * not the workspace directory.
 *
 * Never throws: a store that will not settle is reported as
 * `{ settled: false, outcome: 'timeout' }` so callers can log rather than
 * abort an operator's backup over a slow disk.
 *
 * ── THE `minQuietMs` FLOOR IS FOR AN IN-FLIGHT FLUSH, NOT FOR A STORE THAT
 *    NEVER MOVED ─────────────────────────────────────────────────────────
 *
 * Measured (see this module's header): a store with a REAL pending flush
 * changes visibly within the first poll — `.tmp_*` appears, `wal/` empties,
 * an sstable lands — so its tree at t+0 (before this function is even
 * called) never matches its tree a poll or two later. A store whose `wal/`
 * is non-empty but has been BYTE-IDENTICAL since before polling started
 * (reopening a workspace re-applies its schema, which appears to touch the
 * WAL but leaves a residue that never compacts — measured ~150ms wasted on
 * every `SurrealGraph.close()` of a reopened, otherwise-idle store, flat
 * across 0-20k nodes) was never mid-flush to begin with: there is nothing to
 * wait out. So a tree that matches the PRE-LOOP snapshot is trusted once
 * that has held for at least `FAST_PATH_MIN_ELAPSED_MS` measured from the
 * START of polling (NOT merely "one poll confirmed it") — a single poll can
 * land before a real, still-in-flight flush has written its first byte, so
 * trusting it on poll one is indistinguishable from trusting a store that
 * genuinely never moved. The floor below (`minQuietMs`) applies once
 * something has actually been observed to change — the case it exists for.
 */
export async function settleSurrealStore(
    storeDir: string,
    opts: SurrealSettleOptions = {},
): Promise<SurrealSettleResult> {
    const startedAt = Date.now();
    const budgetMs = opts.budgetMs ?? intEnv('LORE_SURREAL_SETTLE_BUDGET_MS', DEFAULT_SETTLE_BUDGET_MS);
    const pollMs = opts.pollMs ?? intEnv('LORE_SURREAL_SETTLE_POLL_MS', DEFAULT_SETTLE_POLL_MS);
    const minQuietMs = opts.minQuietMs ?? intEnv('LORE_SURREAL_SETTLE_MIN_QUIET_MS', DEFAULT_SETTLE_MIN_QUIET_MS);
    if (budgetMs <= 0) return { settled: true, outcome: 'disabled', waitedMs: 0, polls: 0 };

    const initial = fingerprintStore(storeDir);
    if (initial === null) return { settled: true, outcome: 'absent', waitedMs: 0, polls: 1 };
    let previous = initial;
    let polls = 1;
    // True as long as every snapshot taken so far — including this one —
    // matches the very first one. Once anything changes, stays false for
    // the rest of this call: real movement was observed, so the floor below
    // must do its job for the remainder of the wait.
    let unchangedSinceStart = true;

    while (Date.now() - startedAt < budgetMs) {
        await delay(Math.max(1, pollMs));
        const current = fingerprintStore(storeDir);
        polls++;
        if (current === null) {
            return { settled: true, outcome: 'absent', waitedMs: Date.now() - startedAt, polls };
        }
        if (current.sig !== initial.sig) unchangedSinceStart = false;
        const stable = current.sig === previous.sig && !current.hasTmp;
        const elapsed = Date.now() - startedAt;
        // The unchangedSinceStart fast path may only fire once it has been
        // true across at least two full poll intervals AND at least
        // FAST_PATH_MIN_ELAPSED_MS have elapsed since polling started — a
        // single poll firing early (scheduler jitter, a fast disk) can land
        // before a real deferred flush has written anything, and the floor
        // must never be allowed to sit below the documented flush window.
        const fastPathReady = unchangedSinceStart
            && elapsed >= Math.max(pollMs * 2, FAST_PATH_MIN_ELAPSED_MS);
        if (stable && (current.walEmpty || fastPathReady || elapsed >= minQuietMs)) {
            return { settled: true, outcome: 'quiescent', waitedMs: elapsed, polls };
        }
        previous = current;
    }
    return { settled: false, outcome: 'timeout', waitedMs: Date.now() - startedAt, polls };
}

/**
 * Whether a store directory holds a recognizable store, is genuinely absent,
 * or could not be inspected at all.
 *
 * QA round 2 (2026-09-03): `looksLikeSurrealStore` used to collapse EVERY
 * `readdirSync` failure — a missing directory (ENOENT) exactly as much as a
 * directory that exists but cannot be listed (EACCES, a bad mount, …) — into
 * the same `false`. `probeSurrealLock` then read that `false` as "nothing
 * there to hold" and reported `free: true` for a store it could not actually
 * see into, which is the opposite of what an unreadable-but-present
 * directory should mean for a lock probe: "cannot tell" is not "free".
 */
type StoreDirInspection =
    | { state: 'absent' }
    | { state: 'present' }
    | { state: 'undeterminable'; detail: string };

function inspectStoreDir(storeDir: string): StoreDirInspection {
    let entries: string[];
    try {
        entries = fs.readdirSync(storeDir);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return { state: 'absent' };
        return { state: 'undeterminable', detail: err.message };
    }
    const present = entries.includes('LOCK') || entries.includes('manifest') || entries.includes('CURRENT');
    return { state: present ? 'present' : 'absent' };
}

/**
 * looksLikeSurrealStore — cheap "is this an embedded store directory, or just
 * a directory that happens to be called `surreal`?" check.
 *
 * Guards every caller that would otherwise hand a path to `openSurreal`,
 * because `openSurreal` CREATES a store at a path that has none — which would
 * turn a read-only verification pass into a silent write, and (in restore)
 * would manufacture a "pre-existing store" for the sideline logic to find.
 * Matches both supported backends: surrealkv writes `LOCK` + `manifest/`,
 * rocksdb writes `LOCK` + `CURRENT`.
 *
 * Returns `false` for BOTH "genuinely absent" and "cannot tell" (an
 * unreadable directory) — a boolean has nowhere else to put the third state.
 * `probeSurrealLock` below needs that distinction and calls `inspectStoreDir`
 * directly rather than going through this function.
 */
export function looksLikeSurrealStore(storeDir: string): boolean {
    return inspectStoreDir(storeDir).state === 'present';
}

/**
 * probeSurrealStore — open a workspace's store, count its nodes, close it and
 * settle it again.
 *
 * `basePath` is the WORKSPACE directory, not the store directory: the store's
 * real location is `surrealDataPath(basePath)`, which is what the daemon will
 * open, and the only location worth verifying.
 *
 * "Read-only" in intent only — the driver exposes no read-only mode, so this
 * takes the directory lock and may flush a replayed WAL. That is why it
 * settles on the way out: a verification pass must not leave behind the very
 * deferred flush this module exists to prevent.
 *
 * Never throws — an unreadable store is a RESULT here, because that is the
 * thing callers need to report precisely.
 */
export async function probeSurrealStore(basePath: string): Promise<SurrealStoreProbe> {
    const storeDir = surrealDataPath(basePath);
    if (!looksLikeSurrealStore(storeDir)) {
        return { readable: false, nodeCount: null, detail: `no embedded SurrealDB store at ${storeDir}` };
    }
    let connection: Awaited<ReturnType<typeof openSurreal>> | null = null;
    try {
        connection = await openSurreal(basePath);
        const rows = await connection.db.query<[{ c?: number }[]]>(
            `SELECT count() AS c FROM ${NODE_TABLE} GROUP ALL`,
        );
        const first = Array.isArray(rows) ? rows[0] : undefined;
        const count = Array.isArray(first) && first[0] && typeof first[0].c === 'number' ? first[0].c : 0;
        return { readable: true, nodeCount: count, detail: null };
    } catch (error) {
        return { readable: false, nodeCount: null, detail: (error as Error).message };
    } finally {
        if (connection) {
            await connection.db.close().catch(() => undefined);
            await settleSurrealStore(connection.dataPath).catch(() => undefined);
        }
    }
}

/**
 * probeSurrealLock — is anyone else holding this workspace's store?
 *
 * surrealkv is single-writer by directory lock, so a live daemon (or a
 * forgotten CLI handle) makes an offline backup/restore either fail or, worse,
 * succeed against a directory a second process is still writing to. This opens
 * the store the same way the daemon would and reports whether the lock was
 * available, closing and settling immediately either way.
 *
 * The open budget is squeezed down for the duration via the same env vars
 * `openSurreal` already reads: this is a preflight for a one-shot CLI, and
 * waiting the full 15 s just to learn "someone has it" helps nobody. The
 * previous values are restored in a `finally`.
 *
 * QA round 2 (2026-09-03): a store directory that exists but cannot be
 * listed (EACCES, a bad mount, …) used to be indistinguishable from one that
 * does not exist at all — both went through `looksLikeSurrealStore` and came
 * back `false`, so this returned `free: true` for a directory it never
 * actually looked inside. "Cannot tell whether anyone holds this" must never
 * report as "free" to a caller about to `rmSync` or restore over it, so that
 * case is now its own outcome: `free: false` with an `'undeterminable'`
 * detail, distinct from both a genuine lock and a genuinely absent store.
 */
export async function probeSurrealLock(
    basePath: string,
    budgetMs = 2_500,
): Promise<{ free: boolean; detail: string | null }> {
    const storeDir = surrealDataPath(basePath);
    const inspection = inspectStoreDir(storeDir);
    // Nothing there to hold — and probing would CREATE the store, which is
    // precisely the wrong thing to do to a restore destination.
    if (inspection.state === 'absent') return { free: true, detail: null };
    if (inspection.state === 'undeterminable') {
        return {
            free: false,
            detail: `undeterminable: cannot list ${storeDir} to check for a lock (${inspection.detail})`,
        };
    }

    const priorBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    const priorTimeout = process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = String(budgetMs);
    process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = String(Math.max(250, Math.floor(budgetMs / 2)));
    let connection: Awaited<ReturnType<typeof openSurreal>> | null = null;
    try {
        connection = await openSurreal(basePath);
        return { free: true, detail: null };
    } catch (error) {
        return { free: false, detail: (error as Error).message };
    } finally {
        if (connection) {
            await connection.db.close().catch(() => undefined);
            await settleSurrealStore(connection.dataPath).catch(() => undefined);
        }
        if (priorBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = priorBudget;
        if (priorTimeout === undefined) delete process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
        else process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = priorTimeout;
    }
}
