/**
 * graphReportAggregates.ts — engine-agnostic aggregation for `lore report`.
 *
 * `graphReport.ts` used to feed four raw Cypher aggregates off
 * `graph.getGraphContext().queryRows(...)`: edge-confidence tally, hub
 * ranking by degree (a Cypher `COUNT{}` subquery), recently-updated, and
 * orphans. That only ran on Kùzu. This module reproduces all four from the
 * portable primitives BOTH `LocalGraph` and `SurrealGraph` implement
 * (`queryEdges`, `getNodesByIds`, `bulkListProjected`) — the same shape as
 * `engines/searchRanking.ts` (read its header for the precedent): the report
 * is identical across engines BY CONSTRUCTION because both feed the SAME
 * aggregation code, not two hand-matched Cypher/SurrealQL implementations.
 *
 * One concern per file: this holds the aggregation, `graphReport.ts` holds
 * the markdown formatting.
 */

import type { BulkListCursor, EdgeQuery, GraphStats, LoreEdge, LoreNode } from '../providers/types.js';
import { DEFAULT_MAINTENANCE_PAGE_SIZE } from './nodePager.js';

/**
 * The graph surface the report aggregates need — a deliberate structural
 * subset of `WorkspaceGraph` (openWorkspaceGraph.ts), named here rather than
 * imported so this module doesn't couple to the CLI's engine-selection type.
 * `LocalGraph` and `SurrealGraph` both satisfy it as-is.
 */
export interface ReportGraph {
    getStats(): Promise<GraphStats>;
    queryEdges(q: EdgeQuery): Promise<LoreEdge[]>;
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
    bulkListProjected(
        project: string,
        columns: readonly string[],
        limit: number,
        cursor: BulkListCursor | null,
    ): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: BulkListCursor | null }>;
}

/** Page size for the portable `queryEdges` walk. Both engines clamp at 1000;
 *  500 mirrors `cli/commands/migrateEngine.ts`'s `readAllEdges`. */
const EDGE_PAGE = 500;

export interface EdgeAggregates {
    /** Edge count per confidence tier, absent confidence defaulting to
     *  'extracted' per `LoreEdge.confidence`'s documented default. */
    confidenceByTier: Record<string, number>;
    /** Undirected degree (in + out) per node id that appears on at least one edge. */
    degreeById: Map<string, number>;
    /** Every node id that is a source or target of at least one edge — the orphan-exclusion set. */
    endpointIds: Set<string>;
}

/**
 * computeEdgeAggregates — ONE paged `queryEdges` walk producing every
 * edge-derived report input in a single pass over the corpus (~52k edges on
 * the real workspace).
 *
 * The paging idiom mirrors `migrateEngine.ts`'s `readAllEdges` (limit/offset
 * walk, stop when a page comes back short of the page size) but is not
 * lifted into a shared helper: `readAllEdges` materializes a transformed
 * edge-record array for a migration diff pass; this folds three tallies
 * in-stream and never holds the edge list, because the report only needs
 * the aggregates, not the edges themselves. Same walk shape, different
 * output — a shared helper generic enough to serve both without allocating
 * what neither needs would be the new abstraction, not the removed one.
 */
export async function computeEdgeAggregates(graph: ReportGraph): Promise<EdgeAggregates> {
    const confidenceByTier: Record<string, number> = { extracted: 0, inferred: 0, ambiguous: 0 };
    const degreeById = new Map<string, number>();
    const endpointIds = new Set<string>();

    for (let offset = 0; ; offset += EDGE_PAGE) {
        const page = await graph.queryEdges({ limit: EDGE_PAGE, offset });
        for (const e of page) {
            const tier = e.confidence ?? 'extracted';
            confidenceByTier[tier] = (confidenceByTier[tier] ?? 0) + 1;
            degreeById.set(e.sourceId, (degreeById.get(e.sourceId) ?? 0) + 1);
            degreeById.set(e.targetId, (degreeById.get(e.targetId) ?? 0) + 1);
            endpointIds.add(e.sourceId);
            endpointIds.add(e.targetId);
        }
        if (page.length < EDGE_PAGE) break;
    }
    return { confidenceByTier, degreeById, endpointIds };
}

export interface HubRow {
    id: string;
    label: string;
    type: string;
    deg: number;
}

/**
 * computeTopHubs — rank `degreeById` and hydrate the winners' label/type.
 *
 * Deterministic tie-break: the source Cypher (`ORDER BY deg DESC LIMIT $n`,
 * no tie-break clause) sorted equal-degree nodes in whatever order Kùzu's
 * `COUNT{}` subquery happened to enumerate them — not a documented or
 * stable order. `id` ascending here makes it explicit and reproducible.
 * (`degreeById` only ever holds ids that appeared on ≥1 edge, so every entry
 * is already > 0 — the source Cypher's `WHERE deg > 0` has nothing to do.)
 *
 * Hydrates in topN-sized batches and skips any id that fails to hydrate. The
 * old Cypher (`MATCH (n:LoreNode) WITH n, COUNT{...}`) could only ever
 * surface a hub whose node row still exists — a dangling edge (an endpoint
 * id with no backing node) is structurally invisible to it. Skipping here
 * preserves that: it never renders a blank-label row the old query could
 * not have produced.
 */
export async function computeTopHubs(
    graph: ReportGraph,
    degreeById: ReadonlyMap<string, number>,
    topN: number,
): Promise<HubRow[]> {
    const ranked = Array.from(degreeById.entries())
        .sort(([idA, degA], [idB, degB]) => degB - degA || (idA < idB ? -1 : idA > idB ? 1 : 0));

    const out: HubRow[] = [];
    for (let i = 0; i < ranked.length && out.length < topN; i += topN) {
        const batch = ranked.slice(i, i + topN);
        const hydrated = await graph.getNodesByIds(batch.map(([id]) => id));
        for (const [id, deg] of batch) {
            const node = hydrated.get(id);
            if (!node) continue;
            out.push({ id, deg, label: node.label, type: node.type });
            if (out.length >= topN) break;
        }
    }
    return out;
}

export interface RecentRow {
    id: string;
    label: string;
    type: string;
    updatedAt: string;
}

/**
 * computeRecentlyUpdated — the `limit` most recently updated nodes with a
 * real `updatedAt` timestamp.
 *
 * `bulkListProjected` already orders `(updatedAt DESC, id ASC)` — that IS
 * the explicit tie-break the source Cypher's bare `ORDER BY n.updatedAt DESC`
 * lacked, so this is strictly more deterministic, not merely equivalent.
 * Walks pages of it and keeps rows whose `updatedAt` is a non-empty string,
 * matching the source Cypher's `WHERE n.updatedAt IS NOT NULL AND
 * n.updatedAt <> ''` filter, which `bulkListProjected` does not apply on
 * its own.
 */
export async function computeRecentlyUpdated(graph: ReportGraph, limit: number): Promise<RecentRow[]> {
    const out: RecentRow[] = [];
    let cursor: BulkListCursor | null = null;
    do {
        const { rows, nextCursor } = await graph.bulkListProjected(
            '*', ['label', 'type', 'updatedAt'], DEFAULT_MAINTENANCE_PAGE_SIZE, cursor,
        );
        for (const r of rows) {
            const updatedAt = r['updatedAt'];
            if (typeof updatedAt !== 'string' || updatedAt === '') continue;
            out.push({
                id: String(r['id'] ?? ''),
                label: String(r['label'] ?? ''),
                type: String(r['type'] ?? ''),
                updatedAt,
            });
            if (out.length >= limit) return out;
        }
        cursor = nextCursor;
    } while (cursor);
    return out;
}

export interface OrphanRow {
    id: string;
    label: string;
    type: string;
}

/**
 * computeOrphans — nodes that are not the source or target of any edge.
 *
 * Walks the node table via `bulkListProjected` (`updatedAt DESC, id ASC`)
 * and keeps rows whose id is absent from `endpointIds` (built by
 * `computeEdgeAggregates`), up to `limit`. The source Cypher had no
 * `ORDER BY` on this query at all — its result order was whatever Kùzu's
 * internal node-scan happened to produce, undocumented and not guaranteed
 * stable across runs or versions. This is a genuine ordering IMPROVEMENT,
 * not a preserved behavior: same orphan set (up to `limit`), now in a
 * defined, reproducible order. Nothing downstream depended on the old order
 * being any particular thing — it wasn't one.
 */
export async function computeOrphans(
    graph: ReportGraph,
    endpointIds: ReadonlySet<string>,
    limit: number,
): Promise<OrphanRow[]> {
    const out: OrphanRow[] = [];
    let cursor: BulkListCursor | null = null;
    do {
        const { rows, nextCursor } = await graph.bulkListProjected(
            '*', ['label', 'type'], DEFAULT_MAINTENANCE_PAGE_SIZE, cursor,
        );
        for (const r of rows) {
            const id = String(r['id'] ?? '');
            if (endpointIds.has(id)) continue;
            out.push({ id, label: String(r['label'] ?? ''), type: String(r['type'] ?? '') });
            if (out.length >= limit) return out;
        }
        cursor = nextCursor;
    } while (cursor);
    return out;
}
