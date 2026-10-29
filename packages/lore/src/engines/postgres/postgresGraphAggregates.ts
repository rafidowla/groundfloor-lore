/**
 * postgres/postgresGraphAggregates.ts — projection + aggregation reads for
 * PostgresGraph. Mirrors `engines/sqlite/sqliteGraphAggregates.ts`
 * field-for-field, using the SAME shared `graphShared/keysetPage.ts` cursor
 * builder, so `bulkList`/`bulkListProjected` paging is byte-identical to
 * SurrealGraph's and SqliteGraph's by construction.
 */

import { withPartitionKeyProperty } from '../graphShared/partitionKey.js';
import { normalizeTag } from '../normalizeTags.js';
import type { BulkListPage, BulkListQuery, EdgeQuery, GraphStats, LoreEdge } from '../../providers/types.js';
import { clampLimit } from '../topologyOverviewFold.js';
import { buildKeysetPage } from '../graphShared/keysetPage.js';
import type { Pool } from 'pg';
import { fromPgNodeRow, pgError, PgParams, pgColumn } from './postgresGraphRow.js';
import { edgeFromRow, edgeSelectList, EDGE_ENDPOINT_JOINS, skOf, type EdgeRow } from './postgresEdgeSql.js';

/**
 * The WHERE fragments shared by {@link queryEdges} and the keyset page (postgresEdgeKeyset.ts). `$1` is the
 * workspace. The endpoint filters resolve the text id to its surrogate key (a missing node matches nothing);
 * a `source` filter rides the primary key's (workspace_id, src_sk) prefix, a `target` filter the dst_sk index.
 */
export function edgeFilters(params: PgParams, q: Pick<EdgeQuery, 'source' | 'target' | 'relation' | 'includeInvalidated'>): string[] {
    const filters: string[] = [];
    if (q.source) filters.push(`e.src_sk = ${skOf('$1', params.add(q.source))}`);
    if (q.target) filters.push(`e.dst_sk = ${skOf('$1', params.add(q.target))}`);
    if (q.relation) filters.push(`e.relation = ${params.add(q.relation)}`);
    // Default reads see live edges only; soft-invalidated rows are opt-in (design D3).
    if (!q.includeInvalidated) filters.push('e.valid_to IS NULL');
    return filters;
}

/**
 * queryEdges — paginated edge query, deterministically ordered by the TEXT ids
 * `(source_id, target_id, relation)` — the order SurrealGraph and SqliteGraph return, and the order the
 * limit/offset callers (HTTP edges route sealed cursors, workspace export, migrations) already depend on.
 * The table is keyed by integer surrogate keys (layout 2), so the ids come from a join on `nodes.sk`; with
 * `LIMIT` the planner walks `nodes` in id order and probes the edge primary key per node (incremental
 * sort on the remaining columns), so a deep page costs the offset, not a full sort. Bulk scans that must
 * not pay O(offset) per page use the keyset form instead: `PostgresGraph.queryEdgesPage`
 * (postgresEdgeKeyset.ts), which pages on the physical key.
 */
export async function queryEdges(pool: Pool, workspaceId: string, q: EdgeQuery): Promise<LoreEdge[]> {
    const params = new PgParams();
    params.add(workspaceId);
    const filters = edgeFilters(params, q);
    try {
        const res = await pool.query(
            `SELECT ${edgeSelectList(q.includeProvenance === true)} FROM edges e${EDGE_ENDPOINT_JOINS}`
            + ` WHERE e.workspace_id = $1${filters.map((f) => ` AND ${f}`).join('')}`
            + ' ORDER BY s.id, t.id, e.relation LIMIT $' + (params.values.length + 1) + '::int'
            + ' OFFSET $' + (params.values.length + 2) + '::int',
            [...params.values, q.limit, q.offset],
        );
        return (res.rows as EdgeRow[]).map((row) => edgeFromRow(row, q.includeProvenance === true));
    } catch (error) {
        throw pgError('Failed to query edges', 'queryEdges', error);
    }
}

/**
 * getEdge — the one edge with this exact (source, target, relation) triple, or
 * null. A primary-key lookup (endpoints resolved to their surrogate keys first); the write-failure rollback
 * in the edge routes reads it once per written triple, so it must never scan the table.
 */
export async function getEdge(
    pool: Pool, workspaceId: string, sourceId: string, targetId: string, relation: string,
    opts: Pick<EdgeQuery, 'includeProvenance' | 'includeInvalidated'> = {},
): Promise<LoreEdge | null> {
    try {
        const res = await pool.query(
            `SELECT ${edgeSelectList(opts.includeProvenance === true)} FROM edges e${EDGE_ENDPOINT_JOINS}`
            + ` WHERE e.workspace_id = $1 AND e.src_sk = ${skOf('$1', '$2')} AND e.dst_sk = ${skOf('$1', '$3')} AND e.relation = $4`
            + `${opts.includeInvalidated ? '' : ' AND e.valid_to IS NULL'}`,
            [workspaceId, sourceId, targetId, relation],
        );
        const row = res.rows[0] as EdgeRow | undefined;
        if (!row) return null;
        return edgeFromRow(row, opts.includeProvenance === true);
    } catch (error) {
        throw pgError('Failed to read edge', 'getEdge', error);
    }
}

/** getStats — node count (summed from the type breakdown), edge count, per-type breakdown. Same three rules as the sqlite aggregates. */
export async function getStats(pool: Pool, workspaceId: string, projectFilter?: string): Promise<GraphStats> {
    try {
        const typeRes = projectFilter
            ? await pool.query(`SELECT type, COUNT(*) AS c FROM nodes WHERE workspace_id = $1 AND project = $2 GROUP BY type`, [workspaceId, projectFilter])
            : await pool.query(`SELECT type, COUNT(*) AS c FROM nodes WHERE workspace_id = $1 GROUP BY type`, [workspaceId]);
        const typeBreakdown: Record<string, number> = {};
        let nodeCount = 0;
        for (const row of typeRes.rows as Array<{ type: string; c: number }>) {
            const type = String(row.type ?? '');
            const count = Number(row.c ?? 0);
            nodeCount += count;
            if (type) typeBreakdown[type] = (typeBreakdown[type] ?? 0) + count;
        }
        const edgeRes = projectFilter
            ? await pool.query(
                `SELECT COUNT(*) AS c FROM edges e
                 JOIN nodes ns ON ns.workspace_id = e.workspace_id AND ns.sk = e.src_sk
                 JOIN nodes nt ON nt.workspace_id = e.workspace_id AND nt.sk = e.dst_sk
                 WHERE e.workspace_id = $1 AND e.valid_to IS NULL AND ns.project = $2 AND nt.project = $2`,
                [workspaceId, projectFilter],
            )
            : await pool.query(`SELECT COUNT(*) AS c FROM edges WHERE workspace_id = $1 AND valid_to IS NULL`, [workspaceId]);
        return { nodeCount, edgeCount: Number((edgeRes.rows[0] as { c: number } | undefined)?.c ?? 0), typeBreakdown };
    } catch (error) {
        throw pgError('Failed to compute graph stats', 'getStats', error);
    }
}

/** getTopology — bounded node + edge slice for the network view. Same intra-set-coupling filter as the sqlite aggregates. */
export async function getTopology(
    pool: Pool, workspaceId: string,
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
        // Deterministic order — `id` is inside the `nodes` table's PRIMARY KEY,
        // so this ORDER BY is index-order, not a sort step. Matches
        // SurrealGraph's and SqliteGraph's getTopology.
        const params = new PgParams();
        params.add(workspaceId);
        const projectFilter = scoped ? ` AND project = ANY(${params.add(projectsList)})` : '';
        const nodeRes = await pool.query(
            `SELECT * FROM nodes WHERE workspace_id = $1${projectFilter} ORDER BY id LIMIT ${params.add(nodeLimit)}::int`,
            params.values,
        );
        const nonEmpty = (row: Record<string, unknown>, key: string): string | null => {
            const value = row[key];
            return typeof value === 'string' && value.length > 0 ? value : null;
        };
        const nodes = nodeRes.rows.map((raw) => {
            const row = fromPgNodeRow(raw);
            return {
                id: row['id'], label: row['label'], type: row['type'], project: row['project'],
                group: row['type'],
                supersededBy: nonEmpty(row, 'supersededBy'),
                supersededAt: nonEmpty(row, 'supersededAt'),
                supersededReason: nonEmpty(row, 'supersededReason'),
            };
        });

        const visible = new Set(nodes.map((n) => String(n.id)));
        const edgeRes = await pool.query(
            `SELECT ${edgeSelectList(false)} FROM edges e${EDGE_ENDPOINT_JOINS}`
            + ' WHERE e.workspace_id = $1 AND e.valid_to IS NULL ORDER BY s.id, t.id, e.relation LIMIT $2::int',
            [workspaceId, eLimit],
        );
        const edges: Array<Record<string, unknown>> = [];
        for (const row of edgeRes.rows as Array<{ source_id: string; target_id: string; relation: string; confidence: string; confidenceScore: number }>) {
            if (scoped && !(visible.has(row.source_id) && visible.has(row.target_id))) continue;
            edges.push({
                from: row.source_id, to: row.target_id, label: row.relation,
                confidence: row.confidence ?? 'extracted',
                confidenceScore: row.confidenceScore ?? 1.0,
            });
        }
        return { nodes, edges };
    } catch (error) {
        throw pgError('Failed to extract graph topology', 'getTopology', error);
    }
}

/** Exact column set — same as the sqlite aggregates' BULK_LIST_COLUMNS. */
const BULK_LIST_COLUMNS = [
    'id', 'type', 'label', 'content', 'tags', 'metadata',
    'project', 'ecosystem', 'updatedAt', 'createdAt', 'security_scopes', 'revision', 'partition_key',
] as const;

/** bulkList — cursor-paginated enumeration on (updatedAt DESC, id ASC). Same keyset contract as the sqlite aggregates. */
export async function bulkList(pool: Pool, workspaceId: string, q: BulkListQuery): Promise<BulkListPage> {
    const limit = Math.min(Math.max(Math.trunc(q.limit), 1), 1000);
    const params = new PgParams();
    params.add(workspaceId);
    const filters: string[] = [];
    if (q.types && q.types.length > 0) {
        filters.push(`type = ANY(${params.add(q.types)})`);
    }
    if (q.tags && q.tags.length > 0) {
        const lowered = q.tags.map((t) => normalizeTag(t));
        filters.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ANY(${params.add(lowered)}))`);
    }
    if (q.project) { filters.push(`project = ${params.add(q.project)}`); }
    if (q.ecosystem && q.ecosystem !== '*') {
        filters.push(`(ecosystem = ${params.add(q.ecosystem)} OR ecosystem = '*' OR ecosystem = '')`);
    }
    if (q.cursor) {
        filters.push(`("updatedAt" < ${params.add(q.cursor.updatedAt)} OR ("updatedAt" = ${params.add(q.cursor.updatedAt)} AND id > ${params.add(q.cursor.id)}))`);
    }
    const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    try {
        const res = await pool.query(
            `SELECT ${BULK_LIST_COLUMNS.map(pgColumn).join(', ')} FROM nodes WHERE workspace_id = $1${where}`
            + ` ORDER BY "updatedAt" DESC, id ASC LIMIT ${params.add(limit + 1)}::int`,
            params.values,
        );
        const normalized = res.rows.map((row) => withPartitionKeyProperty(fromPgNodeRow(row)));
        const { page, hasMore, nextCursor } = buildKeysetPage(normalized, limit);
        return { nodes: page, hasMore, nextCursor };
    } catch (error) {
        throw pgError('Failed to bulk-list nodes', 'bulkList', error);
    }
}

/**
 * loadNodeColumns — one information_schema lookup of the `nodes` table's
 * column names. The schema is fixed at initialize (ensureGraphSchema runs
 * before any read); the caller memoizes the returned promise per graph
 * instance (the sqlite aggregates keyed the same cache by db handle in a
 * WeakMap; here the handle IS the class instance).
 */
export async function loadNodeColumns(pool: Pool): Promise<ReadonlySet<string>> {
    const res = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'",
    );
    return new Set(res.rows.map((r) => r.column_name));
}

/**
 * bulkListProjected — keyset-paged node scan, requested columns only. Same
 * contract as the sqlite aggregates, with the same engine difference: a
 * requested column that is not in the table (e.g. `legalHold`, which Lore
 * never persists on either engine) is returned as `NULL` for every row
 * instead of throwing "column does not exist". Callers treat null/absent
 * identically. Identifiers are validated with the SHARED `assertIdent` (via
 * `pgColumn`) before being interpolated — and double-quoted, because the
 * schema deliberately keeps the mixed-case SQLite column names.
 */
export async function bulkListProjected(
    pool: Pool, workspaceId: string,
    project: string,
    columns: readonly string[],
    limit: number,
    cursor: { updatedAt: string; id: string } | null,
    nodeColumns: Promise<ReadonlySet<string>>,
): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }> {
    const wanted = Array.from(new Set<string>(['id', 'updatedAt', ...columns]));
    const filters: string[] = [];
    const params = new PgParams();
    params.add(workspaceId);
    if (project !== '*') { filters.push(`project = ${params.add(project)}`); }
    if (cursor) {
        filters.push(`("updatedAt" < ${params.add(cursor.updatedAt)} OR ("updatedAt" = ${params.add(cursor.updatedAt)} AND id > ${params.add(cursor.id)}))`);
    }
    const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    try {
        const have = await nodeColumns;
        const select = wanted.map((c) => (have.has(c) ? pgColumn(c) : `NULL AS ${pgColumn(c)}`)).join(', ');
        const res = await pool.query(
            `SELECT ${select} FROM nodes WHERE workspace_id = $1${where}`
            + ` ORDER BY "updatedAt" DESC, id ASC LIMIT ${params.add(limit + 1)}::int`,
            params.values,
        );
        const normalized = res.rows.map((row) => (
            wanted.includes('tags') || wanted.includes('security_scopes') ? fromPgNodeRow(row) : row
        ));
        const { page, nextCursor } = buildKeysetPage(normalized, limit);
        return { rows: page, nextCursor };
    } catch (error) {
        throw pgError('Failed to page nodes', 'bulkListProjected', error);
    }
}

/**
 * listNodesByIdPrefix — rows whose id starts with `prefix` (exact, case-sensitive; LIKE metacharacters in the
 * prefix are escaped), requested columns only, ordered like bulkListProjected. Uses idx_nodes_id_prefix
 * (workspace_id, id text_pattern_ops), so the cost is the size of the matching set, not the corpus.
 */
export async function listNodesByIdPrefix(
    pool: Pool, workspaceId: string, prefix: string, columns: readonly string[],
    nodeColumns: Promise<ReadonlySet<string>>,
): Promise<Array<Record<string, unknown>>> {
    const wanted = Array.from(new Set<string>(['id', 'updatedAt', ...columns]));
    try {
        const have = await nodeColumns;
        const select = wanted.map((c) => (have.has(c) ? pgColumn(c) : `NULL AS ${pgColumn(c)}`)).join(', ');
        const like = prefix.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
        const res = await pool.query(
            `SELECT ${select} FROM nodes WHERE workspace_id = $1 AND id LIKE $2 ORDER BY "updatedAt" DESC, id ASC`,
            [workspaceId, like],
        );
        return res.rows.map((row) => (
            wanted.includes('tags') || wanted.includes('security_scopes') ? fromPgNodeRow(row) : row
        ));
    } catch (error) {
        throw pgError('Failed to list nodes by id prefix', 'listNodesByIdPrefix', error);
    }
}
