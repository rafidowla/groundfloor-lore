/**
 * openWorkspaceEraser.ts — the port through which code outside `engines/postgres/` reaches a server
 * engine's `WorkspaceEraser`, so the `pg` driver stays inside the engine directory (D-017). Same shape as
 * `engines/workspaceLogicalBackup.ts`: loaded lazily, throws for engines that have no eraser here.
 *
 * Postgres rows are keyed by the workspace's PERMANENT id (see postgresWorkspaceErase.ts: `POSTGRES_ROWS_KEYED_BY`),
 * so the eraser opened here deletes by that id and nothing else.
 */

import type { PostgresWorkspaceEraseOptions } from '../postgres/postgresWorkspaceErase.js';
import type { IIngestionStore } from '../../ingestion/store.js';
import type { WorkspaceEraser } from './types.js';

export interface OpenWorkspaceEraserOptions {
    /** Use this pool instead of the process-shared one (tests). The caller keeps ownership of it. */
    pool?: PostgresWorkspaceEraseOptions['pool'];
    /** Use a private pool, ended by `close()` (see PostgresWorkspaceEraseOptions.dedicatedPool). Required inside a host that owns the shared pool. */
    dedicatedPool?: boolean;
    schema?: string;
    batchRows?: number;
}

export interface OpenedWorkspaceEraser extends WorkspaceEraser {
    /** Release any connection pool the adapter opened itself. Safe to call more than once. */
    close(): Promise<void>;
}

export async function openWorkspaceEraser(engine: string, opts: OpenWorkspaceEraserOptions = {}): Promise<OpenedWorkspaceEraser> {
    if (engine === 'postgres') {
        const mod = await import('../postgres/postgresWorkspaceErase.js');
        return mod.createPostgresWorkspaceEraser(opts);
    }
    throw new Error(`no per-workspace eraser exists for engine '${engine}'`);
}

export interface OpenedIngestionStore {
    store: IIngestionStore;
    /** Release what was opened here. Safe to call more than once. */
    close(): Promise<void>;
}

/**
 * Open the Postgres ingestion store bound to `workspace`, which here is the workspace's PERMANENT id (the row key; the
 * erase path reads rows by id, never by name), over a private
 * pool that `close()` ends, so a host that owns the shared pool is never disturbed and a CLI process can exit.
 * Throws when `LORE_PG_URL` is not set.
 */
export async function openIngestionStoreForErase(engine: 'postgres', workspace: string): Promise<OpenedIngestionStore> {
    if (engine !== 'postgres') throw new Error(`no server ingestion store exists for engine '${engine}'`);
    const { createPostgresPool, closePostgresPool } = await import('../postgres/postgresClient.js');
    const { PostgresIngestionStore } = await import('../postgres/postgresIngestionStore.js');
    const pool = createPostgresPool({ max: 2 });
    let closed = false;
    const close = async (): Promise<void> => { if (closed) return; closed = true; await closePostgresPool(pool); };
    try {
        return { store: await PostgresIngestionStore.open(workspace, pool), close };
    } catch (e) { await close().catch(() => undefined); throw e; }
}
