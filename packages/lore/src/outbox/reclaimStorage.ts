/**
 * reclaimStorage.ts — storage-growth fix 3/3: offline, one-time reclaim tool.
 *
 * Sprint 1 (isNoOpVersion / FIELDS_CLEARED_ON_OMISSION) stops NEW no-op
 * writes from ever being recorded. Sprint 2 (embedded prune sweeps) keeps
 * OLD rows bounded on an ongoing basis, but its reclaim step is always the
 * bounded, online-safe `incrementalVacuum()` — a no-op on any file that
 * predates Sprint 2, since `auto_vacuum = INCREMENTAL` is only ever set on
 * a brand-new file (see `VersionStore.open`'s doc comment). Neither sprint
 * ever shrinks an EXISTING large file on disk. This module is the one-time
 * offline tool that does: convert an existing file to
 * `auto_vacuum = INCREMENTAL` and run a full `VACUUM` against it, after
 * first clearing out everything Sprints 1/2 would have prevented or pruned
 * had they been running from the start.
 *
 * Offline only, by design: every step here (dedup, policy prune, outbox
 * prune, VACUUM) either mutates the whole table in one pass or blocks on a
 * full VACUUM — the exact costs Sprint 2 built the online sweepers to
 * avoid. The host that owns `dataDir` must have disposed its Lore instance
 * first.
 *
 * ── LOCK PREFLIGHT: TWO CHECKS, BOTH IDLE-AWARE NOW ─────────────────────────
 *
 * `checkNotHeld` probes each SQLite file (`versions.sqlite`, `outbox.sqlite`)
 * with an EXCLUSIVE-locking-mode probe, not a plain `BEGIN IMMEDIATE`:
 *
 *   PRAGMA locking_mode = EXCLUSIVE;
 *   PRAGMA schema_version;   -- forces a read, which is where SQLite
 *                            -- actually attempts the lock upgrade
 *   BEGIN EXCLUSIVE; ROLLBACK;
 *
 * In WAL mode every open connection — including a fully idle one with no
 * in-flight transaction — keeps a claim on the file's wal-index shared
 * memory for as long as it stays open (this is how SQLite itself detects
 * "am I the last connection" for checkpointing). Asking for EXCLUSIVE
 * locking mode and then forcing a lock-acquiring read collides with that
 * claim and fails with SQLITE_BUSY / "database is locked" if ANY other
 * connection has the file open at all, mid-write or not. A plain
 * `BEGIN IMMEDIATE` (the old probe) does not collide with it, which is
 * exactly why the old probe missed an idle holder.
 *
 * Measured directly, cross-process, before trusting this (see PR #159):
 * a real `createLore({ dataDir })` host, left fully idle (no in-flight
 * write) — the EXCLUSIVE probe above fails busy on `versions.sqlite`,
 * `outbox.sqlite`, AND the SQLite-engine graph file (`.lore/graph.sqlite`)
 * while the host is open, and succeeds on all three immediately after the
 * host disposes. A concurrent plain `BEGIN IMMEDIATE` from a third
 * connection succeeds the whole time the idle host is open, confirming the
 * old probe's blind spot and this probe's fix for it. The probe resets
 * `locking_mode` back to `NORMAL` before closing, so it does not itself
 * leave the file exclusively locked for the next opener, and it never
 * changes `journal_mode` (checked before/after: stays `wal`).
 *
 * This makes `checkNotHeld` alone sufficient to detect an idle holder on
 * EVERY data-root layout, including a bare `versions.sqlite`/`outbox.sqlite`
 * pair with no graph at all, and including a SQLite-engine graph — neither
 * of which the graph-lock preflight below can see (SQLite's WAL mode has no
 * exclusive-lock-on-open the way SurrealDB's RocksDB backend does).
 *
 * The graph-lock preflight is kept as a second, independent check: when the
 * data root has a graph (whatever `openWorkspaceGraph` would open for it —
 * checked for existence via `graphStoresOnDisk`, which only stats paths and
 * never creates one), this module also acquires `acquirePieceRebuildLock`
 * (the same single-writer lock preflight `rebuildPieceIndex`/
 * `migrate piece-vectors --data-dir` already use) and holds it for the
 * ENTIRE run, dry-run included, closing it in `finally`. On a Surreal-backed
 * graph this is redundant with the SQLite-file probe above (both now catch
 * an idle holder); on a SQLite-engine graph it adds nothing beyond the
 * SQLite-file probe. It stays because it is a different failure mode
 * (contends the graph's own open, not a file lock) and removing it was not
 * asked for.
 *
 * "Stop the host first" remains the documented procedure — this preflight
 * is a safety net, not a substitute for it.
 *
 * `--data-dir` resolution reuses `resolvePieceRebuildTarget`
 * (engines/pieces/rebuildPieceIndex.ts, 3.24.2) verbatim — same precedence,
 * same "must already exist" refusal — so a bare `.lore/versions.sqlite`
 * and/or `.lore/outbox.sqlite` with no `workspaces.json` yet (the
 * measurement copies' exact shape) resolves the same way
 * `migrate piece-vectors --data-dir` already does: `loadWorkspaces`'s
 * legacy-adoption path treats a bare `.lore/` dir as the sole/default
 * workspace, so `basePath` resolves to `dataDir` itself. Note: resolving a
 * legacy layout this way WRITES a fresh `workspaces.json` into `dataDir` as
 * a side effect (the same side effect `migrate piece-vectors --data-dir`
 * already has), and — separately — opening a pre-existing `versions.sqlite`
 * on ANY run, dry-run included, applies a one-time schema upgrade (missing
 * index/table creation) the same way the host's own next open would.
 * `--dry-run`'s "writes nothing" guarantee is scoped to the two SQLite
 * files' ROW DATA (every row present before is present, unchanged, after);
 * it is NOT a guarantee that literally zero bytes change on disk for a
 * pre-3.25 file. Back up before a first dry run on a legacy root if that
 * matters to you.
 *
 * Steps, run in this order (spec order, sprint-3.md "Fix 5"):
 *   1. Dedup exact no-op version rows (`VersionStore.dedupeIdenticalVersions`).
 *   2. OPT-IN version deletion (owner decision 2026-09-29: history is never
 *      deleted unless asked for). Skipped entirely on a default run. Runs
 *      only when the caller passes `pruneOlderThanDays` (age-based, every
 *      type; `versionHistory.retentionDaysByType` overrides per type) and/or
 *      `skipTypes` (type-based: existing rows of those types are dropped
 *      outright). It is the SAME sync `pruneVersions`/`hardDeleteCompacted`
 *      pair the store exposes — the sync path, not the batched/yielding
 *      one, is correct for an operator-invoked, run-to-completion tool.
 *      Rows already soft-compacted by an earlier prune are only hard-deleted
 *      when this step runs.
 *   3. Prune `replicated` outbox rows older than the retention window,
 *      looped to full drain (same loop shape as
 *      `mcp/outboxOpenPruneSweep.ts`), never touching `pending`/`dead`.
 *   4. Convert both files to `auto_vacuum = INCREMENTAL` and VACUUM.
 *
 * `--dry-run`: steps 1-3 run for real inside an explicit transaction
 * (`beginReclaimTx`/`rollbackReclaimTx`) so the reported row counts are the
 * exact numbers a real run would produce, then the transaction is rolled
 * back instead of committed and step 4 is skipped entirely (VACUUM cannot
 * run inside an explicit transaction, and there would be nothing to VACUUM
 * anyway once the row deletes are rolled back). Bytes-reclaimable for a dry
 * run is therefore an ESTIMATE (rows-removed × the file's own average
 * bytes/row, measured before any change) — the real run instead reports the
 * file's actual on-disk size delta.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { resolvePieceRebuildTarget, acquirePieceRebuildLock, PieceIndexDataDirInUseError } from '../engines/pieces/rebuildPieceIndex.js';
import { graphStoresOnDisk } from '../engines/openWorkspaceGraph.js';
import { VersionStore } from './versionStore.js';
import { SqliteOutboxStore } from './sqliteStore.js';
import type { VersionHistoryPolicy } from './versionPolicy.js';
import { validateVersionHistoryPolicy } from './versionPolicy.js';
import { DEFAULT_REPLICATOR_CONFIG } from './replicator.js';

/** Default-retention sentinel used when the caller asked for type-based
 *  deletion (`skipTypes`) but NOT age-based deletion: `computeCutoffs` needs
 *  a finite day count, and 100_000 days puts the default cutoff in the year
 *  1752 — older than any real row — so no unlisted-type row is ever touched
 *  by age. */
const NO_AGE_DELETION_DAYS = 100_000;

const VERSIONS_FILE = 'versions.sqlite';
const OUTBOX_FILE = 'outbox.sqlite';

/** Rows deleted per `pruneReplicated()` call in Step 3's drain loop. Same
 *  bound the replicator's own sweep uses (`outbox/replicator.ts`). */
const OUTBOX_PRUNE_BATCH_LIMIT = 5_000;

/** The data root is held by a running process (host or daemon). Thrown from
 *  either lock preflight this module runs: a `PieceIndexDataDirInUseError`
 *  from `acquirePieceRebuildLock` (graph-backed root; catches an idle
 *  Surreal-backed holder, redundant with the check below on a SQLite-engine
 *  graph) is re-thrown as this type, and `checkNotHeld`'s own SQLite
 *  EXCLUSIVE-locking-mode probe (every root, graph or not — the only check
 *  on a bare versions.sqlite/outbox.sqlite root) throws this type directly.
 *  Both checks now catch an IDLE holder, not just a mid-write one — see the
 *  module header's "LOCK PREFLIGHT" section. Mirrors
 *  `PieceIndexDataDirInUseError`'s shape so callers can pattern-match either
 *  the same way. */
export class ReclaimDataDirInUseError extends Error {
    constructor(public readonly basePath: string, cause?: Error) {
        super(
            `The Lore data at ${basePath} is in use by another process. Stop the host that owns it, then retry the storage reclaim.`,
        );
        this.name = 'ReclaimDataDirInUseError';
        if (cause) (this as { cause?: unknown }).cause = cause;
    }
}

/** Not enough free disk to safely VACUUM (Step 4 needs roughly a full copy
 *  of the file as scratch space; sprint-3.md's own bar is ~1.1x). */
export class ReclaimInsufficientDiskSpaceError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly requiredBytes: number,
        public readonly availableBytes: number,
    ) {
        super(
            `Not enough free disk to reclaim ${filePath}: need ~${requiredBytes} bytes free, ${availableBytes} available. Free up space and retry.`,
        );
        this.name = 'ReclaimInsufficientDiskSpaceError';
    }
}

/** Resolved opt-in Step 2 request: undefined on a default run. */
interface VersionDeletionPlan {
    days: number;
    policy: VersionHistoryPolicy;
}

export interface ReclaimStorageOptions {
    /** The host's `createLore({ dataDir })` root, resolved the same way as
     *  `lore migrate piece-vectors --data-dir`. Omitted → `loreHome()`. */
    dataDir?: string;
    /** Estimate + report only; writes nothing to either SQLite file. */
    dryRun?: boolean;
    /** Types whose existing version rows are dropped outright in Step 2 —
     *  shorthand for `versionHistory: { skipTypes }`. Merged with
     *  `versionHistory` if both are given. OPT-IN: with no `skipTypes` (and
     *  no `pruneOlderThanDays`) Step 2 does not run. */
    skipTypes?: string[];
    /** Per-type policy for Step 2, same shape `createLore({
     *  versionHistory })` accepts. Only `skipTypes` and (when
     *  `pruneOlderThanDays` is given) `retentionDaysByType` are read; the
     *  `pruning` switch is a host/daemon setting and is ignored here. */
    versionHistory?: VersionHistoryPolicy;
    /** OPT-IN age-based deletion: version rows older than this many days
     *  (any type not named in `retentionDaysByType`) are deleted. Omitted
     *  means NO age-based deletion, whatever the host or daemon policy is. */
    pruneOlderThanDays?: number;
    /** Step 3's `replicated`-row retention window, in ms. Defaults to the
     *  replicator's own 7-day default
     *  (`DEFAULT_REPLICATOR_CONFIG.pruneReplicatedOlderThanMs`). */
    outboxRetentionMs?: number;
    /** Batch size for Step 1's rowid-keyset scan. Defaults to
     *  `VersionStore.DEFAULT_BATCH_SIZE`. */
    batchSize?: number;
}

export interface ReclaimFileReport {
    file: typeof VERSIONS_FILE | typeof OUTBOX_FILE;
    /** False when this part of the data dir doesn't exist — skipped, not an
     *  error (sprint-3.md: "Missing parts are skipped and reported"). */
    present: boolean;
    sizeBeforeBytes: number;
    sizeAfterBytes: number;
    bytesReclaimed: number;
    /** True only for a dry run — `bytesReclaimed` above is then an estimate
     *  (rows removed × average bytes/row before any change), not a measured
     *  file-size delta. */
    estimated: boolean;
    /** Step 1 (versions.sqlite only). */
    dedupedRows?: number;
    /** Step 2 (versions.sqlite only): soft-compacted then hard-deleted. */
    softCompactedRows?: number;
    hardDeletedRows?: number;
    /** Step 3 (outbox.sqlite only). */
    prunedReplicatedRows?: number;
    autoVacuumBefore: number | null;
    autoVacuumAfter: number | null;
}

export interface ReclaimStorageResult {
    dataDir: string;
    basePath: string;
    dryRun: boolean;
    files: ReclaimFileReport[];
}

// SQLite write-lock probe. Only catches a holder mid-write; see this
// module's header ("LOCK PREFLIGHT: TWO CHECKS, NOT ONE") for why the
// caller also takes a graph lock when one exists.
// See the module header's "LOCK PREFLIGHT" section for why this is an
// EXCLUSIVE-locking-mode probe rather than a plain `BEGIN IMMEDIATE`: in WAL
// mode a plain BEGIN IMMEDIATE does not collide with a merely-idle
// connection's claim on the file, so it misses the normal steady state of a
// live host (e.g. Atlas between calls). Asking for locking_mode=EXCLUSIVE
// and forcing a lock-acquiring read does collide with it, and was verified
// cross-process to fail busy against an idle (not mid-write) real host on
// versions.sqlite, outbox.sqlite, and the SQLite-engine graph file alike.
function checkNotHeld(filePath: string, basePath: string): void {
    let probe: DatabaseType | undefined;
    try {
        probe = new Database(filePath);
        probe.pragma('busy_timeout = 250');
        probe.pragma('locking_mode = EXCLUSIVE');
        probe.pragma('schema_version'); // forces the read that triggers the lock upgrade attempt
        probe.exec('BEGIN EXCLUSIVE');
        probe.exec('ROLLBACK');
    } catch (err) {
        const msg = (err as Error).message ?? '';
        if (/SQLITE_BUSY/i.test(msg) || /database is locked/i.test(msg)) {
            throw new ReclaimDataDirInUseError(basePath, err as Error);
        }
        throw err;
    } finally {
        try {
            // Reset locking_mode back to NORMAL before close so this probe
            // does not itself leave the file exclusively locked for the
            // next opener (verified: a third connection can open normally
            // immediately after this probe returns, busy or not).
            probe?.pragma('locking_mode = NORMAL');
        } catch {
            /* ignore */
        }
        try {
            probe?.close();
        } catch {
            /* ignore */
        }
    }
}

function checkFreeDisk(filePath: string): void {
    const sizeBytes = fs.statSync(filePath).size;
    const requiredBytes = Math.ceil(sizeBytes * 1.1);
    const st = fs.statfsSync(path.dirname(filePath));
    const availableBytes = st.bavail * st.bsize;
    if (availableBytes < requiredBytes) {
        throw new ReclaimInsufficientDiskSpaceError(filePath, requiredBytes, availableBytes);
    }
}

function fileSize(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

/**
 * Run the offline reclaim against a data root. See this module's header for
 * the full step-by-step contract. Throws `ReclaimDataDirInUseError` if the
 * root is held by a running host, `ReclaimInsufficientDiskSpaceError` if a
 * real (non-dry-run) VACUUM doesn't have enough free disk.
 */
export async function reclaimStorage(opts: ReclaimStorageOptions = {}): Promise<ReclaimStorageResult> {
    const dryRun = opts.dryRun ?? false;
    const batchSize = opts.batchSize ?? VersionStore.DEFAULT_BATCH_SIZE;
    const pruneOlderThanDays = opts.pruneOlderThanDays;
    if (pruneOlderThanDays !== undefined && !(Number.isFinite(pruneOlderThanDays) && pruneOlderThanDays > 0)) {
        throw new Error(`pruneOlderThanDays must be a positive finite number of days, got ${String(pruneOlderThanDays)}`);
    }
    const outboxRetentionMs = opts.outboxRetentionMs ?? DEFAULT_REPLICATOR_CONFIG.pruneReplicatedOlderThanMs;

    // Step 2 is opt-in: it runs only for an explicit age and/or explicit
    // skip types. `retentionDaysByType` is an age rule, so it applies only
    // together with `pruneOlderThanDays`.
    const explicitSkipTypes = [...new Set([...(opts.versionHistory?.skipTypes ?? []), ...(opts.skipTypes ?? [])])];
    const versionDeletion: VersionDeletionPlan | undefined =
        pruneOlderThanDays !== undefined || explicitSkipTypes.length > 0
            ? {
                  days: pruneOlderThanDays ?? NO_AGE_DELETION_DAYS,
                  policy: {
                      skipTypes: explicitSkipTypes,
                      retentionDaysByType:
                          pruneOlderThanDays !== undefined ? opts.versionHistory?.retentionDaysByType : undefined,
                  },
              }
            : undefined;
    if (versionDeletion) validateVersionHistoryPolicy(versionDeletion.policy);

    const target = resolvePieceRebuildTarget(opts.dataDir);

    // Graph-lock preflight — see this module's header ("LOCK PREFLIGHT: TWO
    // CHECKS, NOT ONE"). Only taken when a graph actually exists on disk
    // (`graphStoresOnDisk` stats paths, never creates one); held for the
    // WHOLE run below, dry-run included, and always released in `finally`.
    let graphLock: { close(): Promise<void> } | undefined;
    if (graphStoresOnDisk(target.basePath).any) {
        try {
            graphLock = await acquirePieceRebuildLock(target);
        } catch (err) {
            if (err instanceof PieceIndexDataDirInUseError) {
                throw new ReclaimDataDirInUseError(target.basePath, err);
            }
            throw err;
        }
    }

    try {
        const loreDir = path.join(target.basePath, '.lore');
        const versionsPath = path.join(loreDir, VERSIONS_FILE);
        const outboxPath = path.join(loreDir, OUTBOX_FILE);
        const versionsPresent = fs.existsSync(versionsPath);
        const outboxPresent = fs.existsSync(outboxPath);

        // SQLite write-lock probe, BEFORE any mutation, for every present
        // file — refuse the whole run rather than partially reclaim one
        // file while the other is held. Runs unconditionally: a second,
        // independent check on a graph-backed root (the graph lock above
        // already refused an idle holder); the ONLY check on a root with no
        // graph, where it can only catch a holder that is mid-write — see
        // this module's header for why that gap means "stop the host
        // first" is mandatory for that layout, not merely advisory.
        if (versionsPresent) checkNotHeld(versionsPath, target.basePath);
        if (outboxPresent) checkNotHeld(outboxPath, target.basePath);

        const files: ReclaimFileReport[] = [];

        if (versionsPresent) {
            files.push(await reclaimVersionsFile(versionsPath, loreDir, { dryRun, batchSize, versionDeletion }));
        } else {
            files.push({
                file: VERSIONS_FILE,
                present: false,
                sizeBeforeBytes: 0,
                sizeAfterBytes: 0,
                bytesReclaimed: 0,
                estimated: false,
                autoVacuumBefore: null,
                autoVacuumAfter: null,
            });
        }

        if (outboxPresent) {
            files.push(await reclaimOutboxFile(outboxPath, loreDir, { dryRun, outboxRetentionMs }));
        } else {
            files.push({
                file: OUTBOX_FILE,
                present: false,
                sizeBeforeBytes: 0,
                sizeAfterBytes: 0,
                bytesReclaimed: 0,
                estimated: false,
                autoVacuumBefore: null,
                autoVacuumAfter: null,
            });
        }

        return { dataDir: opts.dataDir ?? target.home, basePath: target.basePath, dryRun, files };
    } finally {
        if (graphLock) await graphLock.close();
    }
}

async function reclaimVersionsFile(
    versionsPath: string,
    loreDir: string,
    opts: { dryRun: boolean; batchSize: number; versionDeletion: VersionDeletionPlan | undefined },
): Promise<ReclaimFileReport> {
    const sizeBeforeBytes = fileSize(versionsPath);
    const store = VersionStore.open(loreDir);
    try {
        store.beginReclaimTx();
        let dedupedRows = 0;
        let softCompactedRows = 0;
        let hardDeletedRows = 0;
        try {
            const dedup = store.dedupeIdenticalVersions({ batchSize: opts.batchSize });
            dedupedRows = dedup.dropped;

            if (opts.versionDeletion) {
                store.setHistoryPolicy(opts.versionDeletion.policy);
                softCompactedRows = store.pruneVersions(opts.versionDeletion.days);
                hardDeletedRows = store.hardDeleteCompacted();
            }

            if (opts.dryRun) {
                store.rollbackReclaimTx();
            } else {
                store.commitReclaimTx();
            }
        } catch (err) {
            store.rollbackReclaimTx();
            throw err;
        }

        let sizeAfterBytes = sizeBeforeBytes;
        let estimated = true;
        let autoVacuumBefore: number | null = null;
        let autoVacuumAfter: number | null = null;
        if (!opts.dryRun) {
            checkFreeDisk(versionsPath);
            const conv = store.convertToIncrementalVacuum();
            autoVacuumBefore = conv.autoVacuumBefore;
            autoVacuumAfter = conv.autoVacuumAfter;
            store.close();
            sizeAfterBytes = fileSize(versionsPath);
            estimated = false;
            return {
                file: VERSIONS_FILE,
                present: true,
                sizeBeforeBytes,
                sizeAfterBytes,
                bytesReclaimed: Math.max(0, sizeBeforeBytes - sizeAfterBytes),
                estimated,
                dedupedRows,
                softCompactedRows,
                hardDeletedRows,
                autoVacuumBefore,
                autoVacuumAfter,
            };
        }

        // Dry run: no VACUUM, no size change. Estimate reclaimable bytes
        // from the average bytes/row measured before any change (the
        // transaction above was rolled back, so the file itself never
        // moved — sizeBeforeBytes === sizeAfterBytes, proved by the
        // dry-run byte-identical test).
        const totalRows = store.countAllVersions();
        const rowsRemoved = dedupedRows + hardDeletedRows;
        const avgBytesPerRow = totalRows > 0 ? sizeBeforeBytes / totalRows : 0;
        const estimatedBytes = Math.round(avgBytesPerRow * rowsRemoved);
        return {
            file: VERSIONS_FILE,
            present: true,
            sizeBeforeBytes,
            sizeAfterBytes,
            bytesReclaimed: estimatedBytes,
            estimated: true,
            dedupedRows,
            softCompactedRows,
            hardDeletedRows,
            autoVacuumBefore,
            autoVacuumAfter,
        };
    } finally {
        // Idempotent close — the non-dry-run success path above already
        // closed before re-measuring file size (VACUUM's WAL checkpoint
        // needs to have landed before stat()); every other path (dry run,
        // thrown error) still needs this.
        store.close();
    }
}

async function reclaimOutboxFile(
    outboxPath: string,
    loreDir: string,
    opts: { dryRun: boolean; outboxRetentionMs: number },
): Promise<ReclaimFileReport> {
    const sizeBeforeBytes = fileSize(outboxPath);
    const store = new SqliteOutboxStore(loreDir);
    try {
        store.beginReclaimTx();
        let prunedReplicatedRows = 0;
        try {
            for (;;) {
                const n = await store.pruneReplicated(opts.outboxRetentionMs, { workspace: null, limit: OUTBOX_PRUNE_BATCH_LIMIT });
                prunedReplicatedRows += n;
                if (n < OUTBOX_PRUNE_BATCH_LIMIT) break;
            }
            if (opts.dryRun) {
                store.rollbackReclaimTx();
            } else {
                store.commitReclaimTx();
            }
        } catch (err) {
            store.rollbackReclaimTx();
            throw err;
        }

        if (!opts.dryRun) {
            checkFreeDisk(outboxPath);
            const conv = store.convertToIncrementalVacuum();
            store.close();
            const sizeAfterBytes = fileSize(outboxPath);
            return {
                file: OUTBOX_FILE,
                present: true,
                sizeBeforeBytes,
                sizeAfterBytes,
                bytesReclaimed: Math.max(0, sizeBeforeBytes - sizeAfterBytes),
                estimated: false,
                prunedReplicatedRows,
                autoVacuumBefore: conv.autoVacuumBefore,
                autoVacuumAfter: conv.autoVacuumAfter,
            };
        }

        const totalRows = store.countAllEntries();
        const avgBytesPerRow = totalRows > 0 ? sizeBeforeBytes / totalRows : 0;
        const estimatedBytes = Math.round(avgBytesPerRow * prunedReplicatedRows);
        return {
            file: OUTBOX_FILE,
            present: true,
            sizeBeforeBytes,
            sizeAfterBytes: sizeBeforeBytes,
            bytesReclaimed: estimatedBytes,
            estimated: true,
            prunedReplicatedRows,
            autoVacuumBefore: null,
            autoVacuumAfter: null,
        };
    } finally {
        store.close();
    }
}
