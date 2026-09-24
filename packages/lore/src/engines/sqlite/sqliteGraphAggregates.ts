/**
 * sqlite/sqliteGraphAggregates.ts — projection + aggregation reads for
 * SqliteGraph. Mirrors `surreal/surrealGraphAggregates.ts` field-for-field,
 * using the SAME shared `graphShared/keysetPage.ts` cursor builder step 1a
 * extracted, so `bulkList`/`bulkListProjected` paging is byte-identical to
 * SurrealGraph's by construction.
 */

import type { BulkListPage, BulkListQuery, EdgeQuery, GraphStats, LoreEdge } from '../../providers/types.js';
import { LoreGraphError } from '../loreGraphError.js';
import { clampLimit } from '../topologyOverviewFold.js';
import { assertIdent } from '../whereClause.js';
import { buildKeysetPage } from '../graphShared/keysetPage.js';
import type { SqliteDb } from './sqliteGraphSchema.js';
import { fromSqliteNodeRow } from './sqliteGraphRow.js';

function sqliteError(message: string, operation: string, error: unknown): LoreGraphError {
    return new LoreGraphError(message, operation, error);
}

/**
 * queryEdges — paginated edge query, deterministically ordered by
 * `(source_id, target_id, relation)` — exactly the `edges` table's PRIMARY
 * KEY, so `ORDER BY` is answered directly off that index (a covering
 * range/full scan in key order), not a separate sort step. This is a real
 * order, not merely a stable one: it is now identical to SurrealGraph's
 * `queryEdges`, which sorts on the same three columns (`in`, `out`,
 * `relation`) for the same reason — see that function's doc comment for the
 * measured cost and why an UNINDEXED sort was rejected before.
 */
export async function queryEdges(db: SqliteDb, q: EdgeQuery): Promise<LoreEdge[]> {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (q.source) { filters.push('source_id = ?'); params.push(q.source); }
    if (q.target) { filters.push('target_id = ?'); params.push(q.target); }
    if (q.relation) { filters.push('relation = ?'); params.push(q.relation); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    try {
        const rows = db.prepare(
            `SELECT source_id, target_id, relation, confidence, confidenceScore FROM edges${where}`
            + ' ORDER BY source_id, target_id, relation LIMIT ? OFFSET ?',
        ).all(...params, q.limit, q.offset) as Array<{
            source_id: string; target_id: string; relation: string; confidence: string; confidenceScore: number;
        }>;
        return rows.map((row) => ({
            sourceId: row.source_id,
            targetId: row.target_id,
            relation: row.relation,
            confidence: (row.confidence as LoreEdge['confidence']) ?? 'extracted',
            confidenceScore: typeof row.confidenceScore === 'number' ? row.confidenceScore : 1.0,
        }));
    } catch (error) {
        throw sqliteError('Failed to query edges', 'queryEdges', error);
    }
}

/** getStats — node count (summed from the type breakdown), edge count, per-type breakdown. Same three rules as surrealGraphAggregates.getStats. */
export async function getStats(db: SqliteDb, projectFilter?: string): Promise<GraphStats> {
    try {
        const typeRows = projectFilter
            ? db.prepare(`SELECT type, COUNT(*) AS c FROM nodes WHERE project = ? GROUP BY type`).all(projectFilter)
            : db.prepare(`SELECT type, COUNT(*) AS c FROM nodes GROUP BY type`).all();
        const typeBreakdown: Record<string, number> = {};
        let nodeCount = 0;
        for (const row of typeRows as Array<{ type: string; c: number }>) {
            const type = String(row.type ?? '');
            const count = Number(row.c ?? 0);
            nodeCount += count;
            if (type) typeBreakdown[type] = (typeBreakdown[type] ?? 0) + count;
        }
        const edgeRow = projectFilter
            ? db.prepare(
                `SELECT COUNT(*) AS c FROM edges e
                 JOIN nodes ns ON ns.id = e.source_id
                 JOIN nodes nt ON nt.id = e.target_id
                 WHERE ns.project = ? AND nt.project = ?`,
            ).get(projectFilter, projectFilter) as { c: number }
            : db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
        return { nodeCount, edgeCount: Number(edgeRow?.c ?? 0), typeBreakdown };
    } catch (error) {
        throw sqliteError('Failed to compute graph stats', 'getStats', error);
    }
}

/** getTopology — bounded node + edge slice for the network view. Same intra-set-coupling filter as surrealGraphAggregates.getTopology. */
export async function getTopology(
    db: SqliteDb,
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
        // Deterministic order — `id` is the `nodes` table's PRIMARY KEY, so
        // this ORDER BY is index-order, not a sort step. Matches
        // SurrealGraph's getTopology, which now orders its node/edge scans
        // the same way (see that function's doc comment).
        const nodeRows = scoped
            ? db.prepare(`SELECT * FROM nodes WHERE project IN (${projectsList.map(() => '?').join(', ')}) ORDER BY id LIMIT ?`)
                .all(...projectsList, nodeLimit)
            : db.prepare('SELECT * FROM nodes ORDER BY id LIMIT ?').all(nodeLimit);
        const nonEmpty = (row: Record<string, unknown>, key: string): string | null => {
            const value = row[key];
            return typeof value === 'string' && value.length > 0 ? value : null;
        };
        const nodes = (nodeRows as Array<Record<string, unknown>>).map((raw) => {
            const row = fromSqliteNodeRow(raw);
            return {
                id: row['id'], label: row['label'], type: row['type'], project: row['project'],
                group: row['type'],
                supersededBy: nonEmpty(row, 'supersededBy'),
                supersededAt: nonEmpty(row, 'supersededAt'),
                supersededReason: nonEmpty(row, 'supersededReason'),
            };
        });

        const visible = new Set(nodes.map((n) => String(n.id)));
        const edgeRows = db.prepare(
            'SELECT source_id, target_id, relation, confidence, confidenceScore FROM edges'
            + ' ORDER BY source_id, target_id, relation LIMIT ?',
        ).all(eLimit) as Array<{ source_id: string; target_id: string; relation: string; confidence: string; confidenceScore: number }>;
        const edges: Array<Record<string, unknown>> = [];
        for (const row of edgeRows) {
            if (scoped && !(visible.has(row.source_id) && visible.has(row.target_id))) continue;
            edges.push({
                from: row.source_id, to: row.target_id, label: row.relation,
                confidence: row.confidence ?? 'extracted',
                confidenceScore: row.confidenceScore ?? 1.0,
            });
        }
        return { nodes, edges };
    } catch (error) {
        throw sqliteError('Failed to extract graph topology', 'getTopology', error);
    }
}

/** Exact column set — same as surrealGraphAggregates' BULK_LIST_COLUMNS. */
const BULK_LIST_COLUMNS = [
    'id', 'type', 'label', 'content', 'tags', 'metadata',
    'project', 'ecosystem', 'updatedAt', 'createdAt', 'security_scopes',
] as const;

/** bulkList — cursor-paginated enumeration on (updatedAt DESC, id ASC). Same keyset contract as surrealGraphAggregates.bulkList. */
export async function bulkList(db: SqliteDb, q: BulkListQuery): Promise<BulkListPage> {
    const limit = Math.min(Math.max(Math.trunc(q.limit), 1), 1000);
    const filters: string[] = [];
    const params: unknown[] = [];
    if (q.types && q.types.length > 0) {
        filters.push(`type IN (${q.types.map(() => '?').join(', ')})`);
        params.push(...q.types);
    }
    if (q.tags && q.tags.length > 0) {
        const lowered = q.tags.map((t) => t.toLowerCase());
        filters.push(`EXISTS (SELECT 1 FROM json_each(nodes.tags) je WHERE je.value IN (${lowered.map(() => '?').join(', ')}))`);
        params.push(...lowered);
    }
    if (q.project) { filters.push('project = ?'); params.push(q.project); }
    if (q.ecosystem && q.ecosystem !== '*') {
        filters.push(`(ecosystem = ? OR ecosystem = '*' OR ecosystem = '')`);
        params.push(q.ecosystem);
    }
    if (q.cursor) {
        filters.push('(updatedAt < ? OR (updatedAt = ? AND id > ?))');
        params.push(q.cursor.updatedAt, q.cursor.updatedAt, q.cursor.id);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    try {
        const rows = db.prepare(
            `SELECT ${BULK_LIST_COLUMNS.join(', ')} FROM nodes${where} ORDER BY updatedAt DESC, id ASC LIMIT ?`,
        ).all(...params, limit + 1) as Array<Record<string, unknown>>;
        const normalized = rows.map((row) => fromSqliteNodeRow(row));
        const { page, hasMore, nextCursor } = buildKeysetPage(normalized, limit);
        return { nodes: page, hasMore, nextCursor };
    } catch (error) {
        throw sqliteError('Failed to bulk-list nodes', 'bulkList', error);
    }
}

/** bulkListProjected — keyset-paged node scan, requested columns only. Same contract as surrealGraphAggregates.bulkListProjected. */
export async function bulkListProjected(
    db: SqliteDb,
    project: string,
    columns: readonly string[],
    limit: number,
    cursor: { updatedAt: string; id: string } | null,
): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }> {
    const wanted = Array.from(new Set<string>(['id', 'updatedAt', ...columns]));
    for (const c of wanted) assertIdent(c);
    const filters: string[] = [];
    const params: unknown[] = [];
    if (project !== '*') { filters.push('project = ?'); params.push(project); }
    if (cursor) {
        filters.push('(updatedAt < ? OR (updatedAt = ? AND id > ?))');
        params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    try {
        const rows = db.prepare(
            `SELECT ${wanted.join(', ')} FROM nodes${where} ORDER BY updatedAt DESC, id ASC LIMIT ?`,
        ).all(...params, limit + 1) as Array<Record<string, unknown>>;
        const normalized = rows.map((row) => (
            wanted.includes('tags') || wanted.includes('security_scopes') ? fromSqliteNodeRow(row) : row
        ));
        const { page, nextCursor } = buildKeysetPage(normalized, limit);
        return { rows: page, nextCursor };
    } catch (error) {
        throw sqliteError('Failed to page nodes', 'bulkListProjected', error);
    }
}
