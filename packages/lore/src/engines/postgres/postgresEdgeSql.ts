/**
 * postgresEdgeSql.ts - SQL fragments shared by the Postgres edge read/write paths (design D3).
 *
 * The edges table stores only 8-byte endpoint keys (edge layout 2); reads join through `nodes.sk` to return the text ids, and every
 * default read adds `valid_to IS NULL` so soft-invalidated edges stay invisible.
 */
import type { LoreEdge } from '../../providers/types.js';
import { edgeProvenanceFromRow, type EdgeProvenanceRow } from '../../providers/edgeProvenance.js';

/** Column list appended to an edge SELECT when the caller asked for provenance. */
export const PROVENANCE_COLS = 'origin, policy_version, model_fingerprint, created_at, valid_to';

export type EdgeRow = EdgeProvenanceRow & {
    source_id: string; target_id: string; relation: string; confidence: string; confidenceScore: number;
};

/**
 * Edge rows with text endpoint ids resolved through `nodes.sk` (layout 2 stores only the keys). `e` is the edge,
 * `s` the source node, `t` the target node. `sk` is only unique WITHIN a workspace (shard-ready model, Phase 0):
 * every join also matches `workspace_id`, so it resolves through the unique `nodes (workspace_id, sk)` key and never
 * depends on `sk` being unique across the database.
 */
export const EDGE_ENDPOINT_JOINS =
    ' JOIN nodes s ON s.workspace_id = e.workspace_id AND s.sk = e.src_sk'
    + ' JOIN nodes t ON t.workspace_id = e.workspace_id AND t.sk = e.dst_sk';
/** SELECT list for a resolved edge read (provenance appended when asked). */
export const edgeSelectList = (withProvenance: boolean): string =>
    's.id AS source_id, t.id AS target_id, e.relation, e.confidence, e."confidenceScore"'
    + (withProvenance ? ', e.origin, e.policy_version, e.model_fingerprint, e.created_at, e.valid_to' : '');

/** Edge row -> `LoreEdge`; `provenance` is attached only when the SELECT included {@link PROVENANCE_COLS}. */
export function edgeFromRow(row: EdgeRow, withProvenance: boolean): LoreEdge {
    const edge: LoreEdge = {
        sourceId: row.source_id,
        targetId: row.target_id,
        relation: row.relation,
        confidence: (row.confidence as LoreEdge['confidence']) ?? 'extracted',
        confidenceScore: typeof row.confidenceScore === 'number' ? row.confidenceScore : 1.0,
    };
    if (withProvenance) edge.provenance = edgeProvenanceFromRow(row);
    return edge;
}

/** The scalar subselect that resolves a node's surrogate key; `wsParam`/`idParam` are `$n` placeholders. */
export const skOf = (wsParam: string, idParam: string): string =>
    `(SELECT sk FROM nodes WHERE workspace_id = ${wsParam} AND id = ${idParam})`;

/**
 * One frontier level's live edges in one direction, joined through the surrogate keys.
 * Params: $1 workspace_id, $2 text[] of frontier ids. Rows: from_id (the frontier node), to_id, relation.
 * `ordered` adds the deterministic (from, to, relation) order the directed traversal relies on.
 */
export function frontierEdgesSql(direction: 'out' | 'in', ordered: boolean): string {
    const [fromCol, toCol] = direction === 'out' ? ['src_sk', 'dst_sk'] : ['dst_sk', 'src_sk'];
    // Both joins carry the workspace: `sk` is unique per workspace only. `e.workspace_id` also lets the forward direction use
    // the primary key's (workspace_id, src_sk) prefix, and the reverse direction `idx_edges_ws_dst_sk (workspace_id, dst_sk)`.
    return `SELECT f.id AS from_id, t.id AS to_id, e.relation FROM nodes f`
        + ` JOIN edges e ON e.workspace_id = f.workspace_id AND e.${fromCol} = f.sk`
        + ` JOIN nodes t ON t.workspace_id = e.workspace_id AND t.sk = e.${toCol}`
        + ` WHERE f.workspace_id = $1 AND e.workspace_id = $1 AND f.id = ANY($2) AND e.valid_to IS NULL`
        + (ordered ? ' ORDER BY f.id, t.id, e.relation' : '');
}
