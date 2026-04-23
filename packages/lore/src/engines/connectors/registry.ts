/**
 * registry.ts — Connector registry (Phase 2 / C5).
 *
 * One instance per connector name. The registry owns the lifecycle:
 *   - register at boot (core registers FilesystemConnector; future
 *     plugins can register additional connectors)
 *   - list/get for CLI + UI surfaces
 *   - proxy sync calls uniformly
 *
 * Deliberately minimal — all the interesting behaviour lives on the
 * IConnector implementations. This class just dispatches.
 */

import type { IConnector, ConnectorItem, SyncOptions, ConnectorStatus } from './types.js';

export class ConnectorRegistry {
    private readonly connectors = new Map<string, IConnector>();

    register(connector: IConnector): void {
        if (this.connectors.has(connector.name)) {
            throw new Error(`Connector "${connector.name}" already registered`);
        }
        this.connectors.set(connector.name, connector);
    }

    get(name: string): IConnector | undefined {
        return this.connectors.get(name);
    }

    list(): IConnector[] {
        return Array.from(this.connectors.values());
    }

    listStatus(): Array<{ name: string; displayName: string; status: ConnectorStatus }> {
        return this.list().map((c) => ({
            name: c.name,
            displayName: c.displayName,
            status: c.getStatus(),
        }));
    }

    /**
     * syncOne — run a sync against a specific connector, yielding items
     * lazily. Throws if the connector isn't registered.
     */
    syncOne(name: string, opts?: SyncOptions): AsyncIterable<ConnectorItem> {
        const c = this.connectors.get(name);
        if (!c) throw new Error(`Unknown connector: ${name}`);
        return c.sync(opts);
    }
}
