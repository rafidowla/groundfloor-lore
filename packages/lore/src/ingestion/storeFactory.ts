/**
 * ingestion/storeFactory.ts — pick the IIngestionStore for a workspace.
 *
 * Selection follows the workspace's graph engine (the same registry field the
 * graph substrate uses, via resolveWorkspaceGraphEngine): `postgres` => the
 * Postgres store bound to that workspace (rows keyed by its permanent id) in the shared database named by
 * LORE_PG_URL; anything else => the local SQLite file. There is NO silent
 * fallback: a postgres workspace with LORE_PG_URL unset throws, it never gets a
 * SQLite file. `pg` is loaded lazily so SQLite-only hosts never import it.
 */
import * as path from 'node:path';
import { resolveWorkspaceGraphEngine } from '../engines/graphEngineSelector.js';
import { SqliteIngestionStore } from './sqliteStore.js';
import type { IIngestionStore } from './store.js';

export interface IngestionStoreOptions {
    workspace: string;
    /** SQLite file for non-postgres workspaces. Required unless the workspace is postgres. */
    sqlitePath?: string;
    /** LORE_HOME override for engine resolution (tests). */
    home?: string;
    /** Force an engine instead of reading workspaces.json (tests / explicit host config). */
    engine?: 'postgres' | 'sqlite';
}

export async function createIngestionStore(o: IngestionStoreOptions): Promise<IIngestionStore> {
    const engine = o.engine ?? (resolveWorkspaceGraphEngine(o.workspace, o.home) === 'postgres' ? 'postgres' : 'sqlite');
    if (engine === 'postgres') {
        const { PostgresIngestionStore } = await import('../engines/postgres/postgresIngestionStore.js');
        const { resolvePostgresWorkspaceKey } = await import('../engines/postgres/postgresWorkspaceKey.js');
        // Rows are keyed by the workspace's permanent id; callers and returned records keep using the name.
        return PostgresIngestionStore.open(o.workspace, undefined, resolvePostgresWorkspaceKey(o.workspace, o.home));
    }
    if (!o.sqlitePath) throw new Error(`createIngestionStore: sqlitePath is required for non-postgres workspace '${o.workspace}'`);
    return new SqliteIngestionStore(path.resolve(o.sqlitePath));
}
