/**
 * sqlite/sqliteGraphOverview.ts — SQLite query layer for the operations
 * `surreal/surrealGraphOverview.ts` covers on the Surreal side. The two
 * topology overviews delegate their MEANING to the SAME shared
 * `topologyOverviewFold.ts` both engines already used before this file
 * existed — only the three grouped-count queries are engine-specific.
 *
 * `findSupersededByPredecessors` deliberately does NOT use a recursive CTE.
 * The design doc's storage section lists "a recursive CTE over
 * `supersededBy`" for this function, but SurrealGraph's actual
 * implementation (`surrealGraphOverview.ts`) answers a DIFFERENT, narrower
 * question — "which node(s) directly list `byId` as their `supersededBy`"
 * (a merge has more than one; that's the whole point of returning `string[]`
 * instead of one id) — not "the whole transitive ancestor chain". A
 * recursive walk would return a superset (every transitive predecessor) and
 * BREAK bit-identical parity with SurrealGraph rather than preserve it. A
 * flat `WHERE supersededBy = ?` is already exact and needs no recursion; see
 * the design doc's own admission that `findSupersededByPredecessors`'s only
 * hard requirement is returning every DIRECT predecessor, deterministically
 * ordered. Recursion was correctly reserved for lint's supersede-chain
 * WALKS elsewhere in the codebase (none of which live in this file).
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
import { LoreGraphError } from '../loreGraphError.js';
import { formatOrphanMessage } from '../graphShared/lintMessages.js';
import type { SqliteDb } from './sqliteGraphSchema.js';

function sqliteError(message: string, operation: string, error: unknown): LoreGraphError {
    return new LoreGraphError(message, operation, error);
}

function groupedNodeCounts(db: SqliteDb, column: string): Array<{ grp: string; cnt: number }> {
    const col = assertIdent(column);
    return db.prepare(`SELECT ${col} AS grp, COUNT(*) AS cnt FROM nodes GROUP BY ${col} LIMIT ?`)
        .all(TOPOLOGY_OVERVIEW_NODE_CAP) as Array<{ grp: string; cnt: number }>;
}

function groupedNodeCounts2(db: SqliteDb, a: string, b: string): Array<{ grp: string; typ: string; cnt: number }> {
    const ca = assertIdent(a);
    const cb = assertIdent(b);
    return db.prepare(`SELECT ${ca} AS grp, ${cb} AS typ, COUNT(*) AS cnt FROM nodes GROUP BY ${ca}, ${cb} LIMIT ?`)
        .all(TOPOLOGY_OVERVIEW_NODE_CAP) as Array<{ grp: string; typ: string; cnt: number }>;
}

function edgePairsBy(db: SqliteDb, column: string): Array<{ f: string; t: string }> {
    const col = assertIdent(column);
    return db.prepare(
        `SELECT ns.${col} AS f, nt.${col} AS t FROM edges e
         JOIN nodes ns ON ns.id = e.source_id JOIN nodes nt ON nt.id = e.target_id LIMIT ?`,
    ).all(TOPOLOGY_OVERVIEW_EDGE_CAP) as Array<{ f: string; t: string }>;
}

const asGroup = (rows: Array<{ grp: string; cnt: number }>): GroupCountRow[] =>
    rows.map((r) => ({ group: r.grp, count: Number(r.cnt ?? 0) }));
const asGroupType = (rows: Array<{ grp: string; typ: string; cnt: number }>): GroupTypeCountRow[] =>
    rows.map((r) => ({ group: r.grp, type: r.typ, count: Number(r.cnt ?? 0) }));
const asEdgePairs = (rows: Array<{ f: string; t: string }>): EdgePairRow[] =>
    rows.map((r) => ({ from: r.f, to: r.t }));

export async function getTopologyOverview(db: SqliteDb): Promise<TopologyOverviewResult> {
    try {
        const blobRows = groupedNodeCounts(db, 'project');
        const typeRows = groupedNodeCounts2(db, 'project', 'type');
        const edgeRows = edgePairsBy(db, 'project');
        return foldTopologyOverview(asGroup(blobRows), asGroupType(typeRows), asEdgePairs(edgeRows));
    } catch (error) {
        throw sqliteError('Failed to extract topology overview', 'getTopologyOverview', error);
    }
}

export async function getTopologyOverviewByType(db: SqliteDb): Promise<TopologyOverviewResult> {
    try {
        const blobRows = groupedNodeCounts(db, 'type');
        const edgeRows = edgePairsBy(db, 'type');
        const groups = asGroup(blobRows);
        const typeRows: GroupTypeCountRow[] = groups.map((g) => ({ group: g.group, type: g.group, count: g.count }));
        return foldTopologyOverview(groups, typeRows, asEdgePairs(edgeRows));
    } catch (error) {
        throw sqliteError('Failed to extract topology overview by type', 'getTopologyOverviewByType', error);
    }
}

export async function getLanguageBreakdown(db: SqliteDb): Promise<Record<string, number>> {
    try {
        const rows = db.prepare(`SELECT language AS lang, COUNT(*) AS cnt FROM nodes GROUP BY language`)
            .all() as Array<{ lang: string; cnt: number }>;
        const breakdown: Record<string, number> = {};
        for (const row of rows) {
            const key = row.lang && row.lang.length > 0 ? row.lang : 'null';
            breakdown[key] = (breakdown[key] ?? 0) + Number(row.cnt ?? 0);
        }
        return breakdown;
    } catch {
        return {};
    }
}

/** Orphan check — nodes with no edges in either direction, excluding notes. Indexed `NOT EXISTS` instead of Surreal's inline subquery-count. */
export async function lintGraph(db: SqliteDb): Promise<string[]> {
    try {
        const rows = db.prepare(
            `SELECT id, type FROM nodes
             WHERE type != 'note'
               AND NOT EXISTS (SELECT 1 FROM edges WHERE source_id = nodes.id)
               AND NOT EXISTS (SELECT 1 FROM edges WHERE target_id = nodes.id)`,
        ).all() as Array<{ id: string; type: string }>;
        return rows.map((r) => formatOrphanMessage(r.type, r.id));
    } catch (error) {
        throw sqliteError('Failed to lint graph', 'lintGraph', error);
    }
}

/** The nodes that directly list `byId` as their `supersededBy` — see file header for why this is NOT a recursive walk. */
export async function findSupersededByPredecessors(db: SqliteDb, byId: string): Promise<string[]> {
    try {
        const rows = db.prepare(`SELECT id FROM nodes WHERE supersededBy = ? ORDER BY id ASC`).all(byId) as Array<{ id: string }>;
        return rows.map((r) => r.id).filter((id) => id.length > 0);
    } catch (error) {
        throw sqliteError(`Failed to find predecessors of '${byId}'`, 'findSupersededByPredecessors', error);
    }
}

/** Soft-archive: `status = 'archived'`, and stamp `updatedAt` (the keyset cursor). */
export async function archiveNode(db: SqliteDb, id: string): Promise<void> {
    try {
        db.prepare(`UPDATE nodes SET status = 'archived', updatedAt = ? WHERE id = ?`).run(new Date().toISOString(), id);
    } catch (error) {
        throw sqliteError(`Failed to archive node '${id}'`, 'archiveNode', error);
    }
}
