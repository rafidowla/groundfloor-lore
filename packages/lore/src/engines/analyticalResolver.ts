/**
 * analyticalResolver.ts — per-workspace IAnalyticalStorage factory
 * (2026-06-19, Postgres-model isolation).
 *
 * aggregate/time_series build a SqliteAnalyticalStorage from the
 * workspace's TABLE store, not from a graph connection. In the Postgres model (one daemon, many apps, each its own
 * workspace) those ops must run against the REQUESTED workspace's graph, not
 * the boot/active one. This factory resolves the workspace's graph via the
 * LocalGraphRegistry and builds an analytical over its connection — the same
 * construction createMcpServer uses for the boot graph, shared so the MCP tool
 * and the REST route can't drift.
 *
 * Returns `undefined` in cloud mode or when no registry is wired, so callers
 * fall back to the boot/active analytical (behavior unchanged). The returned
 * resolver throws WorkspaceNotFoundError for an unknown workspace — the calling
 * handler's try/catch surfaces it.
 */

import type { LocalGraphRegistry } from './localGraphRegistry.js';
import { createAnalyticalStorage } from './analyticalStorageFactory.js';
import type { IAnalyticalStorage } from '../contracts/index.js';

export function makeWorkspaceAnalyticalResolver(
    graphRegistry: LocalGraphRegistry | undefined,
    deploymentMode: 'local' | 'cloud' | 'embedded',
): ((workspace: string) => Promise<IAnalyticalStorage | null>) | undefined {
    if (deploymentMode === 'cloud' || !graphRegistry) return undefined;
    return async (workspace: string): Promise<IAnalyticalStorage | null> => {
        // Built FROM the workspace's table store, not from a graph connection.
        // This resolver used to reach `getGraphContext().storage` — the
        // graph-backed collection path — and aggregate there, while collections
        // have been written to SQLite since 061e189. Every aggregate therefore
        // threw `Table <name> does not exist` for twelve weeks on an exposed
        // tool surface. Deriving the analytical store from the table store
        // makes the two incapable of naming different substrates.
        // From the REGISTRY, not the graph: table storage is a SQLite file
        // keyed on the workspace PATH, and reaching it through
        // `graph.getTableStorage()` silently required the workspace to be on a
        // specific graph engine — the analytical tools then threw on any other one.
        // `tableStorageFor` memoises per workspace (one handle, one schema
        // sidecar owner), which is the invariant a second store would break.
        return createAnalyticalStorage(await graphRegistry.tableStorageFor(workspace));
    };
}
