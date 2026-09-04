/**
 * dispatcherDeps.ts — the `DispatcherDeps` interface for dispatcher.ts.
 *
 * Extracted 2026-09-03 (merge of audit/X-edges) purely to keep
 * dispatcher.ts under the 800-line hard cap (CLAUDE.md File Size
 * Budget) — this interface is a pure boot-time dependency-injection
 * contract with no runtime logic, so splitting it out of the file that
 * walks the route table is a clean, low-risk extraction. No behavior
 * change: dispatcher.ts imports `DispatcherDeps` from here.
 */

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
import type { ActorResolver } from './middleware.js';
import type { RetentionSweepResult } from './routes/retention.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../../outbox/workspaceVerbatimResolver.js';
import type { LoadJobsStore } from '../../storage/loadJobsStore.js';
import type { WorkspaceConcurrencyManager } from '../../storage/loadJobsConcurrency.js';
import type { StreamRegistry } from '../../streaming/streamRegistry.js';
import type { PendingOpsStore } from '../../security/pendingOps.js';
import type { ReplayHandlerRegistry } from '../../security/approvalReplay.js';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle, PhaseAServices } from '../services.js';
import type { PlanOrchestrator } from '../../schemas/orchestration/orchestrator.js';
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
    /**
     * LORE_HOME root (as opposed to `loreDir`, the per-workspace
     * `.lore/` dir). Threaded into runHttpGates for the
     * /api/auth/bootstrap one-time-nonce gate (security/authToken.ts).
     */
    dataHome: string;

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
    /** HITL queue. Legacy-engine-backed in local mode, in-memory in cloud mode
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
    /** Phase 4 item 8 — migration runner backend (legacy engine in local
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

    /** WP3b — live runner so POST .../cancel can abort an in-flight job. */
    loadJobsRunner?: { requestCancel(jobId: string): void };

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
