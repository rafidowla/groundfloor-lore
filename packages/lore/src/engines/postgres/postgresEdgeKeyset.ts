/**
 * postgres/postgresEdgeKeyset.ts - keyset paging over the edge primary key (edge layout 2).
 *
 * `queryEdges` (limit/offset, text-id order) is the cross-engine contract and is O(offset) per page. A bulk scan
 * (export, rebuild, audit) that walks the whole table should use this instead: it pages on the PHYSICAL key
 * `(src_sk, dst_sk, relation)` with a row-comparison seek, so every page is one index range scan regardless of depth,
 * and the order is stable under concurrent inserts (a row is either before or after the cursor, never shifted).
 *
 * Order is by surrogate key, NOT by text id, so it differs from `queryEdges`; it is engine-only and additive
 * (no other engine implements it). The cursor is opaque. Cursor handling:
 *   - null / undefined -> first page.
 *   - a cursor from this method (version 2) -> seek strictly after it.
 *   - anything else (an old offset/text-key cursor, a truncated or tampered string) -> `invalid_cursor` error; the caller
 *     restarts from null. The HTTP edges route keeps its sealed OFFSET cursors on `queryEdges`, which is unchanged, so no
 *     cursor a client already holds is invalidated by the layout change.
 */
import type { Pool } from 'pg';
import type { EdgeQuery, LoreEdge } from '../../providers/types.js';
import { clampLimit } from '../topologyOverviewFold.js';
import { pgError, PgParams } from './postgresGraphRow.js';
import { edgeFromRow, edgeSelectList, EDGE_ENDPOINT_JOINS, type EdgeRow } from './postgresEdgeSql.js';
import { edgeFilters } from './postgresGraphAggregates.js';

export interface EdgeKeysetQuery extends Pick<EdgeQuery, 'source' | 'target' | 'relation' | 'includeProvenance' | 'includeInvalidated'> {
    /** Page size, clamped to the shared bulk-list ceiling. */
    limit: number;
    /** Opaque cursor returned by the previous page; omit for the first page. */
    cursor?: string | null;
}

export interface EdgeKeysetPage {
    edges: LoreEdge[];
    /** Pass back as `cursor` for the next page; null when this was the last page. */
    nextCursor: string | null;
}

const CURSOR_VERSION = 2;
interface CursorKey { s: string; d: string; r: string }

export function sealEdgeCursor(key: CursorKey): string {
    return Buffer.from(JSON.stringify([CURSOR_VERSION, key.s, key.d, key.r]), 'utf8').toString('base64url');
}

/** @returns the key, or null when the string is not a version-2 edge cursor. */
export function openEdgeCursor(cursor: string): CursorKey | null {
    try {
        const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(v) || v.length !== 4 || v[0] !== CURSOR_VERSION) return null;
        const [, s, d, r] = v as [number, unknown, unknown, unknown];
        if (typeof s !== 'string' || typeof d !== 'string' || typeof r !== 'string') return null;
        if (!/^\d{1,19}$/.test(s) || !/^\d{1,19}$/.test(d)) return null;
        return { s, d, r };
    } catch {
        return null;
    }
}

export async function queryEdgesPage(pool: Pool, workspaceId: string, q: EdgeKeysetQuery): Promise<EdgeKeysetPage> {
    const limit = clampLimit(q.limit);
    const params = new PgParams();
    params.add(workspaceId);
    const where = edgeFilters(params, q);
    if (q.cursor !== undefined && q.cursor !== null && q.cursor !== '') {
        const key = openEdgeCursor(q.cursor);
        if (!key) throw pgError('Invalid edge cursor - restart from the first page', 'queryEdgesPage', new Error('invalid_cursor'));
        where.push(`(e.src_sk, e.dst_sk, e.relation) > (${params.add(key.s)}::bigint, ${params.add(key.d)}::bigint, ${params.add(key.r)})`);
    }
    try {
        const res = await pool.query(
            `SELECT e.src_sk::text AS src_sk, e.dst_sk::text AS dst_sk, ${edgeSelectList(q.includeProvenance === true)}`
            + ` FROM edges e${EDGE_ENDPOINT_JOINS}`
            + ` WHERE e.workspace_id = $1${where.map((f) => ` AND ${f}`).join('')}`
            + ` ORDER BY e.src_sk, e.dst_sk, e.relation LIMIT $${params.values.length + 1}::int`,
            [...params.values, limit + 1],
        );
        const rows = res.rows as Array<EdgeRow & { src_sk: string; dst_sk: string }>;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            edges: page.map((row) => edgeFromRow(row, q.includeProvenance === true)),
            nextCursor: rows.length > limit && last ? sealEdgeCursor({ s: last.src_sk, d: last.dst_sk, r: last.relation }) : null,
        };
    } catch (error) {
        throw pgError('Failed to page edges', 'queryEdgesPage', error);
    }
}
