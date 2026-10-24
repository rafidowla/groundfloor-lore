/**
 * postgresWorkspaceBackup.ts — the Postgres adapter behind the
 * `WorkspaceLogicalBackup` port (engines/workspaceLogicalBackup.ts).
 *
 * Callers outside `engines/postgres/` reach this only through
 * `openWorkspaceLogicalBackup('postgres')`, so the `pg` driver stays inside the
 * engine directory (D-017) and a Dataplane-backed adapter can later sit behind
 * the same port.
 */

import type { Pool } from 'pg';
import type { LogicalBackupRequest, LogicalRestoreRequest, WorkspaceLogicalBackup } from '../workspaceLogicalBackup.js';
import { exportWorkspaceBundle } from './postgresBackupExport.js';
import { restoreWorkspaceBundle } from './postgresBackupRestore.js';
import { closeSharedPostgresPool, sharedPostgresPool } from './postgresPoolOwner.js';

export interface PostgresWorkspaceBackupOptions {
    /** Use this pool instead of the process-shared one (tests). The caller keeps ownership of it. */
    pool?: Pool;
    /** Database schema holding the workspace tables. Default: `public`. */
    schema?: string;
    fetchSize?: number;
    batchRows?: number;
    gzip?: boolean;
}

export function openPostgresWorkspaceBackup(opts: PostgresWorkspaceBackupOptions = {}): WorkspaceLogicalBackup {
    const ownsPool = opts.pool === undefined;
    const pool = (): Pool => opts.pool ?? sharedPostgresPool();
    return {
        engine: 'postgres',
        backup: (req: LogicalBackupRequest) => exportWorkspaceBundle(pool(), {
            workspaceId: req.workspaceId, outDir: req.outDir, outboxDepth: req.outboxDepth,
            schema: opts.schema, fetchSize: opts.fetchSize, gzip: opts.gzip,
        }),
        restore: (req: LogicalRestoreRequest) => restoreWorkspaceBundle(pool(), {
            bundlePath: req.bundlePath, targetWorkspaceId: req.targetWorkspaceId, force: req.force,
            outboxDepth: req.outboxDepth, schema: opts.schema, batchRows: opts.batchRows,
        }),
        close: async () => { if (ownsPool) await closeSharedPostgresPool(); },
    };
}
