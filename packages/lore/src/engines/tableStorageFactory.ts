/**
 * tableStorageFactory.ts — build the collection/table backend for a workspace.
 *
 * Extracted from `LocalGraph.getTableStorage()` so the local-mode storage
 * bundle can build one WITHOUT holding a `LocalGraph`.
 *
 * SQLite is the backend for local-engine workspaces; a workspace on the Postgres
 * engine uses `createPostgresTableStorage` (rows in the shared database, sliced by
 * workspace_id = the workspace's permanent id, joinable to nodes in one statement). The legacy `LORE_TABLE_BACKEND` graph-engine path
 * (a graph-node-table-backed implementation) was removed: a prior operator
 * audit found ZERO `collection-schemas.json` files (that backend's schema
 * cache) and 44/44 empty `tables.sqlite` across every real workspace on
 * this machine — no collection was ever declared in either backend, so
 * there is no legacy data to read.
 */

import * as path from 'node:path';
import type { ITableStorage } from '../contracts/tables.js';
import { SqliteTableStorage } from './sqliteTableStorage.js';
import { PostgresTableStorage } from './postgres/postgresTableStorage.js';
import { resolvePostgresWorkspaceKey } from './postgres/postgresWorkspaceKey.js';
import { resolveWorkspaceGraphEngine } from './graphEngineSelector.js';
import { warnTablesLeftBehind } from './tablesLeftBehind.js';

/**
 * Build the table storage for the workspace rooted at `basePath`.
 */
export function createTableStorage(basePath: string): ITableStorage {
    const loreDir = path.join(basePath, '.lore');
    return new SqliteTableStorage(
        path.join(loreDir, 'tables.sqlite'),
        path.join(loreDir, 'sqlite-collection-schemas.json'),
    );
}

/**
 * Open a SQLite table storage at explicit file paths (not a workspace's live storage). Only for tools that work on a
 * private snapshot of a leftover `tables.sqlite` (`lore tables copy`); keeps every SqliteTableStorage construction here.
 */
export function openSqliteTableStorageAt(dbPath: string, schemasPath: string): SqliteTableStorage {
    return new SqliteTableStorage(dbPath, schemasPath);
}

/**
 * Build the Postgres-backed table storage bound to `workspace` (needs LORE_PG_URL;
 * bootstraps the schema on first open). Async because the schema cache is loaded
 * from the database. Used by `LocalGraphRegistry.tableStorageFor` for workspaces
 * whose graph engine is `postgres`.
 */
export function createPostgresTableStorage(workspace: string, home?: string): Promise<PostgresTableStorage> {
    // Rows are keyed by the workspace's permanent id (no name fallback: throws PostgresWorkspaceKeyError).
    return PostgresTableStorage.open(resolvePostgresWorkspaceKey(workspace, home));
}

/** Which table backend a workspace uses: its graph engine decides (postgres => the shared database, else the SQLite file). */
export function tableBackendFor(workspace: string, home?: string): 'postgres' | 'sqlite' {
    return resolveWorkspaceGraphEngine(workspace, home) === 'postgres' ? 'postgres' : 'sqlite';
}

/**
 * THE single place that chooses SQLite vs Postgres table storage for a workspace
 * (`LocalGraphRegistry.tableStorageFor`, the MCP storage bundle and `lore diagnose` all
 * call it). `basePath` is the workspace directory holding `.lore/` and is only used for
 * the SQLite backend; a Postgres workspace never creates or reads `tables.sqlite`.
 *
 * Ownership: the caller owns the returned handle and closes it. `close()` on the Postgres
 * handle only drops its caches - the shared pool belongs to postgresPoolOwner - so any
 * number of handles for one workspace is safe (a table created through another handle is
 * picked up on the next unknown-table miss).
 */
export async function createWorkspaceTableStorage(workspace: string, basePath: string, home?: string): Promise<ITableStorage> {
    if (tableBackendFor(workspace, home) === 'postgres') {
        // A workspace switched onto Postgres leaves its tables.sqlite behind, unread: say so once per process.
        warnTablesLeftBehind(workspace, basePath);
        return createPostgresTableStorage(workspace, home);
    }
    return createTableStorage(basePath);
}
