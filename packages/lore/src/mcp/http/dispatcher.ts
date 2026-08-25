/**
 * dispatcher.ts — HTTP request dispatcher.
 *
 * Runs the gate gauntlet (auth, rate limit, bootstrap, workspace,
 * orphan) and then walks each route family in order. The first family
 * that returns true has handled the request; the dispatcher returns.
 * If no family matches, it writes a 404.
 *
 * Family order matters only for performance (every family before the
 * matching one runs an inexpensive pathname compare). The chat family
 * is first because it's the highest-volume route in interactive use;
 * MCP transport is last among matchers because chat/api routes are
 * checked before /mcp.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SyncEngine } from '../../engines/syncEngine.js';
import type { TsSdkAdapter } from '../../engines/tsSdkAdapter.js';
import type { ConfigManager } from '../../config/configManager.js';
import type { AuditLog } from '../../security/audit.js';
import type { ConsentManager } from '../../security/consent.js';
import type { LoreDeploymentMode } from '../server.js';
import type { SchemaLoader } from '../../schemas/loader.js';
import type { RateLimiter } from '../../security/rateLimit.js';
import type { RetentionSweeper } from '../../engines/retentionSweep.js';
import type { LocalFileSink } from '../../engines/archive.js';
import type { McpClientRuntime } from '../../engines/mcpClient/runtime.js';
import type { ConnectorRegistry } from '../../engines/connectors/registry.js';
import type { FeedbackStore } from '../../engines/feedbackStore.js';
import { runHttpGates, withPrincipalIfAny, withActorIfAny, runWithWorkspaceIfAny, runWithRouteBindingSlotIfLocal, makeActorResolver, type ActorResolver } from './middleware.js';
import { writeError } from './helpers.js';
import { compileClerkValidator } from '../../security/clerkAuth.js';
import { readOperatorIdentity } from '../../security/operatorIdentity.js';
import { tryDiagnosticRoutes } from './routes/diagnostic.js';
import { tryMetricsRoutes } from './routes/metrics.js';
import { tryAnalyticsRoutes } from './routes/analytics.js';
import { makeWorkspaceAnalyticalResolver } from '../../engines/analyticalResolver.js';
import { trySyncRoutes } from './routes/sync.js';
import { tryRetentionRoutes, type RetentionSweepResult } from './routes/retention.js';
import { tryWorkspacesRoutes } from './routes/workspaces.js';
import { tryWorkspaceExportRoutes } from './routes/workspaceExport.js';
import { tryAuditRoutes } from './routes/audit.js';
import { tryAdminRoutes } from './routes/admin.js';
import { tryConfigRoutes } from './routes/config.js';
import { tryStaticRoutes } from './routes/static.js';
import { tryIngestionRoutes } from './routes/ingestion.js';
import { tryTopologyRoutes } from './routes/topology.js';
import { trySearchRoutes } from './routes/search.js';
import { tryNodesRoutes } from './routes/nodes.js';
import { tryNodeDeleteRoute } from './routes/nodes-delete.js';
import { tryEdgesRoutes } from './routes/edges.js';
import { tryBulkListRoutes } from './routes/bulkList.js';
import { tryBulkWriteRoutes } from './routes/bulkWrite.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../../outbox/workspaceVerbatimResolver.js';
import { tryImportRoutes } from './routes/import.js';
import { tryLoadRoutes } from './routes/load.js';
import type { LoadJobsStore } from '../../storage/loadJobsStore.js';
import type { WorkspaceConcurrencyManager } from '../../storage/loadJobsConcurrency.js';
import { tryStreamRoutes } from './routes/stream.js';
import type { StreamRegistry } from '../../streaming/streamRegistry.js';
import { tryMcpTransportRoute } from './routes/mcp.js';
import { tryApprovalsRoutes } from './routes/approvals.js';
import { tryCollectionsRoutes } from './routes/collections.js';
import type { PendingOpsStore } from '../../security/pendingOps.js';
import type { ReplayHandlerRegistry } from '../../security/approvalReplay.js';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle, PhaseAServices } from '../services.js';
import { trySchemaRoutes } from './routes/schema.js';
import { tryOrchestrationsRoutes } from './routes/orchestrations.js';
import type { PlanOrchestrator } from '../../schemas/orchestration/orchestrator.js';
import { tryLifecycleRoutes } from './routes/lifecycle.js';
import { tryOutcomesRoutes } from './routes/outcomes.js';
import { tryVersioningRoutes } from './routes/versioning.js';
import { tryAnchorsRoutes } from './routes/anchors.js';
import { tryCorpusRoutes } from './routes/corpus.js';
import { tryFreshnessRoutes } from './routes/freshness.js';
import { tryInspectRoutes } from './routes/inspect.js';
import type { AuxStore } from '../../outbox/auxStore.js';
import type { VersionStore } from '../../outbox/versionStore.js';

export interface DispatcherDeps {
    /** Boot-time. */
    port: number;
    deploymentMode: 'local' | 'cloud';
    /**
     * ITEM 3 (launch-fixes-2026-08) — the instance's full run mode
     * (`LoreInstance.runMode`). `deploymentMode` above collapses
     * 'embedded' into 'local' (same substrates); the schema-approve
     * mandatory-HITL gate needs the un-collapsed value so an embedded
     * boot refuses destructive approvals at proposal time instead of
     * enqueueing an op no host can ever decide. Optional: the HTTP
     * surface only runs in daemon modes today (main() returns before
     * binding a port in embedded), and dispatcher-level test harnesses
     * predate the field — production wires `lore.runMode` in server.ts.
     */
    runMode?: LoreDeploymentMode;
    detectedScope: { workspace: string; ecosystem: string };
    graphBasePath: string;
    loreDir: string;

    /** Singletons. */
    /** Phase 2 unified storage handle — used by every route family. */
    store: StorageBundle;
    configManager: ConfigManager;
    schemaLoader: SchemaLoader;
    auditLog: AuditLog;
    consentManager: ConsentManager;
    feedbackStore: FeedbackStore;
    rateLimiter: RateLimiter;
    retentionSweeper: RetentionSweeper;
    archiveSink: LocalFileSink;
    mcpClientRuntime: McpClientRuntime;
    connectorRegistry: ConnectorRegistry;
    extractorRegistry: import('../../engines/extractors/index.js').ExtractorRegistry;
    activeSessions: Map<string, StreamableHTTPServerTransport>;
    /** Audit 2026-05-13: touch on every session access; evict on close. */
    touchActiveSession: (id: string) => void;
    evictActiveSession: (id: string) => void;
    /** HITL queue. Kùzu-backed in local mode, in-memory in cloud mode
     *  until the Postgres impl lands. Routes consume only the interface. */
    pendingOpsStore: PendingOpsStore;
    /** HITL replay registry. Empty by default; ops register themselves
     *  during boot. Decision endpoint invokes the matching handler on
     *  approve and advances the row to executed. */
    replayRegistry: ReplayHandlerRegistry;
    /** Dataplane SDK handle for ReBAC checks. Non-null in cloud mode,
     *  null in local mode. Routes that gate via `gateRoute` consume
     *  this; non-gated routes ignore it. */
    dataplane: GroundfloorClient | null;

    /** Mutable singletons (let-reassigned in main()). */
    getAuthToken: () => string;
    /**
     * Optional pre-supplied shared secret for service-to-service auth
     * (DEF/Loom → Lore in cloud mode). Read once from
     * `LORE_MCP_AUTH_TOKEN` env at boot. Falsy in local mode.
     */
    getSharedSecret?: () => string | undefined;
    getSyncEngine: () => SyncEngine;
    getSyncAdapter: () => TsSdkAdapter | null;
    /** Wave 4.3 — per-workspace SyncEngine registry. Optional so cloud-mode
     *  boots (no local WAL) and older wiring/tests without it still type;
     *  routes/sync.ts falls back to `getSyncEngine()` (the boot engine) when
     *  absent. */
    syncEngineRegistry?: import('../../engines/syncEngineRegistry.js').SyncEngineRegistry;

    /** Lifecycle hooks. */
    runRetentionSweep: (dryRun: boolean) => Promise<RetentionSweepResult>;
    getDataplaneState: () => 'unknown' | 'offline' | 'opted-out' | 'bound' | 'error';
    resolveToolTier: () => 'default' | 'slim' | 'opt-in';
    createMcpServer: () => McpServer;
    /** Phase 2.5 item 6 — Phase A schema-authoring + governance
     *  singletons exposed via /api/schema/* REST routes so the admin
     *  app + no-code tools can drive the propose/approve/reject/
     *  rollback flow without an MCP client. */
    phaseA: PhaseAServices;
    /** Phase 4 item 8 — migration runner backend (Kùzu in local
     *  mode; cloud impl pending). Drives
     *  /api/schema/migrations/dry-run + /execute. Optional so
     *  cloud-mode boots that haven't wired Postgres yet still
     *  serve the rest of the surface. */
    migrationBackend?: import('../../schemas/migration/types.js').MigrationBackend;
    /** Phase 4 batched checkpointing — persists per-batch progress
     *  to <workspace>/.lore/migrations/in-flight.json so a crashed
     *  plan can be resumed via POST /api/schema/migrations/resume.
     *  Required for the resume endpoint to function. */
    migrationCheckpointStore?: import('../../schemas/migration/checkpointStore.js').CheckpointStore;
    /** Phase 4 item 4 — auto-orchestration of decomposed plans. When
     *  wired, exposes /api/schema/orchestrations/* and a background
     *  tick loop that walks each active orchestration through its
     *  expand → migrate → soak → contract phases. */
    planOrchestrator?: PlanOrchestrator;
    /**
     * Phase 6 P1.B — multi-workspace LocalGraph registry. Boot
     * constructs it once and threads it into every HTTP route family
     * that wants per-request workspace routing. Today only the POST
     * /api/node handler consumes it; future P1.C will extend to
     * /api/node/supersede + edge/delete REST routes + MCP-over-HTTP
     * tool handlers.
     *
     * Optional so cloud-mode boots that don't wire a local registry
     * still serve REST writes against the boot-bound LocalGraph.
     */
    graphRegistry?: LocalGraphRegistry;

    /** L-018 — per-workspace verbatim (LanceDB) resolver. Threaded into
     *  the ingestion routes so the destructive reconnect/reconsume rebuild
     *  targets the requested workspace's verbatim store (alongside the
     *  per-workspace graph from graphRegistry). Undefined in cloud mode
     *  (server.ts builds it only when deploymentMode !== 'cloud'). */
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;

    /** Sprint O1 — outbox aggregate-stats provider. /api/health calls
     *  this on every request to emit the `outbox` block (depth +
     *  lagSeconds + per-workspace breakdown). Optional so cloud-mode
     *  / bare-test wiring without an outbox still types. */
    getOutboxStats?: () => Promise<import('../../outbox/types.js').OutboxAggregateStats>;
    /** Sprint O2 — outbox store for hot-lane writes. Every hot single-
     *  write endpoint records to this BEFORE calling the substrate; the
     *  replicator handles fan-out async. Optional so cloud-mode / test
     *  wiring without an outbox still types. */
    outboxStore?: import('../../outbox/types.js').OutboxStore;
    /** Sprint O4 — per-workspace lag cache. Hot + bulk routes call
     *  `shouldBackpressure(workspace)` on the request path and return
     *  503 outbox_lag when the cache says the workspace is behind.
     *  Optional so cloud/test wiring without an outbox still types;
     *  routes treat undefined as "no backpressure check". */
    outboxLagCache?: import('../../outbox/lagCache.js').OutboxLagCache;

    /** Phase 6 P2 — core node types (always active). Used by the
     *  vocab-policy engine to produce activation hints for extended
     *  types. Defaults to empty array when absent (open mode). */
    coreNodeTypes?: ReadonlyArray<string>;
    /**
     * W2 (Sprint W) — allowed edge relation strings for the new
     * /api/edge endpoint's pre-validation gate. Optional: when omitted
     * the route skips the enum check and addEdge surfaces a Cypher
     * error if the relation is bogus. Boot wires this from the same
     * merged-enum source `store_edge` MCP tool uses.
     */
    edgeRelations?: ReadonlyArray<string>;

    /** Architecture gap #2 — async embed queue. When wired, bulk
     *  import paths enqueue embedding compute instead of blocking
     *  on it. Optional so test fixtures can pass undefined. */
    embedQueue?: { enqueue: (nodeId: string, text: string) => void };

    /** Sprint Z1 — async streaming-upload job store (load_jobs SQLite
     *  table at <loreDir>/load-jobs.sqlite). Powers POST /api/load +
     *  GET /api/load/jobs. Optional so cloud-mode / test wiring without
     *  the store still types; the load routes short-circuit if absent. */
    loadJobsStore?: LoadJobsStore;

    /** Sprint Z3 — per-workspace concurrency manager. Optional so cloud /
     *  test wiring without it still types; the load route falls back to
     *  uncapped behaviour when missing (Z3 production wiring always
     *  supplies one — see mcp/server.ts). */
    loadConcurrencyManager?: WorkspaceConcurrencyManager;

    /** Sprint S — in-memory streaming-ingest session registry +
     *  per-workspace concurrency cap. Optional so cloud / test wiring
     *  without it still types; the /api/stream/connect route refuses
     *  with 503 stream_registry_unavailable when absent. */
    streamRegistry?: StreamRegistry;

    /** Sprint C3 — per-workspace write-time quota store. When wired,
     *  hot-lane writes consult it before committing to the outbox and
     *  refuse with HTTP 429 workspace_quota_exceeded when the projected
     *  totals exceed workspaces.json's maxNodes / maxStorageBytes.
     *  Optional so test/cloud wiring without it still types. */
    quotaStore?: import('../../security/workspaceQuota.js').IWorkspaceQuotaStore;
    /** Sprint C3 — resolves the workspace entry for quota lookup.
     *  Defaults to a no-op resolver when quotaStore is unset. */
    getWorkspaceEntryForQuota?: (workspace: string) => import('../../config/workspaces.js').WorkspaceEntry | undefined;

    /** Sprint C5 — IAnalyticalStorage handle for the REST siblings of
     *  the MCP `time_series` + `aggregate` tools. Lazy getter so cloud
     *  mode (where the impl ships in step #6) can plug in later
     *  without a boot reorder. Returns null when unwired — the routes
     *  surface HTTP 503 analytical_not_wired. */
    getAnalytical?: () => import('../../contracts/index.js').IAnalyticalStorage | null;

    /** Feature 1/2/7 — AuxStore for lifecycle, outcomes, and corpus-health
     *  REST routes. Optional so cloud-mode boots without it still type. */
    auxStore?: AuxStore;

    /** Feature 8 — VersionStore for versioning and changeset REST routes.
     *  Optional so cloud-mode boots without it still type. */
    versionStore?: VersionStore;

    /** L-030 — per-request actor resolver (Clerk JWT → operator identity).
     *  Boot-injected; threaded into runHttpGates so getCurrentActor() /
     *  getCurrentActorScopes() are populated downstream. Optional so local
     *  mode without Clerk/operator identity (and tests) keep the actor null
     *  and behave exactly as before. */
    resolveActor?: ActorResolver;
}

/**
 * L-030 — lazily-built, cached production actor resolver used when the boot
 * wiring did not inject `deps.resolveActor`. Building it reads operator.json
 * once and (when CLERK_ISSUER is set) compiles a Clerk validator, so it must be
 * cached rather than rebuilt per request. `makeActorResolver` returns undefined
 * when only the Clerk path could apply and CLERK_ISSUER is unset; in production
 * the dispatcher always passes `readOperatorIdentity`, so a resolver is built
 * (operator path) and the result is non-undefined. `null` here distinguishes
 * "not yet built" from "built/attempted, but no resolver applies" and ALSO
 * caches a build FAILURE: if compileClerkValidator throws (e.g. a malformed
 * CLERK_ISSUER makes `new URL()` throw synchronously), we log once and cache a
 * no-op (null) resolver so every subsequent request doesn't re-throw and 500.
 */
let _defaultActorResolver: ActorResolver | null | undefined;
function getDefaultActorResolver(): ActorResolver | undefined {
    if (_defaultActorResolver !== undefined) return _defaultActorResolver ?? undefined;
    try {
        const built = makeActorResolver({
            clerkIssuer: process.env.CLERK_ISSUER,
            compileClerkValidator: (cfg) => compileClerkValidator(cfg),
            readOperatorIdentity: () => readOperatorIdentity(),
        });
        _defaultActorResolver = built ?? null;
        return built;
    } catch (err) {
        // A malformed CLERK_ISSUER makes compileClerkValidator's `new URL()`
        // throw synchronously. Without this catch the throw was UNCACHED, so
        // every request re-built and re-threw → repeated uncaught 500s. Log
        // once and cache a no-op resolver: subsequent requests proceed with a
        // null actor (fail-open to local/operator behavior) instead of 500ing.
        console.error(
            `[dispatcher] failed to build default actor resolver (check CLERK_ISSUER): ${(err as Error).message}`,
        );
        _defaultActorResolver = null;
        return undefined;
    }
}

/** Test seam — reset the cached default resolver between cases. */
export function _resetDefaultActorResolverForTests(): void {
    _defaultActorResolver = undefined;
}

export async function dispatchHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    deps: DispatcherDeps,
): Promise<void> {
    // Pre-route gates: auth, rate limit, bootstrap short-circuit,
    // workspace header (cloud mode). See mcp/http/middleware.ts. On
    // `handled`, the gate already wrote the response — bail out.
    // (NW-7f removed the never-enforced orphan-decision block.)
    const gate = await runHttpGates(req, res, {
        port: deps.port,
        getAuthToken: deps.getAuthToken,
        getSharedSecret: deps.getSharedSecret,
        rateLimiter: deps.rateLimiter,
        deploymentMode: deps.deploymentMode,

        // Phase 6 P3 — bootstrap principal is bound to the workspaces.json
        // active workspace (NOT detectedScope, which can be "*" when CWD
        // doesn't match any registered workspace path). Local mode reads
        // through graphRegistry; cloud-mode boots fall back to the
        // CWD-resolved scope since there is no local workspaces.json.
        getBootstrapWorkspace: () =>
            deps.graphRegistry?.activeName() ?? deps.detectedScope.workspace,

        // L-030 — actor resolver (Clerk JWT → operator identity). Prefer the
        // boot-injected one; otherwise fall back to the cached default built
        // from CLERK_ISSUER + operator.json. In production this dispatcher always
        // passes readOperatorIdentity to the builder, so the default resolves
        // (operator path) rather than being undefined; the default is only
        // `undefined`/no-op when the build is skipped (Clerk-only path, no
        // CLERK_ISSUER) or the build FAILED (malformed CLERK_ISSUER, cached as
        // no-op). In every undefined case runHttpGates leaves the actor null and
        // behavior is unchanged (local dev with no operator identity).
        resolveActor: deps.resolveActor ?? getDefaultActorResolver(),
    });
    if (gate.handled) return;
    const { url, pathname, principal, actor, workspaceId } = gate;
    // Phase 6 P3 — bind principal to the rest of the async chain so
    // routes can call `getCurrentPrincipal()` without explicit threading.
    // L-030 — bind the actor as its exact sibling so getCurrentActor()/
    // getCurrentActorScopes() are populated for the whole downstream chain.
    // L-032 — bind the cloud workspace via the callback-scoped runWithWorkspace
    // (storage.run, pops on completion) instead of the leak-prone enterWith,
    // mirroring the principal/actor scoping so getCurrentWorkspaceId() is
    // request-scoped and never bleeds into a concurrent request.
    // Wave 4.1 — in local mode also install the route-binding slot
    // { target: workspaceId, lane: 'workspace' } so every workspace-addressed
    // substrate open is confined to the validated target unless a route widens
    // it. Cloud mode is untouched (keeps runWithWorkspaceIfAny + tenantProvider);
    // the slot installer is a no-op for cloud / when workspaceId is undefined.
    return withPrincipalIfAny(principal, () =>
        withActorIfAny(actor, () =>
            runWithWorkspaceIfAny(workspaceId, () =>
                runWithRouteBindingSlotIfLocal(deps.deploymentMode, workspaceId, () =>
                    dispatchAfterGates(req, res, url, pathname, deps),
                ),
            ),
        ),
    );
}

async function dispatchAfterGates(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: DispatcherDeps,
): Promise<void> {

    // Phase 2 item 5 — SDK-aligned collection CRUD on /v1/{collection}.
    // Mounted before all /api/* families because it owns its own
    // prefix; Bearer is required by httpAuth.ts upstream and the
    // family short-circuits on prefix mismatch (cheap when not matched).
    if (await tryCollectionsRoutes(req, res, url, pathname, {
        tableStorage: deps.store.tableStorage,
        store: deps.store,
        graphRegistry: deps.graphRegistry,
    })) return;

    // Chat family removed in TW-6b — Lore Core is API + MCP only, no
    // LLM chat surface. /api/chat + /api/chat/action no longer exist.
    // See DECISIONS.md (2026-06-15). A management/chat UI is a separate
    // cloud application, built later.

    if (await tryNodesRoutes(req, res, url, pathname, {
        store: deps.store,
        auditLog: deps.auditLog,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // P2 — supersession-candidates scans the requested ws's LanceDB.
        pendingOpsStore: deps.pendingOpsStore,
        coreNodeTypes: deps.coreNodeTypes,
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
        quotaStore: deps.quotaStore,
        getWorkspaceEntryForQuota: deps.getWorkspaceEntryForQuota,
    })) return;

    // W8 (Sprint W) — DELETE /api/node/:id. Sibling of MCP delete_node;
    // verbatim tombstone is identical. Lives in its own file so nodes.ts
    // stays under the 800-line cap.
    if (await tryNodeDeleteRoute(req, res, url, pathname, {
        store: deps.store,
        auditLog: deps.auditLog,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // route delete tombstone to requested ws's LanceDB.
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
    })) return;

    // W2 (Sprint W) — POST /api/edge + GET /api/edges. Mirrors the
    // /api/node shape so MCP store_edge has a REST sibling. Closure
    // scripts can now stamp depends_on edges via curl without dragging
    // in the MCP SDK + session bootstrap.
    if (await tryEdgesRoutes(req, res, url, pathname, {
        store: deps.store,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
        edgeRelations: deps.edgeRelations,
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
    })) return;

    // W4 (Sprint W) — POST /api/nodes/bulk-list. Rate-limit-exempt
    // bulk enumeration with cursor pagination. The earlier path that
    // mounted before us (tryNodesRoutes) only handles /api/node + the
    // supersession family; bulk-list is its own concern.
    if (await tryBulkListRoutes(req, res, url, pathname, {
        store: deps.store,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
    })) return;

    // W9 (Sprint W follow-on) — bulk-write / bulk-delete / bulk-recall
    // (POST /api/nodes/bulk, /api/edges/bulk, /api/nodes/bulk-delete,
    // /api/recall/bulk). All exempt from rate limiting per W9 — the
    // surgical path for cron / cleanup / closure flows that were
    // tripping the per-class bucket before.
    if (await tryBulkWriteRoutes(req, res, url, pathname, {
        store: deps.store,
        auditLog: deps.auditLog,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // L-012 — inline embed routes to requested ws's LanceDB.
    })) return;

    // Phase 2.5 item 6 — schema-authoring REST mirror at /api/schema/*.
    // Mounted before the rest of /api/* families because it's a tight
    // family that owns its prefix; cheap pathname compare when not
    // matched. Auth + Host + Origin already enforced by runHttpGates.
    if (await tryOrchestrationsRoutes(req, res, url, pathname, {
        orchestrator: deps.planOrchestrator,
        // Wave 4 sweep — the PlanOrchestrator is wired to the boot workspace
        // (wireOrchestration in mcp/server.ts, same as createPhaseAServices
        // below), so gate it the same way as the /api/schema family.
        schemaWorkspace: deps.detectedScope.workspace,
    })) return;

    if (await trySchemaRoutes(req, res, url, pathname, {
        phaseA: deps.phaseA,
        schemaLoader: deps.schemaLoader,
        migrationBackend: deps.migrationBackend,
        migrationCheckpointStore: deps.migrationCheckpointStore,
        loreDir: deps.loreDir,
        pendingOpsStore: deps.pendingOpsStore,
        runMode: deps.runMode,
        // Wave 4.2 — the schema family is physically bound to the boot
        // workspace's .lore (createPhaseAServices + wireOrchestration are
        // constructed over the boot graph in mcp/server.ts). trySchemaRoutes
        // 409s any request whose resolved target differs from this, so a
        // non-boot app token can no longer silently mutate the boot schema.
        schemaWorkspace: deps.detectedScope.workspace,
    })) return;

    if (await trySearchRoutes(req, res, url, pathname, {
        store: deps.store,
        detectedScope: deps.detectedScope,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // P2 — non-active recall seeds its own verbatim store.
    })) return;

    // Sprint Z1 — POST /api/load streaming upload + GET /api/load/jobs/<id>
    // + GET /api/load/jobs?workspace=X listing. Mounted before
    // tryImportRoutes because /api/load and /api/import share no prefix
    // but the cheap pathname compare avoids dragging the import body
    // reader on the new path. The route short-circuits when
    // loadJobsStore isn't wired (cloud/test boots without it).
    if (deps.loadJobsStore && await tryLoadRoutes(req, res, url, pathname, {
        loreDir: deps.loreDir,
        loadJobsStore: deps.loadJobsStore,
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
        concurrencyManager: deps.loadConcurrencyManager,
        // L-019 — POST /api/load now runs ReBAC + token write-scope gates.
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
    })) return;

    // Sprint S — POST /api/stream/connect warm-lane streaming-ingest +
    // GET /api/stream/sessions for diagnostics. Wired after the bulk
    // /api/load endpoint; cheap pathname compare when not matched.
    // Route short-circuits if outboxStore or streamRegistry missing.
    // Launch gate (2026-08-19): streaming ingest is cloud-only —
    // deploymentMode is threaded so tryStreamRoutes 501s both routes at
    // dispatch in local mode (embedded never runs this dispatcher).
    if (await tryStreamRoutes(req, res, url, pathname, {
        deploymentMode: deps.deploymentMode,
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
        streamRegistry: deps.streamRegistry,
    })) return;

    if (await tryImportRoutes(req, res, url, pathname, {
        store: deps.store,
        detectedScope: deps.detectedScope,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        embedQueue: deps.embedQueue,
        // L-016 — token write-scope gate + workspace-aware write routing.
        graphRegistry: deps.graphRegistry,
    })) return;

    if (await tryTopologyRoutes(req, res, url, pathname, {
        store: deps.store,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        // SP-04 — topology reads now resolve through the workspace
        // registry + run the principal read-scope gate.
        graphRegistry: deps.graphRegistry,
    })) return;

    if (await tryIngestionRoutes(req, res, url, pathname, {
        store: deps.store,

        consentManager: deps.consentManager,
        auditLog: deps.auditLog,
        configManager: deps.configManager,
        graphBasePath: deps.graphBasePath,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        extractorRegistry: deps.extractorRegistry,
        // L-018 — write-scope gate + per-workspace destructive-rebuild routing.
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
    })) return;

    if (await tryConfigRoutes(req, res, url, pathname, {
        store: deps.store,
        configManager: deps.configManager,

        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
    })) return;

    if (await tryAdminRoutes(req, res, url, pathname, {

        consentManager: deps.consentManager,
        retentionSweeper: deps.retentionSweeper,
        archiveSink: deps.archiveSink,
        mcpClientRuntime: deps.mcpClientRuntime,
        connectorRegistry: deps.connectorRegistry,
        auditLog: deps.auditLog,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
    })) return;

    if (await tryAuditRoutes(req, res, url, pathname, {
        auditLog: deps.auditLog,
        feedbackStore: deps.feedbackStore,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
    })) return;

    // Slice-4 — workspace EXPORT (local half of workspace→arcade migration).
    // Mounted before tryWorkspacesRoutes so /export is matched before the
    // generic /:name management verbs.
    if (await tryWorkspaceExportRoutes(req, res, pathname, {
        outboxStore: deps.outboxStore,
        graphRegistry: deps.graphRegistry,
        verbatimResolver: deps.workspaceVerbatimResolver,
    })) return;

    if (await tryWorkspacesRoutes(req, res, url, pathname, {

        auditLog: deps.auditLog,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
    })) return;

    if (await tryRetentionRoutes(req, res, url, pathname, {
        store: deps.store,
        auditLog: deps.auditLog,
        runRetentionSweep: deps.runRetentionSweep,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        detectedScope: deps.detectedScope,
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
    })) return;

    if (await tryDiagnosticRoutes(req, res, url, pathname, {
        store: deps.store,

        configManager: deps.configManager,

        activeSessions: deps.activeSessions,
        deploymentMode: deps.deploymentMode,
        getDataplaneState: deps.getDataplaneState,
        rateLimiter: deps.rateLimiter,
        graphRegistry: deps.graphRegistry,
        // RC-round4 — cleanup handler resolves the requested workspace's
        // LanceDB through this so its destructive orphan-delete + compaction
        // never fall back to the boot/active verbatim store.
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
        dataplane: deps.dataplane,
        getOutboxStats: deps.getOutboxStats,
        outboxLagCache: deps.outboxLagCache,
    })) return;

    // Sprint C1 — /metrics endpoint (Prometheus text format).
    // Gated on LORE_METRICS=on env so local installs don't expose a
    // scrape surface by accident. Cloud activation reuses this endpoint
    // behind ingress auth.
    if (await tryMetricsRoutes(req, res, url, pathname, {
        getOutboxStats: deps.getOutboxStats,
        graphRegistry: deps.graphRegistry,
        loadJobsStore: deps.loadJobsStore,
    })) return;

    // Sprint C5 — analytical REST siblings for the MCP `time_series`
    // + `aggregate` tools (closes the deferred B-local parity gap).
    // 503 analytical_not_wired when the backend isn't plugged in.
    if (await tryAnalyticsRoutes(req, res, url, pathname, {
        analytical: deps.getAnalytical ? deps.getAnalytical() : null,
        resolveAnalytical: makeWorkspaceAnalyticalResolver(deps.graphRegistry, deps.deploymentMode),
    })) return;

    // Feature 1 — lifecycle REST: POST /api/nodes/prune,
    // POST /api/nodes/:id/restore, GET /api/prune-jobs/:id.
    if (deps.auxStore && await tryLifecycleRoutes(req, res, url, pathname, {
        store: deps.store,
        auxStore: deps.auxStore,
        versionStore: deps.versionStore,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // route prune tombstone to requested ws's LanceDB.
    })) return;

    // Feature 2 — outcomes REST: POST/GET /api/nodes/:id/outcomes.
    if (deps.auxStore && await tryOutcomesRoutes(req, res, url, pathname, {
        store: deps.store,
        auxStore: deps.auxStore,
        versionStore: deps.versionStore,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
    })) return;

    // Feature 8 — versioning REST: history, diff, changesets, snapshot.
    if (deps.versionStore && await tryVersioningRoutes(req, res, url, pathname, {
        versionStore: deps.versionStore,
        store: deps.store,
        graphRegistry: deps.graphRegistry,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        // 1.M7 — changeset commit/rollback orchestration.
        outboxStore: deps.outboxStore,
        embedQueue: deps.embedQueue,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
    })) return;

    // Feature 6 — anchors REST: GET /api/nodes/:id/anchors.
    if (await tryAnchorsRoutes(req, res, url, pathname, {
        store: deps.store,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
    })) return;

    // Feature 7 — corpus health REST: GET /api/workspaces/:name/health.
    if (deps.auxStore && await tryCorpusRoutes(req, res, url, pathname, {
        store: deps.store,
        auxStore: deps.auxStore,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry, // route :name/health to that workspace's graph.
    })) return;

    // Freshness sprint — GET /api/workspaces/:name/freshness.
    if (await tryFreshnessRoutes(req, res, url, pathname, {
        store: deps.store,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
    })) return;

    // Inspect — GET /api/lore-status + GET /api/node-list.
    if (await tryInspectRoutes(req, res, url, pathname, {
        store: deps.store,
        detectedScope: deps.detectedScope,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
        graphRegistry: deps.graphRegistry,
    })) return;

    if (await tryMcpTransportRoute(req, res, url, pathname, {
        createMcpServer: deps.createMcpServer,
        activeSessions: deps.activeSessions,
        touchActiveSession: deps.touchActiveSession,
        evictActiveSession: deps.evictActiveSession,
    })) return;

    if (await trySyncRoutes(req, res, url, pathname, {
        getSyncEngine: deps.getSyncEngine,
        resolveSyncEngine: deps.syncEngineRegistry
            ? (ws) => deps.syncEngineRegistry!.getOrOpen(ws)
            : undefined,
    })) return;

    if (await tryApprovalsRoutes(req, res, url, pathname, {
        getPendingOpsStore: () => deps.pendingOpsStore,
        getReplayRegistry: () => deps.replayRegistry,
        deploymentMode: deps.deploymentMode,
        dataplane: deps.dataplane,
    })) return;

    if (await tryStaticRoutes(req, res, url, pathname, {
        store: deps.store,
        // L-007 — HTML export now runs the read-scope gate + resolves the
        // requested workspace's graph instead of leaking the boot-active one.
        graphRegistry: deps.graphRegistry,
        deploymentMode: deps.deploymentMode,
    })) return;

    // Unknown path.
    // Wave 5 cleanup (RC audit): canonical {code, message} envelope via
    // writeError. Previously the sole field was `error` holding the human
    // sentence; that sentence now rides as `message` and `code` carries the
    // stable machine identifier `not_found` (matching the `not_found` code
    // used elsewhere, e.g. individual-resource 404s). HTTP status (404) is
    // unchanged.
    writeError(res, 404, 'not_found', 'Not found. Use /mcp for MCP or /health for status.');
}
