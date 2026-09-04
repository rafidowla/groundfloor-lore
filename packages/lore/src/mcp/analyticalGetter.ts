/**
 * mcp/analyticalGetter.ts — Sprint C5 lazy IAnalyticalStorage builder.
 *
 * Extracted from server.ts to keep that file under the 800-line cap.
 * The HTTP /api/time-series + /api/aggregate routes (mcp/http/routes/
 * analytics.ts) consume IAnalyticalStorage through this getter so the
 * dispatcher doesn't need to know whether a local backend exists.
 *
 * Local mode: builds SqliteAnalyticalStorage on first call from the
 * bundle's table storage — same
 * path createMcpServer takes for the MCP analytical tools.
 *
 * Cloud mode: returns null until step #6's DataplaneAnalyticalStorage
 * lands; routes surface HTTP 503 analytical_not_wired in the meantime.
 */

import type { IAnalyticalStorage } from '../contracts/index.js';
import type { StorageBundle } from './services.js';
import { createAnalyticalStorage } from '../engines/analyticalStorageFactory.js';

/**
 * Returns a memoized getter. The first call attempts to build the
 * SQLite-backed analytical storage; subsequent calls return the cached
 * handle (or null if the build failed / cloud mode).
 */
export function getAnalyticalCached(
    deploymentMode: 'local' | 'cloud',
    store: StorageBundle,
): () => IAnalyticalStorage | null {
    let cached: IAnalyticalStorage | null | undefined = undefined;
    return () => {
        if (cached !== undefined) return cached;
        if (deploymentMode !== 'local') { cached = null; return null; }
        try {
            // Derived from the bundle's TABLE storage, not from the graph's
            // own collection connection. Reaching the latter is what made
            // every aggregate throw `Table <name> does not exist` for twelve
            // weeks after collections moved to SQLite in 061e189 — the two
            // halves named different substrates and nothing compared them.
            // The bundle already carries the table store the workspace writes
            // through, so building from it cannot drift.
            cached = createAnalyticalStorage(store.tableStorage);
            return cached;
        } catch {
            cached = null;
            return null;
        }
    };
}
