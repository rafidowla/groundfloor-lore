/**
 * tsSdkAdapter.ts — V3 Dataplane TS-SDK Sync Adapter.
 *
 * Purpose:
 *   Implements the SyncAdapter interface using the official @groundfloor/ts-sdk.
 *   This abstracts the remote backend infrastructure away from the Lore client.
 *
 * Architecture:
 *   Uses GroundfloorClient to execute schema-driven CRUD and graph traversals.
 *   Target Tenant: Configurable (e.g., groundfloor_lore).
 *
 * Error Behavior: Bubbles up Network/Auth errors from GroundfloorClient.
 * Idempotency: Uses update check + insert pattern natively for upsert semantics.
 */

// TW-1b: groundfloor-ts-sdk is an OPTIONAL, cloud-only dependency. Type-only
// import (erased at compile time); the runtime class is loaded lazily in
// connect() so constructing a TsSdkAdapter in a local install never statically
// loads the SDK module.
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { LoreNode, LoreEdge } from '../providers/types.js';
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
    /** SP-18 — per-(collection,id) serialization tail. The upsert below is a
     *  check-then-act (updateByQuery → insert-on-zero-match); two concurrent
     *  pushes for the SAME id (sync auto-tick racing a manual /api/sync/push)
     *  both see updated:0 for a fresh id and BOTH insert → duplicate row. We
     *  chain same-id operations through this promise map so the second push's
     *  check runs only AFTER the first's insert commits (it then sees
     *  updated:1 and skips the insert). Different ids never contend. */
    private upsertChains = new Map<string, Promise<unknown>>();

    constructor(config: TsSdkConfig) {
        this.config = config;
    }

    /**
     * SP-18 — serialize an async op behind any in-flight op for the same key.
     * Keeps the map clean by deleting the entry once its tail settles (only
     * when no newer op has chained on, to avoid evicting a live tail).
     */
    private async serializeById<T>(key: string, op: () => Promise<T>): Promise<T> {
        const prev = this.upsertChains.get(key) ?? Promise.resolve();
        // Swallow the predecessor's rejection for ORDERING only — the
        // predecessor's own caller still observes its error; we just must not
        // let a prior failure reject this op before it runs.
        const run = prev.catch(() => undefined).then(op);
        this.upsertChains.set(key, run);
        try {
            return await run;
        } finally {
            if (this.upsertChains.get(key) === run) this.upsertChains.delete(key);
        }
    }

    async connect(): Promise<void> {
        try {
            // TW-1b: lazily resolve the optional SDK. A local install without
            // the dep surfaces a clear error here instead of ERR_MODULE_NOT_FOUND.
            let GroundfloorClientCtor: typeof import('groundfloor-ts-sdk').GroundfloorClient;
            try {
                const m = await import('groundfloor-ts-sdk');
                GroundfloorClientCtor = m.GroundfloorClient;
            } catch (importError) {
                throw new Error(
                    "cloud sync requires the optional dependency 'groundfloor-ts-sdk' — " +
                        "install it to use deploymentMode:'cloud'. " +
                        `(dynamic import failed: ${(importError as Error).message})`,
                );
            }
            this.client = new GroundfloorClientCtor(this.config.baseUrl, this.config.apiKey);
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
                    tags: node.tags ?? [],
                    project: node.project,
                    ecosystem: node.ecosystem,
                    org_id: this.config.orgId,
                    created_at: node.createdAt,
                    updated_at: node.updatedAt,
                    sync_id: `${node.id}-${node.updatedAt}`,
                };

                // SP-18 — serialize the check-then-act per id so concurrent
                // pushes for the same node can't both insert (TOCTOU duplicate).
                await this.serializeById(`lore_node:${node.id}`, async () => {
                    const updateRes = await this.client!.updateByQuery(
                        'lore_node',
                        { id_eq: node.id },
                        doc,
                    );
                    if ((updateRes?.updated ?? 0) === 0) {
                        await this.client!.insert('lore_node', doc);
                    }
                });
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

    /**
     * pushDeletes — Propagate local `delete_node` WAL entries to Dataplane.
     *
     * SW-02 (B2): deletes used to be decoded by the sync engine and then
     * dropped (no adapter call) while the WAL truncated — the cloud kept
     * deleted nodes forever. We delete each id via `deleteByQuery` with the
     * Rust enum-shaped filter `{id_eq}` (the same filter shape push() uses
     * for updateByQuery). Per-id serialization mirrors push() so a delete
     * can't race a concurrent upsert of the same id. Idempotent — deleting
     * an already-absent id reports 0 rows, not an error.
     */
    async pushDeletes(ids: string[]): Promise<SyncResult> {
        this.ensureConnected();
        let nodesPushed = 0;
        const errors: string[] = [];
        for (const id of ids) {
            try {
                await this.serializeById(`lore_node:${id}`, async () => {
                    await this.client!.deleteByQuery('lore_node', { id_eq: id });
                });
                nodesPushed++;
            } catch (error) {
                errors.push(`Delete '${id}': ${(error as Error).message}`);
            }
        }
        return { nodesPushed, edgesPushed: 0, failures: errors.length, errors };
    }

    async pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }> {
        this.ensureConnected();
        try {
            // RA2-reaudit2 — use the Dataplane suffix-key filter convention the
            // SDK actually parses (e.g. `updated_at_gt`), not the Mongo-style
            // nested `{ $gt }` operator (which the suffix-key parser silently
            // ignored → pull returned the whole collection / nothing usable).
            // Matches dataplaneGraph bulkList's `updated_at` cursor handling.
            const res = await this.client!.query('lore_node', {
                filter: { org_id: this.config.orgId, updated_at_gt: since },
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

    private ensureConnected(): void {
        if (!this.connected || !this.client) {
            throw new Error('Not connected to TS SDK Client');
        }
    }
}
