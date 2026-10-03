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
import { buildDataplaneScopeFilter, type DataplaneScope } from './dataplaneScopeFilter.js';
import { keepInScope, pageRepeats, unscopeRow } from './dataplaneScopedIo.js';

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
    /** Resolve the per-call scope (org + Lore workspace); throws DataplaneScopeError, fail closed. */
    scope: () => DataplaneScope;
    connection?: string;
    ensureInitialized: (scope: DataplaneScope) => Promise<void>;
}

/** Engine filter tree for "everything in this org + Lore workspace". */
function scopeFilter(scope: DataplaneScope) {
    return buildDataplaneScopeFilter(scope, {}, 'crud', 0);
}

/**
 * Columns the client-side scope check needs on every scanned row (guardScope:
 * org_id + lore_workspace + lore_id, and the row-key `id`). A `projection` that
 * omitted them would make the check impossible, so every overview projects them
 * alongside the one column it tallies.
 */
const SCOPE_PROJECTION = ['id', 'lore_id', 'lore_workspace', 'org_id'] as const;

/**
 * One page of the group-by scan. The engine's QueryRequest key is `projection`
 * (there is no `fields`; an unknown key is silently ignored and the full row
 * comes back). The server filter is an optimisation, NOT a guarantee — the
 * engine's SQLite connector pushes down `id_eq` only — so every returned row is
 * re-checked with the scope predicate. Paging decisions use the RAW page length
 * (what the engine returned), tallying uses only the in-scope rows.
 */
async function scanPage(
    ctx: TopologyCtx,
    scope: DataplaneScope,
    column: string,
    limit: number,
    offset: number,
    what: string,
): Promise<{ rows: Record<string, unknown>[]; rawCount: number; hasMore: boolean; head: unknown }> {
    const built = scopeFilter(scope);
    const res = await ctx.client.query<Record<string, unknown>>(
        scope.dataplaneWorkspaceId,
        NODE_COLLECTION,
        { projection: [...SCOPE_PROJECTION, column], filter: built.server, limit, offset, connection: ctx.connection } as Record<string, unknown>,
    );
    const records = res?.records ?? [];
    return {
        head: records[0]?.['id'],
        rows: keepInScope(records, built.clientPredicate, what),
        rawCount: records.length,
        hasMore: res?.has_more === true,
    };
}

export async function getStats(ctx: TopologyCtx): Promise<GraphStats> {
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;
    const orgFilter = scopeFilter(scope).server as object;
    const [nodeCount, edgeCount] = await Promise.all([
        ctx.client.count(tenantId, NODE_COLLECTION, orgFilter, ctx.connection).catch(() => 0),
        ctx.client.count(tenantId, EDGE_COLLECTION, orgFilter, ctx.connection).catch(() => 0),
    ]);
    // Type breakdown requires group-by, which the SDK doesn't expose yet;
    // slice 1 returns an empty map (callers fall back to listNodes + tally).
    return { nodeCount, edgeCount, typeBreakdown: {} };
}

export async function getTopology(ctx: TopologyCtx, limit = 100): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;
    const built = scopeFilter(scope);
    const orgFilter = built.server as object;
    const [nodesRes, edgesRes] = await Promise.all([
        ctx.client.query<Record<string, unknown>>(tenantId, NODE_COLLECTION, { filter: orgFilter, limit }, ctx.connection).catch(() => ({ records: [] as Record<string, unknown>[] })),
        ctx.client.query<Record<string, unknown>>(tenantId, EDGE_COLLECTION, { filter: orgFilter, limit }, ctx.connection).catch(() => ({ records: [] as Record<string, unknown>[] })),
    ]);
    return {
        nodes: keepInScope(nodesRes.records ?? [], built.clientPredicate, 'getTopology.nodes')
            .map((r) => unscopeRow(r))
            .map((r) => ({ id: r['id'], type: r['type'], label: r['label'] })),
        edges: keepInScope(edgesRes.records ?? [], built.clientPredicate, 'getTopology.edges')
            .map((r) => ({ source: r['source_id'], target: r['target_id'], relation: r['relation'] })),
    };
}

export async function getTopologyOverview(ctx: TopologyCtx): Promise<{
    blobs: Array<{ project: string; nodeCount: number }>;
    aggregateEdges: Array<{ fromProject: string; toProject: string; count: number }>;
    totalNodes: number;
    truncated?: boolean;
}> {
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const counts = new Map<string, number>();
    let total = 0;
    let truncated = false;
    const PAGE = 500;
    const scanCap = resolveTopologyScanCap();
    let head: unknown;
    for (let offset = 0; offset < scanCap; offset += PAGE) {
        const limit = Math.min(PAGE, scanCap - offset);
        const page = await scanPage(ctx, scope, 'project', limit, offset, 'getTopologyOverview');
        // An ignored offset (SQLite) returns page 0 again: stop and flag, never re-count it.
        if (offset === 0) head = page.head;
        else if (pageRepeats(head, page.head)) { truncated = true; break; }
        for (const r of page.rows) {
            const project = typeof r['project'] === 'string' && r['project'].length > 0
                ? (r['project'] as string)
                : '*';
            counts.set(project, (counts.get(project) ?? 0) + 1);
            total += 1;
        }
        if (page.rawCount < limit) break;       // last page
        if (offset + PAGE >= scanCap) {
            truncated = page.hasMore || page.rawCount === limit;
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
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const counts = new Map<string, number>();
    let total = 0;
    let truncated = false;
    const PAGE = 500;
    const scanCap = resolveTopologyScanCap();
    let head: unknown;
    for (let offset = 0; offset < scanCap; offset += PAGE) {
        const limit = Math.min(PAGE, scanCap - offset);
        const page = await scanPage(ctx, scope, 'type', limit, offset, 'getTopologyOverviewByType');
        // An ignored offset (SQLite) returns page 0 again: stop and flag, never re-count it.
        if (offset === 0) head = page.head;
        else if (pageRepeats(head, page.head)) { truncated = true; break; }
        for (const r of page.rows) {
            const type = typeof r['type'] === 'string' && r['type'].length > 0
                ? (r['type'] as string)
                : 'unknown';
            counts.set(type, (counts.get(type) ?? 0) + 1);
            total += 1;
        }
        if (page.rawCount < limit) break;
        if (offset + PAGE >= scanCap) {
            // perf-dataplane-topology-overview-silent-truncation: this method
            // used to hit the cap and return silently. Surface it like
            // getTopologyOverview does so callers can warn the user.
            truncated = page.hasMore || page.rawCount === limit;
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
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const counts: Record<string, number> = {};
    let truncated = false;
    const PAGE = 500;
    const scanCap = resolveTopologyScanCap();
    let head: unknown;
    for (let offset = 0; offset < scanCap; offset += PAGE) {
        const limit = Math.min(PAGE, scanCap - offset);
        const page = await scanPage(ctx, scope, 'language', limit, offset, 'getLanguageBreakdown');
        // An ignored offset (SQLite) returns page 0 again: stop and flag, never re-count it.
        if (offset === 0) head = page.head;
        else if (pageRepeats(head, page.head)) { truncated = true; break; }
        for (const r of page.rows) {
            const raw = r['language'];
            const key = typeof raw === 'string' && raw.length > 0 ? raw : '_unknown';
            counts[key] = (counts[key] ?? 0) + 1;
        }
        if (page.rawCount < limit) break;
        if (offset + PAGE >= scanCap) {
            truncated = page.hasMore || page.rawCount === limit;
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
