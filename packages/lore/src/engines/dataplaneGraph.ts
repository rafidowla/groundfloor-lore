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
 * Scope (cloud parity A1 — see dataplaneScopeFilter.ts):
 *   The Dataplane workspace is fixed by the API credential (the engine ignores
 *   X-Tenant-Id), so many Lore workspaces share it. Every op resolves a
 *   `DataplaneScope` {orgId, loreWorkspace, dataplaneWorkspaceId} via
 *   `resolveDataplaneScope` (fails closed when no Lore workspace is bound). Rows
 *   carry `org_id` + `lore_workspace` + `lore_id`; the physical primary key `id`
 *   is a hashed row key (D2) that never leaves this adapter — every read maps
 *   `lore_id` back to `id`. Every filter goes through the scope builder (the
 *   engine's tagged filter tree; there is no flat filter format).
 *
 *   For unit tests and static contexts, pass `loreWorkspaceProvider: () => 'fixed'`.
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
 * Idempotency: upsertNode/addEdge use a scoped updateByQuery → insert-on-0
 *   (retrying the update once on a PK conflict). addEdge is idempotent per
 *   (source, relation, target) inside a Lore workspace.
 */

// `import type` avoids Node16 resolution issues with SDK's missing `"exports"`. Runtime calls use SdkClient below.
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
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
import { log } from '../logger.js';
import { requireCurrentWorkspaceId } from '../security/workspaceContext.js';
import {
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    engineAnd,
    engineField,
    resolveDataplaneScope,
    SCOPE_COLUMNS,
    SCOPE_KEY_INDEX,
    type DataplaneScope,
    type LoreWorkspaceRegistry,
    type ScopeFilterInput,
} from './dataplaneScopeFilter.js';
import { keepInScope, normaliseVertexRecord, scopedGetRow, scopedUpsert, unscopeRow } from './dataplaneScopedIo.js';
import { ensureCollection, GRAPH_COLLECTION_SCHEMAS } from './dataplaneGraphSchema.js';
import { nodeRowFields, recordToLoreNode as rowToNode } from './dataplaneNodeShape.js';
import { DataplaneVersionStore } from '../outbox/dataplaneVersionStore.js';
import { assertEdgeEndpoints, edgeConfidenceFields, rowToLoreEdge } from './dataplaneEdgeShape.js';

export { SCOPE_COLUMNS, SCOPE_KEY_INDEX };

/**
 * @deprecated Slice C removes tenant routing. Kept so older wiring compiles;
 * when supplied (and `loreWorkspaceProvider` is not) it is treated as the
 * Lore-workspace provider — it is NEVER a Dataplane tenant.
 */
export type TenantProvider = () => string;

export interface DataplaneGraphConfig {
    /** Pre-constructed SDK client. Lets tests inject a fake. */
    client: GroundfloorClient;
    /**
     * Groundfloor portal workspace = engine tenant. Fixed by the API credential;
     * not sent for routing (the engine ignores X-Tenant-Id).
     */
    dataplaneWorkspaceId: string;
    /** Lore workspace for the current call. Default: requireCurrentWorkspaceId (ALS; throws when unbound). */
    loreWorkspaceProvider?: () => string;
    /** @deprecated use loreWorkspaceProvider (see TenantProvider). */
    tenantProvider?: TenantProvider;
    /** Organization id written on every record for ReBAC partitioning. */
    orgId: string;
    /**
     * Optional connector name when the tenant has multiple connectors
     * configured (e.g. `arangodb`). Omitted lets Dataplane pick the
     * primary connector.
     */
    connection?: string;
    /**
     * The Lore workspaces this instance serves (its own workspace registry), consulted on
     * EVERY operation. REQUIRED: there is no wildcard and no default — a workspace that is
     * not registered fails closed (`cloud_scope_workspace_not_allowed`).
     */
    workspaceRegistry: LoreWorkspaceRegistry;
}

import { NODE_COLLECTION, EDGE_COLLECTION } from './dataplaneCollections.js';
import * as dpMaintenance from './dataplaneGraphMaintenance.js';
import type { MaintenanceCtx } from './dataplaneGraphMaintenance.js';
import * as dpTopology from './dataplaneGraphTopology.js';
import type { TopologyCtx } from './dataplaneGraphTopology.js';
import { rankSearchResults, SEARCH_SCAN_CAP } from './searchRanking.js';
import type { SupersedeResult } from './graphShared/supersedeGuard.js';

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
    private client: SdkClient;
    private readonly loreWorkspaceProvider: () => string;
    private readonly dataplaneWorkspaceId: string;
    private readonly orgId: string;
    private readonly connection?: string;
    /** This instance's Lore-workspace registry, consulted on every op. */
    private readonly workspaceRegistry: LoreWorkspaceRegistry;
    /**
     * Schema-push state. The Dataplane workspace is credential-fixed, so the
     * collections are provisioned once per process (per Dataplane workspace),
     * with in-flight dedup so concurrent first-hits don't race on createCollection.
     */
    private readonly initState = new Map<string, Promise<void>>();
    /**
     * Slice 5c — cached collection-storage adapter. See getGraphContext
     * for rationale; the scope closure keeps it multi-workspace-safe.
     */
    private cachedCollectionStorage: DataplaneCollectionStorage | null = null;
    /** Cloud version history (lore_version); shares this graph's client/scope so a credential rebuild is followed. */
    readonly versions: DataplaneVersionStore;

    constructor(config: DataplaneGraphConfig) {
        this.client = config.client as unknown as SdkClient;
        this.dataplaneWorkspaceId = config.dataplaneWorkspaceId;
        this.loreWorkspaceProvider = config.loreWorkspaceProvider ?? config.tenantProvider ?? requireCurrentWorkspaceId;
        this.orgId = config.orgId;
        this.connection = config.connection;
        this.versions = new DataplaneVersionStore({ client: () => this.client as never, scope: () => this.scope(), ensureInitialized: (s) => this.ensureInitialized(s), connection: this.connection });
        if (!config.workspaceRegistry) throw new Error('DataplaneGraph requires a workspaceRegistry (no wildcard default)');
        this.workspaceRegistry = config.workspaceRegistry;
    }

    /** Credential rebuild in place (see DataplaneVectorStore.adoptConnectionFrom): swap the client only. */
    adoptConnectionFrom(other: DataplaneGraph): void {
        this.client = other.client;
        this.cachedCollectionStorage = null; // may hold the old client
    }

    /**
     * scope — resolve the per-call DataplaneScope. Runs on every operation so the
     * registry and the ALS-bound Lore workspace are always current; throws
     * DataplaneScopeError (fail closed) before any SDK call.
     */
    private scope(): DataplaneScope {
        return resolveDataplaneScope({
            orgId: this.orgId,
            dataplaneWorkspaceId: this.dataplaneWorkspaceId,
            workspaceRegistry: this.workspaceRegistry,
            loreWorkspaceProvider: this.loreWorkspaceProvider,
        });
    }

    /**
     * initialize — Top-level no-op at boot. Schema push is lazy (first op) and
     * once per Dataplane workspace.
     */
    async initialize(): Promise<void> {
        // Intentionally empty. Init fires inside the CRUD path (ensureInitialized).
    }

    /**
     * ensureInitialized — Idempotent schema push. First call pushes lore_node +
     * lore_edge; later calls return the cached promise. "already exists" errors
     * are swallowed — safe for re-boots against a workspace provisioned earlier.
     */
    private ensureInitialized(scope: DataplaneScope): Promise<void> {
        const key = scope.dataplaneWorkspaceId;
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('DataplaneGraph: empty Dataplane workspace id — refusing operation.');
        }
        const existing = this.initState.get(key);
        if (existing) return existing;
        const p = this.pushSchemaFor(key).catch((err) => {
            // Drop the failed promise so the next call retries rather
            // than seeing a permanent failed state.
            this.initState.delete(key);
            throw err;
        });
        this.initState.set(key, p);
        return p;
    }

    private async pushSchemaFor(dataplaneWorkspaceId: string): Promise<void> {
        for (const schema of GRAPH_COLLECTION_SCHEMAS) {
            // Create-or-reconcile: a fresh collection gets the full v2 schema; an older one only what it has (#4).
            await ensureCollection(this.client, dataplaneWorkspaceId, schema, this.connection);
        }
    }

    /** Scoped crud filter (org + Lore workspace + caller clauses) for a collection op. */
    private crud(scope: DataplaneScope, input: ScopeFilterInput = {}) {
        return buildDataplaneScopeFilter(scope, input, 'crud', 0);
    }

    async upsertNode(
        nodeData: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    ): Promise<LoreNode> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const now = new Date().toISOString();
        const existing = await this.tryGet(scope, nodeData.id);
        const existingCreated = existing && typeof existing['created_at'] === 'string' ? (existing['created_at'] as string) : null;
        const createdAt: string = existingCreated ?? now;
        // Full node shape (D5): v1 + v2 snake_case columns; absent fields omitted, never null.
        const doc = nodeRowFields(nodeData, createdAt, now, existing === null);

        // Scoped upsert (org + Lore workspace + lore_id; D2 row key). Under a version intent the node and its
        // version row go in one transaction (outbox/dataplaneVersionStore.ts); otherwise a plain scoped upsert.
        const node = this.recordToLoreNode({ ...existing, ...doc, lore_id: nodeData.id }); // the stored row after the write, as a read returns it
        await this.versions.upsertNode({ scope, loreId: nodeData.id, doc, node, previous: existing ? this.recordToLoreNode(existing) : null, isNew: existing === null });
        return node;
    }

    async getNode(id: string): Promise<LoreNode | null> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const record = await this.tryGet(scope, id);
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
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const CONCURRENCY = 16;
        for (let i = 0; i < unique.length; i += CONCURRENCY) {
            const slice = unique.slice(i, i + CONCURRENCY);
            const recs = await Promise.all(slice.map((id) => this.tryGet(scope, id)));
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
     * Single-record fetch by ROW KEY (scopedGetRow): GET + guardScope, null when absent or
     * out of scope. A transient failure (5xx, network) is RE-THROWN — never read as "absent",
     * or upsertNode would reset created_at / counters / status from defaults (review B #7).
     * Returned rows are RAW (still carry the physical `id`); callers map via recordToLoreNode.
     */
    private async tryGet(scope: DataplaneScope, loreId: string): Promise<Record<string, unknown> | null> {
        return scopedGetRow(this.client, scope, NODE_COLLECTION, loreId, this.connection);
    }

    async deleteNode(id: string): Promise<boolean> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const res = await this.client.deleteByQuery(
            scope.dataplaneWorkspaceId,
            NODE_COLLECTION,
            this.crud(scope, { loreId: id }).server as object, // org + Lore workspace + lore_id scoped destructive delete
            this.connection,
        );
        return (res?.deleted ?? 0) > 0;
    }

    async addEdge(edge: LoreEdge): Promise<void> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const now = new Date().toISOString();
        const edgeId = `${edge.sourceId}__${edge.relation}__${edge.targetId}`;
        // Both endpoints must exist in THIS Lore workspace (local edge_endpoint_missing parity).
        // Identity lookups: GET by row key (a filtered limit-N query returns arbitrary rows on SQLite).
        const present = new Set<string>();
        for (const id of new Set([edge.sourceId, edge.targetId])) {
            if (await this.tryGet(scope, id)) present.add(id);
        }
        assertEdgeEndpoints(edge, present);
        // Write to lore_edge collection for portability across connectors
        // (non-graph connectors don't have graph.createEdge). Idempotent per
        // (source, relation, target) inside the Lore workspace (row key from edgeId);
        // a repeat refreshes confidence, like local ON CONFLICT DO UPDATE.
        const outcome = await scopedUpsert(this.client, scope, EDGE_COLLECTION, edgeId, {
            source_id: edge.sourceId,
            target_id: edge.targetId,
            relation: edge.relation,
            created_at: now,
            ...edgeConfidenceFields(edge),
        }, this.connection);
        if (outcome === 'updated') return; // graph edge already exists
        // Additionally create a graph edge for Arango-style connectors so
        // `traverse` works. Vertex refs are ROW KEYS (D2). Non-graph connectors
        // will throw 501; ignore.
        try {
            await this.client.graph.createEdge(scope.dataplaneWorkspaceId, 'knowledge_graph', {
                fromId: `${NODE_COLLECTION}/${dataplaneRowKey(scope, edge.sourceId)}`,
                toId: `${NODE_COLLECTION}/${dataplaneRowKey(scope, edge.targetId)}`,
                edgeCollection: EDGE_COLLECTION,
                properties: { relation: edge.relation, org_id: scope.orgId, lore_workspace: scope.loreWorkspace },
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
     * getEdge — the one edge with this exact triple, or null. A GET by row key
     * (the key `addEdge` writes): a filtered `limit: 1` query is not an identity
     * lookup (see scopedGetRow), so an existing edge could read as absent.
     */
    async getEdge(sourceId: string, targetId: string, relation: string): Promise<LoreEdge | null> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const row = await scopedGetRow(this.client, scope, EDGE_COLLECTION, `${sourceId}__${relation}__${targetId}`, this.connection);
        return row ? rowToLoreEdge(row) : null;
    }

    /**
     * queryEdges — paginated edge query against lore_edge (cloud parity for
     * GET /api/edges). Rows carry the stored confidence / confidence_score; rows
     * written before those columns existed default to 'extracted' / 1.0 — the same
     * default LocalGraph applies for a missing confidence column.
     */
    async queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const extra: NonNullable<ScopeFilterInput['extra']>[number][] = [];
        if (q.source) extra.push({ field: 'source_id', op: 'eq', value: q.source });
        if (q.target) extra.push({ field: 'target_id', op: 'eq', value: q.target });
        if (q.relation) extra.push({ field: 'relation', op: 'eq', value: q.relation });
        const built = this.crud(scope, { extra });
        const res = await this.client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            EDGE_COLLECTION,
            { filter: built.server, limit: q.limit, offset: q.offset },
            this.connection,
        );
        return keepInScope(res.records ?? [], built.clientPredicate, 'queryEdges').map(rowToLoreEdge);
    }

    /**
     * deleteEdge — remove lore_edge rows matching the (source, target,
     * relation) triple (cloud parity for DELETE /api/edge). Returns the
     * deleted count (0 = no match → route maps to 404). The companion
     * graph edge in the Arango knowledge_graph is left to the connector's
     * cascade; the lore_edge row is authoritative (see addEdge).
     */
    async deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        const res = await this.client.deleteByQuery(
            scope.dataplaneWorkspaceId,
            EDGE_COLLECTION,
            this.crud(scope, {
                extra: [
                    { field: 'source_id', op: 'eq', value: sourceId },
                    { field: 'target_id', op: 'eq', value: targetId },
                    { field: 'relation', op: 'eq', value: relation },
                ],
            }).server as object, // org + Lore workspace scoped delete
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
        const scope = this.scope();
        await this.ensureInitialized(scope);
        try {
            const res = await this.client.graph.traverse<Record<string, unknown>>(
                scope.dataplaneWorkspaceId,
                NODE_COLLECTION,
                {
                    startId: dataplaneRowKey(scope, nodeId),
                    edgeCollection: EDGE_COLLECTION,
                    direction: 'both',
                    minDepth: 1,
                    maxDepth,
                    connection: this.connection,
                },
            );
            // The engine's traverse takes no filter (F6): scope is a client-side
            // post-filter on every returned vertex (D3 traverse route). Row keys
            // make cross-workspace edges unconstructible through this adapter, but a
            // buggy/foreign writer could still plant one, so the guard is applied
            // to every vertex AND paths through a rejected vertex are cut: the engine
            // returns vertices without their path, so any vertex deeper than the
            // shallowest rejected vertex may have been reached through it and is
            // dropped too (fail closed; only ever triggers on anomalous data).
            const scopePredicate = buildDataplaneScopeFilter(scope, {}, 'traverse', 0).clientPredicate;
            const returned = (res.records ?? []).map((r) => normaliseVertexRecord(r, NODE_COLLECTION));
            let cutDepth = Infinity;
            for (const r of returned) {
                if (!scopePredicate(r)) {
                    const d = this.recordDepth(r);
                    // depth-unknown (0) vertices cannot be ordered: treat as cutting everything deeper than 0
                    cutDepth = Math.min(cutDepth, d > 0 ? d : 1);
                }
            }
            let rows = keepInScope(returned, scopePredicate, 'traverse');
            if (Number.isFinite(cutDepth)) {
                const before = rows.length;
                rows = rows.filter((r) => {
                    const d = this.recordDepth(r);
                    return d > 0 && d <= cutDepth;
                });
                if (rows.length < before) {
                    log.error('[cloud-scope] dropped traverse vertices beyond an out-of-scope vertex', { cutDepth, dropped: before - rows.length });
                }
            }
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
        const scope = this.scope();
        await this.ensureInitialized(scope);

        // Scope filters are AND-applied server-side. org_id + lore_workspace are
        // ALWAYS present (never regress). project/ecosystem narrow the candidate
        // set before we scan ('' / '*' add no clause).
        const built = this.crud(scope, { project, ecosystem });

        // TW-4c (perf-search-no-order-by-scancap): sort by (updated_at desc, id
        // asc) BEFORE the cap so that beyond SEARCH_SCAN_CAP matches the cloud
        // keeps the SAME most-recently-updated rows the local Cypher's ORDER BY
        // keeps (rankSearchResults' tiebreak). Without it the SDK could hand a
        // DIFFERENT window to the identical ranker, breaking W5B order parity.
        const res = await this.client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            NODE_COLLECTION,
            {
                filter: built.server,
                // lore_id (not the hashed row key) is the logical tiebreak local uses.
                sort: [{ field: 'updated_at', direction: 'desc' }, { field: 'lore_id', direction: 'asc' }],
                limit: SEARCH_SCAN_CAP,
            },
            this.connection,
        );
        const candidates = keepInScope(res.records ?? [], built.clientPredicate, 'search').map((r) => this.recordToLoreNode(r));
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
        const scope = this.scope();
        await this.ensureInitialized(scope);
        // CONTRACT-DEVIATION: cloud does case-insensitive SUBSTRING; local
        // does case-insensitive EXACT membership (Pass 2). Both fold case.
        // See DECISIONS.md DEC-TAG-MATCH for the cloud Pass 2 follow-up.
        const built = this.crud(scope, {
            type: type || undefined,
            project,
            ecosystem,
            tags: tag ? [tag.toLowerCase()] : undefined,
        });
        const res = await this.client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            NODE_COLLECTION,
            { filter: built.server, limit: 1000 },
            this.connection,
        );
        return keepInScope(res.records ?? [], built.clientPredicate, 'listNodes').map((r) => this.recordToLoreNode(r));
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
     *
     * The cursor is a keyset on the full sort key: a row is on a later page
     * when `updated_at < cursor.updatedAt`, or `updated_at == cursor.updatedAt`
     * and `lore_id > cursor.id`. A cursor on `updated_at` alone skipped every
     * row that shared the boundary row's timestamp (two writes in the same
     * millisecond are enough). The same test runs client-side, for a connector
     * that does not push the filter down.
     */
    async bulkList(q: BulkListQuery): Promise<BulkListPage> {
        const scope = this.scope();
        await this.ensureInitialized(scope);
        // CONTRACT-DEVIATION (substring vs exact) — see listNodes above.
        const built = this.crud(scope, {
            project: q.project || undefined,
            ecosystem: q.ecosystem || undefined,
            type: q.types && q.types.length > 0 ? q.types[0] : undefined,
            tags: q.tags && q.tags.length > 0 ? [q.tags[0]!.toLowerCase()] : undefined,
        });
        const cursor = q.cursor ?? null;
        const filter = cursor && built.server
            ? engineAnd([
                built.server,
                {
                    or: [
                        engineField('updated_at', 'lt', cursor.updatedAt),
                        engineAnd([
                            engineField('updated_at', 'eq', cursor.updatedAt),
                            engineField('lore_id', 'gt', cursor.id),
                        ]),
                    ],
                },
            ])
            : built.server;
        const afterCursor = (r: Record<string, unknown>): boolean => {
            if (!cursor) return true;
            const at = String(r['updated_at'] ?? '');
            return at < cursor.updatedAt || (at === cursor.updatedAt && String(r['lore_id'] ?? '') > cursor.id);
        };
        const res = await this.client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            NODE_COLLECTION,
            {
                filter,
                sort: [
                    { field: 'updated_at', direction: 'desc' },
                    { field: 'lore_id', direction: 'asc' },
                ],
                limit: q.limit + 1,
            },
            this.connection,
        );
        const records = keepInScope(res.records ?? [], built.clientPredicate, 'bulkList').filter(afterCursor);
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
            scope: () => this.scope(),
            connection: this.connection,
            ensureInitialized: this.ensureInitialized.bind(this),
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
        // getGraphContext() call. The scope closure still resolves per-op
        // via AsyncLocalStorage, so a single shared adapter is
        // multi-workspace-safe.
        if (!this.cachedCollectionStorage) {
            this.cachedCollectionStorage = new DataplaneCollectionStorage({
                client: this.client as unknown as CollectionStorageSdkClient,
                scopeProvider: () => {
                    const scope = this.scope();
                    // Lazy schema push: same init guard as the core node/edge
                    // writes use (fire-and-forget; failures retry next call).
                    void this.ensureInitialized(scope).catch(() => undefined);
                    return scope;
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
            scope: () => this.scope(),
            connection: this.connection,
            ensureInitialized: this.ensureInitialized.bind(this),
            tryGet: this.tryGet.bind(this),
        };
    }

    async supersedeNode(oldId: string, newId: string, reason?: string): Promise<SupersedeResult> {
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

    private recordToLoreNode(raw: Record<string, unknown>): LoreNode {
        return rowToNode(raw);
    }
}
