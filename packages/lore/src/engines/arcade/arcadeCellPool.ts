/**
 * arcadeCellPool.ts — LRU-bounded cache of the HEAVY per-cell machinery for the
 * ArcadeDB tenant DATA plane (Cloud Slice 3).
 * (branch: spike/arcadedb-multitenant)
 *
 * WHY A POOL (the resolve/cache split):
 *   resolvePrincipal(token) is a cheap SQLite join and MUST re-run on EVERY
 *   request (fail-closed pre-HTTP: revoked/expired/disabled tokens are rejected
 *   before any ArcadeDB call). But constructing the cell's heavy pair —
 *   ArcadeHttp + ArcadeGraphStore + ArcadeVectorStore + a per-cell
 *   LoreStorageClient.fromLocal facade — on every request would be wasteful and
 *   would re-open sockets and re-wrap the process-wide embedder each time. The
 *   pool caches that heavy pair keyed by sha256(token), LRU-bounded, and evicts
 *   it on revoke / rotate / disable / destroy so a stale entry can never outlive
 *   its credential.
 *
 * CONFINEMENT ROLE:
 *   The pool is WALL 1 of the two-wall confinement model. A token maps to
 *   exactly one BoundArcadeCell (arcadeCellForToken's invariant: no request
 *   field names a cell), so an entry is bound to one tenant database. The
 *   returned bundle's graph/verbatim handles capture the cell's db immutably —
 *   they cannot be re-pointed. WALL 2 (the per-db ArcadeDB service user's
 *   physical 403) stands underneath regardless.
 *
 * EVICTION (fail-closed on credential change):
 *   arcadeAdmin's revoke / rotate / disable / destroy routes call evict(token)
 *   or evictCell(tenantId, appId) after mutating the registry. The NEXT request
 *   re-runs resolvePrincipal (which now throws for the dead token/cell) and, on
 *   a cache miss, rebuilds against the fresh registry. A request already in
 *   flight before eviction keeps its resolved cell (it authorized before the
 *   change), but cannot mint a NEW cell afterward — the resolve gate is the
 *   fail-closed point, not the cache.
 */

import {
  arcadeCellForTokenAsync,
  hashToken,
  resolvePrincipal,
  type ArcadePrincipal,
  type BoundArcadeCell,
} from './arcadeAuthResolver.js';
import { cellWorkspace } from './arcadeRequestContext.js';
import { LoreStorageClient } from '../../storage/loreStorageClient.js';
import type { LoreGraphHandle, LoreVectorHandle } from '../../storage/loreStorageClient.js';
import type { EmbeddingProvider } from '../../providers/types.js';
import type { ISessionCache, HotSessionSnapshot } from '../../engines/sessionCache.js';

/**
 * The per-cell StorageBundle-shaped object the local route families consume as
 * `deps.store`. It is intentionally a SUBSET of the full StorageBundle: the
 * fields the data-plane routes actually touch (storageClient / loreGraph /
 * loreVerbatim / sessionCache / deploymentMode / sdk / tableStorage). The two
 * un-used-by-these-routes members (tableStorage) are throwing stubs — no
 * data-plane route on the arcade allowlist reaches them (the /v1 collections
 * family is NOT registered in arcade mode).
 */
export interface ArcadeCellBundle {
  sdk: null;
  loreGraph: LoreGraphHandle;
  loreVerbatim: LoreVectorHandle;
  sessionCache: ISessionCache;
  tableStorage: never;
  storageClient: LoreStorageClient;
  deploymentMode: 'local';
}

/**
 * A pooled cell: the resolved+bound BoundArcadeCell plus the derived
 * StorageBundle-shaped deps (facade + shims), cached together so a request
 * that cache-hits does zero heavy construction.
 */
export interface PooledArcadeCell {
  readonly cell: BoundArcadeCell;
  readonly workspace: string;
  readonly bundle: ArcadeCellBundle;
}

/** A minimal in-process ISessionCache — the ONLY session-cache surface the
 *  data-plane routes touch is retrieve()'s pushNode (single-workspace recall).
 *  Per-cell + in-memory so recent-node bookkeeping never crosses cells and
 *  never writes a daemon-shared file. flushNow is a no-op (nothing to persist);
 *  getHotContext returns the recent ids. */
class InMemorySessionCache implements ISessionCache {
  public readonly backend = 'local-file' as const;
  private recent: string[] = [];
  private static readonly CAP = 50;
  pushNode(nodeId: string): void {
    this.recent = [nodeId, ...this.recent.filter((id) => id !== nodeId)].slice(
      0,
      InMemorySessionCache.CAP,
    );
  }
  getHotContext(): HotSessionSnapshot {
    return { recent_nodes: [...this.recent] };
  }
  flushNow(): void {
    /* in-memory — nothing to flush */
  }
}

const tableStorageStub = new Proxy(
  {},
  {
    get() {
      throw new Error(
        '[arcadeCellPool] tableStorage is not wired in arcade mode — the ' +
          '/v1 collections family is not on the tenant data-plane allowlist.',
      );
    },
  },
) as never;

/**
 * Build the StorageBundle-shaped deps for a bound cell. The facade is the
 * ALREADY-PROVEN LoreStorageClient.fromLocal over the cell's scope-guarded
 * handles (facade round-trip in test/spike-arcadedb-facade-roundtrip.ts) — ZERO
 * facade edits. loreGraph / loreVerbatim point at the SAME scope-guarded
 * handles, so every long-tail route that reaches through loreGraph is still
 * verb-gated and db-confined.
 */
function buildBundle(cell: BoundArcadeCell): ArcadeCellBundle {
  const storageClient = LoreStorageClient.fromLocal({
    graph: cell.graph,
    verbatim: cell.verbatim,
  });
  return {
    sdk: null,
    loreGraph: cell.graph,
    loreVerbatim: cell.verbatim,
    sessionCache: new InMemorySessionCache(),
    tableStorage: tableStorageStub,
    storageClient,
    deploymentMode: 'local',
  };
}

/**
 * ArcadeCellPool — sha256(token) → PooledArcadeCell, LRU-bounded.
 *
 * `get(token, resolve)` is the request entry point: it re-runs `resolve` (the
 * caller passes resolvePrincipal-backed arcadeCellForToken) on a MISS only; on
 * a HIT it returns the cached pooled cell without touching the resolver's heavy
 * construction. The CALLER always re-runs resolvePrincipal BEFORE calling get()
 * (fail-closed), so a hit is only reached for a still-valid token.
 */
export class ArcadeCellPool {
  private readonly entries = new Map<string, PooledArcadeCell>();
  /** hash → { tenantId, appId } so evictCell can find token entries by cell. */
  private readonly cellIndex = new Map<string, { tenantId: string; appId: string }>();
  private readonly maxEntries: number;
  private readonly embedder?: EmbeddingProvider;
  private readonly registryDbPath?: string;
  private readonly baseUrl?: string;

  constructor(opts?: {
    maxEntries?: number;
    embedder?: EmbeddingProvider;
    registryDbPath?: string;
    baseUrl?: string;
  }) {
    this.maxEntries = opts?.maxEntries ?? 256;
    this.embedder = opts?.embedder;
    this.registryDbPath = opts?.registryDbPath;
    this.baseUrl = opts?.baseUrl;
  }

  /**
   * The fail-closed pre-HTTP resolve gate — re-runs resolvePrincipal against
   * the pool's OWN registry on EVERY request (cheap SQLite join). Throws
   * ArcadeAuthError for unknown/revoked/expired tokens and disabled/missing
   * cells BEFORE any ArcadeDB call. Callers run this first, then getOrBuild.
   * Keeping the registry config here (not at the call site) means the resolve
   * and the heavy build read the SAME registry — no split-brain.
   */
  resolve(token: string): ArcadePrincipal {
    return resolvePrincipal(token, { registryDbPath: this.registryDbPath });
  }

  /**
   * Resolve+cache the pooled cell for a token. Builds the heavy pair on a miss
   * via arcadeCellForTokenAsync (which itself re-runs resolvePrincipal, the
   * fail-closed pre-HTTP gate). LRU: a hit moves the entry to most-recent; an
   * over-cap insert evicts the least-recent.
   *
   * ASYNC (slice 5): the secret read is now on the async path so an async-only
   * backend (keychain/kms — no readSync fast-path) resolves through the SAME
   * pool. The sqlite/env fast-path still answers synchronously under the hood;
   * only the build lane is async. On a cache HIT no await touches the store.
   */
  async getOrBuild(token: string): Promise<PooledArcadeCell> {
    const key = hashToken(token);
    const hit = this.entries.get(key);
    if (hit) {
      // LRU touch — reinsert to move to the end (most-recent).
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const cell = await arcadeCellForTokenAsync(token, {
      baseUrl: this.baseUrl,
      registryDbPath: this.registryDbPath,
      embedder: this.embedder,
    });
    const pooled: PooledArcadeCell = {
      cell,
      workspace: cellWorkspace(cell),
      bundle: buildBundle(cell),
    };
    this.entries.set(key, pooled);
    this.cellIndex.set(key, { tenantId: cell.principal.tenantId, appId: cell.principal.appId });
    this.enforceCap();
    return pooled;
  }

  private enforceCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.cellIndex.delete(oldest);
    }
  }

  /** Evict a single token's entry (called on revoke/rotate of that token). */
  evictToken(token: string): void {
    const key = hashToken(token);
    this.entries.delete(key);
    this.cellIndex.delete(key);
  }

  /**
   * Evict every entry bound to a cell (called on disable/destroy/rotate, where
   * the operator names the cell, not a specific token). All tokens for that
   * cell are dropped so none can reuse a stale facade against a gone database.
   */
  evictCell(tenantId: string, appId: string): void {
    for (const [key, ref] of this.cellIndex) {
      if (ref.tenantId === tenantId && ref.appId === appId) {
        this.entries.delete(key);
        this.cellIndex.delete(key);
      }
    }
  }

  /** Drop everything (shutdown / test reset). */
  clear(): void {
    this.entries.clear();
    this.cellIndex.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * Process-wide singleton pool + an AsyncLocalStorage-free accessor so the
 * arcadeAdmin routes (which run in the operator lane, no cell slot) can reach
 * the SAME pool the data dispatcher uses to evict on credential change.
 * Installed by arcadeBoot at listener construction.
 */
let _pool: ArcadeCellPool | null = null;
export function setArcadeCellPool(pool: ArcadeCellPool): void {
  _pool = pool;
}
export function getArcadeCellPool(): ArcadeCellPool | null {
  return _pool;
}
