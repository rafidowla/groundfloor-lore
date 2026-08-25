/**
 * surrealGraphAggregates.ts — projection + aggregation reads for SurrealGraph.
 *
 * `queryEdges`, `getStats`, `getTopology`, `bulkList`. Split out for the same
 * reason LocalGraph keeps graphEdges / graphStats / graphTopology /
 * graphBulkList as separate modules: these are shaped for a specific
 * caller (an HTTP route, the network view, a paginating client) rather than
 * for the graph contract, and they are the part most likely to grow.
 *
 * Each function takes the engine's bound `SurrealQuery` runner and nothing
 * else, so none of them can reach into engine internals or lifecycle.
 *
 * Output shapes are pinned to their Kùzu counterparts field for field —
 * including the empty-string → null coercion on the supersession fields and
 * the `extracted` / `1.0` edge-confidence defaults — because these feed the
 * same routes regardless of which engine backs the workspace.
 */

import type {
    BulkListPage,
    BulkListQuery,
    EdgeQuery,
    GraphStats,
    LoreEdge,
} from '../../providers/types.js';
import { surrealError } from './surrealError.js';
import type { SurrealQuery } from './surrealGraphReads.js';
import {
    EDGE_TABLE,
    NODE_COUNT_VIEW,
    NODE_TABLE,
    normalizeRow,
    ridToId,
    toNodeRid,
} from './surrealRecordId.js';
import { clampLimit } from '../topologyOverviewFold.js';
import { assertIdent } from '../whereClause.js';

/**
 * queryEdges — paginated edge query, mirroring the GET /api/edges contract
 * (confidence/score defaulted so callers can render directly).
 */
export async function queryEdges(query: SurrealQuery, q: EdgeQuery): Promise<LoreEdge[]> {
    const vars: Record<string, unknown> = { limit: q.limit, offset: q.offset };
    const filters: string[] = [];
    if (q.source) { filters.push('in = $source'); vars['source'] = toNodeRid(q.source, 'queryEdges'); }
    if (q.target) { filters.push('out = $target'); vars['target'] = toNodeRid(q.target, 'queryEdges'); }
    if (q.relation) { filters.push('relation = $relation'); vars['relation'] = q.relation; }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    try {
        const rows = await query(
            // NO `ORDER BY`. It used to sort by relation, which is not in the
            // EdgeQuery contract, is not what LocalGraph does (its Cypher has
            // no ORDER BY either), and cost a full sort of every matching edge
            // on EVERY page. Enumerating 51,934 edges in 1,000-row pages spent
            // ~150 ms per page sorting the same 51,934 rows again — 9,227 ms
            // total, against 407 ms unsorted, with all 51,934 distinct edges
            // still recovered. SurrealDB returns record-id order, which is
            // stable across pages, so pagination stays coherent.
            `SELECT in, out, relation, confidence, confidenceScore FROM ${EDGE_TABLE}${where}`
            + ' LIMIT $limit START $offset',
            vars,
        );
        return rows.map((row) => ({
            sourceId: ridToId(row['in']),
            targetId: ridToId(row['out']),
            relation: row['relation'] as string,
            confidence: (row['confidence'] as LoreEdge['confidence']) ?? 'extracted',
            confidenceScore: typeof row['confidenceScore'] === 'number' ? row['confidenceScore'] : 1.0,
        }));
    } catch (error) {
        throw surrealError('Failed to query edges', 'queryEdges', error);
    }
}

/**
 * getStats — node count, edge count, and the per-type breakdown.
 *
 * Three behaviours are pinned to `graphStats.computeGraphStats` because the
 * parity harness compares this output field for field:
 *
 *   1. `nodeCount` is summed from the type breakdown, not counted separately.
 *      Two independent counts can disagree under a concurrent write, and a
 *      total that doesn't equal the sum of its parts reads as corruption.
 *      (Kùzu issues a separate `count(n)`; on a quiescent graph the values are
 *      identical, and the parity test asserts exactly that.)
 *   2. Nodes with an EMPTY type are excluded from the breakdown — Kùzu's
 *      `if (nodeType)` guard. Without this, a Surreal-backed workspace grows a
 *      phantom `""` bucket that no caller expects.
 *   3. A `projectFilter` scopes EDGES to those whose BOTH endpoints carry the
 *      project (edges are not project-tagged in the floor schema), not just
 *      the nodes. Counting all edges under a project filter would inflate the
 *      number on every multi-project workspace.
 */
export async function getStats(
    query: SurrealQuery,
    projectFilter?: string,
    features?: { countView?: boolean },
): Promise<GraphStats> {
    try {
        const vars = projectFilter ? { project: projectFilter } : {};

        // The type breakdown is the expensive half. With the pre-computed view
        // it is a keyed read of a handful of pre-aggregated rows instead of a
        // full table scan (measured 42.4 ms → 0.4 ms at 20 000 nodes). Serial
        // writes, or writers spread across distinct (project, type) groups,
        // get byte-identical numbers either way. Under CONCURRENT writers
        // sharing one group, the view's maintained count can silently drift
        // low (a surrealdb-core 3.0.2 lost-update on the view's own write
        // path) even though the underlying node rows all land correctly —
        // this is why `countView` defaults OFF (SurrealFeatures.countView).
        const typeRows = features?.countView
            ? await query(
                `SELECT type, c FROM ${NODE_COUNT_VIEW}${projectFilter ? ' WHERE project = $project' : ''}`,
                vars,
            )
            : await query(
                `SELECT type, count() AS c FROM ${NODE_TABLE}${projectFilter ? ' WHERE project = $project' : ''} GROUP BY type`,
                vars,
            );

        const typeBreakdown: Record<string, number> = {};
        let nodeCount = 0;
        for (const row of typeRows) {
            const type = String(row['type'] ?? '');
            const count = Number(row['c'] ?? 0);
            nodeCount += count;
            // The view groups by (project, type), so an unscoped read returns
            // one row per project per type and the same type appears more than
            // once — accumulate rather than assign.
            if (type) typeBreakdown[type] = (typeBreakdown[type] ?? 0) + count;
        }

        // Edge count stays a live count(): a view over the RELATION table is
        // broken upstream (never decrements; can panic the engine — see
        // surrealConnection.ts COUNT_VIEW_STATEMENTS) and it was never the
        // expensive half, measuring 1.9 ms at 20 000 edges.
        const edgeRows = await query(
            projectFilter
                ? `SELECT count() AS c FROM ${EDGE_TABLE} WHERE in.project = $project AND out.project = $project GROUP ALL`
                : `SELECT count() AS c FROM ${EDGE_TABLE} GROUP ALL`,
            vars,
        );
        return { nodeCount, edgeCount: Number(edgeRows[0]?.['c'] ?? 0), typeBreakdown };
    } catch (error) {
        throw surrealError('Failed to compute graph stats', 'getStats', error);
    }
}

/**
 * getTopology — bounded node + edge slice for the network view.
 *
 * When scoped to a project set, an edge is kept only if BOTH endpoints are in
 * the set (intra-set coupling), matching computeTopology. Filtering in JS
 * rather than in the query keeps that rule identical to the Kùzu path instead
 * of re-deriving it in a second dialect.
 */
export async function getTopology(
    query: SurrealQuery,
    limit: number = 300,
    projects?: string[] | string,
    edgeLimit?: number,
): Promise<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> {
    const nodeLimit = clampLimit(limit);
    const eLimit = clampLimit(edgeLimit ?? Math.min(nodeLimit * 4, 20_000));
    const projectsList = Array.isArray(projects)
        ? projects.filter((p) => p && p.trim().length > 0)
        : (projects && projects.trim().length > 0 ? [projects] : []);
    const scoped = projectsList.length > 0;

    try {
        const nodeRows = await query(
            `SELECT * FROM ${NODE_TABLE}${scoped ? ' WHERE project IN $projects' : ''} LIMIT $limit`,
            scoped ? { projects: projectsList, limit: nodeLimit } : { limit: nodeLimit },
        );
        const nodes = nodeRows.map((raw) => {
            const row = normalizeRow(raw);
            const nonEmpty = (key: string): string | null => {
                const value = row[key];
                return typeof value === 'string' && value.length > 0 ? value : null;
            };
            return {
                id: row['id'],
                label: row['label'],
                type: row['type'],
                project: row['project'],
                group: row['type'],
                supersededBy: nonEmpty('supersededBy'),
                supersededAt: nonEmpty('supersededAt'),
                supersededReason: nonEmpty('supersededReason'),
            };
        });

        const visible = new Set(nodes.map((n) => String(n.id)));
        const edgeRows = await query(
            `SELECT in, out, relation, confidence, confidenceScore FROM ${EDGE_TABLE} LIMIT $limit`,
            { limit: eLimit },
        );
        const edges: Array<Record<string, unknown>> = [];
        for (const row of edgeRows) {
            const from = ridToId(row['in']);
            const to = ridToId(row['out']);
            if (scoped && !(visible.has(from) && visible.has(to))) continue;
            edges.push({
                from,
                to,
                label: row['relation'],
                confidence: row['confidence'] ?? 'extracted',
                confidenceScore: row['confidenceScore'] ?? 1.0,
            });
        }
        return { nodes, edges };
    } catch (error) {
        throw surrealError('Failed to extract graph topology', 'getTopology', error);
    }
}

/**
 * The exact column set `graphBulkList.bulkListNodes` projects.
 *
 * `SELECT *` would be easier and WRONG: SCHEMALESS storage would then hand
 * POST /api/nodes/bulk-list every internal field the engine happens to keep
 * (supersededBy/At/Reason, ephemeral, ttl_ms, stale, status, classification,
 * anchor_stale*, lastAccessedAt, last_retrieved_at, syncedAt, language,
 * outcome counters) — a wire shape that differs from the Kùzu-backed answer
 * for the same request. Callers would start depending on fields that vanish
 * the moment a workspace moves back to Kùzu.
 */
const BULK_LIST_COLUMNS = [
    'id', 'type', 'label', 'content', 'tags', 'metadata',
    'project', 'ecosystem', 'updatedAt', 'createdAt', 'security_scopes',
] as const;

/**
 * bulkList — cursor-paginated enumeration on (updatedAt DESC, id ASC).
 *
 * The cursor is a stable POSITION, not an offset, so a concurrent write cannot
 * make a page skip or repeat a row. Fetches limit+1 to compute `hasMore`
 * without a second count query. Cursor predicate, ordering, page size and
 * projection all match `graphBulkList.bulkListNodes` exactly.
 */
export async function bulkList(query: SurrealQuery, q: BulkListQuery): Promise<BulkListPage> {
    const limit = Math.min(Math.max(Math.trunc(q.limit), 1), 1000);
    const vars: Record<string, unknown> = { limit: limit + 1 };
    const filters: string[] = [];
    if (q.types && q.types.length > 0) { filters.push('type IN $types'); vars['types'] = q.types; }
    if (q.tags && q.tags.length > 0) {
        filters.push('tags ANYINSIDE $tags');
        vars['tags'] = q.tags.map((t) => t.toLowerCase());
    }
    if (q.project) { filters.push('project = $project'); vars['project'] = q.project; }
    // '*'/''/NONE on the ROW is a WILDCARD (core/ecosystemMatch.ts
    // `isUnscopedEcosystem`) — the pushdown must never drop a row the JS
    // filter would keep. Was strict equality, so a scoped bulkList hid every
    // node written with the schema default. R5 #6: the `NONE` arm was also
    // missing here while all three sibling Surreal predicates
    // (surrealGraphReads search + listNodes, surrealGraphDirected) carry it,
    // so a legacy/imported row with `ecosystem` unset was still dropped by the
    // pushdown and kept by `ecosystemMatches` — the same fail-closed on a
    // narrower input class.
    if (q.ecosystem && q.ecosystem !== '*') {
        filters.push(`(ecosystem = $ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem = NONE)`);
        vars['ecosystem'] = q.ecosystem;
    }
    if (q.cursor) {
        filters.push('(updatedAt < $cursorUpdatedAt OR (updatedAt = $cursorUpdatedAt AND id > $cursorId))');
        vars['cursorUpdatedAt'] = q.cursor.updatedAt;
        vars['cursorId'] = toNodeRid(q.cursor.id, 'bulkList');
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    try {
        const rows = await query(
            `SELECT ${BULK_LIST_COLUMNS.join(', ')} FROM ${NODE_TABLE}${where}`
            + ' ORDER BY updatedAt DESC, id ASC LIMIT $limit',
            vars,
        );
        const hasMore = rows.length > limit;
        const page = (hasMore ? rows.slice(0, limit) : rows).map((row) => normalizeRow(row));
        const last = page[page.length - 1];
        return {
            nodes: page,
            hasMore,
            nextCursor: hasMore && last
                ? { updatedAt: String(last['updatedAt'] ?? ''), id: String(last['id'] ?? '') }
                : null,
        };
    } catch (error) {
        throw surrealError('Failed to bulk-list nodes', 'bulkList', error);
    }
}

/**
 * bulkListProjected — keyset-paged node scan returning ONLY the requested
 * columns.
 *
 * The SurrealDB half of the engine-agnostic maintenance scan. Five callers
 * (consistency, corpus health, supersession candidates, the retention sweep and
 * `list_nodes`) walk every node in bounded pages, and every one of them did it
 * by reaching through `getGraphContext().queryRows` with hand-written Cypher —
 * which is why they were Kùzu-only.
 *
 * Same keyset contract as `bulkList` above and as the Kùzu implementation:
 * `ORDER BY updatedAt DESC, id ASC`, strict-after cursor, `LIMIT n + 1` to
 * detect a further page. It must match exactly, because the parity suite
 * compares the two engines page for page.
 *
 * `id` and `updatedAt` are always projected regardless of `columns`: they are
 * the cursor, so a caller that omitted them would page forever.
 */
export async function bulkListProjected(
    query: SurrealQuery,
    project: string,
    columns: readonly string[],
    limit: number,
    cursor: { updatedAt: string; id: string } | null,
): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }> {
    const wanted = Array.from(new Set<string>(['id', 'updatedAt', ...columns]));
    // SW-01: column names are interpolated (SurrealQL has no parameter slot
    // for an identifier), so every one is validated before it reaches the query.
    for (const c of wanted) assertIdent(c);
    const vars: Record<string, unknown> = { limit: limit + 1 };
    const filters: string[] = [];
    if (project !== '*') { filters.push('project = $project'); vars['project'] = project; }
    if (cursor) {
        filters.push('(updatedAt < $cursorUpdatedAt OR (updatedAt = $cursorUpdatedAt AND id > $cursorId))');
        vars['cursorUpdatedAt'] = cursor.updatedAt;
        vars['cursorId'] = toNodeRid(cursor.id, 'bulkListProjected');
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    try {
        const rows = await query(
            `SELECT ${wanted.join(', ')} FROM ${NODE_TABLE}${where}`
            + ' ORDER BY updatedAt DESC, id ASC LIMIT $limit',
            vars,
        );
        const hasMore = rows.length > limit;
        const page = (hasMore ? rows.slice(0, limit) : rows).map((row) => normalizeRow(row));
        const last = page[page.length - 1];
        return {
            rows: page,
            nextCursor: hasMore && last
                ? { updatedAt: String(last['updatedAt'] ?? ''), id: String(last['id'] ?? '') }
                : null,
        };
    } catch (error) {
        throw surrealError('Failed to page nodes', 'bulkListProjected', error);
    }
}
