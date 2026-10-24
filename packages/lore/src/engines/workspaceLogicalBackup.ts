/**
 * workspaceLogicalBackup.ts — the engine-neutral port for per-workspace
 * LOGICAL backup and restore of a server-engine workspace.
 *
 * Why a port: SQLite workspaces back up as a file archive (`engines/backup.ts`)
 * and cannot be sliced out of a shared server database. A server engine holds
 * many workspaces in one database keyed by `workspace_id`, so it needs a
 * logical, per-workspace export. Callers (the CLI, later the daemon or a
 * Dataplane-backed adapter) depend on THIS interface only and never on the
 * driver; the Postgres implementation lives in `engines/postgres/` and is
 * loaded lazily so non-Postgres hosts never pay for it.
 *
 * Guarantees every implementation must keep (they mirror routes/arcadeBackup):
 *   - a backup is only reported successful after what was captured was
 *     checked (per-table counts against the source, bundle re-verified);
 *   - restore verifies the bundle hash BEFORE any write (`bundle_hash_mismatch`);
 *   - a non-empty target is refused unless `force` (`restore_target_not_empty`);
 *   - an un-drained outbox lane is refused (`outbox_not_drained`);
 *   - a restore ends in a verified state or leaves the target untouched.
 */

import {
    BUNDLE_HASH_MISMATCH,
    OUTBOX_NOT_DRAINED,
    RESTORE_TARGET_NOT_EMPTY,
} from '../mcp/http/errorCodes.js';

export { BUNDLE_HASH_MISMATCH, OUTBOX_NOT_DRAINED, RESTORE_TARGET_NOT_EMPTY };
/** The workspace has no rows at all: almost certainly a wrong name, never a backup worth keeping. */
export const WORKSPACE_EMPTY = 'workspace_empty';
/** The bundle's tables/columns do not fit the target database's schema. */
export const SCHEMA_MISMATCH = 'schema_mismatch';
/** What was captured/restored did not match what was read back; nothing is kept. */
export const VERIFICATION_FAILED = 'verification_failed';

export class LogicalBackupError extends Error {
    constructor(readonly code: string, message: string, readonly status: number = 409) {
        super(message);
        this.name = 'LogicalBackupError';
    }
}

export interface LogicalTableSummary {
    name: string;
    rowCount: number;
    checksum: string;
}

export interface LogicalBackupRequest {
    workspaceId: string;
    /** Directory the bundle (and its sidecar manifest) is written into. */
    outDir: string;
    /** Un-drained write-lane depth for this workspace; > 0 refuses the backup. */
    outboxDepth?: () => Promise<number>;
}

export interface LogicalBackupSummary {
    bundlePath: string;
    manifestPath: string;
    workspaceId: string;
    totalRows: number;
    tables: LogicalTableSummary[];
    /** Lore tables the backup does NOT carry, each with the reason. Never silently dropped. */
    excluded: { table: string; reason: string }[];
    manifestHash: string;
    bytes: number;
    durationMs: number;
    warnings: string[];
}

export interface LogicalRestoreRequest {
    bundlePath: string;
    /** Workspace id to restore INTO; rows are rewritten to it when it differs from the source. */
    targetWorkspaceId: string;
    /** Clear the target workspace's existing rows first (inside the restore transaction). */
    force?: boolean;
    outboxDepth?: () => Promise<number>;
}

export interface LogicalRestoreSummary {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    totalRows: number;
    tables: LogicalTableSummary[];
    /** Rows removed from the target before loading (force only). */
    clearedRows: number;
    /** Surrogate-id shifts applied so ids cannot collide with other workspaces. Empty when ids were kept. */
    idRemaps: { table: string; column: string; offset: string }[];
    manifestHash: string;
    durationMs: number;
    warnings: string[];
}

export interface LogicalBundleInfo {
    sourceWorkspaceId: string;
    createdAt: string;
    loreVersion: string;
    tableCount: number;
}

export interface WorkspaceLogicalBackup {
    readonly engine: 'postgres';
    backup(req: LogicalBackupRequest): Promise<LogicalBackupSummary>;
    restore(req: LogicalRestoreRequest): Promise<LogicalRestoreSummary>;
    /** Release any connection pool the adapter opened itself. Safe to call more than once. */
    close(): Promise<void>;
}

/** Open the logical-backup adapter for a server engine. Loaded lazily; throws for engines that have none. */
export async function openWorkspaceLogicalBackup(engine: string): Promise<WorkspaceLogicalBackup> {
    if (engine === 'postgres') {
        const mod = await import('./postgres/postgresWorkspaceBackup.js');
        return mod.openPostgresWorkspaceBackup();
    }
    throw new Error(`no logical per-workspace backup exists for engine '${engine}' (use the file archive)`);
}

/**
 * Identify a file by content: returns bundle facts when it is a Lore logical
 * workspace bundle, null for anything else (e.g. a SQLite `.tar.gz` archive).
 */
export async function peekLogicalBundle(path: string): Promise<LogicalBundleInfo | null> {
    const mod = await import('./postgres/postgresBackupBundle.js');
    const header = await mod.peekBundleHeader(path);
    if (!header) return null;
    return {
        sourceWorkspaceId: header.sourceWorkspaceId,
        createdAt: header.createdAt,
        loreVersion: header.loreVersion,
        tableCount: header.tables.length,
    };
}
