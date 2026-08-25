/**
 * arcadeScopedHandle.ts — full-provider-surface scope enforcement for the
 * ArcadeDB db-per-app adapters, so a scope-guarded pair can be dropped
 * straight into LoreStorageClient.fromLocal.
 * (branch: spike/arcadedb-multitenant, pre-production hardening slice)
 *
 * Why this exists (and not arcadeScopeGuard.ts): arcadeScopeGuard.ts wraps the
 * NARROW GuardableGraph/GuardableVector shape (the crown-jewel verbs the spike
 * exercised directly). LoreStorageClient.fromLocal needs the FULL
 * LoreGraphHandle (= GraphProvider + maintenance) / VectorProvider surface —
 * getNodesByIds, deleteNode, addBidirectionalEdge, search, listNodes, getStats,
 * getTopology, supersede*, prune*, etc. A wrapper that only covered the narrow
 * shape would not typecheck as a fromLocal handle. This wrapper delegates the
 * ENTIRE surface and gates ONLY the write verbs on an immutable scope set.
 *
 * ── COARSE RBAC (identical policy to arcadeScopeGuard.ts) ────────────────────
 *   - `scopes` is an immutable ReadonlySet captured at construction.
 *   - write verbs (upsertNode, addEdge, addBidirectionalEdge, deleteNode,
 *     supersedeNode, unsupersedeNode, markStaleByTags, pruneEphemeralNodes,
 *     pruneInferredLoreEdges; vector store/delete) throw ScopeError BEFORE any
 *     HTTP call when 'write' is absent.
 *   - read verbs pass straight through.
 *   - scopes NEVER widen reach — reach is fixed by the wrapped adapter's
 *     immutable tenantDb binding (the auth wall), scopes gate verbs only.
 *
 * The wrapper adds NO reach: it delegates to the SAME adapter instance bound to
 * the SAME single tenant db, so isolation is unchanged and defense-in-depth
 * (per-DB ArcadeDB user 403) still stands underneath.
 */

import type {
  GraphStats,
  LoreEdge,
  LoreNode,
  TraversalResult,
  VerbatimDocument,
  VerbatimSearchResult,
  EdgeQuery,
  BulkListQuery,
  BulkListPage,
} from '../../providers/types.js';
import type { LoreGraphHandle, LoreVectorHandle } from '../../storage/loreStorageClient.js';
import type { Bm25Envelope } from '../verbatimBm25Result.js';
import { ScopeError, type Scope } from './arcadeScopeGuard.js';
import type { NeighborRow, SubgraphNode, SubgraphEdge } from './arcadeGraphNeighbors.js';

/**
 * The methods ArcadeGraphStore exposes BEYOND LoreGraphHandle (deleteEdge /
 * getEdges / bulkUpsertNodes / getGraphContext). LoreGraphHandle doesn't declare
 * these, but the concrete ArcadeGraphStore implements them and the facade
 * feature-detects bulkUpsertNodes — so the wrapper accepts an inner handle that
 * provides both surfaces and forwards them without a cast.
 */
export interface ArcadeExtraGraph {
  deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number>;
  getEdges(nodeId?: string): Promise<LoreEdge[]>;
  /** GET /api/edges — paginated edge query (not on LoreGraphHandle; the route's
   *  LoreGraph union declares it on LocalGraph/DataplaneGraph). */
  queryEdges(q: EdgeQuery): Promise<LoreEdge[]>;
  /** POST /api/nodes/bulk-list — cursor-paginated node enumeration (same:
   *  concrete-only method the route reaches via the LoreGraph union). */
  bulkList(q: BulkListQuery): Promise<BulkListPage>;
  /** GET /api/node (neighbors) — typed 1-hop neighbor fetch. The route feature-
   *  detects this; local/dataplane lack it and keep their Cypher path. */
  neighbors1Hop(id: string, ecosystem?: string): Promise<{ outRows: NeighborRow[]; inRows: NeighborRow[] }>;
  /** GET /api/subgraph — typed multi-hop BFS (same feature-detect contract). */
  subgraphFetch(
    centerId: string,
    center: { label: string; type: string; tags?: string[] },
    depth: number,
    limit: number,
    includeInferred: boolean,
    ecosystem?: string,
  ): Promise<{ nodes: SubgraphNode[]; edges: SubgraphEdge[] }>;
  bulkUpsertNodes(
    batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  getGraphContext(): {
    queryRows: (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    executeQuery: (sql: string, params?: Record<string, unknown>) => Promise<unknown>;
  };
}

/** The methods ArcadeVectorStore exposes beyond VectorProvider (bm25Search +
 *  getById — the latter is what GET /api/verbatim/get feature-detects on
 *  store.loreVerbatim). */
export interface ArcadeExtraVector {
  bm25Search(
    query: string,
    limit?: number,
    filter?: Partial<VerbatimDocument['metadata']>,
    actorScopes?: ReadonlyArray<string>,
  ): Promise<Bm25Envelope<VerbatimSearchResult>>;
  getById(id: string): Promise<{ contentHash?: string; text?: string } | null>;
}

/** Full-surface, write-gated LoreGraphHandle wrapper. */
export class ScopedArcadeGraphHandle implements LoreGraphHandle {
  private readonly scopes: ReadonlySet<Scope>;
  constructor(
    private readonly inner: LoreGraphHandle & ArcadeExtraGraph,
    scopes: readonly Scope[],
  ) {
    this.scopes = new Set(scopes);
  }
  private requireWrite(): void {
    if (!this.scopes.has('write')) throw new ScopeError();
  }

  // ── passthrough lifecycle ────────────────────────────────────────────────
  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  // ── writes (gated pre-HTTP) ──────────────────────────────────────────────
  upsertNode(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
    this.requireWrite();
    return this.inner.upsertNode(node);
  }
  addEdge(edge: LoreEdge): Promise<void> {
    this.requireWrite();
    return this.inner.addEdge(edge);
  }
  addBidirectionalEdge(edge: LoreEdge): Promise<void> {
    this.requireWrite();
    return this.inner.addBidirectionalEdge(edge);
  }
  deleteNode(id: string): Promise<boolean> {
    this.requireWrite();
    return this.inner.deleteNode(id);
  }
  supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    this.requireWrite();
    return this.inner.supersedeNode(oldId, newId, reason);
  }
  unsupersedeNode(id: string): Promise<boolean> {
    this.requireWrite();
    return this.inner.unsupersedeNode(id);
  }
  markStaleByTags(tags: string[]): Promise<number> {
    this.requireWrite();
    return this.inner.markStaleByTags(tags);
  }
  pruneEphemeralNodes(defaultTtlMs?: number): Promise<number> {
    this.requireWrite();
    return this.inner.pruneEphemeralNodes(defaultTtlMs);
  }
  pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
    this.requireWrite();
    return this.inner.pruneInferredLoreEdges(relationPrefix);
  }
  deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number> {
    this.requireWrite();
    return this.inner.deleteEdge(sourceId, targetId, relation);
  }
  /**
   * bulkUpsertNodes — write-gated. The facade feature-detects this method
   * (typeof graph.bulkUpsertNodes === 'function'), so it MUST be present on the
   * wrapper the facade sees, not only on the raw adapter. Gates on 'write'
   * before delegating to the batched implementation.
   */
  bulkUpsertNodes(
    batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    this.requireWrite();
    return this.inner.bulkUpsertNodes(batch);
  }

  // ── reads (passthrough) ──────────────────────────────────────────────────
  getNode(id: string): Promise<LoreNode | null> {
    return this.inner.getNode(id);
  }
  getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> {
    return this.inner.getNodesByIds(ids);
  }
  traverse(nodeId: string, maxDepth?: number, relation?: string): Promise<TraversalResult[]> {
    return this.inner.traverse(nodeId, maxDepth, relation);
  }
  search(
    query: string,
    limit?: number,
    project?: string,
    ecosystem?: string,
    excludeHidden?: boolean,
    signals?: { scanCapHit: boolean },
  ): Promise<LoreNode[]> {
    return this.inner.search(query, limit, project, ecosystem, excludeHidden, signals);
  }
  listNodes(
    type?: string,
    tag?: string,
    project?: string,
    ecosystem?: string,
    limit?: number,
    opts?: { unbounded?: boolean },
  ): Promise<LoreNode[]> {
    return this.inner.listNodes(type, tag, project, ecosystem, limit, opts);
  }
  getStats(projectFilter?: string): Promise<GraphStats> {
    return this.inner.getStats(projectFilter);
  }
  getTopology(
    limit?: number,
    projects?: string[] | string,
    edgeLimit?: number,
  ): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    return this.inner.getTopology(limit, projects, edgeLimit);
  }
  getEdges(nodeId?: string): Promise<LoreEdge[]> {
    return this.inner.getEdges(nodeId);
  }
  /** queryEdges — read (passthrough). Present on the wrapper so the route's
   *  `graph.queryEdges(...)` resolves through the scope guard, not only on the
   *  raw adapter. */
  queryEdges(q: EdgeQuery): Promise<LoreEdge[]> {
    return this.inner.queryEdges(q);
  }
  /** bulkList — read (passthrough), same reasoning as queryEdges. */
  bulkList(q: BulkListQuery): Promise<BulkListPage> {
    return this.inner.bulkList(q);
  }
  /** neighbors1Hop — read (passthrough). Present on the wrapper so the route's
   *  feature-detect finds it through the scope guard, not only on the raw
   *  adapter — the fix that turns arcade getNode-neighbors from silent-empty
   *  into real neighbors. */
  neighbors1Hop(id: string, ecosystem: string = '*'): Promise<{ outRows: NeighborRow[]; inRows: NeighborRow[] }> {
    return this.inner.neighbors1Hop(id, ecosystem);
  }
  /** subgraphFetch — read (passthrough), same reasoning as neighbors1Hop. */
  subgraphFetch(
    centerId: string,
    center: { label: string; type: string; tags?: string[] },
    depth: number,
    limit: number,
    includeInferred: boolean,
    ecosystem: string = '*',
  ): Promise<{ nodes: SubgraphNode[]; edges: SubgraphEdge[] }> {
    return this.inner.subgraphFetch(centerId, center, depth, limit, includeInferred, ecosystem);
  }
  /**
   * getGraphContext — daemon-internal SQL passthrough. queryRows (read) is
   * unguarded, matching the escape-hatch posture. executeQuery runs
   * http.command (arbitrary mutation SQL), so it is WRITE-GATED here: a
   * read-only-scoped handle that reached this context could otherwise mutate
   * its own cell (a latent write-scope bypass). The gate throws ScopeError
   * BEFORE any HTTP call when 'write' is absent, consistent with every other
   * write verb on this wrapper. Reach stays 403-walled by the per-db user
   * underneath either way; this closes the scope-verb hole above it.
   */
  getGraphContext(): {
    queryRows: (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    executeQuery: (sql: string, params?: Record<string, unknown>) => Promise<unknown>;
  } {
    const ctx = this.inner.getGraphContext();
    return {
      queryRows: ctx.queryRows,
      executeQuery: (sql, params) => {
        this.requireWrite();
        return ctx.executeQuery(sql, params);
      },
    };
  }
}

/** Full-surface, write-gated LoreVectorHandle wrapper. */
export class ScopedArcadeVectorHandle implements LoreVectorHandle {
  private readonly scopes: ReadonlySet<Scope>;
  constructor(
    private readonly inner: LoreVectorHandle & ArcadeExtraVector,
    scopes: readonly Scope[],
  ) {
    this.scopes = new Set(scopes);
  }
  private requireWrite(): void {
    if (!this.scopes.has('write')) throw new ScopeError();
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }
  // ── writes (gated) ───────────────────────────────────────────────────────
  store(doc: VerbatimDocument): Promise<void> {
    this.requireWrite();
    return this.inner.store(doc);
  }
  delete(id: string): Promise<void> {
    this.requireWrite();
    return this.inner.delete(id);
  }
  // ── reads (passthrough) ──────────────────────────────────────────────────
  search(
    query: string,
    limit?: number,
    filter?: Partial<VerbatimDocument['metadata']>,
    opts?: { includeHistory?: boolean },
    actorScopes?: ReadonlyArray<string>,
  ): Promise<VerbatimSearchResult[]> {
    return this.inner.search(query, limit, filter, opts, actorScopes);
  }
  /**
   * bm25Search — lexical (keyword) search. Read verb, passthrough. Present on
   * the wrapper so LoreStorageClient.verbatimBm25Search's feature-detect
   * (typeof store.bm25Search === 'function') finds it through the scope guard,
   * not only on the raw adapter.
   */
  bm25Search(
    query: string,
    limit?: number,
    filter?: Partial<VerbatimDocument['metadata']>,
    actorScopes?: ReadonlyArray<string>,
  ): Promise<Bm25Envelope<VerbatimSearchResult>> {
    return this.inner.bm25Search(query, limit, filter, actorScopes);
  }
  /**
   * getById — single canonical verbatim read, no re-embed. Read verb,
   * passthrough. Present on the wrapper so GET /api/verbatim/get's feature-
   * detect (typeof store.getById === 'function') finds it through the scope
   * guard, not only on the raw adapter — the fix that turns the arcade 501 into
   * a real 2xx read.
   */
  getById(id: string): Promise<{ contentHash?: string; text?: string } | null> {
    return this.inner.getById(id);
  }
  count(): Promise<number> {
    return this.inner.count();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
