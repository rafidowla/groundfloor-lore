/**
 * arcadeGraphStore.ts — EXPERIMENTAL SPIKE CODE (spike/arcadedb-multitenant).
 *
 * Tenant-scoped ArcadeDB graph adapter. Implements the crown-jewel graph ops
 * (upsertNode / getNode / addEdge / traverse) behind the Lore GraphProvider
 * shape so it can be dropped into `LoreStorageClient.fromLocal(...)` with the
 * five extra LoreGraphHandle maintenance methods stubbed as not-in-spike.
 *
 * ── ISOLATION MODEL: one ArcadeDB database per tenant ──────────────────────
 * The single most important property of this class: a caller for
 * `tenant_alpha` can NEVER reach `tenant_beta` data through ANY method.
 *
 * How that is structurally enforced (not merely by convention):
 *   1. `tenantDb` is a `private readonly` field set ONCE in the constructor.
 *      There is no setter and no method takes a db/tenant parameter — the ONLY
 *      tenant input to the whole object is the constructor argument. (Spec
 *      RULE: no method may accept a database/tenant parameter.)
 *   2. Every HTTP call routes through `this.http.command(this.tenantDb, ...)`
 *      or `this.http.query(this.tenantDb, ...)`. The db name lands in the URL
 *      path, and ArcadeDB has no single-command cross-database primitive, so
 *      the request physically cannot address another database.
 *   3. The db name is NEVER built from request payloads (node ids, project
 *      strings, filters). All caller-supplied values go through ArcadeDB
 *      `params` (server-side parameter binding), never string interpolation —
 *      so a payload like `'../tenant_beta'` or `"x' OR 1=1 --"` is treated as
 *      opaque data inside tenant_alpha and can never cross the wall.
 */

import type {
  GraphStats,
  LoreEdge,
  LoreNode,
  TraversalResult,
} from '../../providers/types.js';
import { ArcadeHttp, retryIdempotentArcadeWrite } from './arcadeHttp.js';
import * as reads from './arcadeGraphReads.js';
import * as maint from './arcadeMaintenance.js';
import * as edges from './arcadeGraphEdges.js';
import { bulkUpsertNodes as bulkUpsertImpl } from './arcadeBulk.js';
import { graphSchemaDdl, NODE_TYPE, EDGE_TYPE } from './arcadeSchema.js';
import { rowToLoreNode } from '../loreNodeRow.js';
import type { EdgeQuery, BulkListQuery, BulkListPage } from '../../providers/types.js';
import { bulkListArcadeNodes, queryEdgesArcade } from './arcadeGraphReads.js';
import {
  neighbors1Hop as neighbors1HopImpl,
  subgraphFetch as subgraphFetchImpl,
  type NeighborRow,
  type SubgraphNode,
  type SubgraphEdge,
} from './arcadeGraphNeighbors.js';

/** Contract cap — mirrors TRAVERSE_NODE_CAP in the local engine. */
const TRAVERSE_NODE_CAP = 500;

/**
 * Full LoreNode projection — every column rowToNode reads, including the
 * slice-2 lifecycle columns. Shared by getNode/getNodesByIds so a point read
 * hydrates supersession/stale/ephemeral (needed for history-aware reads +
 * prune parity). arcadeGraphReads.ts keeps its own narrower list for the
 * list/search paths where lifecycle columns aren't projected into results.
 */
const NODE_FULL_COLUMNS =
  'id, type, label, content, tags, project, ecosystem, metadata, createdAt, updatedAt, ' +
  'supersededBy, supersededAt, supersededReason, stale, staleAt, ephemeral, ttl_ms, ' +
  'success_count, failure_count, partial_count, confirmation_score';

/** Row shape ArcadeDB returns for a LoreNode vertex. */
type NodeRow = Record<string, unknown>;

export class ArcadeGraphStore {
  /** IMMUTABLE tenant database name — the isolation boundary. */
  private readonly tenantDb: string;
  private readonly http: ArcadeHttp;
  private schemaReady = false;

  constructor(opts: { tenantDb: string; http: ArcadeHttp }) {
    this.tenantDb = opts.tenantDb;
    this.http = opts.http;
  }

  // ── schema init (once per tenant DB) ─────────────────────────────────────
  //
  // DDL comes from arcadeSchema.ts (graphSchemaDdl) — the SAME statements the
  // daemon-operator provisioner runs, so the adapter-lazy-init path (tests /
  // spikes constructing an adapter directly) and pre-provisioning never drift.
  // Every statement is IF NOT EXISTS, so this is a no-op against an already-
  // provisioned cell and only adds the slice-2 lifecycle columns
  // (supersededBy/…, stale/staleAt, ephemeral/ttl_ms) when they're absent.
  async initialize(): Promise<void> {
    if (this.schemaReady) return;
    for (const stmt of graphSchemaDdl()) {
      await this.http.command(this.tenantDb, stmt);
    }
    this.schemaReady = true;
  }

  // ── crown-jewel ops ──────────────────────────────────────────────────────

  /**
   * upsertNode — parameterized UPSERT keyed on id. Sets createdAt on insert,
   * updatedAt always. tags serialized to a JSON string; all values bound via
   * ArcadeDB `params` (never interpolated).
   */
  async upsertNode(
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
  ): Promise<LoreNode> {
    await this.initialize();
    const now = new Date().toISOString();
    const existing = await this.getNode(node.id);
    const createdAt = existing?.createdAt ?? now;
    // Lifecycle columns are read-modify-write like LocalGraph.upsertNode: an
    // upsert that omits ephemeral/ttl_ms must NOT clobber a value a prior write
    // set. Preserve the existing row's lifecycle fields when the incoming node
    // doesn't carry them; a plain re-store therefore doesn't reset supersession
    // or the ephemeral flag (parity with LocalGraph's SET-branch semantics).
    const params = {
      id: node.id,
      type: node.type ?? '',
      label: node.label ?? '',
      content: node.content ?? '',
      tags: JSON.stringify(node.tags ?? []),
      project: node.project ?? '',
      // WIRE PARITY (slice-3 close): default ecosystem/metadata to the SAME
      // store-time defaults LocalGraph's schema uses (ecosystem DEFAULT '*';
      // metadata read-back defaults to '{}'), so a node posted without these
      // fields round-trips identically on both backends instead of persisting an
      // empty string that rowToLoreNode's `?? '*'` / `?? '{}'` can't rescue.
      ecosystem: node.ecosystem && node.ecosystem.length > 0 ? node.ecosystem : '*',
      metadata: node.metadata && node.metadata.length > 0 ? node.metadata : '{}',
      createdAt,
      updatedAt: now,
      supersededBy: node.supersededBy ?? existing?.supersededBy ?? '',
      supersededAt: node.supersededAt ?? existing?.supersededAt ?? '',
      supersededReason: node.supersededReason ?? existing?.supersededReason ?? '',
      stale: node.stale ?? existing?.stale ?? false,
      staleAt: (node as { staleAt?: string }).staleAt ?? (existing as { staleAt?: string } | null)?.staleAt ?? '',
      ephemeral: node.ephemeral ?? existing?.ephemeral ?? false,
      ttl_ms: node.ttl_ms ?? existing?.ttl_ms ?? 0,
      // Feature-2 outcome counters — read-modify-write preserve (like the
      // lifecycle columns): a plain re-store must not reset counts a prior
      // record_outcome set. Default 0 / 0.0 on first insert (LocalGraph schema
      // default) so a fresh node's full-projection read emits 0, not undefined.
      success_count: node.success_count ?? existing?.success_count ?? 0,
      failure_count: node.failure_count ?? existing?.failure_count ?? 0,
      partial_count: node.partial_count ?? existing?.partial_count ?? 0,
      confirmation_score: node.confirmation_score ?? existing?.confirmation_score ?? 0,
    };
    // UPSERT: updates the row matching id, or inserts one if absent. Retried
    // on transient 502/503/504 (retryIdempotentArcadeWrite) — this exact
    // statement is a full-column overwrite keyed by id, so replaying it with
    // the same params is safe even if a prior attempt's response was lost.
    // See that helper's doc comment for the real, observed 503 burst this
    // was written to recover from (ArcadeDB's own vector-index rebuild
    // saturating the server under rapid sequential writes).
    await retryIdempotentArcadeWrite(() => this.http.command(
      this.tenantDb,
      `UPDATE ${NODE_TYPE} SET id = :id, type = :type, label = :label, ` +
        `content = :content, tags = :tags, project = :project, ` +
        `ecosystem = :ecosystem, metadata = :metadata, ` +
        `createdAt = :createdAt, updatedAt = :updatedAt, ` +
        `supersededBy = :supersededBy, supersededAt = :supersededAt, ` +
        `supersededReason = :supersededReason, stale = :stale, staleAt = :staleAt, ` +
        `ephemeral = :ephemeral, ttl_ms = :ttl_ms, ` +
        `success_count = :success_count, failure_count = :failure_count, ` +
        `partial_count = :partial_count, confirmation_score = :confirmation_score ` +
        `UPSERT WHERE id = :id`,
      params,
    ));
    const stored = await this.getNode(node.id);
    if (!stored) {
      throw new Error(`[ArcadeGraphStore] upsertNode failed to persist ${node.id}`);
    }
    return stored;
  }

  /** getNode — parameterized single-row lookup by id. */
  async getNode(id: string): Promise<LoreNode | null> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT ${NODE_FULL_COLUMNS} FROM ${NODE_TYPE} WHERE id = :id LIMIT 1`,
      { id },
    );
    const row = res.result?.[0] as NodeRow | undefined;
    return row ? this.rowToNode(row) : null;
  }

  /**
   * addEdge — creates a LoreEdge between two existing nodes. If either
   * endpoint is missing INSIDE THIS TENANT DB, the CREATE EDGE resolves an
   * empty FROM/TO set and we throw (matching LocalGraph's "missing endpoint =>
   * throw"). This is what makes I3 (edge-cross) fail cleanly: a beta node id
   * simply does not resolve inside tenant_alpha.
   */
  async addEdge(edge: LoreEdge): Promise<void> {
    await this.initialize();
    // Preflight: both endpoints must exist in THIS db.
    const src = await this.getNode(edge.sourceId);
    const tgt = await this.getNode(edge.targetId);
    if (!src) {
      throw new Error(`[ArcadeGraphStore] addEdge: source not found: ${edge.sourceId}`);
    }
    if (!tgt) {
      throw new Error(`[ArcadeGraphStore] addEdge: target not found: ${edge.targetId}`);
    }
    // Idempotent per directed (source,target,relation) triple, matching the
    // contract LocalGraph/SurrealGraph's addEdge already guarantee (there is
    // no uniqueness constraint on LoreEdge at the ArcadeDB schema level —
    // confirmed via arcadeSchema.ts, only NODE_TYPE/VERBATIM_TYPE have one —
    // so a plain CREATE EDGE would duplicate on a second call). Check first,
    // skip if it already exists, so this is also safe to retry.
    const existing = await this.queryEdges({ source: edge.sourceId, target: edge.targetId, relation: edge.relation, limit: 1, offset: 0 });
    if (existing.length > 0) return;
    // Retried on transient 502/503/504 (retryIdempotentArcadeWrite) — safe
    // now that the existence check above makes a replay a no-op instead of a
    // duplicate. See that helper's doc comment for the observed 503 burst
    // this was written to recover from.
    await retryIdempotentArcadeWrite(() => this.http.command(
      this.tenantDb,
      `CREATE EDGE ${EDGE_TYPE} FROM (SELECT FROM ${NODE_TYPE} WHERE id = :src) ` +
        `TO (SELECT FROM ${NODE_TYPE} WHERE id = :tgt) ` +
        `SET relation = :rel, confidence = :conf, confidenceScore = :score`,
      {
        src: edge.sourceId,
        tgt: edge.targetId,
        rel: edge.relation,
        conf: edge.confidence ?? 'extracted',
        score: edge.confidenceScore ?? 1.0,
      },
    ));
  }

  /**
   * traverse — iterative per-depth BFS honoring SEARCH_CONTRACT_VERSION=1:
   * true hop depth per node, min-depth dedupe (visited set), depth-ascending
   * order, exact-match relation filter, result cap.
   *
   * Mirrors localGraphReads.traverseUncached's 1-hop-per-depth walk — easier
   * to keep depth-correct than a single MATCH. Each frontier query is
   * parameterized and scoped to `this.tenantDb`, so no hop can leave the tenant.
   *
   * CONTRACT-DEVIATION (relation-filtered hop, discovered during spike testing):
   * `both('LoreEdge').relation CONTAINS :rel` looks like the natural ArcadeDB
   * SQL for "expand neighbors where the connecting edge's relation matches",
   * but `both(...)` expands to VERTEX rows — `.relation` is an EDGE property,
   * so the projection silently evaluates to null for every row and the
   * predicate always eliminates all candidates (confirmed live against
   * v26.8.1-SNAPSHOT: unfiltered `both()` returns rows, the same query with
   * `.relation CONTAINS :rel` appended returns zero, even though the edges
   * being traversed do carry that relation). The original code masked this
   * with a client-side `edgeExists` re-check per candidate, but since the
   * candidate set itself was already empty, no relation-filtered traversal
   * ever returned a neighbor. Fixed by filtering on `bothE('LoreEdge')`
   * (returns EDGE rows, where `.relation` resolves correctly) and then
   * expanding to the neighbor vertex via `inV()`/`outV()` (both are queried
   * since `both()`/`bothE()` are direction-agnostic; the anchor's own id is
   * excluded from each branch since it is always on one end of the edge).
   */
  async traverse(
    nodeId: string,
    maxDepth = 2,
    relation?: string,
  ): Promise<TraversalResult[]> {
    await this.initialize();
    const visited = new Set<string>([nodeId]);
    const out: TraversalResult[] = [];
    let frontier: string[] = [nodeId];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const next: string[] = [];
      for (const fromId of frontier) {
        const rows = relation
          ? await this.neighborsByRelation(fromId, relation)
          : await this.neighborsAny(fromId);
        for (const row of rows) {
          const nbId = String(row['id'] ?? '');
          if (!nbId || visited.has(nbId)) continue;
          visited.add(nbId);
          out.push({ node: this.rowToNode(row), depth, relation: relation ?? '' });
          next.push(nbId);
          if (out.length >= TRAVERSE_NODE_CAP) {
            return out; // already depth-ascending (outer loop increments depth)
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return out; // built in depth-ascending order by construction
  }

  /** All 1-hop neighbors of `fromId`, any relation. */
  private async neighborsAny(fromId: string): Promise<NodeRow[]> {
    const res = await this.http.query(
      this.tenantDb,
      `SELECT expand(both('${EDGE_TYPE}')) FROM ${NODE_TYPE} WHERE id = :id`,
      { id: fromId },
    );
    return (res.result ?? []) as NodeRow[];
  }

  /**
   * 1-hop neighbors of `fromId` reached by an edge whose `relation` matches
   * EXACTLY. Filters on the edge row itself (bothE) — see CONTRACT-DEVIATION
   * note on traverse() for why filtering on both()'s vertex projection does
   * not work. `inV()`/`outV()` cover both edge directions; the WHERE id <> :id
   * on each branch excludes the anchor vertex (which is always one endpoint).
   */
  private async neighborsByRelation(fromId: string, relation: string): Promise<NodeRow[]> {
    // ArcadeDB's SQL dialect on this version does not support UNION/UNION ALL
    // (confirmed live: CommandSQLParsingException), so inV()/outV() are
    // queried separately and merged client-side rather than in one statement.
    const params = { id: fromId, rel: relation };
    const [inRes, outRes] = await Promise.all([
      this.http.query(
        this.tenantDb,
        `SELECT expand(inV()) FROM (SELECT FROM (SELECT expand(bothE('${EDGE_TYPE}')) ` +
          `FROM ${NODE_TYPE} WHERE id = :id) WHERE relation = :rel) WHERE id <> :id`,
        params,
      ),
      this.http.query(
        this.tenantDb,
        `SELECT expand(outV()) FROM (SELECT FROM (SELECT expand(bothE('${EDGE_TYPE}')) ` +
          `FROM ${NODE_TYPE} WHERE id = :id) WHERE relation = :rel) WHERE id <> :id`,
        params,
      ),
    ]);
    return [...((inRes.result ?? []) as NodeRow[]), ...((outRes.result ?? []) as NodeRow[])];
  }

  // ── stats helper (used by isolation count check) ─────────────────────────
  async nodeCount(): Promise<number> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT count(*) AS n FROM ${NODE_TYPE}`,
    );
    const row = res.result?.[0] as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  // ── row → LoreNode ───────────────────────────────────────────────────────
  /**
   * rowToNode — canonical-parity mapping. WIRE PARITY (slice-3 close): the
   * public LoreNode shape MUST be byte-identical to what LocalGraph emits, so
   * this delegates to the SAME pure serializer LocalGraph uses
   * (localGraphReads.rowToLoreNode). That serializer fills the FULL canonical
   * field set with LocalGraph's exact defaults (metadata '{}', ecosystem '*',
   * security_scopes [], status 'active', classification 'tactical', zeroed/
   * undefined counters, empty-string→null lifecycle coercion, stale/ephemeral →
   * undefined-when-false so JSON drops them) — no hand-maintained arcade copy to
   * drift.
   *
   * TWO arcade-specific adaptations before/after the shared serializer:
   *   1. tags — ArcadeDB stores tags as a JSON-encoded string ('["a","b"]');
   *      LocalGraph stores a STRING[]. tagsToArray (which rowToLoreNode calls)
   *      would mis-split the JSON on commas, so we pre-parse the JSON to a real
   *      array and hand rowToLoreNode the array form it round-trips cleanly.
   *   2. staleAt — not a public LoreNode field (LocalGraph never emits it), so
   *      it MUST stay off the enumerable wire shape, but upsertNode's read-
   *      modify-write preservation reads it back off the returned node. Attach
   *      it as a NON-ENUMERABLE property: internal `.staleAt` access works,
   *      JSON.stringify (the wire) drops it → local parity preserved.
   */
  private rowToNode(row: NodeRow): LoreNode {
    // (1) tags: JSON string → real array so rowToLoreNode's tagsToArray takes
    // the Array branch instead of comma-splitting the JSON text.
    let tags: string[] = [];
    const rawTags = row['tags'];
    if (Array.isArray(rawTags)) {
      tags = rawTags.map(String);
    } else if (typeof rawTags === 'string' && rawTags.length > 0) {
      try {
        const parsed = JSON.parse(rawTags);
        tags = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        tags = [];
      }
    }
    const node = rowToLoreNode({ ...row, tags });
    // (2) staleAt — non-enumerable so it survives internal reads but never
    // reaches the JSON wire (LocalGraph parity).
    const staleAtRaw = row['staleAt'] == null ? '' : String(row['staleAt']);
    Object.defineProperty(node, 'staleAt', {
      value: staleAtRaw.length > 0 ? staleAtRaw : null,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return node;
  }

  /**
   * getNodesByIds — SW-16 batch hydration. ArcadeDB's SQL supports a bound
   * `IN` list (params accept arrays), so this is ONE round-trip instead of
   * the prior per-id loop. Absent ids are simply missing from the returned
   * Map (same contract as GraphProvider.getNodesByIds).
   */
  async getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> {
    await this.initialize();
    const map = new Map<string, LoreNode>();
    if (ids.length === 0) return map;
    const res = await this.http.query(
      this.tenantDb,
      `SELECT ${NODE_FULL_COLUMNS} FROM ${NODE_TYPE} WHERE id IN :ids`,
      { ids },
    );
    for (const row of (res.result ?? []) as NodeRow[]) {
      const node = this.rowToNode(row);
      if (node.id) map.set(node.id, node);
    }
    return map;
  }

  /**
   * deleteNode — existence-checked delete of the vertex AND its incident
   * edges. ArcadeDB's `DELETE VERTEX` (as opposed to a plain `DELETE FROM`)
   * detaches incident edge records as part of the vertex delete, so a
   * subsequent traverse from a former neighbor sees nothing dangling —
   * confirmed live against the pinned 26.7.1 container (self-check below).
   * Returns true iff a row existed and was removed.
   */
  async deleteNode(id: string): Promise<boolean> {
    await this.initialize();
    const existing = await this.getNode(id);
    if (!existing) return false;
    await this.http.command(
      this.tenantDb,
      `DELETE VERTEX FROM ${NODE_TYPE} WHERE id = :id`,
      { id },
    );
    return true;
  }

  async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
    await this.addEdge(edge);
    await this.addEdge({ ...edge, sourceId: edge.targetId, targetId: edge.sourceId });
  }

  /**
   * search — SEARCH_CONTRACT_VERSION=1 keyword search. Delegates to
   * arcadeGraphReads.ts (extracted to keep this file near the 500-line file
   * size target). See that module's doc comment for the full contract +
   * trap-avoidance rationale (plain SELECT WHERE — traps T1/T2 don't apply).
   */
  async search(
    query: string,
    limit?: number,
    project?: string,
    ecosystem?: string,
    excludeHidden?: boolean,
    signals?: { scanCapHit: boolean },
  ): Promise<LoreNode[]> {
    await this.initialize();
    return reads.search(
      this.tenantDb,
      this.http,
      NODE_TYPE,
      this.rowToNode.bind(this),
      query,
      limit,
      project,
      ecosystem,
      excludeHidden,
      signals,
    );
  }

  /**
   * listNodes — dynamic WHERE built from the provided filters. Delegates to
   * arcadeGraphReads.ts; see that module's doc comment for the tag-match
   * CONTRACT-DEVIATION (JSON-encoded tags column).
   */
  async listNodes(
    type?: string,
    tag?: string,
    project?: string,
    ecosystem?: string,
    limit?: number,
    opts?: { unbounded?: boolean },
  ): Promise<LoreNode[]> {
    await this.initialize();
    return reads.listNodes(
      this.tenantDb,
      this.http,
      NODE_TYPE,
      this.rowToNode.bind(this),
      type,
      tag,
      project,
      ecosystem,
      limit,
      opts,
    );
  }

  /**
   * getStats — node/edge counts + per-type breakdown, honoring an optional
   * project filter on the node-side counts (matches LocalGraph.getStats'
   * `projectFilter` extension). Delegates to arcadeGraphReads.ts.
   */
  async getStats(projectFilter?: string): Promise<GraphStats> {
    await this.initialize();
    return reads.getStats(this.tenantDb, this.http, NODE_TYPE, EDGE_TYPE, projectFilter);
  }

  // ── topology (delegated — see arcadeGraphEdges.ts) ───────────────────────
  /**
   * getTopology — node + edge snapshot for the UI graph view. The edge query
   * selects FROM the LoreEdge table directly (never both()/expand-of-expand),
   * so traps T1/T2 don't apply — pinned in the hardening e2e. See
   * arcadeGraphEdges.computeTopology for the trap-avoidance rationale.
   */
  async getTopology(
    limit = 300,
    projects?: string[] | string,
    edgeLimit?: number,
  ): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    await this.initialize();
    return edges.computeTopology(this.tenantDb, this.http, limit, projects, edgeLimit);
  }

  // ── edges (delegated — see arcadeGraphEdges.ts) ──────────────────────────
  /**
   * getEdges — list edges optionally filtered by an incident node id. Direct
   * edge-table SELECT with the `out`/`in` link-field projection (trap-guarded).
   */
  async getEdges(nodeId?: string): Promise<LoreEdge[]> {
    await this.initialize();
    return edges.getEdges(this.tenantDb, this.http, nodeId);
  }

  /**
   * queryEdges — paginated edge query (GET /api/edges). Same method the local
   * route calls on LocalGraph; result shape + defaults match graphEdges.query
   * Edges. Delegates to arcadeGraphReads.queryEdgesArcade (verified outV()/inV()
   * link-field projection — the dotted form silently zeroes endpoints, trap T1).
   */
  async queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
    await this.initialize();
    const rows = await queryEdgesArcade(this.tenantDb, this.http, EDGE_TYPE, q);
    return rows.map((r) => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      relation: r.relation,
      confidence: r.confidence as LoreEdge['confidence'],
      confidenceScore: r.confidenceScore,
    }));
  }

  /**
   * bulkList — cursor-paginated node enumeration (POST /api/nodes/bulk-list).
   * Same method the local route calls on LocalGraph; delegates to
   * arcadeGraphReads.bulkListArcadeNodes (updatedAt DESC, id ASC ordering +
   * limit+1 hasMore, byte-parity with graphBulkList.bulkListNodes). The HTTP
   * layer owns cursor base64url (de/en)coding + limit clamping.
   */
  async bulkList(q: BulkListQuery): Promise<BulkListPage> {
    await this.initialize();
    return bulkListArcadeNodes(this.tenantDb, this.http, NODE_TYPE, q);
  }

  /**
   * neighbors1Hop — TYPED 1-hop neighbor fetch for GET /api/node (with
   * neighbors). Slice-3 parity close: replaces the raw-Cypher path (which the
   * ArcadeDB SQL parser rejected → silent-empty) with the portable
   * queryEdges + getNodesByIds verbs. The route feature-detects this method on
   * the graph handle; LocalGraph/DataplaneGraph do NOT expose it, so they keep
   * their byte-identical Cypher path.
   */
  async neighbors1Hop(id: string, ecosystem: string = '*'): Promise<{ outRows: NeighborRow[]; inRows: NeighborRow[] }> {
    await this.initialize();
    return neighbors1HopImpl(this, id, ecosystem);
  }

  /**
   * subgraphFetch — TYPED multi-hop BFS for GET /api/subgraph. Same slice-3
   * parity close as neighbors1Hop: portable queryEdges + getNodesByIds BFS
   * instead of raw Cypher. Returns the visited nodes (EXCLUDING the center,
   * which the route prepends at depth 0) + the closed edge set.
   */
  async subgraphFetch(
    centerId: string,
    center: { label: string; type: string; tags?: string[] },
    depth: number,
    limit: number,
    includeInferred: boolean,
    ecosystem: string = '*',
  ): Promise<{ nodes: SubgraphNode[]; edges: SubgraphEdge[] }> {
    await this.initialize();
    return subgraphFetchImpl(this, centerId, center, depth, limit, includeInferred, ecosystem);
  }

  /**
   * deleteEdge — remove every LoreEdge matching the (source,target,relation)
   * triple; returns the count deleted (0 = no match). Mirrors
   * LocalGraph.deleteEdge / graphEdges.deleteEdge semantics.
   */
  async deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
    await this.initialize();
    return edges.deleteEdge(this.tenantDb, this.http, sourceId, targetId, relation);
  }

  /**
   * pruneInferredLoreEdges — delete every LoreEdge whose relation starts with
   * the given prefix (e.g. "semantic_neighbor"). Direct edge-table WHERE (trap-
   * free — pinned). Returns the count deleted.
   */
  async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
    await this.initialize();
    return edges.pruneInferredLoreEdges(this.tenantDb, this.http, relationPrefix);
  }

  // ── lifecycle / maintenance (delegated — see arcadeMaintenance.ts) ───────
  /**
   * supersedeNode — mark `oldId` superseded by `newId`. Both must exist →
   * {ok:false,reason} otherwise (self / old-not-found / new-not-found), exactly
   * mirroring LocalGraph/nodeLifecycle.supersedeNode. Plain parameterized
   * UPDATE — traps don't apply.
   */
  async supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    await this.initialize();
    return maint.supersedeNode(this.tenantDb, this.http, (id) => this.getNode(id), oldId, newId, reason);
  }

  /** unsupersedeNode — clear the supersession columns; returns true iff the node existed. */
  async unsupersedeNode(id: string): Promise<boolean> {
    await this.initialize();
    return maint.unsupersedeNode(this.tenantDb, this.http, (nid) => this.getNode(nid), id);
  }

  /** markStaleByTags — mark stale every node whose tags include ANY input tag (exact membership); returns count. */
  async markStaleByTags(tags: string[]): Promise<number> {
    await this.initialize();
    return maint.markStaleByTags(this.tenantDb, this.http, tags);
  }

  /** 2026-09-03 (X-markstale audit fix) — read-only tag resolution; see LoreGraphHandle's doc comment. */
  async findNodeIdsByTags(tags: string[]): Promise<string[]> {
    await this.initialize();
    return maint.findNodeIdsByTags(this.tenantDb, this.http, tags);
  }

  /** 2026-09-03 (X-markstale audit fix) — mark stale exactly the given ids; returns count actually marked. */
  async markStaleByIds(ids: string[]): Promise<number> {
    await this.initialize();
    return maint.markStaleByIds(this.tenantDb, this.http, ids);
  }

  /** pruneEphemeralNodes — delete expired ephemeral nodes (client-side expiry math); returns count. */
  async pruneEphemeralNodes(defaultTtlMs = 3_600_000): Promise<number> {
    await this.initialize();
    return maint.pruneEphemeralNodes(this.tenantDb, this.http, defaultTtlMs);
  }

  // ── bulk (delegated — see arcadeBulk.ts) ─────────────────────────────────
  /**
   * bulkUpsertNodes — batched single-round-trip upsert. Chunks the batch into
   * sqlscript blocks (~50/chunk) so N nodes cost ceil(N/chunk) HTTP calls, not
   * N. Per-node {id,ok,error} result contract preserved via a per-chunk
   * fallback to individual upserts on whole-chunk failure. The facade
   * feature-detects this method (typeof graph.bulkUpsertNodes === 'function').
   */
  async bulkUpsertNodes(
    batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    await this.initialize();
    return bulkUpsertImpl(this.tenantDb, this.http, batch, (node) => this.upsertNode(node));
  }

  /**
   * getGraphContext — daemon-internal escape hatch: a thin cell-bound SQL
   * passthrough. NEVER HTTP-exposed in arcade mode (reach stays 403-walled by
   * the per-db user). Callers expecting Cypher (schema authoring, legacy-engine
   * migrations) remain unsupported — their routes aren't registered in arcade
   * mode. Only queryRows/executeQuery are provided.
   */
  getGraphContext(): {
    queryRows: (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    executeQuery: (sql: string, params?: Record<string, unknown>) => Promise<unknown>;
  } {
    return {
      queryRows: async (sql, params) => {
        const res = await this.http.query(this.tenantDb, sql, params);
        return (res.result ?? []) as Array<Record<string, unknown>>;
      },
      executeQuery: async (sql, params) => {
        const res = await this.http.command(this.tenantDb, sql, params);
        return res.result;
      },
    };
  }
}
