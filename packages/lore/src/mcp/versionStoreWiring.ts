/**
 * versionStoreWiring.ts — picks the version-history backend at boot (cloud parity C item 8).
 *
 *   - cloud: the cloud graph OWNS a DataplaneVersionStore (the `lore_version` collection, scoped per
 *     Lore workspace from the request context), so no local sqlite file is opened. The keychain
 *     upgrade adopts the new connection into this same graph and the store follows it;
 *   - local: a sqlite VersionStore opened once at daemon boot (non-fatal when it cannot open).
 *
 * `localVersionStore` is the sqlite-only handle for prune and shutdown close; undefined in cloud mode.
 */
import { DataplaneGraph } from '../engines/dataplaneGraph.js';
import { VersionStore } from '../outbox/versionStore.js';
import type { VersionStoreApi } from '../outbox/versionStoreApi.js';

export function openVersionStores(
    graph: unknown,
    loreDir: string,
    warn: (message: string) => void,
): { versionStore: VersionStoreApi | undefined; localVersionStore: VersionStore | undefined } {
    if (graph instanceof DataplaneGraph) return { versionStore: graph.versions, localVersionStore: undefined };
    try {
        const localVersionStore = VersionStore.open(loreDir);
        return { versionStore: localVersionStore, localVersionStore };
    } catch (err) {
        warn(`[Lore MCP] VersionStore open failed (non-fatal — versioning tools unavailable): ${(err as Error).message}`);
        return { versionStore: undefined, localVersionStore: undefined };
    }
}
