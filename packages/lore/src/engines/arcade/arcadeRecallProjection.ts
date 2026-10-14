/**
 * arcadeRecallProjection.ts — column projection for arcade semantic recall
 * (3.34.0, Nokshi M4). ON by default; LORE_ARCADE_RECALL_PROJECTION=off|0|false
 * turns it off.
 *
 * THE PROBLEM. ArcadeVectorStore.search runs
 *   SELECT vector.neighbors("LoreVerbatim[embedding]", :vec, :k) AS neighbors
 * with k = max(40, limit*4) <= 400. Measured against ArcadeDB 26.7.1: each hit
 * is the whole record (flat columns plus a nested `record` copy, no `vertex`
 * key) and carries its `embedding` array, in fact twice. At dimension 1024 that
 * is about 14 KB per hit: 562 KB per recall at k = 40 and 5.6 MB at k = 400,
 * serialised in the ArcadeDB heap and parsed again here, on every call. Lore
 * only needs the scalar columns.
 *
 * THE PROJECTION. `buildProjectedNeighborsSql` selects just those columns from
 * the expanded neighbour list. Verified live on ArcadeDB 26.7.1 (1,013 nodes,
 * dimension 1024, 12 query/limit/filter cases): same ids in the same order,
 * identical scores and mapped fields, 23x fewer response bytes (5.6 MB -> 0.24 MB
 * at k = 400). NOTE the live check caught a wrong first draft: expand() yields
 * FLAT rows, so `vertex.id` is null and the statement "succeeded" with every
 * column null. parseProjectedNeighbors therefore rejects rows without a string id.
 * Safety net: if the projected statement errors with a 4xx, or returns rows
 * that do not look like projected neighbours, the caller latches the projection
 * OFF for the life of the process (logging once) and falls back to the original
 * statement, so a wrong guess costs one failed query, not recall.
 */

export const PROJECTED_COLUMNS = [
  'id', 'text', 'type', 'label', 'tags', 'project', 'ecosystem', 'updatedAt', 'security_scopes',
] as const;

/** Default ON; only an explicit off/0/false disables it. */
export function recallProjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false)$/i.test((env['LORE_ARCADE_RECALL_PROJECTION'] ?? '').trim());
}

/** The projected statement. `text` is backtick-quoted (26.7.1 parses bare `text` as the TEXT keyword). */
export function buildProjectedNeighborsSql(verbatimType: string): string {
  // expand() yields FLAT rows (the record's own columns plus `distance`), NOT a
  // nested `vertex`: verified against ArcadeDB 26.7.1, where `vertex.id` is null.
  const cols = PROJECTED_COLUMNS.map((c) => (c === 'text' ? '`text`' : c));
  return (
    `SELECT ${cols.join(', ')}, distance ` +
    `FROM (SELECT expand(vector.neighbors("${verbatimType}[embedding]", :vec, :k)))`
  );
}

/**
 * 3.34.0 (N5) - the "is this row answered by the vector index?" self-check: ask for the neighbours of
 * the row's OWN embedding (a server-side subquery, so no embedding crosses the wire) and see whether
 * the row comes back. Projected to `id, distance` only - never the embedding (the M4 out-of-memory
 * shape). Verified against ArcadeDB 26.7.1; `:id` / `:k` only (`:after` is reserved).
 *
 * Dialect trap found live: a bare scalar subquery evaluates to a LIST of rows, and passing that as the
 * query vector is HTTP 500 "Unsupported query vector type: Object[]". It must be indexed:
 * `(SELECT embedding ... WHERE id = :id)[0].embedding` (the `.embedding` suffix on the subquery and the
 * LET form fail the same way).
 */
export function buildSelfNeighborsSql(verbatimType: string): string {
  return (
    `SELECT id, distance FROM (SELECT expand(vector.neighbors("${verbatimType}[embedding]", ` +
    `(SELECT embedding FROM ${verbatimType} WHERE id = :id)[0].embedding, :k)))`
  );
}

/**
 * parseProjectedNeighbors — map projected rows back to the `{ vertex, distance }`
 * shape search() already consumes. Returns null when the rows do not look like
 * projected neighbours (so the caller falls back); an empty result is a valid
 * empty neighbourhood.
 */
export function parseProjectedNeighbors(rows: unknown[]): Array<Record<string, unknown>> | null {
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (r === null || typeof r !== 'object') return null;
    const row = r as Record<string, unknown>;
    // A null/absent id means the engine did not resolve the columns (the
    // 26.7.1 `vertex.id` trap) — never treat that as a hit.
    if (typeof row['id'] !== 'string' || row['id'] === '' || typeof row['distance'] !== 'number') return null;
    const vertex: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (k !== 'distance' && !k.startsWith('@')) vertex[k] = v;
    out.push({ vertex, distance: row['distance'] });
  }
  return out;
}
