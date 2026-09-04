/**
 * surrealGraphOverview.ts — the SurrealDB query layer for the operations that
 * existed only on the prior local graph engine.
 *
 * Eight operations had live callers (topology chords, the diagnostics language
 * breakdown, `lore lint`, node lineage, the maintenance archive, cache
 * controls) and no SurrealDB implementation. On a Surreal-backed workspace each
 * one either threw or, worse, ran against that prior engine's empty node table and
 * returned a confident wrong answer.
 *
 * The two topology overviews delegate their MEANING to
 * `engines/topologyOverviewFold.ts`, which both engines share. Only the three
 * grouped counts are written here. That is deliberate: the folding rules —
 * empty group collapses to `Global`, intra-group edges excluded, types sorted
 * by count, `truncated` derived from the node cap — are where two hand-written
 * implementations would quietly diverge, and a divergence there is a chord
 * diagram that is subtly wrong on one engine.
 */

import { assertIdent } from '../whereClause.js';
import {
    foldTopologyOverview,
    TOPOLOGY_OVERVIEW_EDGE_CAP,
    TOPOLOGY_OVERVIEW_NODE_CAP,
    type EdgePairRow,
    type GroupCountRow,
    type GroupTypeCountRow,
    type TopologyOverviewResult,
} from '../topologyOverviewFold.js';
import { EDGE_TABLE, NODE_TABLE, ridToId } from './surrealRecordId.js';
import { surrealError } from './surrealError.js';
import { withTransactionConflictRetry } from '../transactionConflictRetry.js';

/** The row-returning query runner SurrealGraph threads in. */
export type SurrealQuery = (sql: string, vars?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

/**
 * Grouped node counts on one column.
 *
 * SurrealDB's `GROUP BY` returns the grouped column plus the aggregate, so this
 * is one round trip per grouping rather than a scan folded in JS.
 */
async function groupedNodeCounts(
    query: SurrealQuery,
    column: string,
): Promise<Array<Record<string, unknown>>> {
    // SW-01: interpolated identifier — SurrealQL has no parameter slot for one.
    const col = assertIdent(column);
    return query(
        `SELECT ${col} AS grp, count() AS cnt FROM ${NODE_TABLE} GROUP BY ${col} LIMIT $cap`,
        { cap: TOPOLOGY_OVERVIEW_NODE_CAP },
    );
}

/** Node counts grouped by two columns, for the two-level hierarchy. */
async function groupedNodeCounts2(
    query: SurrealQuery,
    a: string,
    b: string,
): Promise<Array<Record<string, unknown>>> {
    const ca = assertIdent(a);
    const cb = assertIdent(b);
    return query(
        `SELECT ${ca} AS grp, ${cb} AS typ, count() AS cnt FROM ${NODE_TABLE} GROUP BY ${ca}, ${cb} LIMIT $cap`,
        { cap: TOPOLOGY_OVERVIEW_NODE_CAP },
    );
}

/**
 * Edge endpoint pairs projected onto a node column.
 *
 * `in`/`out` are record links, so the grouping value is fetched THROUGH them
 * (`in.project`) rather than joined — SurrealDB resolves the link in the
 * projection, which is the one place its data model is genuinely simpler than
 * the Cypher equivalent.
 */
async function edgePairsBy(
    query: SurrealQuery,
    column: string,
): Promise<Array<Record<string, unknown>>> {
    const col = assertIdent(column);
    return query(
        `SELECT in.${col} AS f, out.${col} AS t FROM ${EDGE_TABLE} LIMIT $cap`,
        { cap: TOPOLOGY_OVERVIEW_EDGE_CAP },
    );
}

const asGroup = (rows: Array<Record<string, unknown>>): GroupCountRow[] =>
    rows.map((r) => ({ group: r['grp'] as string | null, count: Number(r['cnt'] ?? 0) }));

const asGroupType = (rows: Array<Record<string, unknown>>): GroupTypeCountRow[] =>
    rows.map((r) => ({
        group: r['grp'] as string | null,
        type: r['typ'] as string | null,
        count: Number(r['cnt'] ?? 0),
    }));

const asEdgePairs = (rows: Array<Record<string, unknown>>): EdgePairRow[] =>
    rows.map((r) => ({ from: r['f'] as string | null, to: r['t'] as string | null }));

/** Grouped by `project` — the default chord view. */
export async function getTopologyOverview(query: SurrealQuery): Promise<TopologyOverviewResult> {
    try {
        const [blobRows, typeRows, edgeRows] = await Promise.all([
            groupedNodeCounts(query, 'project'),
            groupedNodeCounts2(query, 'project', 'type'),
            edgePairsBy(query, 'project'),
        ]);
        return foldTopologyOverview(asGroup(blobRows), asGroupType(typeRows), asEdgePairs(edgeRows));
    } catch (error) {
        throw surrealError('Failed to extract topology overview', 'getTopologyOverview', error);
    }
}

/**
 * Grouped by `type` — for single-project workspaces, where the project chord
 * shows only one arc.
 *
 * The blob's own type list is itself the grouping column, which is why the
 * second argument repeats `type`: a type blob contains exactly one type entry,
 * matching the prior implementation's shape.
 */
export async function getTopologyOverviewByType(query: SurrealQuery): Promise<TopologyOverviewResult> {
    try {
        const [blobRows, edgeRows] = await Promise.all([
            groupedNodeCounts(query, 'type'),
            edgePairsBy(query, 'type'),
        ]);
        const groups = asGroup(blobRows);
        const typeRows: GroupTypeCountRow[] = groups.map((g) => ({ group: g.group, type: g.group, count: g.count }));
        return foldTopologyOverview(groups, typeRows, asEdgePairs(edgeRows));
    } catch (error) {
        throw surrealError('Failed to extract topology overview by type', 'getTopologyOverviewByType', error);
    }
}

/**
 * Node counts by `language` tag.
 *
 * Empty-string collapses under the key `null` — that is the public
 * representation of "unknown", and it is the behaviour the prior
 * implementation had, which this must match. A missing column is non-fatal
 * for the same reason it was on the prior implementation: older
 * graphs predate the field, and a diagnostics panel must not 500 over it.
 */
export async function getLanguageBreakdown(query: SurrealQuery): Promise<Record<string, number>> {
    try {
        const rows = await query(`SELECT language AS lang, count() AS cnt FROM ${NODE_TABLE} GROUP BY language`);
        const breakdown: Record<string, number> = {};
        for (const row of rows) {
            const raw = row['lang'] as string | null | undefined;
            const key = raw && raw.length > 0 ? raw : 'null';
            breakdown[key] = (breakdown[key] ?? 0) + Number(row['cnt'] ?? 0);
        }
        return breakdown;
    } catch {
        return {};
    }
}

/**
 * Orphan check — nodes with no edges in either direction, excluding notes.
 *
 * Notes are excluded because a standalone note is a legitimate artefact, not a
 * dangling reference; that carries over from the prior implementation verbatim,
 * as does the message text, because operators grep these strings.
 */
export async function lintGraph(query: SurrealQuery): Promise<string[]> {
    try {
        const rows = await query(
            `SELECT id, type FROM ${NODE_TABLE}`
            + ` WHERE type != 'note'`
            + ` AND count(SELECT id FROM ${EDGE_TABLE} WHERE in = $parent.id OR out = $parent.id) = 0`,
        );
        return rows.map((r) => `Orphan: ${String(r['type'])} node '${ridToId(r['id'])}' has no relationships.`);
    } catch (error) {
        throw surrealError('Failed to lint graph', 'lintGraph', error);
    }
}

/**
 * The nodes this one superseded — ALL of them, ordered by id so the result
 * is deterministic. A merge (several nodes superseded by one successor) has
 * more than one predecessor; the old LIMIT 1 lookup silently dropped every
 * branch but an arbitrary one.
 */
export async function findSupersededByPredecessors(
    query: SurrealQuery,
    byId: string,
): Promise<string[]> {
    try {
        const rows = await query(
            `SELECT id FROM ${NODE_TABLE} WHERE supersededBy = $by ORDER BY id ASC`,
            { by: byId },
        );
        return rows
            .map((r) => ridToId(r['id']))
            .filter((id) => id.length > 0);
    } catch (error) {
        throw surrealError(`Failed to find predecessors of '${byId}'`, 'findSupersededByPredecessors', error);
    }
}

/**
 * Soft-archive: `status = 'archived'`, and stamp `updatedAt`.
 *
 * The timestamp matters beyond bookkeeping — `updatedAt` is the keyset cursor,
 * so an archive that did not stamp it would leave the node in the same page
 * position and make "recently changed" views lie.
 */
export async function archiveNode(query: SurrealQuery, id: string, rid: unknown): Promise<void> {
    try {
        // 1.1 residual (2026-08-18) — conflict-retry wrap (composite write
        // verb), same as the lifecycle verbs in surrealGraphWrites.ts.
        await withTransactionConflictRetry(() => query(
            `UPDATE $rid SET status = 'archived', updatedAt = $ts`,
            { rid, ts: new Date().toISOString() },
        ));
    } catch (error) {
        throw surrealError(`Failed to archive node '${id}'`, 'archiveNode', error);
    }
}
