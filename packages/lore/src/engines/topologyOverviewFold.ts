/**
 * topologyOverviewFold.ts — the engine-agnostic half of the topology overview.
 *
 * `getTopologyOverview` and `getTopologyOverviewByType` are three simple
 * grouped counts plus about ninety lines of JavaScript folding. Only the three
 * queries are engine-specific; every rule that decides what the answer MEANS —
 * how an empty project collapses to `Global`, that intra-group edges are
 * excluded, how types sort within a blob, what `truncated` means — is plain
 * JavaScript over rows.
 *
 * Sharing the fold is what makes the two engines agree by construction rather
 * than by review. Reimplementing it beside a SurrealQL query would have
 * duplicated those rules, and a divergence would show up as a chord diagram
 * that is subtly wrong on one engine — the kind of difference nobody notices
 * until they are comparing two screenshots.
 */

/**
 * The SP-21 scan caps. Applied by each engine's query layer, reported by the
 * fold. They live HERE, not beside one engine's queries, because `truncated`
 * is computed from the node cap: two engines with two copies of the number
 * would disagree about whether a result was complete.
 */
export const TOPOLOGY_OVERVIEW_NODE_CAP = 50_000;
export const TOPOLOGY_OVERVIEW_EDGE_CAP = 200_000;

/**
 * SECURITY (SP-05): coerce a LIMIT value to a safe non-negative integer
 * before it reaches a query. Born in graphTopology.ts, where the value was
 * string-interpolated into Cypher (Kùzu has no `$limit` parameter slot), so
 * a non-integer (e.g. `100; DROP TABLE`) would land arbitrary Cypher — moved
 * here (kuzu-removal Phase 3d) because the clamp is engine-agnostic: engines
 * that bind the limit keep the same guard, since a bound 10-billion is still
 * a 10-billion-row scan. NaN/negative → 0; values above `max` are clamped;
 * fractions are floored.
 */
export const TOPOLOGY_LIMIT_CEILING = 100000;
export function clampLimit(n: number, max: number = TOPOLOGY_LIMIT_CEILING): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(0, Math.floor(n)), max);
}

/** The bucket an empty / absent group value collapses into. */
const GLOBAL = 'Global';

export interface TopologyOverviewResult {
    blobs: Array<{ project: string; nodeCount: number; types: Array<{ type: string; count: number }> }>;
    aggregateEdges: Array<{ fromProject: string; toProject: string; count: number }>;
    totalNodes: number;
    truncated?: boolean;
}

/** One `{ group, count }` row. `group` is a project or a type. */
export interface GroupCountRow { group: string | null | undefined; count: number }
/** One `{ group, type, count }` row for the two-level hierarchy. */
export interface GroupTypeCountRow { group: string | null | undefined; type: string | null | undefined; count: number }
/** One edge endpoint pair, already projected to the grouping dimension. */
export interface EdgePairRow { from: string | null | undefined; to: string | null | undefined }

function bucket(raw: string | null | undefined): string {
    return typeof raw === 'string' && raw.length > 0 ? raw : GLOBAL;
}

/**
 * Fold pre-fetched rows into the overview payload.
 *
 * @param blobRows  one row per group with its node count
 * @param typeRows  one row per (group, type) with its count; pass `blobRows`-
 *                  shaped data with `type` set when grouping BY type, so a blob
 *                  still carries its own single type entry
 * @param edgeRows  endpoint pairs, already projected to the grouping dimension
 */
export function foldTopologyOverview(
    blobRows: readonly GroupCountRow[],
    typeRows: readonly GroupTypeCountRow[],
    edgeRows: readonly EdgePairRow[],
): TopologyOverviewResult {
    const blobMap = new Map<string, number>();
    let totalNodes = 0;
    for (const row of blobRows) {
        const key = bucket(row.group);
        const count = Number(row.count ?? 0);
        blobMap.set(key, (blobMap.get(key) ?? 0) + count);
        totalNodes += count;
    }
    // `truncated` means "the SCAN hit its cap", so it is a property of how many
    // rows came back, not of how many nodes were counted.
    const truncated = blobRows.length >= TOPOLOGY_OVERVIEW_NODE_CAP;

    const typesByGroup = new Map<string, Map<string, number>>();
    for (const row of typeRows) {
        const group = bucket(row.group);
        const type = String(row.type ?? 'unknown');
        const count = Number(row.count ?? 0);
        if (!typesByGroup.has(group)) typesByGroup.set(group, new Map());
        const inner = typesByGroup.get(group)!;
        inner.set(type, (inner.get(type) ?? 0) + count);
    }

    const blobs = Array.from(blobMap.entries())
        .map(([project, nodeCount]) => ({
            project,
            nodeCount,
            types: Array.from(typesByGroup.get(project) ?? new Map<string, number>())
                .map(([type, count]) => ({ type, count }))
                .sort((a, b) => b.count - a.count),
        }))
        .sort((a, b) => b.nodeCount - a.nodeCount);

    const edgeMap = new Map<string, number>();
    for (const row of edgeRows) {
        const from = bucket(row.from);
        const to = bucket(row.to);
        if (from === to) continue; // intra-group edges excluded — the diagram shows connections BETWEEN blobs
        const key = `${from}\x00${to}`;
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
    }
    const aggregateEdges = Array.from(edgeMap.entries()).map(([key, count]) => {
        const [fromProject, toProject] = key.split('\x00');
        return { fromProject: fromProject!, toProject: toProject!, count };
    });

    return { blobs, aggregateEdges, totalNodes, ...(truncated ? { truncated: true } : {}) };
}
