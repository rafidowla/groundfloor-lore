/**
 * analyticalStorageFactory.ts — build the analytical store that matches where
 * collections actually live.
 *
 * There were four independent `new KuzuAnalyticalStorage(...)` sites
 * (`analyticalResolver`, `createLocalAdapter`, `analyticalGetter`,
 * `createMcpServer`), each deciding for itself. That is how the twelve-week
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
    // The Kùzu table backend keeps its own analytical implementation, reached
    // only by callers that still hold a Kùzu connection. It is not constructed
    // here because this factory is given a table store, not a connection — and
    // because no workspace on this machine has ever used that backend.
    return null;
}
