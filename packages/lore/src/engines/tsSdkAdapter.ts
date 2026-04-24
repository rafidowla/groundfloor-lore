/**
 * tsSdkAdapter.ts — V3 Dataplane TS-SDK Sync Adapter.
 *
 * Purpose:
 *   Implements the SyncAdapter interface using the official @groundfloor/ts-sdk,
 *   migrating away from raw SurrealDB queries. This abstracts out the remote
 *   backend infrastructure from the Lore client.
 *
 * Architecture:
 *   Uses GroundfloorClient to execute schema-driven CRUD and graph traversals.
 *   Target Tenant: Configurable (e.g., groundfloor_lore).
 *
 * Error Behavior: Bubbles up Network/Auth errors from GroundfloorClient.
 * Idempotency: Uses update check + insert pattern natively for upsert semantics.
 */

// @ts-ignore - Local workspace linking lacks full Node16 exports declaration
import { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { LoreNode, LoreEdge } from './localGraph.js';
import type { SyncAdapter, SyncResult } from './syncEngine.js';

export interface TsSdkConfig {
    baseUrl: string;
    apiKey: string;
    tenantId: string;
    orgId: string;
}

export class TsSdkAdapter implements SyncAdapter {
    private config: TsSdkConfig;
    private client: GroundfloorClient | null = null;
    private connected: boolean = false;

    constructor(config: TsSdkConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        try {
            this.client = new GroundfloorClient(this.config.baseUrl, this.config.apiKey);
            this.connected = true;
        } catch (connectionError) {
            this.connected = false;
            throw new Error(`Failed to connect to TS SDK: ${(connectionError as Error).message}`);
        }
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.client = null;
    }

    async isConnected(): Promise<boolean> {
        return this.connected && this.client !== null;
    }

    async push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult> {
        this.ensureConnected();
        let nodesPushed = 0;
        let edgesPushed = 0;
        const errors: string[] = [];

        // Push nodes — upsert via updateByQuery + insert fallback.
        //
        // Why not `client.update({id: ...}, doc)`? That SDK method issues
        // `PUT /v1/:tenant/:collection` with `{filter, updates}`, which
        // Dataplane does not accept (no PUT handler on the collection
        // resource — returns 405). Dataplane's update contract uses
        // `PUT /v1/:tenant/:collection/update-by-query` with the Rust
        // enum-shaped filter `{id_eq: "<id>"}` and `fields: {...}`. The
        // SDK exposes this as `updateByQuery(tenant, coll, filter, fields)`.
        //
        // Upsert order: try update first; if 0 rows matched, fall through
        // to `insert`. This mirrors the TS-SDK's original intent and is
        // idempotent on re-runs (second call to the same id finds the row
        // and updates it).
        for (const node of nodes) {
            try {
                const doc = {
                    id: node.id,
                    type: node.type,
                    label: node.label,
                    content: node.content,
                    tags: node.tags ? node.tags.split(',').map((tag: string) => tag.trim()) : [],
                    project: node.project,
                    ecosystem: node.ecosystem,
                    org_id: this.config.orgId,
                    created_at: node.createdAt,
                    updated_at: node.updatedAt,
                    sync_id: `${node.id}-${node.updatedAt}`,
                };

                const updateRes = await this.client!.updateByQuery(
                    this.config.tenantId,
                    'lore_node',
                    { id_eq: node.id },
                    doc,
                );
                if ((updateRes?.updated ?? 0) === 0) {
                    await this.client!.insert(this.config.tenantId, 'lore_node', doc);
                }
                nodesPushed++;
            } catch (error) {
                errors.push(`Node '${node.id}': ${(error as Error).message}`);
            }
        }

        // Push edges using graph api
        for (const edge of edges) {
            try {
                await this.client!.graph.createEdge(this.config.tenantId, 'knowledge_graph', {
                    fromId: `lore_node/${edge.sourceId}`,
                    toId: `lore_node/${edge.targetId}`,
                    edgeCollection: 'lore_edge',
                    properties: { relation: edge.relation, org_id: this.config.orgId }
                });
                edgesPushed++;
            } catch (error) {
                errors.push(`Edge '${edge.sourceId}→${edge.targetId}': ${(error as Error).message}`);
            }
        }

        return { nodesPushed, edgesPushed, failures: errors.length, errors };
    }

    async pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }> {
        this.ensureConnected();
        try {
            // Using a simple query with a dynamic JS-style operator. The Engine mapping handles this if configured.
            const res = await this.client!.query(this.config.tenantId, 'lore_node', {
                filter: { org_id: this.config.orgId, updated_at: { $gt: since } },
                limit: 1000
            });
            const rawNodes = res.records || [];
            const nodes: LoreNode[] = rawNodes.map((record: any) => ({
                id: record.id,
                type: record.type,
                label: record.label,
                content: record.content ?? '',
                tags: Array.isArray(record.tags) ? record.tags.join(',') : '',
                project: record.project ?? '*',
                ecosystem: record.ecosystem ?? '*',
                metadata: '{}',
                createdAt: record.created_at ?? '',
                updatedAt: record.updated_at ?? '',
                syncedAt: new Date().toISOString(),
            }));
            
            // Note: graph edges are primarily local mapping constructs, omitted in base Dataplane sync stream
            return { nodes, edges: [] };
        } catch (error) {
            throw new Error(`Pull failed: ${(error as Error).message}`);
        }
    }

    /**
     * pushPluginData — Opaque record push for plugin-owned WAL entries.
     *
     * Collection naming convention: `${pluginName}_${kind}`. Each record
     * is expected to carry an `id` field for upsert; the adapter tries
     * `updateByQuery` first and falls back to `insert` on a zero-match
     * response (the same pattern used for LoreNode push to work around
     * Dataplane's PUT 405 on collection resources — see commit b25b114).
     * Records that lack an `id` are inserted unconditionally.
     */
    async pushPluginData(pluginName: string, kind: string, records: unknown[]): Promise<SyncResult> {
        this.ensureConnected();
        const collection = `${pluginName}_${kind}`;
        let nodesPushed = 0;
        const errors: string[] = [];

        for (const record of records) {
            try {
                const doc = {
                    ...(record as Record<string, unknown>),
                    org_id: this.config.orgId,
                    updated_at: new Date().toISOString(),
                };
                const id = (doc as Record<string, unknown>)['id'];
                if (typeof id === 'string' && id.length > 0) {
                    const updateRes = await this.client!.updateByQuery(
                        this.config.tenantId,
                        collection,
                        { id_eq: id },
                        doc,
                    );
                    if ((updateRes?.updated ?? 0) === 0) {
                        await this.client!.insert(this.config.tenantId, collection, doc);
                    }
                } else {
                    await this.client!.insert(this.config.tenantId, collection, doc);
                }
                nodesPushed++;
            } catch (error) {
                errors.push(`${collection}: ${(error as Error).message}`);
            }
        }

        return { nodesPushed, edgesPushed: 0, failures: errors.length, errors };
    }

    private ensureConnected(): void {
        if (!this.connected || !this.client) {
            throw new Error('Not connected to TS SDK Client');
        }
    }
}
