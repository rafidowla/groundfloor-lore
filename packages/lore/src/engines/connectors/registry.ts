/**
 * registry.ts — Connector registry.
 *
 * One instance per connector name. The registry owns:
 *   - registration at boot
 *   - list/get for CLI + UI surfaces
 *   - sync orchestration (wraps connector.sync to emit ConnectorAuditEvent
 *     around start / each item / complete / error)
 *   - uniform health() — falls back to defaultHealth when a connector
 *     does not implement the optional method
 *
 * The audit-listener pattern keeps connectors stupid: they yield items,
 * the registry decides what to record. A buggy connector cannot forge
 * or drop audit lines because audit lives outside connector code.
 */

import {
    defaultHealth,
    type ConnectorAuditEvent,
    type ConnectorAuditListener,
    type ConnectorItem,
    type ConnectorStatus,
    type HealthResult,
    type IConnector,
    type SyncOptions,
} from './types.js';

export class ConnectorRegistry {
    private readonly connectors = new Map<string, IConnector>();
    private readonly listeners = new Set<ConnectorAuditListener>();

    /** Register an audit listener. Returns an unsubscribe function. */
    addAuditListener(listener: ConnectorAuditListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

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

    listStatus(): Array<{ name: string; displayName: string; version: string; status: ConnectorStatus }> {
        return this.list().map((c) => ({
            name: c.name,
            displayName: c.displayName,
            version: c.version,
            status: c.getStatus(),
        }));
    }

    /**
     * Health check that always returns a HealthResult — uses connector's
     * own implementation if present, otherwise falls back to
     * defaultHealth. Throws if the connector is not registered.
     */
    async healthOf(name: string): Promise<HealthResult> {
        const c = this.connectors.get(name);
        if (!c) throw new Error(`Unknown connector: ${name}`);
        if (c.health) {
            const start = Date.now();
            const r = await c.health();
            return {
                ...r,
                latencyMs: r.latencyMs ?? (Date.now() - start),
            };
        }
        return defaultHealth(c);
    }

    /**
     * syncOne — run a sync against a specific connector, yielding items
     * lazily. Wraps the underlying iterator with ConnectorAuditEvent
     * emissions:
     *
     *   sync.start    → before the first item is requested
     *   sync.item     → for every yielded item
     *   sync.complete → after the iterator ends normally
     *   sync.error    → if the iterator throws
     *
     * If no listeners are registered the wrapping is essentially free.
     */
    async *syncOne(name: string, opts?: SyncOptions): AsyncIterable<ConnectorItem> {
        const c = this.connectors.get(name);
        if (!c) throw new Error(`Unknown connector: ${name}`);

        const start = Date.now();
        let yielded = 0;

        this.emit({
            kind: 'sync.start',
            connector: c.name,
            opts,
            at: new Date(start).toISOString(),
        });

        try {
            for await (const item of c.sync(opts)) {
                yielded++;
                this.emit({
                    kind: 'sync.item',
                    connector: c.name,
                    sourceId: item.sourceId,
                    mimeType: item.mimeType,
                    bytes: item.content.byteLength,
                    at: new Date().toISOString(),
                });
                yield item;
            }
        } catch (err) {
            this.emit({
                kind: 'sync.error',
                connector: c.name,
                itemsYielded: yielded,
                error: (err as Error).message,
                at: new Date().toISOString(),
            });
            throw err;
        }

        this.emit({
            kind: 'sync.complete',
            connector: c.name,
            itemsYielded: yielded,
            durationMs: Date.now() - start,
            at: new Date().toISOString(),
        });
    }

    /**
     * Notify listeners of an auth-state change. Connectors call this
     * (via the registry) when they connect or disconnect so audit logs
     * see the lifecycle.
     */
    notifyAuthEvent(connectorName: string, kind: 'auth.connected' | 'auth.disconnected'): void {
        this.emit({
            kind,
            connector: connectorName,
            at: new Date().toISOString(),
        });
    }

    private emit(event: ConnectorAuditEvent): void {
        if (this.listeners.size === 0) return;
        for (const l of this.listeners) {
            try { l(event); } catch { /* listener errors must not break sync */ }
        }
    }
}
