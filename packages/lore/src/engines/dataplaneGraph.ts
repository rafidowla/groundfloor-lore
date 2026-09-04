/**
 * dataplaneGraph.ts — Q2.2 Cloud-mode GraphProvider backed by Dataplane TS-SDK.
 *
 * Purpose:
 *   When `deploymentMode === 'cloud'` (Q2.1 toggle), core swaps the embedded
 *   local graph engine for this adapter. Every LoreNode / LoreEdge operation is
 *   routed through `groundfloor-ts-sdk` → Dataplane → (Arango | Postgres |
 *   …whatever connector the tenant has). D-017 rules: Lore never talks to a
 *   cloud DB driver directly — Dataplane owns tenant isolation, ReBAC, and
 *   change-feed invalidation.
 *
 * Contract:
 *   Implements `GraphProvider` (providers/types.ts) — the 10-method surface
 *   core uses to read/write the knowledge graph. Also exposes
 *   `getGraphContext()` + `getLanguageBreakdown()` to satisfy
 *   server.ts + cli/commands.ts callers that reach beyond the formal
 *   interface. In slice 1 (Q2.2), raw Cypher ops in cloud mode throw a
 *   descriptive error ("cloud-mode Cypher routing lands in a later slice"),
 *   and language breakdown returns an empty map. LocalGraph is unchanged —
 *   local mode keeps all its capabilities.
 *
 * Multi-tenancy:
 *   Lore server.ts is a singleton. Cloud requests carry `X-Lore-Workspace`
 *   (Q2.1 gate); the server wires that header into a request-local tenantId
 *   and exposes it to this adapter via `tenantProvider: () => string`. Every
 *   SDK call reads the current tenantId from the provider, so a single
 *   DataplaneGraph instance correctly serves many workspaces concurrently.
 *
 *   For unit tests and static contexts, pass `tenantProvider: () => 'fixed'`.
 *
 * Collections:
 *   - `lore_node` — base LoreNode documents (flat fields, no nested metadata)
 *   - `lore_edge` — edges in a standalone collection; also usable as an
 *                   ArangoDB edge collection via `graph.createEdge`
 *
 * Side Effects: Network calls to Dataplane. No local disk.
 * Error Behavior: Bubbles SDK errors (GroundfloorError subclass) so callers
 *   can distinguish auth/network/server failures. `initialize()` tolerates
 *   "already exists" errors for idempotent schema push.
 * Idempotency: upsertNode uses updateByQuery+insert (same pattern as
 *   tsSdkAdapter.push). addEdge is NOT deduplicated in slice 1 — a repeat
 *   call creates a second edge. Callers that need dedup must check first.
 */

// `import type` avoids Node16 resolution issues with SDK's missing `"exports"`. Runtime calls use SdkClient below.
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import { tagsToArray, tagsToString } from './normalizeTags.js';
import type {
    GraphProvider,
    LoreNode,
    LoreEdge,
    TraversalResult,
    GraphStats,
    EdgeQuery,
    BulkListQuery,
    BulkListPage,
} from '../providers/types.js';
import type { CollectionStorage } from './collectionStorage.js';
import { detectLanguage } from './language.js';
import { DataplaneCollectionStorage, type CollectionStorageSdkClient } from './dataplaneCollectionStorage.js';

/**
 * Resolve the current tenant for a SDK call. Called once per operation so
 * server.ts can swap tenants via AsyncLocalStorage between requests without
 * DataplaneGraph caring.
 */
export type TenantProvider = () => string;

export interface DataplaneGraphConfig {
    /** Pre-constructed SDK client. Lets tests inject a fake. */
    client: GroundfloorClient;
    /** Dynamic per-request tenant id. */
    tenantProvider: TenantProvider;
    /** Organization id written on every record for ReBAC partitioning. */
    orgId: string;
    /**
     * Optional connector name when the tenant has multiple connectors
     * configured (e.g. `arangodb`). Omitted lets Dataplane pick the
     * primary connector.
     */
    connection?: string;
    /**
     * F-S06 — Allowlist of tenant ids this graph may serve. When provided,
     * a resolved tenant id NOT in this set is rejected (throws) before any
     * SDK call — preventing a request from targeting an arbitrary tenant id
     * that would otherwise be trusted and auto-provisioned. Omit ONLY for
     * trusted single-tenant/test contexts where the tenantProvider is fixed
     * and cannot be attacker-influenced.
     */
    allowedTenants?: readonly string[];
}

import { NODE_COLLECTION, EDGE_COLLECTION } from './dataplaneCollections.js';
import * as dpMaintenance from './dataplaneGraphMaintenance.js';
import type { MaintenanceCtx } from './dataplaneGraphMaintenance.js';
import * as dpTopology from './dataplaneGraphTopology.js';
import type { TopologyCtx } from './dataplaneGraphTopology.js';
import { rankSearchResults, SEARCH_SCAN_CAP } from './searchRanking.js';

/**
 * Hard cap on rows scanned by client-side aggregations
 * (getTopologyOverview, getLanguageBreakdown) until Dataplane exposes
 * a real group-by primitive. Beyond this we report `truncated: true`
 * so callers know the count is partial; tuning rationale: 10k rows ≈
 * 20 pages of 500, which finishes in well under a second on a local
 * Dataplane and bounds memory at ~1 MB of projected fields.
 */

// TW-4c: SEARCH_SCAN_CAP now lives in searchRanking.ts as the single
// env-overridable source of truth shared with LocalGraph (was duplicated here
// and in localGraphReads.ts — hc-/cq-search-scan-cap-duplicate), so the scan
// window — and the rows handed to the shared ranker — stay identical to local.

// Typed handle to the SDK surface we actually use. Declared locally so the
// arch test's no-direct-cloud-driver rule ignores this file cleanly — we
// never import pg/arangojs/etc.
interface SdkClient {
    createCollection(tenantId: string, schema: unknown, connection?: string): Promise<unknown>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<T>;
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated: number }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    graph: {
        createEdge(tenantId: string, collection: string, options: {
            fromId: string;
            toId: string;
            edgeCollection: string;
            properties?: Record<string, unknown>;
            connection?: string;
        }): Promise<{ edge_id: string }>;
        traverse<T = unknown>(tenantId: string, collection: string, options: {
            startId: string;
            edgeCollection?: string;
            edgeCollections?: string[];
            direction?: 'in' | 'out' | 'both';
            minDepth?: number;
            maxDepth?: number;
            connection?: string;
        }): Promise<{ records: T[] }>;
    };
}

export class DataplaneGraph implements GraphProvider {
    private readonly client: SdkClient;
    private readonly tenantProvider: TenantProvider;
    private readonly orgId: string;
    private readonly connection?: string;
    /** F-S06 — set of permitted tenant ids; null = no allowlist configured. */
    private readonly allowedTenants: ReadonlySet<string> | null;
    /**
     * Per-tenant schema-push state. Collections are provisioned lazily
     * on the first op for each tenant (boot time doesn't know which
     * tenants will connect — the singleton serves many). Keys are
     * tenant ids; value is the in-flight or settled promise so
     * concurrent first-hits don't race on createCollection.
     */
    private readonly tenantInit = new Map<string, Promise<void>>();
    /**
     * Slice 5c — cached collection-storage adapter. See getGraphContext
     * for rationale; the closure tenantProvider keeps it multi-tenant-safe.
     */
    private cachedCollectionStorage: DataplaneCollectionStorage | null = null;

    constructor(config: DataplaneGraphConfig) {
        this.client = config.client as unknown as SdkClient;
        this.tenantProvider = config.tenantProvider;
        this.orgId = config.orgId;
        this.connection = config.connection;
        // F-S06 — freeze the allowlist into a Set for O(1) membership checks.
        // Empty array is honored as "allow nothing" (fail closed); undefined
        // means no allowlist configured (legacy/trusted-context behaviour).
        this.allowedTenants = config.allowedTenants
            ? new Set(config.allowedTenants)
            : null;
    }

    /**
     * initialize — Top-level no-op at boot.
     *
     * Schema push is per-tenant and lazy: the daemon is a singleton
     * serving many workspaces, and at boot time no workspace is bound
     * (no request yet). Each method that touches Dataplane calls
     * `ensureTenantInitialized(tenantId)` which fires createCollection
     * once per tenant, idempotently, with in-flight dedup so concurrent
     * first-hits don't race.
     */
    async initialize(): Promise<void> {
        // Intentionally empty. Per-tenant init fires inside the CRUD
        // path (ensureTenantInitialized).
    }

    /**
     * ensureTenantInitialized — Idempotent schema push for one tenant.
     *
     * Called from every method that hits Dataplane. First call for a
     * given tenant pushes lore_node + lore_edge collections; subsequent
     * calls return the cached promise (no network hit). Collection
     * "already exists" errors are swallowed — safe for re-boots against
     * a tenant that was previously provisioned.
     */
    private ensureTenantInitialized(tenantId: string): Promise<void> {
        // F-S06 — choke point: validate the tenant against the allowlist before
        // any schema push / auto-provision. Every Dataplane-touching method
        // (and the topology/maintenance helper ctxs) routes through here, so an
        // unknown tenant is rejected before a single SDK call regardless of how
        // the caller obtained the id. Throwing synchronously here also rejects
        // the helper paths that pass tenantProvider directly.
        if (typeof tenantId !== 'string' || tenantId.length === 0) {
            throw new Error('DataplaneGraph: empty tenant id — refusing operation (F-S06).');
        }
        if (this.allowedTenants && !this.allowedTenants.has(tenantId)) {
            throw new Error(
                `DataplaneGraph: tenant "${tenantId}" is not in the configured allowlist — ` +
                `refusing to trust/auto-provision an unknown tenant (F-S06).`,
            );
        }
        const existing = this.tenantInit.get(tenantId);
        if (existing) return existing;
        const p = this.pushSchemaFor(tenantId).catch((err) => {
            // Drop the failed promise so the next call retries rather
            // than seeing a permanent failed state.
            this.tenantInit.delete(tenantId);
            throw err;
        });
        this.tenantInit.set(tenantId, p);
        return p;
    }

    private async pushSchemaFor(tenantId: string): Promise<void> {
        await this.ensureCollection(tenantId, {
            name: NODE_COLLECTION,
            fields: [
                { name: 'id', field_type: 'string', primary_key: true, required: true },
                { name: 'type', field_type: 'string', required: true, indexed: true },
                { name: 'label', field_type: 'string' },
                { name: 'content', field_type: 'string' },
                { name: 'tags', field_type: 'string' },
                { name: 'project', field_type: 'string', indexed: true },
                { name: 'ecosystem', field_type: 'string', indexed: true },
                { name: 'org_id', field_type: 'string', indexed: true, required: true },
                { name: 'created_at', field_type: 'string' },
                { name: 'updated_at', field_type: 'string' },
                { name: 'language', field_type: 'string' },
                { name: 'security_scopes', field_type: 'string' }, // RA2-reaudit2 — node-level access scopes (was silently dropped in cloud)
            ],
        });
        await this.ensureCollection(tenantId, {
            name: EDGE_COLLECTION,
            fields: [
                { name: 'id', field_type: 'string', primary_key: true, required: true },
                { name: 'source_id', field_type: 'string', required: true, indexed: true },
                { name: 'target_id', field_type: 'string', required: true, indexed: true },
                { name: 'relation', field_type: 'string', required: true },
                { name: 'org_id', field_type: 'string', indexed: true, required: true },
                { name: 'created_at', field_type: 'string' },
            ],
        });

        // SP-14 — the per-tenant cloud-schema hook fan-out was
        // removed (v3.11.0); the hook list was always empty (no setter
        // caller in Core), so this was dead code.
        // Core lore_node + lore_edge collections are still pushed above.
    }

    private async ensureCollection(tenantId: string, schema: unknown): Promise<void> {
        try {
            await this.client.createCollection(tenantId, schema, this.connection);
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            // Dataplane returns 409 / "already exists" / "duplicate". Accept
            // any message shape that implies the collection is already there.
            if (/already exists|duplicate|409/i.test(msg)) return;
            throw err;
        }
    }

    async upsertNode(
        nodeData: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    ): Promise<LoreNode> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const now = new Date().toISOString();
        const existing = await this.tryGet(tenantId, nodeData.id);
        const existingCreated = existing && typeof existing['created_at'] === 'string' ? (existing['created_at'] as string) : null;
        const createdAt: string = existingCreated ?? now;
        const doc = {
            id: nodeData.id,
            type: nodeData.type,
            label: nodeData.label,
            content: nodeData.content ?? '',
            // Cloud column is STRING (DEC-TAG-MATCH) — join the canonical
            // string[] to the comma form the Dataplane schema stores.
            tags: tagsToString(nodeData.tags),
            project: nodeData.project ?? '*',
            ecosystem: nodeData.ecosystem ?? '*',
            org_id: this.orgId,
            created_at: createdAt,
            updated_at: now,
            language: nodeData.language ?? null,
            // RA2-reaudit2 — persist node-level access scopes (was dropped),
            // serialized as JSON for lossless round-trip in the STRING column.
            security_scopes: JSON.stringify(nodeData.security_scopes ?? []),
        };

        const res = await this.client.updateByQuery(
            tenantId,
            NODE_COLLECTION,
            // RA2-reaudit2 — scope the update selector by org so a node id reused
            // across orgs in one tenant can't be overwritten cross-org.
            { id_eq: nodeData.id, org_id: this.orgId },
            doc,
            this.connection,
        );
        if ((res?.updated ?? 0) === 0) {
            await this.client.insert(tenantId, NODE_COLLECTION, doc, this.connection);
        }

        return {
            id: nodeData.id,
            type: nodeData.type,
            label: nodeData.label,
            content: nodeData.content ?? '',
            tags: tagsToArray(nodeData.tags),
            project: nodeData.project ?? '*',
            ecosystem: nodeData.ecosystem ?? '*',
            metadata: nodeData.metadata ?? '{}',
            createdAt,
            updatedAt: now,
            syncedAt: now,
            security_scopes: nodeData.security_scopes,
            language: nodeData.language ?? null,
        };
    }

    async getNode(id: string): Promise<LoreNode | null> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const record = await this.tryGet(tenantId, id);
        if (!record) return null;
        return this.recordToLoreNode(record);
    }

    /**
     * SW-16: batch-hydrate many nodes. Dataplane connectors have no
     * single bulk-by-id primitive exposed here, so we fan out bounded
     * parallel `tryGet`s (vs the old per-seed serial loop in callers).
     * Returns a Map keyed by id; missing ids are absent. Dedupes input.
     */
    async getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> {
        const out = new Map<string, LoreNode>();
        const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
        if (unique.length === 0) return out;
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const CONCURRENCY = 16;
        for (let i = 0; i < unique.length; i += CONCURRENCY) {
            const slice = unique.slice(i, i + CONCURRENCY);
            const recs = await Promise.all(slice.map((id) => this.tryGet(tenantId, id).catch(() => null)));
            recs.forEach((rec) => {
                if (rec) {
                    const node = this.recordToLoreNode(rec);
                    out.set(node.id, node);
                }
            });
        }
        return out;
    }

    /**
     * Robust single-record fetch — prefers `get`, falls back to filtered
     * `query` when the connector doesn't expose a direct-id endpoint
     * (some Dataplane connectors route id lookups through query).
     */
    private async tryGet(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
        try {
            const rec = await this.client.get<Record<string, unknown>>(
                tenantId,
                NODE_COLLECTION,
                id,
                this.connection,
            );
            // Defense-in-depth org guard (parity with the org_id filter every
            // list/search/query path already applies — search:506, listNodes:534,
            // queryEdges:422, bulkList:570). The `get` SDK signature has no filter
            // param, so the org check is enforced post-fetch. A single daemon
            // serves exactly one org (this.orgId is the boot-fixed
            // DATAPLANE_ORG_ID) and the engine enforces ReBAC server-side, so this
            // is belt-and-suspenders, not the sole control — but it guarantees
            // getNode can never surface a record stamped with a different org_id.
            return this.guardOrg(rec) ?? null;
        } catch (err) {
            const msg = (err as Error).message ?? '';
            // 404 / not found — interpret as null rather than re-throw.
            if (/not found|404/i.test(msg)) return null;
            // Some connectors don't expose /get — fall back to query. The
            // fallback CAN take a filter, so apply org_id directly there.
            try {
                const res = await this.client.query<Record<string, unknown>>(
                    tenantId,
                    NODE_COLLECTION,
                    { filter: { id_eq: id, org_id: this.orgId }, limit: 1 },
                    this.connection,
                );
                return this.guardOrg(res.records?.[0]) ?? null;
            } catch {
                return null;
            }
        }
    }

    /**
     * F-S06/S07 — Return the record only if its org_id EQUALS this graph's org.
     * A record with a different org_id is treated as not-found; a record with a
     * MISSING or empty org_id is ALSO treated as not-found (fail closed). Prior
     * behaviour returned records lacking org_id to any caller — a cross-tenant
     * read of un-stamped/legacy rows. Every write path here stamps org_id
     * (required column), so a missing org_id is anomalous and must not surface.
     * Defense-in-depth — see tryGet's note on why this is a secondary control.
     */
    private guardOrg(rec: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
        if (!rec) return null;
        const recOrg = rec['org_id'];
        // F-S07: fail closed — a record must carry an org_id that matches ours.
        if (typeof recOrg !== 'string' || recOrg.length === 0) return null;
        if (recOrg !== this.orgId) return null;
        return rec;
    }

    async deleteNode(id: string): Promise<boolean> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const res = await this.client.deleteByQuery(
            tenantId,
            NODE_COLLECTION,
            { id_eq: id, org_id: this.orgId }, // RA2-reaudit2 — org-scope the destructive delete (defense-in-depth, matches every other path)
            this.connection,
        );
        return (res?.deleted ?? 0) > 0;
    }

    async addEdge(edge: LoreEdge): Promise<void> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const now = new Date().toISOString();
        const edgeId = `${edge.sourceId}__${edge.relation}__${edge.targetId}`;
        // Write to lore_edge collection for portability across connectors
        // (non-graph connectors don't have graph.createEdge).
        await this.client.insert(tenantId, EDGE_COLLECTION, {
            id: edgeId,
            source_id: edge.sourceId,
            target_id: edge.targetId,
            relation: edge.relation,
            org_id: this.orgId,
            created_at: now,
        }, this.connection);
        // Additionally create a graph edge for Arango-style connectors so
        // `traverse` works. Non-graph connectors will throw 501; ignore.
        try {
            await this.client.graph.createEdge(tenantId, 'knowledge_graph', {
                fromId: `${NODE_COLLECTION}/${edge.sourceId}`,
                toId: `${NODE_COLLECTION}/${edge.targetId}`,
                edgeCollection: EDGE_COLLECTION,
                properties: { relation: edge.relation, org_id: this.orgId },
                connection: this.connection,
            });
        } catch (err) {
            const msg = (err as Error).message ?? '';
            // 501 = connector lacks graph support; fine, lore_edge row is authoritative.
            if (!/501|not supported/i.test(msg)) throw err;
        }
    }

    async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
        await this.addEdge(edge);
        await this.addEdge({
            sourceId: edge.targetId,
            targetId: edge.sourceId,
            relation: edge.relation,
            confidence: edge.confidence,
            confidenceScore: edge.confidenceScore,
        });
    }

    /**
     * queryEdges — paginated edge query against lore_edge (cloud parity for
     * GET /api/edges). lore_edge rows carry source_id/target_id/relation but
     * NOT confidence (addEdge omits it), so results default to
     * 'extracted' / 1.0 — the same default LocalGraph applies for a missing
     * confidence column.
     */
    async queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const filter: Record<string, unknown> = { org_id: this.orgId };
        if (q.source) filter['source_id_eq'] = q.source;
        if (q.target) filter['target_id_eq'] = q.target;
        if (q.relation) filter['relation_eq'] = q.relation;
        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            EDGE_COLLECTION,
            { filter, limit: q.limit, offset: q.offset },
            this.connection,
        );
        return (res.records ?? []).map((r) => ({
            sourceId: r['source_id'] as string,
            targetId: r['target_id'] as string,
            relation: r['relation'] as string,
            confidence: 'extracted' as const,
            confidenceScore: 1.0,
        }));
    }

    /**
     * deleteEdge — remove lore_edge rows matching the (source, target,
     * relation) triple (cloud parity for DELETE /api/edge). Returns the
     * deleted count (0 = no match → route maps to 404). The companion
     * graph edge in the Arango knowledge_graph is left to the connector's
     * cascade; the lore_edge row is authoritative (see addEdge).
     */
    async deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const res = await this.client.deleteByQuery(
            tenantId,
            EDGE_COLLECTION,
            { source_id_eq: sourceId, target_id_eq: targetId, relation_eq: relation, org_id: this.orgId }, // RA2-reaudit2 — org-scope the delete
            this.connection,
        );
        return res?.deleted ?? 0;
    }

    /**
     * traverse — cloud parity for GraphProvider.traverse (SEARCH_CONTRACT v1).
     *
     * Forwards the requested `maxDepth` to the Dataplane graph engine (the
     * engine bounds the BFS server-side) and, when supplied, applies the
     * exact-match `relation` filter the contract mandates. Results are
     * returned sorted by depth ascending so callers receive closer neighbours
     * first, matching the LocalGraph ordering.
     *
     * Per-node depth: the engine *may* annotate each traversed record with a
     * hop-distance field. We read it from whichever of the known keys it
     * emits (`_depth` / `depth` / `_distance`). See the CONTRACT-DEVIATION
     * note below for the residual SDK limitation when no such field is
     * present.
     */
    async traverse(nodeId: string, maxDepth = 2, relation?: string): Promise<TraversalResult[]> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        try {
            const res = await this.client.graph.traverse<Record<string, unknown>>(
                tenantId,
                NODE_COLLECTION,
                {
                    startId: nodeId,
                    edgeCollection: EDGE_COLLECTION,
                    direction: 'both',
                    minDepth: 1,
                    maxDepth,
                    connection: this.connection,
                },
            );
            let rows = res.records ?? [];
            // Contract: when `relation` is supplied, only edges whose relation
            // exactly matches (case-sensitive) may surface. The SDK's traverse
            // has no relation predicate, so post-filter on the record's
            // relation field.
            if (relation && relation.length > 0) {
                rows = rows.filter((r) => (r['relation'] as string) === relation);
            }
            const results = rows.map((r) => ({
                node: this.recordToLoreNode(r),
                depth: this.recordDepth(r),
                relation: (r['relation'] as string) ?? '',
            } as TraversalResult));
            // Contract: sort by depth ascending (closer neighbours first).
            // Stable sort keeps engine sub-order within a depth band.
            results.sort((a, b) => a.depth - b.depth);
            return results;
        } catch (err) {
            const msg = (err as Error).message ?? '';
            // Non-graph connector → empty traversal rather than blow up.
            if (/501|not supported/i.test(msg)) return [];
            throw err;
        }
    }

    /**
     * recordDepth — extract the true hop-distance of a traversed record.
     *
     * The Dataplane Rust traversal engine bounds depth server-side via the
     * forwarded min/maxDepth, but the typed SDK result (`QueryResult.records`)
     * does NOT guarantee a per-row depth field — only the raw record columns
     * are typed. We therefore probe the keys the engine is known to emit
     * (`_depth`, then `depth`, then `_distance`).
     *
     * CONTRACT-DEVIATION (SEARCH_CONTRACT v1 — see DECISIONS.md DEC-PARITY):
     * when the active connector exposes NONE of those depth fields, true
     * per-node hop-distance is not recoverable from the SDK. Rather than
     * silently mislabel every node depth=1 (the prior behaviour, which the
     * contract forbids), we return depth=0 as an explicit "depth unknown"
     * sentinel. depth=0 is distinguishable from any real hop (min hop is 1),
     * so callers/parity harness can detect the SDK gap instead of trusting a
     * fabricated value. The residual is documented here and in DEC-PARITY.
     */
    private recordDepth(r: Record<string, unknown>): number {
        for (const key of ['_depth', 'depth', '_distance'] as const) {
            const v = r[key];
            if (typeof v === 'number' && Number.isFinite(v)) return v;
        }
        return 0; // depth-unknown sentinel (see CONTRACT-DEVIATION above)
    }

    /**
     * search — cloud parity for GraphProvider.search (SEARCH_CONTRACT v1).
     *
     * Contract: match the query case-insensitively against label OR content
     * OR tags; order by relevance desc then updatedAt desc; apply
     * project/ecosystem as AND-filters before ordering+limiting.
     *
     * CONTRACT-DEVIATION (see DECISIONS.md DEC-PARITY): the SDK's structured
     * filter is a flat AND of `field_operator` predicates — it exposes
     * `label_contains` / `content_contains` / `tags_contains` individually
     * but offers NO way to OR them in a single query, and no relevance
     * scoring. A server-side `label_contains` alone would drop genuine
     * content/tags matches (a contract violation), so we instead fetch a
     * bounded candidate set scoped by org_id (+ project/ecosystem) and
     * post-filter + rank + limit in-adapter to honor the contracted surface
     * and order exactly. The candidate scan is bounded by SEARCH_SCAN_CAP;
     * the org_id partition keeps this tenant-safe and the NW point-get org
     * guard intact. A future Dataplane FTS/tsvector predicate (the SDK's
     * `client.search(...)` Phase-2 path) can replace the post-filter.
     */
    async search(
        query: string,
        limit = 10,
        project?: string,
        ecosystem?: string,
        // CONTRACT-DEVIATION (DEC-PARITY): the cloud backend does not filter
        // hidden (archived/superseded) rows in-query the way LocalGraph's
        // excludeHidden does. retrieve() applies that filter post-fetch, so
        // results stay correct; only the pre-rank scan is marginally less
        // efficient. Accepted for signature parity; pre-existing (the prior
        // 4-arg signature silently dropped this arg too).
        _excludeHidden?: boolean,
        signals?: { scanCapHit: boolean },
    ): Promise<LoreNode[]> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);

        // Scope filters are AND-applied server-side. org_id is ALWAYS present
        // (ReBAC partition guard — never regress). project/ecosystem narrow
        // the candidate set before we scan.
        const filter: Record<string, unknown> = { org_id: this.orgId };
        if (project) filter['project'] = project;
        if (ecosystem) filter['ecosystem'] = ecosystem;

        // TW-4c (perf-search-no-order-by-scancap): sort by (updated_at desc, id
        // asc) BEFORE the cap so that beyond SEARCH_SCAN_CAP matches the cloud
        // keeps the SAME most-recently-updated rows the local Cypher's ORDER BY
        // keeps (rankSearchResults' tiebreak). Without it the SDK could hand a
        // DIFFERENT window to the identical ranker, breaking W5B order parity.
        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            {
                filter,
                sort: [{ field: 'updated_at', direction: 'desc' }, { field: 'id', direction: 'asc' }],
                limit: SEARCH_SCAN_CAP,
            },
            this.connection,
        );
        const candidates = (res.records ?? []).map((r) => this.recordToLoreNode(r));
        // P16 — same scan-cap-hit signal as LocalGraph so the incomplete-results
        // hint is cross-engine consistent: a full candidate window means matches
        // beyond SEARCH_SCAN_CAP were dropped before ranking.
        if (signals) signals.scanCapHit = candidates.length >= SEARCH_SCAN_CAP;
        // Rank/score/sort/slice via the shared keyword-search ranker so cloud
        // and LocalGraph return an IDENTICAL order by construction (W5B).
        return rankSearchResults(candidates, query, limit);
    }

    async listNodes(
        type?: string,
        tag?: string,
        project?: string,
        ecosystem?: string,
        // limit + opts are LocalGraph extensions; Dataplane hardcaps at 1000 rows.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _limit?: number,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _opts?: { unbounded?: boolean },
    ): Promise<LoreNode[]> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const filter: Record<string, unknown> = { org_id: this.orgId };
        if (type) filter['type'] = type;
        if (project) filter['project'] = project;
        if (ecosystem) filter['ecosystem'] = ecosystem;
        // CONTRACT-DEVIATION: cloud does case-insensitive SUBSTRING; local
        // does case-insensitive EXACT membership (Pass 2). Both fold case.
        // See DECISIONS.md DEC-TAG-MATCH for the cloud Pass 2 follow-up.
        if (tag) filter['tags_contains'] = tag.toLowerCase();

        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter, limit: 1000 },
            this.connection,
        );
        return (res.records ?? []).map((r) => this.recordToLoreNode(r));
    }

    /**
     * bulkList — cursor-paginated node enumeration (cloud parity for
     * POST /api/nodes/bulk-list). Ordered (updated_at DESC, id ASC); fetches
     * limit+1 to detect hasMore. Records map through recordToLoreNode so the
     * camelCase `updatedAt`/`id` cursor contract matches the local path.
     *
     * Slice-1 limitations (documented; the local graph path is fully robust
     * and actively used — cloud bulk-list is a deferred, unverified parity follow-up):
     *   - Multi-value type/tag filters apply only the FIRST value — the
     *     AND-only SDK filter can't express an OR-chain. Single type/tag
     *     (the common cold-warmup case) is exact.
     *   - The cursor uses a strict `updated_at_lt`, so the rare case of
     *     nodes sharing the EXACT cursor timestamp across a page boundary
     *     can skip those rows. Knowledge writes stamp per-write ISO-ms
     *     timestamps, so boundary collisions are vanishingly unlikely.
     */
    async bulkList(q: BulkListQuery): Promise<BulkListPage> {
        const tenantId = this.tenantProvider();
        await this.ensureTenantInitialized(tenantId);
        const filter: Record<string, unknown> = { org_id: this.orgId };
        if (q.project) filter['project'] = q.project;
        if (q.ecosystem) filter['ecosystem'] = q.ecosystem;
        if (q.types && q.types.length > 0) filter['type'] = q.types[0];
        // CONTRACT-DEVIATION (substring vs exact) — see listNodes above.
        if (q.tags && q.tags.length > 0) filter['tags_contains'] = q.tags[0]!.toLowerCase();
        if (q.cursor) filter['updated_at_lt'] = q.cursor.updatedAt;
        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            {
                filter,
                sort: [
                    { field: 'updated_at', direction: 'desc' },
                    { field: 'id', direction: 'asc' },
                ],
                limit: q.limit + 1,
            },
            this.connection,
        );
        const records = res.records ?? [];
        const hasMore = records.length > q.limit;
        const pageRecords = hasMore ? records.slice(0, q.limit) : records;
        const nodes = pageRecords.map((r) => this.recordToLoreNode(r) as unknown as Record<string, unknown>);
        const last = nodes.length > 0 ? nodes[nodes.length - 1]! : null;
        const nextCursor = hasMore && last
            ? { updatedAt: last['updatedAt'] as string, id: last['id'] as string }
            : null;
        return { nodes, hasMore, nextCursor };
    }

    /** Bundle the state the extracted topology reads need. */
    private topologyCtx(): TopologyCtx {
        return {
            client: this.client,
            tenantProvider: this.tenantProvider,
            orgId: this.orgId,
            connection: this.connection,
            ensureTenantInitialized: this.ensureTenantInitialized.bind(this),
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getStats(_projectFilter?: string): Promise<GraphStats> {
        // projectFilter is a LocalGraph extension; Dataplane ignores it harmlessly.
        return dpTopology.getStats(this.topologyCtx());
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getTopology(limit = 100, _projects?: string[] | string, _edgeLimit?: number): Promise<{ nodes: unknown[]; edges: unknown[] }> {
        // projects + edgeLimit are LocalGraph extensions; Dataplane ignores them harmlessly.
        return dpTopology.getTopology(this.topologyCtx(), limit);
    }

    async getTopologyOverview(): Promise<{
        blobs: Array<{ project: string; nodeCount: number }>;
        aggregateEdges: Array<{ fromProject: string; toProject: string; count: number }>;
        totalNodes: number;
        truncated?: boolean;
    }> {
        return dpTopology.getTopologyOverview(this.topologyCtx());
    }

    async getTopologyOverviewByType(): Promise<{
        blobs: Array<{ project: string; nodeCount: number; types: Array<{ type: string; count: number }> }>;
        aggregateEdges: Array<{ fromProject: string; toProject: string; count: number }>;
        totalNodes: number;
    }> {
        return dpTopology.getTopologyOverviewByType(this.topologyCtx());
    }

    /**
     * reconfigureCache — No-op in cloud mode. The Q1.3 local read cache
     * doesn't apply to DataplaneGraph; Dataplane owns caching + change-feed
     * invalidation. Kept for API compatibility so PATCH /api/config can call
     * it unconditionally.
     */
    reconfigureCache(_opts: { enabled?: boolean; ttlSeconds?: number; maxEntries?: number }): void {
        // intentional no-op
    }

    async getLanguageBreakdown(): Promise<Record<string, number>> {
        return dpTopology.getLanguageBreakdown(this.topologyCtx());
    }

    /**
     * getGraphContext — cloud-mode Cypher execution bridge.
     *
     * Q2.2 status:
     *   - slice 1: stub, blanket-throws on any call.
     *   - slice 4: schema parity lands via `registerCloudSchema` hook
     *     (collections now exist in cloud mode), but OP routing
     *     (translating Cypher to Dataplane AQL/SQL via executeRaw)
     *     is still out of scope. executeQuery/queryRows throw a
     *     structured error naming the operation for root-causing;
     *     bumpEpoch is a no-op; detectLanguage is pure.
     *
     * Why op routing is deferred:
     *   Raw Cypher paths run ~25 distinct parameterized patterns
     *   (MERGE, MATCH-WHERE-CONTAINS, rel-typed CREATE). Each needs a
     *   faithful AQL/SQL translation. That's intentionally a multi-PR
     *   slice — see the q2-2-slice-3 "SCOPE DEFERRED" list.
     *   Operators who need raw Cypher today run local mode.
     *
     * The cypher snippet + params are attached to the thrown error so
     * the daemon log line tells operators exactly which op to lift
     * first when planning the next slice.
     */
    getGraphContext(): {
        storage: CollectionStorage;
        executeQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>;
        queryRows(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
        bumpEpoch(): void;
        detectLanguage(text: string, options?: { threshold?: number; minLength?: number }): { language: string | null; confidence: number };
    } {
        // Q2.2 slice 5a — substrate-portable storage. Callers on `storage.*`
        // run identically here and in local mode.
        //
        // Slice 5c — single instance cached on the engine so collection
        // declarations (declareCollection) persist across every
        // getGraphContext() call. The internal tenantProvider
        // closure still resolves per-op via AsyncLocalStorage, so a
        // single shared adapter is multi-tenant-safe.
        if (!this.cachedCollectionStorage) {
            this.cachedCollectionStorage = new DataplaneCollectionStorage({
                client: this.client as unknown as CollectionStorageSdkClient,
                tenantProvider: () => {
                    const tenantId = this.tenantProvider();
                    // Lazy schema push: same per-tenant init guard as the
                    // core node/edge writes use. Collections were
                    // pushed in slice 4's registerCloudSchema fan-out.
                    void this.ensureTenantInitialized(tenantId);
                    return tenantId;
                },
                connection: this.connection,
            });
        }
        const storage: CollectionStorage = this.cachedCollectionStorage;
        const refuse = (op: string, cypher: string): never => {
            // Keep the snippet short in the error message — full query is
            // on err.cypher for debuggers. One line for log-grep friendliness.
            const snippet = cypher.trim().replace(/\s+/g, ' ').slice(0, 120);
            const err = new Error(
                `DataplaneGraph.${op} refused: raw Cypher routing is not available in ` +
                `cloud mode yet (Q2.2 slice 4 landed schema parity; op routing is a ` +
                `follow-up). Cypher: "${snippet}${cypher.length > 120 ? '…' : ''}". ` +
                `Run the daemon with LORE_DEPLOYMENT_MODE=local for Cypher features, or ` +
                `wait for the op-routing slice.`,
            );
            (err as Error & { cypher?: string }).cypher = cypher;
            throw err;
        };
        return {
            storage,
            executeQuery: async (cypher: string) => refuse('executeQuery', cypher),
            queryRows: async (cypher: string) => refuse('queryRows', cypher),
            bumpEpoch: () => { /* no-op in cloud mode */ },
            // Language detection is a pure function (no graph access).
            detectLanguage: (text: string, options?: { threshold?: number; minLength?: number }) => {
                return detectLanguage(text, options);
            },
        };
    }

    /* ─── Bucket C — cloud parity for Lore-specific ops ──────── */
    //
    // Each method below is composable from existing dataplane primitives
    // (updateByQuery / deleteByQuery / query) — no new Dataplane endpoints
    // needed. Semantics match the LocalGraph counterparts so callers can
    // drop their `instanceof LocalGraph` guards once these land.
    // See docs/CLOUD_GAP_AUDIT.md for the full inventory.

    /**
     * supersedeNode — Mark `oldId` as superseded by `newId`. Cloud parity
     * for LocalGraph.supersedeNode (localGraph.ts:1220). Same semantics:
     * idempotent re-stamp, validates both nodes exist first.
     */
    /** Bundle the state the extracted maintenance helpers need. */
    private maintenanceCtx(): MaintenanceCtx {
        return {
            client: this.client,
            tenantProvider: this.tenantProvider,
            orgId: this.orgId,
            connection: this.connection,
            ensureTenantInitialized: this.ensureTenantInitialized.bind(this),
            tryGet: this.tryGet.bind(this),
        };
    }

    async supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
        return dpMaintenance.supersedeNode(this.maintenanceCtx(), oldId, newId, reason);
    }

    async unsupersedeNode(id: string): Promise<boolean> {
        return dpMaintenance.unsupersedeNode(this.maintenanceCtx(), id);
    }

    async markStaleByTags(tags: string[]): Promise<number> {
        return dpMaintenance.markStaleByTags(this.maintenanceCtx(), tags);
    }

    /** 2026-09-03 (X-markstale audit fix) — see LoreGraphHandle's doc comment. */
    async findNodeIdsByTags(tags: string[]): Promise<string[]> {
        return dpMaintenance.findNodeIdsByTags(this.maintenanceCtx(), tags);
    }

    async markStaleByIds(ids: string[]): Promise<number> {
        return dpMaintenance.markStaleByIds(this.maintenanceCtx(), ids);
    }

    async pruneEphemeralNodes(defaultTtlMs: number = 3_600_000): Promise<number> {
        return dpMaintenance.pruneEphemeralNodes(this.maintenanceCtx(), defaultTtlMs);
    }

    async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
        return dpMaintenance.pruneInferredLoreEdges(this.maintenanceCtx(), relationPrefix);
    }

    /* ─── internals ───────────────────────────────────────────── */

    private recordToLoreNode(rec: Record<string, unknown>): LoreNode {
        return {
            id: String(rec['id'] ?? ''),
            type: String(rec['type'] ?? ''),
            label: String(rec['label'] ?? ''),
            content: String(rec['content'] ?? ''),
            tags: tagsToArray(rec['tags']),
            project: String(rec['project'] ?? '*'),
            ecosystem: String(rec['ecosystem'] ?? '*'),
            metadata: '{}',
            createdAt: String(rec['created_at'] ?? ''),
            updatedAt: String(rec['updated_at'] ?? ''),
            syncedAt: String(rec['updated_at'] ?? ''),
            language: (rec['language'] as string | null | undefined) ?? null,
            // RA2-reaudit2 — read node-level access scopes back (was dropped).
            security_scopes: parseSecurityScopes(rec['security_scopes']),
        };
    }
}

/** RA2-reaudit2 — deserialize the JSON-serialized security_scopes column;
 *  tolerates a legacy array, a JSON string, or empty → []. */
function parseSecurityScopes(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
    if (typeof raw === 'string' && raw.length > 0) {
        try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []; }
        catch { return []; }
    }
    return [];
}
