/**
 * arcadeGraphEdges.ts — edge read/delete/prune + topology for the ArcadeDB
 * db-per-app adapter (branch: spike/arcadedb-multitenant, slice 2).
 *
 * Extracted from arcadeGraphStore.ts to keep that file near the 500-line
 * target (mirrors LocalGraph's graphEdges.ts / graphTopology.ts split). Every
 * function takes (tenantDb, http) explicitly — never `this` — preserving the
 * "tenantDb only from the constructor" isolation invariant.
 *
 * ── THE LIVE-VERIFIED EDGE-PROJECTION TRAP (T1 family) ──────────────────────
 * Probed live against the pinned ArcadeDB 26.7.1 container: on the LoreEdge
 * table, the DOTTED link-field projection `out.id` / `in.id` SILENTLY RETURNS
 * NULL — the row is real (relation projects fine) but both endpoint ids come
 * back null, and a `WHERE out.id=:x` therefore matches ZERO rows. That is the
 * exact silent-zero-rows release-blocker the plan's `getTopology` note warned
 * about ("if out.id/in.id projection proves unreliable … fall back"). The
 * FUNCTION-CALL traversal form `outV().id` / `inV().id` projects the endpoint
 * ids CORRECTLY, both in SELECT projections and in WHERE predicates and in
 * DELETE predicates (all three verified live). So every function here uses
 * `outV()` / `inV()`, NEVER the dotted `out.` / `in.` form. This is pinned by
 * trap-pin cases in the hardening e2e.
 *
 * These are all direct edge-table SELECT/DELETE — none use both()/expand-of-
 * expand, so the T1 (both()-projection) and T2 (WHERE-atop-expand-of-expand)
 * neighbor traps don't apply; the T1-family risk here is the edge link-field
 * projection, handled as above.
 */

import type { LoreEdge } from '../../providers/types.js';
import type { ArcadeHttp } from './arcadeHttp.js';
import { NODE_TYPE, EDGE_TYPE } from './arcadeSchema.js';

type Row = Record<string, unknown>;

/** Topology node/edge caps mirroring LocalGraph.getTopology defaults. */
const TOPOLOGY_NODE_DEFAULT = 300;

/** Parse ArcadeDB's DELETE result shape ([{count:N}]) into a number. */
function deletedCount(result: unknown[]): number {
  const row = result?.[0] as { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * getEdges — list edges, optionally restricted to those incident on `nodeId`
 * (either endpoint). Uses the verified `outV().id` / `inV().id` projection.
 * Confidence/score default ('extracted' / 1.0) so callers can render directly,
 * matching graphEdges.queryEdges' defaults.
 */
export async function getEdges(
  tenantDb: string,
  http: ArcadeHttp,
  nodeId?: string,
): Promise<LoreEdge[]> {
  const params: Record<string, unknown> = {};
  let sql =
    `SELECT relation, confidence, confidenceScore, ` +
    `outV().id AS source, inV().id AS target FROM ${EDGE_TYPE}`;
  if (nodeId) {
    // Either endpoint matches — the OR is over the two verified traversal
    // projections, so it can't silently zero-row the way `out.id` would.
    sql += ` WHERE outV().id = :nid OR inV().id = :nid`;
    params['nid'] = nodeId;
  }
  const res = await http.query(tenantDb, sql, params);
  return ((res.result ?? []) as Row[]).map((r) => ({
    sourceId: String(r['source'] ?? ''),
    targetId: String(r['target'] ?? ''),
    relation: String(r['relation'] ?? ''),
    confidence: (r['confidence'] as LoreEdge['confidence']) ?? 'extracted',
    confidenceScore:
      typeof r['confidenceScore'] === 'number' ? (r['confidenceScore'] as number) : 1.0,
  }));
}

/**
 * deleteEdge — remove every LoreEdge matching the (source,target,relation)
 * triple; returns the count deleted (0 = no match). Mirrors
 * LocalGraph.deleteEdge. Uses the verified `outV()`/`inV()` WHERE form (the
 * dotted form would delete NOTHING silently — the T1 trap).
 */
export async function deleteEdge(
  tenantDb: string,
  http: ArcadeHttp,
  sourceId: string,
  targetId: string,
  relation: string,
): Promise<number> {
  const res = await http.command(
    tenantDb,
    `DELETE FROM ${EDGE_TYPE} WHERE outV().id = :s AND inV().id = :t AND relation = :r`,
    { s: sourceId, t: targetId, r: relation },
  );
  return deletedCount(res.result);
}

/**
 * pruneInferredLoreEdges — delete every LoreEdge whose relation starts with the
 * given prefix (e.g. "semantic_neighbor"). Direct edge-table WHERE on the
 * scalar `relation` column (no link-field projection involved — trap-free);
 * the prefix is bound, never interpolated. Returns the count deleted.
 */
export async function pruneInferredLoreEdges(
  tenantDb: string,
  http: ArcadeHttp,
  relationPrefix: string,
): Promise<number> {
  const res = await http.command(
    tenantDb,
    `DELETE FROM ${EDGE_TYPE} WHERE relation LIKE :p`,
    { p: `${relationPrefix}%` },
  );
  return deletedCount(res.result);
}

/**
 * computeTopology — node + edge snapshot for the UI graph view. Matches
 * LocalGraph.getTopology's { nodes:[{id,label,type,project,group,supersededBy…}],
 * edges:[{from,to,label,confidence,confidenceScore}] } shape.
 *
 * Nodes: a plain scalar SELECT with an optional `project IN :projects` filter.
 * Edges: a DIRECT edge-table SELECT using the verified `outV().id`/`inV().id`
 * projection (never both()/expand — traps T1/T2 don't apply here), then
 * filtered client-side to the returned node-id set so the graph is closed over
 * the node window. All caller limits are clamped to safe non-negative ints
 * before interpolation (ArcadeDB has no LIMIT param slot).
 */
export async function computeTopology(
  tenantDb: string,
  http: ArcadeHttp,
  limit = TOPOLOGY_NODE_DEFAULT,
  projects?: string[] | string,
  edgeLimit?: number,
): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  const nodeLimit = clampInt(limit, TOPOLOGY_NODE_DEFAULT);
  const eLimit = clampInt(edgeLimit ?? Math.min(nodeLimit * 4, 20_000), 20_000);
  const projectsList = Array.isArray(projects)
    ? projects.filter((p) => p && p.trim().length > 0)
    : projects && projects.trim().length > 0
      ? [projects]
      : [];
  const hasProjects = projectsList.length > 0;

  const nodeParams: Record<string, unknown> = {};
  let nodeSql =
    `SELECT id, type, label, project, supersededBy, supersededAt, supersededReason ` +
    `FROM ${NODE_TYPE}`;
  if (hasProjects) {
    nodeSql += ` WHERE project IN :projects`;
    nodeParams['projects'] = projectsList;
  }
  nodeSql += ` LIMIT ${nodeLimit}`;
  const nodeRes = await http.query(tenantDb, nodeSql, nodeParams);

  const nodeIds = new Set<string>();
  const nodes = ((nodeRes.result ?? []) as Row[]).map((n) => {
    const id = String(n['id'] ?? '');
    nodeIds.add(id);
    const nonEmpty = (v: unknown): string | null => {
      const s = v == null ? '' : String(v);
      return s.length > 0 ? s : null;
    };
    return {
      id,
      label: String(n['label'] ?? ''),
      type: String(n['type'] ?? ''),
      project: String(n['project'] ?? ''),
      group: String(n['type'] ?? ''),
      supersededBy: nonEmpty(n['supersededBy']),
      supersededAt: nonEmpty(n['supersededAt']),
      supersededReason: nonEmpty(n['supersededReason']),
    };
  });

  const edgeRes = await http.query(
    tenantDb,
    `SELECT relation, confidence, confidenceScore, ` +
      `outV().id AS source, inV().id AS target FROM ${EDGE_TYPE} LIMIT ${eLimit}`,
  );
  const edges: unknown[] = [];
  for (const e of (edgeRes.result ?? []) as Row[]) {
    const from = String(e['source'] ?? '');
    const to = String(e['target'] ?? '');
    // Close the graph over the returned node window (matches LocalGraph, whose
    // project-filtered edge query only returns edges with both endpoints in set).
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    edges.push({
      from,
      to,
      label: String(e['relation'] ?? ''),
      confidence: e['confidence'] ?? 'extracted',
      confidenceScore: typeof e['confidenceScore'] === 'number' ? e['confidenceScore'] : 1.0,
    });
  }
  return { nodes, edges };
}

/** Coerce a limit to a safe non-negative integer (SP-05 parity). */
function clampInt(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(0, Math.floor(n)), 100_000);
}
