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
import {
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    DataplaneScopeError,
    resolveDataplaneScope,
    type DataplaneScope,
    type LoreWorkspaceRegistry,
    scopeWorkspaceName,
} from './dataplaneScopeFilter.js';
import { keepInScope, scopedUpsert, unscopeRow } from './dataplaneScopedIo.js';
import { asLoreDataplaneSdk, type CollectionFirstSdk } from './dataplaneSdkCompat.js';

/** Rows per pull query; equals SyncEngine's PULL_PAGE_FULL_THRESHOLD so a full page triggers its next-page loop. */
const PULL_PAGE = 1000;
/** Safety cap on the equal-`updated_at` run drain (x PULL_PAGE rows). */
const PULL_TIE_MAX_PAGES = 100;

export interface TsSdkConfig {
    baseUrl: string;
    apiKey: string;
    tenantId: string;
    orgId: string;
    /**
     * The Lore workspaces this instance serves (its own workspace registry), checked on every
     * operation. Required: there is no wildcard and no default (review A1 #10).
     */
    workspaceRegistry: LoreWorkspaceRegistry;
    /**
     * Lore workspace this adapter instance syncs (review A1 #1). Every cloud row is keyed
     * and filtered by (org_id, lore_workspace, lore_id); an adapter with no workspace
     * bound FAILS CLOSED on push / pushDeletes / pull rather than touching another
     * workspace's rows. A provider is read on every operation. Use `forWorkspace()`.
     */
    loreWorkspace?: string | (() => string);
    /** Connector named on every Dataplane call (`DATAPLANE_CONNECTION`); unset = the engine's per-route default (review C #1). */
    connection?: string;
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
     * Workspace-bound view of this adapter (review A1 #1). Sync engines are per Lore
     * workspace; each must push/pull/delete only inside its own (org, workspace). The view
     * shares credentials but owns its own client and per-id serialization (rows of
     * different workspaces never contend).
     */
    forWorkspace(loreWorkspace: string | (() => string)): TsSdkAdapter {
        return new TsSdkAdapter({ ...this.config, loreWorkspace });
    }

    /** Resolve the scope for THIS operation; throws DataplaneScopeError when unbound or '*'. */
    private scope(): DataplaneScope {
        const bound = this.config.loreWorkspace;
        const provider = typeof bound === 'function' ? bound : bound !== undefined ? () => bound : undefined;
        const scope = resolveDataplaneScope({
            orgId: this.config.orgId,
            dataplaneWorkspaceId: this.config.tenantId,
            workspaceRegistry: this.config.workspaceRegistry,
            loreWorkspaceProvider: () => {
                if (!provider) throw new Error('TsSdkAdapter is not bound to a Lore workspace (use forWorkspace)');
                return provider();
            },
        });
        if (scopeWorkspaceName(scope) === '*') {
            throw new DataplaneScopeError('cloud_scope_missing_workspace', "sync needs a concrete Lore workspace, not '*'");
        }
        return scope;
    }

    /** Tenant-first view over the raw collection-first SDK client (what scopedUpsert expects). */
    private sdk() {
        return asLoreDataplaneSdk(this.client as unknown as CollectionFirstSdk);
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
        // `PUT /v1/:tenant/:collection/update-by-query` with the engine
        // tagged filter (`id eq "<id>"`) and `fields: {...}`. The
        // SDK exposes this as `updateByQuery(tenant, coll, filter, fields)`.
        //
        // Upsert order: try update first; if 0 rows matched, fall through
        // to `insert`. This mirrors the TS-SDK's original intent and is
        // idempotent on re-runs (second call to the same id finds the row
        // and updates it).
        const scope = this.scope(); // fail closed BEFORE any I/O
        const sdk = this.sdk();
        for (const node of nodes) {
            try {
                // Identity + scope columns (row key, lore_id, lore_workspace, org_id) are added
                // by scopedUpsert; the raw node id never becomes a physical key.
                const fields = {
                    type: node.type,
                    label: node.label,
                    content: node.content,
                    tags: node.tags ?? [],
                    project: node.project,
                    ecosystem: node.ecosystem,
                    created_at: node.createdAt,
                    updated_at: node.updatedAt,
                    sync_id: `${node.id}-${node.updatedAt}`,
                };

                // SP-18 — serialize the check-then-act per id so concurrent
                // pushes for the same node can't both insert (TOCTOU duplicate).
                await this.serializeById(`lore_node:${node.id}`, async () => {
                    await scopedUpsert(sdk, scope, 'lore_node', node.id, fields, this.config.connection);
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
                    // Vertex refs are ROW KEYS (D2), never raw ids — a raw id could name another
                    // workspace's vertex.
                    fromId: `lore_node/${dataplaneRowKey(scope, edge.sourceId)}`,
                    toId: `lore_node/${dataplaneRowKey(scope, edge.targetId)}`,
                    edgeCollection: 'lore_edge',
                    properties: { relation: edge.relation, org_id: scope.orgId, lore_workspace: scope.loreWorkspace },
                    ...(this.config.connection ? { connection: this.config.connection } : {}),
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
     * engine tagged filter (`id eq`, the same shape push() uses
     * for updateByQuery). Per-id serialization mirrors push() so a delete
     * can't race a concurrent upsert of the same id. Idempotent — deleting
     * an already-absent id reports 0 rows, not an error.
     */
    async pushDeletes(ids: string[]): Promise<SyncResult> {
        this.ensureConnected();
        const scope = this.scope(); // fail closed BEFORE any I/O
        let nodesPushed = 0;
        const errors: string[] = [];
        for (const id of ids) {
            try {
                await this.serializeById(`lore_node:${id}`, async () => {
                    // org + lore_workspace + lore_id — never the bare id (review A1 #1).
                    const filter = buildDataplaneScopeFilter(scope, { loreId: id }, 'crud', 0).server as object;
                    await this.client!.deleteByQuery('lore_node', filter, this.config.connection);
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
            // Cloud parity A1 (F1) — the engine's filter is a tagged tree; the builder emits it.
            // Review A1 #1: scoped to (org, Lore workspace), re-checked client-side so a
            // connector that ignores the filter cannot hand back another workspace's rows.
            const scope = this.scope();
            const rawNodes = await this.pullOrdered(scope, since);
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
     * Cloud parity B (sync fix; review B #8). SyncEngine pages by advancing `since` to the max
     * `updatedAt` of the page and treats `since` as exclusive, so the adapter must (1) return rows
     * oldest-first in a stable order, otherwise a limited page is an arbitrary slice and the cursor
     * jumps past rows never delivered, and (2) never cut a run of equal `updated_at` values in half,
     * since `updated_at > since` would drop the remainder for good. On a full page we therefore keep
     * reading the rest of the run at the last timestamp, keyset-paged on `lore_id`.
     *
     * "Full page" is decided from the RAW record count the engine returned, before the client-side
     * scope filter: a connector that ignores the filter (SQLite, sqlite.rs:186-245) hands back other
     * workspaces' rows, and judging fullness after dropping them would call a truncated page "short".
     * Ordering is enforced client-side too (sorted again after the scope filter), since SQLite has no
     * ORDER BY. LIMIT OF THIS DESIGN: a connector that ignores filter/sort/offset can only be read
     * completely while the whole collection fits in one raw page (<= PULL_PAGE rows, all tenants).
     * Once the raw page is full and the connector visibly ignored the filter or sort, the remainder
     * is unreachable (no OFFSET, no working keyset), so we throw rather than let SyncEngine treat a
     * truncated page as the last one and lose rows silently. Dataplane ask: SQLite must honour
     * filter + sort + offset. A keyset fallback was not added: it needs a working `gt` filter,
     * which is exactly what such a connector lacks.
     */
    private async pullOrdered(scope: DataplaneScope, since: string): Promise<Array<Record<string, unknown>>> {
        const sort: Array<{ field: string; direction: 'asc' | 'desc' }> = [{ field: 'updated_at', direction: 'asc' }, { field: 'lore_id', direction: 'asc' }];
        const order = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
            const ta = String(a['updated_at'] ?? '');
            const tb = String(b['updated_at'] ?? '');
            if (ta !== tb) return ta < tb ? -1 : 1;
            const ia = String(a['lore_id'] ?? a['id'] ?? '');
            const ib = String(b['lore_id'] ?? b['id'] ?? '');
            return ia < ib ? -1 : ia > ib ? 1 : 0;
        };
        const fetchPage = async (
            extra: Array<{ field: string; op: 'gt' | 'eq'; value: string }>,
            what: string,
        ): Promise<{ rows: Array<Record<string, unknown>>; full: boolean }> => {
            const built = buildDataplaneScopeFilter(scope, { extra }, 'crud', 0);
            const res = await this.client!.query('lore_node', { filter: built.server as object, sort, limit: PULL_PAGE }, this.config.connection);
            const raw = (res.records || []) as Array<Record<string, unknown>>;
            const full = raw.length >= PULL_PAGE;
            const rows = keepInScope(raw, built.clientPredicate, what).map((r) => unscopeRow(r)).sort(order);
            if (full) {
                // A connector that honoured filter and sort returns exactly the rows in scope, in order.
                const honoured = rows.length === raw.length && raw.every((r, i) => i === 0 || order(raw[i - 1]!, r) <= 0);
                if (!honoured) {
                    throw new Error(
                        `${what}: the connector returned a full page of ${PULL_PAGE} rows but ignored the scope filter or sort ` +
                        `(e.g. SQLite); the rest of the collection cannot be paged, refusing to sync a truncated page`,
                    );
                }
            }
            return { rows, full };
        };
        const first = await fetchPage([{ field: 'updated_at', op: 'gt', value: since }], 'tsSdkAdapter.pull');
        const rows = first.rows;
        if (!first.full) return rows;
        const tieTs = String(rows[rows.length - 1]!['updated_at'] ?? '');
        if (!tieTs) return rows;
        let lastId = String(rows[rows.length - 1]!['lore_id'] ?? rows[rows.length - 1]!['id'] ?? '');
        for (let i = 0; i < PULL_TIE_MAX_PAGES; i++) {
            const more = await fetchPage(
                [{ field: 'updated_at', op: 'eq', value: tieTs }, { field: 'lore_id', op: 'gt', value: lastId }],
                'tsSdkAdapter.pull(tie)',
            );
            rows.push(...more.rows);
            if (!more.full) return rows;
            lastId = String(more.rows[more.rows.length - 1]!['lore_id'] ?? more.rows[more.rows.length - 1]!['id'] ?? '');
        }
        throw new Error(`more than ${PULL_TIE_MAX_PAGES * PULL_PAGE} rows share updated_at ${tieTs}; refusing to truncate the run`);
    }

    private ensureConnected(): void {
        if (!this.connected || !this.client) {
            throw new Error('Not connected to TS SDK Client');
        }
    }
}
