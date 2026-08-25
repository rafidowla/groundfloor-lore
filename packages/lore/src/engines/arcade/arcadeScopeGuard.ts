/**
 * arcadeScopeGuard.ts — EXPERIMENTAL SPIKE CODE (spike/arcadedb-multitenant).
 *
 * Coarse read/write RBAC for the app-grid spike. This is DESIGN-AGNOSTIC: it
 * wraps ANY graph+vector adapter pair (Design A's db-per-app stores OR Design
 * B's app_id-scoped stores) and gates the four write verbs on an IMMUTABLE
 * scope set captured at construction.
 *
 * ── WHAT THIS IS (and is NOT) ───────────────────────────────────────────────
 * IN SCOPE (coarse RBAC): read | write on the adapter as a whole.
 *   - write verbs (upsertNode, addEdge/addBidirectionalEdge, vector.store,
 *     vector.delete) throw ScopeError BEFORE any HTTP call when 'write' is
 *     absent from the scope set.
 *   - read verbs (getNode, traverse, nodeCount, vector.search, vector.count)
 *     pass straight through.
 *
 * OUT OF SCOPE (deferred to Dataplane + app layer, per the spike decision):
 *   - roles-within-app, ReBAC, cross-app/cross-customer grants. There is NO
 *     scope value that widens reach beyond the token's bound (customer,app) —
 *     reach is fixed by the underlying adapter's immutable binding; scopes ONLY
 *     gate verbs. A read-only token is not a wider lens, and a write token is
 *     not a cross-cell key.
 *
 * ── STRUCTURAL GUARANTEE ────────────────────────────────────────────────────
 * `scopes` is a `private readonly ReadonlySet<Scope>` set once in the
 * constructor. No setter, no method mutates it. The guard throws before it ever
 * touches `this.inner`, so a read-only adapter provably issues zero write HTTP
 * requests (the isolation test asserts this via a request counter).
 */

import type {
  LoreEdge,
  LoreNode,
  TraversalResult,
  VerbatimDocument,
  VerbatimSearchResult,
} from '../../providers/types.js';

export type Scope = 'read' | 'write';

/** Typed error thrown BEFORE any HTTP call when a write verb lacks 'write'. */
export class ScopeError extends Error {
  constructor(message = 'write scope required') {
    super(message);
    this.name = 'ScopeError';
  }
}

/**
 * Minimal structural interfaces the guard depends on. Both Design A's
 * ArcadeGraphStore/ArcadeVectorStore and Design B's app-scoped parallels
 * satisfy these shapes, so one guard covers both designs.
 */
export interface GuardableGraph {
  upsertNode(node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode>;
  getNode(id: string): Promise<LoreNode | null>;
  addEdge(edge: LoreEdge): Promise<void>;
  addBidirectionalEdge(edge: LoreEdge): Promise<void>;
  traverse(nodeId: string, maxDepth?: number, relation?: string): Promise<TraversalResult[]>;
  nodeCount(): Promise<number>;
}

export interface GuardableVector {
  store(doc: VerbatimDocument): Promise<void>;
  search(
    query: string,
    limit?: number,
    filter?: Partial<VerbatimDocument['metadata']>,
  ): Promise<VerbatimSearchResult[]>;
  count(): Promise<number>;
  delete(id: string): Promise<void>;
}

/** Read/write-gated graph facade. Write verbs throw ScopeError pre-HTTP. */
export class ScopeGuardedGraph implements GuardableGraph {
  private readonly inner: GuardableGraph;
  private readonly scopes: ReadonlySet<Scope>;

  constructor(inner: GuardableGraph, scopes: ReadonlySet<Scope>) {
    this.inner = inner;
    this.scopes = scopes;
  }

  private requireWrite(): void {
    if (!this.scopes.has('write')) throw new ScopeError();
  }

  // ── writes (gated) ──────────────────────────────────────────────────────
  async upsertNode(
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
  ): Promise<LoreNode> {
    this.requireWrite();
    return this.inner.upsertNode(node);
  }
  async addEdge(edge: LoreEdge): Promise<void> {
    this.requireWrite();
    return this.inner.addEdge(edge);
  }
  async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
    this.requireWrite();
    return this.inner.addBidirectionalEdge(edge);
  }

  // ── reads (pass-through) ────────────────────────────────────────────────
  getNode(id: string): Promise<LoreNode | null> {
    return this.inner.getNode(id);
  }
  traverse(nodeId: string, maxDepth?: number, relation?: string): Promise<TraversalResult[]> {
    return this.inner.traverse(nodeId, maxDepth, relation);
  }
  nodeCount(): Promise<number> {
    return this.inner.nodeCount();
  }
}

/** Read/write-gated vector facade. store/delete throw ScopeError pre-HTTP. */
export class ScopeGuardedVector implements GuardableVector {
  private readonly inner: GuardableVector;
  private readonly scopes: ReadonlySet<Scope>;

  constructor(inner: GuardableVector, scopes: ReadonlySet<Scope>) {
    this.inner = inner;
    this.scopes = scopes;
  }

  private requireWrite(): void {
    if (!this.scopes.has('write')) throw new ScopeError();
  }

  // ── writes (gated) ──────────────────────────────────────────────────────
  async store(doc: VerbatimDocument): Promise<void> {
    this.requireWrite();
    return this.inner.store(doc);
  }
  async delete(id: string): Promise<void> {
    this.requireWrite();
    return this.inner.delete(id);
  }

  // ── reads (pass-through) ────────────────────────────────────────────────
  search(
    query: string,
    limit?: number,
    filter?: Partial<VerbatimDocument['metadata']>,
  ): Promise<VerbatimSearchResult[]> {
    return this.inner.search(query, limit, filter);
  }
  count(): Promise<number> {
    return this.inner.count();
  }
}

/** Wrap a graph+vector pair with the same immutable scope set. */
export function scopeGuardPair(
  graph: GuardableGraph,
  vector: GuardableVector,
  scopes: readonly Scope[],
): { graph: ScopeGuardedGraph; vector: ScopeGuardedVector } {
  const set: ReadonlySet<Scope> = new Set(scopes);
  return {
    graph: new ScopeGuardedGraph(graph, set),
    vector: new ScopeGuardedVector(vector, set),
  };
}
