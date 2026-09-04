/**
 * cloud-slice3-local-harness.ts — the LOCAL-mode counterpart to
 * arcadeData.ts's dispatcher, used ONLY by the Slice-3 differential-parity
 * test (cloud-slice3-dataplane-parity-e2e.ts).
 *
 * WHY THIS EXISTS: the parity requirement is "run the SAME public HTTP
 * operation against local and arcade and diff the results". The arcade side
 * already has a proven in-process driver (tryArcadeDataRoutes fed mock
 * req/res — see test/slice3-arcadedata-selfcheck.ts). This module is the
 * mirror for local: it drives the IDENTICAL local route families
 * (tryNodesRoutes, trySearchRoutes, ...) against a REAL SurrealGraph
 * (embedded SurrealDB — the local graph engine default since 2026-08-11) +
 * VerbatimStore (LanceDB) pair, with NO daemon/HTTP listener and no other
 * local subsystems (sync, outbox, timers) — exactly the same "route-level,
 * substrate-real" altitude the arcade harness runs at, so the diff isolates
 * substrate behavior (SurrealDB+LanceDB vs ArcadeDB), not incidental daemon
 * plumbing.
 *
 * Deliberately NOT a general-purpose local test harness — it is scoped to
 * what the Slice 3 allowlist covers (matching arcadeData.ts's route set) and
 * lives in test/, not src/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { createTableStorage } from '../packages/lore/src/engines/tableStorageFactory.js';
import type { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { WorkspaceNotFoundError } from '../packages/lore/src/engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { runWithRouteBindingSlot } from '../packages/lore/src/security/routeWorkspaceBinding.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { ISessionCache, HotSessionSnapshot } from '../packages/lore/src/engines/sessionCache.js';
import { writeError } from '../packages/lore/src/mcp/http/helpers.js';

import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';
import { tryTopologyRoutes } from '../packages/lore/src/mcp/http/routes/topology.js';
import { tryInspectRoutes } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { tryVerbatimRoutes } from '../packages/lore/src/mcp/http/routes/retention/verbatim.js';

/** A minimal in-process ISessionCache — mirrors arcadeCellPool's
 *  InMemorySessionCache so both sides bookkeep recent-nodes identically
 *  (neither persists to a shared file, so neither leaks across test runs). */
class InMemorySessionCache implements ISessionCache {
  public readonly backend = 'local-file' as const;
  private recent: string[] = [];
  private static readonly CAP = 50;
  pushNode(nodeId: string): void {
    this.recent = [nodeId, ...this.recent.filter((id) => id !== nodeId)].slice(0, InMemorySessionCache.CAP);
  }
  getHotContext(): HotSessionSnapshot {
    return { recent_nodes: [...this.recent] };
  }
  flushNow(): void {
    /* in-memory */
  }
}

export interface LocalWorkspaceHandle {
  readonly workspace: string;
  readonly basePath: string;
  readonly graph: SurrealGraph;
  readonly verbatim: VerbatimStore;
  readonly store: StorageBundle;
  close(): Promise<void>;
}

/**
 * Build a real local workspace: a fresh temp dir with its own embedded
 * SurrealDB graph dir + LanceDB dir, exactly as `lore init` would produce for
 * one workspace (SurrealDB has been the default local graph engine since
 * 2026-08-11).
 */
export async function openLocalWorkspace(
  workspace: string,
  embedder: EmbeddingProvider,
): Promise<LocalWorkspaceHandle> {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), `lore-local-parity-${workspace}-`));
  const graph = new SurrealGraph(basePath, { workspaceId: workspace });
  const verbatim = new VerbatimStore(basePath, embedder);
  // VerbatimStore requires an explicit initialize() before use (unlike the
  // arcade side, which lazily initializes on first HTTP call) — without this
  // every inline verbatim write throws "Store not initialized" and postNode's
  // consistency guard deletes the just-written graph node.
  await verbatim.initialize();
  // fromSurreal, not fromLocal — the single chokepoint enforcing the BSL 1.1
  // boundary (storage/surrealLicenceGuard.ts / D-022 arch rule).
  const storageClient = LoreStorageClient.fromSurreal({ graph, verbatim, deploymentMode: 'local' });
  const store: StorageBundle = {
    sdk: null,
    loreGraph: graph,
    loreVerbatim: verbatim,
    sessionCache: new InMemorySessionCache(),
    tableStorage: createTableStorage(basePath),
    storageClient,
    deploymentMode: 'local',
  };
  return {
    workspace,
    basePath,
    graph,
    verbatim,
    store,
    close: async () => {
      try { await graph.close(); } catch { /* already closed */ }
      try { await verbatim.close(); } catch { /* already closed */ }
      try { fs.rmSync(basePath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Single-workspace LocalGraphRegistry shim — the local-side mirror of
 *  arcadeData.ts's cellRegistryShim. Confines getOrOpen/getGraphHandle/
 *  activeName to the ONE workspace this harness owns, exactly as the arcade
 *  shim confines to one cell.
 *
 *  getGraphHandle is implemented alongside the legacy getOrOpen: the route
 *  families this harness drives resolve their graph via the engine-aware
 *  `graphRegistry.getGraphHandle(...)`, not the legacy-only `getOrOpen` — a
 *  shim exposing only the latter throws `TypeError: ...getGraphHandle is not
 *  a function` the moment any driven route reaches it. */
function registryShim(handle: LocalWorkspaceHandle): LocalGraphRegistry {
  const shim = {
    async getOrOpen(requested: string) {
      if (requested !== handle.workspace) throw new WorkspaceNotFoundError(requested, [handle.workspace]);
      return handle.graph;
    },
    async getGraphHandle(requested: string) {
      if (requested !== handle.workspace) throw new WorkspaceNotFoundError(requested, [handle.workspace]);
      return handle.graph;
    },
    activeName(): string {
      return handle.workspace;
    },
    async withGraph<T>(requested: string, fn: (g: unknown) => Promise<T>): Promise<T> {
      if (requested !== handle.workspace) throw new WorkspaceNotFoundError(requested, [handle.workspace]);
      return fn(handle.graph);
    },
  };
  return shim as unknown as LocalGraphRegistry;
}

function verbatimResolverShim(handle: LocalWorkspaceHandle): WorkspaceVerbatimResolver {
  const shim = {
    async getOrOpen(requested: string) {
      if (requested !== handle.workspace) throw new WorkspaceNotFoundError(requested, [handle.workspace]);
      return handle.verbatim;
    },
  };
  return shim as unknown as WorkspaceVerbatimResolver;
}

function toTokenScopes(scopes: ReadonlyArray<'read' | 'write'>): TokenScope[] {
  const out: TokenScope[] = [];
  if (scopes.includes('read')) out.push('read');
  if (scopes.includes('write')) out.push('write');
  return out;
}

export interface LocalDataDeps {
  auditLog: AuditLog;
  edgeRelations?: ReadonlyArray<string>;
}

/**
 * tryLocalDataRoutes — the LOCAL-mode mirror of tryArcadeDataRoutes. Binds a
 * real app Principal to `handle.workspace` + a matching route-binding slot
 * (no cell slot — local mode has none), then delegates to the SAME local
 * route families arcadeData.ts calls. This is deliberately the closest
 * possible parallel: same principal shape, same route functions, same
 * allowlist surface — only the underlying substrate (real the legacy graph engine/LanceDB
 * instead of ArcadeDB) differs.
 */
export async function tryLocalDataRoutes(
  req: unknown,
  res: unknown,
  url: string,
  pathname: string,
  handle: LocalWorkspaceHandle,
  scopes: ReadonlyArray<'read' | 'write'>,
  deps: LocalDataDeps,
): Promise<boolean> {
  const appPrincipal: Principal = {
    kind: 'app',
    workspace: handle.workspace,
    scopes: toTokenScopes(scopes),
    label: `local-parity:${handle.workspace}`,
  };

  const graphRegistry = registryShim(handle);
  const workspaceVerbatimResolver = verbatimResolverShim(handle);
  const detectedScope = { workspace: handle.workspace, ecosystem: '' };

  return runWithPrincipal(appPrincipal, () =>
    runWithRouteBindingSlot({ target: handle.workspace, lane: 'workspace' }, async () => {
      const common = {
        store: handle.store,
        deploymentMode: 'local' as const,
        dataplane: null,
        graphRegistry,
        auditLog: deps.auditLog,
      };

      const r = req as Parameters<typeof tryNodesRoutes>[0];
      const s = res as Parameters<typeof tryNodesRoutes>[1];

      if (
        await tryNodesRoutes(r, s, url, pathname, {
          ...common,
          pendingOpsStore: undefined as never,
          // No outbox in this harness either (mirrors arcadeData.ts's own
          // no-outbox-this-slice posture) — seed verbatim INLINE via the
          // facade so embed:true -> recall/search work over this harness,
          // exactly like the arcade side, so the differential parity test
          // compares equivalent embed pipelines on both substrates.
          inlineVerbatim: handle.store.storageClient,
        } as unknown as Parameters<typeof tryNodesRoutes>[4])
      )
        return true;

      if (
        await tryNodeDeleteRoute(r, s, url, pathname, {
          ...common,
          workspaceVerbatimResolver,
        } as unknown as Parameters<typeof tryNodeDeleteRoute>[4])
      )
        return true;

      if (
        await tryEdgesRoutes(r, s, url, pathname, {
          ...common,
          edgeRelations: deps.edgeRelations,
        } as unknown as Parameters<typeof tryEdgesRoutes>[4])
      )
        return true;

      if (
        await tryBulkListRoutes(r, s, url, pathname, {
          ...common,
        } as unknown as Parameters<typeof tryBulkListRoutes>[4])
      )
        return true;

      if (
        await tryBulkWriteRoutes(r, s, url, pathname, {
          ...common,
          workspaceVerbatimResolver,
        } as unknown as Parameters<typeof tryBulkWriteRoutes>[4])
      )
        return true;

      if (
        await trySearchRoutes(r, s, url, pathname, {
          ...common,
          detectedScope,
          workspaceVerbatimResolver,
        } as unknown as Parameters<typeof trySearchRoutes>[4])
      )
        return true;

      if (
        await tryTopologyRoutes(r, s, url, pathname, {
          ...common,
        } as unknown as Parameters<typeof tryTopologyRoutes>[4])
      )
        return true;

      if (
        await tryInspectRoutes(r, s, url, pathname, {
          ...common,
          detectedScope,
        } as unknown as Parameters<typeof tryInspectRoutes>[4])
      )
        return true;

      if (
        await tryDiagnosticRoutes(r, s, url, pathname, {
          ...common,
          configManager: undefined as never,
          activeSessions: new Map(),
          getDataplaneState: () => 'offline' as const,
        } as unknown as Parameters<typeof tryDiagnosticRoutes>[4])
      )
        return true;

      if (
        await tryVerbatimRoutes(r, s, url, {
          ...common,
          detectedScope,
          workspaceVerbatimResolver,
        } as unknown as Parameters<typeof tryVerbatimRoutes>[3], pathname)
      )
        return true;

      writeError(
        s,
        500,
        'internal_error',
        `local parity harness: ${pathname} passed no route family`,
      );
      return true;
    }),
  );
}

// ── mock req/res (identical shape to slice3-arcadedata-selfcheck.ts) ──────
export interface Captured { status: number; body: unknown; }

export function mkReq(method: string, url: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {};
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

export function mkRes(): { res: unknown; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  let raw = '';
  const res = {
    headersSent: false,
    statusCode: 200,
    writeHead(status: number) { captured.status = status; (res as { headersSent: boolean }).headersSent = true; return res; },
    setHeader() { return res; },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      if (captured.status === 0) captured.status = (res as { statusCode: number }).statusCode;
      try { captured.body = raw ? JSON.parse(raw) : undefined; } catch { captured.body = raw; }
    },
    write(chunk: string) { raw += chunk; return true; },
  };
  return { res, captured };
}

export async function driveLocal(
  handle: LocalWorkspaceHandle,
  scopes: ReadonlyArray<'read' | 'write'>,
  deps: LocalDataDeps,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number; body: unknown }> {
  const pathname = apiPath.split('?')[0]!;
  const req = mkReq(method, apiPath, body);
  const { res, captured } = mkRes();
  const handled = await tryLocalDataRoutes(req, res, apiPath, pathname, handle, scopes, deps);
  return { handled, status: captured.status, body: captured.body };
}
