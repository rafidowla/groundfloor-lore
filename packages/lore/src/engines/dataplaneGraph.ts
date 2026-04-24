/**
 * dataplaneGraph.ts — Q2.2 Cloud-mode GraphProvider backed by Dataplane TS-SDK.
 *
 * Purpose:
 *   When `deploymentMode === 'cloud'` (Q2.1 toggle), core swaps the embedded
 *   Kùzu LocalGraph for this adapter. Every LoreNode / LoreEdge operation is
 *   routed through `groundfloor-ts-sdk` → Dataplane → (Arango | Postgres |
 *   …whatever connector the tenant has). D-017 rules: Lore never talks to a
 *   cloud DB driver directly — Dataplane owns tenant isolation, ReBAC, and
 *   change-feed invalidation.
 *
 * Contract:
 *   Implements `GraphProvider` (providers/types.ts) — the 10-method surface
 *   core uses to read/write the knowledge graph. Also exposes
 *   `createPluginGraphContext()` + `getLanguageBreakdown()` to satisfy
 *   server.ts + cli/commands.ts callers that reach beyond the formal
 *   interface. In slice 1 (Q2.2), plugin graph ops in cloud mode throw a
 *   descriptive error ("cloud-mode plugin support lands in a later slice"),
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
 *   Plugins contribute their own collections in a later slice (same naming
 *   convention as `tsSdkAdapter.pushPluginData`: `${pluginName}_${kind}`).
 *
 * Side Effects: Network calls to Dataplane. No local disk.
 * Error Behavior: Bubbles SDK errors (GroundfloorError subclass) so callers
 *   can distinguish auth/network/server failures. `initialize()` tolerates
 *   "already exists" errors for idempotent schema push.
 * Idempotency: upsertNode uses updateByQuery+insert (same pattern as
 *   tsSdkAdapter.push). addEdge is NOT deduplicated in slice 1 — a repeat
 *   call creates a second edge. Callers that need dedup must check first.
 */

// @ts-ignore - Local workspace linking lacks full Node16 exports declaration
import { GroundfloorClient } from 'groundfloor-ts-sdk';
import type {
    GraphProvider,
    LoreNode,
    LoreEdge,
    TraversalResult,
    GraphStats,
} from '../providers/types.js';
import { detectLanguage } from './language.js';

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
}

const NODE_COLLECTION = 'lore_node';
const EDGE_COLLECTION = 'lore_edge';

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
    private initialized = false;

    constructor(config: DataplaneGraphConfig) {
        this.client = config.client as unknown as SdkClient;
        this.tenantProvider = config.tenantProvider;
        this.orgId = config.orgId;
        this.connection = config.connection;
    }

    /**
     * initialize — Idempotent schema push for lore_node + lore_edge.
     *
     * Safe to call multiple times; subsequent calls hit the "already
     * exists" error path and return cleanly. Called by server.ts once
     * on daemon boot in cloud mode.
     *
     * NB: pushes against the CURRENT tenantProvider's tenant, which is
     * expected to be a boot-time system tenant or the first tenant that
     * hits the daemon. Full per-workspace schema push (one collection set
     * per tenant) is a later slice — slice 1 assumes collections are
     * provisioned ahead of time for each tenant that will ever connect.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        const tenantId = this.tenantProvider();
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
        this.initialized = true;
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
        const now = new Date().toISOString();
        const existing = await this.tryGet(tenantId, nodeData.id);
        const existingCreated = existing && typeof existing['created_at'] === 'string' ? (existing['created_at'] as string) : null;
        const createdAt: string = existingCreated ?? now;
        const doc = {
            id: nodeData.id,
            type: nodeData.type,
            label: nodeData.label,
            content: nodeData.content ?? '',
            tags: nodeData.tags ?? '',
            project: nodeData.project ?? '*',
            ecosystem: nodeData.ecosystem ?? '*',
            org_id: this.orgId,
            created_at: createdAt,
            updated_at: now,
            language: nodeData.language ?? null,
        };

        const res = await this.client.updateByQuery(
            tenantId,
            NODE_COLLECTION,
            { id_eq: nodeData.id },
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
            tags: nodeData.tags ?? '',
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
        const record = await this.tryGet(tenantId, id);
        if (!record) return null;
        return this.recordToLoreNode(record);
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
            return rec ?? null;
        } catch (err) {
            const msg = (err as Error).message ?? '';
            // 404 / not found — interpret as null rather than re-throw.
            if (/not found|404/i.test(msg)) return null;
            // Some connectors don't expose /get — fall back to query.
            try {
                const res = await this.client.query<Record<string, unknown>>(
                    tenantId,
                    NODE_COLLECTION,
                    { filter: { id_eq: id }, limit: 1 },
                    this.connection,
                );
                return res.records?.[0] ?? null;
            } catch {
                return null;
            }
        }
    }

    async deleteNode(id: string): Promise<boolean> {
        const tenantId = this.tenantProvider();
        const res = await this.client.deleteByQuery(
            tenantId,
            NODE_COLLECTION,
            { id_eq: id },
            this.connection,
        );
        return (res?.deleted ?? 0) > 0;
    }

    async addEdge(edge: LoreEdge): Promise<void> {
        const tenantId = this.tenantProvider();
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

    async traverse(nodeId: string, maxDepth = 2): Promise<TraversalResult[]> {
        const tenantId = this.tenantProvider();
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
            const rows = res.records ?? [];
            return rows.map((r, i) => ({
                node: this.recordToLoreNode(r),
                // Depth / relation aren't uniformly exposed by the traverse
                // result. Slice 1 approximates: depth = 1 (one-hop neighbours
                // dominate the typical use case), relation from record if
                // present else empty.
                depth: typeof r['_depth'] === 'number' ? (r['_depth'] as number) : 1,
                relation: (r['relation'] as string) ?? '',
                _index: i,
            } as unknown as TraversalResult));
        } catch (err) {
            const msg = (err as Error).message ?? '';
            // Non-graph connector → empty traversal rather than blow up.
            if (/501|not supported/i.test(msg)) return [];
            throw err;
        }
    }

    async search(
        query: string,
        limit = 10,
        project?: string,
        ecosystem?: string,
    ): Promise<LoreNode[]> {
        const tenantId = this.tenantProvider();
        // Slice 1 — substring match on label/content via query filter
        // (`contains`). Full-text search with ranking is a later slice;
        // the SDK exposes `client.search(...)` for Phase 2 tsvector.
        const filter: Record<string, unknown> = { org_id: this.orgId };
        if (project) filter['project'] = project;
        if (ecosystem) filter['ecosystem'] = ecosystem;
        if (query && query.length > 0) {
            filter['label_contains'] = query;
        }
        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter, limit },
            this.connection,
        );
        return (res.records ?? []).map((r) => this.recordToLoreNode(r));
    }

    async listNodes(
        type?: string,
        tag?: string,
        project?: string,
        ecosystem?: string,
    ): Promise<LoreNode[]> {
        const tenantId = this.tenantProvider();
        const filter: Record<string, unknown> = { org_id: this.orgId };
        if (type) filter['type'] = type;
        if (project) filter['project'] = project;
        if (ecosystem) filter['ecosystem'] = ecosystem;
        // tag match — substring on the comma-joined tags field.
        if (tag) filter['tags_contains'] = tag;

        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter, limit: 1000 },
            this.connection,
        );
        return (res.records ?? []).map((r) => this.recordToLoreNode(r));
    }

    async getStats(): Promise<GraphStats> {
        const tenantId = this.tenantProvider();
        const orgFilter = { org_id: this.orgId };
        const [nodeCount, edgeCount] = await Promise.all([
            this.client.count(tenantId, NODE_COLLECTION, orgFilter, this.connection).catch(() => 0),
            this.client.count(tenantId, EDGE_COLLECTION, orgFilter, this.connection).catch(() => 0),
        ]);
        // Type breakdown requires group-by, which the SDK doesn't expose
        // yet; slice 1 returns an empty map. Callers that need it today
        // fall back to listNodes + client-side tally.
        return {
            nodeCount,
            edgeCount,
            typeBreakdown: {},
            pluginStats: {},
        };
    }

    async getTopology(limit = 100): Promise<{ nodes: unknown[]; edges: unknown[] }> {
        const tenantId = this.tenantProvider();
        const orgFilter = { org_id: this.orgId };
        const [nodesRes, edgesRes] = await Promise.all([
            this.client.query<Record<string, unknown>>(tenantId, NODE_COLLECTION, { filter: orgFilter, limit }, this.connection).catch(() => ({ records: [] as Record<string, unknown>[] })),
            this.client.query<Record<string, unknown>>(tenantId, EDGE_COLLECTION, { filter: orgFilter, limit }, this.connection).catch(() => ({ records: [] as Record<string, unknown>[] })),
        ]);
        return {
            nodes: (nodesRes.records ?? []).map((r) => ({
                id: r['id'],
                type: r['type'],
                label: r['label'],
            })),
            edges: (edgesRes.records ?? []).map((r) => ({
                source: r['source_id'],
                target: r['target_id'],
                relation: r['relation'],
            })),
        };
    }

    /**
     * getLanguageBreakdown — Slice-1 stub.
     *
     * Returning `{}` is the contract LocalGraph already uses for
     * pre-Phase-A graphs missing the column. Server.ts and cli/commands
     * surface this as "no language data" without error. Full cloud
     * implementation needs a SDK aggregate API (group-by) which lands
     * in a later slice.
     */
    async getLanguageBreakdown(): Promise<Record<string, number>> {
        return {};
    }

    /**
     * createPluginGraphContext — Slice-1 stub.
     *
     * Plugin-owned Cypher against a cloud tenant requires translating
     * Kùzu Cypher to Dataplane's AQL/SQL surface via executeRaw, plus
     * per-plugin schema provisioning. That's a later slice. For Q2.2
     * slice 1, the cloud-mode daemon refuses plugin graph calls with a
     * descriptive error; operators who need plugin features run local
     * mode (Q2.1 default).
     *
     * bumpEpoch() is a no-op — there is no in-proc read cache in cloud
     * mode (Dataplane handles caching / change-feed invalidation).
     * detectLanguage() is still pure (no graph access), so we delegate
     * directly to the core detector.
     */
    createPluginGraphContext(): {
        executeQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>;
        queryRows(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
        bumpEpoch(): void;
        detectLanguage(text: string, options?: { threshold?: number; minLength?: number }): { language: string | null; confidence: number };
    } {
        const refuse = (): never => {
            throw new Error(
                'DataplaneGraph: plugin graph operations are not available in cloud mode ' +
                '(Q2.2 slice 1). Run the daemon with LORE_DEPLOYMENT_MODE=local, or wait for ' +
                'the plugin-cloud-parity slice.',
            );
        };
        return {
            executeQuery: async () => refuse(),
            queryRows: async () => refuse(),
            bumpEpoch: () => { /* no-op in cloud mode */ },
            // Language detection is a pure function (no graph access).
            detectLanguage: (text: string, options?: { threshold?: number; minLength?: number }) => {
                return detectLanguage(text, options);
            },
        };
    }

    /* ─── internals ───────────────────────────────────────────── */

    private recordToLoreNode(rec: Record<string, unknown>): LoreNode {
        return {
            id: String(rec['id'] ?? ''),
            type: String(rec['type'] ?? ''),
            label: String(rec['label'] ?? ''),
            content: String(rec['content'] ?? ''),
            tags: String(rec['tags'] ?? ''),
            project: String(rec['project'] ?? '*'),
            ecosystem: String(rec['ecosystem'] ?? '*'),
            metadata: '{}',
            createdAt: String(rec['created_at'] ?? ''),
            updatedAt: String(rec['updated_at'] ?? ''),
            syncedAt: String(rec['updated_at'] ?? ''),
            language: (rec['language'] as string | null | undefined) ?? null,
        };
    }
}
