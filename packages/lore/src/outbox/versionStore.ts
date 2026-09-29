/**
 * versionStore.ts — Immutable version history + changeset store (Feature 8, 2026-05-26).
 *
 * Tables (in <loreDir>/versions.sqlite):
 *   node_versions    — one immutable row per write on any node
 *   changesets       — atomic transaction headers (open/committed/rolled_back)
 *   changeset_writes — buffered upsert/delete ops for open changesets
 *
 * Retention policy (pruneVersions):
 *   Rows older than the configured retention window are soft-deleted
 *   (compacted=1). Protected-node rows — any row whose previous_state
 *   or new_state JSON contains the string '"status":"protected"' — are
 *   retained indefinitely regardless of age.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import type { VersionHistoryPolicy } from './versionPolicy.js';
import { resolveEffectiveVersionHistoryPolicy, type EffectiveVersionHistoryPolicy } from './versionPruningPolicy.js';
import * as reclaimOps from './reclaimOps.js';

const SQLITE_FILE = 'versions.sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS node_versions (
  version_id     TEXT PRIMARY KEY,
  node_id        TEXT NOT NULL,
  workspace      TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  principal      TEXT NOT NULL DEFAULT 'mcp',
  operation      TEXT NOT NULL,
  previous_state TEXT,
  new_state      TEXT,
  changeset_id   TEXT,
  compacted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nv_node_ws ON node_versions(node_id, workspace, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nv_ws_ts   ON node_versions(workspace, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nv_cset    ON node_versions(changeset_id)
  WHERE changeset_id IS NOT NULL;
-- Storage-growth fix 2/3 follow-up (2026-09-28): a partial index covering
-- ONLY not-yet-compacted rows. Without it, the batched prune's rowid-LIMIT
-- subquery (pruneVersionsBatched/hardDeleteCompactedBatched below) degrades
-- to O(rows_scanned_so_far) PER BATCH: each call re-scans the table from
-- the start to skip past however many rows earlier batches already marked
-- compacted, so total cost across all batches is quadratic in row count --
-- measured on a synthetic 220k-row store, batch time grew from 33ms to
-- 219ms as the sweep progressed. A partial index on compacted = 0 lets
-- SQLite seek directly to the remaining candidates and drops OUT of the
-- index automatically as rows flip to compacted=1, so batch cost stays
-- flat (~20ms/batch, same measurement) regardless of how much of the sweep
-- has already run. IF NOT EXISTS means an existing versions.sqlite (any
-- file that predates this change) gets it built once, synchronously, the
-- next time VersionStore.open() runs -- see that method's doc comment.
CREATE INDEX IF NOT EXISTS idx_nv_pending ON node_versions(compacted) WHERE compacted = 0;

CREATE TABLE IF NOT EXISTS changesets (
  id           TEXT PRIMARY KEY,
  workspace    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('open','committed','rolled_back')),
  created_at   TEXT NOT NULL,
  committed_at TEXT,
  write_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cset_ws ON changesets(workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS changeset_writes (
  id           TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  seq          INTEGER NOT NULL,
  operation    TEXT NOT NULL,
  payload      TEXT NOT NULL,
  UNIQUE(changeset_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cw_cset ON changeset_writes(changeset_id, seq);
`;

/* ─── Public types ─────────────────────────────────────────────── */

export interface VersionRecord {
    versionId: string;
    nodeId: string;
    workspace: string;
    timestamp: string;
    principal: string;
    operation: string;
    previousState: unknown | null;
    newState: unknown | null;
    changesetId: string | null;
    compacted: boolean;
}

export interface Changeset {
    id: string;
    workspace: string;
    status: 'open' | 'committed' | 'rolled_back';
    createdAt: string;
    committedAt: string | null;
    writeCount: number;
}

export interface ChangesetWrite {
    id: string;
    changesetId: string;
    seq: number;
    operation: string;
    payload: unknown;
}

/* ─── VersionStore ─────────────────────────────────────────────── */

export class VersionStore {
    private db: DatabaseType;
    /** Storage-growth fix 2/3 (R2) — in-memory only, set by the host at
     *  `createLore({ versionHistory })` time. `retentionDaysByType` is
     *  store/validate-only here; Sprint 2's pruning sweep is the reader. */
    private historyPolicy: VersionHistoryPolicy | undefined;

    private constructor(db: DatabaseType) {
        this.db = db;
    }

    /** Set the per-type history policy for this store instance (in-memory,
     *  not persisted — re-supplied by the host on every `createLore()`). */
    setHistoryPolicy(policy: VersionHistoryPolicy | undefined): void {
        this.historyPolicy = policy;
    }

    /** Read back the policy set via `setHistoryPolicy` (Sprint 2's pruner
     *  reads `retentionDaysByType` from here). */
    getHistoryPolicy(): VersionHistoryPolicy | undefined {
        return this.historyPolicy;
    }

    private effectivePolicy: EffectiveVersionHistoryPolicy | undefined;
    /** Host-set at boot; read-only to everything else (no MCP/REST setter). */
    setEffectiveHistoryPolicy(policy: EffectiveVersionHistoryPolicy): void { this.effectivePolicy = policy; }
    /** Effective pruning policy (versionPruningPolicy.ts); resolves from env if unset. */
    getEffectiveHistoryPolicy(): EffectiveVersionHistoryPolicy {
        return this.effectivePolicy ?? resolveEffectiveVersionHistoryPolicy(this.historyPolicy);
    }

    /**
     * Open (or create) versions.sqlite at <loreDir>/versions.sqlite.
     * Idempotent: schema is CREATE IF NOT EXISTS throughout.
     *
     * Storage-growth fix 2/3 (R3) — on a brand-new file (checked BEFORE the
     * `Database` handle is opened, since `new Database()` itself creates an
     * empty file), `auto_vacuum = INCREMENTAL` is set before the schema is
     * created AND before `journal_mode` is switched to WAL — empirically,
     * setting `journal_mode = WAL` first causes the `auto_vacuum` pragma to
     * silently no-op (mode stays 0/NONE) even on that same brand-new,
     * schema-less file; the ordering here is load-bearing, not cosmetic.
     * `auto_vacuum` only takes effect on an empty database or right after a
     * full `VACUUM` — an existing file stays NONE until Sprint 3's offline
     * conversion tool runs a one-time full VACUUM on it. This is why
     * `incrementalVacuum()` below is a no-op on any file that predates this
     * change.
     *
     * Also note (storage-growth fix 2/3 follow-up, 2026-09-28): the schema
     * now includes `idx_nv_pending`, a partial index on `compacted = 0`
     * (see SCHEMA_SQL's own comment for why the batched pruner needs it).
     * `db.exec(SCHEMA_SQL)` below runs synchronously, so the FIRST open of
     * an existing large versions.sqlite after upgrading to this version
     * pays a one-time synchronous cost to build that index (a single pass
     * over the table — cheap relative to the O(N²) degradation it prevents
     * on every SUBSEQUENT sweep, but still a real synchronous cost on that
     * one open, not spread across `setImmediate` yields). Not batched or
     * deferred: `CREATE INDEX` is one atomic SQLite operation with no
     * batched equivalent, and deferring it would mean the first embedded
     * sweep after upgrade hits the O(N²) path anyway. Measured in this
     * sprint's real-size run (see the PR description) on Atlas's real
     * 323k-row/1.36GB store.
     */
    static open(loreDir: string): VersionStore {
        const filePath = path.join(loreDir, SQLITE_FILE);
        const isNewFile = !fs.existsSync(filePath);
        const db = new Database(filePath);
        // Must be set BEFORE `journal_mode = WAL` — empirically, switching to
        // WAL first causes a subsequent `auto_vacuum = INCREMENTAL` to
        // silently no-op (mode stays 0/NONE) even on a brand-new, schema-less
        // file. Setting it first, then switching to WAL, persists correctly.
        if (isNewFile) {
            db.pragma('auto_vacuum = INCREMENTAL');
        }
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.exec(SCHEMA_SQL);
        return new VersionStore(db);
    }

    close(): void {
        try { this.db.close(); } catch { /* ignore */ }
    }

    /* ─── node_versions ──────────────────────────────────────────── */

    recordVersion(r: Omit<VersionRecord, 'compacted'>): void {
        this.db
            .prepare(
                `INSERT INTO node_versions
                   (version_id, node_id, workspace, timestamp, principal,
                    operation, previous_state, new_state, changeset_id, compacted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            )
            .run(
                r.versionId,
                r.nodeId,
                r.workspace,
                r.timestamp,
                r.principal,
                r.operation,
                r.previousState != null ? JSON.stringify(r.previousState) : null,
                r.newState != null ? JSON.stringify(r.newState) : null,
                r.changesetId ?? null,
            );
    }

    /** Newest-first version log for a single node. Excludes compacted rows. */
    getVersions(nodeId: string, workspace: string, limit = 50): VersionRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM node_versions
                 WHERE node_id = ? AND workspace = ? AND compacted = 0
                 ORDER BY timestamp DESC LIMIT ?`,
            )
            .all(nodeId, workspace, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToVersion);
    }

    /** All non-compacted changes in a workspace at or after `since` (ISO 8601). */
    getDiff(workspace: string, since: string): VersionRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM node_versions
                 WHERE workspace = ? AND timestamp >= ? AND compacted = 0
                 ORDER BY timestamp DESC`,
            )
            .all(workspace, since) as Array<Record<string, unknown>>;
        return rows.map(rowToVersion);
    }

    /** All version records created as part of a specific changeset (oldest-first). */
    getVersionsByChangeset(changesetId: string): VersionRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM node_versions
                 WHERE changeset_id = ? ORDER BY timestamp ASC`,
            )
            .all(changesetId) as Array<Record<string, unknown>>;
        return rows.map(rowToVersion);
    }

    /**
     * Soft-compact version rows older than `olderThanDays`.
     * Protected-node rows (state JSON contains '"status":"protected"') are
     * skipped regardless of age.
     * Returns the number of rows compacted.
     *
     * Storage-growth fix 2/3 (R3) — policy-aware: when `setHistoryPolicy()`
     * has supplied a policy with `retentionDaysByType` and/or `skipTypes`,
     * those override `olderThanDays` per node type (see
     * `pruneVersionsWithPolicy` below). This makes both the daemon's
     * scheduled sweep (`mcp/versionPruneScheduler.ts`, which already calls
     * `store.pruneVersions(days)` unchanged) and the new embedded-host sweep
     * enforce the same per-type retention, since both paths already call
     * `setHistoryPolicy()` on their `VersionStore` instance in `server.ts`.
     * With no policy set, behaviour is byte-for-byte the pre-Sprint-2 query.
     */
    pruneVersions(olderThanDays: number): number {
        return this.pruneVersionsWithPolicy(olderThanDays, this.historyPolicy);
    }

    /**
     * Per-type retention. `skipTypes` types are pruned with
     * `olderThanDays=0` (existing rows are immediately prunable, matching
     * sprint-2.md's "skipTypes type's existing rows are prunable
     * immediately"). `retentionDaysByType[type]` wins over a same-type entry
     * in `skipTypes` if a type appears in both. Every other type — including
     * rows whose type cannot be determined — uses `defaultDays`.
     *
     * `node_versions` has no dedicated type column; the type is recovered
     * from whichever state JSON is present, preferring `new_state` (a
     * `delete` changeset write sets `new_state` to NULL, so it falls back to
     * `previous_state`).
     *
     * Cutoff comparison is `<=`, not `<` (fixed 2026-09-28, storage-growth
     * fix 2/3 follow-up — root cause of test/version-prune-embedded-unit.ts's
     * U3 flake). `days=0` (the `skipTypes` "prunable immediately" case) sets
     * cutoff = `now` at query time; a row seeded moments earlier in the same
     * test can land in the SAME millisecond as that cutoff (ISO timestamps
     * are millisecond-granular, and two back-to-back `Date.now()` calls
     * collide far more often than intuition suggests — measured ~99.97% of
     * 100k back-to-back pairs on this machine landing in the same or an
     * earlier ms). With strict `<`, a tied row is NOT "older than" its own
     * cutoff and survives, intermittently. `<=` makes "prunable immediately"
     * actually immediate, and is harmless for the day-granularity case
     * (`days>0`): a tie there would require a row timestamp to land exactly
     * on a day boundary many days out, which never happens from wall-clock
     * seeding.
     */
    private pruneVersionsWithPolicy(defaultDays: number, policy: VersionHistoryPolicy | undefined): number {
        const typeExpr = `COALESCE(json_extract(new_state, '$.type'), json_extract(previous_state, '$.type'))`;
        const protectedGuard = `AND (previous_state IS NULL OR previous_state NOT LIKE '%"status":"protected"%')
                   AND (new_state IS NULL OR new_state NOT LIKE '%"status":"protected"%')`;

        const { perType, defaultCutoff } = this.computeCutoffs(defaultDays, policy);

        let total = 0;

        for (const [type, cutoff] of perType) {
            const result = this.db
                .prepare(
                    `UPDATE node_versions
                     SET compacted = 1
                     WHERE timestamp <= ?
                       AND compacted = 0
                       AND ${typeExpr} = ?
                       ${protectedGuard}`,
                )
                .run(cutoff, type);
            total += (result as unknown as { changes: number }).changes;
        }

        const namedTypes = [...perType.keys()];
        if (namedTypes.length === 0) {
            const result = this.db
                .prepare(
                    `UPDATE node_versions
                     SET compacted = 1
                     WHERE timestamp <= ?
                       AND compacted = 0
                       ${protectedGuard}`,
                )
                .run(defaultCutoff);
            total += (result as unknown as { changes: number }).changes;
        } else {
            const placeholders = namedTypes.map(() => '?').join(', ');
            const result = this.db
                .prepare(
                    `UPDATE node_versions
                     SET compacted = 1
                     WHERE timestamp <= ?
                       AND compacted = 0
                       AND (${typeExpr} IS NULL OR ${typeExpr} NOT IN (${placeholders}))
                       ${protectedGuard}`,
                )
                .run(defaultCutoff, ...namedTypes);
            total += (result as unknown as { changes: number }).changes;
        }

        return total;
    }

    /**
     * Shared cutoff computation for both the sync multi-pass pruner above
     * and the batched single-pass pruner below — kept in one place so the
     * two can never drift on WHICH cutoff a given type gets (only how many
     * SQL statements it takes to apply them). All cutoffs are computed from
     * ONE `Date.now()` read so every type's cutoff in a given pass is
     * mutually consistent, rather than drifting slightly across a long
     * batched run.
     */
    private computeCutoffs(
        defaultDays: number,
        policy: VersionHistoryPolicy | undefined,
    ): { perType: Map<string, string>; defaultCutoff: string } {
        const now = Date.now();
        const cutoffFor = (days: number): string => new Date(now - days * 86_400_000).toISOString();

        const perTypeDays = new Map<string, number>();
        for (const t of policy?.skipTypes ?? []) perTypeDays.set(t, 0);
        for (const [t, days] of Object.entries(policy?.retentionDaysByType ?? {})) perTypeDays.set(t, days);

        const perType = new Map<string, string>();
        for (const [type, days] of perTypeDays) perType.set(type, cutoffFor(days));

        return { perType, defaultCutoff: cutoffFor(defaultDays) };
    }

    /** Batch size used by the yielding, bounded prune/hard-delete passes
     *  below — see their doc comments for why ~2-5k rows/batch. */
    static readonly DEFAULT_BATCH_SIZE = 3000;

    /**
     * Storage-growth fix 2/3 follow-up (2026-09-28) — the async, bounded,
     * single-pass counterpart to `pruneVersions()`, for the embedded sweep
     * ONLY. `pruneVersionsWithPolicy` above does one full-table `UPDATE` per
     * named type (`skipTypes` + `retentionDaysByType`) plus one default
     * pass — measured on a real 1.36GB/323k-row store copy, ~3.2s per
     * per-type pass, ~15-20s total with 5 `skipTypes` + the default pass,
     * ALL synchronous (better-sqlite3 is a blocking native call), so the
     * whole thing runs as one uninterrupted slice of the event loop.
     * `resolveVersionPruneSweeper` runs this with `runImmediately: true`
     * right after `createLore()` opens — an embedded host (Atlas, MIRA, PM
     * Helper) would freeze for that entire span on every large store until
     * a reclaim had run.
     *
     * Two changes fix that:
     *   1. Row classification is ONE pass, not N: a single `UPDATE` whose
     *      WHERE clause picks each row's own cutoff via a `CASE` over the
     *      recovered type (see `computeCutoffs`/`typeExpr`), instead of one
     *      `UPDATE` per named type. A row has exactly one type, so it can
     *      only ever match one `WHEN` branch (or fall to `ELSE` = the
     *      default cutoff) — this is not an approximation of the old
     *      multi-pass result, it's the same classification restated as one
     *      statement (see test coverage: the batched pass and the old
     *      sync multi-pass pass are asserted to produce byte-identical
     *      compacted-row sets on the same seed data).
     *   2. The single statement itself runs in bounded batches (rowid-LIMIT
     *      subquery, `DEFAULT_BATCH_SIZE` rows/call — 3000, chosen so a
     *      batch (~2KB `new_state` JSON/row in this sprint's synthetic
     *      stall test, close to Atlas's real measured ~4.4KB/row average)
     *      keeps one batch's wall-clock UPDATE well under the target
     *      single-slice budget on real hardware — measured on a synthetic
     *      220k-row store to stay under a 250ms max-observed-stall
     *      threshold, see test/version-prune-embedded-stall-unit.ts),
     *      yielding to the event loop (`setImmediate`) between batches so
     *      no single synchronous slice blocks anything else queued on the
     *      loop for more than one batch's worth of work.
     *
     * `pruneVersions()`/`hardDeleteCompacted()` (sync) are UNCHANGED and
     * still used by the daemon sweeper (`runVersionPruneSweep`) and `lore
     * maintain` — both are operator-invoked or daemon-owned maintenance
     * paths where a multi-second blocking pass was already the accepted
     * cost before this fix, and daemon `lore maintain` in particular wants
     * the ENTIRE sweep to complete synchronously within one tool call, not
     * partially applied across `setImmediate` turns. Only the embedded
     * sweep (`runEmbeddedVersionPruneSweep`), which runs unattended inside
     * a host process that must stay responsive, is switched to this path.
     */
    async pruneVersionsBatched(defaultDays: number, opts?: { batchSize?: number; signal?: { aborted: boolean } }): Promise<number> {
        return this.pruneVersionsWithPolicyBatched(defaultDays, this.historyPolicy, opts);
    }

    private async pruneVersionsWithPolicyBatched(
        defaultDays: number,
        policy: VersionHistoryPolicy | undefined,
        opts?: { batchSize?: number; signal?: { aborted: boolean } },
    ): Promise<number> {
        const typeExpr = `COALESCE(json_extract(new_state, '$.type'), json_extract(previous_state, '$.type'))`;
        const protectedGuard = `AND (previous_state IS NULL OR previous_state NOT LIKE '%"status":"protected"%')
                   AND (new_state IS NULL OR new_state NOT LIKE '%"status":"protected"%')`;
        const batchSize = opts?.batchSize ?? VersionStore.DEFAULT_BATCH_SIZE;

        const { perType, defaultCutoff } = this.computeCutoffs(defaultDays, policy);

        // One CASE expression classifies every row's cutoff in a single
        // pass. `CASE <expr> WHEN v THEN r ... ELSE r END` treats a NULL
        // <expr> (type unrecoverable from either state JSON) as matching no
        // WHEN branch, falling through to ELSE — the same "unrecognized or
        // unrecoverable type gets the default" rule the old NOT IN(...)/IS
        // NULL branch enforced explicitly.
        let cutoffExpr: string;
        const cutoffParams: unknown[] = [];
        if (perType.size > 0) {
            const whens = [...perType.entries()]
                .map(([type, cutoff]) => {
                    cutoffParams.push(type, cutoff);
                    return 'WHEN ? THEN ?';
                })
                .join(' ');
            cutoffExpr = `CASE ${typeExpr} ${whens} ELSE ? END`;
            cutoffParams.push(defaultCutoff);
        } else {
            cutoffExpr = '?';
            cutoffParams.push(defaultCutoff);
        }

        const stmt = this.db.prepare(
            `UPDATE node_versions
             SET compacted = 1
             WHERE rowid IN (
                 SELECT rowid FROM node_versions
                 WHERE compacted = 0
                   AND timestamp <= ${cutoffExpr}
                   ${protectedGuard}
                 LIMIT ?
             )`,
        );

        let total = 0;
        for (;;) {
            if (opts?.signal?.aborted) break;
            const result = stmt.run(...cutoffParams, batchSize);
            const changes = (result as unknown as { changes: number }).changes;
            total += changes;
            if (changes < batchSize) break; // drained — last batch was partial
            await new Promise((resolve) => setImmediate(resolve));
        }
        return total;
    }

    /**
     * Async, bounded counterpart to `hardDeleteCompacted()` — same rowid-
     * batched, yielding shape as `pruneVersionsBatched` above, for the same
     * reason: a single unbounded `DELETE FROM node_versions WHERE
     * compacted=1` is one synchronous native call whose duration scales
     * with the number of already-compacted rows (measured: ~1.3s alone on
     * the real 323k-row/1.36GB store after a full compact pass). Embedded-
     * sweep-only; `hardDeleteCompacted()` is unchanged for the daemon
     * sweeper and `lore maintain`.
     */
    async hardDeleteCompactedBatched(opts?: { batchSize?: number; signal?: { aborted: boolean } }): Promise<number> {
        const batchSize = opts?.batchSize ?? VersionStore.DEFAULT_BATCH_SIZE;
        const stmt = this.db.prepare(
            `DELETE FROM node_versions WHERE rowid IN (
                 SELECT rowid FROM node_versions WHERE compacted = 1 LIMIT ?
             )`,
        );
        let total = 0;
        for (;;) {
            if (opts?.signal?.aborted) break;
            const result = stmt.run(batchSize);
            const changes = (result as unknown as { changes: number }).changes;
            total += changes;
            if (changes < batchSize) break;
            await new Promise((resolve) => setImmediate(resolve));
        }
        return total;
    }

    /**
     * Fix Requirement 4 (Defect 3, 3.20.2) — read-only counterpart to
     * `pruneVersions()`/`hardDeleteCompacted()`, mirroring their exact WHERE
     * clauses without writing anything. Lets a caller (embedded `maintain`'s
     * dry-run) preview a versions.sqlite prune the same way every other
     * maintain op already supports a preview.
     */
    countPrunable(olderThanDays: number): { eligibleForCompact: number; alreadyCompacted: number } {
        const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
        const compactRow = this.db
            .prepare(
                `SELECT COUNT(*) as n FROM node_versions
                 WHERE timestamp < ?
                   AND compacted = 0
                   AND (previous_state IS NULL
                        OR previous_state NOT LIKE '%"status":"protected"%')
                   AND (new_state IS NULL
                        OR new_state NOT LIKE '%"status":"protected"%')`,
            )
            .get(cutoff) as { n: number };
        const compactedRow = this.db.prepare(`SELECT COUNT(*) as n FROM node_versions WHERE compacted = 1`).get() as { n: number };
        return { eligibleForCompact: compactRow.n, alreadyCompacted: compactedRow.n };
    }

    /** Storage-growth fix 3/3 — total row count, used only for the offline
     *  reclaim tool's dry-run bytes-reclaimable estimate (average
     *  bytes/row × rows removed). Every other counting need in this class
     *  (`countPrunable`) is scoped to a WHERE clause; this one deliberately
     *  isn't. */
    countAllVersions(): number {
        const row = this.db.prepare(`SELECT COUNT(*) as n FROM node_versions`).get() as { n: number };
        return row.n;
    }

    /**
     * Hard-delete rows already marked `compacted=1`. Every read path
     * (getVersionHistory, getChangesSince) already excludes compacted rows —
     * nothing in this codebase ever reads one — so retaining them serves no
     * purpose and is why `versions.sqlite` grew unbounded even where
     * `pruneVersions` ran: soft-delete alone frees no disk space.
     * Returns the number of rows removed.
     */
    hardDeleteCompacted(): number {
        const result = this.db.prepare(`DELETE FROM node_versions WHERE compacted = 1`).run();
        return (result as unknown as { changes: number }).changes;
    }

    /**
     * Reclaim the freed pages on disk. SQLite DELETE leaves freed pages in
     * the file's internal freelist for reuse — the file itself does not
     * shrink without this. Exclusive on the connection while it runs;
     * callers should treat this as a maintenance operation, not something
     * to run on every write.
     *
     * The store opens in WAL mode (`journal_mode = WAL`), so VACUUM's own
     * rewrite lands in `versions.sqlite-wal`, not the main file — measured:
     * the main file's on-disk size does not change until that WAL is
     * checkpointed back in. Without the explicit checkpoint below, the
     * space would only be reclaimed on the NEXT `close()`, which a
     * long-running daemon may not do for days. `TRUNCATE` (not the default
     * `PASSIVE`) forces the checkpoint immediately and shrinks the -wal
     * file itself back to empty.
     */
    vacuum(): void {
        this.db.exec('VACUUM');
        this.db.pragma('wal_checkpoint(TRUNCATE)');
    }

    /**
     * Storage-growth fix 2/3 (R3) — the online-safe counterpart to
     * `vacuum()`, meant for a host's automatic sweep, never a blocking full
     * `VACUUM`. A full VACUUM rewrites the entire file in one transaction
     * (stalls the whole event loop for seconds on a >1 GB file, needs ~2×
     * disk); `PRAGMA incremental_vacuum(N)` instead reclaims up to N free
     * pages per call and is safe to run repeatedly from a short-lived timer.
     *
     * It only does anything when the file is already in `auto_vacuum =
     * INCREMENTAL` mode (set on creation by `open()` above, or by Sprint 3's
     * offline conversion tool after a one-time full VACUUM) — on a NONE-mode
     * file `incremental_vacuum` is a silent no-op, so this checks the mode
     * first and reports that back rather than assume it did something.
     *
     * WAL checkpoint: unlike `vacuum()`, this uses `PASSIVE`, not
     * `TRUNCATE`. `TRUNCATE` blocks until it can acquire an exclusive lock
     * over any other connection still reading the WAL, which is exactly the
     * kind of stall this method exists to avoid; `PASSIVE` checkpoints
     * whatever it can without blocking or forcing anything out, and no-ops
     * if it can't. The tradeoff: a `PASSIVE` checkpoint may leave the
     * reclaimed pages sitting in `-wal` rather than reflected in the main
     * file's size immediately — they land on a later checkpoint (SQLite's
     * automatic one at ~1000 WAL pages, or the next `close()`/`vacuum()`).
     * For a periodic background sweep that beats unbounded growth, that
     * latency is an acceptable trade for never blocking a write.
     */
    incrementalVacuum(maxPages = 1000): { ran: boolean; autoVacuumMode: number } {
        const mode = this.db.pragma('auto_vacuum', { simple: true }) as number;
        if (mode !== 2 /* INCREMENTAL */) {
            return { ran: false, autoVacuumMode: mode };
        }
        this.db.pragma(`incremental_vacuum(${maxPages})`);
        this.db.pragma('wal_checkpoint(PASSIVE)');
        return { ran: true, autoVacuumMode: mode };
    }

    /** Absolute path to this store's underlying file — the reclaim tool
     *  (storage-growth fix 3/3) needs it for size/free-disk checks; nothing
     *  else in this class needed it before, since every existing caller
     *  goes through the loreDir passed to `open()`. */
    get filePath(): string {
        return String(this.db.name);
    }

    /** Storage-growth fix 3/3 — begin/end a manual transaction around the
     *  reclaim tool's own steps, so its `--dry-run` mode can run the exact
     *  same mutating calls (`dedupeIdenticalVersions`, `pruneVersions`,
     *  `hardDeleteCompacted`) and roll them back instead of maintaining a
     *  separate read-only estimation path that could drift from the real
     *  one. `db` is private to this class, so these three thin wrappers are
     *  the only way an outside caller can drive that transaction. Mechanics
     *  live in `reclaimOps.ts` (shared with `SqliteOutboxStore`, which was
     *  a literal duplicate — extracted to stay under the file-size cap). */
    beginReclaimTx(): void {
        reclaimOps.beginReclaimTx(this.db);
    }

    commitReclaimTx(): void {
        reclaimOps.commitReclaimTx(this.db);
    }

    rollbackReclaimTx(): void {
        reclaimOps.rollbackReclaimTx(this.db);
    }

    /** Storage-growth fix 3/3, Step 1 — drop `node_versions` rows that are a
     *  true no-op against the very state they themselves recorded writing
     *  from (Sprint 1's `isNoOpVersion`, reused not copied). Full design
     *  rationale (per-row not per-adjacent-pair, first-row-always-kept,
     *  protected-node exemption, why no `previous_state` chain rewrite is
     *  needed, batching) is in `reclaimOps.ts`'s `dedupeIdenticalVersionRows`
     *  doc comment — moved there to stay under the file-size cap. */
    dedupeIdenticalVersions(opts?: { batchSize?: number }): { scanned: number; dropped: number } {
        const batchSize = opts?.batchSize ?? VersionStore.DEFAULT_BATCH_SIZE;
        return reclaimOps.dedupeIdenticalVersionRows(this.db, batchSize);
    }

    /** Storage-growth fix 3/3, Step 4 — one-time offline conversion to
     *  `auto_vacuum = INCREMENTAL` plus a full `VACUUM`. Full rationale
     *  (WAL-checkpoint-first / pragma-then-VACUUM ordering, must run outside
     *  any explicit transaction) is in `reclaimOps.ts`'s
     *  `convertToIncrementalVacuumOp` doc comment. */
    convertToIncrementalVacuum(): { autoVacuumBefore: number; autoVacuumAfter: number } {
        return reclaimOps.convertToIncrementalVacuumOp(this.db);
    }

    /* ─── changesets ─────────────────────────────────────────────── */

    createChangeset(workspace: string): string {
        // RA2-reaudit2 — crypto-random id. The old timestamp + 6 chars of
        // Math.random() was guessable, letting a caller target/forge another
        // open changeset's id.
        const id = `cs-${randomUUID()}`;
        this.db
            .prepare(
                `INSERT INTO changesets (id, workspace, status, created_at, write_count)
                 VALUES (?, ?, 'open', ?, 0)`,
            )
            .run(id, workspace, new Date().toISOString());
        return id;
    }

    getChangeset(id: string): Changeset | null {
        const row = this.db
            .prepare(`SELECT * FROM changesets WHERE id = ?`)
            .get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return rowToChangeset(row);
    }

    updateChangeset(id: string, status: 'committed' | 'rolled_back'): void {
        this.db
            .prepare(`UPDATE changesets SET status = ?, committed_at = ? WHERE id = ?`)
            .run(status, new Date().toISOString(), id);
    }

    incrementWriteCount(changesetId: string): void {
        this.db
            .prepare(`UPDATE changesets SET write_count = write_count + 1 WHERE id = ?`)
            .run(changesetId);
    }

    /* ─── changeset_writes ───────────────────────────────────────── */

    /**
     * Append a buffered write to an open changeset and return the seq it was
     * assigned.
     *
     * SW-06 (B8): seq is allocated atomically inside a single transaction that
     * also bumps the changeset's write_count. Pre-SW-06 the caller read
     * changeset.write_count and passed it as `seq`; two concurrent store_node
     * calls buffering into the SAME changeset both read the same write_count,
     * both inserted with the same seq → `UNIQUE(changeset_id, seq)` violation
     * (one write lost), and the two write_count bumps could interleave and
     * under-count. Deriving seq from `MAX(seq)+1` of the committed rows under
     * the same transaction that bumps write_count closes both windows.
     */
    addChangesetWrite(changesetId: string, operation: string, payload: unknown): number {
        const txn = this.db.transaction((csId: string, op: string, body: string): number => {
            const r = this.db
                .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM changeset_writes WHERE changeset_id = ?`)
                .get(csId) as { next: number };
            const seq = r.next;
            this.db
                .prepare(
                    `INSERT INTO changeset_writes (id, changeset_id, seq, operation, payload)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(randomUUID(), csId, seq, op, body);
            this.db
                .prepare(`UPDATE changesets SET write_count = write_count + 1 WHERE id = ?`)
                .run(csId);
            return seq;
        });
        return txn(changesetId, operation, JSON.stringify(payload));
    }

    getChangesetWrites(changesetId: string): ChangesetWrite[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM changeset_writes
                 WHERE changeset_id = ? ORDER BY seq ASC`,
            )
            .all(changesetId) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            id: String(r['id'] ?? ''),
            changesetId: String(r['changeset_id'] ?? ''),
            seq: Number(r['seq'] ?? 0),
            operation: String(r['operation'] ?? ''),
            payload: r['payload'] ? JSON.parse(String(r['payload'])) : null,
        }));
    }
}

/* ─── Row mappers ────────────────────────────────────────────────── */

function rowToVersion(r: Record<string, unknown>): VersionRecord {
    return {
        versionId: String(r['version_id'] ?? ''),
        nodeId: String(r['node_id'] ?? ''),
        workspace: String(r['workspace'] ?? ''),
        timestamp: String(r['timestamp'] ?? ''),
        principal: String(r['principal'] ?? 'mcp'),
        operation: String(r['operation'] ?? ''),
        previousState: r['previous_state'] != null
            ? JSON.parse(String(r['previous_state'])) : null,
        newState: r['new_state'] != null
            ? JSON.parse(String(r['new_state'])) : null,
        changesetId: r['changeset_id'] != null ? String(r['changeset_id']) : null,
        compacted: Number(r['compacted'] ?? 0) === 1,
    };
}

function rowToChangeset(r: Record<string, unknown>): Changeset {
    return {
        id: String(r['id'] ?? ''),
        workspace: String(r['workspace'] ?? ''),
        status: String(r['status'] ?? 'open') as Changeset['status'],
        createdAt: String(r['created_at'] ?? ''),
        committedAt: r['committed_at'] != null ? String(r['committed_at']) : null,
        writeCount: Number(r['write_count'] ?? 0),
    };
}
