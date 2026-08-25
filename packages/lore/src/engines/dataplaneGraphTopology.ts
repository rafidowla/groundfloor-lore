/**
 * dataplaneGraphTopology.ts — read-only stats + topology overviews for the
 * cloud DataplaneGraph adapter.
 *
 * Extracted from dataplaneGraph.ts (god-class split). All five operations are
 * pure reads (count / paginated query + client-side group-by). They take a
 * structural TopologyCtx so this module has no dependency on the adapter class
 * or its private SdkClient type. DataplaneGraph keeps thin delegators; behavior
 * (including the paginated TOPOLOGY_OVERVIEW_NODE_CAP bound, the `truncated`
 * flag, the connection-in-options query quirk, and the '_unknown'/'*' bucket
 * keys) is unchanged.
 */

import type { GraphStats } from '../providers/types.js';
import { NODE_COLLECTION, EDGE_COLLECTION } from './dataplaneCollections.js';

/**
 * Cap on rows scanned for the client-side group-by overviews (1M-node guard).
 *
 * hc-topology-node-cap-mismatch (Audit 2026): the local path
 * (`graphTopology.ts`) caps at 50_000 while this cloud path historically
 * capped at 10_000 — a silent parity gap where the same overview returned a
 * different `truncated` answer depending on deployment mode. Both now share
 * the 50_000 default and read the same `LORE_TOPOLOGY_SCAN_CAP` override so
 * operators can tune the bound symmetrically. Clamped to [1, 1_000_000] to
 * keep an adversarial/typo'd value from disabling the guard or pinning it at 0.
 */
function resolveTopologyScanCap(): number {
    const raw = parseInt(process.env['LORE_TOPOLOGY_SCAN_CAP'] ?? '', 10);
    if (Number.isFinite(raw) && raw > 0) {
        return Math.min(raw, 1_000_000);
    }
    return 50_000;
}

/** Structural subset of the SDK client the topology reads touch. */
interface TopologyClient {
    count(tenantId: string, collection: string, filter: object, connection?: string): Promise<number>;
    query<T = Record<string, unknown>>(tenantId: string, collection: string, options: object, connection?: string): Promise<{ records?: T[]; has_more?: boolean }>;
}

/** State threaded from DataplaneGraph for the topology reads. */
export interface TopologyCtx {
    client: TopologyClient;
    tenantProvider: () => string;
    orgId: string;
    connection?: string;
    ensureTenantInitialized: (tenantId: string) => Promise<void>;
}

export async function getStats(ctx: TopologyCtx): Promise<GraphStats> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const orgFilter = { org_id: ctx.orgId };
    const [nodeCount, edgeCount] = await Promise.all([
        ctx.client.count(tenantId, NODE_COLLECTION, orgFilter, ctx.connection).catch(() => 0),
        ctx.client.count(tenantId, EDGE_COLLECTION, orgFilter, ctx.connection).catch(() => 0),
    ]);
    // Type breakdown requires group-by, which the SDK doesn't expose yet;
    // slice 1 returns an empty map (callers fall back to listNodes + tally).
    return { nodeCount, edgeCount, typeBreakdown: {} };
}

export async function getTopology(ctx: TopologyCtx, limit = 100): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const orgFilter = { org_id: ctx.orgId };
    const [nodesRes, edgesRes] = await Promise.all([
        ctx.client.query<Record<string, unknown>>(tenantId, NODE_COLLECTION, { filter: orgFilter, limit }, ctx.connection).catch(() => ({ records: [] as Record<string, unknown>[] })),
        ctx.client.query<Record<string, unknown>>(tenantId, EDGE_COLLECTION, { filter: orgFilter, limit }, ctx.connection).catch(() => ({ records: [] as Record<string, unknown>[] })),
    ]);
    return {
        nodes: (nodesRes.records ?? []).map((r) => ({ id: r['id'], type: r['type'], label: r['label'] })),
        edges: (edgesRes.records ?? []).map((r) => ({ source: r['source_id'], target: r['target_id'], relation: r['relation'] })),
    };
}

export async function getTopologyOverview(ctx: TopologyCtx): Promise<{
    blobs: Array<{ project: string; nodeCount: number }>;
    aggregateEdges: Array<{ fromProject: string; toProject: string; count: number }>;
    totalNodes: number;
    truncated?: boolean;
}> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const counts = new Map<string, number>();
    let total = 0;
    let truncated = false;
    const PAGE = 500;
    const scanCap = resolveTopologyScanCap();
    for (let offset = 0; offset < scanCap; offset += PAGE) {
        const limit = Math.min(PAGE, scanCap - offset);
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { fields: ['project'], filter: { org_id: ctx.orgId }, limit, offset, connection: ctx.connection } as Record<string, unknown>,
        );
        const records = res?.records ?? [];
        for (const r of records) {
            const project = typeof r['project'] === 'string' && r['project'].length > 0
                ? (r['project'] as string)
                : '*';
            counts.set(project, (counts.get(project) ?? 0) + 1);
            total += 1;
        }
        if (records.length < limit) break;       // last page
        if (offset + PAGE >= scanCap) {
            truncated = res.has_more === true || records.length === limit;
            break;
        }
    }
    const blobs = Array.from(counts.entries())
        .map(([project, nodeCount]) => ({ project, nodeCount }))
        .sort((a, b) => b.nodeCount - a.nodeCount);
    return {
        blobs,
        aggregateEdges: [],
        totalNodes: total,
        ...(truncated ? { truncated: true } : {}),
    };
}

export async function getTopologyOverviewByType(ctx: TopologyCtx): Promise<{
    blobs: Array<{ project: string; nodeCount: number; types: Array<{ type: string; count: number }> }>;
    aggregateEdges: Array<{ fromProject: string; toProject: string; count: number }>;
    totalNodes: number;
    truncated?: boolean;
}> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const counts = new Map<string, number>();
    let total = 0;
    let truncated = false;
    const PAGE = 500;
    const scanCap = resolveTopologyScanCap();
    for (let offset = 0; offset < scanCap; offset += PAGE) {
        const limit = Math.min(PAGE, scanCap - offset);
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { fields: ['type'], filter: { org_id: ctx.orgId }, limit, offset, connection: ctx.connection } as Record<string, unknown>,
        );
        const records = res?.records ?? [];
        for (const r of records) {
            const type = typeof r['type'] === 'string' && r['type'].length > 0
                ? (r['type'] as string)
                : 'unknown';
            counts.set(type, (counts.get(type) ?? 0) + 1);
            total += 1;
        }
        if (records.length < limit) break;
        if (offset + PAGE >= scanCap) {
            // perf-dataplane-topology-overview-silent-truncation: this method
            // used to hit the cap and return silently. Surface it like
            // getTopologyOverview does so callers can warn the user.
            truncated = res.has_more === true || records.length === limit;
            break;
        }
    }
    const blobs = Array.from(counts.entries())
        .map(([type, nodeCount]) => ({
            project: type,  // re-use "project" field so ChordDiagram works unchanged
            nodeCount,
            types: [{ type, count: nodeCount }],
        }))
        .sort((a, b) => b.nodeCount - a.nodeCount);
    return {
        blobs,
        aggregateEdges: [],
        totalNodes: total,
        ...(truncated ? { truncated: true } : {}),
    };
}

export async function getLanguageBreakdown(ctx: TopologyCtx): Promise<Record<string, number>> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const counts: Record<string, number> = {};
    let truncated = false;
    const PAGE = 500;
    const scanCap = resolveTopologyScanCap();
    for (let offset = 0; offset < scanCap; offset += PAGE) {
        const limit = Math.min(PAGE, scanCap - offset);
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { fields: ['language'], filter: { org_id: ctx.orgId }, limit, offset, connection: ctx.connection } as Record<string, unknown>,
        );
        const records = res?.records ?? [];
        for (const r of records) {
            const raw = r['language'];
            const key = typeof raw === 'string' && raw.length > 0 ? raw : '_unknown';
            counts[key] = (counts[key] ?? 0) + 1;
        }
        if (records.length < limit) break;
        if (offset + PAGE >= scanCap) {
            truncated = res.has_more === true || records.length === limit;
            break;
        }
    }
    // perf-dataplane-topology-overview-silent-truncation: the language
    // breakdown returns a flat map (no struct to hang a `truncated:true`
    // field on), so when the scan hits the cap we surface it through a
    // reserved `_truncated` sentinel key — the same in-band convention the
    // `_unknown` language bucket already uses in this map. Callers that
    // tally languages should skip keys starting with `_`.
    if (truncated) counts['_truncated'] = 1;
    return counts;
}
