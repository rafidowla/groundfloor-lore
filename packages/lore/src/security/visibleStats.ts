/**
 * visibleStats.ts — visible-only graph totals for a BOUND non-operator.
 *
 * Builds, from the bounded scans in visibleCounts.ts, the numbers that stats,
 * lore_status, GET /api/topology (totalCoreNodes) and GET /api/topology/overview
 * would otherwise take from engine-side aggregates that count hidden rows too.
 * Callers short-circuit on countAudience() === 'visible' first; unbound and
 * operator callers never enter this module.
 *
 * Responses carrying these numbers are labelled with visibleCountLabel():
 * `countScope: 'visible'`, plus `countsLowerBound: true` when a scan hit its cap.
 */

import {
    countVisibleEdges,
    countVisibleNodes,
    forEachVisibleEdge,
    forEachVisibleNode,
    type VisibleCountGraph,
    type VisibleEdgeGraph,
} from './visibleCounts.js';
import {
    foldTopologyOverview,
    type EdgePairRow,
    type GroupCountRow,
    type GroupTypeCountRow,
    type TopologyOverviewResult,
} from '../engines/topologyOverviewFold.js';

export type VisibleStatsGraph = VisibleCountGraph & VisibleEdgeGraph;

export interface VisibleGraphStats {
    nodeCount: number;
    edgeCount: number;
    typeBreakdown: Record<string, number>;
    languageBreakdown?: Record<string, number>;
    lowerBound: boolean;
}

/**
 * Visible node / edge totals and breakdowns for one workspace graph. `project`
 * mirrors getStats(projectFilter): nodes tagged with it, edges with both ends
 * tagged with it. `cap` is for tests.
 */
export async function visibleGraphStats(
    graph: VisibleStatsGraph,
    opts: { project?: string; withLanguage?: boolean; cap?: number } = {},
): Promise<VisibleGraphStats> {
    const nodes = await countVisibleNodes(graph, {
        byType: true,
        byLanguage: opts.withLanguage === true,
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    });
    const edges = await countVisibleEdges(graph, {
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    });
    return {
        nodeCount: nodes.nodeCount,
        edgeCount: edges.edgeCount,
        typeBreakdown: nodes.typeBreakdown ?? {},
        ...(opts.withLanguage ? { languageBreakdown: nodes.languageBreakdown ?? {} } : {}),
        lowerBound: nodes.lowerBound || edges.lowerBound,
    };
}

/** The label fields a visible-only response carries. */
export function visibleCountLabel(lowerBound: boolean): { countScope: 'visible'; countsLowerBound?: true } {
    return { countScope: 'visible', ...(lowerBound ? { countsLowerBound: true as const } : {}) };
}

/**
 * GET /api/topology/overview for a bound non-operator: the engine's own fold
 * (foldTopologyOverview) fed only visible nodes and edges whose both endpoints
 * are visible, bounded by the visible-count cap rather than the fold's 50k/200k
 * engine caps. Same grouping rules as the engines (empty project -> 'Global',
 * intra-group edges excluded, types sorted within a blob).
 */
export async function visibleTopologyOverview(
    graph: VisibleStatsGraph,
    groupBy: 'project' | 'type',
    opts: { cap?: number } = {},
): Promise<{ overview: TopologyOverviewResult; lowerBound: boolean }> {
    const cap = opts.cap !== undefined ? { cap: opts.cap } : {};
    const groups = new Map<string, number>();
    const pairs = new Map<string, { group: string; type: string; count: number }>();
    const nodeScan = await forEachVisibleNode(graph, { ...cap, extraColumns: ['project'] }, (row) => {
        const type = String(row['type'] ?? '');
        const group = groupBy === 'type' ? type : String(row['project'] ?? '');
        groups.set(group, (groups.get(group) ?? 0) + 1);
        const key = `${group}\x00${type}`;
        const cur = pairs.get(key);
        if (cur) cur.count++; else pairs.set(key, { group, type, count: 1 });
    });
    const edgeRows: EdgePairRow[] = [];
    const edgeScan = await forEachVisibleEdge(graph, cap, (_e, s, t) => {
        edgeRows.push(groupBy === 'type' ? { from: s.type, to: t.type } : { from: s.project, to: t.project });
    });
    const blobRows: GroupCountRow[] = [...groups].map(([group, count]) => ({ group, count }));
    // By type a blob's own type list is its single grouping value, as in the engines.
    const typeRows: GroupTypeCountRow[] = groupBy === 'type'
        ? blobRows.map((b) => ({ group: b.group, type: b.group, count: b.count }))
        : [...pairs.values()];
    return {
        overview: foldTopologyOverview(blobRows, typeRows, edgeRows),
        lowerBound: nodeScan.lowerBound || edgeScan.lowerBound,
    };
}
