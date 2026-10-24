/**
 * cli/commands/backupPostgres.ts — the Postgres side of `lore backup` /
 * `lore restore`.
 *
 * A Postgres workspace keeps no files under `.lore/` (its rows live in the
 * shared database), so the file archive cannot hold it. These helpers route it
 * to the logical per-workspace path (`engines/workspaceLogicalBackup.ts`),
 * which writes a verified `lore-pgbackup-<workspace>-<iso>.ndjson[.gz]` bundle.
 * Nothing here imports the `pg` driver (D-017): the engine is reached through
 * the port, loaded lazily, so a SQLite-only install never loads it.
 *
 * The SQLite code paths in backup.ts / restore.ts are untouched; they call in
 * here only when a workspace is registered with the postgres engine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { resolveWorkspaceGraphEngine } from '../../engines/graphEngineSelector.js';
import { resolveWorkspaceVectorEngine } from '../../engines/vectorEngineSelector.js';
import {
    LogicalBackupError, openWorkspaceLogicalBackup,
    type LogicalBackupSummary, type LogicalRestoreSummary,
} from '../../engines/workspaceLogicalBackup.js';

export type PostgresBackupMode = 'logical' | 'mixed' | 'none';

/**
 * How a workspace is backed up: `logical` (graph AND vectors on postgres),
 * `mixed` (only one of them — a tarball half plus a logical half cannot be
 * restored as one unit, so it is refused), or `none` (no postgres involved:
 * the existing file archive applies).
 */
export function postgresBackupMode(wsName: string): PostgresBackupMode {
    const g = resolveWorkspaceGraphEngine(wsName) === 'postgres';
    const v = resolveWorkspaceVectorEngine(wsName) === 'postgres';
    if (g && v) return 'logical';
    return g || v ? 'mixed' : 'none';
}

export function describeMixedEngines(wsName: string): string {
    return `graphEngine '${resolveWorkspaceGraphEngine(wsName)}', vectorEngine '${resolveWorkspaceVectorEngine(wsName)}'`;
}

const OUTBOX_UNDRAINED = ['pending', 'replicating', 'failed', 'pending_commit'];

/**
 * Un-drained outbox rows for a workspace, read straight from its
 * `.lore/outbox.sqlite` (read-only; no daemon needed). A missing file means
 * the workspace never queued anything: 0. A file that exists but cannot be
 * read FAILS CLOSED — a backup that cannot prove the lane is drained must not
 * be taken, because it could snapshot the graph ahead of its vectors.
 */
export function readOutboxDepth(workspaceDir: string, wsName: string): number {
    const file = path.join(workspaceDir, '.lore', 'outbox.sqlite');
    if (!fs.existsSync(file)) return 0;
    let db: Database.Database | undefined;
    try {
        db = new Database(file, { readonly: true, fileMustExist: true });
        const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox_entries'`).get();
        if (!has) return 0;
        const marks = OUTBOX_UNDRAINED.map(() => '?').join(',');
        const row = db.prepare(`SELECT COUNT(*) AS n FROM outbox_entries WHERE workspace = ? AND status IN (${marks})`).get(wsName, ...OUTBOX_UNDRAINED) as { n: number };
        return row.n;
    } catch (err) {
        throw new Error(`cannot read the write-lane outbox at ${file} (${(err as Error).message}); refusing rather than guess it is drained`);
    } finally {
        db?.close();
    }
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prune older logical bundles (and their sidecar manifests) for one workspace beyond `keep`. */
export function pruneOldPostgresBundles(outDir: string, wsName: string, keep: number): string[] {
    if (!fs.existsSync(outDir)) return [];
    const safe = wsName.replace(/[^A-Za-z0-9._-]/g, '_');
    const re = new RegExp(`^lore-pgbackup-${escapeRe(safe)}-\\d{4}-\\d{2}-\\d{2}T[^/]*\\.ndjson(\\.gz)?$`);
    const bundles = fs.readdirSync(outDir)
        .filter((n) => re.test(n))
        .map((n) => ({ n, mtime: fs.statSync(path.join(outDir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    const pruned: string[] = [];
    for (const b of bundles.slice(keep)) {
        for (const f of [b.n, `${b.n}.manifest.json`]) {
            try { fs.unlinkSync(path.join(outDir, f)); if (f === b.n) pruned.push(path.join(outDir, f)); } catch { /* best effort */ }
        }
    }
    return pruned;
}

/** Back up one postgres-engine workspace to a verified logical bundle; prints the result. */
export async function backupPostgresWorkspace(
    wsName: string, workspaceDir: string, outDir: string, keep: number,
): Promise<LogicalBackupSummary> {
    console.log(`→ Backing up postgres workspace '${wsName}' (logical bundle; rows read from the shared database)`);
    const port = await openWorkspaceLogicalBackup('postgres');
    try {
        const s = await port.backup({ workspaceId: wsName, outDir, outboxDepth: async () => readOutboxDepth(workspaceDir, wsName) });
        console.log(`✓ ${s.bundlePath}`);
        console.log(`  ${(s.bytes / 1024 / 1024).toFixed(1)} MB · ${s.tables.length} table(s) · ${s.totalRows} row(s) · ${(s.durationMs / 1000).toFixed(1)}s`);
        console.log(`  verified: per-table counts match the snapshot and the written file was re-read; manifest ${s.manifestHash.slice(0, 16)}…`);
        for (const w of s.warnings) console.error(`  ! ${w}`);
        const pruned = pruneOldPostgresBundles(outDir, wsName, keep);
        if (pruned.length > 0) console.log(`  rotated: pruned ${pruned.length} older bundle(s) beyond keep=${keep}`);
        return s;
    } finally {
        await port.close();
    }
}

/** Restore a logical bundle into `targetWorkspace` (rows are rewritten to it); prints the result. */
export async function restorePostgresBundle(
    bundlePath: string, targetWorkspace: string, workspaceDir: string, replace: boolean,
): Promise<LogicalRestoreSummary> {
    console.log(`→ Restoring '${path.basename(bundlePath)}' into postgres workspace '${targetWorkspace}'`);
    const port = await openWorkspaceLogicalBackup('postgres');
    try {
        const r = await port.restore({
            bundlePath, targetWorkspaceId: targetWorkspace, force: replace,
            outboxDepth: async () => readOutboxDepth(workspaceDir, targetWorkspace),
        });
        console.log(`✓ Restored ${r.totalRows} row(s) across ${r.tables.length} table(s) · ${(r.durationMs / 1000).toFixed(1)}s`);
        console.log('  verified: every table re-read inside the restore transaction and matched the bundle manifest');
        if (r.clearedRows > 0) console.log(`  replaced ${r.clearedRows} existing row(s) in the target workspace`);
        for (const m of r.idRemaps) console.log(`  ids shifted: ${m.table}.${m.column} by ${m.offset} (kept clear of other workspaces)`);
        for (const w of r.warnings) console.error(`  ! ${w}`);
        return r;
    } finally {
        await port.close();
    }
}

export { LogicalBackupError };

export interface LogicalRestoreFlags {
    /** Bypass the running-daemon gate (same meaning as for a file restore). */
    force?: boolean;
    /** Allow the bundle's source workspace to differ from the target (restore "as" another id). */
    allowNameMismatch?: boolean;
    /** Clear a non-empty target workspace first (inside the restore transaction). */
    replace?: boolean;
}

/**
 * CLI half of a logical restore: resolves and guards the target, then calls
 * `restorePostgresBundle`. Returns false (after printing why) for a handled
 * refusal, like `restoreOneWorkspace` does for the file path.
 */
export async function restoreLogicalBundleCli(
    bundlePath: string, sourceWorkspace: string, targetWorkspace: string, flags: LogicalRestoreFlags,
    deps: { workspaceDir: (name: string) => string | null; daemonServesHome: () => Promise<boolean>; daemonMessage: string },
): Promise<boolean> {
    const dir = deps.workspaceDir(targetWorkspace);
    if (dir === null) {
        console.error(`No workspace named '${targetWorkspace}' is registered. Register it (on the postgres engine) first.`);
        return false;
    }
    if (postgresBackupMode(targetWorkspace) !== 'logical') {
        console.error(`lore restore: workspace '${targetWorkspace}' is not registered with graphEngine 'postgres' and vectorEngine 'postgres' (${describeMixedEngines(targetWorkspace)}).`);
        console.error('  A logical bundle holds postgres rows; restoring it would not make the workspace readable.');
        return false;
    }
    if (sourceWorkspace !== targetWorkspace && !flags.allowNameMismatch) {
        console.error(`lore restore: this bundle was taken from workspace '${sourceWorkspace}' but you are restoring into '${targetWorkspace}'.`);
        console.error('  If that is intended (e.g. restoring a copy next to the original), pass --allow-name-mismatch.');
        return false;
    }
    if (!flags.force && await deps.daemonServesHome()) {
        console.error(deps.daemonMessage);
        console.error('A running daemon may be writing this workspace; restoring under it would race its writes.');
        return false;
    }
    await restorePostgresBundle(bundlePath, targetWorkspace, dir, flags.replace ?? false);
    return true;
}
