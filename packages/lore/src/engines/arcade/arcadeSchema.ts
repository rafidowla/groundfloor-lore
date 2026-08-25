/**
 * arcadeSchema.ts — SINGLE SOURCE OF TRUTH for the ArcadeDB db-per-app schema
 * (branch: spike/arcadedb-multitenant, slice 2 provider-completeness).
 *
 * WHY THIS FILE EXISTS
 * Before slice 2 the LoreNode / LoreVerbatim / LoreEdge property lists were
 * copy-pasted between arcadeProvisioner.ts (NODE_PROPS / VERBATIM_PROPS, the
 * real daemon-operator provisioning path) and the two adapters' lazy-init
 * (arcadeGraphStore.ts / arcadeVectorStore.ts, the test/spike path that
 * constructs an adapter directly). Two hand-maintained copies of the same DDL
 * is a structural drift risk: a column added on one path but not the other
 * produces a cell whose reads silently miss a field — exactly the silent-wrong
 * class of bug the slice-1 SQL-trap pins exist to kill. This module holds the
 * property lists + DDL emitters ONCE; provisioner and both adapters import it,
 * so drift is structurally impossible.
 *
 * SLICE-2 NEW COLUMNS (provider completeness): the lifecycle columns that the
 * finished provider methods read/write — supersededBy / supersededAt /
 * supersededReason (soft supersession, history-aware reads), stale / staleAt
 * (markStaleByTags), ephemeral / ttl_ms (pruneEphemeralNodes). Column names
 * match LocalGraph's LoreNode fields verbatim (providers/types.ts) so the
 * adapter's contract is byte-for-byte the local one — no rename drift between
 * the two backends.
 *
 * ADDITIVE-ONLY: every emitter uses `IF NOT EXISTS`, so applying the DDL to an
 * already-provisioned cell is a no-op for existing columns and only adds the
 * new ones. `provisionApp` re-run therefore upgrades an existing cell's schema
 * in place (idempotent), which is how a pre-slice-2 cell picks up the new
 * lifecycle columns without a destroy/recreate.
 */

/** Vertex + edge type names, shared across provisioner + both adapters. */
export const NODE_TYPE = 'LoreNode';
export const EDGE_TYPE = 'LoreEdge';
export const VERBATIM_TYPE = 'LoreVerbatim';

/**
 * Current per-cell schema version. Bumped whenever a new additive column lands
 * here so tenant_apps.schema_version can gate a stale cell (a request against a
 * cell provisioned before this version 503s cell_schema_stale rather than
 * tripping over a missing column silently). v1 = slice-1 baseline; v2 = slice-2
 * lifecycle columns (supersededBy/…, stale/staleAt, ephemeral/ttl_ms); v3 =
 * slice-3 wire-parity outcome counters (success/failure/partial_count,
 * confirmation_score).
 */
export const ARCADE_SCHEMA_VERSION = 3;

/**
 * LoreNode scalar properties. STRING for everything the adapter round-trips as
 * text (tags is a JSON-encoded string[]; metadata is opaque JSON text), plus
 * the slice-2 lifecycle columns. `stale` / `ephemeral` are BOOLEAN and `ttl_ms`
 * is LONG so the prune math reads a real number, not a stringified one.
 */
export const NODE_PROPS: ReadonlyArray<readonly [string, string]> = [
  ['id', 'STRING'],
  ['type', 'STRING'],
  ['label', 'STRING'],
  ['content', 'STRING'],
  ['tags', 'STRING'], // JSON-encoded string[] — see rowToNode / nodeParams
  ['project', 'STRING'],
  ['ecosystem', 'STRING'],
  ['metadata', 'STRING'],
  ['createdAt', 'STRING'],
  ['updatedAt', 'STRING'],
  // ── slice-2 lifecycle columns (names match LocalGraph LoreNode fields) ──
  ['supersededBy', 'STRING'],
  ['supersededAt', 'STRING'],
  ['supersededReason', 'STRING'],
  ['stale', 'BOOLEAN'],
  ['staleAt', 'STRING'],
  ['ephemeral', 'BOOLEAN'],
  ['ttl_ms', 'LONG'],
  // ── slice-3 wire-parity columns: Feature-2 outcome counters. LocalGraph's
  //    schema declares these with DEFAULT 0 / 0.0, so a full-projection read
  //    (getNode / node-list) emits 0 for a node with no recorded outcomes.
  //    Arcade's upsertNode seeds them to 0 so rowToLoreNode reads 0 (not
  //    undefined) → byte parity with the local canonical node shape.
  ['success_count', 'LONG'],
  ['failure_count', 'LONG'],
  ['partial_count', 'LONG'],
  ['confirmation_score', 'DOUBLE'],
];

/** LoreVerbatim scalar properties (the `embedding` ARRAY_OF_FLOATS + its HNSW
 *  index are declared separately by the vector-schema emitter below because
 *  they depend on the embedding dimension). */
export const VERBATIM_PROPS: ReadonlyArray<readonly [string, string]> = [
  ['id', 'STRING'],
  ['text', 'STRING'],
  ['type', 'STRING'],
  ['label', 'STRING'],
  ['tags', 'STRING'],
  ['project', 'STRING'],
  ['ecosystem', 'STRING'],
  ['updatedAt', 'STRING'],
  ['security_scopes', 'STRING'],
  ['contentHash', 'STRING'],
];

/** LoreEdge scalar properties (relation + confidence pair). */
export const EDGE_PROPS: ReadonlyArray<readonly [string, string]> = [
  ['relation', 'STRING'],
  ['confidence', 'STRING'],
  ['confidenceScore', 'DOUBLE'],
];

/** A single ArcadeDB SQL command string. */
export type DdlStatement = string;

/**
 * graphSchemaDdl — the ordered list of additive DDL statements for the LoreNode
 * vertex + LoreEdge edge type. Every statement is `IF NOT EXISTS`, so this is
 * safe to replay against an existing cell (schema upgrade in place).
 */
export function graphSchemaDdl(): DdlStatement[] {
  const out: DdlStatement[] = [`CREATE VERTEX TYPE ${NODE_TYPE} IF NOT EXISTS`];
  for (const [name, kind] of NODE_PROPS) {
    out.push(`CREATE PROPERTY ${NODE_TYPE}.${name} IF NOT EXISTS ${kind}`);
  }
  out.push(`CREATE INDEX IF NOT EXISTS ON ${NODE_TYPE} (id) UNIQUE`);
  out.push(`CREATE EDGE TYPE ${EDGE_TYPE} IF NOT EXISTS`);
  for (const [name, kind] of EDGE_PROPS) {
    out.push(`CREATE PROPERTY ${EDGE_TYPE}.${name} IF NOT EXISTS ${kind}`);
  }
  return out;
}

/**
 * verbatimSchemaDdl — the ordered DDL for the LoreVerbatim vertex, its scalar
 * props, the `embedding` ARRAY_OF_FLOATS column, and the native HNSW
 * (LSM_VECTOR) index sized to `embedDim`. Also additive / replay-safe.
 */
export function verbatimSchemaDdl(embedDim: number): DdlStatement[] {
  const out: DdlStatement[] = [`CREATE VERTEX TYPE ${VERBATIM_TYPE} IF NOT EXISTS`];
  for (const [name, kind] of VERBATIM_PROPS) {
    out.push(`CREATE PROPERTY ${VERBATIM_TYPE}.${name} IF NOT EXISTS ${kind}`);
  }
  out.push(`CREATE PROPERTY ${VERBATIM_TYPE}.embedding IF NOT EXISTS ARRAY_OF_FLOATS`);
  out.push(`CREATE INDEX IF NOT EXISTS ON ${VERBATIM_TYPE} (id) UNIQUE`);
  out.push(
    `CREATE INDEX IF NOT EXISTS ON ${VERBATIM_TYPE} (embedding) LSM_VECTOR METADATA ` +
      `{"dimensions": ${embedDim}, "similarity": "cosine", "maxConnections": 16, "beamWidth": 100}`,
  );
  return out;
}
