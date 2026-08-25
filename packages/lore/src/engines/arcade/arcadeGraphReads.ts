/**
 * arcadeGraphReads.ts — read-query bodies for ArcadeGraphStore (search /
 * listNodes / getStats), extracted so arcadeGraphStore.ts stays near the
 * repo's 500-line file-size target (CLAUDE.md File Size Budget). Mirrors the
 * existing localGraph.ts split into localGraphReads.ts / graphStats.ts.
 *
 * Every function here takes the (tenantDb, http) pair explicitly rather than
 * `this` — no method here can smuggle in a different tenant db than the one
 * ArcadeGraphStore passes, preserving the "tenantDb only ever comes from the
 * constructor" isolation invariant documented in arcadeGraphStore.ts.
 */

import type { GraphStats, LoreNode, BulkListQuery, BulkListPage } from '../../providers/types.js';
import type { ArcadeHttp } from './arcadeHttp.js';
import { rankSearchResults } from '../searchRanking.js';
import { tagsToArray } from '../normalizeTags.js';

/** Default row cap for search, mirrors the local engine's default. */
export const DEFAULT_LIST_LIMIT = 20;
/** Default row cap for no-arg/no-limit listNodes calls (SW-18 parity with LocalGraph). */
export const DEFAULT_LIST_NODES_CAP = 10_000;

type NodeRow = Record<string, unknown>;

const NODE_SELECT_COLUMNS =
  'id, type, label, content, tags, project, ecosystem, metadata, createdAt, updatedAt';

/**
 * Projection that also carries the lifecycle columns rowToNode hydrates
 * (supersededBy/…, stale/staleAt, ephemeral/ttl_ms). search/listNodes select
 * these so the returned LoreNodes carry supersession/stale state (callers that
 * render stale_warning need it) and so the history-exclusion WHERE has the
 * column available. Kept in sync with arcadeGraphStore.NODE_FULL_COLUMNS by
 * intent (both derive from arcadeSchema.NODE_PROPS).
 */
const SELECT_WITH_LIFECYCLE =
  NODE_SELECT_COLUMNS +
  ', supersededBy, supersededAt, supersededReason, stale, staleAt, ephemeral, ttl_ms' +
  ', success_count, failure_count, partial_count, confirmation_score';

/**
 * search — SEARCH_CONTRACT_VERSION=1 keyword search. Case-insensitive
 * substring match across label/content/tags, project/ecosystem AND-filters
 * applied before limit, ordered relevance desc then updatedAt desc (id asc
 * tiebreak) — identical contract to LocalGraph.search / DataplaneGraph.search.
 *
 * Plain SELECT with WHERE — no expand()/both() involved, so traps T1/T2
 * don't apply here. `q` is pre-lowercased and bound via params (never
 * string-concatenated); tags is a JSON-encoded string column, so a
 * substring match against it is equivalent to a substring match against
 * the tag list's serialized text (matches the CONTRACT's "tags" surface;
 * a tag like "auth" also matches inside "authentication" as prose text —
 * consistent with LocalGraph's tag matching being case-insensitive
 * substring-shaped at the string level here, not exact-membership).
 *
 * Reuses the shared `rankSearchResults` ranker (searchRanking.ts) so this
 * adapter produces the SAME ordering as LocalGraph/DataplaneGraph for
 * identical inputs — the single source of truth for SEARCH_CONTRACT order.
 */
export async function search(
  tenantDb: string,
  http: ArcadeHttp,
  nodeType: string,
  rowToNode: (row: NodeRow) => LoreNode,
  query: string,
  limit = DEFAULT_LIST_LIMIT,
  project = '*',
  ecosystem = '*',
  excludeHidden = false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _signals?: { scanCapHit: boolean },
): Promise<LoreNode[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const q = query.toLowerCase();
  const params: Record<string, unknown> = { q: `%${q}%` };
  let sql =
    `SELECT ${SELECT_WITH_LIFECYCLE} FROM ${nodeType} WHERE ` +
    `(content.toLowerCase() LIKE :q OR label.toLowerCase() LIKE :q OR tags.toLowerCase() LIKE :q)`;
  // History-aware default read: superseded rows (supersededBy set) are hidden
  // from default recall/search — parity with LocalGraph, which filters them in
  // the read layer. `excludeHidden` additionally drops archived nodes. Plain
  // SELECT WHERE — no expand()/both(), so traps T1/T2 don't apply.
  sql += ` AND (supersededBy IS NULL OR supersededBy = '')`;
  if (project !== '*') {
    sql += ` AND project = :project`;
    params['project'] = project;
  }
  if (ecosystem !== '*') {
    // '*'/''/NULL = unscoped row (core/ecosystemMatch.ts).
    sql += ` AND (ecosystem = :ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem IS NULL)`;
    params['ecosystem'] = ecosystem;
  }
  // Over-fetch a bounded candidate window (mirrors SEARCH_SCAN_CAP intent)
  // ordered updatedAt DESC so the retained window — if the true match set
  // exceeds it — favors the most-recently-updated rows, same tiebreak the
  // shared ranker applies.
  const scanCap = Math.max(clampedLimit, 2000);
  sql += ` ORDER BY updatedAt DESC LIMIT ${scanCap}`;
  const res = await http.query(tenantDb, sql, params);
  const candidates = ((res.result ?? []) as NodeRow[]).map((row) => rowToNode(row));
  return rankSearchResults(candidates, query, clampedLimit);
}

/**
 * listNodes — dynamic WHERE built from the provided filters (all bound via
 * params), ordered updatedAt DESC, capped at `limit` unless
 * `opts.unbounded` is set (batch callers). tag filter matches within the
 * JSON-encoded tags string via a bound LIKE — CONTRACT-DEVIATION: tags are
 * stored as a JSON-serialized string[] (see rowToNode), so an exact-array
 * membership predicate isn't directly expressible in SQL here; matching
 * against `"<tag>"` inside the JSON text is the equivalent substring-safe
 * proxy (a tag value can't itself contain an unescaped `"`).
 */
export async function listNodes(
  tenantDb: string,
  http: ArcadeHttp,
  nodeType: string,
  rowToNode: (row: NodeRow) => LoreNode,
  type?: string,
  tag?: string,
  project = '*',
  ecosystem = '*',
  limit?: number,
  opts?: { unbounded?: boolean; includeHistory?: boolean },
): Promise<LoreNode[]> {
  const params: Record<string, unknown> = {};
  let sql = `SELECT ${SELECT_WITH_LIFECYCLE} FROM ${nodeType} WHERE true`;
  // History-aware default: hide superseded rows unless includeHistory. Plain
  // WHERE on a scalar column — trap-free.
  if (!opts?.includeHistory) {
    sql += ` AND (supersededBy IS NULL OR supersededBy = '')`;
  }
  if (type) {
    sql += ` AND type = :type`;
    params['type'] = type;
  }
  if (tag) {
    // CONTRACT-DEVIATION: tags column is JSON-encoded text (see header);
    // matching the quoted tag literal within that text is the closest
    // equivalent to exact-membership without a native array column.
    sql += ` AND tags LIKE :tag`;
    params['tag'] = `%"${tag.toLowerCase()}"%`;
  }
  if (project !== '*') {
    sql += ` AND project = :project`;
    params['project'] = project;
  }
  if (ecosystem !== '*') {
    // '*'/''/NULL = unscoped row (core/ecosystemMatch.ts).
    sql += ` AND (ecosystem = :ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem IS NULL)`;
    params['ecosystem'] = ecosystem;
  }
  sql += ` ORDER BY updatedAt DESC`;
  if (!opts?.unbounded) {
    const effectiveLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), 10_000)
        : DEFAULT_LIST_NODES_CAP;
    sql += ` LIMIT ${effectiveLimit}`;
  }
  const res = await http.query(tenantDb, sql, params);
  return ((res.result ?? []) as NodeRow[]).map((row) => rowToNode(row));
}

/**
 * getStats — node/edge counts + per-type breakdown, honoring an optional
 * project filter on the node-side counts (matches LocalGraph.getStats'
 * `projectFilter` extension).
 */
export async function getStats(
  tenantDb: string,
  http: ArcadeHttp,
  nodeType: string,
  edgeType: string,
  projectFilter?: string,
): Promise<GraphStats> {
  const nodeParams: Record<string, unknown> = {};
  let nodeSql = `SELECT count(*) AS n FROM ${nodeType}`;
  if (projectFilter) {
    nodeSql += ` WHERE project = :project`;
    nodeParams['project'] = projectFilter;
  }
  const [nodeRes, edgeRes, typeRes] = await Promise.all([
    http.query(tenantDb, nodeSql, nodeParams),
    http.query(tenantDb, `SELECT count(*) AS n FROM ${edgeType}`),
    http.query(
      tenantDb,
      projectFilter
        ? `SELECT type, count(*) AS n FROM ${nodeType} WHERE project = :project GROUP BY type`
        : `SELECT type, count(*) AS n FROM ${nodeType} GROUP BY type`,
      projectFilter ? { project: projectFilter } : {},
    ),
  ]);
  const nodeCount = Number((nodeRes.result?.[0] as { n?: number } | undefined)?.n ?? 0);
  const edgeCount = Number((edgeRes.result?.[0] as { n?: number } | undefined)?.n ?? 0);
  const typeBreakdown: Record<string, number> = {};
  for (const row of (typeRes.result ?? []) as Array<{ type?: string; n?: number }>) {
    if (row.type) typeBreakdown[row.type] = Number(row.n ?? 0);
  }
  return { nodeCount, edgeCount, typeBreakdown };
}

/**
 * arcadeTagsToArray — parse the JSON-encoded tags string column into the
 * canonical normalized string[] (arcade stores tags as JSON, LocalGraph as a
 * STRING[]). Pre-parses the JSON so tagsToArray's Array branch runs instead of
 * comma-splitting the JSON text. Mirrors arcadeGraphStore.rowToNode's tag path.
 */
function arcadeTagsToArray(rawTags: unknown): string[] {
  if (Array.isArray(rawTags)) return tagsToArray(rawTags.map(String));
  if (typeof rawTags === 'string' && rawTags.length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      return tagsToArray(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * bulkListArcadeNodes — cursor-paginated node enumeration (POST
 * /api/nodes/bulk-list) for ArcadeGraphStore. Byte-parity target: emit the SAME
 * per-row projection + (updatedAt DESC, id ASC) ordering + limit+1 hasMore
 * detection LocalGraph's graphBulkList.bulkListNodes produces, so the arcade
 * cell paginates identically to a local workspace.
 *
 * Plain SELECT WHERE + ORDER BY + LIMIT — no expand()/both()/vector.neighbors,
 * so the three ArcadeDB SQL traps don't apply. All caller input (types, tags,
 * project, cursor) is bound via params; only the integer page size (limit+1) is
 * interpolated (ArcadeDB has no LIMIT param slot), clamped upstream by the route.
 */
export async function bulkListArcadeNodes(
  tenantDb: string,
  http: ArcadeHttp,
  nodeType: string,
  q: BulkListQuery,
): Promise<BulkListPage> {
  const filters: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.types && q.types.length > 0) {
    const ors: string[] = [];
    q.types.forEach((t, i) => {
      const k = `type${i}`;
      ors.push(`type = :${k}`);
      params[k] = t;
    });
    filters.push(`(${ors.join(' OR ')})`);
  }
  if (q.tags && q.tags.length > 0) {
    // tags is a JSON-encoded string column (CONTRACT-DEVIATION, see
    // listNodes) — match the quoted lowercased tag literal within the JSON
    // text as the exact-membership proxy, same as arcade listNodes.
    const ors: string[] = [];
    q.tags.forEach((t, i) => {
      const k = `tag${i}`;
      ors.push(`tags LIKE :${k}`);
      params[k] = `%"${t.toLowerCase()}"%`;
    });
    filters.push(`(${ors.join(' OR ')})`);
  }
  if (q.project) {
    filters.push('project = :project');
    params['project'] = q.project;
  }
  if (q.ecosystem && q.ecosystem !== '*') {
    // '*'/''/NULL on the ROW is a WILDCARD (core/ecosystemMatch.ts
    // `isUnscopedEcosystem`) — the pushdown must never drop a row the JS
    // filter would keep. Was strict equality, so a scoped bulkList hid every
    // node written with the schema default. R5 #6: the `IS NULL` arm was also
    // missing here while both sibling Arcade predicates (search at :90,
    // listNodes at :150) carry it.
    filters.push(`(ecosystem = :ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem IS NULL)`);
    params['ecosystem'] = q.ecosystem;
  }
  if (q.cursor) {
    // Strict-after under (updatedAt DESC, id ASC) — mirrors bulkListNodes.
    filters.push('(updatedAt < :cursorUpdatedAt OR (updatedAt = :cursorUpdatedAt AND id > :cursorId))');
    params['cursorUpdatedAt'] = q.cursor.updatedAt;
    params['cursorId'] = q.cursor.id;
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const pageSize = q.limit + 1;
  const sql =
    `SELECT id, type, label, content, tags, metadata, project, ecosystem, ` +
    `updatedAt, createdAt FROM ${nodeType} ${where} ` +
    `ORDER BY updatedAt DESC, id ASC LIMIT ${pageSize}`;
  const res = await http.query(tenantDb, sql, params);
  const rows = (res.result ?? []) as Array<Record<string, unknown>>;
  // Match LocalGraph's row projection: tags → array; security_scopes → [] (the
  // LoreNode graph vertex carries no scopes column on arcade, and LocalGraph's
  // default for an absent value is []).
  const projected = rows.map((r) => ({
    id: String(r['id'] ?? ''),
    type: String(r['type'] ?? ''),
    label: String(r['label'] ?? ''),
    content: String(r['content'] ?? ''),
    tags: arcadeTagsToArray(r['tags']),
    metadata: String(r['metadata'] ?? '{}'),
    project: String(r['project'] ?? ''),
    ecosystem: String(r['ecosystem'] ?? '*'),
    updatedAt: String(r['updatedAt'] ?? ''),
    createdAt: String(r['createdAt'] ?? ''),
    security_scopes: [] as string[],
  }));
  const hasMore = projected.length > q.limit;
  const nodes = hasMore ? projected.slice(0, q.limit) : projected;
  const last = nodes.length > 0 ? nodes[nodes.length - 1]! : null;
  const nextCursor = hasMore && last
    ? { updatedAt: last.updatedAt, id: last.id }
    : null;
  return { nodes, hasMore, nextCursor };
}

/**
 * queryEdgesArcade — paginated edge query (GET /api/edges) for
 * ArcadeGraphStore. Byte-parity target: same {sourceId, targetId, relation,
 * confidence, confidenceScore} result shape + defaults ('extracted' / 1.0) as
 * graphEdges.queryEdges. Uses the verified `outV().id`/`inV().id` projection
 * (never the dotted `out.`/`in.` form — the T1 edge-link-field trap that
 * silently returns NULL endpoints). SKIP/LIMIT paginate; ArcadeDB has no LIMIT
 * param slot so the clamped ints are interpolated, all filters bound via params.
 */
export async function queryEdgesArcade(
  tenantDb: string,
  http: ArcadeHttp,
  edgeType: string,
  q: { source?: string; target?: string; relation?: string; limit: number; offset: number },
): Promise<Array<{ sourceId: string; targetId: string; relation: string; confidence: string; confidenceScore: number }>> {
  const params: Record<string, unknown> = {};
  const filters: string[] = [];
  if (q.source) { filters.push('outV().id = :source'); params['source'] = q.source; }
  if (q.target) { filters.push('inV().id = :target'); params['target'] = q.target; }
  if (q.relation) { filters.push('relation = :relation'); params['relation'] = q.relation; }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Math.floor(q.limit), 1), 1000);
  const offset = Math.max(Math.floor(q.offset), 0);
  // No ORDER BY (mirrors graphEdges.queryEdges, which paginates SKIP/LIMIT with
  // no ordering) — the GET /api/edges contract compares the edge SET, not order.
  const sql =
    `SELECT relation, confidence, confidenceScore, outV().id AS sourceId, inV().id AS targetId ` +
    `FROM ${edgeType} ${where} SKIP ${offset} LIMIT ${limit}`;
  const res = await http.query(tenantDb, sql, params);
  return ((res.result ?? []) as Array<Record<string, unknown>>).map((r) => ({
    sourceId: String(r['sourceId'] ?? ''),
    targetId: String(r['targetId'] ?? ''),
    relation: String(r['relation'] ?? ''),
    confidence: (r['confidence'] as string) ?? 'extracted',
    confidenceScore: typeof r['confidenceScore'] === 'number' ? (r['confidenceScore'] as number) : 1.0,
  }));
}
