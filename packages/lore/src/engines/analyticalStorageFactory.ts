/**
 * analyticalStorageFactory.ts — build the analytical store that matches where
 * collections actually live.
 *
 * There were four independent call sites each constructing their own
 * analytical storage instance directly (`analyticalResolver`,
 * `createLocalAdapter`, `analyticalGetter`, `createMcpServer`), each
 * deciding for itself. That is how the twelve-week
 * defect survived: collections moved to SQLite in 061e189 and none of the four
 * followed, because none of them was the one obvious place to change.
 *
 * One factory, one decision: the analytical store is built FROM the table store
 * the workspace is actually using, so the two cannot drift apart again. If the
 * table store is SQLite the aggregates run against that same database handle;
 * a caller cannot accidentally aggregate over a different substrate than the
 * one it writes to.
 */

import type { IAnalyticalStorage } from '../contracts/analytical.js';
import type { ITableStorage } from '../contracts/tables.js';
import { SqliteTableStorage } from './sqliteTableStorage.js';
import { SqliteAnalyticalStorage } from './sqliteAnalyticalStorage.js';

/**
 * Analytical aggregates over `tableStorage`, or `null` when the backend has no
 * analytical implementation.
 *
 * Null rather than a throwing stub: `mcp/tools/analytical.ts` already handles a
 * null store by reporting the surface as not wired, which is a truthful answer.
 * A stub that threw on call would report "broken" for a configuration that is
 * merely unsupported — the distinction the last twelve weeks blurred.
 */
export function createAnalyticalStorage(tableStorage: ITableStorage): IAnalyticalStorage | null {
    if (tableStorage instanceof SqliteTableStorage) {
        return new SqliteAnalyticalStorage(
            tableStorage.getDatabase(),
            (coll) => tableStorage.resolveCollectionTable(coll),
            // Share the declared column types so analytical filters encode
            // and results decode with the SAME map as reads/writes (audit
            // cluster 5, 2026-08-17).
            (table) => tableStorage.getColumnTypes(table),
        );
    }
    // No other table backend currently exists — this branch is a defensive
    // fallback for any future `ITableStorage` implementation that supplies
    // its own analytical path, since this factory can only build one from a
    // table store it recognizes.
    return null;
}
