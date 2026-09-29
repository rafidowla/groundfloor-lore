/**
 * reclaimOps.ts — storage-growth fix 3/3: low-level SQLite mechanics for the
 * offline reclaim tool, factored out of `versionStore.ts`/`sqliteStore.ts`.
 *
 * Both store classes hold a private better-sqlite3 `Database` handle and are
 * the only place SQL for their table is allowed to live — that discipline is
 * unchanged. What moved here is code that was IDENTICAL (or near-identical)
 * between the two classes: the tx-wrap trio and the auto_vacuum/VACUUM
 * conversion were literal duplicates (`sqliteStore.ts`'s own doc comment
 * said so — "Mirrors VersionStore.convertToIncrementalVacuum exactly").
 * Extracting them to plain functions over an injected `Database` handle
 * removes the duplication and keeps both call sites under the repo's
 * 800-line file-size guardrail (`scripts/test-file-sizes.mjs`) without
 * changing behaviour — each store still exposes the same public methods,
 * now as thin one-line delegations.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { isNoOpVersion } from './versionPolicy.js';

/**
 * Begin a manual transaction around the reclaim tool's own mutating steps,
 * so its `--dry-run` mode can run the exact same calls
 * (`dedupeIdenticalVersionRows`, `VersionStore.pruneVersions`,
 * `VersionStore.hardDeleteCompacted`, `SqliteOutboxStore.pruneReplicated`)
 * and roll them back instead of maintaining a separate read-only estimation
 * path that could drift from the real one. `db` is private to each store
 * class, so these three wrappers (re-exposed by each class as
 * `beginReclaimTx`/`commitReclaimTx`/`rollbackReclaimTx`) are the only way
 * an outside caller can drive that transaction. VACUUM cannot run inside an
 * explicit transaction (SQLite refuses it), so `convertToIncrementalVacuumOp`
 * below is always called AFTER `commitReclaimTx`/`rollbackReclaimTx`, never
 * between begin/end.
 *
 * `cache_size` is raised here (not left at SQLite's small default) to stop a
 * large reclaim transaction (hundreds of thousands of deletes against a
 * multi-hundred-MB file) from "spilling" dirty pages into the WAL file
 * before COMMIT/ROLLBACK. Measured against a real 1.3GB versions.sqlite
 * (storage-growth 3/3 real-data check, 2026-09): with the default cache, a
 * dry run's `--dry-run` transaction spilled ~228MB into the WAL, and the
 * connection's own automatic checkpoint-on-close then applied ~2.9MB of
 * that spill into the MAIN file — even though the transaction had already
 * been rolled back and every logical row was provably unchanged (a repeat
 * dry run reported identical counts). That silently broke the documented
 * "--dry-run writes nothing, byte-identical file" guarantee on real-scale
 * data despite passing on small synthetic test fixtures, which never grow
 * large enough to spill. A ~1GB cache keeps this reclaim tool's own
 * transactions entirely in memory for realistic data sizes, so ROLLBACK
 * leaves the WAL at 0 bytes and CLOSE has nothing to checkpoint — verified
 * with the same 1.3GB file: 0 bytes of WAL spill, byte-identical file
 * before/after. This is a heuristic bound, not a guarantee, for a
 * pathologically larger data dir; see reclaimStorage.ts's own doc comment.
 */
export function beginReclaimTx(db: DatabaseType): void {
    db.pragma('cache_size = -1000000'); // ~1GB, negative = KB not pages
    db.exec('BEGIN IMMEDIATE');
}

export function commitReclaimTx(db: DatabaseType): void {
    db.exec('COMMIT');
}

export function rollbackReclaimTx(db: DatabaseType): void {
    db.exec('ROLLBACK');
}

/**
 * Storage-growth fix 3/3, Step 4 — one-time offline conversion to
 * `auto_vacuum = INCREMENTAL` plus a full `VACUUM`, for a file created
 * before this sprint (each store's `open()`/constructor only sets
 * `INCREMENTAL` on a brand-new file). Checkpoints the WAL first
 * (`TRUNCATE`) so VACUUM's own rewrite doesn't also have to absorb a large
 * pending WAL, sets the pragma, then VACUUMs — the only two triggers that
 * make an `auto_vacuum` mode change actually take effect are an empty
 * database or immediately after a full VACUUM, per SQLite's own docs, which
 * is why each store's own `incrementalVacuum()` is a documented no-op on
 * any file that predates this conversion. A second checkpoint afterwards
 * forces VACUUM's WAL rewrite back into the main file so the reclaimed
 * bytes show up in its on-disk size immediately, not on some later
 * checkpoint.
 *
 * Must be called OUTSIDE any explicit transaction — SQLite refuses `VACUUM`
 * inside one — so the reclaim tool always calls this after
 * `commitReclaimTx()`, never between `beginReclaimTx()`/`commit`.
 */
export function convertToIncrementalVacuumOp(db: DatabaseType): { autoVacuumBefore: number; autoVacuumAfter: number } {
    const autoVacuumBefore = db.pragma('auto_vacuum', { simple: true }) as number;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const autoVacuumAfter = db.pragma('auto_vacuum', { simple: true }) as number;
    return { autoVacuumBefore, autoVacuumAfter };
}

/**
 * Storage-growth fix 3/3, Step 1 (VersionStore only) — drop `node_versions`
 * rows that are a true no-op against the very state they themselves
 * recorded writing from, using Sprint 1's exact comparison (`isNoOpVersion`,
 * versionPolicy.ts — reused, not copied).
 *
 * Per-row, not per-adjacent-pair: `previous_state` is always a FULL
 * pre-write snapshot (Sprint 1's `shouldRecordVersion` contract), so a
 * row's own `previous_state`/`new_state` pair already IS "this write
 * against whatever came before it" — nothing is gained, and correctness
 * would be LOST, by instead diffing two neighbouring rows' `new_state`
 * values against each other: `new_state` is only ever a PARTIAL echo of
 * the fields the caller supplied on that write, which is exactly why
 * Sprint 1 needed `FIELDS_CLEARED_ON_OMISSION` in the first place (two
 * partial echoes aren't safely comparable — a field omitted on write N
 * doesn't mean "unchanged since N-1", it can also mean "cleared"). So
 * this only ever inspects one row's own two stored columns, never a
 * neighbour's.
 *
 * The first row of every node is always kept, unconditionally —
 * precomputed once via `MIN(rowid) GROUP BY node_id` before the batch
 * loop starts (not inferred from scan order, so it holds regardless of
 * how the rowid-keyset pages happen to land). In practice a first row's
 * `previous_state` is `NULL` (the node didn't exist yet), which already
 * makes `isNoOpVersion` return `false` on its own (see that function's
 * early type guard) — this is a belt-and-suspenders guarantee, not the
 * primary mechanism, so a node's history can never be dropped to zero
 * rows by a degenerate case. Protected-node rows are exempt, the same
 * LIKE-based guard `pruneVersions`/`pruneVersionsBatched` already use.
 *
 * `previous_state` chain: dropping a row never requires patching a
 * surviving row's own `previous_state`. Nothing in this codebase
 * reconstructs history by walking `node_versions` rows adjacently —
 * every reader (`getVersions`, `getDiff`, `getVersionsByChangeset`, and
 * `rollback_changeset` in `mcp/tools/versioning.ts`) reads a single
 * row's own `previous_state`/`new_state` pair directly, keyed by that
 * row's own `version_id`/`changeset_id`, never by "the row before this
 * one in the table". A row this step drops is, by definition, one whose
 * own pair records no real change — so every SURVIVING row's own
 * `previous_state` is exactly as accurate after the drop as it was
 * before it. There is nothing to rewrite.
 *
 * Synchronous, unyielded, rowid-keyset-batched (same batch-size shape as
 * `VersionStore`'s own online batched methods, but with no `setImmediate`
 * yields): this only ever runs offline, against a data root that has
 * already passed the reclaim tool's held-root preflight — there is no live
 * event loop to protect here, unlike `pruneVersionsBatched`'s online,
 * yielding counterpart.
 */
export function dedupeIdenticalVersionRows(db: DatabaseType, batchSize: number): { scanned: number; dropped: number } {
    const firstRowids = new Set<number>();
    for (const row of db
        .prepare(`SELECT MIN(rowid) as r FROM node_versions GROUP BY node_id`)
        .iterate() as IterableIterator<{ r: number }>) {
        firstRowids.add(row.r);
    }

    const pageStmt = db.prepare(
        `SELECT rowid, version_id, previous_state, new_state
           FROM node_versions
          WHERE rowid > ?
          ORDER BY rowid
          LIMIT ?`,
    );
    const deleteStmt = db.prepare(`DELETE FROM node_versions WHERE version_id = ?`);

    let cursor = 0;
    let scanned = 0;
    let dropped = 0;
    for (;;) {
        const page = pageStmt.all(cursor, batchSize) as Array<{
            rowid: number;
            version_id: string;
            previous_state: string | null;
            new_state: string | null;
        }>;
        if (page.length === 0) break;
        for (const row of page) {
            scanned++;
            cursor = row.rowid;
            if (firstRowids.has(row.rowid)) continue;
            const isProtected =
                (row.previous_state !== null && row.previous_state.includes('"status":"protected"')) ||
                (row.new_state !== null && row.new_state.includes('"status":"protected"'));
            if (isProtected) continue;
            const prevState = row.previous_state !== null ? JSON.parse(row.previous_state) : null;
            const newState = row.new_state !== null ? JSON.parse(row.new_state) : null;
            if (isNoOpVersion(prevState, newState)) {
                deleteStmt.run(row.version_id);
                dropped++;
            }
        }
        if (page.length < batchSize) break;
    }
    return { scanned, dropped };
}
