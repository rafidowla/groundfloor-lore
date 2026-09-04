/**
 * arcadeData.ts — the TENANT DATA PLANE dispatcher for arcade mode
 * (Cloud Slice 3, branch spike/arcadedb-multitenant).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * arcadeBoot's arcadeDispatch 501s every data verb. This module is the ONE
 * place that makes a tenant `lore_at_*` token able to READ/WRITE its cell's data
 * over HTTP, byte-for-byte matching the LOCAL public contract. It does exactly
 * three things per request, then delegates to the UNMODIFIED local route
 * families:
 *
 *   1. RESOLVE  — Bearer → cell. resolvePrincipal re-runs every request
 *      (fail-closed pre-HTTP); the heavy pair is cached in the ArcadeCellPool.
 *      Auth failures map onto the frozen {code,message} envelope.
 *   2. BIND     — runWithPrincipal(appPrincipal) + runWithRouteBindingSlot(
 *      {target: cellWorkspace, lane:'workspace'}) + runWithArcadeCell(cell), so
 *      the UNMODIFIED local gates (bindRouteTarget / requireRead-WriteToWorkspace)
 *      produce byte-identical denials. appPrincipal is a REAL local Principal
 *      (kind 'app', workspace=cellWorkspace, scopes=cell verbs) — no arcade
 *      special-case in the gates.
 *   3. DELEGATE — synthesize per-cell deps (StorageBundle facade + a single-cell
 *      registry shim + a single-cell verbatim resolver) and call the SAME
 *      try*Routes family local mode registers. The identical route code writes
 *      every byte of every response and every denial, so parity drift is
 *      impossible by construction.
 *
 * ── DENY-BY-DEFAULT ──────────────────────────────────────────────────────────
 * An EXPLICIT allowlist of (method, path-family) pairs. `tryArcadeDataRoutes`
 * returns false for any path NOT on the allowlist, so arcadeDispatch's 501
 * deny-by-default still fires for every unmatched /api/* family. /api/arcade/*
 * (operator control plane) is never reached here — arcadeDispatch routes it
 * first. A tenant token that reaches the pool is bound to ONE cell; no request
 * field can name another (wall 1), and the per-db ArcadeDB user 403s outside its
 * one database anyway (wall 2).
 *
 * ── CONFINEMENT PER ROUTE ────────────────────────────────────────────────────
 * Because the bound principal's workspace IS the cell workspace, EVERY route's
 * own gate enforces confinement identically to local:
 *   - workspace param == cellWorkspace  → pass
 *   - any other name / '*' / crossProject=true → 403 workspace_forbidden
 *   - omitted workspace on a read       → 400 workspace_required
 *   - omitted on POST /api/node         → defaulted to cellWorkspace (local parity)
 *   - read-only token on a write verb   → 403 (route gate) AND ScopeError pre-HTTP
 * The registry shim is residual belt: getOrOpen(ws) returns the cell graph iff
 * ws === cellWorkspace, else throws WorkspaceNotFoundError — but the bound
 * principal already 403s a foreign workspace before the shim is reached.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../../../auth/principal.js';
import type { TokenScope } from '../../../auth/tokens.js';
import { runWithRouteBindingSlot } from '../../../security/routeWorkspaceBinding.js';
import { writeError } from '../helpers.js';
import { WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';
import type { AuditLog } from '../../../security/audit.js';
import {
  ArcadeAuthError,
  type BoundArcadeCell,
} from '../../../engines/arcade/arcadeAuthResolver.js';
import {
  runWithArcadeCell,
  cellWorkspace,
} from '../../../engines/arcade/arcadeRequestContext.js';
import {
  ArcadeCellPool,
  type ArcadeCellBundle,
} from '../../../engines/arcade/arcadeCellPool.js';
import { NODE_TYPE } from '../../../engines/arcade/arcadeSchema.js';
import { getCellVocabPolicy } from '../../../engines/arcade/arcadeCellPolicy.js';
import {
  arcadeCellKey,
  cellOutboxStore,
  cellLagCache,
} from '../../../engines/arcade/arcadeOutboxLane.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import type { StorageBundle } from '../../services.js';

// The local route families we delegate to, VERBATIM (no re-serialization).
import { tryNodesRoutes } from './nodes.js';
import { tryNodeDeleteRoute } from './nodes-delete.js';
import { tryEdgesRoutes } from './edges.js';
import { tryBulkListRoutes } from './bulkList.js';
import { tryBulkWriteRoutes } from './bulkWrite.js';
import { trySearchRoutes } from './search.js';
import { tryTopologyRoutes } from './topology.js';
import { tryInspectRoutes } from './inspect.js';
import { tryDiagnosticRoutes } from './diagnostic.js';
import { tryVerbatimRoutes } from './retention/verbatim.js';

export interface ArcadeDataDeps {
  pool: ArcadeCellPool;
  auditLog: AuditLog;
  /** Merged edge-relation enum (same source local wires) for POST /api/edge's
   *  pre-validation gate. Optional — absent skips the enum check (addEdge
   *  surfaces the backend error), exactly as local. */
  edgeRelations?: ReadonlyArray<string>;
  /**
   * Slice-4 PRODUCER side — the ONE shared daemon SqliteOutboxStore. When wired,
   * tenant writes record `node.upsert` (+`verbatim.upsert` when embed) BEFORE
   * returning success, byte-matching local outbox semantics; the arcade
   * replicator (arcadeOutboxWiring.ts) drains them to the cell. Each request
   * decorates it with the cell's canonical lane key `arcade:<t>:<a>` so rows
   * route to the right cell (arcadeOutboxLane.cellOutboxStore). Absent (tests
   * that only exercise the read path) → writes go direct, exactly as slice 3.
   */
  outboxStore?: OutboxStore;
  /**
   * Slice-4 — the shared backpressure lag cache. Decorated per request with the
   * cell key so `checkOutboxBackpressure` reads the cell's lane lag (503
   * outbox_lag) rather than the never-populated bare-appId key. Absent → skip.
   */
  outboxLagCache?: OutboxLagCache;
}

/**
 * The ALLOWLIST. Each entry is an exact (method, pathname) OR a method +
 * predicate for the `:id`-suffixed families. Only these reach a local route
 * family; everything else returns false → arcadeDispatch 501s.
 *
 * Deliberately EXCLUDES the families the spec keeps 501 this slice:
 * supersession-candidates, lineage, history/changesets/snapshot, outcomes,
 * anchors, prune + restore, aggregate/time-series, verbatim history/reap/
 * tombstone, mark-stale, prune-ephemeral, /api/lore-status, MCP-over-HTTP.
 */
function matchesAllowlist(method: string, pathname: string): boolean {
  // Exact (method, path) pairs.
  const EXACT: ReadonlyArray<readonly [string, string]> = [
    ['POST', '/api/node'],
    ['GET', '/api/node'],
    ['GET', '/api/node-full'],
    ['GET', '/api/node-list'],
    ['GET', '/api/nodes'],
    ['POST', '/api/node/supersede'],
    ['POST', '/api/node/unsupersede'],
    ['POST', '/api/edge'],
    ['DELETE', '/api/edge'],
    ['GET', '/api/edges'],
    ['GET', '/api/recall'],
    ['GET', '/api/search'],
    ['POST', '/api/query'],
    ['POST', '/api/nodes/bulk'],
    ['POST', '/api/nodes/bulk-list'],
    ['POST', '/api/nodes/bulk-delete'],
    ['POST', '/api/recall/bulk'],
    ['POST', '/api/edges/bulk'],
    ['GET', '/api/topology'],
    ['GET', '/api/stats'],
    ['GET', '/api/subgraph'],
    ['POST', '/api/verbatim'],
    ['GET', '/api/verbatim/get'],
    ['GET', '/api/verbatim/search'],
  ];
  for (const [m, p] of EXACT) {
    if (method === m && pathname === p) return true;
  }
  // DELETE /api/node/:id — the delete family (tombstone included).
  if (method === 'DELETE' && /^\/api\/node\/[^/]+$/.test(pathname)) return true;
  return false;
}

/** Map an ArcadeAuthError onto the frozen {code,message} envelope + status. */
function writeAuthError(res: ServerResponse, err: ArcadeAuthError): void {
  switch (err.reason) {
    case 'expired_token':
      // Slice-4 token-lifecycle-contract alignment (invariant 4): an EXPIRED
      // token surfaces the same distinct code local middleware returns
      // (errorCodes.TOKEN_EXPIRED), not the collapsed auth_required — so an app
      // can tell "rotate/re-issue" from "revoked/unknown". Still pre-HTTP.
      writeError(res, 401, 'token_expired', 'token expired');
      return;
    case 'unknown_token':
    case 'revoked_token':
      // unknown/revoked stay collapsed into a deliberately minimal /
      // non-enumerating 401 (parity with local's revoked handling).
      writeError(res, 401, 'auth_required', 'invalid or expired token');
      return;
    case 'cell_missing':
    case 'cell_not_active':
    case 'secret_missing':
      // The token outlived its database — the tenant-scoped equivalent of
      // workspace_not_found (404 per the frozen convention).
      writeError(res, 404, 'workspace_not_found', 'the token’s workspace is no longer available');
      return;
    default:
      writeError(res, 401, 'auth_required', 'invalid token');
  }
}

/** arcade scopes ('read'|'write') → local TokenScope[] verbatim (no widening —
 *  reach is fixed by the cell). A read-only cell → ['read'], read+write →
 *  ['read','write']; never any cross-workspace-* scope, so '*'/crossProject
 *  405s exactly as a plain local app token. */
function toTokenScopes(scopes: ReadonlyArray<'read' | 'write'>): TokenScope[] {
  const out: TokenScope[] = [];
  if (scopes.includes('read')) out.push('read');
  if (scopes.includes('write')) out.push('write');
  return out;
}

/**
 * getLanguageBreakdown for the cell — a plain `GROUP BY language` aggregate over
 * the single node type. No traps: it does not use both()/expand()/vector.neighbors
 * (the three ArcadeDB silent-wrong-result patterns). Empty-string language
 * collapses under `null`, matching LocalGraph.computeLanguageBreakdown's public
 * representation of "unknown". Runs through the cell's scope-guarded read-only
 * SQL passthrough (queryRows), so it cannot mutate and stays db-confined.
 */
async function cellLanguageBreakdown(cell: BoundArcadeCell): Promise<Record<string, number>> {
  const ctx = cell.graph.getGraphContext();
  const rows = await ctx.queryRows(
    `SELECT language AS language, count(*) AS n FROM ${NODE_TYPE} GROUP BY language`,
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    const langRaw = row['language'];
    const key = langRaw === undefined || langRaw === null || langRaw === '' ? 'null' : String(langRaw);
    out[key] = (out[key] ?? 0) + Number(row['n'] ?? 0);
  }
  return out;
}

/**
 * Build a `loreGraph`-shaped object for the cell: the cell's scope-guarded graph
 * handle AUGMENTED with getLanguageBreakdown (the one method /api/stats reaches
 * through store.loreGraph / the registry graph that ScopedArcadeGraphHandle does
 * not itself declare). Every other method delegates to the scope-guarded handle,
 * so reach + verb gating are unchanged.
 */
function cellGraphForStats(cell: BoundArcadeCell): StorageBundle['loreGraph'] {
  const base = cell.graph as unknown as Record<string, unknown>;
  const augmented = Object.create(base) as StorageBundle['loreGraph'] & {
    getLanguageBreakdown(): Promise<Record<string, number>>;
  };
  augmented.getLanguageBreakdown = () => cellLanguageBreakdown(cell);
  return augmented as StorageBundle['loreGraph'];
}

/**
 * A single-cell LocalGraphRegistry SHIM closing over the bound cell.
 *   getOrOpen(ws)     → the cell graph iff ws === cellWorkspace, else throw
 *                       WorkspaceNotFoundError (the local 404/400 shape).
 *   getGraphHandle(ws)→ same as getOrOpen: there is exactly one graph here,
 *                       already resolved to the cell's actual engine by
 *                       cellGraphForStats — no per-engine branch to run.
 *   activeName()      → cellWorkspace (there is exactly one workspace).
 * Typed as LocalGraphRegistry via a cast because the local routes only ever
 * call getOrOpen / getGraphHandle / activeName / withGraph on it (verified
 * across the delegated families — the route families now call the
 * engine-aware getGraphHandle, not getOrOpen, hence that method existing
 * here too; getOrOpen is kept for any caller still on the older accessor).
 * It is residual: the bound app principal already 403s a foreign workspace
 * before any accessor is reached — this is belt to that braces.
 */
function cellRegistryShim(cell: BoundArcadeCell, ws: string): LocalGraphRegistry {
  const graph = cellGraphForStats(cell);
  const shim = {
    async getOrOpen(requested: string) {
      if (requested !== ws) throw new WorkspaceNotFoundError(requested, [ws]);
      return graph;
    },
    async getGraphHandle(requested: string) {
      if (requested !== ws) throw new WorkspaceNotFoundError(requested, [ws]);
      return graph;
    },
    activeName(): string {
      return ws;
    },
    async withGraph<T>(requested: string, fn: (g: unknown) => Promise<T>): Promise<T> {
      if (requested !== ws) throw new WorkspaceNotFoundError(requested, [ws]);
      return fn(graph);
    },
  };
  return shim as unknown as LocalGraphRegistry;
}

/**
 * A single-cell WorkspaceVerbatimResolver SHIM: getOrOpen(ws) → the cell's OWN
 * verbatim store iff ws === cellWorkspace, so retrieve()'s hybrid semantic+BM25
 * seeds against the cell's store; a foreign ws throws (belt — the principal
 * already 403'd).
 */
function cellVerbatimResolverShim(cell: BoundArcadeCell, ws: string): WorkspaceVerbatimResolver {
  const shim = {
    async getOrOpen(requested: string) {
      if (requested !== ws) throw new WorkspaceNotFoundError(requested, [ws]);
      return cell.verbatim;
    },
  };
  return shim as unknown as WorkspaceVerbatimResolver;
}

/** The StorageBundle the local families consume as deps.store. */
function bundleAsStorageBundle(bundle: ArcadeCellBundle): StorageBundle {
  return bundle as unknown as StorageBundle;
}

/**
 * tryArcadeDataRoutes — the tenant data-plane entry point, called from
 * arcadeDispatch for a `lore_at_*` bearer BEFORE the 501 fallthrough. Returns
 * true once a response is written (allowlisted path, handled or denied),
 * false when the path is not on the allowlist (caller 501s).
 */
export async function tryArcadeDataRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  pathname: string,
  bearer: string,
  deps: ArcadeDataDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!matchesAllowlist(method, pathname)) return false;

  // ── (1) RESOLVE — fail-closed pre-HTTP. resolvePrincipal runs on EVERY
  //     request (cheap SQLite join); it throws for unknown/revoked/expired
  //     tokens and disabled/missing cells before any ArcadeDB call.
  try {
    deps.pool.resolve(bearer);
  } catch (err) {
    if (err instanceof ArcadeAuthError) {
      // A resolve failure evicts any stale pool entry so a request in flight
      // before a revoke cannot resurrect a fresh cell afterward.
      deps.pool.evictToken(bearer);
      writeAuthError(res, err);
      return true;
    }
    throw err;
  }

  let pooled;
  try {
    pooled = await deps.pool.getOrBuild(bearer);
  } catch (err) {
    if (err instanceof ArcadeAuthError) {
      writeAuthError(res, err);
      return true;
    }
    throw err;
  }
  const cell = pooled.cell;
  const ws = cellWorkspace(cell);

  // ── (2) BIND — a REAL local app principal whose workspace IS the cell
  //     workspace, so the unmodified local gates confine to the cell.
  const appPrincipal: Principal = {
    kind: 'app',
    workspace: ws,
    scopes: toTokenScopes(cell.principal.scopes),
    label: `arcade:${cell.principal.tenantId}/${cell.principal.appId}`,
  };

  // ── (3) DELEGATE — per-cell deps + the SAME local route families.
  const store = bundleAsStorageBundle(pooled.bundle);
  const graphRegistry = cellRegistryShim(cell, ws);
  const workspaceVerbatimResolver = cellVerbatimResolverShim(cell, ws);
  const detectedScope = { workspace: ws, ecosystem: '' };

  // Slice-4 PRODUCER wiring. When an outbox is wired, decorate it + the lag
  // cache with THIS cell's canonical lane key `arcade:<t>:<a>` (never the bare
  // appId — two tenants sharing an appId would interleave lanes). The delegated
  // local routes call record({workspace: appId}) and shouldBackpressure(appId);
  // the decorators rewrite/redirect that to the cell key. Both close over the
  // bound cell, so no request field can retarget another cell's lane.
  const cellKey = arcadeCellKey(cell.principal.tenantId, cell.principal.appId);
  const laneOutbox = deps.outboxStore ? cellOutboxStore(deps.outboxStore, cellKey) : undefined;
  const laneLagCache = deps.outboxLagCache ? cellLagCache(deps.outboxLagCache, cellKey) : undefined;

  return runWithPrincipal(appPrincipal, () =>
    runWithRouteBindingSlot({ target: ws, lane: 'workspace' }, () =>
      runWithArcadeCell(cell, async () => {
        // deploymentMode:'local' + dataplane:null so gateRoute is the same
        // no-op it is in local mode. outbox/quota deps are undefined — the
        // routes' optional-dep fallbacks make writes direct (documented
        // divergence: durability/backpressure semantics only, NOT wire shape).
        const common = {
          store,
          deploymentMode: 'local' as const,
          dataplane: null,
          graphRegistry,
          auditLog: deps.auditLog,
          // Slice-4 — cell-keyed outbox + lag cache threaded into every write
          // family. Undefined when no outbox is wired (slice-3 read-path tests),
          // in which case the routes' optional-dep fallbacks make writes direct.
          outboxStore: laneOutbox,
          outboxLagCache: laneLagCache,
        };

        // Slice-4 cell-aware vocab policy SEAM. The closure closes over the
        // BOUND cell, so the `ws` argument can never select a foreign cell's
        // policy (same confinement pattern as the registry shim): we assert
        // ws === cellWorkspace, then resolve from the relational-lane
        // cell_policies row (or the documented open default). This replaces the
        // structurally-unreachable getWorkspaceVocabPolicy(appId) lookup that
        // threw "Unknown workspace" and silently default-accepted every write.
        const getVocabPolicy = (requestedWs: string) => {
          if (requestedWs !== ws) {
            // Belt: the bound principal already 403'd a foreign workspace before
            // any write gate runs. Fail loud rather than resolve a wrong policy.
            throw new WorkspaceNotFoundError(requestedWs, [ws]);
          }
          return getCellVocabPolicy(cell.principal.tenantId, cell.principal.appId);
        };

        if (
          await tryNodesRoutes(req, res, url, pathname, {
            ...common,
            pendingOpsStore: undefined as never,
            getVocabPolicy,
            // Slice-4 — when the outbox IS wired (arcadeBoot), nodeUpsert records
            // node.upsert + verbatim.upsert rows and the replicator drains them
            // (recall becomes async; drive replicator.tickOnce()). ONLY when no
            // outbox is wired (slice-3 read-path tests) do we fall back to the
            // INLINE verbatim seed so embed:true → recall still works
            // synchronously over HTTP. The two paths are mutually exclusive —
            // nodeService.nodeUpsert prefers the outbox when both are present, but
            // we keep this exclusive to avoid a double verbatim write.
            inlineVerbatim: laneOutbox ? undefined : store.storageClient,
          } as unknown as Parameters<typeof tryNodesRoutes>[4])
        )
          return true;

        if (
          await tryNodeDeleteRoute(req, res, url, pathname, {
            ...common,
            workspaceVerbatimResolver,
          } as unknown as Parameters<typeof tryNodeDeleteRoute>[4])
        )
          return true;

        if (
          await tryEdgesRoutes(req, res, url, pathname, {
            ...common,
            edgeRelations: deps.edgeRelations,
          } as unknown as Parameters<typeof tryEdgesRoutes>[4])
        )
          return true;

        if (
          await tryBulkListRoutes(req, res, url, pathname, {
            ...common,
          } as unknown as Parameters<typeof tryBulkListRoutes>[4])
        )
          return true;

        if (
          await tryBulkWriteRoutes(req, res, url, pathname, {
            ...common,
            workspaceVerbatimResolver,
          } as unknown as Parameters<typeof tryBulkWriteRoutes>[4])
        )
          return true;

        if (
          await trySearchRoutes(req, res, url, pathname, {
            ...common,
            detectedScope,
            workspaceVerbatimResolver,
          } as unknown as Parameters<typeof trySearchRoutes>[4])
        )
          return true;

        if (
          await tryTopologyRoutes(req, res, url, pathname, {
            ...common,
          } as unknown as Parameters<typeof tryTopologyRoutes>[4])
        )
          return true;

        if (
          await tryInspectRoutes(req, res, url, pathname, {
            ...common,
            detectedScope,
          } as unknown as Parameters<typeof tryInspectRoutes>[4])
        )
          return true;

        if (
          await tryDiagnosticRoutes(req, res, url, pathname, {
            ...common,
            configManager: undefined as never,
            activeSessions: new Map(),
            getDataplaneState: () => 'offline' as const,
          } as unknown as Parameters<typeof tryDiagnosticRoutes>[4])
        )
          return true;

        // Verbatim family: tryVerbatimRoutes owns POST /api/verbatim,
        // GET /api/verbatim/get, GET /api/verbatim/search (allowlisted) AND the
        // history/reap/tombstone verbs (NOT allowlisted — matchesAllowlist gated
        // those out before we got here, so they never reach this call).
        if (
          await tryVerbatimRoutes(req, res, url, {
            ...common,
            detectedScope,
            workspaceVerbatimResolver,
          } as unknown as Parameters<typeof tryVerbatimRoutes>[3], pathname)
        )
          return true;

        // Allowlisted but unhandled by any family — should be unreachable (the
        // allowlist and the families are kept in sync). Fail loud rather than
        // silently 404 with a foreign shape.
        writeError(
          res,
          500,
          'internal_error',
          `arcade data route ${method} ${pathname} passed the allowlist but no family handled it`,
        );
        return true;
      }),
    ),
  );
}
