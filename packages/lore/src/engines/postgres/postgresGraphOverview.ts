/**
 * postgres/postgresGraphOverview.ts — the postgres query layer for the
 * operations `engines/sqlite/sqliteGraphOverview.ts` covers on the SQLite
 * side. The two topology overviews delegate their MEANING to the SAME shared
 * `topologyOverviewFold.ts`; only the three grouped-count queries are
 * engine-specific, and here they additionally slice `workspace_id = $1`.
 *
 * `findSupersededByPredecessors` deliberately does NOT use a recursive CTE —
 * for the same reason SQLite's does not (see that file's header): the
 * question is "which node(s) DIRECTLY list `byId` as their `supersededBy`",
 * not "the transitive ancestor chain", and a recursive walk would return a
 * superset and break parity.
 */

import {
    foldTopologyOverview,
    TOPOLOGY_OVERVIEW_EDGE_CAP,
    TOPOLOGY_OVERVIEW_NODE_CAP,
    type EdgePairRow,
    type GroupCountRow,
    type GroupTypeCountRow,
    type TopologyOverviewResult,
} from '../topologyOverviewFold.js';
import { assertIdent } from '../whereClause.js';
import { formatOrphanMessage } from '../graphShared/lintMessages.js';
import { pgQuoteIdent, pgError, PgParams } from './postgresGraphRow.js';
import type { Pool } from 'pg';

function groupedNodeCounts(pool: Pool, workspaceId: string, column: string): Promise<Array<{ grp: string; cnt: number }>> {
    const col = pgQuoteIdent(assertIdent(column));
    return pool.query(`SELECT ${col} AS grp, COUNT(*) AS cnt FROM nodes WHERE workspace_id = $1 GROUP BY ${col} LIMIT $2::int`, [workspaceId, TOPOLOGY_OVERVIEW_NODE_CAP])
        .then((res) => res.rows as Array<{ grp: string; cnt: number }>);
}

function groupedNodeCounts2(pool: Pool, workspaceId: string, a: string, b: string): Promise<Array<{ grp: string; typ: string; cnt: number }>> {
    const ca = pgQuoteIdent(assertIdent(a));
    const cb = pgQuoteIdent(assertIdent(b));
    return pool.query(
        `SELECT ${ca} AS grp, ${cb} AS typ, COUNT(*) AS cnt FROM nodes WHERE workspace_id = $1 GROUP BY ${ca}, ${cb} LIMIT $2::int`,
        [workspaceId, TOPOLOGY_OVERVIEW_NODE_CAP],
    ).then((res) => res.rows as Array<{ grp: string; typ: string; cnt: number }>);
}

function edgePairsBy(pool: Pool, workspaceId: string, column: string): Promise<Array<{ f: string; t: string }>> {
    const col = pgQuoteIdent(assertIdent(column));
    return pool.query(
        `SELECT ns.${col} AS f, nt.${col} AS t FROM edges e`
        + ' JOIN nodes ns ON ns.sk = e.src_sk'
        + ' JOIN nodes nt ON nt.sk = e.dst_sk'
        + ' WHERE e.workspace_id = $1 AND e.valid_to IS NULL LIMIT $2::int',
        [workspaceId, TOPOLOGY_OVERVIEW_EDGE_CAP],
    ).then((res) => res.rows as Array<{ f: string; t: string }>);
}

const asGroup = (rows: Array<{ grp: string; cnt: number }>): GroupCountRow[] =>
    rows.map((r) => ({ group: r.grp, count: Number(r.cnt ?? 0) }));
const asGroupType = (rows: Array<{ grp: string; typ: string; cnt: number }>): GroupTypeCountRow[] =>
    rows.map((r) => ({ group: r.grp, type: r.typ, count: Number(r.cnt ?? 0) }));
const asEdgePairs = (rows: Array<{ f: string; t: string }>): EdgePairRow[] =>
    rows.map((r) => ({ from: r.f, to: r.t }));

export async function getTopologyOverview(pool: Pool, workspaceId: string): Promise<TopologyOverviewResult> {
    try {
        const blobRows = await groupedNodeCounts(pool, workspaceId, 'project');
        const typeRows = await groupedNodeCounts2(pool, workspaceId, 'project', 'type');
        const edgeRows = await edgePairsBy(pool, workspaceId, 'project');
        return foldTopologyOverview(asGroup(blobRows), asGroupType(typeRows), asEdgePairs(edgeRows));
    } catch (error) {
        throw pgError('Failed to extract topology overview', 'getTopologyOverview', error);
    }
}

export async function getTopologyOverviewByType(pool: Pool, workspaceId: string): Promise<TopologyOverviewResult> {
    try {
        const blobRows = await groupedNodeCounts(pool, workspaceId, 'type');
        const edgeRows = await edgePairsBy(pool, workspaceId, 'type');
        const groups = asGroup(blobRows);
        const typeRows: GroupTypeCountRow[] = groups.map((g) => ({ group: g.group, type: g.group, count: g.count }));
        return foldTopologyOverview(groups, typeRows, asEdgePairs(edgeRows));
    } catch (error) {
        throw pgError('Failed to extract topology overview by type', 'getTopologyOverviewByType', error);
    }
}

export async function getLanguageBreakdown(pool: Pool, workspaceId: string): Promise<Record<string, number>> {
    try {
        const res = await pool.query(
            `SELECT language AS lang, COUNT(*) AS cnt FROM nodes WHERE workspace_id = $1 GROUP BY language`,
            [workspaceId],
        );
        const breakdown: Record<string, number> = {};
        for (const row of res.rows as Array<{ lang: string; cnt: number }>) {
            const key = row.lang && row.lang.length > 0 ? row.lang : 'null';
            breakdown[key] = (breakdown[key] ?? 0) + Number(row.cnt ?? 0);
        }
        return breakdown;
    } catch {
        return {};
    }
}

/** Orphan check — nodes with no edges in either direction, excluding notes. Indexed `NOT EXISTS` instead of a subquery-count. */
export async function lintGraph(pool: Pool, workspaceId: string): Promise<string[]> {
    try {
        const res = await pool.query(
            `SELECT id, type FROM nodes n
             WHERE n.workspace_id = $1 AND n.type != 'note'
               AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.workspace_id = n.workspace_id AND e.src_sk = n.sk AND e.valid_to IS NULL)
               AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_sk = n.sk AND e.valid_to IS NULL)
             ORDER BY id ASC`, // 3.27.1: deterministic message order
            [workspaceId],
        );
        return (res.rows as Array<{ id: string; type: string }>)
            .map((r) => formatOrphanMessage(r.type, r.id));
    } catch (error) {
        throw pgError('Failed to lint graph', 'lintGraph', error);
    }
}

/** The nodes that directly list `byId` as their `supersededBy` — see file header for why this is NOT a recursive walk. */
export async function findSupersededByPredecessors(pool: Pool, workspaceId: string, byId: string): Promise<string[]> {
    try {
        const res = await pool.query(
            `SELECT id FROM nodes WHERE workspace_id = $1 AND supersededBy = $2 ORDER BY id ASC`,
            [workspaceId, byId],
        );
        return (res.rows as Array<{ id: string }>).map((r) => r.id).filter((id) => id.length > 0);
    } catch (error) {
        throw pgError(`Failed to find predecessors of '${byId}'`, 'findSupersededByPredecessors', error);
    }
}

/**
 * Soft-archive: `status = 'archived'`, and stamp `updatedAt` (the keyset cursor).
 * Archiving a node that is not yet archived is an accepted mutation, so the
 * revision moves up by 1 (computed in the statement); re-archiving one that
 * already is changes no state and leaves the revision alone.
 */
export async function archiveNode(pool: Pool, workspaceId: string, id: string): Promise<void> {
    try {
        const params = new PgParams();
        const ws = params.add(workspaceId);
        const now = params.add(new Date().toISOString());
        const idp = params.add(id);
        await pool.query(
            `UPDATE nodes SET revision = revision + CASE WHEN COALESCE(status, '') = 'archived' THEN 0 ELSE 1 END,`
            + ` status = 'archived', "updatedAt" = ${now} WHERE workspace_id = ${ws} AND id = ${idp}`,
            params.values,
        );
    } catch (error) {
        throw pgError(`Failed to archive node '${id}'`, 'archiveNode', error);
    }
}
