/**
 * tableStorageFactory.ts — build the collection/table backend for a workspace.
 *
 * Extracted from `LocalGraph.getTableStorage()` so the local-mode storage
 * bundle can build one WITHOUT holding a `LocalGraph`.
 *
 * SQLite is the only backend. The legacy `LORE_TABLE_BACKEND=kuzu` path
 * (`KuzuTableStorage` over Kùzu node tables) was removed with the Kùzu
 * teardown: a prior operator audit found ZERO `collection-schemas.json`
 * files (the Kùzu backend's schema cache) and 44/44 empty `tables.sqlite`
 * across every real workspace on this machine — no collection was ever
 * declared in either backend, so there is no legacy data to read.
 */

import * as path from 'node:path';
import type { ITableStorage } from '../contracts/tables.js';
import { SqliteTableStorage } from './sqliteTableStorage.js';

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
